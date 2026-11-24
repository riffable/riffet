import type {
  NativeBackendId, NativeContext, NativeJob, NativeStatus,
  NativeStreamMessage, NativeWorkbenchEvent, Session, SessionState,
} from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import { activityOfEvent, summarizeActivities } from '../journal/activity.js';
import type { JournalFeed } from '../journal/feed.js';
import { OutputRateTracker } from '../metrics/output-rate.js';
import { backendIdOf } from '../session-identity.js';
import type { Store } from '../store.js';
import type { TranscriptIngest } from '../sync/ingest.js';
import { BackendCatalog, safeBackendReason } from './catalog.js';
import type { NativeBackendRegistry } from './registry.js';
import type { TerminalDialogObserver } from './shared/terminal-dialogs.js';
import type { NativeBackendDriver, NativeBackendHost, NativeBackendProfileConfig, NativeControlMessage } from './types.js';

export type ControlMessage = Extract<NativeStreamMessage, { type: 'status' | 'context' | 'metrics' }>;

export interface BackendWatch {
  driver: NativeBackendDriver;
  profile: NativeBackendProfileConfig;
  nativeSessionId?: string;
  /**
   * Child activity affects the session, while status.phase still describes the main agent. Claude Code's
   * background agents outlive its turns and are independent of them: they are reported through the
   * `subagent` messages' `running` flag and never hold the session in `running` (see `activeSubagents`).
   */
  runningSubagents: Map<string, string>;
  status?: NativeStatus;
  /** The context the provider reported last, for a sync v3 stream that opens after it did. */
  context?: NativeContext;
  /** The control path's readers (`watchControl`): sync streams and the dispatcher. */
  controlListeners: Set<(message: ControlMessage) => void>;
  unsubscribe: () => void;
  releaseTimer?: NodeJS.Timeout;
}

export const listened = (watch: BackendWatch): boolean => watch.controlListeners.size > 0;
export function activeSubagents(watch: BackendWatch | undefined): number {
  return watch && !watch.driver.traits?.detachedSubagents ? watch.runningSubagents.size : 0;
}

/** How long a watch nobody listens to survives a one-shot read, so a page that comes back reuses it. */
const WATCH_IDLE_MS = 60_000;
const OUTPUT_RATE_RETENTION_MS = 300_000;
const EMPTY_OUTPUT_RATE = new OutputRateTracker().sample();

function sameProfileConfig(left: NativeBackendProfileConfig, right: NativeBackendProfileConfig): boolean {
  return left.backendId === right.backendId && left.id === right.id
    && JSON.stringify(left.config) === JSON.stringify(right.config);
}

export interface WatchHubDeps {
  readonly store: Store;
  readonly registry: NativeBackendRegistry;
  readonly catalog: BackendCatalog;
  readonly terminalDialogs: TerminalDialogObserver;
  readonly watchIdleMs?: number;
  host(): NativeBackendHost;
  ingest(): TranscriptIngest | undefined;
  isClosed(): boolean;
  unavailable(backendId: NativeBackendId): AppError | undefined;
  resolveSync(session: Session): { driver: NativeBackendDriver; profile: NativeBackendProfileConfig };
  bindProfile(session: Session, driver: NativeBackendDriver, profile: NativeBackendProfileConfig): void;
  deriveSessionState(facts: { current: SessionState; phase?: NativeStatus['phase']; terminalLive?: boolean; runningSubagents?: number; startError?: boolean }): SessionState;
  sessionStatePatch(session: Session, state: SessionState, error?: string): Partial<Session>;
  selectedProfile(sessionId: string): { driver: NativeBackendDriver; profile: NativeBackendProfileConfig } | undefined;
  clearProfilesForBackend(backendId: NativeBackendId): void;
  clearSessionProfile(sessionId: string): void;
}

export class WatchHub {
  readonly watches = new Map<string, BackendWatch>();
  readonly controlReaders = new Map<string, Set<(message: ControlMessage) => void>>();
  private readonly outputRates = new Map<string, { binding: string; tracker: OutputRateTracker; updatedAt: number; published?: string }>();
  private outputRateTimer?: NodeJS.Timeout;
  readonly following = new Map<string, () => void>();
  private readonly eventListeners = new Map<string, Set<(event: NativeWorkbenchEvent) => void>>();
  private readonly jobs = new Map<string, Map<string, NativeJob>>();
  private readonly jobListeners = new Set<(sessionId: string, job: NativeJob) => void>();

  constructor(private readonly deps: WatchHubDeps) {}

  private controlSet(sessionId: string): Set<(message: ControlMessage) => void> {
    let readers = this.controlReaders.get(sessionId);
    if (!readers) this.controlReaders.set(sessionId, readers = new Set());
    return readers;
  }

  armControl(session: Session): { driver: NativeBackendDriver; profile: NativeBackendProfileConfig } {
    session = this.deps.catalog.currentSession(session);
    const selected = this.deps.resolveSync(session);
    this.ensureWatch(session, selected.driver, selected.profile);
    this.scheduleWatchRelease(session.id);
    if (this.watchesTerminalDialogs(session)) {
      this.deps.terminalDialogs.watch(session.id, () => this.deps.store.getSession(session.id), () => this.publishStatus(session.id, selected.driver, selected.profile));
    }
    return selected;
  }

  watchesTerminalDialogs(session: Session): boolean {
    return !this.deps.catalog.traits(backendIdOf(session)).ownsSessionObservation && !session.archivedAt;
  }

  usesTerminalDialogs(session: Session): boolean {
    return this.watchesTerminalDialogs(session) && Boolean(session.terminalId);
  }

  detachBackend(backendId: NativeBackendId): void {
    const reason = this.deps.unavailable(backendId)?.message ?? `Native backend ${backendId} is not available`;
    for (const [sessionId, watch] of [...this.watches]) {
      if (watch.driver.id !== backendId) continue;
      const status = this.withOutputRate(sessionId, { phase: 'offline', connection: { state: 'failed', message: reason } });
      for (const listener of [...watch.controlListeners]) { try { listener({ type: 'status', status }); } catch { /* one reader does not stop the others */ } }
      this.releaseWatch(sessionId, watch);
    }
    this.deps.clearProfilesForBackend(backendId);
  }

  attachBackend(backendId: NativeBackendId): void {
    if (this.deps.isClosed()) return;
    this.deps.ingest()?.reopen(sessionId => {
      try {
        const session = this.deps.store.getSession(sessionId);
        return session.kind === 'native' && backendIdOf(session) === backendId;
      } catch { return false; }
    });
    for (const [sessionId, readers] of [...this.controlReaders]) {
      if (!readers.size) continue;
      try {
        const session = this.deps.store.getSession(sessionId);
        if (session.kind !== 'native' || backendIdOf(session) !== backendId) continue;
        const { driver, profile } = this.armControl(session);
        const status = driver.status(this.deps.host(), session, profile);
        if (status.phase !== 'offline') this.broadcast(sessionId, { type: 'status', status });
      } catch (error) {
        console.warn(`[riffet] ${backendId}: re-attaching ${sessionId} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  ensureWatch(session: Session, driver: NativeBackendDriver, profile: NativeBackendProfileConfig): BackendWatch {
    if (driver.id === 'codex' || driver.id === 'traex') profile = this.deps.resolveSync(session).profile;
    const existing = this.watches.get(session.id);
    if (existing && existing.driver === driver && sameProfileConfig(existing.profile, profile) && existing.nativeSessionId === session.nativeSessionId) return existing;
    if (this.deps.isClosed()) throw new AppError('NATIVE_BACKENDS_CLOSED', 'Native backend service is shutting down', 503);
    if (session.nativeSessionId || session.terminalId) this.deps.bindProfile(session, driver, profile);
    if (existing) {
      if (existing.releaseTimer) clearTimeout(existing.releaseTimer);
      try { existing.unsubscribe(); } catch { /* rebinding continues */ }
    }
    const watch: BackendWatch = {
      driver, profile, nativeSessionId: session.nativeSessionId,
      runningSubagents: new Map(),
      controlListeners: this.controlSet(session.id),
      unsubscribe: () => undefined,
    };
    this.watches.set(session.id, watch);
    try {
      watch.unsubscribe = driver.subscribe(this.deps.host(), session, profile, message => this.broadcast(session.id, message));
    } catch (error) {
      this.watches.delete(session.id);
      throw error;
    }
    return watch;
  }

  scheduleWatchRelease(sessionId: string): void {
    const watch = this.watches.get(sessionId);
    if (!watch || this.deps.isClosed()) return;
    if (watch.releaseTimer) clearTimeout(watch.releaseTimer);
    watch.releaseTimer = undefined;
    this.follow(sessionId);
    if (listened(watch)) return;
    watch.releaseTimer = setTimeout(() => {
      watch.releaseTimer = undefined;
      if (this.deps.isClosed() || this.watches.get(sessionId) !== watch) return;
      if (this.hasUnfinishedRun(sessionId) || this.providerLive(sessionId)) this.scheduleWatchRelease(sessionId);
      else if (!listened(watch)) this.releaseWatch(sessionId, watch);
    }, this.deps.watchIdleMs ?? WATCH_IDLE_MS);
    watch.releaseTimer.unref();
  }

  private providerLive(sessionId: string): boolean {
    try {
      const session = this.deps.store.getSession(sessionId);
      if (this.watches.get(sessionId)?.runningSubagents.size) return true;
      if (['starting', 'running', 'waiting', 'cancelling'].includes(session.state)) return true;
      if (this.deps.catalog.traits(backendIdOf(session)).ownsSessionObservation || !session.terminalId) return false;
      return this.deps.store.getTerminal(session.terminalId).state === 'running';
    } catch { return false; }
  }

  private liveNativeTerminal(session: Session): boolean {
    try {
      const item = this.deps.store.getTerminal(session.terminalId!);
      return item.sessionId === session.id && item.projectId === session.projectId && item.kind === 'native' && item.state !== 'exited';
    } catch { return false; }
  }

  hasListeners(sessionId: string): boolean {
    const watch = this.watches.get(sessionId);
    return Boolean(watch && listened(watch));
  }

  follow(sessionId: string): void {
    const ingest = this.deps.ingest();
    if (!ingest || this.deps.isClosed() || this.following.has(sessionId)) return;
    const watch = this.watches.get(sessionId);
    if (!watch || !(listened(watch) || this.hasUnfinishedRun(sessionId) || this.providerLive(sessionId))) return;
    this.following.set(sessionId, ingest.follow(sessionId));
  }

  unfollow(sessionId: string): void {
    const release = this.following.get(sessionId);
    this.following.delete(sessionId);
    release?.();
  }

  private hasUnfinishedRun(sessionId: string): boolean {
    try { return this.deps.store.listUnfinishedNativeRuns(sessionId).some(run => !run.native?.queueReleasedAt); }
    catch { return false; }
  }

  private releaseWatch(sessionId: string, watch: BackendWatch): void {
    if (watch.releaseTimer) clearTimeout(watch.releaseTimer);
    watch.releaseTimer = undefined;
    try { watch.unsubscribe(); } catch { /* release continues */ }
    if (this.watches.get(sessionId) === watch) { this.watches.delete(sessionId); this.unfollow(sessionId); }
    this.dropIdleReaders(sessionId);
    this.deps.terminalDialogs.release(sessionId);
  }

  dropIdleReaders(sessionId: string): void {
    if (!this.watches.has(sessionId) && !this.controlReaders.get(sessionId)?.size) this.controlReaders.delete(sessionId);
  }

  watchControl(sessionId: string, listener: (message: ControlMessage) => void): { status(): NativeStatus; context(): NativeContext | undefined; close(): void } {
    const session = this.deps.store.getSession(sessionId);
    const readers = this.controlSet(sessionId);
    if (!this.deps.unavailable(backendIdOf(session))) {
      try { this.armControl(session); }
      catch (error) { this.dropIdleReaders(sessionId); throw error; }
    }
    let closed = false;
    const relay = (message: ControlMessage) => { if (!closed) listener(message); };
    readers.add(relay);
    return {
      status: () => {
        const stored = this.deps.store.getSession(sessionId);
        const current = this.deps.catalog.currentSession(stored);
        const missing = this.deps.unavailable(backendIdOf(current));
        if (missing) return this.withOutputRate(sessionId, { phase: 'offline', connection: { state: 'failed', message: missing.message } });
        let selected: { driver: NativeBackendDriver; profile: NativeBackendProfileConfig } | undefined;
        try {
          selected = current !== stored ? this.deps.resolveSync(current) : this.watches.get(sessionId) ?? this.deps.resolveSync(current);
          return this.withOutputRate(sessionId, this.deps.terminalDialogs.merge(current, selected.driver.status(this.deps.host(), current, selected.profile)));
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'Native backend status is unavailable';
          return this.withOutputRate(sessionId, { phase: 'offline', connection: { state: 'failed', message: selected ? safeBackendReason(reason, selected.profile) : reason.slice(0, 1000) } });
        }
      },
      context: () => this.watches.get(sessionId)?.context ?? this.savedContext(sessionId),
      close: () => {
        if (closed) return;
        closed = true;
        readers.delete(relay);
        const watch = this.watches.get(sessionId);
        if (!watch || !listened(watch)) this.deps.terminalDialogs.release(sessionId);
        this.scheduleWatchRelease(sessionId);
        this.dropIdleReaders(sessionId);
      },
    };
  }

  private saveContext(sessionId: string, context: NativeContext | undefined): void {
    try {
      const session = this.deps.store.getSession(sessionId);
      const chat = session.nativeSessionId;
      if (chat) this.deps.store.saveNativeContext(sessionId, chat, context);
    } catch { /* a deleted session */ }
  }

  private savedContext(sessionId: string): NativeContext | undefined {
    try {
      const session = this.deps.store.getSession(sessionId);
      const chat = session.nativeSessionId;
      return chat ? this.deps.store.getNativeContext(sessionId, chat) : undefined;
    } catch { return undefined; }
  }

  publishStatus(sessionId: string, driver: NativeBackendDriver, profile: NativeBackendProfileConfig): void {
    const stored = this.deps.store.getSession(sessionId);
    const session = this.deps.catalog.currentSession(stored);
    if (session !== stored) profile = this.deps.resolveSync(session).profile;
    if (session.archivedAt) return;
    let status: NativeStatus;
    try { status = driver.status(this.deps.host(), session, profile); }
    catch (error) { status = { phase: 'offline', connection: { state: 'failed', message: safeBackendReason(error instanceof Error ? error.message : 'Native backend status is unavailable', profile) } }; }
    this.broadcast(sessionId, { type: 'status', status });
  }

  broadcast(sessionId: string, message: NativeControlMessage): void {
    if (this.deps.isClosed()) return;
    if (message.type === 'job') { this.noteJob(sessionId, message.job); return; }
    if (message.type === 'session') { try { this.deps.store.appendEvent(sessionId, 'session', { session: message.session }); } catch { /* a deleted session */ } return; }
    if (message.type === 'metrics') {
      const binding = this.outputRateBinding(sessionId);
      let entry = this.outputRates.get(sessionId);
      if (!entry || entry.binding !== binding) {
        entry = { binding, tracker: new OutputRateTracker(), updatedAt: Date.now() };
        this.outputRates.set(sessionId, entry);
      }
      entry.updatedAt = Date.now();
      entry.tracker.update(message.metrics, entry.updatedAt);
      this.ensureOutputRateTimer();
    }
    const watch = this.watches.get(sessionId);
    if (message.type === 'context' && (message.context || watch?.context)) this.saveContext(sessionId, message.context);
    if (watch) {
      if (message.type === 'subagent') {
        if (message.running === true) watch.runningSubagents.set(message.toolCallId, message.agentId);
        else if (message.running === false || watch.runningSubagents.get(message.toolCallId) !== message.agentId) watch.runningSubagents.delete(message.toolCallId);
      }
      if (message.type === 'status') watch.status = message.status;
      if (message.type === 'context') watch.context = message.context;
    }
    const loaded = message.type === 'status' || (message.type === 'subagent' && watch) ? this.deps.store.getSession(sessionId) : undefined;
    if (watch && loaded && watch.nativeSessionId !== loaded.nativeSessionId && loaded.nativeSessionId) {
      watch.runningSubagents.clear();
      watch.nativeSessionId = loaded.nativeSessionId;
      this.jobs.delete(sessionId);
    }
    const rawStatus = message.type === 'status' ? message.status
      : watch && loaded ? watch.status ?? watch.driver.status(this.deps.host(), loaded, watch.profile) : undefined;
    let delivered: NativeControlMessage = message;
    let statusSession: Session | undefined;
    if (rawStatus && loaded && !this.deps.catalog.traits(backendIdOf(loaded)).ownsSessionObservation) {
      const current = loaded;
      const status = this.deps.terminalDialogs.merge(current, rawStatus);
      if (message.type === 'status') delivered = { type: 'status', status };
      const targetState = this.deps.deriveSessionState({
        current: current.state, phase: status.phase, runningSubagents: activeSubagents(watch),
        terminalLive: Boolean(current.terminalId && this.liveNativeTerminal(current)),
      });
      const patch = this.deps.sessionStatePatch(current, targetState);
      if (!current.archivedAt && (current.state !== targetState || (targetState !== 'failed' && current.error))) {
        statusSession = this.deps.store.updateSession(sessionId, patch);
        this.deps.store.appendEvent(sessionId, 'session', { session: statusSession });
        this.follow(sessionId);
      }
    }
    if (delivered.type === 'status') delivered = { ...delivered, status: this.withOutputRate(sessionId, delivered.status, statusSession ?? loaded) };
    if (watch && (delivered.type === 'status' || delivered.type === 'context' || delivered.type === 'metrics')) {
      for (const listener of watch.controlListeners) { try { listener(delivered); } catch { /* one reader does not stop the others */ } }
    }
  }

  private noteJob(sessionId: string, job: NativeJob): void {
    let jobs = this.jobs.get(sessionId);
    if (!jobs) this.jobs.set(sessionId, jobs = new Map());
    if (JSON.stringify(jobs.get(job.toolCallId)) === JSON.stringify(job)) return;
    jobs.set(job.toolCallId, job);
    for (const listener of this.jobListeners) { try { listener(sessionId, job); } catch { /* one reader does not stop the others */ } }
  }

  listJobs(sessionId: string): NativeJob[] { return [...this.jobs.get(sessionId)?.values() ?? []]; }
  onJobChanged(listener: (sessionId: string, job: NativeJob) => void): () => void {
    this.jobListeners.add(listener);
    return () => { this.jobListeners.delete(listener); };
  }
  emitEvent(sessionId: string, event: NativeWorkbenchEvent): void {
    for (const listener of this.eventListeners.get(sessionId) ?? []) { try { listener(event); } catch { /* a reader's failure is its own */ } }
  }
  watchEvents(sessionId: string, listener: (event: NativeWorkbenchEvent) => void): () => void {
    let listeners = this.eventListeners.get(sessionId);
    if (!listeners) this.eventListeners.set(sessionId, listeners = new Set());
    listeners.add(listener);
    return () => { listeners.delete(listener); if (!listeners.size && this.eventListeners.get(sessionId) === listeners) this.eventListeners.delete(sessionId); };
  }

  readJournal(feed: JournalFeed): () => void {
    return feed.subscribe(() => true, batch => {
      const events = batch.items.flatMap(item => 'event' in item ? [item.event] : []);
      const turnStarted = batch.lane === 'main' && batch.items.some(item => 'mark' in item && (item.mark.edge === 'started' || item.mark.edge === 'reopened'));
      if (!events.length && !turnStarted) return;
      const watch = batch.lane === 'main' ? this.watches.get(batch.sessionId) : undefined;
      if (watch && listened(watch) && (events.some(event => activityOfEvent(event))
        || ((turnStarted || events.some(event => event.type === 'agent_message_chunk' || event.type === 'agent_thought_chunk' || event.type === 'tool_call'))
          && watch.status?.phase !== 'busy' && watch.status?.phase !== 'attention'))) {
        try { this.publishStatus(batch.sessionId, watch.driver, watch.profile); } catch { /* a status that cannot be read is the driver's own */ }
      }
      const calls = events.filter(event => event.type === 'tool_call' || event.type === 'tool_call_update');
      if (!calls.length) return;
      try {
        const driver = this.watches.get(batch.sessionId)?.driver;
        const traits = driver ? driver.traits ?? {} : this.deps.catalog.traits(backendIdOf(this.deps.store.getSession(batch.sessionId)));
        if (!traits.ownsSessionObservation) this.deps.host().stats.observeEvents(batch.sessionId, calls);
      } catch { /* statistics are best-effort */ }
    });
  }

  private outputRateBinding(sessionId: string, session: Session = this.deps.store.getSession(sessionId)): string {
    return JSON.stringify([backendIdOf(session), session.nativeSessionId ?? null]);
  }

  withOutputRate(sessionId: string, status: NativeStatus, session?: Session): NativeStatus {
    const decorated = this.withJournalActivity(sessionId, status);
    const entry = this.outputRates.get(sessionId);
    if (!entry) return { ...decorated, outputRate: EMPTY_OUTPUT_RATE };
    if (entry.binding !== this.outputRateBinding(sessionId, session)) {
      this.outputRates.delete(sessionId);
      return { ...decorated, outputRate: EMPTY_OUTPUT_RATE };
    }
    return { ...decorated, outputRate: entry.tracker.sample() };
  }

  private withJournalActivity(sessionId: string, status: NativeStatus): NativeStatus {
    const ingest = this.deps.ingest();
    if (status.activity || !ingest || !this.following.has(sessionId)) return status;
    const writer = ingest.writer(sessionId);
    const summary = summarizeActivities((writer.scratch ?? writer).activities.live());
    return summary.compacting || summary.background ? { ...status, activity: summary } : status;
  }

  private ensureOutputRateTimer(): void {
    if (this.outputRateTimer) return;
    this.outputRateTimer = setInterval(() => {
      const now = Date.now();
      for (const [sessionId, entry] of this.outputRates) {
        const watch = this.watches.get(sessionId);
        if (!watch && now - entry.updatedAt >= OUTPUT_RATE_RETENTION_MS) {
          this.outputRates.delete(sessionId);
          continue;
        }
        const sample = entry.tracker.sample(now);
        if (!watch || !listened(watch)) continue;
        const serialized = JSON.stringify(sample);
        if (serialized === entry.published) continue;
        entry.published = serialized;
        try { this.publishStatus(sessionId, watch.driver, watch.profile); }
        catch { /* a deleted session must not interrupt other sessions' sampling */ }
      }
      if (!this.outputRates.size) {
        clearInterval(this.outputRateTimer);
        this.outputRateTimer = undefined;
      }
    }, 1_000);
    this.outputRateTimer.unref();
  }

  disposeSession(sessionId: string): void {
    this.outputRates.delete(sessionId);
    this.jobs.delete(sessionId);
    this.unfollow(sessionId);
    if (!this.outputRates.size) {
      clearInterval(this.outputRateTimer);
      this.outputRateTimer = undefined;
    }
    const watch = this.watches.get(sessionId);
    if (watch) {
      if (watch.releaseTimer) clearTimeout(watch.releaseTimer);
      try { watch.unsubscribe(); } catch { /* adapter cleanup continues */ }
      this.watches.delete(sessionId);
    }
    this.dropIdleReaders(sessionId);
    this.deps.terminalDialogs.release(sessionId);
  }

  drainForClose(): Map<string, { driver: NativeBackendDriver; profile: NativeBackendProfileConfig }> {
    clearInterval(this.outputRateTimer);
    this.outputRateTimer = undefined;
    this.outputRates.clear();
    this.deps.terminalDialogs.releaseAll();
    const sessions = new Map<string, { driver: NativeBackendDriver; profile: NativeBackendProfileConfig }>();
    for (const [sessionId, watch] of this.watches) {
      if (watch.releaseTimer) clearTimeout(watch.releaseTimer);
      try { watch.unsubscribe(); } catch { /* adapter shutdown continues */ }
      sessions.set(sessionId, { driver: watch.driver, profile: watch.profile });
    }
    this.watches.clear();
    this.controlReaders.clear();
    for (const sessionId of [...this.following.keys()]) this.unfollow(sessionId);
    return sessions;
  }
}
