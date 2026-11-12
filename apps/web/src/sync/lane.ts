import type { LaneFind, SyncFrame, SyncLane, TimelinePage, TimelineRow, TurnOutlineV3 } from '@contracts';
import { reconnectDelay } from '@/lib/utils';
import { blobPath, findUrl, outlineUrl, parseFrame, routeMissing, SYNC_PROTOCOL, syncUrl, timelineUrl, type Place, type SyncTransport } from './protocol';
import { isRow, LaneWindow, type PageMode, type WindowLimit } from './window';

type Frame<T extends SyncFrame['type']> = Extract<SyncFrame, { type: T }>;
/** What a lane hands on as it is: the session's state, not the transcript's. */
export type ControlFrame = Exclude<SyncFrame, { type: 'snapshot' | 'rows' | 'reset' | 'error' | 'caughtUp' }>;
export type LaneConnection = 'connecting' | 'open' | 'retrying' | 'suspended' | 'outdated' | 'failed' | 'closed';
/** How one page request ended; the same vocabulary as `useEarlierHistory`'s `EarlierLoad`. */
export type PageResult = 'progress' | 'none' | 'failed';
export interface LaneOutline { turnCount: number; turns: TurnOutlineV3[] }

/** A lane's window as it was saved: where its stream resumes and what it showed. */
export interface LaneHeld { generation: string; seq: number; rows: readonly TimelineRow[]; hasBefore: boolean }

export interface LaneEvents {
  /** The rows changed. `replaced`: the window was replaced whole (a snapshot, a jump), so a reading position in it is gone. */
  rows?(replaced: boolean): void;
  /** Accepted live upserts, including rows outside the reader's window, before the window takes them. */
  upserts?(rows: readonly TimelineRow[]): void;
  control?(frame: ControlFrame): void;
  /** Connection, loading or error changed. */
  state?(): void;
  /** The server replaced the lane's generation: nothing kept of the old one may be resumed from. */
  reset?(): void;
}

export interface LaneOptions {
  sessionId: string;
  lane: SyncLane;
  transport: SyncTransport;
  events: LaneEvents;
  limit?: WindowLimit;
  /** Asked when the stream gave up: whether the server is too old to speak v3. */
  probe?: () => Promise<boolean>;
}

/** The server pings every 15s; this much silence on a stream means it is dead. */
export const SILENT_MS = 40_000;
const WATCHDOG_MS = 10_000;
/** A repeated gap within this long backs off instead of redialing at once. */
const GAP_WINDOW_MS = 60_000;
/** docs/SYNC-V3.md 预算, 客户端缓存: the newest rows a saved copy keeps, about two snapshots' worth. */
const CACHED_TAIL: WindowLimit = { rows: 500, bytes: 1024 * 1024 };

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * One lane of one conversation, kept current (docs/SYNC-V3.md, 续传与缺口): the SSE stream, the window
 * it fills, and the pages around it.
 *
 * - A redial resumes with the generation and lane seq the window holds (`after`); the browser's own
 *   redial sends `Last-Event-ID`, which the server takes over the query.
 * - `rows.from` must be `held + 1`: a frame wholly at or below `held` is a repeat and is dropped, any
 *   other gap redials with `after = held`. Nothing is ever fetched to fill a gap from here.
 * - `reset` voids the generation: the window stays on screen, unresumable, until the snapshot that
 *   follows replaces it.
 * - Snapshot parts are staged and replace the window together, so the screen never shows half of one.
 */
export class LaneSync {
  readonly window: LaneWindow;
  connection: LaneConnection = 'connecting';
  generation: string | undefined;
  /** The lane seq the window is current through; only good to resume from while `resumable`. */
  held = 0;
  resumable = false;
  /** The server has confirmed the window: a delta hello, or a whole snapshot. */
  synced = false;
  /**
   * The window holds what the transcript said when this stream opened, the read the server started
   * then included. Until then rows arriving are history the reader missed, not live.
   */
  current = false;
  error: { code: string; message: string } | undefined;
  outline: LaneOutline = { turnCount: 0, turns: [] };

  private retryableError = false;
  /** The backend's last reported history state; only a change to `ready` says a read succeeded. */
  private historyState: string | undefined;
  private token: object | undefined;
  private source: { close(): void } | undefined;
  private staging: { asOfSeq: number; next: number; rows: TimelineRow[]; hasBefore: boolean } | undefined;
  private awaitingSnapshot = false;
  /** The lane seq that makes the window `current`, once the server has named it. */
  private currentAt: number | undefined;
  private retries = 0;
  private gaps = 0;
  private lastGapAt = Number.NEGATIVE_INFINITY;
  private lastFrameAt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private requests = new Set<AbortController>();
  /** The page request on its way at each end; one at a time per end. */
  private paging: { before?: AbortController; after?: AbortController } = {};
  /** Bumped whenever answers already on their way stop being wanted: a reset, a jump, closing. */
  private epoch = 0;
  private disposed = false;

  constructor(private readonly options: LaneOptions) {
    this.window = new LaneWindow(options.limit);
  }

  get lane(): SyncLane { return this.options.lane; }
  get loadingBefore(): boolean { return Boolean(this.paging.before); }
  get loadingAfter(): boolean { return Boolean(this.paging.after); }

  /** Paints a saved window before the stream answers; the first connection resumes from it. */
  restore(held: LaneHeld): void {
    if (this.synced || this.disposed) return;
    this.window.replace(held.rows, { hasBefore: held.hasBefore, hasAfter: false });
    this.generation = held.generation;
    this.held = held.seq;
    this.resumable = true;
    this.options.events.rows?.(true);
  }

  /**
   * What may be saved for the next visit: only a window the server confirmed that ends at the lane's
   * end, and only its newest rows. The copy paints the first screen; a whole window restored at its
   * budget would leave no room for the first page of older rows without giving up the end.
   */
  saved(): LaneHeld | undefined {
    if (!this.synced || !this.resumable || !this.generation || this.window.hasAfter) return undefined;
    const { rows, hasBefore } = this.window.tail(CACHED_TAIL);
    return { generation: this.generation, seq: this.held, rows, hasBefore };
  }

  /** Which end of the window the reader is nearer to: the end a full window keeps. */
  readerAtEnd(atEnd: boolean): void {
    this.window.readerAtEnd = atEnd;
    if (!atEnd) this.window.olderFull = false;
  }

  connect(): void {
    if (this.connection !== 'outdated') this.dial();
  }

  private dial(): void {
    if (this.disposed) return;
    this.dropSource();
    this.staging = undefined;
    this.current = false;
    this.currentAt = undefined;
    this.setConnection('connecting');
    const resume = this.resumable && this.generation !== undefined ? { generation: this.generation, after: this.held } : undefined;
    const token = {};
    this.token = token;
    this.lastFrameAt = Date.now();
    const source = this.options.transport.stream(syncUrl(this.options.sessionId, this.options.lane, resume), {
      open: () => {
        if (this.token !== token) return;
        this.retries = 0;
        this.lastFrameAt = Date.now();
        this.setConnection('open');
      },
      frame: (type, data) => {
        if (this.token !== token) return;
        this.lastFrameAt = Date.now();
        this.receive(type, data);
      },
      error: (closed) => {
        if (this.token === token) this.streamFailed(closed);
      },
    });
    if (this.token === token) this.source = source;
    else source.close();
    this.watchdog ??= setInterval(() => {
      if ((this.connection === 'open' || this.connection === 'connecting') && Date.now() - this.lastFrameAt > SILENT_MS) this.connect();
    }, WATCHDOG_MS);
  }

  /** Redials now, forgetting the backoff; also how an outdated or failed lane tries again. */
  retry(): void {
    if (this.disposed) return;
    this.retries = 0;
    this.gaps = 0;
    this.error = undefined;
    this.retryableError = false;
    this.dial();
  }

  /** The tab has been hidden a while: the stream goes, the window and its place in the lane stay. */
  suspend(): void {
    if (this.disposed || this.connection === 'outdated' || this.connection === 'failed' || this.connection === 'suspended') return;
    this.dropSource();
    this.stopWatchdog();
    this.setConnection('suspended');
  }

  resume(): void {
    if (this.connection === 'suspended') this.connect();
  }

  /** Back from the background: a stream that went quiet while the page was frozen is replaced at once. */
  revive(): void {
    if ((this.connection === 'open' || this.connection === 'connecting') && Date.now() - this.lastFrameAt > SILENT_MS) this.connect();
    else if (this.connection === 'retrying' && !this.source) this.connect();
  }

  close(): void {
    this.disposed = true;
    this.epoch += 1;
    this.dropSource();
    this.stopWatchdog();
    this.abortRequests();
    this.connection = 'closed';
  }

  /** The server cannot speak v3: nothing more is asked of it until `retry`. */
  markOutdated(): void {
    if (this.disposed) return;
    this.dropSource();
    this.stopWatchdog();
    this.abortRequests();
    this.setConnection('outdated');
  }

  pageUp(): Promise<PageResult> {
    const first = this.window.first;
    if (this.window.olderFull && this.window.readerAtEnd) return Promise.resolve('none');
    return this.window.hasBefore && first ? this.page({ before: first.pos }, 'before', first.pos) : Promise.resolve('none');
  }

  pageDown(): Promise<PageResult> {
    const last = this.window.last;
    return this.window.hasAfter && last ? this.page({ from: last.pos }, 'from', last.pos) : Promise.resolve('none');
  }

  /** Replaces the window with the rows around [pos], as for a turn picked in the outline. */
  jump(pos: number, signal?: AbortSignal): Promise<PageResult> {
    if (signal?.aborted) return Promise.resolve('none');
    this.abortRequests();
    return this.page({ around: pos }, 'around', undefined, signal);
  }

  /** Back to the lane's end after paging or jumping away from it. */
  latest(signal?: AbortSignal): Promise<PageResult> {
    if (signal?.aborted || !this.window.hasAfter) return Promise.resolve('none');
    this.abortRequests();
    return this.page({ before: Number.MAX_SAFE_INTEGER }, 'latest', undefined, signal);
  }

  /** The whole outline, beyond the newest turns the hello carried. */
  async loadOutline(): Promise<LaneOutline | undefined> {
    const epoch = this.epoch;
    try {
      const outline = await this.options.transport.get<LaneOutline & { generation?: string }>(outlineUrl(this.options.sessionId, this.options.lane, this.generation));
      if (epoch !== this.epoch || !outline || !Array.isArray(outline.turns) || (outline.generation && outline.generation !== this.generation)) return undefined;
      this.outline = { turnCount: outline.turnCount, turns: outline.turns };
      this.emitState();
      return this.outline;
    } catch (error) {
      if (routeMissing(error)) this.markOutdated();
      return undefined;
    }
  }

  /**
   * The rows of the whole lane holding [query] (会话内查找), loaded or not. Undefined when the server
   * cannot answer it (an older one, a failed request) or the lane started over meanwhile: the caller
   * counts the rows it holds instead.
   */
  async find(query: string, signal?: AbortSignal): Promise<LaneFind | undefined> {
    const epoch = this.epoch, generation = this.generation;
    try {
      const found = await this.options.transport.get<LaneFind>(findUrl(this.options.sessionId, this.options.lane, query, generation), signal);
      if (epoch !== this.epoch || !found || !Array.isArray(found.hits) || (generation && found.generation !== generation)) return undefined;
      return found;
    } catch {
      return undefined;
    }
  }

  /** Fetches the whole of a row that was sent cut to a preview. */
  async expand(key: string): Promise<boolean> {
    const row = this.window.get(key);
    if (!row?.truncated) return false;
    const epoch = this.epoch;
    try {
      const body = await this.options.transport.get<unknown>(blobPath(this.options.sessionId, row.truncated.blobRef));
      const full = typeof body === 'string' ? JSON.parse(body) as unknown : body;
      if (epoch !== this.epoch || !isRecord(full) || full.key !== key || !this.window.expand(key, row.seq, full)) return false;
      this.options.events.rows?.(false);
      return true;
    } catch {
      return false;
    }
  }

  private async page(place: Place, mode: PageMode, anchor?: number, signal?: AbortSignal): Promise<PageResult> {
    const end = mode === 'before' ? 'before' : 'after';
    const generation = this.generation;
    if (signal?.aborted || this.disposed || !this.resumable || !generation || this.paging[end]) return 'none';
    const epoch = this.epoch;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    this.requests.add(controller);
    this.paging[end] = controller;
    this.window.begin();
    this.emitState();
    try {
      if (controller.signal.aborted) return 'none';
      const page = await this.options.transport.get<TimelinePage>(timelineUrl(this.options.sessionId, this.options.lane, generation, place), controller.signal);
      if (controller.signal.aborted || epoch !== this.epoch || page?.generation !== this.generation || !Array.isArray(page.rows)) return 'none';
      // A page asked relative to an edge that has since moved would land in the wrong place.
      if (anchor !== undefined && (mode === 'before' ? this.window.first?.pos : this.window.last?.pos) !== anchor) return 'none';
      const edges = `${this.window.hasBefore}:${this.window.hasAfter}`;
      const { added, full } = this.window.merge(page, mode);
      const replaced = mode === 'around' || mode === 'latest';
      this.options.events.rows?.(replaced);
      // No room on that side while the reader is at the other: not a failure, nothing to retry.
      if (full) return 'none';
      // A page that moved nothing would only be asked for again; a jump has landed whatever it held.
      return replaced || added > 0 || edges !== `${this.window.hasBefore}:${this.window.hasAfter}` ? 'progress' : 'failed';
    } catch (error) {
      if (controller.signal.aborted || epoch !== this.epoch) return 'none';
      if (routeMissing(error)) { this.markOutdated(); return 'none'; }
      // The lane started over; its stream brings the reset and the new generation's rows.
      if ((error as { code?: unknown } | undefined)?.code === 'SYNC_GENERATION_CHANGED') return 'none';
      return 'failed';
    } finally {
      signal?.removeEventListener('abort', abort);
      this.requests.delete(controller);
      this.window.end();
      if (this.paging[end] === controller) delete this.paging[end];
      this.emitState();
    }
  }

  private receive(type: string, data: string): void {
    const frame = parseFrame(type, data);
    if (!frame) return;
    switch (frame.type) {
      case 'hello': this.hello(frame); return;
      case 'snapshot': this.snapshot(frame); return;
      case 'rows': this.rows(frame); return;
      case 'reset': this.reset(frame); return;
      case 'error': this.failed(frame); return;
      case 'caughtUp':
        // Under a generation that has since started over, the snapshot replacing it is current.
        this.currentAt = frame.generation === this.generation ? frame.headSeq : 0;
        this.settle();
        return;
      case 'outline': this.mergeOutline(frame); break;
      case 'status': {
        const state = frame.status.history?.state;
        if (state === 'ready' && this.historyState !== 'ready') this.recoverTranscriptRead();
        this.historyState = state;
        break;
      }
    }
    this.options.events.control?.(frame);
  }

  private hello(frame: Frame<'hello'>): void {
    if (frame.protocol < SYNC_PROTOCOL) { this.markOutdated(); return; }
    // The server repeats every failure that still holds right after its hello, so any other
    // retryable one from before is cleared here rather than left until a manual retry. A transcript
    // read failure stays until the transcript is read, so it does not flicker away and back.
    this.historyState = frame.status.history?.state;
    if (this.retryableError && this.error?.code !== 'TRANSCRIPT_READ_FAILED' && this.connection !== 'failed') { this.error = undefined; this.retryableError = false; }
    this.outline = { turnCount: frame.outline?.turnCount ?? 0, turns: Array.isArray(frame.outline?.turns) ? frame.outline.turns : [] };
    // A stream the browser redialed itself opens with a hello too. An older server never catches up
    // out loud: its hello's own rows are all there is.
    this.current = false;
    this.currentAt = frame.catchingUp ? undefined : frame.headSeq;
    if (frame.mode === 'delta') {
      if (!this.resumable || frame.generation !== this.generation || frame.headSeq < this.held) {
        // The server thinks this client holds what it does not; start over from a snapshot.
        this.resumable = false;
        this.connect();
        return;
      }
      this.awaitingSnapshot = false;
      this.synced = true;
    } else {
      this.generation = frame.generation;
      this.resumable = false;
      this.awaitingSnapshot = true;
      this.staging = undefined;
    }
    this.options.events.control?.(frame);
    this.settle();
    this.emitState();
  }

  private snapshot(frame: Frame<'snapshot'>): void {
    if (!this.awaitingSnapshot || frame.generation !== this.generation) return;
    if (frame.part === 0) this.staging = { asOfSeq: frame.asOfSeq, next: 0, rows: [], hasBefore: frame.hasBefore };
    const staging = this.staging;
    if (!staging || frame.part !== staging.next || frame.asOfSeq !== staging.asOfSeq) { this.gap(); return; }
    staging.rows.push(...frame.rows);
    staging.next += 1;
    staging.hasBefore = frame.hasBefore;
    if (!frame.final) return;
    this.staging = undefined;
    this.awaitingSnapshot = false;
    this.epoch += 1;
    this.abortRequests();
    this.window.replace(staging.rows, { hasBefore: staging.hasBefore, hasAfter: false });
    this.held = staging.asOfSeq;
    this.resumable = true;
    this.synced = true;
    this.recoverTranscriptRead();
    this.settle();
    this.options.events.rows?.(true);
    this.emitState();
  }

  private rows(frame: Frame<'rows'>): void {
    // Rows for a generation this client does not hold, or before the snapshot it is waiting for.
    if (!this.resumable || frame.generation !== this.generation) return;
    if (frame.to <= this.held) return;
    if (frame.from !== this.held + 1) { this.gap(); return; }
    // A page may already hold a newer row than this live frame. Only the frame's own changes may
    // reach summary consumers; a stale row must not undo what the window already knows either.
    const upserts = frame.upserts.filter((row) => isRow(row) && row.seq >= frame.from && row.seq <= frame.to && (this.window.get(row.key)?.seq ?? 0) <= row.seq);
    this.options.events.upserts?.(upserts);
    this.window.apply(upserts, Array.isArray(frame.deletes) ? frame.deletes : [], frame.to);
    this.held = frame.to;
    this.recoverTranscriptRead();
    this.settle();
    this.options.events.rows?.(false);
  }

  private reset(frame: Frame<'reset'>): void {
    this.epoch += 1;
    this.abortRequests();
    this.generation = frame.generation;
    this.held = 0;
    this.resumable = false;
    this.awaitingSnapshot = true;
    this.staging = undefined;
    this.options.events.reset?.();
    this.emitState();
  }

  /**
   * A retryable error is news on a stream that goes on (the transcript cannot be read just now): it
   * shows until the transcript becomes readable, even if it is empty. One that is not ends the
   * stream until `retry`.
   */
  private failed(frame: Frame<'error'>): void {
    this.error = { code: frame.code, message: frame.message };
    this.retryableError = frame.retryable;
    if (!frame.retryable) {
      this.dropSource();
      this.stopWatchdog();
      this.connection = 'failed';
    }
    this.emitState();
  }

  /** The window has reached where the server said it is current. */
  private settle(): void {
    if (this.current || this.currentAt === undefined || this.awaitingSnapshot || !this.resumable || this.held < this.currentAt) return;
    this.current = true;
    this.emitState();
  }

  /** A successful transcript read says nothing about an unrelated or terminal stream error. */
  private recoverTranscriptRead(): void {
    if (!this.retryableError || this.error?.code !== 'TRANSCRIPT_READ_FAILED' || this.connection === 'failed') return;
    this.error = undefined;
    this.retryableError = false;
    this.emitState();
  }

  private mergeOutline(frame: Frame<'outline'>): void {
    if (!Array.isArray(frame.turns)) return;
    const turns = new Map(this.outline.turns.map((turn) => [turn.turn, turn]));
    for (const turn of frame.turns) turns.set(turn.turn, turn);
    this.outline = { turnCount: frame.turnCount, turns: [...turns.values()].sort((a, b) => a.startPos - b.startPos) };
  }

  /**
   * A gap the server keeps reproducing would otherwise become a redial loop; the first redial is
   * immediate, repeats within a minute back off.
   */
  private gap(): void {
    const now = Date.now();
    this.gaps = now - this.lastGapAt > GAP_WINDOW_MS ? 1 : this.gaps + 1;
    this.lastGapAt = now;
    if (this.gaps === 1) { this.connect(); return; }
    this.dropSource();
    this.setConnection('retrying');
    this.retryTimer = setTimeout(() => this.connect(), Math.min(1000 * 2 ** Math.min(this.gaps - 2, 4), 15_000));
  }

  private streamFailed(closed: boolean): void {
    this.setConnection('retrying');
    // An open stream that drops is redialed by the transport itself, with `Last-Event-ID`.
    if (!closed) return;
    this.dropSource();
    this.retries += 1;
    const epoch = this.epoch;
    void (this.options.probe?.() ?? Promise.resolve(false)).catch(() => false).then((outdated) => {
      if (this.disposed || epoch !== this.epoch || this.connection !== 'retrying' || this.source || this.retryTimer !== undefined) return;
      if (outdated) this.markOutdated();
      else this.retryTimer = setTimeout(() => this.connect(), reconnectDelay(this.retries));
    });
  }

  private dropSource(): void {
    this.token = undefined;
    this.source?.close();
    this.source = undefined;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private stopWatchdog(): void {
    clearInterval(this.watchdog);
    this.watchdog = undefined;
  }

  private abortRequests(): void {
    for (const controller of this.requests) controller.abort();
    this.requests.clear();
    this.paging = {};
  }

  private setConnection(connection: LaneConnection): void {
    if (this.connection === connection) return;
    this.connection = connection;
    this.emitState();
  }

  private emitState(): void {
    if (!this.disposed) this.options.events.state?.();
  }
}
