import { assertTaskWorkspaceAvailable } from '../task-workspaces/identity.js';
import type {
  ModelInfo, NativeActivity, NativeBackendId,
  NativeContext, NativeInteraction, NativeJob, NativeInteractionResponse, NativeInteractionResult, NativeStopRequest, NativeWorkbenchEvent,
  NativeBackendProfilesResponse, NativeRunInput, NativeRuntimeActionRequest, NativeStatus, NativeTurnTarget, Project, Run, Session, SessionState, TerminalInfo, WorkbenchEvent,
} from '../../../../packages/contracts/src/index.js';
import { AppError, sessionInTerminal } from '../errors.js';
import type { Store } from '../store.js';
import type { WorkspaceService } from '../workspace/index.js';
import type { SessionLockHandle } from '../agent-host/session-lock.js';
import type { TerminalBehaviour, TerminalService } from '../terminal/service.js';
import { prepareSource } from './shared/model-source.js';
import type { SyncLane } from '../../../../packages/contracts/src/sync.js';
import type { TraceRequests } from '../../../../packages/contracts/src/trace.js';
export { modelFamily } from './shared/model-selection.js';
import { NativeBackendRegistry, isNativeBackendId } from './registry.js';
import { TerminalDialogObserver } from './shared/terminal-dialogs.js';
import { BackendCatalog } from './catalog.js';
import { BackendAdmin } from './admin.js';
import type { StatsSink, UsageTranscript } from '../stats/types.js';
import { servingKey, type TranscriptSource, type TurnEndStatus } from '../journal/ingest.js';
import { backendIdOf } from '../session-identity.js';
import type { TranscriptIngest } from '../sync/ingest.js';
import type { JournalFeed } from '../journal/feed.js';
import type { ExternalSessionEntry, ExternalSessionScan, NativeBackendDriver, NativeBackendHost, NativeBackendOpenOptions, NativeBackendOpenResult, NativeBackendProfileConfig, NativeDispatchBinding, NativePtyLaunchSpec, NativeRiffetMcpHost, NativeShareReadOptions, NativeStandingHost } from './types.js';
import { stopWorkbenchAppServerAt } from './shared/app-server-daemons.js';
import { appServerCredentialDirs } from './codex/config.js';
import { activeSubagents, WatchHub, type ControlMessage } from './watch-hub.js';
import * as dispatchOps from './service-dispatch.js';

/** Used when the process has not installed a ledger. Recording must stay optional for the session. */
const noopStats: StatsSink = {
  recordUsage() {},
  observeEvents() {},
};

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
  /** Idle lifetime of an unpinned provider watch; defaults to `WATCH_IDLE_MS`. */
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
  private readonly sessionProfiles = new Map<string, { driver: NativeBackendDriver; profile: NativeBackendProfileConfig }>();
  private readonly terminalDialogs: TerminalDialogObserver;
  private readonly watches: WatchHub;
  private readonly dispatchDeps: dispatchOps.DispatchDeps;
  private closed = false;
  private ingest: TranscriptIngest | undefined;

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
        if (nativeSessionId && (this.watches.watches.has(id) || this.watches.controlReaders.get(id)?.size)) {
          try {
            const { driver, profile } = this.resolveSync(updated);
            this.watches.ensureWatch(updated, driver, profile);
            this.watches.scheduleWatchRelease(id);
          } catch { /* the caller's open or send binds the watch */ }
        }
        return updated;
      },
      emit: (id, message) => this.watches.broadcast(id, message),
      emitEvent: (id, event) => this.watches.emitEvent(id, event),
      saveRunMetrics: (runId, metrics) => {
        try { options.store.saveRunMetrics(runId, metrics); }
        catch { /* A turn that finished and was pruned must not break the live stream. */ }
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
    this.watches = new WatchHub({
      store: options.store, registry: options.registry, catalog: this.catalog, terminalDialogs: this.terminalDialogs,
      watchIdleMs: options.watchIdleMs,
      host: () => this.host,
      ingest: () => this.ingest,
      isClosed: () => this.closed,
      unavailable: backendId => this.unavailable(backendId),
      resolveSync: session => this.resolveSync(session),
      bindProfile: (session, driver, profile) => this.bindProfile(session, driver, profile),
      deriveSessionState,
      sessionStatePatch,
      selectedProfile: sessionId => this.sessionProfiles.get(sessionId),
      clearProfilesForBackend: backendId => {
        for (const [sessionId, selected] of [...this.sessionProfiles]) if (selected.driver.id === backendId) this.sessionProfiles.delete(sessionId);
      },
      clearSessionProfile: sessionId => { this.sessionProfiles.delete(sessionId); },
    });
    this.dispatchDeps = {
      store: options.store, terminal: options.terminal, runtime: options.runtime, registry: options.registry,
      catalog: this.catalog, terminalDialogs: this.terminalDialogs, watches: this.watches, host: this.host,
      prepareContextInput: options.prepareContextInput,
      resolve: (session, requestedProfileId) => this.resolve(session, requestedProfileId),
      resolveSync: session => this.resolveSync(session),
      bindProfile: (session, driver, profile) => this.bindProfile(session, driver, profile),
      unavailable: backendId => this.unavailable(backendId),
      assertSessionReferences: session => this.assertSessionReferences(session),
      dispose: sessionId => this.dispose(sessionId),
      journalBaseline: sessionId => this.journalBaseline(sessionId),
    };
  }

  backendId(session: Session): NativeBackendId { return backendIdOf(session); }
  assertAvailable(session: Session): void { this.registry.require(backendIdOf(session)); }

  terminalBehaviour(target: { sessionId?: string; backendId?: NativeBackendId }): TerminalBehaviour | undefined {
    let backendId = target.backendId;
    if (!backendId && target.sessionId) {
      try { backendId = this.options.store.getSession(target.sessionId).backendId; } catch { return undefined; }
    }
    return backendId ? this.registry.get(backendId)?.terminal : undefined;
  }

  private unavailable(backendId: NativeBackendId): AppError | undefined {
    try { this.registry.require(backendId); return undefined; }
    catch (error) {
      if (error instanceof AppError && error.code === 'NATIVE_BACKEND_UNAVAILABLE') return error;
      throw error;
    }
  }

  detachBackend(backendId: NativeBackendId): void { this.watches.detachBackend(backendId); }
  attachBackend(backendId: NativeBackendId): void { this.watches.attachBackend(backendId); }
  backendPending(backendId: string): boolean { return isNativeBackendId(backendId) && this.registry.isPending(backendId); }

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
    if (driver.id === 'codex' || driver.id === 'traex') {
      profile = this.catalog.profiles(driver).find(item => item.id === profile.id) ?? profile;
    }
    this.sessionProfiles.set(session.id, { driver, profile });
  }

  forgetProfile(backendId: NativeBackendId, profileId: string): void {
    for (const [sessionId, selected] of this.sessionProfiles) {
      if (selected.driver.id === backendId && selected.profile.id === profileId) this.sessionProfiles.delete(sessionId);
    }
  }

  refreshProfile(backendId: NativeBackendId, profileId: string): void {
    if (backendId !== 'codex' && backendId !== 'traex') return;
    const driver = this.registry.require(backendId);
    const profile = this.catalog.profiles(driver).find(item => item.id === profileId);
    if (!profile) return;
    for (const [sessionId, selected] of this.sessionProfiles) {
      if (selected.driver.id !== backendId || selected.profile.id !== profileId) continue;
      const session = this.options.store.getSession(sessionId);
      this.bindProfile(session, driver, profile);
      const watch = this.watches.watches.get(sessionId);
      if (watch) watch.profile = profile;
      this.watches.publishStatus(sessionId, driver, profile);
    }
    this.catalog.invalidateModelCatalogs();
  }

  async supportsInitialPromptArgs(session: Session): Promise<boolean> {
    const { driver, profile } = await this.resolve(session);
    return (await this.catalog.driverCapabilities(driver, profile)).supportsInitialPromptArgs === true;
  }
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
      await dispatchOps.assertNotHeldElsewhere(this.dispatchDeps, current, driver, profile);
      await prepareSource(profile.config);
      try {
        const project = this.options.store.getProject(current.projectId);
        await assertTaskWorkspaceAvailable(project);
        const opened = await driver.openOrResume(this.host, current, project, profile, options);
        current = this.options.store.getSession(current.id);
        if (opened.nativeSessionId && opened.nativeSessionId !== current.nativeSessionId) current = this.host.setNativeSessionId(current.id, opened.nativeSessionId);
        if (opened.terminalId && opened.terminalId !== current.terminalId) current = this.options.store.updateSession(current.id, { terminalId: opened.terminalId });
        this.bindProfile(current, driver, profile);
        const watch = this.watches.ensureWatch(current, driver, profile);
        current = this.options.store.getSession(current.id);
        const status = opened.status ?? driver.status(this.host, current, profile);
        if (status.phase !== 'offline') {
          const state = deriveSessionState({ current: current.state, phase: status.phase, runningSubagents: activeSubagents(watch) });
          current = this.options.store.updateSession(current.id, sessionStatePatch(current, state));
          this.watches.broadcast(current.id, { type: 'status', status });
        }
        this.watches.scheduleWatchRelease(current.id);
        const terminal = opened.terminalId ? await this.options.terminal.get(opened.terminalId).catch(() => undefined) : undefined;
        return { ...opened, status: this.watches.withOutputRate(current.id, status), session: current, ...(terminal ? { terminal } : {}) };
      } catch (error) {
        if (error instanceof AppError && error.code === 'NATIVE_LAUNCH_ABORTED') throw error;
        const message = error instanceof Error ? error.message : 'Native backend could not start';
        this.options.store.updateSession(current.id, sessionStatePatch(current, deriveSessionState({ current: current.state, startError: true }), message));
        throw error;
      }
    });
  }

  async wakeNativeSession(backendId: NativeBackendId, nativeSessionId: string): Promise<boolean> {
    if (this.closed) return false;
    const session = this.options.store.listSessions().find(item => item.kind === 'native' && item.backendId === backendId
      && item.nativeSessionId === nativeSessionId && !item.archivedAt && Boolean(item.terminalId));
    if (!session) return false;
    const { driver, profile } = await this.resolve(session);
    this.watches.ensureWatch(session, driver, profile);
    this.watches.scheduleWatchRelease(session.id);
    return true;
  }

  hasListeners(sessionId: string): boolean { return this.watches.hasListeners(sessionId); }

  attachIngest(ingest: TranscriptIngest): void {
    this.ingest = ingest;
    this.host.transcript = {
      drain: sessionId => ingest.drain(sessionId),
      endTurn: (sessionId, turnId, status, at, error) => ingest.endTurn(sessionId, turnId, status, at, error),
      withSource: (sessionId, task) => ingest.control(sessionId, task),
      wake: sessionId => ingest.wake(sessionId),
    };
  }

  drainTranscript(sessionId: string): Promise<void> { return this.ingest?.drain(sessionId) ?? Promise.resolve(); }

  async canReleaseInput(session: Session, run: Run): Promise<boolean> {
    const { driver, profile } = this.resolveSync(session);
    return await driver.canReleaseInput?.(this.host, session, profile, run) ?? false;
  }

  transcriptSource(sessionId: string): TranscriptSource | undefined {
    const session = this.options.store.getSession(sessionId);
    if (session.kind !== 'native') return undefined;
    if (this.unavailable(this.backendId(session))) return undefined;
    const { driver, profile } = this.resolveSync(session);
    return driver.transcript?.(this.host, session, profile);
  }

  watchControl(sessionId: string, listener: (message: ControlMessage) => void): { status(): NativeStatus; context(): NativeContext | undefined; close(): void } {
    return this.watches.watchControl(sessionId, listener);
  }
  listJobs(sessionId: string): NativeJob[] { return this.watches.listJobs(sessionId); }
  onJobChanged(listener: (sessionId: string, job: NativeJob) => void): () => void { return this.watches.onJobChanged(listener); }
  watchEvents(sessionId: string, listener: (event: NativeWorkbenchEvent) => void): () => void { return this.watches.watchEvents(sessionId, listener); }
  readJournal(feed: JournalFeed): () => void { return this.watches.readJournal(feed); }

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

  async traceRequests(sessionId: string, lane: SyncLane, agentId: string | undefined, signal: AbortSignal): Promise<TraceRequests> {
    const session = this.options.store.getSession(sessionId);
    const { driver, profile } = this.resolveSync(session);
    if (!driver.stored?.requests) return { lane, status: 'unsupported', backendId: driver.id, prompts: [], requests: [], params: {}, context: {} };
    return driver.stored.requests(this.host, session, profile, { lane, ...(agentId ? { agentId } : {}), signal });
  }

  async usageTranscript(sessionId: string, known?: string): Promise<UsageTranscript | undefined | null> {
    const session = this.options.store.getSession(sessionId);
    if (this.unavailable(this.backendId(session))) return null;
    const { driver, profile } = await this.resolve(session);
    if (!driver.stored?.usage) return null;
    return driver.stored.usage(this.host, session, profile, known);
  }

  usageTranscriptBackendIds(): NativeBackendId[] { return this.registry.list().filter((driver) => driver.stored?.usage).map((driver) => driver.id); }
  externalSessionSources(): Array<{ backendId: NativeBackendId; profileId: string; list(options: ExternalSessionScan): Promise<ExternalSessionEntry[]> }> {
    return dispatchOps.externalSessionSources(this.dispatchDeps);
  }
  resumeCommand(session: Session): Promise<{ nativeSessionId: string; command: string; credentialsOmitted: boolean }> {
    return dispatchOps.resumeCommand(this.dispatchDeps, session);
  }
  async stopOwnCli(session: Session): Promise<void> {
    await this.dispose(session.id);
    const terminal = dispatchOps.liveTerminalOf(this.options.store, this.options.store.getSession(session.id));
    if (terminal) await this.options.terminal.stop(terminal.id);
  }
  releaseToTerminal(session: Session): Promise<NativePtyLaunchSpec> { return dispatchOps.releaseToTerminal(this.dispatchDeps, session); }
  followExternal(session: Session): () => void {
    const { driver, profile } = this.resolveSync(session);
    return driver.external?.follow?.(this.host, session, profile) ?? (() => undefined);
  }
  offeredBackendIds(): NativeBackendId[] { return this.registry.list().map((driver) => driver.id); }
  availableBackendIds(): Promise<NativeBackendId[]> { return this.catalog.availableBackendIds(); }
  readOnlyTranscriptBackendIds(): NativeBackendId[] { return this.registry.list().filter((driver) => driver.stored?.readOnly).map((driver) => driver.id); }

  sendRun(session: Session, run: Run, commitDispatchFence: (binding?: NativeDispatchBinding) => Run, options: { now?: boolean; expectedStop?: NativeStopRequest } = {}): Promise<void | { settled: true }> {
    return dispatchOps.sendRun(this.dispatchDeps, session, run, commitDispatchFence, options);
  }
  steerRun(session: Session, run: Run, commitDispatchFence: (binding?: NativeDispatchBinding) => Run): Promise<void | { deferred: true }> {
    return dispatchOps.steerRun(this.dispatchDeps, session, run, commitDispatchFence);
  }
  commitDispatchFence(runId: string, binding: NativeDispatchBinding = {}): Run {
    return dispatchOps.commitDispatchFence(this.dispatchDeps, runId, binding);
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

  async readShareTranscript(sessionId: string, options?: NativeShareReadOptions) {
    const session = this.options.store.getSession(sessionId);
    const { driver, profile } = await this.resolve(session);
    if (!driver.stored?.share) throw new AppError('SHARE_HISTORY_UNAVAILABLE', `${driver.label} does not provide a complete read-only transcript`, 409);
    return await driver.stored.share(this.host, session, profile, options);
  }

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
    if (!selected) return this.watches.withOutputRate(sessionId, { phase: 'offline' });
    return this.watches.withOutputRate(sessionId, this.terminalDialogs.merge(session, selected.driver.status(this.host, session, selected.profile)));
  }

  async capabilities(session: Session) {
    session = this.catalog.currentSession(session);
    const { driver, profile } = await this.resolve(session);
    return this.catalog.driverCapabilities(driver, profile);
  }

  interaction(session: Session): Promise<NativeInteraction | undefined> { return dispatchOps.interaction(this.dispatchDeps, session); }
  respondInteraction(session: Session, response: NativeInteractionResponse): Promise<NativeInteractionResult> { return dispatchOps.respondInteraction(this.dispatchDeps, session, response); }
  async extendInteraction(session: Session, interactionId: string): Promise<NativeInteraction> {
    session = this.catalog.currentSession(session);
    const { driver, profile } = await this.resolve(session);
    if (!driver.extendInteraction) throw new AppError('NATIVE_INTERACTION_NOT_EXTENDABLE', 'This backend does not time out its requests', 409);
    return await driver.extendInteraction(this.host, session, profile, interactionId);
  }
  stopActivity(session: Session, activityId: string): Promise<NativeActivity> { return dispatchOps.stopActivity(this.dispatchDeps, session, activityId); }

  requestInterrupt(sessionId: string): void {
    const session = this.options.store.getSession(sessionId);
    this.registry.require(this.backendId(session)).requestInterrupt?.(this.host, session);
  }
  interrupt(sessionId: string, options?: { clearPrompt?: boolean; expectedStop?: NativeStopRequest }): Promise<void> {
    return dispatchOps.interrupt(this.dispatchDeps, sessionId, options);
  }
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
  async relaunchForAppearance(session: Session): Promise<boolean> {
    if (session.kind !== 'native' || session.archivedAt) return false;
    const resolved = await this.resolve(session).catch(() => undefined);
    const relaunch = resolved?.driver.relaunchForAppearance?.bind(resolved.driver);
    if (!relaunch) return false;
    await relaunch(this.host, session, resolved!.profile);
    return true;
  }
  configure(session: Session, request: { model?: string; mode?: string; approval?: string; backendProfileId?: string }): Promise<Session> {
    return dispatchOps.configure(this.dispatchDeps, session, request);
  }
  models(session: Session): Promise<ModelInfo[]> { return dispatchOps.models(this.dispatchDeps, session); }
  forkNativeSession(source: Session, targetProject: Project, target: { backendId?: NativeBackendId; backendProfileId?: string }, options: { upToRunId?: string; upToNativeTurnId?: string; upToNativeMessageId?: string } = {}) {
    return dispatchOps.forkNativeSession(this.dispatchDeps, source, targetProject, target, options);
  }

  async dispose(sessionId: string): Promise<void> {
    await this.ingest?.retire(sessionId);
    this.watches.disposeSession(sessionId);
    const selected = this.sessionProfiles.get(sessionId);
    if (selected) await selected.driver.dispose?.(this.host, sessionId);
    this.sessionProfiles.delete(sessionId);
    let address: string | undefined;
    try { address = this.options.store.getSession(sessionId).nativeRuntime?.address; } catch { /* a deleted conversation binds nothing */ }
    if (address) await stopWorkbenchAppServerAt(address, appServerCredentialDirs()).catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    this.closed = true;
    const sessions = this.watches.drainForClose();
    for (const [sessionId, selected] of this.sessionProfiles) sessions.set(sessionId, selected);
    this.sessionProfiles.clear();
    for (const [sessionId, selected] of sessions) {
      if (selected.driver.traits?.closesSessionsItself && selected.driver.close) continue;
      try { await selected.driver.dispose?.(this.host, sessionId); } catch { /* remaining native runtimes still need shutdown */ }
    }
    for (const driver of this.registry.list()) {
      try { await driver.close?.(this.host); } catch { /* app shutdown continues for other adapters */ }
    }
  }
}
