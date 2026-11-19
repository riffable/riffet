import type { DatabaseSync } from 'node:sqlite';
import { SERVER_BUDGET, STORAGE_BUDGET, type NativeActivity, type NativeJob, type NativeWorkbenchEvent, type Run, type WorkbenchEvent } from '../../../../packages/contracts/src/index.js';
import { SYNC_BUDGET, type FileChange, type LaneFind, type SyncLane, type TimelineChanges, type TimelinePage, type TimelineRow, type TurnOutlineV3 } from '../../../../packages/contracts/src/sync.js';
import { buildTimeline } from '../../../../packages/timeline/src/buildTimeline.js';
import { projectEvents } from '../../../../packages/timeline/src/projectEvents.js';
import { rowContent, type RowContent } from '../../../../packages/timeline/src/rows.js';
import { isLiveActivity } from '../journal/activity.js';
import { blobSha256 } from '../journal/blob-store.js';
import { eventLoopBusy } from '../loop-health.js';
import { META_PREFIX, TOMBSTONE_KIND, laneKey, type Journal, type JournalAppend, type SessionBlobResult } from '../journal/journal.js';
import { hasTurnEnded, servingKey, turnMetaId } from '../journal/ingest.js';
import { reclaimFreePages } from '../sqlite-storage.js';
import { materializeRowImages, type BlobWriter } from './budget.js';
import { generationOf, LaneFold, rowFrames, timelineRuns, type FoldContext, type FoldInputs, type RowEntry, type TimelineChange } from './fold.js';
import { LaneFinder } from './find.js';
import { rowOf, TimelineTables, type StoredSubagentSummary } from './tables.js';
import { toolFileChanges } from '../../../../packages/timeline/src/lineDiff.js';

export { FOLD_VERSION, type ResetReason, type TimelineChange } from './fold.js';

/*
 * The server's timeline (docs/SYNC-V3.md, 时间线由服务端折叠): every lane's journal log, runs and jobs folded
 * into `timeline_rows`, kept current as they change, and read back for sync by seq (`changes`), by place
 * (`page`, `snapshot`) and by turn (`outline`).
 *
 * Folding never runs on a caller's stack. A journal commit schedules it for the next turn of the event
 * loop; a run, job or subagent change waits `debounceMs` so a burst folds once. Readers read the tables,
 * which hold what the last fold committed; `ready` waits for a lane to be current first.
 */

export interface TimelineDeps {
  /** The database the journal writes to; the timeline tables live beside its tables. */
  db: DatabaseSync;
  journal: Journal;
  /** A session's runs, oldest first (`Store.listRuns`). */
  listRuns(sessionId: string): Run[];
  /** Committed run changes (`Store.onRunChanged`). */
  onRunChanged?(listener: (run: Run) => void): () => void;
  /** The native chat a session's main lane is read from (`Session.nativeSessionId`). */
  nativeChatId?(sessionId: string): string | undefined;
  /** A session's background jobs, by the tool call that started each. */
  listJobs?(sessionId: string): NativeJob[];
  onJobChanged?(listener: (sessionId: string, job: NativeJob) => void): () => void;
  /** A deleted conversation, whose queued folds are dropped instead of writing its rows again. */
  deleted?(sessionId: string): boolean;
  /** Where blobs a row refers to go; `journal.putSessionBlob` by default. */
  putBlob?: BlobWriter;
  /** Lets go of blobs no row refers to any more; `journal.releaseSessionBlobs` by default. */
  releaseBlobs?(sessionId: string, hashes: string[]): void;
  /** Log rows folded per turn of the event loop; a longer stretch (a first fold, an import) takes several. */
  stepRows?: number;
  /** Lanes kept folded in memory; a lane past it folds its open turn again when next needed. */
  hotLanes?: number;
  debounceMs?: number;
  /** Told of a lane that failed to fold; the default logs it. */
  onError?(error: unknown, sessionId: string, lane: SyncLane): void;
  /**
   * When a session was last active, and whether it is running now; undefined when unknown (its rows are kept).
   * The default reads the store's `sessions` table in `db`.
   */
  activity?(sessionId: string): { at?: string; running: boolean } | undefined;
  /** Whether the event loop is lagging, which defers the cold sweep; `eventLoopBusy` by default. */
  busy?(): boolean;
  /** When the cold sweep first runs and how often after; `false` turns it off. */
  coldSweep?: false | { firstMs: number; everyMs: number };
}

export interface TimelineHead { generation: string; headSeq: number }

export interface Budget { bytes?: number; rows?: number }

/** A snapshot of the newest rows within a budget, read a part (≤ one frame) at a time. */
export interface TimelineSnapshot {
  generation: string;
  asOfSeq: number;
  hasBefore: boolean;
  parts(): Generator<{ part: number; final: boolean; rows: TimelineRow[] }>;
}

interface Hot { fold: LaneFold }
type SubagentProgress = ReturnType<FoldContext['subagent']>;
interface Work { journal: boolean; runs: boolean; jobs: NativeJob[]; subagents: Set<string>; waiters: Array<() => void> }

/** The files a subagent row names at most; the newest are kept. */
const MAX_SUBAGENT_CHANGES = 200;
const laneId = (sessionId: string, lane: SyncLane) => `${sessionId}\n${lane}`;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, Math.floor(value)));
const TERMINAL_RUNS = new Set<Run['state']>(['completed', 'failed', 'cancelled', 'interrupted']);
const MAX_POS = Number.MAX_SAFE_INTEGER;
/** Log rows a fold takes per turn of the event loop: a few tens of milliseconds of folding at most. */
const STEP_ROWS = 1_000;
/** Rows a cold drop deletes per transaction; the event loop is yielded between chunks. */
const COLD_CHUNK_ROWS = 2_000;
/** Rows of the job check read per turn of the event loop. */
const COLD_SCAN_ROWS = 500;
const COLD_FIRST_MS = 5 * 60_000;
const COLD_EVERY_MS = 6 * 60 * 60_000;
const COLD_RETRY_MS = 30_000;
const RUNNING_STATES = new Set(['starting', 'running', 'waiting', 'cancelling']);

export class TimelineService {
  private readonly tables: TimelineTables;
  private readonly finder: LaneFinder;
  private readonly context: FoldContext;
  private readonly hot = new Map<string, Hot>();
  private readonly listeners = new Map<string, Set<(change: TimelineChange) => void>>();
  private readonly work = new Map<string, Work>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly summaries = new Map<string, SubagentProgress>();
  /** Summaries whose lane has gained rows since: re-read on use, yet still what a change is compared with. */
  private readonly staleSummaries = new Set<string>();
  /** Per subagent lane, the files each tool row changed, by row key and the content digest they were read at (a rebuilt lane counts revisions again). */
  private readonly laneFileChanges = new Map<string, Map<string, { digest: string; changes: FileChange[] }>>();
  private immediate: ReturnType<typeof setImmediate> | undefined;
  private readonly offs: Array<() => void> = [];
  private closed = false;
  private coldTimers: Array<ReturnType<typeof setTimeout>> = [];
  private sweeping: Promise<number> | undefined;
  private readonly coldWaits = new Map<ReturnType<typeof setTimeout>, () => void>();
  /** Lanes of a cold drop whose rows are still being deleted. */
  private readonly dropping = new Set<string>();
  /** Bounded LRU of on-demand expanded truncated rows, keyed by `${sessionId}\n${hash}`. */
  private readonly expandedCache = new Map<string, Buffer>();
  private expandedCacheBytes = 0;

  constructor(private readonly deps: TimelineDeps) {
    this.tables = new TimelineTables(deps.db);
    this.finder = new LaneFinder(this.tables);
    const put = deps.putBlob ?? ((sessionId: string, bytes: Buffer, type: string) => deps.journal.putSessionBlob(sessionId, bytes, type));
    const release = deps.releaseBlobs ?? ((sessionId: string, hashes: string[]) => deps.journal.releaseSessionBlobs(sessionId, hashes));
    this.context = { journal: deps.journal, tables: this.tables, put, release, subagent: (sessionId, toolCallId) => this.summary(sessionId, toolCallId) };
    deps.journal.setFallbackBlobResolver((sessionId, hash) => this.expandTruncatedBlob(sessionId, hash));
    this.offs.push(deps.journal.onAppend(change => this.noteAppend(change)));
    // A lane not folded now takes up its runs and jobs when it is next opened (`LaneFold.open`).
    if (deps.onRunChanged) this.offs.push(deps.onRunChanged(run => { if (this.wanted(run.sessionId, 'main')) this.later(run.sessionId, 'main', work => { work.runs = true; }); }));
    if (deps.onJobChanged) this.offs.push(deps.onJobChanged((sessionId, job) => { if (this.wanted(sessionId, 'main')) this.later(sessionId, 'main', work => { work.jobs.push(job); }); }));
    if (deps.coldSweep !== false) {
      const { firstMs, everyMs } = deps.coldSweep ?? { firstMs: COLD_FIRST_MS, everyMs: COLD_EVERY_MS };
      const run = () => { void this.sweepCold(); };
      const first = setTimeout(run, firstMs), every = setInterval(run, everyMs);
      first.unref(); every.unref();
      this.coldTimers.push(first, every);
    }
  }

  // ---- reads -------------------------------------------------------------------------------

  /** Resolves once the lane's rows hold everything its log, runs and jobs say now. */
  ready(sessionId: string, lane: SyncLane): Promise<TimelineHead> {
    return new Promise(resolve => {
      const work = this.workOf(sessionId, lane);
      work.journal = true;
      work.waiters.push(() => resolve(this.head(sessionId, lane) ?? { generation: generationOf(undefined), headSeq: 0 }));
      this.schedule();
    });
  }

  /** The lane's generation and head seq as last folded; undefined for a lane never folded. */
  head(sessionId: string, lane: SyncLane): TimelineHead | undefined {
    const head = this.tables.head(sessionId, lane);
    return head ? { generation: head.generation, headSeq: head.headSeq } : undefined;
  }

  /**
   * What a client holding the lane at `after` under `generation` needs: the rows changed since, when it
   * holds the current generation and they are at most twice its budget; else the newest rows (`snapshot`).
   */
  changes(sessionId: string, lane: SyncLane, request: { generation?: string; after: number } & Budget): TimelineChanges {
    const head = this.head(sessionId, lane) ?? { generation: generationOf(undefined), headSeq: 0 };
    const budget = this.snapshotBudget(request);
    if (this.deltaFits(sessionId, lane, head, request, budget)) {
      const rows: TimelineRow[] = [];
      const deletes: string[] = [];
      for (const change of this.tables.changesSince(sessionId, lane, request.after)) {
        if (change.deleted) deletes.push(change.key); else rows.push(rowOf(change.payload, change.seq, change.rev));
      }
      return { generation: head.generation, headSeq: head.headSeq, mode: 'delta', from: request.after + 1, to: head.headSeq, rows, ...(deletes.length ? { deletes } : {}) };
    }
    const window = this.tail(sessionId, lane, budget);
    return { generation: head.generation, headSeq: head.headSeq, mode: 'snapshot', rows: window.rows, hasBefore: window.hasBefore };
  }

  /**
   * What a stream resuming the lane at `after` under `generation` is sent, by the rule of `changes`:
   * the rows changed since as frames contiguous in seq up to `headSeq` (none when it is current), or
   * undefined when it is to be sent a snapshot instead.
   */
  resume(sessionId: string, lane: SyncLane, request: { generation?: string; after: number } & Budget): { head: TimelineHead; frames: Array<Extract<TimelineChange, { type: 'rows' }>> } | undefined {
    const head = this.head(sessionId, lane) ?? { generation: generationOf(undefined), headSeq: 0 };
    if (!this.deltaFits(sessionId, lane, head, request, this.snapshotBudget(request))) return undefined;
    const entries: RowEntry[] = this.tables.changesSince(sessionId, lane, request.after)
      .map(change => change.deleted ? { seq: change.seq, key: change.key } : { seq: change.seq, row: rowOf(change.payload, change.seq, change.rev) });
    return { head, frames: rowFrames(head.generation, request.after + 1, head.headSeq, entries) };
  }

  /** The lane's activities still running, newest `limit` of them, in order. */
  liveActivities(sessionId: string, lane: SyncLane, limit: number = SYNC_BUDGET.liveActivities): NativeActivity[] {
    return this.tables.activityRows(sessionId, lane).flatMap(row => row.kind === 'activity' && isLiveActivity(row.activity) ? [row.activity] : []).slice(-limit);
  }

  /** Rows by place: before `before`, from `from` on, or around `around`, within the page budget. */
  page(sessionId: string, lane: SyncLane, request: ({ before: number } | { from: number } | { around: number }) & Budget): TimelinePage {
    const generation = this.head(sessionId, lane)?.generation ?? generationOf(undefined);
    const budget = { bytes: clamp(request.bytes ?? SYNC_BUDGET.page.bytes, 1, SYNC_BUDGET.page.maxBytes), rows: clamp(request.rows ?? SYNC_BUDGET.page.rows, 1, SYNC_BUDGET.page.maxRows) };
    const older = (before: number, take: Budget & { bytes: number; rows: number }) => this.within(this.tables.placesBefore(sessionId, lane, before, take.rows), take.bytes);
    const newer = (from: number, take: Budget & { bytes: number; rows: number }) => this.within(this.tables.placesFrom(sessionId, lane, from, take.rows), take.bytes);
    let places: Array<{ pos: number }>;
    if ('before' in request) places = older(request.before, budget).reverse();
    else if ('from' in request) places = newer(request.from, budget);
    else {
      const half = { bytes: Math.max(1, Math.floor(budget.bytes / 2)), rows: Math.max(1, Math.floor(budget.rows / 2)) };
      places = [...older(request.around, half).reverse(), ...newer(request.around, half)];
    }
    if (!places.length) return { generation, rows: [], hasBefore: false, hasAfter: false };
    const low = places[0]!.pos, high = places.at(-1)!.pos;
    return { generation, rows: this.tables.rowsBetween(sessionId, lane, low, high), hasBefore: this.tables.hasBefore(sessionId, lane, low), hasAfter: this.tables.hasAfter(sessionId, lane, high) };
  }

  /**
   * The newest rows within the snapshot budget as of now. The window is picked here; each part is read
   * when asked for, so a writer can put other frames between parts. A row that changes meanwhile is
   * sent with its new content, and again by the rows after `asOfSeq`.
   */
  snapshot(sessionId: string, lane: SyncLane, budget: Budget = {}): TimelineSnapshot {
    const head = this.head(sessionId, lane) ?? { generation: generationOf(undefined), headSeq: 0 };
    const places = this.within(this.tables.placesBefore(sessionId, lane, MAX_POS, this.snapshotBudget(budget).rows), this.snapshotBudget(budget).bytes).reverse();
    const ranges: Array<{ from: number; to: number }> = [];
    let bytes = 0;
    for (const place of places) {
      const range = ranges.at(-1);
      if (!range || bytes + place.bytes > SYNC_BUDGET.frameBytes - 4096) { ranges.push({ from: place.pos, to: place.pos }); bytes = 0; } else range.to = place.pos;
      bytes += place.bytes;
    }
    const hasBefore = places.length ? this.tables.hasBefore(sessionId, lane, places[0]!.pos) : false;
    const tables = this.tables;
    return {
      generation: head.generation, asOfSeq: head.headSeq, hasBefore,
      *parts() {
        if (!ranges.length) { yield { part: 0, final: true, rows: [] }; return; }
        for (const [part, range] of ranges.entries()) yield { part, final: part === ranges.length - 1, rows: tables.rowsBetween(sessionId, lane, range.from, range.to) };
      },
    };
  }

  /** The lane's rows holding [query] as last folded (`ready` first), each counted by what it shows folded; see `LaneFinder`. */
  find(sessionId: string, lane: SyncLane, query: string, root?: string): Promise<LaneFind> {
    return this.finder.find(sessionId, lane, this.head(sessionId, lane) ?? { generation: generationOf(undefined), headSeq: 0 }, query, root);
  }

  /** The lane's outline: its newest `limit` turns (all without one), oldest first. */
  outline(sessionId: string, lane: SyncLane, limit?: number): { generation: string; turnCount: number; turns: TurnOutlineV3[] } {
    return { generation: this.head(sessionId, lane)?.generation ?? generationOf(undefined), ...this.tables.outline(sessionId, lane, limit) };
  }

  /**
   * What a finished turn of the main lane came to: the question and the answer, which is the last
   * `final_answer` row, else the last assistant row that is not marked commentary. Undefined for a turn
   * that has not completed, is unknown, or has no answer.
   */
  turnText(sessionId: string, turn: string): { question: string; answer: string } | undefined {
    const outline = this.tables.turn(sessionId, 'main', turn);
    if (!outline || outline.status !== 'completed') return undefined;
    const rows = this.tables.textRows(sessionId, 'main', turn, outline.startPos, outline.endPos ?? MAX_POS);
    const answers = rows.flatMap(row => row.kind === 'assistant' && row.text.trim() ? [row] : []);
    const answer = answers.findLast(row => row.phase === 'final_answer') ?? answers.findLast(row => row.phase === undefined);
    if (!answer) return undefined;
    const question = rows.find(row => row.kind === 'user' && !row.pending);
    return { question: question?.kind === 'user' ? question.text : '', answer: answer.text };
  }

  /** Differs after any lane of the session folds a change; a cheap check that a set derived from its rows is still current. */
  revision(sessionId: string): string {
    return this.tables.revision(sessionId);
  }

  /**
   * The absolute paths the session's tool rows name, as a location or as image content, in every lane
   * (subagents included). A path named here is only a candidate: whoever serves it still checks the file.
   */
  namedPaths(sessionId: string): Set<string> {
    const paths = new Set<string>();
    const add = (value: unknown) => { if (typeof value === 'string' && value.startsWith('/')) paths.add(value); };
    for (const payload of this.tables.toolPayloadsNaming(sessionId)) {
      let data: Record<string, unknown> | undefined;
      try { data = (JSON.parse(payload) as { event?: { data?: Record<string, unknown> } }).event?.data; } catch { continue; }
      if (!data) continue;
      if (Array.isArray(data.locations)) for (const location of data.locations) add((location as { path?: unknown } | null)?.path);
      if (Array.isArray(data.content)) {
        for (const item of data.content) {
          const inner = (item as { content?: unknown } | null)?.content;
          for (const candidate of [item, inner] as Array<{ type?: unknown; path?: unknown } | null | undefined>) if (candidate?.type === 'image') add(candidate.path);
        }
      }
    }
    return paths;
  }

  /** Hears the lane's changes as they are committed; the lane stays folded in memory while anyone listens. */
  subscribe(sessionId: string, lane: SyncLane, listener: (change: TimelineChange) => void): () => void {
    const id = laneId(sessionId, lane);
    let group = this.listeners.get(id);
    if (!group) this.listeners.set(id, group = new Set());
    group.add(listener);
    this.workOf(sessionId, lane).journal = true;
    this.schedule();
    return () => { group!.delete(listener); if (!group!.size) this.listeners.delete(id); };
  }

  /** Runs timeline table writes atomically on `tables.db` (reusing `journal.tx` when both share one DB). */
  private tableTx<T>(fn: () => T): T {
    return this.tables.db === this.deps.journal.db ? this.deps.journal.tx(fn) : this.tables.tx(fn);
  }

  /**
   * Reconstructs the full JSON of a truncated timeline row directly from the journal on demand,
   * eliminating duplicate full-row copies in the `blobs` table. Backed by a bounded LRU cache.
   */
  expandTruncatedBlob(sessionId: string, hash: string): SessionBlobResult | undefined {
    const cacheKey = `${sessionId}\n${hash}`;
    const cached = this.expandedCache.get(cacheKey);
    if (cached) {
      this.expandedCache.delete(cacheKey);
      this.expandedCache.set(cacheKey, cached);
      return { size: cached.length, type: 'application/json', bytes: () => cached };
    }
    const stored = this.tables.truncatedRowByHash(sessionId, hash);
    if (!stored) return undefined;
    let preview: RowContent;
    try { preview = JSON.parse(stored.payload) as RowContent; } catch { return undefined; }
    const sourceIds = preview.event?.sourceIds;
    if (!Array.isArray(sourceIds) || !sourceIds.length) return undefined;
    const { key: journalKey } = servingKey(this.deps.journal, sessionId, stored.lane);
    const seen = new Set<string>();
    const events: WorkbenchEvent[] = [];
    for (const nativeId of sourceIds) {
      if (typeof nativeId !== 'string' || !nativeId || seen.has(nativeId)) continue;
      seen.add(nativeId);
      const entity = this.deps.journal.entity(journalKey, nativeId);
      // Allow live draft entities (streaming long answers) while skipping tombstones and meta markers.
      if (!entity || entity.kind === TOMBSTONE_KIND || entity.kind.startsWith(META_PREFIX)) continue;
      const payload = entity.payload as Omit<NativeWorkbenchEvent, 'sequence' | 'sessionId'> | undefined;
      if (!payload || typeof payload.type !== 'string' || !payload.data || typeof payload.data !== 'object') continue;
      events.push({ ...payload, sessionId, sequence: entity.identity } as WorkbenchEvent);
    }
    if (!events.length) return undefined;
    events.sort((a, b) => a.sequence - b.sequence);
    const runs = stored.lane === 'main' && preview.kind === 'user' ? timelineRuns(this.deps.listRuns(sessionId)) : [];
    const chatId = stored.lane === 'main' ? this.deps.nativeChatId?.(sessionId) : undefined;
    const items = buildTimeline(projectEvents(events), runs, undefined, undefined, chatId);
    const matched = items.find(item => item.key === stored.key) ?? (items.length === 1 && items[0]!.kind === preview.kind ? items[0] : undefined);
    if (!matched) return undefined;
    const rebuilt = { ...rowContent(matched, { pos: stored.pos, turn: stored.turn }), key: stored.key } as RowContent;
    if (rebuilt.kind === 'tool' && preview.kind === 'tool') {
      if (preview.subagent) rebuilt.subagent = preview.subagent;
      if (preview.activity) rebuilt.activity = preview.activity;
    }
    const materialized = materializeRowImages(rebuilt, sessionId, (_sid, bytes) => blobSha256(bytes));
    const buf = Buffer.from(JSON.stringify(materialized));
    this.cacheExpanded(cacheKey, buf);
    return { size: buf.length, type: 'application/json', bytes: () => buf };
  }

  private cacheExpanded(cacheKey: string, bytes: Buffer): void {
    const existing = this.expandedCache.get(cacheKey);
    if (existing) {
      this.expandedCacheBytes -= existing.length;
      this.expandedCache.delete(cacheKey);
    }
    if (bytes.length > STORAGE_BUDGET.expandedRowCacheBytes) return;
    this.expandedCache.set(cacheKey, bytes);
    this.expandedCacheBytes += bytes.length;
    while (this.expandedCache.size > STORAGE_BUDGET.expandedRowCacheEntries || this.expandedCacheBytes > STORAGE_BUDGET.expandedRowCacheBytes) {
      const oldest = this.expandedCache.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.expandedCache.get(oldest)!;
      this.expandedCache.delete(oldest);
      this.expandedCacheBytes -= evicted.length;
    }
  }

  private clearExpandedFor(sessionId?: string): void {
    if (!sessionId) {
      this.expandedCache.clear();
      this.expandedCacheBytes = 0;
      return;
    }
    const prefix = `${sessionId}\n`;
    for (const [key, bytes] of [...this.expandedCache]) {
      if (!key.startsWith(prefix)) continue;
      this.expandedCache.delete(key);
      this.expandedCacheBytes -= bytes.length;
    }
  }

  /** Forgets a session's rows (a deleted conversation), and the blobs they held. */
  drop(sessionId: string): void {
    this.forget(sessionId);
    this.clearExpandedFor(sessionId);
    const cut = this.tableTx(() => {
      const refs = this.tables.truncatedBlobs(sessionId);
      this.tables.dropSession(sessionId);
      return refs;
    });
    if (cut.length) this.context.release(sessionId, cut);
  }

  /**
   * Drops the rows of sessions idle longer than `SERVER_BUDGET.coldTimelineDays` that nobody holds open
   * (docs/guide/performance.md §3.7). Both main and subagent lanes are dropped: each subagent lane's
   * summary (`rows`, `changes`) is persisted onto its `timeline_heads.summary` before its rows go, so
   * refolding the main lane later still decorates every parent tool row accurately without refolding children.
   * Each dropped lane keeps its head under a new epoch, and releases any legacy persisted truncated blobs.
   *
   * Limitation: a background job (`NativeJob`) is held in memory only and decorates stored tool rows, so a
   * session whose rows carry one is not dropped; a refold could not bring it back.
   */
  sweepCold(now = Date.now()): Promise<number> {
    if (this.sweeping) return this.sweeping;
    const sweep = (async () => {
      await Promise.resolve();
      let dropped = 0, after = '';
      try {
        while (!this.closed) {
          const [sessionId] = this.tables.foldedSessions(after, 1);
          if (!sessionId) break;
          after = sessionId;
          while (!this.closed && (this.deps.busy ?? eventLoopBusy)()) await this.pause(COLD_RETRY_MS);
          if (this.closed) break;
          if (await this.dropIfCold(sessionId, now)) dropped++;
          await new Promise<void>(resolve => setImmediate(resolve));
        }
        if (dropped > 0 && !this.closed) reclaimFreePages(this.deps.db, { busy: this.deps.busy });
      } catch (error) {
        console.error('[timeline] cold sweep failed:', error);
      }
      return dropped;
    })();
    this.sweeping = sweep;
    void sweep.finally(() => { if (this.sweeping === sweep) this.sweeping = undefined; });
    return sweep;
  }

  private pause(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.coldWaits.delete(timer); resolve(); }, ms);
      timer.unref();
      this.coldWaits.set(timer, resolve);
    });
  }

  private held(sessionId: string): boolean {
    const prefix = `${sessionId}\n`;
    for (const map of [this.hot, this.listeners, this.work, this.timers]) for (const id of map.keys()) if (id.startsWith(prefix)) return true;
    return false;
  }

  private async dropIfCold(sessionId: string, now: number): Promise<boolean> {
    if (this.held(sessionId) || this.deps.deleted?.(sessionId)) return false;
    const heads = this.tables.lanesOf(sessionId);
    if (!heads.length) return false;
    // A lane still being imported is served from its scratch window; leave the session alone.
    if (heads.some(head => head.scratch)) return false;
    const activeHeads = heads.filter(head => head.headSeq > 0 || head.foldedThrough > 0 || (head.epoch > 0 && this.tables.hasRows(sessionId, head.lane)));
    if (!activeHeads.length) return false;
    const resumeOnly = activeHeads.every(head => head.headSeq === 0 && head.journalSeq === 0 && head.epoch > 0);
    if (!resumeOnly) {
      const activity = (this.deps.activity ?? ((id: string) => this.storedActivity(id)))(sessionId);
      if (!activity || activity.running) return false;
      // The newest sign of use: the session's activity, its log, and any lane's last fold.
      const at = Math.max(
        Date.parse(activity.at ?? '') || 0,
        Date.parse(this.deps.journal.peek(sessionId)?.updatedAt ?? '') || 0,
        ...heads.map(head => Date.parse(head.updatedAt ?? '') || 0),
      );
      if (!at || now - at < SERVER_BUDGET.coldTimelineDays * 86_400_000) return false;
      if (this.deps.listRuns(sessionId).some(run => !TERMINAL_RUNS.has(run.state))) return false;
      if (await this.hasJob(sessionId)) return false;
      if (this.closed || this.held(sessionId)) return false;
    }
    this.clearExpandedFor(sessionId);
    // Drop subagent lanes first (caching their summaries onto `timeline_heads.summary`), then the main lane.
    const ordered = [...activeHeads.filter(h => h.lane !== 'main'), ...activeHeads.filter(h => h.lane === 'main')];
    for (const head of ordered) {
      if (this.closed || this.held(sessionId)) break;
      const id = laneId(sessionId, head.lane);
      this.dropping.add(id);
      const resume = head.headSeq === 0 && head.journalSeq === 0 && head.epoch > 0 && this.tables.hasRows(sessionId, head.lane);
      // Snapshot subagent summary before removing its rows so parent tool cards refold identically later.
      let summary = head.summary;
      if (head.lane !== 'main' && !resume && this.tables.hasRows(sessionId, head.lane)) {
        summary = { rows: this.tables.countLive(sessionId, head.lane), changes: this.subagentFileChanges(sessionId, head.lane) };
      }
      const released = this.tables.truncatedBlobs(sessionId, head.lane);
      let left = true;
      this.tableTx(() => {
        this.tables.clearTurns(sessionId, head.lane);
        if (!resume) {
          const epoch = head.epoch + 1;
          this.tables.putHead({
            ...head, epoch, generation: generationOf(head.journalGeneration ?? undefined, epoch),
            headSeq: 0, foldedThrough: 0, journalSeq: 0, ...(summary ? { summary } : {}),
          });
        }
        left = this.deleteChunk(sessionId, head.lane);
      });
      if (released.length) this.context.release(sessionId, released);
      this.forget(sessionId, false);
      while (left) {
        await new Promise<void>(resolve => setImmediate(resolve));
        if (this.closed || !this.dropping.has(id)) break;
        this.tableTx(() => { left = this.deleteChunk(sessionId, head.lane); });
      }
      this.dropping.delete(id);
    }
    return true;
  }

  /** Whether a tool row of the main lane carries a background job, read a bounded step at a time. */
  private async hasJob(sessionId: string): Promise<boolean> {
    let after = 'tool:';
    for (;;) {
      const step = this.tables.jobRowsAfter(sessionId, after, COLD_SCAN_ROWS);
      if (step.found) return true;
      if (step.last === undefined || this.closed) return false;
      after = step.last;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }

  /** Deletes a chunk of a lane's rows; whether rows may be left. */
  private deleteChunk(sessionId: string, lane: SyncLane): boolean {
    return this.tables.deleteRowsChunk(sessionId, lane, COLD_CHUNK_ROWS) === COLD_CHUNK_ROWS;
  }

  /** The default `activity`: the store's session record, which shares this database. */
  private storedActivity(sessionId: string): { at?: string; running: boolean } | undefined {
    try {
      const row = this.deps.db.prepare("SELECT json_extract(json,'$.lastActivityAt') AS last, json_extract(json,'$.updatedAt') AS updated, json_extract(json,'$.state') AS state FROM sessions WHERE id=?").get(sessionId) as { last: string | null; updated: string | null; state: string | null } | undefined;
      if (!row) return undefined;
      const times = [row.last, row.updated].filter((value): value is string => typeof value === 'string').sort();
      return { ...(times.length ? { at: times.at(-1)! } : {}), running: row.state !== null && RUNNING_STATES.has(row.state) };
    } catch { return undefined; }
  }

  /** Lets go of everything held in memory for the session; `queued` also drops pending work. */
  private forget(sessionId: string, queued = true): void {
    const owned = (id: string) => id.startsWith(`${sessionId}\n`);
    for (const id of [...this.hot.keys()]) if (owned(id)) this.hot.delete(id);
    if (queued) {
      for (const [id, timer] of [...this.timers]) if (owned(id)) { clearTimeout(timer); this.timers.delete(id); }
      for (const [id, work] of [...this.work]) if (owned(id)) { this.work.delete(id); for (const waiter of work.waiters) waiter(); }
      for (const id of [...this.listeners.keys()]) if (owned(id)) this.listeners.delete(id);
    }
    for (const id of [...this.summaries.keys()]) if (id.startsWith(`${sessionId}\n`)) { this.summaries.delete(id); this.staleSummaries.delete(id); }
    for (const id of [...this.laneFileChanges.keys()]) if (owned(id)) this.laneFileChanges.delete(id);
    if (queued) for (const id of [...this.dropping]) if (owned(id)) this.dropping.delete(id);
  }

  close(): void {
    this.closed = true;
    this.deps.journal.setFallbackBlobResolver(undefined);
    this.clearExpandedFor();
    for (const timer of this.coldTimers.splice(0)) { clearTimeout(timer); clearInterval(timer); }
    for (const [timer, resolve] of [...this.coldWaits]) { clearTimeout(timer); resolve(); }
    this.coldWaits.clear();
    for (const off of this.offs.splice(0)) off();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    if (this.immediate) clearImmediate(this.immediate);
    for (const work of this.work.values()) for (const waiter of work.waiters) waiter();
    this.work.clear();
    this.hot.clear();
    this.listeners.clear();
  }

  // ---- scheduling --------------------------------------------------------------------------

  private noteAppend(change: JournalAppend): void {
    if (change.lane !== 'main' && this.summaries.has(laneId(change.sessionId, change.lane))) this.staleSummaries.add(laneId(change.sessionId, change.lane));
    if (!this.wanted(change.sessionId, change.lane)) return;
    this.workOf(change.sessionId, change.lane).journal = true;
    this.schedule();
  }

  /**
   * Whether a lane is folded as its log grows: one held in memory or listened to, and the subagent lanes of
   * such a main lane (their summaries are on its tool rows). Any other lane — a conversation read into the
   * journal on someone else's behalf — is folded when it is next read (`ready`, `subscribe`), so a long log
   * nobody looks at is never folded whole on the event loop just because it was written.
   */
  private wanted(sessionId: string, lane: SyncLane): boolean {
    const id = laneId(sessionId, lane), main = laneId(sessionId, 'main');
    return this.hot.has(id) || this.listeners.has(id) || this.work.has(id) || (lane !== 'main' && (this.hot.has(main) || this.listeners.has(main)));
  }

  private workOf(sessionId: string, lane: SyncLane): Work {
    const id = laneId(sessionId, lane);
    let work = this.work.get(id);
    if (!work) this.work.set(id, work = { journal: false, runs: false, jobs: [], subagents: new Set(), waiters: [] });
    return work;
  }

  /** Records a change that waits out the debounce before it is folded. */
  private later(sessionId: string, lane: SyncLane, note: (work: Work) => void): void {
    if (this.closed) return;
    note(this.workOf(sessionId, lane));
    const id = laneId(sessionId, lane);
    if (this.timers.has(id)) return;
    this.timers.set(id, setTimeout(() => { this.timers.delete(id); this.schedule(); }, this.deps.debounceMs ?? 50));
  }

  private schedule(): void {
    if (this.immediate || this.closed) return;
    this.immediate = setImmediate(() => { this.immediate = undefined; this.run(); });
  }

  private run(): void {
    for (const [id, work] of [...this.work]) {
      // Debounced work waits for its timer unless something else is due for the lane now.
      if (this.timers.has(id) && !work.journal && !work.waiters.length) continue;
      this.work.delete(id);
      const at = id.indexOf('\n');
      const sessionId = id.slice(0, at), lane = id.slice(at + 1) as SyncLane;
      if (this.deps.deleted?.(sessionId)) { this.hot.delete(id); for (const waiter of work.waiters) waiter(); continue; }
      let caughtUp = true;
      try { caughtUp = this.flushLane(sessionId, lane, work); }
      catch (error) {
        this.hot.delete(id);
        (this.deps.onError ?? ((failure, session, failed) => console.error(`[timeline] fold of ${session} ${failed} failed:`, failure)))(error, sessionId, lane);
      }
      if (caughtUp) { for (const waiter of work.waiters) waiter(); continue; }
      // The rest of the log is folded a turn of the event loop later; whoever waits for the lane waits for all of it.
      const next = this.workOf(sessionId, lane);
      next.journal = true;
      next.waiters.push(...work.waiters);
      this.schedule();
    }
  }

  private inputs(sessionId: string, lane: SyncLane): FoldInputs {
    // A subagent's lane is folded as the web folded it: without runs, jobs or chat (`SubagentSession`).
    if (lane !== 'main') return { runs: [], jobs: [], chatId: undefined };
    return { runs: this.deps.listRuns(sessionId), jobs: this.deps.listJobs?.(sessionId) ?? [], chatId: this.deps.nativeChatId?.(sessionId) };
  }

  /** Folds a step of what the lane's log gained; false when more is left for the next. */
  private flushLane(sessionId: string, lane: SyncLane, work: Work): boolean {
    const id = laneId(sessionId, lane);
    // A fold of the lane ends what is left of a cold drop of it: `LaneFold.attach` clears the leftover rows.
    this.dropping.delete(id);
    let hot = this.hot.get(id);
    let reset: TimelineChange | undefined;
    let caughtUp: boolean;
    const step = this.deps.stepRows ?? STEP_ROWS;
    if (!hot || !hot.fold.current()) {
      const opened = LaneFold.open(this.context, sessionId, lane, this.inputs(sessionId, lane), step);
      // A lane that started over is read whole again by its clients: they hear `reset`, not its rows.
      if (opened.reset) reset = { type: 'reset', generation: opened.fold.generation, reason: opened.reset };
      hot = { fold: opened.fold };
      caughtUp = opened.caughtUp;
    } else {
      if (work.runs) hot.fold.setInputs(this.inputs(sessionId, lane));
      for (const job of work.jobs) hot.fold.setJob(job);
      if (lane === 'main') hot.fold.setChat(this.deps.nativeChatId?.(sessionId));
      for (const toolCallId of work.subagents) hot.fold.decorationChanged(toolCallId);
      caughtUp = hot.fold.sync(step);
      hot.fold.flush();
    }
    this.hot.delete(id);
    this.hot.set(id, hot);
    this.evict();
    const changes = hot.fold.take();
    if (reset || changes.length) this.clearExpandedFor(sessionId);
    const listeners = this.listeners.get(id);
    if (reset) for (const listener of listeners ?? []) listener(reset);
    else for (const change of changes) for (const listener of listeners ?? []) listener(change);
    if (lane !== 'main') this.subagentLaneChanged(sessionId, lane, hot.fold);
    return caughtUp;
  }

  /** A subagent lane's summary moved: the tool rows that show it are redone, after the debounce. */
  private subagentLaneChanged(sessionId: string, lane: SyncLane, fold: LaneFold): void {
    const toolCallId = lane.slice('sub:'.length);
    const next = this.readSubagentProgress(sessionId, lane, fold.liveRows);
    const persisted: StoredSubagentSummary = { rows: next.rows, changes: next.changes ?? [] };
    this.tables.putSummary(sessionId, lane, persisted);
    const previous = this.summaries.get(laneId(sessionId, lane));
    this.summaries.set(laneId(sessionId, lane), next);
    this.staleSummaries.delete(laneId(sessionId, lane));
    if (previous && JSON.stringify(previous) === JSON.stringify(next)) return;
    for (const [id, hot] of this.hot) {
      if (!id.startsWith(`${sessionId}\n`) || hot.fold === fold || ![...hot.fold.subagentIds].includes(toolCallId)) continue;
      this.later(sessionId, hot.fold.lane, work => { work.subagents.add(toolCallId); });
    }
  }

  /** A subagent lane's row count and whether it runs, from what is stored when it is not folded here. */
  private summary(sessionId: string, toolCallId: string): SubagentProgress {
    const lane: SyncLane = `sub:${toolCallId}`;
    const id = laneId(sessionId, lane);
    const known = this.summaries.get(id);
    if (known && !this.staleSummaries.has(id)) return known;
    const summary = this.readSubagentProgress(sessionId, lane, this.tables.countLive(sessionId, lane));
    this.summaries.set(id, summary);
    this.staleSummaries.delete(id);
    return summary;
  }

  /** The child's newest execution, rather than a terminal notification from an earlier round. */
  private readSubagentProgress(sessionId: string, lane: SyncLane, rows: number): SubagentProgress {
    const { journal } = this.deps;
    const key = journal.peek(laneKey(sessionId, lane)) ? servingKey(journal, sessionId, lane).key : undefined;
    const turnId = key ? journal.lastStartedTurn(key) : undefined;
    const closed = key && turnId ? hasTurnEnded(journal, key, turnId) : false;
    const start = key && turnId ? journal.entity(key, turnMetaId(turnId, 'started')) : undefined;
    const end = closed && key && turnId ? journal.entity(key, turnMetaId(turnId, 'ended')) : undefined;
    const ended = (end?.payload as { status?: unknown } | undefined)?.status;
    const status: SubagentProgress['status'] = ended === 'failed' ? 'failed' : ended === 'cancelled' || ended === 'interrupted' ? 'cancelled' : end ? 'completed' : start ? 'running' : undefined;
    let liveRows = rows;
    let changes: FileChange[];
    if (liveRows === 0) {
      const head = this.tables.head(sessionId, lane);
      if (head && head.headSeq === 0 && head.epoch > 0 && head.summary) {
        liveRows = head.summary.rows;
        changes = head.summary.changes;
      } else {
        changes = [];
      }
    } else {
      changes = this.subagentFileChanges(sessionId, lane);
    }
    return { rows: liveRows, running: status === 'running', ...(turnId ? { turnId } : {}), ...(status ? { status } : {}), ...(start ? { startedAt: start.at } : {}), ...(end ? { endedAt: end.at } : {}), ...(changes.length ? { changes } : {}) };
  }

  /**
   * The files a subagent changed, carried by the parent's tool row: the conversation's outputs list only reads
   * the lane it shows, and a subagent's lane is loaded when it is opened. Read from the lane's folded tool rows,
   * so it holds for any backend and for a subagent still running; a path last touched later moves to the end.
   */
  private subagentFileChanges(sessionId: string, lane: SyncLane): FileChange[] {
    const id = laneId(sessionId, lane);
    const known = this.laneFileChanges.get(id);
    const read = new Map<string, { digest: string; changes: FileChange[] }>();
    const byPath = new Map<string, FileChange>();
    for (const { key, digest } of this.tables.toolDigests(sessionId, lane)) {
      let entry = known?.get(key);
      if (entry?.digest !== digest) {
        const stored = this.tables.row(sessionId, lane, key);
        const row = stored && rowOf(stored.payload, stored.seq, stored.rev);
        entry = { digest, changes: row?.kind === 'tool' ? toolFileChanges(row.event.data) : [] };
      }
      read.set(key, entry);
      for (const change of entry.changes) {
        const current = byPath.get(change.path);
        byPath.delete(change.path);
        byPath.set(change.path, current ? { ...current, added: current.added + change.added, removed: current.removed + change.removed } : change);
      }
    }
    this.laneFileChanges.set(id, read);
    return [...byPath.values()].slice(-MAX_SUBAGENT_CHANGES);
  }

  private evict(): void {
    const limit = this.deps.hotLanes ?? 32;
    for (const id of this.hot.keys()) {
      if (this.hot.size <= limit) return;
      if (this.listeners.has(id) || this.work.has(id)) continue;
      this.hot.delete(id);
    }
  }

  // ---- budgets -----------------------------------------------------------------------------

  /** A client holding the current generation at `after` gets the rows since, when they are at most twice its budget. */
  private deltaFits(sessionId: string, lane: SyncLane, head: TimelineHead, request: { generation?: string; after: number }, budget: { bytes: number; rows: number }): boolean {
    if (request.generation !== head.generation || !(request.after >= 0 && request.after <= head.headSeq)) return false;
    const size = this.tables.changedSince(sessionId, lane, request.after);
    return size.rows <= 2 * budget.rows && size.bytes <= 2 * budget.bytes;
  }

  private snapshotBudget(budget: Budget): { bytes: number; rows: number } {
    const limits = SYNC_BUDGET.snapshot;
    return { bytes: clamp(budget.bytes ?? limits.bytes, limits.minBytes, limits.maxBytes), rows: clamp(budget.rows ?? limits.rows, limits.minRows, limits.maxRows) };
  }

  /** The leading places whose rows fit in `bytes`; always at least one. */
  private within<T extends { bytes: number }>(places: T[], bytes: number): T[] {
    let total = 0;
    const kept: T[] = [];
    for (const place of places) {
      if (kept.length && total + place.bytes > bytes) break;
      total += place.bytes;
      kept.push(place);
    }
    return kept;
  }

  private tail(sessionId: string, lane: SyncLane, budget: { bytes: number; rows: number }): { rows: TimelineRow[]; hasBefore: boolean } {
    const places = this.within(this.tables.placesBefore(sessionId, lane, MAX_POS, budget.rows), budget.bytes);
    if (!places.length) return { rows: [], hasBefore: false };
    const low = places.at(-1)!.pos;
    return { rows: this.tables.rowsBetween(sessionId, lane, low, MAX_POS), hasBefore: this.tables.hasBefore(sessionId, lane, low) };
  }
}
