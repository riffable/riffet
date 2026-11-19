import type { NativeInteraction, NativeStatus, NativeWorkbenchEvent } from '../../../../../packages/contracts/src/index.js';
import { DORMANT_POLL_MS, DormancyClock } from '../shared/dormancy.js';
import type { NativeControlMessage } from '../types.js';
import type { CodexActivities } from './activities.js';
import type { CodexConnection } from './connection.js';
import type { CodexDraftStream } from './drafts.js';
import type { CodexEventLog } from './event-log.js';
import { turnMarkers } from './event-diff.js';
import { isTurnsListUnsupportedError, safeProviderError } from './errors.js';
import type { CodexFlavor } from './flavors.js';
import { insertPlanEvent, stableTurnIdsOf, type CodexHistoryReader } from './history-read.js';
import { CodexJournalSpace } from './journal-space.js';
import type { CodexContextMeter, CodexTurnMetering } from './metering.js';
import { IMPORT_PAGE_TURNS } from './runtime-limits.js';
import type { CodexSubagents } from './subagents.js';
import type { CodexTerminal } from './terminal.js';
import type { CodexThread } from './thread.js';
import type { CodexTurnPage, CodexTurnsRequest } from './transcript-source.js';
import { isFinalTurnStatus, turnStatus } from './transcript.js';
import type { CodexTurns } from './turns.js';
import type { RpcItem, RpcThread, RpcTurn } from './types.js';
import { asArray, asRecord, str, toIso } from './util.js';

/** What `CodexHistorySync` needs from the runtime that owns it. */
export interface CodexHistorySyncContext {
  readonly sessionId: string;
  readonly flavor: CodexFlavor;
  readonly profileConfig: Record<string, unknown>;
  readonly connection: CodexConnection;
  threadId(): string | undefined;
  status(): NativeStatus;
  /** The blocking request the card shows. */
  interaction(): NativeInteraction | undefined;
  interactionsIdle(): boolean;
  turns(): CodexTurns;
  reader(): CodexHistoryReader;
  drafts(): CodexDraftStream;
  metering(): CodexTurnMetering;
  thread(): CodexThread;
  subagents(): CodexSubagents;
  usage(): CodexContextMeter;
  activities(): CodexActivities;
  terminal(): CodexTerminal;
  commandIdOf(item: RpcItem, turnId: string | undefined): string | undefined;
  isTurnRunning(threadId: string, turn: RpcTurn): boolean;
  attachLoadedOwner(): Promise<void>;
  applyThreadStatus(status: RpcThread['status']): void;
  adoptProviderTitle(name: string | undefined): void;
  refreshStatus(change?: { link?: 'starting' | 'offline' | 'quiet' | 'working'; connection?: NativeStatus['connection']; history?: NativeStatus['history'] }): void;
  /** The poll interval the turn tracker suggests for the current evidence. */
  suggestedPollMs(healthy: boolean): number;
}

/**
 * Reads the thread into the conversation's events: the transcript read that keeps the resident
 * window current, the import of its older history into the journal, and the poll that schedules both.
 *
 * It owns the read in flight and the one queued behind it, whether the last read produced a usable
 * snapshot, the turn markers it saw, the import task, the poll timer with its cadence and dormancy.
 *
 * It does not own the events or their numbers (`event-log.ts`), the turns, or the status: it
 * publishes what it read into the log, drives the turns through their methods and asks the context
 * to refresh the status and to adopt the thread's status and title.
 */
export class CodexHistorySync {
  private historyPoll: NodeJS.Timeout | undefined;
  private pollHealthy?: boolean;
  private pollDormant = false;
  /** Polls slow to `DORMANT_POLL_MS` once idle and unwatched; a client, a turn or a request brings the normal cadence back. */
  private readonly dormancy = new DormancyClock();
  private refreshTask: Promise<NativeWorkbenchEvent[] | undefined> | undefined;
  private refreshQueued: Promise<NativeWorkbenchEvent[] | undefined> | undefined;
  private importTask: Promise<void> | undefined;
  private importStopped = false;
  private transcriptLoaded = false;
  private historySnapshotReady = false;
  /** Marker of each turn as of the last read, for telling which settled turns cannot have changed. */
  private turnMarkersSeen = new Map<string, string>();

  constructor(private readonly ctx: CodexHistorySyncContext, private readonly log: CodexEventLog) {}

  /** The last read produced a snapshot of the thread that can be trusted. */
  get snapshotReady(): boolean { return this.historySnapshotReady; }

  /** The thread's history is being read into the journal, or this runtime is closed. */
  get stopped(): boolean { return this.importStopped; }

  /** Stops the poll and the import for good. */
  stop(): void {
    this.importStopped = true;
    if (this.historyPoll) clearTimeout(this.historyPoll);
    this.historyPoll = undefined;
  }

  /** The cadence depends on whether notifications can be trusted and whether anyone is idle-watching; re-read when either changed. */
  statusChanged(): void {
    if (this.historyPoll && (this.pushHealthy() !== this.pollHealthy || (this.pollDormant && !this.dormant()))) this.scheduleHistoryPoll(true);
  }

  subscribe(listener: (message: NativeControlMessage) => void): () => void {
    this.log.listeners.add(listener);
    // Seed child activity before the main phase: an idle parent can still have working children.
    for (const watch of this.ctx.subagents().values()) if (watch.running) listener({ type: 'subagent', toolCallId: watch.toolCallId, agentId: watch.childId, running: true });
    if (this.ctx.usage().context) listener({ type: 'context', context: this.ctx.usage().context });
    listener({ type: 'status', status: this.ctx.status() });
    if (this.ctx.interaction()) listener({ type: 'status', status: { ...this.ctx.status(), phase: 'attention', interaction: this.ctx.interaction() } });
    if ((!this.historyPoll || this.pollDormant) && this.ctx.threadId() && this.ctx.connection.transport?.isOnline) this.scheduleHistoryPoll(true);
    return () => {
      this.log.listeners.delete(listener);
      if (this.log.listeners.size === 0 && this.historyPoll) {
        clearTimeout(this.historyPoll);
        this.historyPoll = undefined;
      }
    };
  }

  /**
   * Notifications are the primary feed once this client owns the thread over a healthy connection;
   * the history read then only backstops a missed one. Anything else (a reader that is not attached,
   * a failing connection or history) still has nothing but the read, so it keeps the quick cadence.
   */
  private pushHealthy(): boolean {
    return this.ctx.connection.attached && this.ctx.connection.transport?.isOnline === true && !this.ctx.connection.bindingScopeMismatch && !this.ctx.connection.endpointBlocked
      && this.ctx.status().connection?.state === 'connected' && this.ctx.status().history?.state === 'ready';
  }

  /** One read now (or after the suggested interval), then rescheduled at the cadence the tracker suggests. */
  private scheduleHistoryPoll(immediate = false): void {
    if (this.historyPoll) clearTimeout(this.historyPoll);
    this.historyPoll = undefined;
    if (this.log.listeners.size === 0 || !this.ctx.threadId() || !this.ctx.connection.transport?.isOnline) return;
    const healthy = this.pushHealthy();
    this.pollHealthy = healthy;
    this.pollDormant = this.dormant();
    const run = () => {
      // Polls need the current read, not an additional full read queued behind a slow one.
      if (!this.refreshTask) void this.refreshEvents().catch(error => this.noteHistoryFailure(error));
      // An unverified endpoint is usually a scan that timed out, not a different owner. Re-check it
      // (at most every couple of seconds, by the state's own cache) so the conflict clears on its own.
      if (this.ctx.connection.endpointBlocked) void this.ctx.terminal().endpointState().then(() => this.ctx.attachLoadedOwner());
      else void this.ctx.attachLoadedOwner();
      this.ctx.activities().sync();
      this.scheduleHistoryPoll();
    };
    if (immediate) { run(); return; }
    const interval = this.ctx.suggestedPollMs(healthy);
    this.historyPoll = setTimeout(run, this.pollDormant ? Math.max(interval, DORMANT_POLL_MS) : interval);
    this.historyPoll.unref();
  }

  /** Idle, with no client listening, for a while: nothing anyone sees depends on a quick read. */
  private dormant(): boolean {
    const quiet = !this.ctx.turns().activeTurnId && this.ctx.interactionsIdle()
      && (this.ctx.status().phase === 'idle' || this.ctx.status().phase === 'offline');
    return this.dormancy.dormant(!quiet || this.log.listeners.size > 0);
  }

  /**
   * What a reader needs before the poll takes over: the thread read once (status, active turn, title),
   * whether this client owns it, its children, and the context window the provider has not reported yet.
   */
  async prime(): Promise<void> {
    try {
      await this.refreshEvents();
    } catch (error) {
      this.noteHistoryFailure(error);
      this.historySnapshotReady = false;
    }
    const threadId = this.ctx.threadId();
    if (!this.ctx.connection.attached && threadId && this.transcriptLoaded) {
      await this.ctx.connection.loadedThread(threadId).catch(() => undefined);
      this.ctx.refreshStatus({ link: 'offline', connection: this.ctx.status().connection?.state === 'conflict' || this.ctx.connection.endpointBlocked ? this.ctx.status().connection : { state: 'disconnected' } });
    }
    void this.ctx.subagents().refresh();
    // A resumed thread reports nothing until its next turn, so the rollout is consulted once when
    // nothing has been reported yet; after that the provider's own frames lead.
    await this.ctx.usage().seedContextWindow().catch(() => undefined);
    if (!this.ctx.usage().contextBreakdown) await this.ctx.usage().refreshContextBreakdown().catch(() => undefined);
  }

  /**
   * One transcript read at a time. A caller arriving mid-read shares a single follow-up read that
   * starts after it, so it still sees state at least as new as its call.
   */
  refreshEvents(): Promise<NativeWorkbenchEvent[] | undefined> {
    if (!this.refreshTask) {
      const task = this.readEvents().finally(() => { if (this.refreshTask === task) this.refreshTask = undefined; });
      this.refreshTask = task;
      return task;
    }
    this.refreshQueued ??= this.refreshTask.catch(() => undefined).then(() => {
      this.refreshQueued = undefined;
      return this.refreshEvents();
    });
    return this.refreshQueued;
  }

  private async readEvents(): Promise<NativeWorkbenchEvent[] | undefined> {
    const materializationBeforeRead = this.ctx.reader().materialization;
    const statusBeforeRead = this.ctx.status();
    const turnsBeforeRead = this.ctx.turns().snapshot();
    const threadId = this.ctx.threadId();
    if (!threadId || !this.ctx.connection.transport?.isOnline) {
      this.historySnapshotReady = false;
      return;
    }
    // A concurrent poll must not invalidate the successful snapshot another caller just awaited.
    // Keep that snapshot ready until this read either replaces it or actually fails.
    const eventsBeforeRead = this.log.snapshot();
    const draftsBeforeRead = this.ctx.drafts().texts();
    const window = await this.ctx.reader().readThreadWindow(threadId);
    // Before its first user message a new thread has no native history yet. Keep that normal
    // preparation distinct from a reader that cannot read this thread at all.
    if (!window || window === 'pending') {
      this.historySnapshotReady = false;
      if (window === 'pending') this.setHistory({ state: 'loading' });
      else this.noteHistoryUnavailable();
      return;
    }
    const turns = window.turns;
    if (!this.log.space.initialized) this.chooseLog(threadId, window.complete);
    else if (this.log.space.ready && this.logTrailsThread(window)) {
      // The log stops short of this window: turns ran while nobody was reading. Serve the tail from a
      // scratch window and let a background import close the gap in order.
      this.log.space.writeState({ ...this.log.space.ingestState()!, phase: 'importing' });
      this.log.space.unbind();
      this.log.resetResident();
      return await this.readEvents();
    }
    // A settled turn whose marker has not moved since the last published read cannot have changed.
    const markersNow = turnMarkers(turns);
    const stableTurns = stableTurnIdsOf(turns, markersNow, this.turnMarkersSeen);
    this.log.markStable(stableTurns);
    const rolloutPlan = await this.log.readRolloutPlanSnapshot(threadId, turns);
    await this.log.loadItemSpans(threadId);
    // Until the first read has finished, nothing is published: notifications that arrived meanwhile
    // were numbered provisionally and are numbered for good, in conversational order, by this pass.
    const initializing = !this.log.space.initialized;
    for (const turn of turns) {
      this.ctx.turns().restoreCommands(turn.id);
      for (const item of asArray<RpcItem>(turn.items)) {
        const commandId = this.ctx.commandIdOf(item, turn.id);
        if (!commandId) continue;
        this.ctx.turns().observeCommand(turn.id, commandId, toIso(typeof turn.startedAt === 'number' ? turn.startedAt * 1000 : undefined));
      }
    }
    const { plansByTurn, loosePlans } = this.log.plansOf(threadId, rolloutPlan, turns);
    let loosePlanIndex = 0;
    const events: NativeWorkbenchEvent[] = [];
    // A turn that is still running is served under positional item ids naming the same items as the
    // ids it is written with, so this read holds its text to what the turn already shows and
    // remembers the copies it adds, for the settled read to take back.
    const shown = this.log.shownTextRows(threadId, turns.map(turn => turn.id));
    const provisionalRows = new Map<string, string[]>();
    const superseded = new Set<string>();
    const committed = new Set<string>();
    const streaming = new Set<string>();
    for (const turn of turns) {
      if (!stableTurns.has(turn.id)) { this.log.noteTurnStart(turn); this.log.noteCompactions(turn); }
      const turnStartedAt = typeof turn.startedAt === 'number' ? turn.startedAt * 1_000 : Number.NEGATIVE_INFINITY;
      while (loosePlanIndex < loosePlans.length && Date.parse(loosePlans[loosePlanIndex]!.createdAt) <= turnStartedAt) {
        const planEvent = loosePlans[loosePlanIndex++]!;
        events.push(this.log.withStableSequence(planEvent));
        this.log.pushEvent(planEvent);
      }
      // Number the complete turn before publishing its receipts. Numbering every user first and
      // the remaining items after the loop groups all questions ahead of all answers on recovery.
      const projected = this.log.projectTurnItems(turn, { shown, provisionalRows, superseded });
      const planEvent = plansByTurn.get(turn.id);
      if (planEvent) insertPlanEvent(projected, planEvent, rolloutPlan, turn.id);
      const final = isFinalTurnStatus(turn.status);
      for (const event of projected) {
        const numbered = this.log.withStableSequence(event);
        if (final) committed.add(event.nativeId);
        const text = str(asRecord(event.data.content)?.text);
        if (!final && text !== undefined && this.ctx.drafts().adoptPartial(event.nativeId, text, draftsBeforeRead.get(event.nativeId), numbered.sequence, event.data.phase)) {
          streaming.add(event.nativeId);
          continue;
        }
        events.push(numbered);
      }
      this.log.projectKnownUserReceipts(turn);
      if (planEvent) this.log.pushEvent(planEvent);
      if (isFinalTurnStatus(turn.status) && !(turnStatus(turn.status) === 'interrupted' && this.ctx.isTurnRunning(threadId, turn))) {
        events.push(...this.log.emitTurnOutcome(turn, turn.id));
      }
      if (!stableTurns.has(turn.id)) this.log.noteTurnEnd(turn);
    }
    while (loosePlanIndex < loosePlans.length) {
      const planEvent = loosePlans[loosePlanIndex++]!;
      events.push(this.log.withStableSequence(planEvent));
      this.log.pushEvent(planEvent);
    }
    const full = this.log.merge(events, { superseded, streaming, committed, eventsBeforeRead, provisionalRows });
    this.ctx.drafts().settleCommitted(nativeId => committed.has(nativeId) || this.log.liveCompleted(nativeId));
    this.log.pruneCompleted();
    if (initializing) {
      this.ctx.drafts().resequence(nativeId => this.log.space.seqOf(nativeId));
      this.log.space.markInitialized();
    }
    const phaseStillCurrent = this.ctx.status() === statusBeforeRead && this.ctx.turns().unchangedSince(turnsBeforeRead);
    if (turns.length && phaseStillCurrent) {
      const latest = turns.at(-1)!;
      const target = this.ctx.turns().activeTurnId ? turns.find(turn => turn.id === this.ctx.turns().activeTurnId) : undefined;
      // A bounded read can miss a just-started target. Only that target's own terminal record
      // clears it; an interrupted copy of a turn we still drive may be provisional.
      if (target && isFinalTurnStatus(target.status) &&
        !(turnStatus(target.status) === 'interrupted' && this.ctx.isTurnRunning(threadId, target))) {
        this.ctx.turns().endForeground(target.id);
      }
      // Only an ordered turn after the observed end can provide new foreground work. A read
      // stopping before a newer live end, or its same-turn inProgress copy, cannot undo that fact.
      const endedIndex = this.ctx.turns().foregroundEndedTurnId ? turns.findIndex(turn => turn.id === this.ctx.turns().foregroundEndedTurnId) : -1;
      const pastEnd = !this.ctx.turns().foregroundEndedTurnId || (endedIndex >= 0 && endedIndex < turns.length - 1);
      const active = turnStatus(latest.status) === 'inProgress' && pastEnd
        && (!this.ctx.turns().activeTurnId || target) ? latest : undefined;
      if (active) {
        this.ctx.turns().startForeground(active.id);
        if (!!!this.ctx.metering().active(active.id) && !this.ctx.metering().isSettled(active.id)) {
          const meter = this.ctx.metering().meterFor(active.id);
          const hasAssistantOrTool = asArray<RpcItem>(active.items).some(item => item.type !== 'userMessage');
          meter.requestStartAt ??= !hasAssistantOrTool && typeof active.startedAt === 'number'
            ? active.startedAt * 1000
            : Date.now();
        }
      } else if (!this.ctx.turns().activeTurnId && (!this.ctx.turns().foregroundEndedTurnId || endedIndex >= 0)
        && (turnStatus(latest.status) === 'completed' || turnStatus(latest.status) === 'failed')) {
        this.ctx.turns().noteForegroundEnded(latest.id);
      } else if (turnStatus(latest.status) === 'interrupted' && pastEnd) {
        // An active TRAE thread can expose a newly starting turn as interrupted before rollout
        // catches up. Without a live end for this turn, aggregate active remains busy.
        this.ctx.turns().clearForegroundEnded();
      }
    }
    const statusBeforeThread = this.ctx.status();
    const turnsBeforeThread = this.ctx.turns().snapshot();
    // The first real turn page can arrive before the provider's metadata view catches up. Use
    // this read's initial evidence even if that page just completed materialization; later reads
    // still start without the grace, and genuine or foreign-thread errors remain failures.
    const thread = await this.ctx.reader().readThread(threadId, false, materializationBeforeRead);
    this.ctx.thread().noteThread(thread);
    if (thread) {
      this.ctx.adoptProviderTitle(typeof thread.name === 'string' ? thread.name : undefined);
      // `notLoaded` is an observation about this reader connection. It cannot prove that another
      // Codex endpoint stopped the thread, so only an explicitly attached owner drives phase.
      if (phaseStillCurrent && this.ctx.status() === statusBeforeThread && this.ctx.turns().unchangedSince(turnsBeforeThread) &&
        (this.ctx.connection.attached || this.ctx.connection.loadedOwnerFresh(threadId))) {
        const target = this.ctx.turns().activeTurnId ? turns.find(turn => turn.id === this.ctx.turns().activeTurnId) : undefined;
        // Unlike a provisional interrupted copy on an active thread, the same target plus the
        // verified owner's idle/error state confirms a lost interruption completion.
        if (target && turnStatus(target.status) === 'interrupted' &&
          (thread.status?.type === 'idle' || thread.status?.type === 'systemError')) {
          this.ctx.turns().endForeground(target.id);
          this.log.emitTurnOutcome(target, target.id);
          this.log.noteTurnEnd(target);
        }
        this.ctx.applyThreadStatus(thread.status);
      }
    }
    this.ctx.reader().noteMaterialized(threadId, turns);
    this.turnMarkersSeen = markersNow;
    this.transcriptLoaded = true;
    this.noteHistoryReady();
    this.historySnapshotReady = true;
    this.recordIngest(turns, window.complete);
    if (this.log.space.bound === 'scratch') this.startImport(threadId);
    // Children are followed on the same tick, but a slow child must not hold up the conversation.
    this.ctx.subagents().note(turns);
    void this.ctx.subagents().refresh();
    return full;
  }

  // ---- journal ingest ---------------------------------------------------------------------------

  /** Decides, at the first read of a thread, which log serves it and how its history gets in. */
  private chooseLog(threadId: string, complete: boolean): void {
    this.log.space.adoptThread(threadId);
    if (this.log.space.ingestState()?.phase === 'ready' || complete) this.log.space.bind('real');
    else this.log.space.bind('scratch');
  }

  /** Whether the log's last ingested turn is missing from a window that does not reach the thread's start. */
  private logTrailsThread(window: { turns: RpcTurn[]; complete: boolean }): boolean {
    if (window.complete) return false;
    const state = this.log.space.ingestState();
    // A log that has seen no turn at all (the thread was empty when it was written) trails any thread that has grown.
    if (!state?.settled && !state?.open) return true;
    return !window.turns.some(turn => turn.id === state.settled || turn.id === state.open);
  }

  /**
   * One page of `thread/turns/list` over this runtime's connection. An app-server too old for the
   * method answers from the legacy `thread/read`, paged here by position; a thread not materialized
   * yet reads as undefined.
   */
  async turnsPage(request: CodexTurnsRequest): Promise<CodexTurnPage | undefined> {
    const materialization = this.ctx.reader().materialization;
    const { threadId, cursor, limit, sortDirection, itemsView } = request;
    const params = { threadId, ...(cursor ? { cursor } : {}), limit, sortDirection, itemsView: itemsView ?? 'full' };
    let flushError: unknown;
    try {
      const page = await this.ctx.connection.requireTransport().request<CodexTurnPage>('thread/turns/list', params);
      if (Array.isArray(page.data)) this.ctx.reader().noteMaterialized(threadId, page.data);
      this.ctx.reader().clearChildPending(threadId);
      return page;
    } catch (error) {
      if (!cursor && this.ctx.reader().isHistoryPending(threadId, error, materialization)) {
        return this.ctx.reader().isEmptyNewThread(threadId) ? { data: [], nextCursor: null } : undefined;
      }
      if (this.ctx.reader().isChildFlushUnavailable(threadId, error)) {
        // A child may unload between lookup and live-history flush. Retry the same page first;
        // persisted legacy history is a fallback only at the head (opaque cursors cannot be
        // translated safely). Never replace it with an empty successful snapshot.
        try {
          const page = await this.ctx.connection.requireTransport().request<CodexTurnPage>('thread/turns/list', params);
          if (Array.isArray(page.data)) this.ctx.reader().noteMaterialized(threadId, page.data);
          this.ctx.reader().clearChildPending(threadId);
          return page;
        } catch (retryError) {
          if (!this.ctx.reader().isChildFlushUnavailable(threadId, retryError) || (cursor && !cursor.startsWith('legacy:'))) throw retryError;
          flushError = retryError;
        }
      } else if (!isTurnsListUnsupportedError(error)) throw error;
    }
    const turns = await this.ctx.reader().readLegacyTurns(threadId);
    if (flushError && (!turns || turns === 'pending' || !turns.length)) throw flushError;
    if (!turns || turns === 'pending') return undefined;
    this.ctx.reader().clearChildPending(threadId);
    const at = cursor?.startsWith('legacy:') ? Number(cursor.slice('legacy:'.length)) : sortDirection === 'asc' ? 0 : turns.length;
    const start = sortDirection === 'asc' ? at : Math.max(0, at - limit);
    const end = sortDirection === 'asc' ? Math.min(turns.length, at + limit) : at;
    const data = turns.slice(start, end);
    const more = sortDirection === 'asc' ? end < turns.length : start > 0;
    return { data: sortDirection === 'asc' ? data : data.reverse(), nextCursor: more ? `legacy:${sortDirection === 'asc' ? end : start}` : null };
  }

  /** Writes how far the thread has been read: the newest settled turn, and the turn still running. */
  private recordIngest(turns: readonly RpcTurn[], complete: boolean): void {
    if (this.log.space.bound !== 'real') return;
    const previous = this.log.space.ingestState();
    const settled = turns.findLast(turn => isFinalTurnStatus(turn.status))?.id ?? previous?.settled;
    const open = turns.findLast(turn => !isFinalTurnStatus(turn.status))?.id;
    // A bounded read that did not reach the thread's start must not claim a log it has not written.
    if (!complete && previous?.phase !== 'ready') return;
    this.log.space.writeState({ phase: 'ready', ...(settled ? { settled } : {}), ...(open ? { open } : {}), turns: previous?.turns ?? 0 });
  }

  /** Starts the background import of the thread's history into the real log, once at a time. */
  private startImport(threadId: string): void {
    // The journal's reader imports the thread itself.
    if (this.log.journalRead) return;
    if (this.importTask || this.importStopped || !this.ctx.connection.transport?.isOnline) return;
    const task = this.importHistory(threadId)
      .catch(error => console.warn('[codex-journal] history import paused; it resumes from its cursor on the next read:', safeProviderError(error, this.ctx.profileConfig)))
      .finally(() => { if (this.importTask === task) this.importTask = undefined; });
    this.importTask = task;
  }

  /**
   * Imports settled turns oldest first, a few at a time, each step committing its rows together with
   * the cursor (the last turn ingested). Interrupted at any point it resumes after that turn. The
   * running turn is left to the live path. When the thread is caught up the real log takes over from
   * the scratch window.
   */
  private async importHistory(threadId: string): Promise<void> {
    const real = new CodexJournalSpace(this.log.space.journal, this.ctx.sessionId, threadId);
    real.bind('real');
    let state = real.ingestState();
    let settled = state?.phase === 'importing' ? state.settled : undefined;
    let open: string | undefined;
    if (!state) real.writeState({ phase: 'importing', turns: 0 });
    let cursor: string | undefined;
    let skipThrough = settled;
    if (settled) {
      const position = await this.locateAfter(threadId, settled);
      if (!position) {
        // The thread no longer contains the turn the log stopped at: it was rewritten. Start over.
        this.log.space.journal.rebuild(this.ctx.sessionId);
        real.writeState({ phase: 'importing', turns: 0 });
        settled = undefined; skipThrough = undefined;
      } else cursor = position.cursor;
    }
    for (;;) {
      if (this.importStopped) return;
      const page = await this.ctx.connection.requireTransport().request<{ data?: RpcTurn[]; nextCursor?: string | null }>('thread/turns/list', {
        threadId, ...(cursor ? { cursor } : {}), limit: IMPORT_PAGE_TURNS, sortDirection: 'asc', itemsView: 'full',
      });
      if (!Array.isArray(page.data)) throw new Error(`${this.ctx.flavor.label} app-server thread/turns/list returned invalid history data.`);
      await this.log.loadItemSpans(threadId);
      let turns = page.data;
      if (skipThrough) {
        const at = turns.findIndex(turn => turn.id === skipThrough);
        if (at >= 0) { turns = turns.slice(at + 1); skipThrough = undefined; } else turns = [];
      }
      const done = turns.findIndex(turn => !isFinalTurnStatus(turn.status));
      const batch = done < 0 ? turns : turns.slice(0, done);
      if (done >= 0) open = turns[done]!.id;
      if (batch.length) {
        settled = batch.at(-1)!.id;
        this.log.ingestSettledTurns(batch, { space: real, state: { phase: 'importing', settled } });
      }
      if (done >= 0 || !page.nextCursor) break;
      cursor = page.nextCursor;
      // Let notifications and requests run between steps; a long thread is many of them.
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    if (this.importStopped) return;
    real.writeState({ phase: 'ready', ...(settled ? { settled } : {}), ...(open ? { open } : {}), turns: real.ingestState()?.turns ?? 0 });
    this.promoteToRealLog();
  }

  /** The asc-order cursor of the page holding `turnId`, found by scanning turn headers only. */
  private async locateAfter(threadId: string, turnId: string): Promise<{ cursor?: string } | undefined> {
    let cursor: string | undefined;
    for (let pages = 0; pages < 1000; pages += 1) {
      let response: { data?: RpcTurn[]; nextCursor?: string | null };
      const request = (itemsView: string) => this.ctx.connection.requireTransport().request<{ data?: RpcTurn[]; nextCursor?: string | null }>('thread/turns/list', {
        threadId, ...(cursor ? { cursor } : {}), limit: 100, sortDirection: 'asc', itemsView,
      });
      try { response = await request('notLoaded'); } catch { response = await request('summary'); }
      if ((response.data ?? []).some(turn => turn.id === turnId)) return cursor ? { cursor } : {};
      if (!response.nextCursor) return undefined;
      cursor = response.nextCursor;
    }
    return undefined;
  }

  /** The real log is complete: the scratch window gives way to it, under the log's own generation. */
  private promoteToRealLog(): void {
    this.log.promote();
    this.turnMarkersSeen = new Map();
    this.ctx.drafts().resequence(nativeId => this.log.space.seqOf(nativeId));
    void this.refreshEvents().catch(() => undefined);
  }

  private setHistory(history: NonNullable<NativeStatus['history']>): void {
    const previous = this.ctx.status().history;
    if (!this.importStopped && history.state === 'error' && (previous?.state !== 'error' || previous.message !== history.message)) {
      console.warn('[codex-history]', JSON.stringify({
        sessionId: this.ctx.sessionId,
        nativeThreadId: this.ctx.threadId() ?? null,
        backendId: this.ctx.flavor.id,
        message: safeProviderError(history.message ?? 'The thread history could not be read.', this.ctx.profileConfig),
      }));
    }
    this.ctx.refreshStatus({ history });
  }

  noteHistoryFailure(error: unknown): void {
    this.historySnapshotReady = false;
    const message = safeProviderError(error, this.ctx.profileConfig);
    this.setHistory({ state: 'error', message });
  }

  private noteHistoryUnavailable(): void {
    this.historySnapshotReady = false;
    this.setHistory({ state: 'error', message: `${this.ctx.flavor.label} could not read this thread history from the connected app-server.` });
  }

  private noteHistoryReady(): void {
    this.setHistory({ state: 'ready' });
  }
}
