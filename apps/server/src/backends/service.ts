import { assertTaskWorkspaceAvailable } from '../task-workspaces/identity.js';
import type {
  ModelInfo, NativeActivity, NativeBackendId,
  NativeContext, NativeInteraction, NativeJob, NativeInteractionResponse, NativeInteractionResult, NativeStopRequest, NativeWorkbenchEvent,
  NativeBackendProfilesResponse, NativeRunConfig, NativeRunInput, NativeRuntimeActionRequest, NativeStatus, NativeTurnTarget, Project, Run, Session, SessionState, TerminalInfo, WorkbenchEvent,
} from '../../../../packages/contracts/src/index.js';
import { AppError, sessionInTerminal } from '../errors.js';
import type { Store } from '../store.js';
import type { WorkspaceService } from '../workspace/index.js';
import type { SessionLockHandle } from '../agent-host/session-lock.js';
import type { TerminalBehaviour, TerminalService } from '../terminal/service.js';
import { prepareSource } from './shared/model-source.js';
import { modelFamily } from './shared/model-selection.js';
export { modelFamily } from './shared/model-selection.js';
import { NativeBackendRegistry, isNativeBackendId } from './registry.js';
import { TerminalDialogObserver } from './shared/terminal-dialogs.js';
import { BackendCatalog, curateModels, modelNormalizer, profileDefaultModel, safeBackendReason } from './catalog.js';
import { BackendAdmin } from './admin.js';
import type { StatsSink, UsageTranscript } from '../stats/types.js';
import { servingKey, type TranscriptSource, type TurnEndStatus } from '../journal/ingest.js';
import { backendIdOf } from '../session-identity.js';
import { activityOfEvent, summarizeActivities } from '../journal/activity.js';
import type { TranscriptIngest } from '../sync/ingest.js';
import type { JournalFeed } from '../journal/feed.js';
import type { ExternalSessionEntry, ExternalSessionScan, NativeBackendDriver, NativeBackendHost, NativeBackendOpenOptions, NativeBackendOpenResult, NativeBackendProfileConfig, NativeControlMessage, NativeDispatchBinding, NativePtyLaunchSpec, NativeRiffetMcpHost, NativeStandingHost } from './types.js';
import { stopWorkbenchAppServerAt } from './shared/app-server-daemons.js';
import { appServerCredentialDirs } from './codex/config.js';
import { OutputRateTracker } from '../metrics/output-rate.js';

/** Used when the process has not installed a ledger. Recording must stay optional for the session. */
const noopStats: StatsSink = {
  recordUsage() {},
  observeEvents() {},
};

interface BackendWatch {
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

type ControlMessage = Extract<NativeControlMessage, { type: 'status' | 'context' | 'metrics' }>;

const listened = (watch: BackendWatch): boolean => watch.controlListeners.size > 0;

/** How long a watch nobody listens to survives a one-shot read, so a page that comes back reuses it. */
const WATCH_IDLE_MS = 60_000;
const OUTPUT_RATE_RETENTION_MS = 300_000;
const EMPTY_OUTPUT_RATE = new OutputRateTracker().sample();

/** What is known about a native session right now; `deriveSessionState` is the only reader of it. */
export interface SessionStateFacts {
  current: SessionState;
  /** The provider's latest phase. Absent when only a terminal fact is known (attach, exit). */
  phase?: NativeStatus['phase'];
  terminalLive?: boolean;
  runningSubagents?: number;
  /** The CLI or its runtime failed to start; the only way to reach `failed`. */
  startError?: boolean;
}

/** How many running subagents keep the session itself busy: none for a backend whose agents run on their own. */
function activeSubagents(watch: BackendWatch | undefined): number {
  return watch && !watch.driver.traits?.detachedSubagents ? watch.runningSubagents.size : 0;
}

const LIVE_STATES: ReadonlySet<SessionState> = new Set(['idle', 'running', 'waiting', 'cancelling']);

/**
 * The single place that turns observations into `Session.state`; every writer reports facts and
 * persists the result. `failed` means a start/recovery failure and nothing else (a notice is not a
 * state): it is held through offline observations and cleared by the next phase the provider reports.
 */
export function deriveSessionState(facts: SessionStateFacts): SessionState {
  const { current, phase, terminalLive = false, runningSubagents = 0 } = facts;
  if (facts.startError) return 'failed';
  if (phase === 'attention') return 'waiting';
  if (phase === 'busy' || runningSubagents > 0) return 'running';
  if (phase === 'starting') return 'starting';
  if (phase === 'idle') return 'idle';
  if (current === 'failed') return 'failed';
  if (!terminalLive) return 'idle';
  // A live terminal with no phase yet: a re-attach is not activity, so a state the screen monitor set stays.
  return phase === undefined && !LIVE_STATES.has(current) ? 'running' : current;
}

/** The session patch for a derived state: `error` is only meaningful while the session is `failed`. */
export function sessionStatePatch(session: Session, state: SessionState, error?: string): Partial<Session> {
  if (state === 'failed') return { state, ...(error ? { error } : {}) };
  return { state, ...(session.error ? { error: undefined } : {}) };
}

function sameProfileConfig(left: NativeBackendProfileConfig, right: NativeBackendProfileConfig): boolean {
  return left.backendId === right.backendId && left.id === right.id
    && JSON.stringify(left.config) === JSON.stringify(right.config);
}

/** A word the shell reads back unchanged: bare when it has nothing special in it, quoted otherwise. */
function shellWord(value: string): string {
  return /^[\w@%+=:,./~-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

export interface NativeBackendServiceOptions {
  store: Store;
  workspace: WorkspaceService;
  terminal: TerminalService;
  /** The host's session lock; the runtime manager's own `withSession` pair serves as well. */
  runtime: SessionLockHandle;
  registry: NativeBackendRegistry;
  defaultProfileId?: (backendId: NativeBackendId) => string | undefined;
  /** Ledger for settled usage and transcript events. Absent means record nothing. */
  stats?: StatsSink;
  /** Idle lifetime of an unpinned provider watch; defaults to {@link WATCH_IDLE_MS}. */
  watchIdleMs?: number;
  profiles?: {
    get(backendId: NativeBackendId): NativeBackendProfilesResponse;
    getConfig(backendId: NativeBackendId, profileId: string): Record<string, unknown> | undefined;
  };
  /** The Riffet MCP server launches carry, handed to drivers through the host. */
  riffetMcp?: NativeRiffetMcpHost;
  /** Standing conversations (docs/ASSISTANT.md §4), handed to drivers through the host. */
  standing?: NativeStandingHost;
  prepareContextInput?: (run: Run) => Promise<NativeRunInput>;
}

/** Routes native operations to provider adapters and owns their watches and run write fence. */
export class NativeBackendService {
  readonly registry: NativeBackendRegistry;
  readonly host: NativeBackendHost;
  readonly catalog: BackendCatalog;
  readonly admin: BackendAdmin;
  private readonly watches = new Map<string, BackendWatch>();
  /**
   * The control path's readers by conversation (`watchControl`). They belong to whoever opened them, not to a watch: a
   * watch released because its backend was withdrawn leaves them in place, and `attachBackend` hands them to the
   * next one.
   */
  private readonly controlReaders = new Map<string, Set<(message: ControlMessage) => void>>();
  /** Outlives the short provider watch TTL so a page reconnect retains its recent output. */
  private readonly outputRates = new Map<string, {
    binding: string; tracker: OutputRateTracker; updatedAt: number; published?: string;
  }>();
  private outputRateTimer?: NodeJS.Timeout;
  private readonly sessionProfiles = new Map<string, { driver: NativeBackendDriver; profile: NativeBackendProfileConfig }>();
  /**
   * Startup screens of the protocol-first backends. Cursor parses its own screen inside its driver,
   * so this only ever serves Claude Code and Codex terminals (DSH runs without one).
   */
  private readonly terminalDialogs: TerminalDialogObserver;
  private closed = false;
  private ingest: TranscriptIngest | undefined;
  /** Conversations read into the journal on everyone's behalf, while their watch lives (see `follow`). */
  private readonly following = new Map<string, () => void>();
  /** Events a driver sends outside its transcript (`host.emitEvent`): steer receipts, hook-reported turn ends. */
  private readonly eventListeners = new Map<string, Set<(event: NativeWorkbenchEvent) => void>>();
  /** Background jobs as the provider last reported them (Cursor), by session and tool call. */
  private readonly jobs = new Map<string, Map<string, NativeJob>>();
  private readonly jobListeners = new Set<(sessionId: string, job: NativeJob) => void>();

  constructor(private readonly options: NativeBackendServiceOptions) {
    this.registry = options.registry;
    this.terminalDialogs = new TerminalDialogObserver(options.terminal, (session, dialog) => {
      session = this.catalog.currentSession(session);
      return this.resolveSync(session).driver.endorsesScreenDialog?.(this.host, session, dialog) ?? true;
    });
    const stats = options.stats ?? noopStats;
    this.host = {
      getSession: id => options.store.getSession(id),
      firstUserMessage: id => options.store.firstUserMessage(id),
      getProject: id => options.store.getProject(id),
      listSessions: () => options.store.listSessions(),
      findTerminal: id => options.store.findTerminal(id),
      listTerminals: () => options.store.listTerminals(),
      recordActivity: (id, at) => options.store.updateSessionActivity(id, at),
      getProfile: session => this.resolveSync(session).profile,
      findProfile: (backendId, profileId) => this.catalog.profiles(options.registry.require(backendId)).find(profile => profile.id === profileId),
      updateSession: (id, patch) => options.store.updateSession(id, patch),
      bumpConfig: (id, patch) => options.store.bumpConfig(id, patch),
      setNativeSessionId: (id, nativeSessionId) => {
        const session = options.store.getSession(id);
        if (session.nativeSessionId === nativeSessionId) return session;
        const updated = options.store.updateSession(id, { nativeSessionId });
        options.store.appendEvent(id, 'session', { session: updated });
        if (nativeSessionId && (this.watches.has(id) || this.controlReaders.get(id)?.size)) {
          try {
            const { driver, profile } = this.resolveSync(updated);
            this.ensureWatch(updated, driver, profile);
            this.scheduleWatchRelease(id);
          } catch { /* the caller's open or send binds the watch */ }
        }
        return updated;
      },
      emit: (id, message) => this.broadcast(id, message),
      emitEvent: (id, event) => {
        for (const listener of this.eventListeners.get(id) ?? []) { try { listener(event); } catch { /* a reader's failure is its own */ } }
      },
      saveRunMetrics: (runId, metrics) => {
        try {
          options.store.saveRunMetrics(runId, metrics);
        } catch { /* A turn that finished and was pruned must not break the live stream. */ }
      },
      findRunIdByCommand: (sessionId, commandId) => options.store.findRunByCommand(sessionId, commandId)?.id,
      findRunIdByNativeMessage: (sessionId, nativeMessageId) => options.store.findRunByNativeMessage(sessionId, nativeMessageId)?.id,
      listRuns: sessionId => options.store.listRuns(sessionId),
      findRunsByNativeTurn: (sessionId, nativeSessionId, turnId) => options.store.findRunsByNativeTurn(sessionId, nativeSessionId, turnId),
      stats,
      journal: options.store.journal,
      getInteractionReceipt: (sessionId, requestId) => options.store.getNativeInteractionReceipt(sessionId, requestId),
      saveInteractionReceipt: (sessionId, requestId, receipt) => options.store.saveNativeInteractionReceipt(sessionId, requestId, receipt),
      readAttachment: id => options.workspace.readAttachment(id),
      commitDispatchFence: (runId, binding) => this.commitDispatchFence(runId, binding),
      isRunCancelled: runId => {
        try { return options.store.getRun(runId).native?.delivery === 'cancelled'; }
        catch { return true; }
      },
      getRun: runId => options.store.getRun(runId),
      launchPty: async (session, project, spec) => {
        const current = options.store.getSession(session.id);
        const currentProject = options.store.getProject(current.projectId);
        await assertTaskWorkspaceAvailable(currentProject);
        if (current.projectId !== project.id || currentProject.cwd !== project.cwd || spec.cwd !== project.cwd) {
          throw new AppError('NATIVE_LAUNCH_CWD_INVALID', 'Native terminal cwd must match the session workspace', 400);
        }
        if (current.archivedAt) throw new AppError('ARCHIVED_SESSION', 'Restore this conversation before opening it', 409);
        return options.terminal.create(currentProject, {
          sessionId: current.id, kind: spec.kind ?? 'native', title: spec.title ?? current.title, ...(spec.reuseLive ? { reuseLive: true } : {}),
          launchSpec: { command: spec.command, args: spec.args, env: spec.env, ...(spec.secretEnv ? { secretEnv: spec.secretEnv } : {}), cwd: spec.cwd, ...(spec.launchMarker ? { launchMarker: spec.launchMarker } : {}) },
        });
      },
      terminal: options.terminal,
      withSessionLock: (sessionId, operation) => options.runtime.withSession(sessionId, () => Promise.resolve(operation())),
      ...(options.riffetMcp ? { riffetMcp: options.riffetMcp } : {}),
      ...(options.standing ? { standing: options.standing } : {}),
      withDetachedSessionLock: (sessionId, operation) => options.runtime.withDetachedSession(sessionId, () => Promise.resolve(operation())),
    };
    this.catalog = new BackendCatalog(options.registry, this.host, { profiles: options.profiles, defaultProfileId: options.defaultProfileId }, session => this.resolveSync(session).profile);
    this.admin = new BackendAdmin(options.registry, this.host, this.catalog);
  }

  backendId(session: Session): NativeBackendId { return backendIdOf(session); }

  /** New input is refused with `NATIVE_BACKEND_UNAVAILABLE` (503, with the reason) when the session's backend has no driver, instead of queuing a run that cannot start. */
  assertAvailable(session: Session): void { this.registry.require(backendIdOf(session)); }

  /**
   * How the terminal service reads the panes of the backend behind a terminal: found through its
   * session, or through the backend a reservation names. None for a shell, a login or a backend that is gone.
   */
  terminalBehaviour(target: { sessionId?: string; backendId?: NativeBackendId }): TerminalBehaviour | undefined {
    let backendId = target.backendId;
    if (!backendId && target.sessionId) {
      try { backendId = this.options.store.getSession(target.sessionId).backendId; } catch { return undefined; }
    }
    return backendId ? this.registry.get(backendId)?.terminal : undefined;
  }

  /**
   * Why a backend has no driver, or undefined while one is registered. Reads that the journal can serve on
   * its own use this to carry on without the driver instead of failing.
   */
  private unavailable(backendId: NativeBackendId): AppError | undefined {
    try { this.registry.require(backendId); return undefined; }
    catch (error) {
      if (error instanceof AppError && error.code === 'NATIVE_BACKEND_UNAVAILABLE') return error;
      throw error;
    }
  }

  /**
   * A backend was withdrawn (its plugin turned off): observation of its sessions ends and what this service
   * cached for them is dropped. A reader still listening is told the session is offline and why. Nothing
   * is stopped: the native process may outlive this server and is picked up again when the backend returns.
   */
  detachBackend(backendId: NativeBackendId): void {
    const reason = this.unavailable(backendId)?.message ?? `Native backend ${backendId} is not available`;
    for (const [sessionId, watch] of [...this.watches]) {
      if (watch.driver.id !== backendId) continue;
      const status = this.withOutputRate(sessionId, { phase: 'offline', connection: { state: 'failed', message: reason } });
      for (const listener of [...watch.controlListeners]) { try { listener({ type: 'status', status }); } catch { /* one reader does not stop the others */ } }
      this.releaseWatch(sessionId, watch);
    }
    for (const [sessionId, selected] of [...this.sessionProfiles]) if (selected.driver.id === backendId) this.sessionProfiles.delete(sessionId);
  }

  /**
   * A backend was registered (its plugin turned on, or finished starting): whoever follows its conversations through
   * `watchControl` (sync streams, the dispatcher) gets a watch on the new driver and its status, instead of staying
   * on the one that was released when the backend went away, or on none when it was not there yet.
   */
  attachBackend(backendId: NativeBackendId): void {
    if (this.closed) return;
    // The journal reads these conversations through the new driver too, not the one released with the old activation.
    this.ingest?.reopen(sessionId => {
      try {
        const session = this.options.store.getSession(sessionId);
        return session.kind === 'native' && this.backendId(session) === backendId;
      } catch { return false; }
    });
    for (const [sessionId, readers] of [...this.controlReaders]) {
      if (!readers.size) continue;
      try {
        const session = this.options.store.getSession(sessionId);
        if (session.kind !== 'native' || this.backendId(session) !== backendId) continue;
        const { driver, profile } = this.armControl(session);
        // A driver that reports through `observe` says so itself; one that keeps a status is read now. Readers were told "offline" already.
        const status = driver.status(this.host, session, profile);
        if (status.phase !== 'offline') this.broadcast(sessionId, { type: 'status', status });
      } catch (error) {
        console.warn(`[riffet] ${backendId}: re-attaching ${sessionId} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** Whether the backend's plugin is still on its way, so queued work for it waits instead of failing (the dispatcher asks). */
  backendPending(backendId: string): boolean {
    return isNativeBackendId(backendId) && this.registry.isPending(backendId);
  }

  private controlSet(sessionId: string): Set<(message: ControlMessage) => void> {
    let readers = this.controlReaders.get(sessionId);
    if (!readers) this.controlReaders.set(sessionId, readers = new Set());
    return readers;
  }

  /** The watch a reader needs, with the terminal pump when the conversation's dialogs can only be read from its screen. */
  private armControl(session: Session): { driver: NativeBackendDriver; profile: NativeBackendProfileConfig } {
    session = this.catalog.currentSession(session);
    const selected = this.resolveSync(session);
    this.ensureWatch(session, selected.driver, selected.profile);
    this.scheduleWatchRelease(session.id);
    if (this.watchesTerminalDialogs(session)) {
      this.terminalDialogs.watch(session.id, () => this.options.store.getSession(session.id), () => this.publishStatus(session.id, selected.driver, selected.profile));
    }
    return selected;
  }

  async assertSessionReferences(session: Pick<Session, 'backendId' | 'backendProfileId'>): Promise<void> {
    const capabilities = await this.catalog.capabilitiesFor(session.backendId ?? 'cursor', session.backendProfileId);
    if (!capabilities.supportsSessionReferences) throw new AppError('SESSION_REFERENCES_UNSUPPORTED', 'This agent cannot read session references', 409);
  }

  async rename(session: Session): Promise<void> {
    const { driver, profile } = await this.resolve(session);
    await driver.rename?.(this.host, session, profile);
  }

  private async resolve(session: Session, requestedProfileId?: string): Promise<{ driver: NativeBackendDriver; profile: NativeBackendProfileConfig }> {
    const backendId = this.backendId(session);
    const cached = this.sessionProfiles.get(session.id);
    const selectedProfileId = requestedProfileId ?? session.backendProfileId;
    if (backendId !== 'pi' && cached && cached.driver.id === backendId && (!selectedProfileId || cached.profile.id === selectedProfileId)) return cached;
    const driver = this.registry.require(backendId);
    const all = this.catalog.profiles(driver);
    const wanted = requestedProfileId ?? session.backendProfileId ?? this.options.defaultProfileId?.(backendId);
    const profile = (wanted ? all.find(item => item.id === wanted) : undefined)
      ?? all.find(item => item.isDefault)
      ?? all[0];
    if (!profile) throw new AppError('NATIVE_PROFILE_UNAVAILABLE', 'No profile is configured for ' + driver.label, 503, { backendId });
    if (profile.backendId !== backendId) throw new AppError('INVALID_BACKEND_PROFILE', 'Profile belongs to a different native backend', 400);
    if (wanted && profile.id !== wanted) throw new AppError('NATIVE_PROFILE_NOT_FOUND', 'Profile ' + wanted + ' is not configured for ' + driver.label, 404, { backendId });
    return { driver, profile };
  }

  private resolveSync(session: Session): { driver: NativeBackendDriver; profile: NativeBackendProfileConfig } {
    const cached = this.sessionProfiles.get(session.id);
    const backendId = this.backendId(session);
    const selectedProfileId = session.backendProfileId;
    if (backendId !== 'pi' && cached && cached.driver.id === backendId && (!selectedProfileId || cached.profile.id === selectedProfileId)) return cached;
    const driver = this.registry.require(backendId);
    const all = this.catalog.profiles(driver);
    const wanted = session.backendProfileId ?? this.options.defaultProfileId?.(backendId);
    const profile = (wanted ? all.find(item => item.id === wanted) : undefined) ?? all.find(item => item.isDefault) ?? all[0];
    if (!profile) throw new AppError('NATIVE_PROFILE_UNAVAILABLE', 'No profile is configured for ' + driver.label, 503, { backendId });
    if (wanted && profile.id !== wanted) throw new AppError('NATIVE_PROFILE_NOT_FOUND', 'Profile ' + wanted + ' is not configured for ' + driver.label, 404, { backendId });
    return { driver, profile };
  }

  private bindProfile(session: Session, driver: NativeBackendDriver, profile: NativeBackendProfileConfig): void {
    // An in-flight open/configure can finish after settings were saved. Its old snapshot must not
    // overwrite the desired settings; Codex keeps the actual launch snapshot inside its runtime.
    if (driver.id === 'codex' || driver.id === 'traex') {
      profile = this.catalog.profiles(driver).find(item => item.id === profile.id) ?? profile;
    }
    this.sessionProfiles.set(session.id, { driver, profile });
  }

  /**
   * A provider was deleted: sessions resolved against it must not keep running on its endpoint
   * and key from this cache. Their next resolve re-reads the profile list and fails as not found.
   */
  forgetProfile(backendId: NativeBackendId, profileId: string): void {
    for (const [sessionId, selected] of this.sessionProfiles) {
      if (selected.driver.id === backendId && selected.profile.id === profileId) this.sessionProfiles.delete(sessionId);
    }
  }

  /** Refresh desired Codex launch settings while its runtime retains the actual launch identity. */
  refreshProfile(backendId: NativeBackendId, profileId: string): void {
    if (backendId !== 'codex' && backendId !== 'traex') return;
    const driver = this.registry.require(backendId);
    const profile = this.catalog.profiles(driver).find(item => item.id === profileId);
    if (!profile) return;
    for (const [sessionId, selected] of this.sessionProfiles) {
      if (selected.driver.id !== backendId || selected.profile.id !== profileId) continue;
      const session = this.options.store.getSession(sessionId);
      this.bindProfile(session, driver, profile);
      // Profile edits do not replace the native thread, its child activity or its observers.
      const watch = this.watches.get(sessionId);
      if (watch) watch.profile = profile;
      this.publishStatus(sessionId, driver, profile);
    }
    this.catalog.invalidateModelCatalogs();
  }

  /** Whether this session's backend accepts the first user message as a launch argument. */
  async supportsInitialPromptArgs(session: Session): Promise<boolean> {
    const { driver, profile } = await this.resolve(session);
    return (await this.catalog.driverCapabilities(driver, profile)).supportsInitialPromptArgs === true;
  }

  /** Whether this session's backend replaces its running turn with a new message on its own (`sendRun` with `now`). */
  async supportsSendNow(session: Session): Promise<boolean> {
    const { driver } = await this.resolve(session);
    return driver.sendsNow === true;
  }

  async supportsSteer(session: Session): Promise<boolean> {
    const { driver, profile } = await this.resolve(session);
    return Boolean(driver.steer && (await this.catalog.driverCapabilities(driver, profile)).supportsSteer);
  }

  async ensure(session: Session, options: NativeBackendOpenOptions = {}): Promise<NativeBackendOpenResult & { session: Session; terminal?: TerminalInfo }> {
    return this.options.runtime.withSession(session.id, async () => {
      let current: Session = this.options.store.getSession(session.id);
      if (current.kind !== 'native') throw new AppError('NOT_NATIVE', 'Only native sessions use native backends', 409);
      if (current.archivedAt) throw new AppError('ARCHIVED_SESSION', 'Restore this conversation before running it', 409);
      if (current.terminalHold) throw sessionInTerminal();
      const { driver, profile } = await this.resolve(current);
      await this.assertNotHeldElsewhere(current, driver, profile);
      await prepareSource(profile.config);
      try {
        const project = this.options.store.getProject(current.projectId);
        await assertTaskWorkspaceAvailable(project);
        const opened = await driver.openOrResume(this.host, current, project, profile, options);
        current = this.options.store.getSession(current.id);
        if (opened.nativeSessionId && opened.nativeSessionId !== current.nativeSessionId) current = this.host.setNativeSessionId(current.id, opened.nativeSessionId);
        if (opened.terminalId && opened.terminalId !== current.terminalId) current = this.options.store.updateSession(current.id, { terminalId: opened.terminalId });
        // A successful explicit open binds this session to the profile that created its runtime.
        // Metadata-only profile resolution deliberately does not populate this cache.
        this.bindProfile(current, driver, profile);
        const watch = this.ensureWatch(current, driver, profile);
        current = this.options.store.getSession(current.id);
        const status = opened.status ?? driver.status(this.host, current, profile);
        if (status.phase !== 'offline') {
          // A start can be reported `starting` by the driver: it is the derived state, not a forced `running`.
          const state = deriveSessionState({ current: current.state, phase: status.phase, runningSubagents: activeSubagents(watch) });
          current = this.options.store.updateSession(current.id, sessionStatePatch(current, state));
          this.broadcast(current.id, { type: 'status', status });
        }
        this.scheduleWatchRelease(current.id);
        const terminal = opened.terminalId ? await this.options.terminal.get(opened.terminalId).catch(() => undefined) : undefined;
        return { ...opened, status: this.withOutputRate(current.id, status), session: current, ...(terminal ? { terminal } : {}) };
      } catch (error) {
        // The caller refused the spawn before anything started; that is not a failed session.
        if (error instanceof AppError && error.code === 'NATIVE_LAUNCH_ABORTED') throw error;
        const message = error instanceof Error ? error.message : 'Native backend could not start';
        this.options.store.updateSession(current.id, sessionStatePatch(current, deriveSessionState({ current: current.state, startError: true }), message));
        throw error;
      }
    });
  }

  /**
   * A provider process of ours reported on a conversation nothing here has open (the server was restarted
   * under a live CLI). Opens the conversation's watch, which attaches to the running provider without
   * launching one, so the report can be routed. False when no conversation of this backend has that id.
   */
  async wakeNativeSession(backendId: NativeBackendId, nativeSessionId: string): Promise<boolean> {
    if (this.closed) return false;
    const session = this.options.store.listSessions().find(item => item.kind === 'native' && item.backendId === backendId
      && item.nativeSessionId === nativeSessionId && !item.archivedAt && Boolean(item.terminalId));
    if (!session) return false;
    const { driver, profile } = await this.resolve(session);
    this.ensureWatch(session, driver, profile);
    this.scheduleWatchRelease(session.id);
    return true;
  }

  private ensureWatch(session: Session, driver: NativeBackendDriver, profile: NativeBackendProfileConfig): BackendWatch {
    if (driver.id === 'codex' || driver.id === 'traex') profile = this.resolveSync(session).profile;
    const existing = this.watches.get(session.id);
    if (existing && existing.driver === driver && sameProfileConfig(existing.profile, profile) && existing.nativeSessionId === session.nativeSessionId) return existing;
    if (this.closed) throw new AppError('NATIVE_BACKENDS_CLOSED', 'Native backend service is shutting down', 503);
    // A persisted native id/terminal means this watch may attach to an existing provider runtime;
    // keep that runtime's profile stable. A new, still-cold session remains free to pick up later
    // profile edits until its first successful open/send.
    if (session.nativeSessionId || session.terminalId) this.bindProfile(session, driver, profile);
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
      watch.unsubscribe = driver.subscribe(this.host, session, profile, message => this.broadcast(session.id, message));
    } catch (error) {
      this.watches.delete(session.id);
      throw error;
    }
    return watch;
  }

  /**
   * A provider watch is held while a stream listens to it (a sync stream or the dispatcher's receipt
   * observer) or the session has an unfinished run. Anything else — an explicit open, a send — only
   * borrows it: it lapses after an idle TTL, re-armed by each use.
   */
  private scheduleWatchRelease(sessionId: string): void {
    const watch = this.watches.get(sessionId);
    if (!watch || this.closed) return;
    if (watch.releaseTimer) clearTimeout(watch.releaseTimer);
    watch.releaseTimer = undefined;
    this.follow(sessionId);
    if (listened(watch)) return;
    watch.releaseTimer = setTimeout(() => {
      watch.releaseTimer = undefined;
      if (this.closed || this.watches.get(sessionId) !== watch) return;
      if (this.hasUnfinishedRun(sessionId) || this.providerLive(sessionId)) this.scheduleWatchRelease(sessionId);
      else if (!listened(watch)) this.releaseWatch(sessionId, watch);
    }, this.options.watchIdleMs ?? WATCH_IDLE_MS);
    watch.releaseTimer.unref();
  }

  /**
   * The watch is also what writes provider state back to the session. A busy session, or one whose
   * CLI still runs in a terminal (a turn can start there without any run), keeps it so the sidebar and
   * notifications still follow it; Cursor has its own sweep for that and only needs the run rule.
   */
  private providerLive(sessionId: string): boolean {
    try {
      const session = this.options.store.getSession(sessionId);
      // Detached children keep their observation/ingest alive without making the foreground
      // session running. This is independent of streams, unfinished parent runs or a TUI.
      if (this.watches.get(sessionId)?.runningSubagents.size) return true;
      if (['starting', 'running', 'waiting', 'cancelling'].includes(session.state)) return true;
      if (this.catalog.traits(this.backendId(session)).ownsSessionObservation || !session.terminalId) return false;
      return this.options.store.getTerminal(session.terminalId).state === 'running';
    } catch { return false; }
  }

  private liveNativeTerminal(session: Session): boolean {
    try {
      const item = this.options.store.getTerminal(session.terminalId!);
      return item.sessionId === session.id && item.projectId === session.projectId && item.kind === 'native' && item.state !== 'exited';
    } catch { return false; }
  }

  /** Whether a stream (a client's conversation view or the dispatcher) is listening to this conversation now. */
  hasListeners(sessionId: string): boolean {
    const watch = this.watches.get(sessionId);
    return Boolean(watch && listened(watch));
  }

  /**
   * Keeps a watched conversation's journal current for every reader — sync streams, the dispatcher, the
   * index — once someone listens to it or it may be running, whether or not a sync stream is open; until
   * its watch is released. A turn typed into the CLI is read this way too.
   */
  private follow(sessionId: string): void {
    if (!this.ingest || this.closed || this.following.has(sessionId)) return;
    const watch = this.watches.get(sessionId);
    if (!watch || !(listened(watch) || this.hasUnfinishedRun(sessionId) || this.providerLive(sessionId))) return;
    this.following.set(sessionId, this.ingest.follow(sessionId));
  }

  private unfollow(sessionId: string): void {
    const release = this.following.get(sessionId);
    this.following.delete(sessionId);
    release?.();
  }

  private hasUnfinishedRun(sessionId: string): boolean {
    try { return this.options.store.listUnfinishedNativeRuns(sessionId).length > 0; }
    catch { return false; }
  }

  /** Stops observing without disposing the provider runtime; the next reader starts a new watch. */
  private releaseWatch(sessionId: string, watch: BackendWatch): void {
    if (watch.releaseTimer) clearTimeout(watch.releaseTimer);
    watch.releaseTimer = undefined;
    try { watch.unsubscribe(); } catch { /* release continues */ }
    if (this.watches.get(sessionId) === watch) { this.watches.delete(sessionId); this.unfollow(sessionId); }
    this.dropIdleReaders(sessionId);
    this.terminalDialogs.release(sessionId);
  }

  /** The set of readers of a conversation is kept while it has one or a watch holds it. */
  private dropIdleReaders(sessionId: string): void {
    if (!this.watches.has(sessionId) && !this.controlReaders.get(sessionId)?.size) this.controlReaders.delete(sessionId);
  }

  /**
   * Sync v3's ingest, which reads conversations through this service and so is made after it. From here
   * on drivers can end turns on the journal (`host.transcript`), and live conversations are followed.
   */
  attachIngest(ingest: TranscriptIngest): void {
    this.ingest = ingest;
    this.host.transcript = {
      drain: sessionId => ingest.drain(sessionId),
      endTurn: (sessionId, turnId, status, at, error) => ingest.endTurn(sessionId, turnId, status, at, error),
      withSource: (sessionId, task) => ingest.control(sessionId, task),
      wake: sessionId => ingest.wake(sessionId),
    };
  }

  /** Reads what the conversation's CLI has written so far into its journal, after any read in flight (G6). Never rejects. */
  drainTranscript(sessionId: string): Promise<void> {
    return this.ingest?.drain(sessionId) ?? Promise.resolve();
  }

  /** No openOrResume, ensure or terminal write: unsupported proof is simply unavailable. */
  async canReleaseInput(session: Session, run: Run): Promise<boolean> {
    const { driver, profile } = this.resolveSync(session);
    return await driver.canReleaseInput?.(this.host, session, profile, run) ?? false;
  }

  /** The conversation's transcript as the journal reads it (sync v3), or undefined while its backend has none. */
  transcriptSource(sessionId: string): TranscriptSource | undefined {
    const session = this.options.store.getSession(sessionId);
    if (session.kind !== 'native') return undefined;
    // A withdrawn backend's conversations are served from what the journal already holds.
    if (this.unavailable(this.backendId(session))) return undefined;
    const { driver, profile } = this.resolveSync(session);
    return driver.transcript?.(this.host, session, profile);
  }

  /**
   * The control path (docs/SYNC-V3.md): what the provider reports outside the transcript, as it reports
   * it, while the provider watch is held for `listener`. It opens with nothing; `status` and `context`
   * read what holds now. A driver that owns the conversation never reports its terminal's startup
   * screens, so while someone watches, that terminal is read and its status republished on any change.
   */
  watchControl(sessionId: string, listener: (message: ControlMessage) => void): { status(): NativeStatus; context(): NativeContext | undefined; close(): void } {
    const session = this.options.store.getSession(sessionId);
    const readers = this.controlSet(sessionId);
    // With its backend withdrawn (or not there yet) the reader is only recorded: the conversation is read from its
    // journal meanwhile, and `attachBackend` gives the reader a watch when the backend returns.
    if (!this.unavailable(this.backendId(session))) {
      try { this.armControl(session); }
      catch (error) { this.dropIdleReaders(sessionId); throw error; }
    }
    let closed = false;
    const relay = (message: ControlMessage) => { if (!closed) listener(message); };
    readers.add(relay);
    return {
      // Resolved at every call: the driver behind a conversation can be replaced while this reader is open.
      status: () => {
        const stored = this.options.store.getSession(sessionId);
        const current = this.catalog.currentSession(stored);
        const missing = this.unavailable(this.backendId(current));
        if (missing) return this.withOutputRate(sessionId, { phase: 'offline', connection: { state: 'failed', message: missing.message } });
        let selected: { driver: NativeBackendDriver; profile: NativeBackendProfileConfig } | undefined;
        try {
          selected = current !== stored ? this.resolveSync(current) : this.watches.get(sessionId) ?? this.resolveSync(current);
          return this.withOutputRate(sessionId, this.terminalDialogs.merge(current, selected.driver.status(this.host, current, selected.profile)));
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
        if (!watch || !listened(watch)) this.terminalDialogs.release(sessionId);
        this.scheduleWatchRelease(sessionId);
        this.dropIdleReaders(sessionId);
      },
    };
  }

  /**
   * The provider reports its context window only while it runs (Claude Code only on its status line),
   * so the last report is kept with the chat it describes; a restarted server or a reopened
   * conversation shows it until the provider reports again.
   */
  private saveContext(sessionId: string, context: NativeContext | undefined): void {
    try {
      const session = this.options.store.getSession(sessionId);
      const chat = session.nativeSessionId;
      if (chat) this.options.store.saveNativeContext(sessionId, chat, context);
    } catch { /* a deleted session */ }
  }

  private savedContext(sessionId: string): NativeContext | undefined {
    try {
      const session = this.options.store.getSession(sessionId);
      const chat = session.nativeSessionId;
      return chat ? this.options.store.getNativeContext(sessionId, chat) : undefined;
    } catch { return undefined; }
  }

  /** Republish the full driver status when a terminal dialog or recent output sample changes. */
  private publishStatus(sessionId: string, driver: NativeBackendDriver, profile: NativeBackendProfileConfig): void {
    const stored = this.options.store.getSession(sessionId);
    const session = this.catalog.currentSession(stored);
    if (session !== stored) profile = this.resolveSync(session).profile;
    if (session.archivedAt) return;
    let status: NativeStatus;
    try { status = driver.status(this.host, session, profile); }
    catch (error) { status = { phase: 'offline', connection: { state: 'failed', message: safeBackendReason(error instanceof Error ? error.message : 'Native backend status is unavailable', profile) } }; }
    this.broadcast(sessionId, { type: 'status', status });
  }

  private broadcast(sessionId: string, message: NativeControlMessage): void {
    if (this.closed) return;
    if (message.type === 'job') { this.noteJob(sessionId, message.job); return; }
    // What a driver wrote to the record reaches whoever follows the conversation (sync streams) as the store's own news.
    if (message.type === 'session') { try { this.options.store.appendEvent(sessionId, 'session', { session: message.session }); } catch { /* a deleted session */ } return; }
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
    // An empty frame says "nothing to report", which a fresh subscription also replays before the
    // provider has measured anything (Droid, Cursor). Only one that follows a report withdraws it,
    // so a restart's empty replay does not erase the value saved for exactly that case.
    if (message.type === 'context' && (message.context || watch?.context)) this.saveContext(sessionId, message.context);
    if (watch) {
      if (message.type === 'subagent') {
        if (message.running === true) watch.runningSubagents.set(message.toolCallId, message.agentId);
        else if (message.running === false || watch.runningSubagents.get(message.toolCallId) !== message.agentId) watch.runningSubagents.delete(message.toolCallId);
      }
      if (message.type === 'status') watch.status = message.status;
      if (message.type === 'context') watch.context = message.context;
    }
    // One read serves the whole status path; the session is only needed when a status is in play.
    const loaded = message.type === 'status' || (message.type === 'subagent' && watch) ? this.options.store.getSession(sessionId) : undefined;
    if (watch && loaded && watch.nativeSessionId !== loaded.nativeSessionId && loaded.nativeSessionId) {
      // The provider moved to another chat: what was running or reported belonged to the old one.
      watch.runningSubagents.clear();
      watch.nativeSessionId = loaded.nativeSessionId;
      this.jobs.delete(sessionId);
    }
    const rawStatus = message.type === 'status' ? message.status
      : watch && loaded ? watch.status ?? watch.driver.status(this.host, loaded, watch.profile) : undefined;
    let delivered: NativeControlMessage = message;
    let statusSession: Session | undefined;
    if (rawStatus && loaded && !this.catalog.traits(this.backendId(loaded)).ownsSessionObservation) {
      const current = loaded;
      // A dialog lifted from the CLI's own screen rides the driver's status; a protocol request
      // the driver already reported always wins (see TerminalDialogObserver.merge).
      const status = this.terminalDialogs.merge(current, rawStatus);
      if (message.type === 'status') delivered = { type: 'status', status };
      const targetState = deriveSessionState({
        current: current.state, phase: status.phase, runningSubagents: activeSubagents(watch),
        terminalLive: Boolean(current.terminalId && this.liveNativeTerminal(current)),
      });
      const patch = sessionStatePatch(current, targetState);
      if (!current.archivedAt && (current.state !== targetState || (targetState !== 'failed' && current.error))) {
        statusSession = this.options.store.updateSession(sessionId, patch);
        this.options.store.appendEvent(sessionId, 'session', { session: statusSession });
        // A conversation that started running (in its terminal, say) is read from now on.
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

  /** The conversation's background jobs as its provider last reported them, for the timeline's tool rows. */
  listJobs(sessionId: string): NativeJob[] { return [...this.jobs.get(sessionId)?.values() ?? []]; }

  onJobChanged(listener: (sessionId: string, job: NativeJob) => void): () => void {
    this.jobListeners.add(listener);
    return () => { this.jobListeners.delete(listener); };
  }

  /** Hears what a driver sends outside its transcript (`host.emitEvent`) for this conversation. */
  watchEvents(sessionId: string, listener: (event: NativeWorkbenchEvent) => void): () => void {
    let listeners = this.eventListeners.get(sessionId);
    if (!listeners) this.eventListeners.set(sessionId, listeners = new Set());
    listeners.add(listener);
    return () => { listeners.delete(listener); if (!listeners.size && this.eventListeners.get(sessionId) === listeners) this.eventListeners.delete(sessionId); };
  }

  /**
   * What the service reads of the journal: tool calls of every lane for statistics (but a backend that
   * keeps its own, Cursor).
   */
  readJournal(feed: JournalFeed): () => void {
    return feed.subscribe(() => true, batch => {
      const events = batch.items.flatMap(item => 'event' in item ? [item.event] : []);
      const turnStarted = batch.lane === 'main' && batch.items.some(item => 'mark' in item && (item.mark.edge === 'started' || item.mark.edge === 'reopened'));
      if (!events.length && !turnStarted) return;
      // An activity that changed, or a turn that opened in the journal while the watch was not yet busy, refreshes the status.
      const watch = batch.lane === 'main' ? this.watches.get(batch.sessionId) : undefined;
      if (watch && listened(watch) && ( events.some(event => activityOfEvent(event))
        || ((turnStarted || events.some(event => event.type === 'agent_message_chunk' || event.type === 'agent_thought_chunk' || event.type === 'tool_call'))
          && watch.status?.phase !== 'busy' && watch.status?.phase !== 'attention') )) {
        try { this.publishStatus(batch.sessionId, watch.driver, watch.profile); } catch { /* a status that cannot be read is the driver's own */ }
      }
      const calls = events.filter(event => event.type === 'tool_call' || event.type === 'tool_call_update');
      if (!calls.length) return;
      try {
        const driver = this.watches.get(batch.sessionId)?.driver;
        const traits = driver ? driver.traits ?? {} : this.catalog.traits(this.backendId(this.options.store.getSession(batch.sessionId)));
        if (!traits.ownsSessionObservation) this.host.stats.observeEvents(batch.sessionId, calls);
      } catch { /* statistics are best-effort */ }
    });
  }

  /** `session` is the conversation as just read, when the caller has it; otherwise it is read here. */
  private outputRateBinding(sessionId: string, session: Session = this.options.store.getSession(sessionId)): string {
    return JSON.stringify([backendIdOf(session), session.nativeSessionId ?? null]);
  }

  /** A status as readers see it: with the recent output rate, and the activity summary the journal holds when the driver has none of its own. */
  private withOutputRate(sessionId: string, status: NativeStatus, session?: Session): NativeStatus {
    const decorated = this.withJournalActivity(sessionId, status);
    const entry = this.outputRates.get(sessionId);
    if (!entry) return { ...decorated, outputRate: EMPTY_OUTPUT_RATE };
    if (entry.binding !== this.outputRateBinding(sessionId, session)) {
      this.outputRates.delete(sessionId);
      return { ...decorated, outputRate: EMPTY_OUTPUT_RATE };
    }
    return { ...decorated, outputRate: entry.tracker.sample() };
  }

  /**
   * The live activities of the main lane's ledger (G10), summarized on a status whose driver reports none:
   * a backend whose activities only its transcript tells of (DSH's background jobs) is read from the journal.
   */
  private withJournalActivity(sessionId: string, status: NativeStatus): NativeStatus {
    if (status.activity || !this.ingest || !this.following.has(sessionId)) return status;
    const writer = this.ingest.writer(sessionId);
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
        // Prune expired segments even when nobody is listening. A quiet, open session retains
        // only its last-signal state, not an ever-growing history of token events.
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

  /**
   * The transcript of one conversation, for the search index only.
   *
   * Returns nothing unless the provider declares that its complete transcript read
   * (`readShareTranscript`) only reads its own stored files: a search may read such a conversation
   * speculatively, and typing in a search box must never start an agent.
   */
  async contextTranscript(sessionId: string, maxBytes: number, signal: AbortSignal): Promise<NativeWorkbenchEvent[] | undefined> {
    const session = this.options.store.getSession(sessionId);
    const { driver, profile } = this.resolveSync(session);
    return driver.stored?.context?.(this.host, session, profile, { maxBytes, signal });
  }

  async indexableTranscript(sessionId: string): Promise<WorkbenchEvent[]> {
    const session = this.options.store.getSession(sessionId);
    if (this.unavailable(this.backendId(session))) return [];
    const { driver, profile } = await this.resolve(session);
    if (!driver.stored?.readOnly || !driver.stored?.share) return [];
    return (await driver.stored.share(this.host, session, profile, { messagesOnly: true })).events;
  }

  /** Settled usage from the provider's stored transcript; `null` when the backend cannot backfill. */
  async usageTranscript(sessionId: string, known?: string): Promise<UsageTranscript | undefined | null> {
    const session = this.options.store.getSession(sessionId);
    if (this.unavailable(this.backendId(session))) return null;
    const { driver, profile } = await this.resolve(session);
    if (!driver.stored?.usage) return null;
    return driver.stored.usage(this.host, session, profile, known);
  }

  usageTranscriptBackendIds(): NativeBackendId[] {
    return this.registry.list().filter((driver) => driver.stored?.usage).map((driver) => driver.id);
  }

  /**
   * Every profile that can list the provider's stored conversations, one per place they are kept
   * (`continuationKey`), so two profiles reading the same directory list it once.
   */
  externalSessionSources(): Array<{ backendId: NativeBackendId; profileId: string; list(options: ExternalSessionScan): Promise<ExternalSessionEntry[]> }> {
    const sources: Array<{ backendId: NativeBackendId; profileId: string; list(options: ExternalSessionScan): Promise<ExternalSessionEntry[]> }> = [];
    for (const driver of this.registry.list()) {
      if (!driver.external?.list) continue;
      const seen = new Set<string>();
      const profiles = this.catalog.profiles(driver);
      // The default profile first: a conversation both could continue is imported under it.
      for (const profile of [...profiles.filter(item => item.isDefault), ...profiles.filter(item => !item.isDefault)]) {
        const key = driver.continuationKey?.(profile) ?? profile.id;
        if (seen.has(key)) continue;
        seen.add(key);
        sources.push({ backendId: driver.id, profileId: profile.id, list: options => driver.external!.list!(this.host, profile, options) });
      }
    }
    return sources;
  }

  /**
   * The provider thread may be held by a CLI outside Riffet (the user's own terminal): launching ours
   * on it too would interleave two writers in one transcript. Asked only when this conversation has no
   * live CLI of its own, which would be the holder; so any process found, even one in a Riffet terminal
   * (a shell there, an orphan), is a second writer.
   */
  private async assertNotHeldElsewhere(session: Session, driver: NativeBackendDriver, profile: NativeBackendProfileConfig): Promise<void> {
    if (!session.nativeSessionId || !driver.external?.holder) return;
    if (this.liveTerminalOf(session)) return;
    const holder = await driver.external.holder(this.host, profile, session.nativeSessionId).catch(() => undefined);
    if (holder) {
      throw new AppError('NATIVE_SESSION_HELD_EXTERNALLY', 'This conversation is open in a terminal outside Riffet; exit it there first', 409, { pid: holder.pid, ...(holder.status ? { status: holder.status } : {}) });
    }
  }

  /** The command that continues this conversation in a terminal of the reader's own; starts nothing. */
  async resumeCommand(session: Session): Promise<{ nativeSessionId: string; command: string; credentialsOmitted: boolean }> {
    const { driver, profile } = await this.resolve(session);
    if (!driver.external?.resumeCommand) throw new AppError('TERMINAL_RESUME_UNSUPPORTED', driver.label + ' cannot be continued in a terminal', 409);
    if (!session.nativeSessionId) throw new AppError('NATIVE_SESSION_NOT_STARTED', 'This conversation has not started yet', 409);
    const { argv, env, credentialsOmitted } = driver.external.resumeCommand(session, profile);
    const project = this.options.store.getProject(session.projectId);
    const assignments = Object.entries(env).map(([name, value]) => `${name}=${shellWord(value)}`);
    return {
      nativeSessionId: session.nativeSessionId,
      command: `cd ${shellWord(project.cwd)} && ${[...assignments, ...argv.map(shellWord)].join(' ')}`,
      credentialsOmitted: Boolean(credentialsOmitted),
    };
  }

  /**
   * Stops this conversation's own CLI so one the reader starts in a terminal is the only writer. A
   * later launch here is then refused while that terminal CLI runs (`assertNotHeldElsewhere`).
   */
  async stopOwnCli(session: Session): Promise<void> {
    await this.dispose(session.id);
    const terminal = this.liveTerminalOf(this.options.store.getSession(session.id));
    if (terminal) await this.options.terminal.stop(terminal.id);
  }

  /**
   * Hands the conversation to a terminal: returns how to launch its CLI there after stopping Riffet's own.
   * The caller holds the session lock and records the hold.
   */
  async releaseToTerminal(session: Session): Promise<NativePtyLaunchSpec> {
    const { driver, profile } = await this.resolve(session);
    if (!driver.external?.terminalLaunch) throw new AppError('TERMINAL_RESUME_UNSUPPORTED', driver.label + ' cannot be continued in a terminal', 409);
    if (!session.nativeSessionId) throw new AppError('NATIVE_SESSION_NOT_STARTED', 'Send a message first; this conversation has nothing to continue yet', 409);
    await this.assertNotHeldElsewhere(session, driver, profile);
    const project = this.options.store.getProject(session.projectId);
    const { spec, keepsRuntime } = await driver.external.terminalLaunch(this.host, session, project, profile);
    if (!keepsRuntime) await this.dispose(session.id);
    const current = this.options.store.getSession(session.id);
    const terminal = this.liveTerminalOf(current);
    if (terminal) await this.options.terminal.stop(terminal.id);
    return spec;
  }

  private liveTerminalOf(session: Session): TerminalInfo | undefined {
    if (!session.terminalId) return undefined;
    try {
      const terminal = this.options.store.getTerminal(session.terminalId);
      return terminal.state === 'exited' ? undefined : terminal;
    } catch { return undefined; }
  }

  /** Keeps the timeline following a terminal that holds the conversation; a no-op for a backend whose runtime stays live. */
  followExternal(session: Session): () => void {
    const { driver, profile } = this.resolveSync(session);
    return driver.external?.follow?.(this.host, session, profile) ?? (() => undefined);
  }

  /** The backends a request can reach now (enabled plugins' included), in registry order. */
  offeredBackendIds(): NativeBackendId[] {
    return this.registry.list().map((driver) => driver.id);
  }

  /** Providers whose transcripts may be read speculatively, for the index to fill in the background. */
  readOnlyTranscriptBackendIds(): NativeBackendId[] {
    return this.registry.list().filter((driver) => driver.stored?.readOnly).map((driver) => driver.id);
  }

  async sendRun(session: Session, run: Run, commitDispatchFence: (binding?: NativeDispatchBinding) => Run, options: { now?: boolean; expectedStop?: NativeStopRequest } = {}): Promise<void | { settled: true }> {
    if (!run.native) throw new AppError('NOT_NATIVE_RUN', 'Only native runs can be dispatched', 409);
    await assertTaskWorkspaceAvailable(this.options.store.getProject(session.projectId));
    if (run.native.intent === 'steer') throw new AppError('STEER_REJECTED', 'An in-flight instruction must use the steer endpoint.', 409);
    const { driver, profile } = await this.resolve(session);
    await prepareSource(profile.config);
    this.ensureWatch(session, driver, profile);
    this.scheduleWatchRelease(session.id);
    // The configuration the message is delivered with is the one in effect now, not the snapshot the
    // run was accepted with: DSH resolves a selection when the message's step is assembled, and a
    // switch made while a message waited in the queue is meant to govern it. `run.native.config`
    // stays as the record of what was accepted; `resolvedConfig` in the fence records what was used.
    if (run.native.input.references?.length) await this.assertSessionReferences(session);
    const config: NativeRunConfig = {
      ...(session.model !== undefined ? { model: session.model } : {}),
      mode: session.mode,
      ...(session.approval !== undefined ? { approval: session.approval } : {}),
    };
    // A send that replaces a targeted turn re-checks that target before the driver writes, the same
    // guard interrupt installs. The driver calls it again at the write itself.
    const beforeWrite = options.now && options.expectedStop ? this.stopTargetGuard(session.id, driver, profile, options.expectedStop) : undefined;
    beforeWrite?.();
    const outcome = await driver.send(this.host, {
      session, project: this.options.store.getProject(session.projectId), profile,
      commandId: run.commandId, runId: run.id, sourceText: run.native.input.text, input: this.options.prepareContextInput ? await this.options.prepareContextInput(run) : run.native.input, config,
      commitDispatchFence,
      ...(options.now && driver.sendsNow ? { now: true } : {}),
      ...(beforeWrite ? { beforeWrite } : {}),
    });
    const updated = this.options.store.getSession(session.id);
    this.bindProfile(updated, driver, profile);
    this.ensureWatch(updated, driver, profile);
    this.scheduleWatchRelease(session.id);
    return outcome;
  }

  async steerRun(session: Session, run: Run, commitDispatchFence: (binding?: NativeDispatchBinding) => Run): Promise<void | { deferred: true }> {
    if (!run.native || run.native.intent !== 'steer' || !run.native.nativeSessionId || !run.native.nativeTurnId) {
      throw new AppError('STEER_REJECTED', 'An in-flight instruction requires its original turn target.', 409);
    }
    await assertTaskWorkspaceAvailable(this.options.store.getProject(session.projectId));
    const { driver, profile } = await this.resolve(session);
    if (!driver.steer || !(await this.catalog.driverCapabilities(driver, profile)).supportsSteer) throw new AppError('STEER_UNSUPPORTED', 'This backend does not support steering an active turn.', 409);
    if (session.nativeSessionId !== run.native.nativeSessionId) throw new AppError('STEER_TARGET_CHANGED', 'The target conversation changed before delivery.', 409);
    // The driver records the actual target turn configuration, never the next-turn selection.
    if (run.native.input.references?.length) await this.assertSessionReferences(session);
    const result = await driver.steer(this.host, {
      session, project: this.options.store.getProject(session.projectId), profile,
      commandId: run.commandId, runId: run.id, sourceText: run.native.input.text, input: this.options.prepareContextInput ? await this.options.prepareContextInput(run) : run.native.input, config: run.native.config,
      target: { nativeSessionId: run.native.nativeSessionId, turnId: run.native.nativeTurnId },
      commitDispatchFence,
    });
    this.ensureWatch(session, driver, profile);
    this.scheduleWatchRelease(session.id);
    return result;
  }

  commitDispatchFence(runId: string, binding: NativeDispatchBinding = {}): Run {
    return this.options.store.transaction(() => {
      let run = this.options.store.getRun(runId);
      if (!run.native) throw new AppError('NOT_NATIVE_RUN', 'Only native runs can be dispatched', 409);
      const session = this.options.store.getSession(run.sessionId);
      const expectedBackend = session.backendId;
      if (binding.backendId && binding.backendId !== expectedBackend) throw new AppError('NATIVE_BACKEND_CHANGED', 'Backend changed before message delivery', 409);
      if (session.archivedAt || this.host.isRunCancelled(runId)) throw new AppError('RUN_CANCELLED', 'Message was cancelled before delivery', 409);
      if (run.native.intent === 'steer' && (
        run.native.nativeSessionId !== session.nativeSessionId ||
        binding.nativeSessionId !== run.native.nativeSessionId || binding.nativeTurnId !== run.native.nativeTurnId
      )) throw new AppError('STEER_TARGET_CHANGED', 'The target turn changed before delivery.', 409);
      // Deliberately not a configuration check: a queued message is delivered under the settings in
      // effect when it starts (`sendRun` reads the live session), so a switch made while it waited is
      // what governs it. The accepted snapshot stays on `run.native.config`; what the provider really
      // received lands in `resolvedConfig` below.
      if (binding.nativeSessionId && binding.nativeSessionId !== session.nativeSessionId) this.host.setNativeSessionId(session.id, binding.nativeSessionId);
      const changed = this.options.store.transitionNativeRun(runId, ['preparing'], {
        delivery: 'dispatching', stage: 'input', backendId: expectedBackend,
        ...(binding.nativeTurnId ? { nativeTurnId: binding.nativeTurnId } : {}),
        ...(binding.ownerRunId ? { ownerRunId: binding.ownerRunId } : {}),
        ...(binding.terminalId ? { terminalId: binding.terminalId } : session.terminalId ? { terminalId: session.terminalId } : {}),
        ...(binding.terminalEpoch !== undefined ? { terminalEpoch: binding.terminalEpoch } : {}),
        ...(binding.nativeSessionId ? { nativeSessionId: binding.nativeSessionId } : session.nativeSessionId ? { nativeSessionId: session.nativeSessionId } : {}),
        ...(binding.baselineSequence !== undefined ? { baselineSequence: this.journalBaseline(session.id) ?? binding.baselineSequence } : {}),
        ...(binding.renderedText !== undefined ? { renderedText: binding.renderedText } : {}),
        ...(binding.nativeInputBoundary !== undefined ? { nativeInputBoundary: binding.nativeInputBoundary } : {}),
        ...(binding.slashCommand !== undefined ? { slashCommand: binding.slashCommand } : {}),
        ...(binding.resolvedConfig ? { resolvedConfig: binding.resolvedConfig } : {}),
        timings: { ...run.native.timings, dispatchAt: Date.now() },
      });
      if (!changed) throw new AppError('RUN_CANCELLED', 'Message was cancelled before delivery', 409);
      return changed;
    });
  }

  /**
   * Where the dispatcher's receipts start, now that it reads the journal (`dispatch-feed.ts`): the last row of
   * the log serving the main lane. Only an entity first written after it can be the echo of what is sent now.
   */
  private journalBaseline(sessionId: string): number | undefined {
    if (!this.ingest) return undefined;
    const { journal } = this.options.store;
    return journal.peek(servingKey(journal, sessionId, 'main').key)?.lastSeq ?? 0;
  }

  /** Frozen export reads are intentionally outside the watch/status/dispatch machinery. */
  async readShareTranscript(sessionId: string, options?: import('./types.js').NativeShareReadOptions) {
    const session = this.options.store.getSession(sessionId);
    const { driver, profile } = await this.resolve(session);
    if (!driver.stored?.share) throw new AppError('SHARE_HISTORY_UNAVAILABLE', `${driver.label} does not provide a complete read-only transcript`, 409);
    return await driver.stored.share(this.host, session, profile, options);
  }

  /** A driver is bound to the session in this process (`status` has something to read). */
  runtimeSessionIds(): Iterable<string> { return this.sessionProfiles.keys(); }
  hasRuntime(sessionId: string): boolean { return this.sessionProfiles.has(sessionId); }

  ownedForegroundTurn(sessionId: string): (NativeTurnTarget & { ownerRunId: string }) | undefined {
    const status = this.status(sessionId);
    if (status.phase !== 'busy') return undefined;
    const stored = this.options.store.getSession(sessionId);
    const session = this.catalog.currentSession(stored);
    const selected = session !== stored ? this.resolveSync(session) : this.sessionProfiles.get(sessionId);
    if (selected?.driver.ownedForegroundTurn) return selected.driver.ownedForegroundTurn(session);
    const turn = status.activeTurn;
    return turn?.ownerRunId ? { ...turn, ownerRunId: turn.ownerRunId } : undefined;
  }

  status(sessionId: string): NativeStatus {
    const stored = this.options.store.getSession(sessionId);
    const session = this.catalog.currentSession(stored);
    const selected = session !== stored ? this.resolveSync(session) : this.sessionProfiles.get(sessionId);
    if (!selected) return this.withOutputRate(sessionId, { phase: 'offline' });
    return this.withOutputRate(sessionId, this.terminalDialogs.merge(session, selected.driver.status(this.host, session, selected.profile)));
  }

  async capabilities(session: Session) {
    session = this.catalog.currentSession(session);
    const { driver, profile } = await this.resolve(session);
    return this.catalog.driverCapabilities(driver, profile);
  }

  async interaction(session: Session): Promise<NativeInteraction | undefined> {
    // Polled by every open page, so a withdrawn backend simply has nothing waiting.
    if (this.unavailable(this.backendId(session))) return undefined;
    session = this.catalog.currentSession(session);
    const { driver, profile } = await this.resolve(session);
    const driverInteraction = await driver.interaction(this.host, session, profile);
    if (driverInteraction || !this.usesTerminalDialogs(session)) return driverInteraction;
    // No protocol request is open, so the CLI's own screen is the only place a blocking dialog
    // can be. Read it now rather than waiting for the pump: this endpoint answers a fresh page.
    return await this.terminalDialogs.refresh(session);
  }

  async respondInteraction(session: Session, response: NativeInteractionResponse): Promise<NativeInteractionResult> {
    session = this.catalog.currentSession(session);
    const { driver, profile } = await this.resolve(session);
    let terminalAnswer = false;
    const result = await this.options.runtime.withSession(session.id, async () => {
      const current = this.catalog.currentSession(this.options.store.getSession(session.id));
      // Receipts outlive their screen. Retrying a terminal answer must not fall through to the
      // protocol driver or drive the CLI a second time after the dialog has disappeared.
      const replay = this.terminalDialogs.replay(current, response);
      if (replay) return replay;
      if (this.terminalDialogs.ownsInteraction(response.interactionId)) {
        const protocol = await driver.interaction(this.host, current, profile);
        const dialog = this.usesTerminalDialogs(current) ? this.terminalDialogs.current(current) : undefined;
        // Re-check inside the session fence: a protocol request or a changed driver policy may
        // have superseded the screen while this answer waited. Never send that old payload to
        // either the TUI or the protocol responder.
        if (protocol || !dialog || dialog.id !== response.interactionId) {
          return Promise.resolve<NativeInteractionResult>({
            status: 'uncertain', interaction: protocol ?? dialog,
            message: '此终端交互已失效，未发送按键。请同步当前请求或查看终端。',
          });
        }
        terminalAnswer = true;
        return this.terminalDialogs.respond(current, response, async observed => {
          const before = this.catalog.currentSession(this.options.store.getSession(session.id));
          if (!this.usesTerminalDialogs(before) || before.terminalId !== observed.terminalId) return false;
          const selected = this.resolveSync(before);
          if (await selected.driver.interaction(this.host, before, selected.profile)) return false;
          // The driver's read may itself await. Check the binding and synchronous status again
          // after it, at the key/paste boundary, not only before terminal acquisition.
          const latest = this.catalog.currentSession(this.options.store.getSession(session.id));
          if (!this.usesTerminalDialogs(latest) || latest.terminalId !== observed.terminalId) return false;
          if (this.backendId(latest) !== selected.driver.id || latest.backendProfileId !== before.backendProfileId) return false;
          if (selected.driver.status(this.host, latest, selected.profile).interaction) return false;
          return selected.driver.endorsesScreenDialog?.(this.host, latest, observed) ?? true;
        });
      }
      return driver.respond(this.host, current, profile, response);
    });
    const current = this.catalog.currentSession(this.options.store.getSession(session.id));
    if (current.nativeSessionId || current.terminalId) this.bindProfile(current, driver, profile);
    if (terminalAnswer) {
      await this.terminalDialogs.refresh(current).catch(() => undefined);
      // Refresh already updates the cache, so the observer's next tick may see no identity change.
      // Publish here as well: a quiet protocol driver need not emit anything after a TUI answer.
      this.publishStatus(current.id, driver, profile);
    }
    return result;
  }

  async extendInteraction(session: Session, interactionId: string): Promise<NativeInteraction> {
    session = this.catalog.currentSession(session);
    const { driver, profile } = await this.resolve(session);
    if (!driver.extendInteraction) throw new AppError('NATIVE_INTERACTION_NOT_EXTENDABLE', 'This backend does not time out its requests', 409);
    return await driver.extendInteraction(this.host, session, profile, interactionId);
  }

  /**
   * Stops a system activity (a background task). Whether it can be stopped is the driver's call; a
   * backend with no way to stop anything says so, rather than the request silently doing nothing.
   */
  async stopActivity(session: Session, activityId: string): Promise<NativeActivity> {
    session = this.catalog.currentSession(session);
    const { driver, profile } = await this.resolve(session);
    if (!driver.stopActivity) throw new AppError('ACTIVITY_STOP_UNSUPPORTED', 'This backend cannot stop its background tasks from here', 409);
    return await driver.stopActivity(this.host, session, profile, activityId);
  }

  /**
   * Whether a session's blocking screens can only be read from its terminal. Cursor's driver parses
   * its own screen and publishes the result, so folding it in here would double-report every dialog.
   */
  private usesTerminalDialogs(session: Session): boolean {
    return this.watchesTerminalDialogs(session) && Boolean(session.terminalId);
  }

  /** The same question without the terminal binding, for deciding whether to keep reading at all. */
  private watchesTerminalDialogs(session: Session): boolean {
    return !this.catalog.traits(this.backendId(session)).ownsSessionObservation && !session.archivedAt;
  }

  /** Release a provider's pending receipt wait before Stop queues for its session lock. */
  requestInterrupt(sessionId: string): void {
    const session = this.options.store.getSession(sessionId);
    this.registry.require(this.backendId(session)).requestInterrupt?.(this.host, session);
  }

  /**
   * The stop the caller saw, checked again at the write. An absent `terminalEpoch` is not a mismatch:
   * the lease is only compared when the stop captured one. The run's older dispatch-time epoch is not
   * this check — that comparison belongs nowhere in target matching.
   */
  private stopTargetGuard(sessionId: string, driver: NativeBackendDriver, profile: NativeBackendProfileConfig, expected: NativeStopRequest): (allowEnded?: boolean) => void {
    return (allowEnded = false) => {
      const current = this.catalog.currentSession(this.options.store.getSession(sessionId));
      const status = driver.status(this.host, current, profile);
      if ((current.nativeSessionId ?? '') !== expected.nativeSessionId
        || status.activeTurn?.turnId !== expected.turnId && !(allowEnded && !status.activeTurn)
        || status.activeTurn !== undefined && status.activeTurn.nativeSessionId !== expected.nativeSessionId
        || expected.terminalId !== undefined && current.terminalId !== expected.terminalId
        || expected.terminalEpoch !== undefined && (!current.terminalId || this.options.store.getTerminal(current.terminalId).epoch !== expected.terminalEpoch)) {
        throw new AppError('NATIVE_STOP_TARGET_CHANGED', 'The original task changed before stopping', 409);
      }
    };
  }

  async interrupt(sessionId: string, options?: { clearPrompt?: boolean; expectedStop?: NativeStopRequest }): Promise<void> {
    const session = this.catalog.currentSession(this.options.store.getSession(sessionId));
    const { driver, profile } = await this.resolve(session);
    await this.options.runtime.withSession(session.id, () => {
      const expected = options?.expectedStop;
      const beforeWrite = expected ? this.stopTargetGuard(sessionId, driver, profile, expected) : undefined;
      beforeWrite?.();
      return driver.interrupt(this.host, this.catalog.currentSession(this.options.store.getSession(sessionId)), profile, expected ? { ...options, beforeWrite } : options);
    });
    if (session.nativeSessionId || session.terminalId) this.bindProfile(session, driver, profile);
  }

  /** Records a turn end the dispatcher confirmed, on the journal that serves the conversation. */
  async endTurn(sessionId: string, turnId: string, status: TurnEndStatus, at: string): Promise<void> {
    await this.host.transcript?.endTurn(sessionId, turnId, status, at);
  }

  async runtimeAction(sessionId: string, request: NativeRuntimeActionRequest): Promise<void> {
    const session = this.catalog.currentSession(this.options.store.getSession(sessionId));
    if (session.kind !== 'native' || session.archivedAt) throw new AppError('RUNTIME_CONTROL_UNAVAILABLE', 'This conversation has no runtime control', 409);
    const { driver, profile } = await this.resolve(session);
    if (!driver.runtimeAction) throw new AppError('RUNTIME_CONTROL_UNAVAILABLE', 'This backend has no runtime control', 409);
    await driver.runtimeAction(this.host, session, profile, request);
  }

  /** False when the backend has no such relaunch, and the caller recolours the pane instead. */
  async relaunchForAppearance(session: Session): Promise<boolean> {
    if (session.kind !== 'native' || session.archivedAt) return false;
    const resolved = await this.resolve(session).catch(() => undefined);
    const relaunch = resolved?.driver.relaunchForAppearance?.bind(resolved.driver);
    if (!relaunch) return false;
    await relaunch(this.host, session, resolved!.profile);
    return true;
  }

  async configure(session: Session, request: { model?: string; mode?: string; approval?: string; backendProfileId?: string }): Promise<Session> {
    const { backendProfileId, ...patch } = request;
    const source = backendProfileId === session.nativeRuntime?.profileId ? this.catalog.currentSession(session) : session;
    const { driver, profile: from } = await this.resolve(source);
    const switching = backendProfileId !== undefined && backendProfileId !== (session.backendProfileId ?? from.id);
    const profile = switching ? (await this.resolve(session, backendProfileId)).profile : from;
    if (switching && profile.id !== from.id) {
      await prepareSource(profile.config);
      const key = driver.continuationKey?.(from);
      if (key === undefined || driver.continuationKey!(profile) !== key
        || driver.canContinueProfile && !driver.canContinueProfile(from, profile, session)) {
        throw new AppError('NATIVE_PROFILE_SWITCH_UNSUPPORTED', 'This conversation cannot continue on that provider; hand it off instead', 409, { backendId: driver.id });
      }
      const family = (of: NativeBackendProfileConfig, value: string | undefined) => value ? modelFamily(modelNormalizer(driver, of)(value)) : undefined;
      if (family(profile, patch.model ?? session.model ?? profileDefaultModel(driver, profile)) !== family(from, session.model ?? profileDefaultModel(driver, from))) {
        throw new AppError('NATIVE_PROFILE_SWITCH_MODEL', 'A conversation moves to another provider within its model line; hand it off instead', 409, { backendId: driver.id });
      }
    }
    const normalizedPatch = patch.model === undefined ? patch : { ...patch, model: driver.normalizeModel?.(patch.model, profile) ?? patch.model };
    const result = await driver.configure(this.host, session, profile, normalizedPatch);
    if (switching) {
      // Reads that follow (history, status, interactions) resolve against the new profile from here on.
      this.bindProfile(this.options.store.getSession(session.id), driver, profile);
      const watch = this.watches.get(session.id);
      if (watch) watch.profile = profile;
    } else if (result.nativeSessionId || result.terminalId) this.bindProfile(this.options.store.getSession(session.id), driver, profile);
    const next: Partial<Session> = {
      ...(switching ? { backendProfileId: profile.id } : {}),
      ...normalizedPatch,
      ...(result.model !== undefined ? { model: result.model } : {}),
      ...(result.mode !== undefined ? { mode: result.mode } : {}),
      ...(result.approval !== undefined ? { approval: result.approval } : {}),
      ...(result.nativeSessionId ? { nativeSessionId: result.nativeSessionId } : {}),
      ...(result.terminalId ? { terminalId: result.terminalId } : {}),
    };
    // The driver still sees repeated intent: it may need to apply a previously deferred switch.
    // Only an actual configuration change advances the revision used by submission fences.
    const normalize = modelNormalizer(driver, profile);
    const current = this.options.store.getSession(session.id);
    const changed = switching || (['model', 'mode', 'approval'] as const).some(key => key in next &&
      (key === 'model' ? normalize(next.model ?? '') !== normalize(current.model ?? '') : next[key] !== current[key]));
    let updated = current;
    if (changed || !Object.entries(next).every(([key, value]) => current[key as keyof Session] === value)) {
      updated = changed ? this.options.store.bumpConfig(session.id, next) : this.options.store.updateSession(session.id, next);
      this.options.store.appendEvent(session.id, 'session', { session: updated });
    }
    // Deferred scheduling is a notice after commit. A scheduler failure must not turn saved intent
    // into an apparent failed write; the next open/send can still apply that intent.
    try { driver.afterConfigure?.(this.host, updated, profile); } catch { /* retried by later session activity */ }
    return updated;
  }

  async models(session: Session): Promise<ModelInfo[]> {
    const { driver, profile } = await this.resolve(session);
    return curateModels(await this.catalog.listModels(driver, this.options.store.getProject(session.projectId), profile, session), profile, session, modelNormalizer(driver, profile));
  }

  /**
   * Attempts a native same-backend session fork when the driver supports it and the target profile
   * can continue from the source profile. Returns `undefined` on any mismatch or failure so the
   * caller safely falls back to a text-brief fork.
   */
  async forkNativeSession(
    source: Session,
    targetProject: Project,
    target: { backendId?: NativeBackendId; backendProfileId?: string },
    options: { upToRunId?: string; upToNativeTurnId?: string; upToNativeMessageId?: string } = {},
  ): Promise<{ nativeSessionId: string; cleanup?: () => Promise<void> } | undefined> {
    if (source.kind !== 'native' || !source.nativeSessionId) return undefined;
    if (target.backendId && target.backendId !== source.backendId) return undefined;
    try {
      const { driver, profile: from } = await this.resolve(source);
      if (!driver.forkSession) return undefined;
      const to = target.backendProfileId && target.backendProfileId !== from.id
        ? (await this.resolve(source, target.backendProfileId)).profile
        : from;
      if (to.id !== from.id) {
        const key = driver.continuationKey?.(from);
        if (key === undefined || driver.continuationKey!(to) !== key
          || (driver.canContinueProfile && !driver.canContinueProfile(from, to, source))) {
          return undefined;
        }
      }
      return await driver.forkSession(this.host, source, targetProject, to, options);
    } catch {
      return undefined;
    }
  }

  async dispose(sessionId: string): Promise<void> {
    // The journal reads the last of the conversation through its runtime, before that runtime goes.
    await this.ingest?.retire(sessionId);
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
    this.terminalDialogs.release(sessionId);
    const selected = this.sessionProfiles.get(sessionId);
    if (selected) await selected.driver.dispose?.(this.host, sessionId);
    this.sessionProfiles.delete(sessionId);
    // A conversation not opened since the service started has no runtime to dispose, yet its bound
    // app-server from an earlier instance is still running; and an adopted Unix socket can only be
    // closed, not ended, by its client.
    let address: string | undefined;
    try { address = this.options.store.getSession(sessionId).nativeRuntime?.address; } catch { /* a deleted conversation binds nothing */ }
    if (address) await stopWorkbenchAppServerAt(address, appServerCredentialDirs()).catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    this.closed = true;
    clearInterval(this.outputRateTimer);
    this.outputRateTimer = undefined;
    this.outputRates.clear();
    this.terminalDialogs.releaseAll();
    const sessions = new Map<string, { driver: NativeBackendDriver; profile: NativeBackendProfileConfig }>();
    for (const [sessionId, selected] of this.sessionProfiles) sessions.set(sessionId, selected);
    for (const [sessionId, watch] of this.watches) {
      if (watch.releaseTimer) clearTimeout(watch.releaseTimer);
      try { watch.unsubscribe(); } catch { /* adapter shutdown continues */ }
      sessions.set(sessionId, { driver: watch.driver, profile: watch.profile });
    }
    this.watches.clear();
    this.controlReaders.clear();
    for (const sessionId of [...this.following.keys()]) this.unfollow(sessionId);
    this.sessionProfiles.clear();
    for (const [sessionId, selected] of sessions) {
      // An app-server backend's provider-wide close detaches its reusable daemon. Session disposal is for
      // explicitly closing a conversation and would stop that daemon before close can preserve it.
      if (selected.driver.traits?.closesSessionsItself && selected.driver.close) continue;
      try { await selected.driver.dispose?.(this.host, sessionId); } catch { /* remaining native runtimes still need shutdown */ }
    }
    for (const driver of this.registry.list()) {
      try { await driver.close?.(this.host); } catch { /* app shutdown continues for other adapters */ }
    }
  }
}
