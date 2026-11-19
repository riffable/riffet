import { readFile, stat } from 'node:fs/promises';
import type { NativeActivity, NativeStreamMessage, NativeWorkbenchEvent } from '../../../../../packages/contracts/src/index.js';
import { activityEvent } from '../../journal/activity.js';
import { turnMetaId } from '../../journal/ingest.js';
import type { NativeBackendHost, NativeControlMessage } from '../types.js';
import type { CodexActivities } from './activities.js';
import { messagePhase, type CodexDraftStream } from './drafts.js';
import { mergeResidentEvents, shownTextRowsOf, planSnapshotForTurns } from './history-read.js';
import type { CodexFlavor } from './flavors.js';
import { rolloutItemSpans, type ItemSpans } from './item-spans.js';
import { CodexJournalSpace, journalOf, type CodexIngestState } from './journal-space.js';
import type { CodexObservation } from './observation.js';
import { projectCodexItem, rowTextKey } from './project-item.js';
import type { CodexQuestionHistory } from './question-history.js';
import { parseRolloutPlan, type RolloutPlanSnapshot } from './rollout-plan.js';
import { MAX_EVENTS, RESIDENT_EVENTS } from './runtime-limits.js';
import type { CodexSubagentFrame } from './subagents.js';
import type { CodexLiveFeed } from './transcript-source.js';
import { buildEvent, codexPlanNativeId, isFinalTurnStatus, isProvisionalItemId, nativeTurnIdOf, rolloutPlanNativeId, turnStatus, type ItemSpan } from './transcript.js';
import type { CodexTurns } from './turns.js';
import type { RpcItem, RpcTurn } from './types.js';
import { MAX_ROLLOUT_BYTES } from './config.js';
import { safeTurnError } from './errors.js';
import { asArray, str, toIso } from './util.js';

/** What `CodexEventLog` needs from the runtime that owns it. */
export interface CodexEventLogContext {
  readonly host: NativeBackendHost;
  readonly sessionId: string;
  readonly flavor: CodexFlavor;
  readonly profileConfig: Record<string, unknown>;
  /** Reports what shell commands changed in the working tree (`observation.ts`). */
  readonly observation?: CodexObservation;
  threadId(): string | undefined;
  turns(): CodexTurns;
  activities(): CodexActivities;
  drafts(): CodexDraftStream;
  /** The question requests the thread's tool items are matched against. */
  questions(): CodexQuestionHistory;
  /** The workbench command a user item answers, or undefined for a message typed in the TUI. */
  commandIdOf(item: RpcItem, turnId: string | undefined): string | undefined;
  /** The conversation is named after its first message (`settings.ts#nameFromMessage`). */
  nameFromMessage(text: string): void;
  rolloutFile(threadId: string): Promise<string | undefined>;
  isTurnRunning(threadId: string, turn: RpcTurn): boolean;
  refreshStatus(): void;
}

/**
 * The conversation's events as this runtime holds them: the resident window of the newest events,
 * their numbers, and how a thread's items become events.
 *
 * It owns the resident events and the ids already seen among them, the journal space that numbers
 * them, the rows projected from positional items, the plan snapshots, the item times read from the
 * rollout, the listeners of the control stream and the journal reader's live feed.
 *
 * It does not decide when to read: `history-sync.ts` reads the thread, imports it and polls, and
 * calls in to publish what it read. Nor does it own the turns or the status: it asks the context.
 */
export class CodexEventLog {
  readonly events: NativeWorkbenchEvent[] = [];
  private readonly seenEvents = new Set<string>();
  /** Items explicitly committed by a notification; partial history must not undo them. */
  private readonly liveCompletedIds = new Set<string>();
  /**
   * Event numbering and the log's generation come from the session journal, so they outlive both a
   * rebuilt runtime and a restarted service: the same event keeps its number.
   */
  space: CodexJournalSpace;
  /** The journal's own reader imports the thread (`transcript-source.ts`); this runtime keeps to the newest turns. */
  readonly journalRead: boolean;
  /** Set while a batch of settled history is being projected for the journal rather than for listeners. */
  private importBatch: NativeWorkbenchEvent[] | undefined;
  /** Settled turns whose events are unchanged since the last read; their rows are not rewritten. */
  private stableTurnIds: ReadonlySet<string> = new Set();
  /**
   * Rows projected from a running turn's positional items (`item-1`, `item-2`, …), by turn id. They
   * are the provider's provisional naming of items the settled read returns under their own ids.
   */
  private provisionalRows = new Map<string, string[]>();
  private readonly livePlanSnapshots = new Map<string, NativeWorkbenchEvent>();
  private rolloutPlanCache?: { generation: string; snapshot?: RolloutPlanSnapshot };
  /** When the conversation thread's items happened, as its rollout last read says (`item-spans.ts`). */
  private itemSpans?: { threadId: string; spans: ItemSpans };
  readonly listeners = new Set<(message: NativeControlMessage) => void>();
  /** The journal's transcript source listening in (`transcript-source.ts`), when one does. */
  private feed: CodexLiveFeed | undefined;

  constructor(private readonly ctx: CodexEventLogContext, threadId: string | undefined) {
    // Sync v3 reads the thread into the journal (`transcript-source.ts`) once its ingest is attached to the
    // host; then this runtime writes nothing there and numbers in memory for its own bookkeeping.
    this.journalRead = ctx.host.transcript !== undefined && ctx.host.journal !== undefined;
    this.space = new CodexJournalSpace(journalOf(ctx.host), ctx.sessionId, threadId, this.journalRead);
    // A complete log is ready the moment the runtime exists: numbering is known, and the newest
    // events are at hand before the app-server has answered anything.
    if (this.space.ready) {
      this.events.push(...this.space.tail(RESIDENT_EVENTS));
      for (const event of this.events) this.seenEvents.add(event.nativeId);
    }
  }

  /** Whether a batch of settled history is being projected for the journal. */
  get importing(): boolean { return this.importBatch !== undefined; }

  /** The highest number handed out so far: a steer's baseline for "events after the input". */
  get headSequence(): number { return this.space.peekNext() - 1; }

  /** Passes this thread's notifications and activity states on to `feed` until the returned function is called. */
  attachFeed(feed: CodexLiveFeed): () => void {
    this.feed = feed;
    return () => { if (this.feed === feed) this.feed = undefined; };
  }

  /** Hands a notification of the thread to the journal's reader, which must not break the live runtime. */
  forward(method: string, params: Record<string, unknown>): void {
    try { this.feed?.notification(method, params); } catch { /* the journal's reader must not break the live runtime */ }
  }

  /** The app-server connection went away: what the journal's reader was told is running is unproven. */
  feedLost(): void {
    try { this.feed?.lost?.(); } catch { /* as for notifications */ }
  }

  /** Whether anyone follows the conversation: a control listener, or the journal's reader. */
  get observed(): boolean {
    return this.listeners.size > 0 || (this.feed !== undefined && this.feed.active?.() !== false);
  }

  /** The resident rows by id, for telling later what a read replaced. */
  snapshot(): Map<string, NativeWorkbenchEvent> {
    return new Map(this.events.map(event => [event.nativeId, event]));
  }

  /** Empties the resident window of a log that is served from a scratch read until its import closes the gap. */
  resetResident(): void {
    this.events.length = 0;
    this.seenEvents.clear();
    this.provisionalRows = new Map();
  }

  /** The turns now known to be unchanged since the last read; their rows are numbered without being looked up. */
  markStable(turnIds: ReadonlySet<string>): void { this.stableTurnIds = turnIds; }

  /** The plan rows of a read: one per turn, and those that fall between turns, oldest first. */
  plansOf(threadId: string, rolloutPlan: RolloutPlanSnapshot | undefined, turns: readonly RpcTurn[]): { plansByTurn: Map<string, NativeWorkbenchEvent>; loosePlans: NativeWorkbenchEvent[] } {
    const plansByTurn = new Map<string, NativeWorkbenchEvent>();
    if (rolloutPlan?.turnId) plansByTurn.set(rolloutPlan.turnId, this.rolloutPlanEvent(threadId, rolloutPlan));
    for (const [turnId, event] of this.livePlanSnapshots) {
      const current = plansByTurn.get(turnId);
      if (!current || Date.parse(event.createdAt) >= Date.parse(current.createdAt)) plansByTurn.set(turnId, event);
    }
    const orderedTurns = new Set(turns.map(turn => turn.id));
    const loosePlans = [...plansByTurn].filter(([turnId]) => !orderedTurns.has(turnId)).map(([, event]) => event);
    if (rolloutPlan && !rolloutPlan.turnId) loosePlans.push(this.rolloutPlanEvent(threadId, rolloutPlan));
    loosePlans.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
    return { plansByTurn, loosePlans };
  }

  /** Folds one read into the resident window and returns the whole read, numbered and in order. */
  merge(events: readonly NativeWorkbenchEvent[], read: {
    superseded: ReadonlySet<string>; streaming: ReadonlySet<string>; committed: ReadonlySet<string>;
    eventsBeforeRead: ReadonlyMap<string, NativeWorkbenchEvent>; provisionalRows: Map<string, string[]>;
  }): NativeWorkbenchEvent[] {
    const unique = mergeResidentEvents(events, this.events, read.superseded, read.streaming, this.liveCompletedIds, read.committed, read.eventsBeforeRead);
    for (const nativeId of read.streaming) this.seenEvents.delete(nativeId);
    for (const nativeId of read.superseded) {
      this.seenEvents.delete(nativeId);
      this.space.retire(nativeId);
    }
    this.provisionalRows = read.provisionalRows;
    const full = [...unique.values()].map(event => this.numbered(event)).sort((left, right) => left.sequence - right.sequence);
    const limited = full.slice(-MAX_EVENTS);
    this.events.splice(0, this.events.length, ...limited);
    for (const event of this.events) this.seenEvents.add(event.nativeId);
    return full;
  }

  /** Whether a live notification committed this row. */
  liveCompleted(nativeId: string): boolean { return this.liveCompletedIds.has(nativeId); }

  /** Marks a row the live stream committed; a poll's partial copy of it no longer replaces it. */
  noteLiveCompleted(nativeId: string): void { this.liveCompletedIds.add(nativeId); }

  /** Forgets live completions of rows that left the resident window. */
  pruneCompleted(): void {
    const retained = new Set(this.events.map(event => event.nativeId));
    for (const id of this.liveCompletedIds) if (!retained.has(id)) this.liveCompletedIds.delete(id);
  }

  /** Removes a partial row a draft now stands in for. */
  dropRow(partial: NativeWorkbenchEvent): void {
    this.events.splice(this.events.indexOf(partial), 1);
    this.seenEvents.delete(partial.nativeId);
  }

  /** The partial row of a streamed item, unless a notification already committed it. */
  partialRow(nativeId: string): NativeWorkbenchEvent | undefined {
    return !this.liveCompletedIds.has(nativeId) ? this.events.find(event => event.nativeId === nativeId) : undefined;
  }

  /** The real log is complete: the scratch window gives way to it, under the log's own generation. */
  promote(): void {
    this.space.promote();
    this.events.splice(0, this.events.length, ...this.space.tail(RESIDENT_EVENTS));
    this.seenEvents.clear();
    for (const event of this.events) this.seenEvents.add(event.nativeId);
    this.stableTurnIds = new Set();
  }

  rolloutSpan(threadId: string, item: RpcItem): ItemSpan | undefined {
    return this.itemSpans?.threadId === threadId ? this.itemSpans.spans(item) : undefined;
  }

  async loadItemSpans(threadId: string): Promise<void> {
    const spans = await rolloutItemSpans(this.ctx.flavor.stateHome(this.ctx.profileConfig), threadId);
    if (spans) this.itemSpans = { threadId, spans };
  }

  async readRolloutPlanSnapshot(threadId: string, turns: readonly RpcTurn[]): Promise<RolloutPlanSnapshot | undefined> {
    try {
      const path = await this.ctx.rolloutFile(threadId);
      if (!path) return undefined;
      const info = await stat(path);
      const generation = `${threadId}:${path}:${info.size}:${info.mtimeMs}`;
      let snapshot: RolloutPlanSnapshot | undefined;
      if (this.rolloutPlanCache?.generation === generation) snapshot = this.rolloutPlanCache.snapshot;
      else {
        snapshot = info.size <= MAX_ROLLOUT_BYTES ? parseRolloutPlan(await readFile(path, 'utf8')) : undefined;
        this.rolloutPlanCache = { generation, snapshot };
      }
      if (!snapshot) return undefined;
      return planSnapshotForTurns(snapshot, turns);
    } catch {
      // Rollout history is an optional recovery source; unreadable or partial logs must not hide
      // the app-server transcript.
      return undefined;
    }
  }

  private turnTime(seconds: unknown): string | undefined {
    return typeof seconds === 'number' && Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : undefined;
  }

  /** Synthetic row opening a turn, named as the lane writer names it (`journal/ingest.ts`). Same payload every time, so re-reading a turn writes nothing. */
  noteTurnStart(turn: RpcTurn): void {
    this.space.meta('meta.turn_started', turnMetaId(turn.id, 'started'), turn.id, this.turnTime(turn.startedAt), { turnId: turn.id });
  }

  /** A read of a turn: brings compactions and background terminals it shows into line with what is live. */
  noteCompactions(turn: RpcTurn): void {
    this.ctx.activities().noteTurn(turn, isFinalTurnStatus(turn.status), !this.importBatch);
  }

  /**
   * Writes one state of a system activity: a new version of its row in the log (under the number its first
   * state got), the resident transcript, and the live stream. Settled history being imported is only logged.
   */
  writeActivity(activity: NativeActivity, turnId: string | undefined): void {
    const run = turnId ? this.ctx.turns().turnRun(turnId) : undefined;
    const event = activityEvent(this.ctx.sessionId, activity, {
      ...(turnId ? { runId: run?.runId ?? turnId, nativeTurnId: turnId } : {}),
      createdAt: this.ctx.turns().turnRun(turnId ?? '')?.createdAt ?? activity.startedAt,
    });
    try { this.feed?.activity(activity); } catch { /* as for notifications */ }
    const row = this.space.assignRow(event);
    // The entity stays where its first state was written; a later state is announced under its own row's number, above everything sent.
    const sequenced = { ...event, sequence: row.identity };
    if (this.importBatch) { this.importBatch.push(sequenced); return; }
    const index = this.events.findIndex(candidate => candidate.nativeId === event.nativeId);
    if (index >= 0) this.events[index] = sequenced;
    else {
      this.seenEvents.add(event.nativeId);
      this.events.splice(this.events.findLastIndex(existing => existing.sequence < sequenced.sequence) + 1, 0, sequenced);
    }
    this.ctx.refreshStatus();
  }

  noteTurnEnd(turn: RpcTurn): void {
    if (!isFinalTurnStatus(turn.status)) return;
    this.space.meta('meta.turn_ended', turnMetaId(turn.id, 'ended'), turn.id, this.turnTime(turn.completedAt),
      { turnId: turn.id, status: turnStatus(turn.status), ...(turnStatus(turn.status) === 'failed' ? { error: safeTurnError(turn.error, this.ctx.profileConfig) } : {}) });
  }

  /**
   * Projects settled turns into `space`'s log and commits them, with the ingest cursor, in one
   * transaction. Nothing is shown to listeners or kept resident: this is history on its way into the
   * journal. A turn already logged writes nothing (an identical event is skipped), so re-running a
   * batch after a crash, or overlapping one that was committed, neither duplicates nor drops rows.
   */
  ingestSettledTurns(turns: readonly RpcTurn[], options: { space?: CodexJournalSpace; state?: Omit<CodexIngestState, 'v' | 'threadId'> } = {}): number {
    const live = this.space;
    const space = options.space ?? this.space;
    const written: NativeWorkbenchEvent[] = [];
    this.space = space;
    this.importBatch = written;
    try {
      space.batch(() => {
        for (const turn of turns) {
          this.ctx.turns().restoreCommands(turn.id);
          for (const item of asArray<RpcItem>(turn.items)) {
            const commandId = this.ctx.commandIdOf(item, turn.id);
            if (!commandId) continue;
            this.ctx.turns().observeCommand(turn.id, commandId, this.turnTime(turn.startedAt));
          }
          this.noteTurnStart(turn);
          this.noteCompactions(turn);
          const projected = this.projectTurnItems(turn, { shown: new Map(), provisionalRows: new Map(), superseded: new Set() });
          for (const event of projected) this.withStableSequence(event);
          this.projectKnownUserReceipts(turn);
          if (isFinalTurnStatus(turn.status) && !(turnStatus(turn.status) === 'interrupted' && this.ctx.isTurnRunning(this.ctx.threadId() ?? '', turn))) this.emitTurnOutcome(turn, turn.id);
          this.noteTurnEnd(turn);
        }
        if (options.state) space.writeState({ ...options.state, turns: (space.ingestState()?.turns ?? 0) + turns.length });
      });
    } finally {
      this.space = live;
      this.importBatch = undefined;
    }
    return written.length;
  }

  /** A child's projected events, without the parent's run/command bookkeeping. */
  projectChildItem(item: RpcItem, turn: RpcTurn, childThreadId: string): NativeWorkbenchEvent[] {
    return this.projectItem(item, turn, { childThreadId, isolated: true });
  }

  projectItem(item: RpcItem, turn: RpcTurn, options: { childThreadId?: string; isolated?: boolean; span?: ItemSpan } = {}): NativeWorkbenchEvent[] {
    const threadId = options.childThreadId ?? this.ctx.threadId() ?? 'unknown';
    const turnRun = options.isolated ? undefined : this.ctx.turns().turnRun(turn.id);
    const commandId = options.isolated ? undefined : this.ctx.commandIdOf(item, turn.id);
    const commandRun = !options.isolated && commandId ? this.ctx.turns().commandRun(commandId) : undefined;
    const runId = commandRun?.runId ?? turnRun?.runId ?? turn.id;
    const createdAt = toIso(typeof turn.startedAt === 'number' ? turn.startedAt * 1000 : undefined) ?? commandRun?.createdAt ?? turnRun?.createdAt ?? new Date().toISOString();
    const main = !options.isolated && !options.childThreadId;
    const span = options.span ?? this.rolloutSpan(threadId, item);
    return projectCodexItem(item, turn, {
      sessionId: this.ctx.sessionId, threadId, runId, createdAt, ...(commandId ? { commandId } : {}), questions: this.ctx.questions(),
      ...(span ? { span } : {}),
      ...(this.ctx.observation ? { observedChanges: (toolCallId: string) => this.ctx.observation?.changes(this.ctx.sessionId, toolCallId) } : {}),
      // A child thread's first message names the child, not this conversation; its compactions are its own.
      ...(options.childThreadId ? {} : {
        onUserText: (text: string) => this.ctx.nameFromMessage(text),
        compaction: (compacted: RpcItem, at: Pick<RpcTurn, 'id' | 'startedAt' | 'status' | 'items'>, settled: boolean) => this.ctx.activities().presented(compacted, at, settled),
      }),
      ...(main ? { phase: (itemId: string, nativeId: string) => this.ctx.drafts().phase(itemId, nativeId) ?? messagePhase(this.events.find(candidate => candidate.nativeId === nativeId)?.data.phase) } : {}),
    });
  }

  publishPlanSnapshot(turnId: string, entries: Array<Record<string, unknown>>, raw: unknown): void {
    const threadId = this.ctx.threadId() ?? 'unknown';
    const nativeId = codexPlanNativeId(threadId, turnId);
    const event = this.withStableSequence({
      ...this.makeEvent(nativeId, turnId, this.ctx.turns().turnRun(turnId)?.runId, 'plan', { entries }, raw),
      createdAt: new Date().toISOString(),
    });
    this.livePlanSnapshots.set(turnId, event);
    this.seenEvents.add(nativeId);
    const existingIndex = this.events.findIndex(existing => existing.nativeId === nativeId);
    if (existingIndex >= 0) this.events[existingIndex] = event;
    else {
      const at = this.events.findLastIndex(existing => existing.sequence < event.sequence) + 1;
      this.events.splice(at, 0, event);
      if (this.events.length > MAX_EVENTS) {
        this.events.splice(0, this.events.length - MAX_EVENTS);
      }
    }
  }

  private rolloutPlanEvent(threadId: string, snapshot: RolloutPlanSnapshot): NativeWorkbenchEvent {
    const turnId = snapshot.turnId;
    const nativeId = rolloutPlanNativeId(threadId, snapshot);
    const event = this.makeEvent(
      nativeId,
      turnId ?? '',
      turnId ? this.ctx.turns().turnRun(turnId)?.runId : undefined,
      'plan',
      { entries: snapshot.entries },
    );
    return { ...event, createdAt: snapshot.timestamp };
  }

  makeEvent(nativeId: string, turnId: string, runId: string | undefined, type: string, data: Record<string, unknown>, raw?: unknown): NativeWorkbenchEvent {
    return buildEvent(this.ctx.sessionId, this.ctx.turns().turnRun(turnId)?.createdAt, nativeId, turnId, runId, type, data, raw);
  }

  emitTurnOutcome(turn: RpcTurn, turnId: string): NativeWorkbenchEvent[] {
    const settled = this.ctx.turns().settleOutcome(turn, turnId);
    if (!settled) return [];
    const { type, status, known, mapped } = settled;
    const outcomes: NativeWorkbenchEvent[] = [];
    for (const commandId of known) {
      const command = this.ctx.turns().commandRun(commandId)!;
      const nativeMessage = this.events.find(event => event.type === 'user_message_chunk'
        && event.data.commandId === commandId
        && event.nativeId.startsWith(`${this.ctx.threadId() ?? 'unknown'}:${turnId}:`));
      const data: Record<string, unknown> = { commandId };
      data.nativeMessageId = nativeMessage?.nativeId ?? `${this.ctx.threadId() ?? 'unknown'}:${turnId}:web:${commandId}:user`;
      if (status === 'failed') data.error = safeTurnError(turn.error, this.ctx.profileConfig);
      if (status === 'interrupted') data.reason = `${this.ctx.flavor.label} turn was interrupted.`;
      const nativeId = `${this.ctx.threadId() ?? 'thread'}:${turnId}:${type}:${commandId}`;
      const event = this.events.find(candidate => candidate.nativeId === nativeId) ?? this.withStableSequence({ ...this.makeEvent(
        nativeId,
        turnId,
        command.runId ?? mapped?.runId,
        type,
        data,
        { id: turn.id, status, ...(status === 'failed' ? { error: safeTurnError(turn.error, this.ctx.profileConfig) } : {}) },
      ), createdAt: command.createdAt });
      this.pushEvent(event);
      // An outcome can already have left the resident tail. Include it in this read's projection
      // even when pushEvent correctly suppresses another live delivery of the same identity.
      outcomes.push(event);
    }
    return outcomes;
  }

  projectKnownUserReceipts(turn: RpcTurn): void {
    for (const item of asArray<RpcItem>(turn.items)) {
      if (item.type !== 'userMessage') continue;
      const commandId = this.ctx.commandIdOf(item, turn.id);
      if (!commandId || !this.ctx.turns().commandRun(commandId)) continue;
      for (const event of this.projectItem(item, turn)) this.pushEvent(event);
    }
  }

  /**
   * The text rows these turns already show under the ids their items keep, by turn id.
   *
   * Rows a positional item added are left out: this is the settled side of the comparison, and a
   * copy standing in for a settled row must not pass for one.
   */
  shownTextRows(threadId: string, turnIds: readonly string[]): Map<string, Set<string>> {
    return shownTextRowsOf(this.provisionalRows, this.events, threadId, turnIds);
  }

  /** Which text row a provisional native id stands for, if it is one this transcript still holds. */
  private textKeyOf(nativeId: string): string | undefined {
    const event = this.events.find(candidate => candidate.nativeId === nativeId);
    return event ? rowTextKey(event) : undefined;
  }

  /**
   * One turn's history items, projected without showing a running turn's items twice.
   *
   * TRAE CLI serves a turn it has not written yet under positional item ids (`item-1`, `item-2`, …)
   * and returns the same items under the ids they keep once it is written (`msg_…` for an answer,
   * `rs_…` for its reasoning). A read taken mid-turn would therefore show a second copy of what the
   * live stream — or an earlier read — already committed, and the copy it adds is named with an id
   * that will not last. So text the turn already shows is not shown again, and the copies this read
   * adds are remembered until the settled read returns the items under the ids that do last.
   */
  projectTurnItems(turn: RpcTurn, context: {
    shown: Map<string, Set<string>>;
    /** Rows this read projected from a positional item, by turn id; replaces `provisionalRows`. */
    provisionalRows: Map<string, string[]>;
    /** Rows of the transcript a settled copy replaces; the caller drops them. */
    superseded: Set<string>;
  }): NativeWorkbenchEvent[] {
    const items = asArray<RpcItem>(turn.items);
    const settled = isFinalTurnStatus(turn.status);
    // Every item returned under the id it keeps means the turn is written and this read is the
    // settled copy of all of it; otherwise a positional item is only compared with what text shows.
    const renamed = settled && items.every(item => !isProvisionalItemId(str(item.id)));
    const shown = context.shown.get(turn.id) ?? new Set<string>();
    const events: NativeWorkbenchEvent[] = [];
    const positional: NativeWorkbenchEvent[][] = [];
    for (const item of items) {
      const projected = this.projectItem(item, turn);
      if (!projected.length) continue;
      if (isProvisionalItemId(str(item.id))) { positional.push(projected); continue; }
      for (const event of projected) {
        const key = rowTextKey(event);
        if (key) shown.add(key);
        events.push(event);
      }
    }
    const rows = new Set<string>();
    for (const nativeId of this.provisionalRows.get(turn.id) ?? []) {
      const key = this.textKeyOf(nativeId);
      if (renamed || (key !== undefined && shown.has(key))) context.superseded.add(nativeId);
      else rows.add(nativeId);
    }
    for (const projected of positional) {
      const keys = projected.map(rowTextKey).filter((key): key is string => key !== undefined);
      if (keys.some(key => shown.has(key))) continue;
      for (const event of projected) rows.add(event.nativeId);
      events.push(...projected);
    }
    if (rows.size) context.provisionalRows.set(turn.id, [...rows]);
    context.shown.set(turn.id, shown);
    return events;
  }

  pushEvent(event: NativeWorkbenchEvent, replace = false): void {
    // Settled history being logged is not shown to anyone: it only needs its number and a row.
    if (this.importBatch) { this.importBatch.push(this.withStableSequence(event)); return; }
    if (this.seenEvents.has(event.nativeId)) {
      if (replace) {
        const index = this.events.findIndex(candidate => candidate.nativeId === event.nativeId);
        if (index >= 0) this.events[index] = this.withStableSequence(event);
      }
      return;
    }
    const sequenced = this.withStableSequence(event);
    this.seenEvents.add(sequenced.nativeId);
    // A sequence reserved by a draft sits behind newer events, so keep the transcript ordered.
    const at = this.events.findLastIndex(existing => existing.sequence < sequenced.sequence) + 1;
    this.events.splice(at, 0, sequenced);
    if (this.events.length > MAX_EVENTS) {
      const dropped = this.events.splice(0, this.events.length - MAX_EVENTS);
      for (const previous of dropped) this.liveCompletedIds.delete(previous.nativeId);
    }
  }

  /** An event that already has its place keeps it without being looked at in the log again. */
  private numbered(event: NativeWorkbenchEvent): NativeWorkbenchEvent {
    const known = this.space.seqOf(event.nativeId);
    return known === undefined ? this.withStableSequence(event) : { ...event, sequence: known };
  }

  withStableSequence(event: NativeWorkbenchEvent): NativeWorkbenchEvent {
    const sequence = this.space.assign(event, event.nativeTurnId !== undefined && this.stableTurnIds.has(event.nativeTurnId));
    const nativeTurnId = nativeTurnIdOf(event, this.ctx.threadId());
    const numbered = { ...event, sequence, ...(nativeTurnId ? { nativeTurnId } : {}) };
    return numbered;
  }

  /** What the control path takes of a message: the transcript itself is read into the journal (`transcript-source.ts`). */
  emit(message: NativeStreamMessage | CodexSubagentFrame): void {
    let control: NativeControlMessage | undefined;
    if (message.type === 'subagent') control = message.running === undefined ? undefined : { type: 'subagent', toolCallId: message.toolCallId, agentId: message.agentId, running: message.running };
    else if (message.type === 'status' || message.type === 'context' || message.type === 'metrics' || message.type === 'job' || message.type === 'session') control = message;
    if (!control) return;
    for (const listener of this.listeners) {
      try { listener(control); } catch { /* A failing listener must not stop the native process observer. */ }
    }
  }
}
