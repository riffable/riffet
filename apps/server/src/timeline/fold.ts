import { createHash } from 'node:crypto';
import type { NativeActivity, NativeJob, NativeWorkbenchEvent, Run, WorkbenchEvent } from '../../../../packages/contracts/src/index.js';
import { PENDING_ROW_POS, SYNC_BUDGET, type SyncLane, type TimelineRow, type TurnOutlineV3 } from '../../../../packages/contracts/src/sync.js';
import { buildTimeline, IncrementalTimeline } from '../../../../packages/timeline/src/buildTimeline.js';
import type { TimelineItem } from '../../../../packages/timeline/src/model.js';
import { appendProjectedEvents, projectEvents, projectionIndexes, type ProjectedEvent } from '../../../../packages/timeline/src/projectEvents.js';
import { isRunRow, pendingOf, POS_STEP, rowContent, rowPlaces, type RowContent, type RowPlace } from '../../../../packages/timeline/src/rows.js';
import { activityOfEvent, isLiveActivity } from '../journal/activity.js';
import { hasTurnEnded, servingKey, subagentMetaId, turnMetaId, type TurnEndStatus } from '../journal/ingest.js';
import { DRAFT_KIND, META_PREFIX, TOMBSTONE_KIND, type Journal, type JournalRow } from '../journal/journal.js';
import { fitRow, type BlobWriter } from './budget.js';
import type { RowState, TimelineTables } from './tables.js';

/*
 * One lane's fold (docs/SYNC-V3.md, 时间线由服务端折叠): the lane's journal log, its runs and jobs, folded
 * with `packages/timeline` into `timeline_rows`, each changed row taking the next lane seq.
 *
 * Only the tail is held and folded: the events from `windowStart` (a journal identity) on. Rows before it
 * belong to turns that are over and are not folded again; what they consumed (the runs their prompts
 * echoed) seeds the fold of the tail, which is how a cold start folds only the open turn. The window
 * moves forward when a new turn starts and the one before it can no longer change (`rebase`), and back
 * to an earlier turn start (`cut`) when something reaches into a turn already folded (`unfreeze`): a new
 * version of one of its entities, a tool update for one of its cards, late output, or a change to one
 * of its runs. A new activity state and a job or subagent change only rewrite their own row (`patch`).
 */

/** Bumped when a change to the fold rules must refold every lane: it changes every lane's generation. */
export const FOLD_VERSION = 10;
const READ_BATCH = 2000;
const PREVIEW_CHARS = 120;
const TERMINAL_RUN = new Set<Run['state']>(['completed', 'failed', 'cancelled', 'interrupted']);
const TOOL_TYPES = new Set(['tool_call', 'tool_call_update']);

const sha1 = (text: string) => createHash('sha1').update(text).digest('hex');
export const generationOf = (journalGeneration: string | undefined): string => sha1(`${journalGeneration ?? ''}\n${FOLD_VERSION}`);

export type ResetReason = 'rebuilt' | 'promoted' | 'fold';

/** What subscribers hear about a lane. A `rows` change is contiguous in seq and fits one frame. */
export type TimelineChange =
  | { type: 'rows'; generation: string; from: number; to: number; upserts: TimelineRow[]; deletes: string[] }
  | { type: 'reset'; generation: string; reason: ResetReason }
  | { type: 'outline'; generation: string; turnCount: number; turns: TurnOutlineV3[] };

/** A row's latest change: its content, or the key of a row that left. */
export type RowEntry = { seq: number; row: TimelineRow } | { seq: number; key: string };

/**
 * Changes in seq order as `rows` frames that each fit one SSE frame and together cover `from..to`
 * without a gap: each frame runs to its last entry's seq, the last one to `to`.
 */
export function rowFrames(generation: string, from: number, to: number, entries: readonly RowEntry[]): Array<Extract<TimelineChange, { type: 'rows' }>> {
  const frames: Array<Extract<TimelineChange, { type: 'rows' }>> = [];
  let frame: { upserts: TimelineRow[]; deletes: string[]; to: number; bytes: number } | undefined;
  const close = () => {
    if (frame) frames.push({ type: 'rows', generation, from: frames.length ? frames.at(-1)!.to + 1 : from, to: frame.to, upserts: frame.upserts, deletes: frame.deletes });
    frame = undefined;
  };
  for (const entry of entries) {
    const bytes = 'row' in entry ? Buffer.byteLength(JSON.stringify(entry.row)) : entry.key.length + 8;
    if (frame && frame.bytes + bytes > SYNC_BUDGET.frameBytes - 1024) close();
    frame ??= { upserts: [], deletes: [], to: entry.seq, bytes: 0 };
    frame.to = entry.seq;
    frame.bytes += bytes;
    if ('row' in entry) frame.upserts.push(entry.row); else frame.deletes.push(entry.key);
  }
  if (frame) frame.to = to;
  close();
  return frames;
}

export interface FoldInputs { runs: Run[]; jobs: NativeJob[]; chatId: string | undefined }

export interface FoldContext {
  journal: Journal;
  tables: TimelineTables;
  put: BlobWriter;
  /** The session no longer refers to these blobs: the whole of a cut row that was replaced or went. */
  release(sessionId: string, hashes: string[]): void;
  /** A subagent lane's summary for the tool row that started it. */
  subagent(sessionId: string, toolCallId: string): Pick<NonNullable<Extract<TimelineRow, { kind: 'tool' }>['subagent']>, 'rows' | 'running' | 'turnId' | 'status' | 'startedAt' | 'endedAt'>;
}

interface Entity { event: WorkbenchEvent; draft: boolean }
interface TurnMeta { started: boolean; runId?: string; status?: TurnEndStatus; endedAt?: string; error?: string; endIdentity?: number; reopened?: boolean }
interface SubagentMeta { agentId: string; title?: string; subagentType?: string; model?: string }
interface Emitted { item?: TimelineItem; deco: string; state: RowState }
interface Seed { seenRunIds: Set<string>; echoedRuns: Set<string>; echoedPrompts: Set<string> }
interface TurnTally { turn: string; startPos: number; endPos: number; at: string; rows: number; nativeTurn?: string; preview?: string; runId?: string; hasUserMessage: boolean; hasAttachments: boolean }

const str = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined;
const nativeTurnOf = (item: TimelineItem): string | undefined => (item.event as Partial<NativeWorkbenchEvent>).nativeTurnId ?? (item.kind === 'user' ? item.run?.native?.nativeTurnId : undefined);
const identityOfPos = (pos: number) => Math.floor(pos / POS_STEP);
const isTurnReopened = (row: JournalRow): boolean => row.kind === TOMBSTONE_KIND && Boolean(row.turnId) && row.nativeId === turnMetaId(row.turnId!, 'ended');

function sameSources(left: ProjectedEvent, right: ProjectedEvent): boolean {
  return left.projectionKey === right.projectionKey && left.sourceEvents.length === right.sourceEvents.length
    && left.sourceEvents.every((event, index) => event === right.sourceEvents[index]);
}

/** What a fold reads of a run: everything but its metrics, which change all the time and no row shows. */
const runSignature = (run: Run): string => JSON.stringify(run, (key, value) => key === 'metrics' ? undefined : value);

/**
 * The runs a timeline is built with: all but a cancellation that never reached the CLI, as the web did
 * (`NativeTimelineModel.syncPending`).
 */
export const timelineRuns = (runs: Run[]): Run[] => runs.filter(run => !(run.state === 'cancelled' && run.native && !run.native.nativeMessageId));

/** A tool card's run and call id, read back from its row key (`tool:[<run>:]<id>`, both percent-encoded). */
function toolKeyParts(key: string): { run?: string; id: string } | undefined {
  const parts = key.split(':');
  try {
    if (parts.length === 2) return { id: decodeURIComponent(parts[1]!) };
    if (parts.length === 3) return { run: decodeURIComponent(parts[1]!), id: decodeURIComponent(parts[2]!) };
  } catch { /* not a key the fold wrote */ }
  return undefined;
}

export class LaneFold {
  generation = '';
  headSeq = 0;
  /** The serving log's last seq the rows reflect. */
  journalSeq = 0;
  windowStart = 1;
  private key = '';
  private scratch = false;
  private journalGeneration: string | undefined;
  private entities = new Map<string, Entity>();
  private drafts = new WeakSet<WorkbenchEvent>();
  private events: WorkbenchEvent[] = [];
  private fresh: WorkbenchEvent[] = [];
  private reproject = true;
  private projected: ProjectedEvent[] = [];
  private indexes: ReturnType<typeof projectionIndexes> = { tools: new Map() };
  private timeline = new IncrementalTimeline();
  private items: TimelineItem[] = [];
  private places: RowPlace[] = [];
  private turnMetas = new Map<string, TurnMeta>();
  private subagents = new Map<string, SubagentMeta | null>();
  /** The latest background task each tool call started, by call id: its tool row carries it. */
  private toolActivities = new Map<string, NativeActivity>();
  private emitted = new Map<string, Emitted>();
  private outlines = new Map<string, TurnOutlineV3>();
  private seed: Seed = { seenRunIds: new Set(), echoedRuns: new Set(), echoedPrompts: new Set() };
  private frozenTurns = new Map<string, number>();
  private frozenTurnIds = new Map<string, number>();
  private frozenTools: Map<string, Array<{ key: string; run?: string; pos: number }>> | undefined;
  private runs: Run[] = [];
  private runSigs = new Map<string, string>();
  private jobs = new Map<string, NativeJob>();
  private chatId: string | undefined;
  /** Changes made since the last `take`, for subscribers. */
  private out: { upserts: TimelineRow[]; deletes: Array<{ key: string; seq: number }>; turns: Map<string, TurnOutlineV3> } = { upserts: [], deletes: [], turns: new Map() };

  private constructor(private readonly ctx: FoldContext, readonly sessionId: string, readonly lane: SyncLane) {}

  /**
   * Opens a lane from what is stored: only the open tail is read and folded. Says why its rows started over, if
   * they did. Of what the log gained since it was last folded it takes at most `limit` rows; `caughtUp` is false
   * when more are left for `sync`, so a log folded for the first time is folded a step at a time.
   */
  static open(ctx: FoldContext, sessionId: string, lane: SyncLane, inputs: FoldInputs, limit = Number.POSITIVE_INFINITY): { fold: LaneFold; reset?: ResetReason; caughtUp: boolean } {
    const fold = new LaneFold(ctx, sessionId, lane);
    const reset = fold.attach();
    fold.setInputs(inputs);
    const caughtUp = fold.loadFrom(fold.windowStart, fold.journalSeq, Math.max(fold.journalSeq, fold.windowStart - 1) + limit);
    fold.foldAndPersist();
    return { fold, caughtUp, ...(reset ? { reset } : {}) };
  }

  /** Whether the log that serves the lane is still the one these rows were folded from. */
  current(): boolean {
    const serving = servingKey(this.ctx.journal, this.sessionId, this.lane);
    return serving.key === this.key && this.ctx.journal.peek(serving.key)?.generation === this.journalGeneration;
  }

  /** Rows the lane holds now (live ones). */
  get liveRows(): number { return this.ctx.tables.countLive(this.sessionId, this.lane); }

  /** Whether the lane's newest turn has started and not ended. */
  get running(): boolean { return [...this.turnMetas.values()].some(meta => meta.started && !meta.status); }

  get subagentIds(): Iterable<string> { return [...this.subagents].flatMap(([id, meta]) => meta ? [id] : []); }

  // ---- inputs ------------------------------------------------------------------------------

  /** New runs, jobs or chat; a run change that reaches into a folded turn unfreezes it. */
  setInputs(inputs: FoldInputs): void {
    this.chatId = inputs.chatId;
    for (const job of inputs.jobs) this.setJob(job);
    const runs = timelineRuns(inputs.runs);
    const sigs = new Map(runs.map(run => [run.id, runSignature(run)]));
    const changed = [...new Set([...sigs.keys(), ...this.runSigs.keys()])].filter(id => sigs.get(id) !== this.runSigs.get(id));
    this.runSigs = sigs;
    if (!changed.length && runs.length === this.runs.length) return;
    this.runs = runs;
    let target = Number.POSITIVE_INFINITY;
    for (const id of changed) {
      if (!this.seed.echoedRuns.has(id) && !this.seed.seenRunIds.has(id)) continue;
      const run = runs.find(candidate => candidate.id === id) ?? this.runsById(id);
      const state = run ? this.ctx.tables.rowState(this.sessionId, this.lane, `user:${run.commandId || run.id}`) : undefined;
      target = Math.min(target, state ? identityOfPos(state.pos) : 1);
    }
    if (target < this.windowStart) this.unfreeze(target, this.journalSeq);
  }

  private runsById(id: string): Run | undefined { return this.runs.find(run => run.id === id); }

  setChat(chatId: string | undefined): void { this.chatId = chatId; }

  setJob(job: NativeJob): void {
    if (this.jobs.get(job.toolCallId) === job) return;
    this.jobs.set(job.toolCallId, job);
    this.timeline.setJob(job);
    for (const tool of this.frozenToolsOf(job.toolCallId)) this.patch(tool.key, row => row.kind === 'tool' ? { ...row, job } : undefined);
  }

  /** A tool's subagent lane or background task changed: its tool row's decoration is redone wherever that row is. */
  decorationChanged(toolCallId: string): void {
    const meta = this.subagents.get(toolCallId);
    for (const tool of this.frozenToolsOf(toolCallId)) this.patch(tool.key, row => {
      if (row.kind !== 'tool') return;
      const { subagent: _subagent, activity: _activity, ...base } = row;
      return { ...base, ...this.toolDecoration(toolCallId, meta ?? undefined) };
    });
  }

  // ---- the journal -------------------------------------------------------------------------

  /** Takes what the serving log has gained since the rows were folded, at most `limit` rows; true once that is all of it. */
  sync(limit = Number.POSITIVE_INFINITY): boolean {
    const since = this.journalSeq;
    const start = this.windowStart;
    const frozen: Array<{ identity: number; row: JournalRow }> = [];
    let caughtUp = false;
    let restoreDrafts = false;
    for (let after = since, left = limit; ;) {
      const batch = Math.min(READ_BATCH, left);
      const rows = this.ctx.journal.range(this.key, after, batch);
      for (const row of rows) {
        // A terminal fold hid drafts, but their latest journal versions still exist. Read the same
        // window again on reopening, including when the source rereads an identical draft (no append).
        if (isTurnReopened(row) && this.ctx.journal.locate(this.key, row.nativeId)?.seq === row.seq && this.turnMetas.get(row.turnId!)?.status) restoreDrafts = true;
        this.applyRow(row, frozen);
      }
      if (!rows.length) { caughtUp = true; break; }
      after = this.journalSeq = rows.at(-1)!.seq;
      left -= rows.length;
      if (rows.length < batch) { caughtUp = true; break; }
      if (left <= 0) break;
    }
    this.settleFrozen(frozen, since);
    if (restoreDrafts && this.windowStart === start) return this.loadFrom(start, since, this.journalSeq);
    return caughtUp;
  }

  /** Folds what changed and stores the rows that did. */
  flush(): void {
    this.foldAndPersist();
  }

  /** What subscribers have not heard yet, cut into frames. */
  take(): TimelineChange[] {
    const { upserts, deletes, turns } = this.out;
    this.out = { upserts: [], deletes: [], turns: new Map() };
    const entries: RowEntry[] = [...upserts.map(row => ({ seq: row.seq, row })), ...deletes.map(({ key, seq }) => ({ seq, key }))].sort((left, right) => left.seq - right.seq);
    const changes: TimelineChange[] = entries.length ? rowFrames(this.generation, entries[0]!.seq, entries.at(-1)!.seq, entries) : [];
    if (turns.size) changes.push({ type: 'outline', generation: this.generation, turnCount: this.ctx.tables.turnCount(this.sessionId, this.lane), turns: [...turns.values()] });
    return changes;
  }

  // ---- loading -----------------------------------------------------------------------------

  /** Points the fold at the log that serves; when that is another log, or the fold rules changed, the lane starts over. */
  private attach(): ResetReason | undefined {
    const { journal, tables } = this.ctx;
    const serving = servingKey(journal, this.sessionId, this.lane);
    this.key = serving.key;
    this.scratch = serving.scratch;
    this.journalGeneration = journal.peek(serving.key)?.generation;
    this.generation = generationOf(this.journalGeneration);
    const stored = tables.head(this.sessionId, this.lane);
    if (stored && stored.generation === this.generation) {
      this.headSeq = stored.headSeq;
      this.journalSeq = stored.journalSeq;
      this.windowStart = stored.foldedThrough + 1;
      return undefined;
    }
    this.headSeq = 0;
    this.journalSeq = 0;
    this.windowStart = 1;
    journal.tx(() => {
      const cut = tables.truncatedBlobs(this.sessionId, this.lane);
      tables.clearLane(this.sessionId, this.lane);
      if (cut.length) this.ctx.release(this.sessionId, cut);
      this.putHead();
    });
    if (!stored) return undefined;
    return stored.foldVersion !== FOLD_VERSION ? 'fold' : stored.scratch && !this.scratch ? 'promoted' : 'rebuilt';
  }

  private putHead(): void {
    this.ctx.tables.putHead({
      sessionId: this.sessionId, lane: this.lane, generation: this.generation, journalGeneration: this.journalGeneration ?? null, scratch: this.scratch,
      headSeq: this.headSeq, foldVersion: FOLD_VERSION, foldedThrough: this.windowStart - 1, journalSeq: this.journalSeq,
    });
  }

  /**
   * Reads the window from `start`: every entity from there on at its latest version, the turn and
   * subagent marks it needs, and what the rows before it consumed. Changes the log made after `since` to
   * entities before `start` are settled after. Rows past `upTo` are left for `sync`; true when there were none.
   */
  private loadFrom(start: number, since: number, upTo = Number.POSITIVE_INFINITY): boolean {
    const { journal, tables } = this.ctx;
    this.windowStart = start;
    this.entities = new Map();
    this.drafts = new WeakSet();
    this.events = [];
    this.fresh = [];
    this.turnMetas = new Map();
    this.subagents = new Map();
    this.toolActivities = new Map();
    this.frozenTools = undefined;
    // Frozen tools still depend on their child's current execution after this fold is reopened.
    for (const meta of journal.subagentEntities(this.key)) {
      const toolCallId = str((meta.payload as { toolCallId?: unknown }).toolCallId);
      if (toolCallId) this.subagents.set(toolCallId, this.subagentMetaOf(meta.payload));
    }
    for (const entity of journal.activityEntities(this.key)) {
      const activity = activityOfEvent(entity.payload);
      if (activity?.kind === 'background_task' && activity.toolCallId) this.toolActivities.set(activity.toolCallId, activity);
    }
    const frozen: Array<{ identity: number; row: JournalRow }> = [];
    let last = Math.max(0, start - 1), caughtUp = false;
    for (;;) {
      const batch = Math.min(READ_BATCH, upTo - last);
      if (batch <= 0) break;
      const rows = journal.range(this.key, last, batch);
      for (const row of rows) this.applyRow(row, frozen, since);
      if (!rows.length) { caughtUp = true; break; }
      last = rows.at(-1)!.seq;
      if (rows.length < batch) { caughtUp = true; break; }
    }
    if (!caughtUp) caughtUp = !journal.range(this.key, last, 1).length;
    this.journalSeq = caughtUp ? Math.max(this.journalSeq, last, journal.peek(this.key)?.lastSeq ?? 0) : Math.max(this.journalSeq, last);
    // Marks written before the window: the start of its first turn, the subagent of a tool it holds.
    for (const { event } of this.entities.values()) {
      const turnId = (event as Partial<NativeWorkbenchEvent>).nativeTurnId;
      if (turnId && !this.turnMetas.has(turnId)) this.readTurnMeta(turnId);
      const toolCallId = TOOL_TYPES.has(event.type) ? str(event.data.toolCallId) : undefined;
      if (toolCallId && !this.subagents.has(toolCallId)) {
        const meta = journal.entity(this.key, subagentMetaId(toolCallId));
        this.subagents.set(toolCallId, meta ? this.subagentMetaOf(meta.payload) : null);
      }
    }
    const boundary = start * POS_STEP;
    this.seed = { seenRunIds: new Set(), echoedRuns: new Set(), echoedPrompts: new Set() };
    for (const user of tables.usersBefore(this.sessionId, this.lane, boundary)) this.seedFromRow(JSON.parse(user.payload) as RowContent);
    this.frozenTurns = new Map();
    this.frozenTurnIds = new Map();
    for (const turn of tables.turnsBefore(this.sessionId, this.lane, boundary)) this.freezeTurn(turn.outline);
    this.emitted = new Map(tables.rowsFrom(this.sessionId, this.lane, boundary).map(state => [state.key, { deco: '', state }]));
    this.outlines = new Map(tables.turnsFrom(this.sessionId, this.lane, boundary).map(turn => [turn.turn, turn.outline]));
    this.reproject = true;
    this.timeline = new IncrementalTimeline(this.seed);
    for (const job of this.jobs.values()) this.timeline.setJob(job);
    this.settleFrozen(frozen, since);
    for (const [toolCallId, meta] of this.subagents) if (meta) this.decorationChanged(toolCallId);
    for (const toolCallId of this.toolActivities.keys()) if (!this.subagents.get(toolCallId)) this.decorationChanged(toolCallId);
    return caughtUp;
  }

  private readTurnMeta(turnId: string): void {
    const started = this.ctx.journal.entity(this.key, turnMetaId(turnId, 'started'));
    const ended = this.ctx.journal.entity(this.key, turnMetaId(turnId, 'ended'));
    if (!started && !ended) return;
    const runId = str((started?.payload as { runId?: unknown } | undefined)?.runId);
    const status = hasTurnEnded(this.ctx.journal, this.key, turnId) ? (ended!.payload as { status: TurnEndStatus }).status : undefined;
    this.turnMetas.set(turnId, { started: started?.kind === 'meta.turn_started', ...(runId ? { runId } : {}), ...(status ? { status, endedAt: ended!.at, error: str((ended!.payload as { error?: unknown }).error), endIdentity: this.ctx.journal.locate(this.key, ended!.nativeId)?.identity } : {}), ...(ended && isTurnReopened(ended) ? { reopened: true } : {}) });
  }

  private subagentMetaOf(payload: unknown): SubagentMeta | null {
    const value = payload as Record<string, unknown> | undefined;
    const agentId = str(value?.agentId);
    if (!agentId) return null;
    return { agentId, ...(str(value?.title) ? { title: str(value?.title) } : {}), ...(str(value?.subagentType) ? { subagentType: str(value?.subagentType) } : {}), ...(str(value?.model) ? { model: str(value?.model) } : {}) };
  }

  /** One row of the log into the window; a change to an entity before it is set aside in `frozen` when written after `since`. */
  private applyRow(row: JournalRow, frozen: Array<{ identity: number; row: JournalRow }>, since = -1): void {
    const reopened = isTurnReopened(row);
    if (row.kind.startsWith(META_PREFIX) || reopened) {
      if (reopened || row.kind === 'meta.turn_started' || row.kind === 'meta.turn_ended') {
        if (this.ctx.journal.locate(this.key, row.nativeId)?.seq !== row.seq) return;
      }
      if ((reopened || row.kind === 'meta.turn_ended') && row.turnId && row.seq > since) {
        const identity = this.ctx.journal.locate(this.key, turnMetaId(row.turnId, 'started'))?.identity;
        if (identity !== undefined && identity < this.windowStart) frozen.push({ identity, row });
      }
      // Frozen rows already contain the latest decoration. Reopening must not replay an older
      // metadata version over them and then number another update for the version already stored.
      this.applyMeta(since >= 0 && row.kind === 'meta.subagent' ? this.ctx.journal.entity(this.key, row.nativeId) ?? row : row);
      return;
    }
    const activity = activityOfEvent(row.payload);
    // loadFrom restored the latest activity states already; replaying earlier versions must not regress them.
    if (since < 0 && activity?.kind === 'background_task' && activity.toolCallId) {
      this.toolActivities.set(activity.toolCallId, activity);
      this.decorationChanged(activity.toolCallId);
    }
    const known = this.entities.get(row.nativeId);
    const identity = row.rev === 1 ? row.seq : known?.event.sequence ?? this.ctx.journal.locate(this.key, row.nativeId)?.identity ?? row.seq;
    if (identity < this.windowStart) {
      if (row.seq > since) frozen.push({ identity, row });
      return;
    }
    const draft = row.kind === DRAFT_KIND;
    // A draft chunk emptied once its entity committed (`compactDrafts`) says nothing; the committed version does.
    const payload = row.payload as { type?: unknown; data?: unknown } | undefined;
    if (row.kind !== TOMBSTONE_KIND && (typeof payload?.type !== 'string' || !payload.data || typeof payload.data !== 'object')) return;
    // A draft is the step the CLI has not committed; once its turn is over it is gone (as the web dropped it).
    if (row.kind === TOMBSTONE_KIND || (draft && this.turnEnded(row.turnId))) {
      if (known) this.removeEntity(row.nativeId, known);
      return;
    }
    const event = { ...(row.payload as Omit<NativeWorkbenchEvent, 'sequence' | 'sessionId'>), sessionId: this.sessionId, sequence: identity } as WorkbenchEvent;
    if (draft) this.drafts.add(event);
    if (!known) {
      const toolCallId = TOOL_TYPES.has(event.type) ? str(event.data.toolCallId) : undefined;
      const card = toolCallId ? this.frozenCard(toolCallId, event.runId) : undefined;
      if (card) frozen.push({ identity: identityOfPos(card.pos), row });
    }
    this.entities.set(row.nativeId, { event, draft });
    if (known) {
      this.events[this.indexOf(known.event.sequence)] = event;
      this.reproject = true;
    } else if (!this.events.length || identity > this.events.at(-1)!.sequence) {
      this.events.push(event);
      if (!this.reproject) this.fresh.push(event);
    } else {
      this.events.splice(this.insertionPoint(identity), 0, event);
      this.reproject = true;
    }
  }

  private applyMeta(row: JournalRow): void {
    const payload = row.payload as Record<string, unknown>;
    const turnId = str(payload.turnId);
    if (row.kind === 'meta.turn_started' && turnId) {
      const meta = this.turnMetas.get(turnId);
      const runId = str(payload.runId) ?? meta?.runId;
      this.turnMetas.set(turnId, { ...meta, started: true, ...(runId ? { runId } : {}) });
      this.reproject = true;
    } else if (isTurnReopened(row)) {
      this.readTurnMeta(row.turnId!);
      this.reproject = true;
    } else if (row.kind === 'meta.turn_ended' && turnId && hasTurnEnded(this.ctx.journal, this.key, turnId)) {
      this.turnMetas.set(turnId, { started: true, ...this.turnMetas.get(turnId), reopened: false, status: payload.status as TurnEndStatus, endedAt: row.at, error: str(payload.error), endIdentity: this.ctx.journal.locate(this.key, row.nativeId)?.identity });
      this.reproject = true;
      for (const [nativeId, entity] of this.entities) if (entity.draft && (entity.event as Partial<NativeWorkbenchEvent>).nativeTurnId === turnId) this.removeEntity(nativeId, entity);
      if (this.frozenTurnIds.has(turnId)) this.patchFrozenOutline(turnId);
    } else if (row.kind === 'meta.subagent') {
      const toolCallId = str(payload.toolCallId);
      if (toolCallId) this.subagents.set(toolCallId, this.subagentMetaOf(payload));
      if (toolCallId) this.decorationChanged(toolCallId);
    }
  }

  private turnEnded(turnId: string | undefined): boolean { return Boolean(turnId && hasTurnEnded(this.ctx.journal, this.key, turnId)); }

  private removeEntity(nativeId: string, entity: Entity): void {
    this.entities.delete(nativeId);
    this.events.splice(this.indexOf(entity.event.sequence), 1);
    this.reproject = true;
  }

  private insertionPoint(sequence: number): number {
    let low = 0, high = this.events.length;
    while (low < high) { const mid = (low + high) >> 1; if (this.events[mid]!.sequence < sequence) low = mid + 1; else high = mid; }
    return low;
  }

  private indexOf(sequence: number): number { return this.insertionPoint(sequence); }

  /**
   * Changes to entities before the window: a new activity state rewrites its own row; anything else
   * folds again from the cut before the earliest one it touches.
   */
  private settleFrozen(frozen: Array<{ identity: number; row: JournalRow }>, since: number): void {
    if (!frozen.length) return;
    let target = Number.POSITIVE_INFINITY;
    const patches: Array<{ identity: number; row: JournalRow }> = [];
    for (const change of frozen) {
      const activity = change.row.kind !== TOMBSTONE_KIND && change.row.kind !== DRAFT_KIND && activityOfEvent(change.row.payload);
      if (activity && this.ctx.tables.rowState(this.sessionId, this.lane, `activity:${activity.id}`)?.deleted === false) patches.push(change);
      else target = Math.min(target, change.identity);
    }
    if (target < this.windowStart) { this.unfreeze(target, since); return; }
    for (const { identity, row } of patches) {
      const event = { ...(row.payload as object), sessionId: this.sessionId, sequence: identity } as WorkbenchEvent;
      const [item] = buildTimeline(projectEvents([event]), []);
      if (item?.kind === 'activity') this.patch(item.key, (_row, state) => rowContent(item, { pos: state.pos, turn: state.turn }));
    }
  }

  /** Folds again from the latest cut at or before identity `at`. */
  private unfreeze(at: number, since: number): void {
    const cut = this.ctx.tables.cutAtOrBefore(this.sessionId, this.lane, at) ?? 1;
    if (cut >= this.windowStart) return;
    this.loadFrom(cut, since);
  }

  // ---- folded rows -------------------------------------------------------------------------

  private seedFromRow(row: RowContent): void {
    if (row.kind !== 'user' || !row.runId) return;
    // A run row (an unechoed prompt) is made with empty data; a row folded from an event never is (see `rows.ts`).
    if (!Object.keys(row.event.data).length) { this.seed.echoedRuns.add(row.runId); return; }
    this.seed.seenRunIds.add(row.runId);
    this.seed.echoedRuns.add(row.runId);
    if (!this.runsById(row.runId)?.native) this.seed.echoedPrompts.add(row.text);
  }

  private freezeTurn(outline: TurnOutlineV3): void {
    this.frozenTurns.set(outline.turn, outline.startPos);
    this.frozenTurnIds.set(outline.turnId, outline.startPos);
  }

  /** Tool rows before the window by call id, read once. */
  private frozenToolMap(): NonNullable<LaneFold['frozenTools']> {
    if (!this.frozenTools) {
      this.frozenTools = new Map();
      for (const tool of this.ctx.tables.toolsBefore(this.sessionId, this.lane, this.windowStart * POS_STEP)) {
        const parts = toolKeyParts(tool.key);
        if (!parts) continue;
        const list = this.frozenTools.get(parts.id) ?? [];
        list.push({ key: tool.key, ...(parts.run ? { run: parts.run } : {}), pos: tool.pos });
        this.frozenTools.set(parts.id, list);
      }
    }
    return this.frozenTools;
  }

  private frozenToolsOf(toolCallId: string): Array<{ key: string; run?: string; pos: number }> {
    return this.frozenToolMap().get(toolCallId) ?? [];
  }

  /** The folded card a tool event of the window would join (see `toolCardIndex`): same run, or either without one. */
  private frozenCard(toolCallId: string, runId: string | undefined): { pos: number } | undefined {
    return this.frozenToolsOf(toolCallId).find(card => !runId || !card.run || card.run === runId);
  }

  private subagentSummary(toolCallId: string, meta: SubagentMeta): NonNullable<Extract<TimelineRow, { kind: 'tool' }>['subagent']> {
    const child = this.ctx.subagent(this.sessionId, toolCallId);
    const linked = this.toolActivities.get(toolCallId);
    const activity = linked?.task?.kind === 'agent' ? linked : undefined;
    // An agent id can be woken again without a new background launch. Its lane's current turn is
    // authoritative; a delayed task notification has no execution identity with which to replace it.
    const outcome = !child.status && activity ? activity.status === 'failed' ? 'failed' : activity.status === 'stopped' ? 'cancelled' : activity.status === 'completed' ? 'completed' : activity.status === 'running' ? 'running' : undefined : undefined;
    return { lane: `sub:${toolCallId}`, agentId: meta.agentId, ...child, ...(outcome ? { status: outcome, running: outcome === 'running', ...(activity?.startedAt ? { startedAt: activity.startedAt } : {}), ...(activity?.endedAt ? { endedAt: activity.endedAt } : {}) } : {}), ...(meta.title ? { title: meta.title } : {}), ...(meta.subagentType ? { subagentType: meta.subagentType } : {}), ...(meta.model ? { model: meta.model } : {}) };
  }

  /** Rewrites one stored row in place, outside the fold (it keeps its place and turn). */
  private patch(key: string, change: (row: RowContent, state: RowState) => RowContent | undefined): void {
    const { tables } = this.ctx;
    const stored = tables.row(this.sessionId, this.lane, key);
    if (!stored || stored.deleted) return;
    const next = change(JSON.parse(stored.payload) as RowContent, stored);
    if (!next) return;
    const json = JSON.stringify(next);
    const digest = sha1(json);
    if (digest === stored.digest) return;
    this.ctx.journal.tx(() => {
      this.write(next, digest, stored);
      this.putHead();
    });
  }

  private patchFrozenOutline(turnId: string): void {
    const startPos = this.frozenTurnIds.get(turnId);
    const stored = this.ctx.tables.turnsBefore(this.sessionId, this.lane, this.windowStart * POS_STEP).find(turn => turn.startPos === startPos && turn.outline.turnId === turnId);
    const meta = this.turnMetas.get(turnId);
    if (!stored || !meta?.status) return;
    const outline: TurnOutlineV3 = { ...stored.outline, status: meta.status === 'interrupted' ? 'cancelled' : meta.status, ...(meta.endedAt ? { endedAt: meta.endedAt } : {}) };
    if (JSON.stringify(outline) === JSON.stringify(stored.outline)) return;
    this.ctx.journal.tx(() => this.ctx.tables.putTurn(this.sessionId, this.lane, outline, null));
    this.out.turns.set(outline.turn, outline);
  }

  /** Stores a changed row under the next seq. */
  private write(row: RowContent, digest: string, previous: RowState | undefined): RowState {
    const seq = ++this.headSeq;
    const rev = (previous?.rev ?? 0) + 1;
    const fitted = fitRow(row, this.sessionId, this.ctx.put);
    const state: RowState = { key: row.key, pos: row.pos, turn: row.turn, seq, rev, ...(row.runId ? { runId: row.runId } : {}), deleted: false, kind: row.kind, digest, bytes: fitted.bytes };
    // The whole of a cut row is kept for as long as the row is; its next version names a blob of its own.
    const superseded = previous && !previous.deleted ? this.ctx.tables.truncatedBlobOf(this.sessionId, this.lane, row.key) : undefined;
    this.ctx.tables.putRow(this.sessionId, this.lane, state, fitted.json);
    if (superseded && superseded !== fitted.row.truncated?.blobRef) this.ctx.release(this.sessionId, [superseded]);
    this.out.upserts.push({ ...fitted.row, seq, rev } as TimelineRow);
    return state;
  }

  // ---- folding -----------------------------------------------------------------------------

  /** End metadata owns a native turn's failure; command outcomes remain available for settlement. */
  private eventsWithTurnFailures(): WorkbenchEvent[] {
    const legacy = new Map<string, WorkbenchEvent>();
    const contentEnds = new Map<string, number>();
    for (const event of this.events) {
      const turnId = (event as Partial<NativeWorkbenchEvent>).nativeTurnId;
      if (event.type === 'run_failed' && turnId) legacy.set(turnId, event);
      if (turnId && !event.type.startsWith('run_')) contentEnds.set(turnId, Math.max(contentEnds.get(turnId) ?? 0, event.sequence));
    }
    const events = this.events.filter(event => {
      if (event.type !== 'run_failed' && event.type !== 'run_cancelled' && event.type !== 'run_interrupted') return true;
      const meta = this.turnMetas.get((event as Partial<NativeWorkbenchEvent>).nativeTurnId ?? '');
      if (meta?.reopened) return false;
      // A reopened/corrected result also retires a former cancellation, without changing the
      // command outcome retained by the journal for settlement.
      return !meta?.status || (event.type !== 'run_failed' && meta.status === 'interrupted');
    });
    for (const [turnId, meta] of this.turnMetas) {
      if (meta.status !== 'failed' || meta.endIdentity === undefined || meta.endIdentity < this.windowStart) continue;
      const previous = legacy.get(turnId);
      const error = meta.error ?? str(previous?.data.error);
      if (!error && !previous) continue;
      events.push({
        // Reopening retains the first end identity. Put the failure after any newer content of
        // its own turn, beyond that event's run-row slots and before the next journal entity.
        sessionId: this.sessionId, sequence: Math.max(meta.endIdentity, (contentEnds.get(turnId) ?? 0) + 0.5), type: 'run_failed',
        nativeId: `${turnMetaId(turnId, 'ended')}:failure`, nativeTurnId: turnId,
        createdAt: meta.endedAt!, data: error ? { error } : {},
        ...(meta.runId ? { runId: meta.runId } : {}),
      } as NativeWorkbenchEvent);
    }
    // Preserve the fast append path when no end metadata contributes to this view.
    if (events.length === this.events.length && events.every((event, index) => event === this.events[index])) return this.events;
    return events.sort((left, right) => left.sequence - right.sequence);
  }

  private project(): void {
    const events = this.reproject || this.fresh.length ? this.eventsWithTurnFailures() : this.events;
    if (this.reproject || events !== this.events) {
      const old = new Map(this.projected.map(event => [event.projectionKey, event]));
      this.projected = projectEvents(events).map(event => { const previous = old.get(event.projectionKey); return previous && sameSources(previous, event) ? previous : event; });
      this.indexes = projectionIndexes(this.projected, events.at(-1));
    } else if (this.fresh.length && appendProjectedEvents(this.projected, this.fresh, this.indexes).appended < 0) {
      this.projected = projectEvents(events);
      this.indexes = projectionIndexes(this.projected, events.at(-1));
    }
    this.reproject = false;
    this.fresh = [];
    this.items = this.timeline.build(this.projected, this.runs, this.jobs, this.chatId);
    this.places = rowPlaces(this.items, { base: this.windowStart });
  }

  /** The turn start of a folded turn some row of the window belongs to (late output), if any. */
  private reachedBack(): number | undefined {
    if (!this.frozenTurns.size) return undefined;
    let target: number | undefined;
    this.items.forEach((item, index) => {
      const nativeTurn = nativeTurnOf(item);
      const pos = this.frozenTurns.get(this.places[index]!.turn) ?? (nativeTurn ? this.frozenTurnIds.get(nativeTurn) : undefined);
      if (pos !== undefined) target = Math.min(target ?? pos, pos);
    });
    return target === undefined ? undefined : identityOfPos(target);
  }

  private toolDecoration(toolCallId: string, meta?: SubagentMeta): Pick<Extract<RowContent, { kind: 'tool' }>, 'subagent' | 'activity'> {
    const subagent = meta ? this.subagentSummary(toolCallId, meta) : undefined;
    // Keep the real activity and its identity even across a child wake. Clients merge its standalone
    // row into the tool, but only use its clock and stop control when it agrees with the current turn.
    const activity = this.toolActivities.get(toolCallId);
    return { ...(subagent ? { subagent } : {}), ...(activity ? { activity } : {}) };
  }

  private decoration(item: TimelineItem): { deco: string; subagent?: ReturnType<LaneFold['subagentSummary']>; activity?: NativeActivity } {
    if (item.kind !== 'tool') return { deco: '' };
    const toolCallId = str(item.event.data.toolCallId);
    const fields = toolCallId ? this.toolDecoration(toolCallId, this.subagents.get(toolCallId) ?? undefined) : {};
    return { deco: JSON.stringify(fields), ...fields };
  }

  private foldAndPersist(): void {
    this.project();
    for (let attempts = 0; attempts < 8; attempts += 1) {
      const back = this.reachedBack();
      if (back === undefined || back >= this.windowStart) break;
      const before = this.windowStart;
      this.unfreeze(back, this.journalSeq);
      if (this.windowStart === before) break;
      this.project();
    }
    this.persist();
    if (this.rebase()) {
      this.project();
      this.persist();
    }
  }

  private persist(): void {
    const changed: Array<{ row: RowContent; digest: string; previous?: Emitted; item: TimelineItem; deco: string }> = [];
    const seen = new Set<string>();
    const turns = new Map<string, TurnTally>();
    this.items.forEach((item, index) => {
      if (seen.has(item.key)) return;
      seen.add(item.key);
      const place = this.places[index]!;
      this.accumulateTurn(turns, item, place);
      const { deco, subagent, activity } = this.decoration(item);
      const previous = this.emitted.get(item.key);
      if (previous && previous.item === item && previous.deco === deco && previous.state.pos === place.pos && previous.state.turn === place.turn) return;
      const row = rowContent(item, place);
      if (subagent) (row as Extract<RowContent, { kind: 'tool' }>).subagent = subagent;
      if (activity) (row as Extract<RowContent, { kind: 'tool' }>).activity = activity;
      const digest = sha1(JSON.stringify(row));
      if (previous && previous.state.digest === digest) { previous.item = item; previous.deco = deco; return; }
      changed.push({ row, digest, ...(previous ? { previous } : {}), item, deco });
    });
    const gone = [...this.emitted.keys()].filter(key => !seen.has(key));
    const outlines = this.outlinesOf(turns);
    const outlineChanges = [...outlines.values()].filter(outline => JSON.stringify(outline) !== JSON.stringify(this.outlines.get(outline.turn)));
    const outlineGone = [...this.outlines.keys()].filter(turn => !outlines.has(turn));
    const stored = this.ctx.tables.head(this.sessionId, this.lane);
    const headMoved = !stored || stored.journalSeq !== this.journalSeq || stored.foldedThrough !== this.windowStart - 1;
    if (!changed.length && !gone.length && !outlineChanges.length && !outlineGone.length && !headMoved) return;
    const { tables } = this.ctx;
    this.ctx.journal.tx(() => {
      for (const change of changed) {
        const previous = change.previous?.state ?? tables.rowState(this.sessionId, this.lane, change.row.key);
        const state = this.write(change.row, change.digest, previous);
        this.emitted.set(change.row.key, { item: change.item, deco: change.deco, state });
      }
      for (const key of gone) {
        const previous = this.emitted.get(key)!.state;
        const state: RowState = { ...previous, seq: ++this.headSeq, rev: previous.rev + 1, deleted: true, digest: '', bytes: 0 };
        const superseded = tables.truncatedBlobOf(this.sessionId, this.lane, key);
        tables.putRow(this.sessionId, this.lane, state, '');
        if (superseded) this.ctx.release(this.sessionId, [superseded]);
        this.emitted.delete(key);
        this.out.deletes.push({ key, seq: state.seq });
      }
      for (const outline of outlineChanges) { tables.putTurn(this.sessionId, this.lane, outline, null); this.outlines.set(outline.turn, outline); this.out.turns.set(outline.turn, outline); }
      for (const turn of outlineGone) {
        const outline = this.outlines.get(turn)!;
        tables.deleteTurn(this.sessionId, this.lane, turn);
        this.outlines.delete(turn);
        // A turn left with no rows is announced as such: `rows: 0`.
        this.out.turns.set(turn, { ...outline, rows: 0 });
      }
      this.putHead();
    });
  }

  private accumulateTurn(turns: Map<string, TurnTally>, item: TimelineItem, place: RowPlace): void {
    const nativeTurn = nativeTurnOf(item);
    const runId = place.turn.startsWith('run:') ? place.turn.slice('run:'.length) : item.kind === 'user' ? item.run?.id : undefined;
    const preview = item.kind === 'user' ? item.text.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS) : undefined;
    const tally = turns.get(place.turn);
    if (!tally) {
      turns.set(place.turn, { turn: place.turn, startPos: place.pos, endPos: place.pos, at: item.event.createdAt, rows: 1, hasUserMessage: item.kind === 'user', hasAttachments: item.kind === 'user' && item.attachments.length > 0, ...(nativeTurn ? { nativeTurn } : {}), ...(preview ? { preview } : {}), ...(runId ? { runId } : {}) });
      return;
    }
    tally.rows += 1;
    tally.startPos = Math.min(tally.startPos, place.pos);
    tally.endPos = Math.max(tally.endPos, place.pos);
    tally.nativeTurn ??= nativeTurn;
    tally.preview ??= preview || undefined;
    tally.runId ??= runId;
    tally.hasUserMessage ||= item.kind === 'user';
    tally.hasAttachments ||= item.kind === 'user' && item.attachments.length > 0;
  }

  /** Each turn's status: its end mark, else its run, else whether it has started without ending. */
  private outlinesOf(turns: Map<string, TurnTally>): Map<string, TurnOutlineV3> {
    const outlines = new Map<string, TurnOutlineV3>();
    for (const [turn, tally] of turns) {
      const turnId = tally.nativeTurn ?? tally.runId ?? turn;
      const meta = this.turnMetas.get(turnId);
      const run = tally.runId ? this.runsById(tally.runId) : undefined;
      const status: TurnOutlineV3['status'] = meta?.status ? (meta.status === 'interrupted' ? 'cancelled' : meta.status)
        : meta?.reopened ? 'running' : run ? (run.state === 'queued' || run.state === 'running' ? 'running' : run.state === 'interrupted' ? 'cancelled' : run.state)
          : meta?.started ? 'running' : 'completed';
      outlines.set(turn, {
        turn, turnId, startPos: tally.startPos, ...(status !== 'running' ? { endPos: tally.endPos } : {}), status, at: tally.at,
        ...(meta?.endedAt ? { endedAt: meta.endedAt } : {}), ...(tally.preview ? { preview: tally.preview } : {}), hasUserMessage: tally.hasUserMessage, hasAttachments: tally.hasAttachments, rows: tally.rows, ...(tally.runId ? { runId: tally.runId } : {}),
      });
    }
    return outlines;
  }

  /**
   * Moves the window to the start of the newest turn once the turns before it can no longer change: it
   * starts with a prompt echoed by the transcript, has an identity of its own, shares no turn with the
   * rows before it, holds no row logged before that prompt, and nothing before it is still live (an
   * unechoed or unfinished run, a running activity or job, a draft) or reaches into it (an entry whose
   * sources run past its start).
   */
  private rebase(): boolean {
    const last = this.places.findLastIndex(place => place.pos < PENDING_ROW_POS);
    if (last <= 0) return false;
    let start = last;
    while (start > 0 && this.places[start - 1]!.turn === this.places[last]!.turn) start -= 1;
    if (start === 0) return false;
    const first = this.items[start]!;
    const turn = this.places[start]!.turn;
    if (first.kind !== 'user' || isRunRow(first) || first.event.type !== 'user_message_chunk' || !/^(?:run|native):/.test(turn)) return false;
    const before = new Set(this.places.slice(0, start).map(place => place.turn));
    if (this.places.slice(start).some(place => before.has(place.turn))) return false;
    if ([...before].some(key => this.outlines.get(key)?.status === 'running')) return false;
    for (const item of this.items.slice(0, start)) {
      if (item.kind === 'user' && (pendingOf(item) || (item.run ? !TERMINAL_RUN.has(item.run.state) : isRunRow(item)))) return false;
      if (item.kind === 'activity' && isLiveActivity(item.activity)) return false;
      if (item.kind === 'tool' && item.job?.status === 'running') return false;
    }
    const cut = first.event.sequence;
    // A row filed after the prompt can come from before it (Claude logs a compaction ahead of its `/compact`).
    if (this.items.slice(start).some(item => item.event.sourceEvents.some(source => source.sequence < cut))) return false;
    for (const event of this.projected) {
      if (event.sequence >= cut) break;
      if (event.sourceEvents.some(source => source.sequence >= cut || this.drafts.has(source))) return false;
    }
    // Freeze what is before the cut.
    for (const [index, item] of this.items.slice(0, start).entries()) {
      if (item.kind === 'user') this.seedFromRow(rowContent(item, this.places[index]!));
      this.emitted.delete(item.key);
    }
    for (const turnKey of before) {
      const outline = this.outlines.get(turnKey);
      if (outline) this.freezeTurn(outline);
      this.outlines.delete(turnKey);
    }
    this.frozenTools = undefined;
    this.windowStart = cut;
    for (const [nativeId, entity] of this.entities) if (entity.event.sequence < cut) this.entities.delete(nativeId);
    this.events = this.events.filter(event => event.sequence >= cut);
    this.reproject = true;
    this.timeline = new IncrementalTimeline(this.seed);
    for (const job of this.jobs.values()) this.timeline.setJob(job);
    const outline = this.outlines.get(turn);
    this.ctx.journal.tx(() => {
      if (outline) this.ctx.tables.putTurn(this.sessionId, this.lane, outline, cut);
      this.putHead();
    });
    return true;
  }
}
