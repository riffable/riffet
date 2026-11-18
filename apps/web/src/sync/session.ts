import type { NativeActivity, NativeContext, NativeInteraction, NativeInteractionResponse, NativeStatus, LaneFind, Run, RunMetrics, Session, StepMetrics, SyncLane, TimelineRow } from '@contracts';
import { createStore, type Store } from '@/lib/store';
import type { SyncCache } from './cache';
import { LaneSync, type ControlFrame, type LaneConnection, type LaneOutline, type PageResult } from './lane';
import { healthProtocol, SYNC_PROTOCOL, type SyncTransport } from './protocol';
import type { WindowLimit } from './window';

/** Whether the page is hidden, and word when that changes. */
export interface Visibility {
  hidden(): boolean;
  subscribe(listener: () => void): () => void;
}

/** docs/SYNC-V3.md 传输: a hidden tab keeps its streams this long before closing them. */
export const HIDDEN_CLOSE_MS = 60_000;
/** A burst of rows settles before the copy is written; leaving or hiding writes it at once. */
const SAVE_DELAY_MS = 2_000;
/** Rows in the saved copy per extra SAVE_DELAY_MS between writes. */
const SAVE_SLOW_ROWS = 400;
/**
 * An upper bound, not a delay: the local read normally settles in a millisecond and the stream dials
 * as soon as it does. The budget covers a read that never settles, which a browser can leave pending.
 */
const LOCAL_READ_BUDGET_MS = 2_000;

/**
 * One conversation as the server last said it was. Everything but the rows comes from control
 * frames (and the hello); none of it is ever worked out from the transcript.
 */
export interface SessionSyncState {
  connection: LaneConnection;
  error?: { code: string; message: string };
  /** The main lane has rows to show, from the cache or the server. */
  loaded: boolean;
  /** The server has confirmed the main lane on this visit. */
  synced: boolean;
  /** The main lane's stream is still bringing what was written while nobody watched (`LaneSync.current`). */
  catchingUp: boolean;
  generation?: string;
  hasBefore: boolean;
  hasAfter: boolean;
  loadingBefore: boolean;
  loadingAfter: boolean;
  /** Bumped by every change of the main lane's rows. */
  rowsVersion: number;
  /** Bumped when they were replaced whole (a snapshot, a jump): a reading position in them is gone. */
  resetVersion: number;
  status: NativeStatus;
  statusKnown: boolean;
  interaction: NativeInteraction | null;
  runs: Run[];
  activities: NativeActivity[];
  context?: NativeContext;
  session?: Session;
  outline: LaneOutline;
  /** Output speed per run, from `metrics` frames. */
  metrics: ReadonlyMap<string, RunMetrics>;
  step?: StepMetrics;
}

export interface SessionSyncOptions {
  sessionId: string;
  transport: SyncTransport;
  cache?: SyncCache;
  visibility?: Visibility;
  limit?: WindowLimit;
  /** Every accepted main-lane control update, including request results, after the state has taken it. */
  onControl?: (frame: ControlFrame) => void;
  /** Accepted live upserts of the main lane, before window clipping; child lanes keep their own rows. */
  onUpserts?: (rows: readonly TimelineRow[]) => void;
  /** A stream ended for good and will not redial: the caller may check whether the conversation was deleted (once). */
  onClosed?: () => void;
}

const protocolChecks = new WeakMap<SyncTransport, Promise<number>>();

/** Full wire content: revisions are opaque, and some providers keep one while updating fields. */
function interactionContent(interaction: NativeInteraction | null): string {
  return JSON.stringify(interaction, (_key, value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) : value);
}

/** The protocol the server declares on `/health`, asked once per page unless [fresh]; unknown when the server cannot be reached. */
function serverProtocol(transport: SyncTransport, fresh = false): Promise<number> {
  const cached = fresh ? undefined : protocolChecks.get(transport);
  if (cached) return cached;
  const check = transport.get<unknown>('/health').then(healthProtocol, () => {
    protocolChecks.delete(transport);
    return SYNC_PROTOCOL;
  });
  protocolChecks.set(transport, check);
  return check;
}

function upsertRun(runs: Run[], run: Run): Run[] {
  const index = runs.findIndex((item) => item.id === run.id);
  const next = index < 0 ? [...runs, run] : runs.map((item, at) => (at === index ? run : item));
  return index < 0 ? next.sort((a, b) => a.createdAt.localeCompare(b.createdAt)) : next;
}

/**
 * A conversation kept in sync: its main lane, the subagent lanes whose panels are open, the copy
 * for the next visit, and the tab's visibility. Framework-free; `useSessionSync` puts it on screen.
 */
export class SessionSync {
  readonly store: Store<SessionSyncState>;
  readonly main: LaneSync;
  private lanes = new Map<SyncLane, { lane: LaneSync; listeners: Set<(replaced: boolean) => void> }>();
  private hiddenTimer: ReturnType<typeof setTimeout> | undefined;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  /** What the cache was last given (generation, seq, row count) and how many rows that was: an unchanged lane is not written again, a long one is written less often. */
  private savedMark = '';
  private savedRows = 0;
  private stopVisibility: (() => void) | undefined;
  private readonly cacheEpoch: number;
  private disposed = false;
  private started = false;
  /** Local observation order, not the provider's opaque interaction revision. */
  private interactionSequence = 0;

  constructor(private readonly options: SessionSyncOptions) {
    this.cacheEpoch = options.cache?.epoch ?? 0;
    this.store = createStore<SessionSyncState>({
      connection: 'connecting', loaded: false, synced: false, catchingUp: true, hasBefore: false, hasAfter: false, loadingBefore: false, loadingAfter: false,
      rowsVersion: 0, resetVersion: 0, status: { phase: 'offline' }, statusKnown: false, interaction: null, runs: [], activities: [],
      outline: { turnCount: 0, turns: [] }, metrics: new Map(),
    });
    this.main = this.makeLane('main', {
      rows: (replaced) => {
        this.store.set((state) => ({ rowsVersion: state.rowsVersion + 1, ...(replaced ? { resetVersion: state.resetVersion + 1 } : {}) }));
        this.publish();
        this.scheduleSave();
      },
      upserts: (rows) => this.options.onUpserts?.(rows),
      control: (frame) => this.control(frame),
      state: () => this.publish(),
      reset: () => { this.interactionSequence += 1; void this.options.cache?.drop(this.options.sessionId); },
    });
  }

  get sessionId(): string { return this.options.sessionId; }
  /** Capture before a request; any intervening interaction observation makes its answer obsolete. */
  get interactionVersion(): number { return this.interactionSequence; }
  rows(): readonly TimelineRow[] { return this.main.window.rows(); }

  /** A GET snapshot or POST result takes the same engine-and-consumer path as a live interaction. */
  updateInteraction(interaction: NativeInteraction | null, observedVersion: number, submitted?: Pick<NativeInteractionResponse, 'interactionId' | 'revision'>): boolean {
    if (this.disposed || observedVersion !== this.interactionSequence) return false;
    const current = this.store.get().interaction;
    if (submitted && (current?.id !== submitted.interactionId || current.revision !== submitted.revision)) return false;
    this.control({ type: 'interaction', interaction });
    return true;
  }

  /** Paints the saved copy, then dials; resolves once the stream is on its way. */
  async start(): Promise<void> {
    if (this.started || this.disposed) return;
    this.started = true;
    const { cache, sessionId, visibility } = this.options;
    if (visibility) this.stopVisibility = visibility.subscribe(this.visibilityChanged);
    void serverProtocol(this.options.transport).then((version) => { if (version < SYNC_PROTOCOL) this.outdated(); });
    let held = cache?.peek(sessionId);
    if (!held && cache) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const budget = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), LOCAL_READ_BUDGET_MS); });
      held = await Promise.race([cache.load(sessionId), budget]);
      clearTimeout(timer);
    }
    if (this.disposed) return;
    if (held) this.main.restore(held);
    if (this.main.connection !== 'outdated') this.main.connect();
    if (visibility?.hidden()) this.visibilityChanged();
  }

  /** Redials every lane now; for an outdated server, asks again whether it still is. */
  retry(): void {
    if (this.disposed) return;
    if (this.main.connection !== 'outdated') { this.eachLane((lane) => lane.retry()); return; }
    void serverProtocol(this.options.transport, true).then((version) => {
      if (!this.disposed && version >= SYNC_PROTOCOL) this.eachLane((lane) => lane.retry());
    });
  }

  close(): void {
    if (this.disposed) return;
    this.save();
    this.disposed = true;
    clearTimeout(this.hiddenTimer);
    clearTimeout(this.saveTimer);
    this.stopVisibility?.();
    this.eachLane((lane) => lane.close());
    this.lanes.clear();
  }

  pageUp(): Promise<PageResult> { return this.main.pageUp(); }
  /** Which end of the main lane's window the reader is nearer to; a window over its budget keeps that end. */
  readerAtEnd(atEnd: boolean): void { this.main.readerAtEnd(atEnd); }
  pageDown(): Promise<PageResult> { return this.main.pageDown(); }
  jump(pos: number, signal?: AbortSignal): Promise<PageResult> { return this.main.jump(pos, signal); }
  /** The main lane's whole outline, beyond the newest turns the hello carried; the store's `outline` follows. */
  loadOutline(): Promise<LaneOutline | undefined> { return this.main.loadOutline(); }
  latest(signal?: AbortSignal): Promise<PageResult> { return this.main.latest(signal); }
  find(query: string, signal?: AbortSignal): Promise<LaneFind | undefined> { return this.main.find(query, signal); }
  expand(key: string, lane: SyncLane = 'main'): Promise<boolean> { return (lane === 'main' ? this.main : this.lanes.get(lane)?.lane)?.expand(key) ?? Promise.resolve(false); }

  /**
   * Subscribes to a subagent's lane while its panel is open. Each call holds the lane until its
   * release; the stream closes with the last one.
   */
  openLane(lane: SyncLane, listener: (replaced: boolean) => void): { lane: LaneSync; release: () => void } {
    let entry = this.lanes.get(lane);
    if (!entry) {
      const listeners = new Set<(replaced: boolean) => void>();
      const notify = (replaced = false) => { for (const each of [...listeners]) each(replaced); };
      entry = { lane: this.makeLane(lane, { rows: notify, state: () => notify() }), listeners };
      this.lanes.set(lane, entry);
      if (!this.disposed) {
        if (this.main.connection === 'outdated') entry.lane.markOutdated();
        else if (this.hiddenTimer === undefined && this.main.connection === 'suspended') entry.lane.suspend();
        else entry.lane.connect();
      }
    }
    const held = entry;
    held.listeners.add(listener);
    let released = false;
    return {
      lane: held.lane,
      release: () => {
        if (released) return;
        released = true;
        held.listeners.delete(listener);
        if (held.listeners.size || this.lanes.get(lane) !== held) return;
        held.lane.close();
        this.lanes.delete(lane);
      },
    };
  }

  private closedReported = false;

  private makeLane(lane: SyncLane, events: ConstructorParameters<typeof LaneSync>[0]['events']): LaneSync {
    return new LaneSync({
      sessionId: this.options.sessionId, lane, transport: this.options.transport, events,
      ...(this.options.limit ? { limit: this.options.limit } : {}),
      probe: () => {
        if (!this.closedReported) { this.closedReported = true; this.options.onClosed?.(); }
        return serverProtocol(this.options.transport, true).then((version) => version < SYNC_PROTOCOL);
      },
    });
  }

  private eachLane(action: (lane: LaneSync) => void): void {
    action(this.main);
    for (const { lane } of this.lanes.values()) action(lane);
  }

  private outdated(): void {
    if (this.disposed) return;
    this.eachLane((lane) => lane.markOutdated());
  }

  private control(frame: ControlFrame): void {
    const previous = this.store.get();
    if (frame.type === 'hello' || frame.type === 'interaction') {
      const interaction = frame.interaction ?? null;
      // A reconnect can repeat the same pending request while its POST is completing. That is
      // not a new interaction, and must not discard the receipt which closes this exact revision.
      if (interactionContent(previous.interaction) !== interactionContent(interaction)) this.interactionSequence += 1;
    }
    if (frame.type === 'hello' || frame.type === 'session') {
      if (previous.session?.nativeSessionId !== frame.session.nativeSessionId) this.interactionSequence += 1;
      if (frame.type === 'hello' && previous.generation !== frame.generation) this.interactionSequence += 1;
    }
    switch (frame.type) {
      case 'hello':
        this.store.set({
          status: frame.status, statusKnown: true, interaction: frame.interaction ?? null, runs: Array.isArray(frame.runs) ? frame.runs : [],
          activities: Array.isArray(frame.activities) ? frame.activities : [], context: frame.context, session: frame.session, outline: this.main.outline,
        });
        this.options.cache?.rememberContext(this.options.sessionId, frame.context, this.cacheEpoch);
        break;
      case 'status': this.store.set({ status: frame.status, statusKnown: true }); break;
      case 'interaction': this.store.set({ interaction: frame.interaction ?? null }); break;
      case 'runs': this.store.set({ runs: frame.runs }); break;
      case 'run': this.store.set((state) => ({ runs: upsertRun(state.runs, frame.run) })); break;
      case 'activities': this.store.set({ activities: frame.live }); break;
      case 'outline': this.store.set({ outline: this.main.outline }); break;
      case 'context': this.store.set({ context: frame.context }); this.options.cache?.rememberContext(this.options.sessionId, frame.context, this.cacheEpoch); break;
      case 'metrics':
        this.store.set((state) => {
          if (!frame.runId || !frame.run) return { step: frame.metrics };
          const metrics = new Map(state.metrics);
          metrics.set(frame.runId, frame.run);
          return { step: frame.metrics, metrics };
        });
        break;
      case 'session': this.store.set({ session: frame.session }); break;
    }
    this.options.onControl?.(frame);
  }

  /** The main lane's connection and window as the state shows them. */
  private publish(): void {
    if (this.disposed) return;
    const { main } = this;
    this.store.set({
      connection: main.connection, error: main.error, loaded: main.window.count > 0 || main.synced, synced: main.synced,
      // A stream that ended will bring nothing more: what shows is all there is.
      catchingUp: !main.current && !['failed', 'outdated', 'closed'].includes(main.connection),
      generation: main.generation, hasBefore: main.window.hasBefore, hasAfter: main.window.hasAfter,
      loadingBefore: main.loadingBefore, loadingAfter: main.loadingAfter, outline: main.outline,
    });
  }

  private scheduleSave(): void {
    if (this.saveTimer !== undefined || !this.options.cache) return;
    // Each write clones the whole copy (up to the 8 MB budget), so the longer the copy the longer the pause between writes.
    const delay = SAVE_DELAY_MS * Math.min(5, 1 + Math.floor(this.savedRows / SAVE_SLOW_ROWS));
    this.saveTimer = setTimeout(() => { this.saveTimer = undefined; this.save(); }, delay);
  }

  private save(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    const held = this.disposed ? undefined : this.main.saved();
    if (!held) return;
    const mark = `${held.generation}:${held.seq}:${held.rows.length}`;
    if (mark === this.savedMark) return;
    this.savedMark = mark;
    this.savedRows = held.rows.length;
    void this.options.cache?.save(this.options.sessionId, held, this.cacheEpoch);
  }

  /** Hidden: the copy is written (a phone may discard the tab next) and, after a while, the streams close. Shown: they resume. */
  private visibilityChanged = (): void => {
    if (this.disposed) return;
    if (this.options.visibility?.hidden()) {
      this.save();
      this.hiddenTimer ??= setTimeout(() => {
        this.hiddenTimer = undefined;
        this.eachLane((lane) => lane.suspend());
      }, HIDDEN_CLOSE_MS);
      return;
    }
    clearTimeout(this.hiddenTimer);
    this.hiddenTimer = undefined;
    this.eachLane((lane) => { lane.resume(); lane.revive(); });
  };
}
