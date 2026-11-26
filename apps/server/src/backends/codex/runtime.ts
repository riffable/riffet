import type { ModelInfo, NativeActivity, NativeInteraction, NativeInteractionResponse, NativeInteractionResult, NativeRuntimeActionRequest, NativeRuntimeControl, NativeStatus, NativeTurnTarget, Project, Session } from '../../../../../packages/contracts/src/index.js';
import type { CodexAppServerClient, CodexAppServerFactory, JsonRpcServerRequest } from '../shared/codex-app-server.js';
import { CodexDraftStream, type CodexDraftOptions } from './drafts.js';
import { codexFlavor, type CodexFlavor } from './flavors.js';
import type { CodexObservation } from './observation.js';
import { parseNativeModelSelection } from '../shared/model-selection.js';
import { TurnTracker, turnPhaseOf } from '../shared/turn-tracker.js';
import { AppError } from '../../errors.js';
import type { NativeBackendHost, NativeBackendProfileConfig, NativeControlMessage } from '../types.js';
import { isLiveActivity, withActivity } from '../../journal/activity.js';
import { CodexActivities } from './activities.js';
import { CodexTurnMetering, CodexContextMeter, noteRequestWaitStart, noteRequestWaitEnd } from './metering.js';
import { CodexTurns } from './turns.js';
import { CodexConnection, type NativeRuntimeHooks } from './connection.js';
import { CodexTerminal } from './terminal.js';
import { CodexThread } from './thread.js';
import { CodexInteractions } from './pending.js';
import { CodexSettings } from './settings.js';
import { CodexDispatch, type SendInput } from './dispatch.js';
import { CodexNotifications } from './notifications.js';
import { CodexEventLog } from './event-log.js';
import { CodexHistorySync } from './history-sync.js';
import { CodexSubagents } from './subagents.js';
import { journalOf } from './journal-space.js';
import type { CodexLiveFeed, CodexThreadReader, CodexTurnPage, CodexTurnsRequest } from './transcript-source.js';
import type { TerminalEndpointState, RpcThread, RpcTurn, RpcItem } from './types.js';
import { HISTORY_POLL_MS, HISTORY_FALLBACK_POLL_MS } from './runtime-limits.js';
import { latestPlanTextOf, CodexHistoryReader } from './history-read.js';
import { threadStatusUpdate } from './thread-status.js';
import { str, canonicalJson } from './util.js';
import { matchesRuntimeFingerprint, supportsSteerVersion } from './config.js';
import { standingProtects } from './standing.js';
import { type CodexWarm } from './launch.js';
import { safeProviderError } from './errors.js';
import { commandIdOfItem } from './command-id.js';

export type { NativeRuntimeHooks } from './connection.js';

/** What the adapter supplies to `switchProfile`: the parts of the move that belong to its runtime table and listeners. */
export interface ProfileSwitchSteps {
  feed(): CodexLiveFeed;
  /** Makes `runtime` the one that serves the session. */
  publish(runtime: CodexSessionRuntime): void;
  /** Subscribes the session's listeners to `runtime`. */
  bind(runtime: CodexSessionRuntime): Promise<void>;
  /** A new, unstarted runtime for the profile being left, already attached to the feed and published. */
  restore(): CodexSessionRuntime;
  previousModel: string;
  /** The failure as the user may see it, with provider credentials removed. */
  describe(error: unknown): string;
  succeeded(): void;
  failed(): void;
}

export class CodexSessionRuntime implements CodexThreadReader {
  /** The link to the app-server: transport, endpoint and binding conflicts, profile identity (`connection.ts`). */
  readonly connection: CodexConnection;
  /** The terminal client sharing the app-server (`terminal.ts`). */
  readonly terminal: CodexTerminal;
  /** The thread on the app-server: opening it, its standing configuration, who owns it while loaded (`thread.ts`). */
  private readonly thread: CodexThread;
  /** What the app-server waits on the reader for: requests, questions, mode changes (`pending.ts`). */
  private readonly interactions: CodexInteractions;
  /** What the conversation runs with: permissions, mode, model, goal and title (`settings.ts`). */
  private readonly settings: CodexSettings;
  /** What the workbench writes to the thread: messages, steers, native commands, interruption (`dispatch.ts`). */
  private readonly dispatch: CodexDispatch;
  /** Sends each notification to the object that owns what it changes (`notifications.ts`). */
  private readonly notifications: CodexNotifications;
  /** The conversation's events: the resident window, their numbers and the projection of items (`event-log.ts`). */
  private readonly log: CodexEventLog;
  /** Reads the thread into the log, imports its history and polls (`history-sync.ts`). */
  private readonly sync: CodexHistorySync;
  /** Turn bookkeeping: the current turn, and which command and run each turn belongs to. */
  private readonly turns: CodexTurns;
  private readonly turn = new TurnTracker('starting', { activePollMs: HISTORY_POLL_MS, fallbackPollMs: HISTORY_FALLBACK_POLL_MS });
  status: NativeStatus = { phase: 'starting', connection: { state: 'reconnecting' }, history: { state: 'loading' } };
  private readonly subagents: CodexSubagents;
  private readonly metering: CodexTurnMetering;
  private readonly drafts = new CodexDraftStream({
    ...(process.env.RIFFET_CODEX_STREAM_TIMING === '1' ? {
      timing: (sample: Parameters<NonNullable<CodexDraftOptions['timing']>>[0]) =>
        console.info('[codex-stream-timing]', JSON.stringify({ sessionId: this.session.id, ...sample })),
    } : {}),
    nextSequence: () => this.log.space.peekNext(),
    reserveSequence: () => undefined,
    persist: (finalId, event) => this.log.space.assignDraft(finalId, event),
    eventContext: turnId => {
      const run = this.turns.turnRun(turnId);
      return { sessionId: this.session.id, runId: run?.runId ?? turnId, createdAt: run?.createdAt ?? new Date().toISOString() };
    },
    send: () => undefined,
  });
  /** Context compactions and background terminals: live state, log rows and the status summary. */
  private readonly activities: CodexActivities;
  private readonly usage: CodexContextMeter;
  private readonly history: CodexHistoryReader;
  /**
   * The facts `refreshStatus` derives the published status from. `link` is what the app-server last
   * said about work outside a tracked turn; the phase is that, the interaction and the active turn.
   * The notice's source stays local: transport/history diagnostics have their own structured status.
   */
  private facts: {
    link: 'starting' | 'offline' | 'quiet' | 'working';
    connection?: NativeStatus['connection']; history?: NativeStatus['history']; approval?: string; model?: string;
    notice?: { text: string; level: NativeStatus['noticeLevel']; source: 'thread' | 'transient' | 'other' };
  } = { link: 'starting', connection: { state: 'reconnecting' }, history: { state: 'loading' } };
  private threadError = false;
  /** Only a root turn observed in the current activity can explain its thread's generic error. */
  private threadErrorTurnId: string | undefined;
  private readonly profileConfig: Record<string, unknown>;
  private detachObservation?: () => void;

  constructor(
    private readonly host: NativeBackendHost,
    private session: Session,
    private readonly project: Project,
    private readonly profile: NativeBackendProfileConfig,
    startAppServer: CodexAppServerFactory,
    private readonly flavor: CodexFlavor = codexFlavor,
    runtimeHooks?: NativeRuntimeHooks,
    /** Reports what shell commands change in the working tree (`observation.ts`); only Codex itself has the hooks it needs. */
    observation?: CodexObservation,
  ) {
    this.detachObservation = observation?.attach(session.id, () => this.nativeSessionId);
    // These describe the process we connected to. A later profile edit must not retroactively
    // change its launch identity or the fingerprint committed for that process.
    this.project = { ...project };
    this.session = { ...session };
    this.profile = { ...profile, config: structuredClone(profile.config) };
    this.log = new CodexEventLog({
      host,
      sessionId: session.id,
      flavor: this.flavor,
      profileConfig: this.profile.config,
      observation,
      threadId: () => this.nativeSessionId,
      turns: () => this.turns,
      activities: () => this.activities,
      drafts: () => this.drafts,
      questions: () => this.interactions.questionHistory,
      commandIdOf: (item, turnId) => this.commandIdOf(item, turnId),
      nameFromMessage: text => this.settings.nameFromMessage(text),
      rolloutFile: threadId => this.thread.rolloutFile(threadId),
      isTurnRunning: (threadId, turn) => this.isTurnRunning(threadId, turn),
      refreshStatus: () => this.refreshStatus(),
    }, session.nativeSessionId);
    this.profileConfig = this.profile.config;
    this.connection = new CodexConnection({
      host,
      project: this.project,
      profile: this.profile,
      flavor: this.flavor,
      startAppServer,
      runtimeHooks,
      observation,
      session: () => this.session,
      threadId: () => this.nativeSessionId,
      status: () => this.status,
      terminal: () => this.terminal,
      refreshStatus: change => this.refreshStatus(change),
      resumed: () => this.resumed(),
      canSwitchProfile: () => this.canSwitchProfile,
      readThread: threadId => this.history.readThread(threadId, false),
      interrupt: () => this.interrupt(),
      dispose: () => this.dispose(host),
      beginMaterialization: () => this.history.beginMaterialization(),
      terminalEndpointUnreachable: () => {
        this.facts = { link: 'offline', connection: { state: 'failed', message: `The ${this.label} terminal endpoint could not be reached.` }, history: { state: 'error', message: `${this.label} history could not be loaded from the running terminal.` } };
        this.status = { phase: this.turnPhase('offline'), connection: this.facts.connection, history: this.facts.history };
      },
      onNotification: (method, params) => this.onNotification(method, params),
      onServerRequest: request => this.onServerRequest(request),
      onExit: error => this.onExit(error),
    });
    this.settings = new CodexSettings({
      host,
      sessionId: session.id,
      project: this.project,
      flavor: this.flavor,
      connection: this.connection,
      threadId: () => this.nativeSessionId,
      status: () => this.status,
      turns: () => this.turns,
      thread: () => this.thread,
      reader: () => this.history,
      log: () => this.log,
      reloadSession: () => { this.session = host.getSession(this.session.id); },
      emit: message => this.log.emit(message),
      openOrResume: override => this.openOrResume(override),
      applyThreadStatus: status => this.applyThreadStatus(status),
      refreshStatus: change => this.refreshStatus(change),
    });
    this.thread = new CodexThread({
      host,
      project: this.project,
      profile: this.profile,
      flavor: this.flavor,
      session: () => this.session,
      terminal: () => this.terminal,
      canSwitchProfile: () => this.canSwitchProfile,
      busy: () => this.activeTurnId !== undefined || this.status.phase === 'busy',
      readThread: threadId => this.history.readThread(threadId, false),
      permissionObservation: () => this.settings.permissionObservation,
      modeObservation: () => this.settings.modeObservation,
      permissionParams: (permission, sandboxField, force) => this.settings.permissionParams(permission, sandboxField, force),
      adoptApproval: settings => this.settings.adoptApproval(settings),
      adoptSettingsMode: settings => this.settings.adoptSettingsMode(settings),
      adoptProviderTitle: name => this.settings.adoptProviderTitle(name),
      startedThread: threadId => {
        this.history.startMaterialization(threadId);
        this.log.space.adoptThread(threadId);
        if (!this.log.space.initialized) { this.log.space.bind('real'); this.log.space.writeState({ phase: 'ready', turns: 0 }); this.log.space.markInitialized(); }
      },
      resetUsage: () => this.usage.reset(),
      readGoal: threadId => { void this.settings.readGoal(threadId); },
      applyThreadStatus: status => this.applyThreadStatus(status),
      markQuiet: () => { if (this.facts.link === 'offline' || this.facts.link === 'starting') this.refreshStatus({ link: 'quiet' }); },
      refreshEvents: () => this.sync.refreshEvents(),
      noteHistoryFailure: error => this.sync.noteHistoryFailure(error),
    }, this.connection, session.nativeSessionId);
    this.interactions = new CodexInteractions({
      host,
      profile: this.profile,
      flavor: this.flavor,
      session: () => this.session,
      threadId: () => this.nativeSessionId,
      activeTurnId: () => this.activeTurnId,
      status: () => this.status,
      modeObservation: () => this.settings.modeObservation,
      emit: message => this.log.emit(message),
      interrupt: (turnId, threadId) => this.interrupt(turnId, threadId),
      scopedRequestId: (threadId, id) => this.scopedRequestId(threadId, id),
      refreshStatus: () => this.refreshStatus(),
      requestRaised: () => this.refreshStatus({ link: this.resumed(), notice: undefined }),
      requestSettled: notice => this.refreshStatus({ link: 'quiet', notice: notice ? { text: notice, level: 'warning', source: 'other' } : undefined }),
      adoptMode: mode => this.settings.adoptMode(mode),
      reconcileMode: threadId => this.settings.startModeReconciliation(threadId),
      latestPlanText: (turnId, threadId) => this.latestPlanText(turnId, threadId),
      projectAnswered: (item, turnId) => { for (const event of this.log.projectItem(item, { id: turnId })) this.log.pushEvent(event); },
      // A child's output-only history still needs this native metadata, as does a v3 reader with
      // its own question tracker. Forward metadata, never candidate answers or a child main row.
      forwardQuestion: (method, params) => this.log.forward(method, params),
      projectQuestion: (item, turnId) => { for (const event of this.log.projectItem(item, { id: turnId })) this.log.pushEvent(event, true); },
      requestWaitStarted: (turnId, requestId) => noteRequestWaitStart(this.metering, turnId, requestId),
      requestWaitEnded: (turnId, requestId) => {
        const meter = this.metering.active(turnId);
        if (meter) noteRequestWaitEnd(meter, requestId);
      },
    }, this.connection);
    this.terminal = new CodexTerminal({
      host,
      project: this.project,
      profile: this.profile,
      flavor: this.flavor,
      observation,
      session: () => this.session,
      threadId: () => this.nativeSessionId,
      turnInFlight: () => Boolean(this.activeTurnId || this.dispatchCommandId || this.interaction || this.status.phase === 'busy' || this.status.phase === 'attention'),
    }, this.connection, session.terminalId);
    this.turns = new CodexTurns({
      threadId: () => this.nativeSessionId,
      runsOfTurn: (threadId, turnId) => this.host.findRunsByNativeTurn?.(this.session.id, threadId, turnId) ?? [],
      runIdOfCommand: commandId => this.host.findRunIdByCommand(this.session.id, commandId),
      commandIdOf: (item, turnId) => this.commandIdOf(item, turnId),
      scopedRequestId: (threadId, id) => this.scopedRequestId(threadId, id),
    });
    this.history = new CodexHistoryReader({
      requireTransport: () => this.connection.requireTransport(),
      label: () => this.label,
      subagents: () => this.subagents,
      dispatchCommandId: () => this.turns.dispatchCommandId,
      foregroundEndedTurnId: () => this.turns.foregroundEndedTurnId,
      routineWindow: () => this.log.space.ready || (this.log.journalRead && this.log.space.initialized),
    });
    this.subagents = new CodexSubagents({
      readTurns: threadId => this.history.readTurns(threadId),
      readThread: (threadId, includeTurns) => this.history.readThread(threadId, includeTurns),
      projectChildItem: (item, turn, childThreadId) => this.log.projectChildItem(item, turn, childThreadId),
      turnCompleted: (threadId, turn) => this.turns.completeWaiters(turn.id, threadId),
      emit: message => this.log.emit(message),
    });
    this.usage = new CodexContextMeter({
      contextUsage: this.flavor.contextUsage,
      emit: message => { for (const listener of this.log.listeners) listener(message); },
      threadId: () => this.nativeSessionId,
      transport: () => this.transport,
      bindingScopeMismatch: () => this.connection.bindingScopeMismatch,
      rolloutFile: threadId => this.thread.rolloutFile(threadId),
      contextUsed: used => this.activities.noteContext(used),
    });
    this.metering = new CodexTurnMetering({
      sessionId: session.id,
      host,
      turnRun: turnId => this.turns.turnRun(turnId),
      userMessageId: turnId => this.log.events.find(event => event.type === 'user_message_chunk'
        && event.nativeId.startsWith(`${this.nativeSessionId ?? 'unknown'}:${turnId}:`))?.nativeId,
      model: () => this.status.model,
      emit: message => this.log.emit(message),
    });
    this.activities = new CodexActivities({
      flavor: this.flavor,
      sessionId: this.session.id,
      threadId: () => this.nativeSessionId,
      transport: () => this.transport?.isOnline ? this.transport : undefined,
      journal: () => journalOf(this.host),
      contextUsed: () => this.usage.context?.used,
      rolloutFile: threadId => this.thread.rolloutFile(threadId),
      write: (activity, turnId) => this.log.writeActivity(activity, turnId),
      // The journal's reader follows background terminals too, whether or not a v2 client listens.
      hasListeners: () => this.log.observed,
    });
    this.sync = new CodexHistorySync({
      sessionId: session.id,
      flavor: this.flavor,
      profileConfig: this.profileConfig,
      connection: this.connection,
      threadId: () => this.nativeSessionId,
      status: () => this.status,
      interaction: () => this.interaction,
      interactionsIdle: () => this.interactions.idle,
      turns: () => this.turns,
      reader: () => this.history,
      drafts: () => this.drafts,
      metering: () => this.metering,
      thread: () => this.thread,
      subagents: () => this.subagents,
      usage: () => this.usage,
      activities: () => this.activities,
      terminal: () => this.terminal,
      commandIdOf: (item, turnId) => this.commandIdOf(item, turnId),
      isTurnRunning: (threadId, turn) => this.isTurnRunning(threadId, turn),
      attachLoadedOwner: () => this.attachLoadedOwner(),
      applyThreadStatus: status => this.applyThreadStatus(status),
      adoptProviderTitle: name => this.settings.adoptProviderTitle(name),
      refreshStatus: change => this.refreshStatus(change),
      suggestedPollMs: healthy => this.turn.suggestedPollMs(healthy),
    }, this.log);
    this.dispatch = new CodexDispatch({
      host,
      sessionId: session.id,
      project: this.project,
      flavor: this.flavor,
      profileConfig: this.profileConfig,
      connection: this.connection,
      log: this.log,
      turns: this.turns,
      thread: this.thread,
      settings: this.settings,
      interactions: this.interactions,
      subagents: this.subagents,
      sync: this.sync,
      reader: this.history,
      terminal: this.terminal,
      threadId: () => this.nativeSessionId,
      status: () => this.status,
      interaction: () => this.interaction,
      currentInteraction: () => this.currentInteraction,
      resumed: () => this.resumed(),
      scopedRequestId: (threadId, id) => this.scopedRequestId(threadId, id),
      attachLoadedOwner: () => this.attachLoadedOwner(),
      refreshStatus: change => this.refreshStatus(change),
    });
    this.notifications = new CodexNotifications({
      host,
      sessionId: session.id,
      flavor: this.flavor,
      profileConfig: this.profileConfig,
      observation,
      log: this.log,
      turns: this.turns,
      thread: this.thread,
      interactions: this.interactions,
      settings: this.settings,
      sync: this.sync,
      subagents: this.subagents,
      metering: this.metering,
      usage: this.usage,
      drafts: this.drafts,
      activities: this.activities,
      terminal: this.terminal,
      reader: this.history,
      threadId: () => this.nativeSessionId,
      status: () => this.status,
      noticeSource: () => this.facts.notice?.source,
      nativeCommand: () => this.dispatch.nativeCommand,
      confirmNativeCommand: turnId => this.dispatch.confirmNativeCommand(turnId),
      commandIdOf: (item, turnId) => this.commandIdOf(item, turnId),
      rootTurnStarted: turnId => { this.threadError = false; this.threadErrorTurnId = turnId; },
      applyThreadStatus: status => this.applyThreadStatus(status),
      refreshStatus: change => this.refreshStatus(change),
    });
  }

  get label(): string { return this.flavor.label; }

  get transport(): CodexAppServerClient | undefined { return this.connection.transport; }
  /** The id of the thread this runtime drives; it changes only when `openOrResume` creates one. */
  get nativeSessionId(): string | undefined { return this.thread.id; }
  openOrResume(override?: { model?: string; approval?: string }): Promise<string> { return this.thread.openOrResume(override); }
  leaveThread(): Promise<string> { return this.thread.leaveThread(); }
  attachLoadedOwner(): Promise<void> { return this.thread.attachLoadedOwner(); }
  /** The blocking request the card shows; public because the status carries it. */
  get interaction(): NativeInteraction | undefined { return this.interactions.blocking; }
  /** What the card shows: a blocking request first, then the oldest unanswered async question. */
  get currentInteraction(): NativeInteraction | undefined { return this.interactions.current; }
  respond(response: NativeInteractionResponse): Promise<NativeInteractionResult> { return this.interactions.respond(response); }
  holdsInteraction(interactionId: string): boolean { return this.interactions.holdsInteraction(interactionId); }
  get terminalId(): string | undefined { return this.terminal.id; }
  set terminalId(id: string | undefined) { this.terminal.bind(id); }

  /** The provider turn in the foreground, if any. */
  get activeTurnId(): string | undefined { return this.turns.activeTurnId; }
  private get dispatchCommandId(): string | undefined { return this.turns.dispatchCommandId; }
  private get foregroundEndedTurnId(): string | undefined { return this.turns.foregroundEndedTurnId; }

  /** The workbench command a user item answers, or undefined for a message typed in the TUI. */
  private commandIdOf(item: RpcItem, turnId: string | undefined): string | undefined {
    return commandIdOfItem({
      flavor: this.flavor,
      sessionId: this.session.id,
      threadId: () => this.nativeSessionId,
      runsOfTurn: (threadId, turn) => this.host.findRunsByNativeTurn?.(this.session.id, threadId, turn) ?? [],
      claimSteeredItem: (id, turn, claimed) => this.turns.claimSteeredItem(id, turn, claimed),
    }, item, turnId);
  }

  get projectCwd(): string { return this.project.cwd; }

  /** The actual writer's launch profile, independent of the next provider the user selected. */
  get launchProfile(): NativeBackendProfileConfig { return this.profile; }

  /** The source model for rollback, including saved dimensions when they still name that model. */
  get currentModel(): string | undefined {
    const selected = this.status.model ?? (!this.session.backendProfileId || this.session.backendProfileId === this.profile.id ? this.session.model : undefined);
    return selected && (!this.thread.model || parseNativeModelSelection(selected).model === this.thread.model)
      ? selected : this.thread.model ?? str(this.profileConfig.defaultModel);
  }

  get canSwitchProfile(): boolean {
    return !this.activeTurnId && !this.dispatchCommandId && !this.currentInteraction
      && this.status.phase !== 'busy' && this.status.phase !== 'attention'
      && ![...this.subagents.values()].some(child => child.running)
      && !this.activities.ledger.list().some(isLiveActivity)
      && this.host.getSession(this.session.id).goal?.status !== 'active';
  }

  /**
   * Whether the endpoint a reused runtime stands on is still the one the session's terminal uses.
   * Undefined when this runtime has no live connection to that thread, where there is nothing to
   * check; `reuseVerdict` then judges the runtime on its own. `force` rechecks the terminal even
   * if a recent check is cached.
   */
  async probeEndpoint(session: Session, project: Project, profile: NativeBackendProfileConfig, force: boolean): Promise<{ state: TerminalEndpointState; changed: boolean } | undefined> {
    this.connection.syncSessionBinding(session, project, profile);
    if (!this.transport?.isOnline || this.project.cwd !== project.cwd || this.nativeSessionId !== session.nativeSessionId) return undefined;
    const state = await this.terminal.endpointState(force || this.connection.endpointBlocked || this.status.connection?.state === 'conflict');
    // A cold reader's replacement leaves the dead binding saved; that binding is not a new owner.
    return { state, changed: state === 'changed' || this.connection.bindingMoved(session.nativeRuntime?.address) };
  }

  /**
   * Whether this runtime keeps serving the session or a new one replaces it. A runtime that has to
   * stay because a profile change waits for its turn is marked as deferred here; the caller only
   * acts on the verdict.
   */
  reuseVerdict(session: Session, project: Project, profile: NativeBackendProfileConfig, probe: { state: TerminalEndpointState; changed: boolean } | undefined): 'keep' | 'replace' {
    const online = () => Boolean(this.transport?.isOnline);
    if (probe) {
      if (probe.state === 'unknown' && online()) {
        if (!this.connection.belongsTo(project, profile)) this.connection.deferForProfileChange();
        return 'keep';
      }
      if (!probe.changed && this.connection.belongsTo(project, profile) && online()
        && (this.connection.matches(project, profile) || session.nativeRuntime?.address === this.transport!.remoteAddress)) {
        return 'keep';
      }
    }
    const confirmedProfileRestored = Boolean(session.nativeRuntime?.fingerprint && matchesRuntimeFingerprint(session.nativeRuntime.fingerprint, project, profile, this.flavor));
    // If the terminal still proves this is the active endpoint, preserve its owner while a
    // profile change waits. A changed endpoint is reselected by the caller, with this runtime only
    // detached so it cannot stop the terminal's new owner.
    if (!probe?.changed && online() && this.project.cwd === project.cwd && this.nativeSessionId === session.nativeSessionId
      && (this.status.phase === 'busy' || this.activeTurnId) && !confirmedProfileRestored) {
      this.connection.deferForProfileChange();
      return 'keep';
    }
    return 'replace';
  }

  /**
   * Moves the conversation from this runtime onto `replacement`, which the caller built for the
   * selected profile. The replacement starts first, so a profile that cannot launch never costs the
   * old writer; the old one is released only once it is idle and verified. A failure after the
   * release restores the old profile on a new runtime and keeps the desired profile pending, so an
   * explicit retry attempts it again. Resolves to the runtime that serves the session afterwards.
   */
  async switchProfile(replacement: CodexSessionRuntime, steps: ProfileSwitchSteps): Promise<CodexSessionRuntime> {
    const sessionId = this.session.id;
    let released = false;
    try {
      await replacement.start();
      if (!await this.connection.releaseForProfileSwitch()) { await replacement.dispose(this.host); return this; }
      released = true;
      this.host.updateSession(sessionId, { terminalId: undefined });
      replacement.attachFeed(steps.feed());
      await replacement.openOrResume();
      steps.publish(replacement);
      const updated = this.host.updateSession(sessionId, { configPending: false, terminalId: undefined });
      this.host.emit(sessionId, { type: 'session', session: updated });
      await steps.bind(replacement).catch(error => replacement.profileSwitchFailed(steps.describe(error)));
      await replacement.terminal.ensureTui().catch(error => replacement.profileSwitchFailed(steps.describe(error)));
      steps.succeeded();
      return replacement;
    } catch (error) {
      await replacement.dispose(this.host).catch(() => undefined);
      let restored: CodexSessionRuntime = this;
      if (released) {
        // The failed target never receives user input. Restore the old writer, retain the
        // desired provider and pending flag, and let an explicit retry attempt it again.
        restored = steps.restore();
        try {
          await restored.start();
          await restored.openOrResume({ model: steps.previousModel });
          await steps.bind(restored);
          await restored.terminal.ensureTui();
        } catch { /* The persisted source binding and original thread remain recoverable. */ }
      }
      restored.profileSwitchFailed(steps.describe(error));
      steps.failed();
      throw new AppError('NATIVE_PROFILE_SWITCH_FAILED', steps.describe(error), 502);
    }
  }

  profileSwitchFailed(message: string): void {
    this.refreshStatus({ notice: { text: message, level: 'error', source: 'other' } });
  }

  /**
   * `warm` hands over an app-server with a new thread started ahead of this conversation (`launch.ts`);
   * it is asked only by a conversation that has no thread and no process of its own yet.
   */
  async start(options: { reconnectOnly?: boolean; warm?: () => Promise<CodexWarm | undefined> } = {}): Promise<void> {
    await this.connection.start(options);
    // Opening the app-server socket is not proof that this client owns the native thread. A
    // cold history reader remains offline until it explicitly resumes a confirmed loaded owner.
    this.facts = {
      link: 'offline',
      connection: this.connection.endpointBlocked
        ? this.connection.endpointConnection()
        : this.connection.bindingScopeMismatch
        ? { state: 'conflict', message: `The ${this.label} profile changed. Restore the previous profile or explicitly end its ${this.label} backend, then retry.` }
        : { state: 'disconnected' },
      history: { state: 'loading' },
    };
    this.status = {
      phase: this.turnPhase('offline'),
      connection: this.facts.connection,
      history: this.facts.history,
      ...(this.connection.profilePending ? { profilePending: true } : {}),
    };
    const control = this.runtimeControl();
    if (control) this.status.runtimeControl = control;
  }

  async applyThreadConfig(config: { model?: string; approval?: string; mode?: string }, updateApproval = true): Promise<{ approval?: string; mode?: string }> {
    return await this.settings.applyThreadConfig(config, updateApproval);
  }

  listModels(): Promise<ModelInfo[]> { return this.settings.listModels(); }

  /** Gives Codex the conversation's title when the reader or a model chose one the thread does not carry (`settings.ts`). */
  pushTitle(): Promise<void> { return this.settings.pushTitle(); }

  /** The model the sidecar's control is shown for. */
  private controlModel(status: NativeStatus = this.status): string | undefined {
    return parseNativeModelSelection(status.model ?? this.thread.model ?? this.session.model).model || undefined;
  }

  /** The sidecar's control on this conversation. Plugin code: one that throws shows nothing. */
  private runtimeControl(status?: NativeStatus): NativeRuntimeControl | undefined {
    const attachment = this.connection.attachment;
    if (!attachment?.value.control) return undefined;
    try {
      const control = attachment.value.control({ model: this.controlModel(status) });
      return control ? { ...control, owner: attachment.owner } : undefined;
    } catch { return undefined; }
  }

  async runtimeAction(request: NativeRuntimeActionRequest): Promise<void> {
    this.connection.assertWritable();
    const attachment = this.connection.attachment?.value;
    if (!attachment?.act || !this.transport?.isOnline) throw new AppError('RUNTIME_CONTROL_UNAVAILABLE', 'The native process is not connected to its sidecar', 409);
    try {
      await attachment.act({ ...request, model: this.controlModel() });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('RUNTIME_CONTROL_UNAVAILABLE', 'The sidecar cannot be reached', 503);
    } finally {
      this.refreshStatus();
    }
  }

  subscribe(listener: (message: NativeControlMessage) => void): () => void { return this.sync.subscribe(listener); }

  /** What a reader needs before the poll takes over (`history-sync.ts#prime`). */
  prime(): Promise<void> { return this.sync.prime(); }
  /** One page of `thread/turns/list` over this runtime's connection (`history-sync.ts#turnsPage`). */
  turnsPage(request: CodexTurnsRequest): Promise<CodexTurnPage | undefined> { return this.sync.turnsPage(request); }

  async dispose(host: NativeBackendHost, options: { keepRunning?: boolean } = {}): Promise<void> {
    this.detachObservation?.();
    this.detachObservation = undefined;
    this.dispatch.requestInterrupt();
    this.interactions.close();
    await this.connection.releaseTransport(options.keepRunning);
    if (!options.keepRunning && this.terminalId) await host.terminal.stop(this.terminalId).catch(() => undefined);
    this.connection.markClosed();
    this.log.listeners.clear();
    this.subagents.clear();
    this.drafts.clear();
    this.sync.stop();
    this.activities.dispose();
    this.refreshStatus({ link: 'offline', model: undefined, notice: undefined, connection: { state: 'failed', message: `This ${this.label} client is disconnected.` } });
  }

  hasEmptyHistoryBaseline(threadId: string): boolean { return this.history.materialization?.threadId === threadId; }

  /** Stops a background terminal; `stopping` at once, `stopped` when the provider's list or reply says it is gone. */
  async stopActivity(activityId: string): Promise<NativeActivity> { return await this.activities.stop(activityId); }

  /** Passes this thread's notifications and activity states on to `feed` until the returned function is called. */
  attachFeed(feed: CodexLiveFeed): () => void { return this.log.attachFeed(feed); }

  /** The workbench command a user item answers; see `commandIdOf`. */
  commandOf(item: RpcItem, turnId: string): string | undefined { return this.commandIdOf(item, turnId); }

  /** Native question requests known before this reader attached; answers are never copied. */
  questionRequests(threadId: string): RpcItem[] { return this.interactions.questionHistory.requests(threadId); }

  /** Shared with transcript ingest: history can temporarily misreport our executing turn as interrupted. */
  isTurnRunning(threadId: string, turn: RpcTurn): boolean {
    return this.transport?.isOnline === true && threadId === this.nativeSessionId
      && !this.turns.hasPendingOutcome(turn.id) && this.turns.drives(turn);
  }

  /** Parent ids remain wire-compatible; child request ids are scoped to their native thread. */
  private scopedRequestId(threadId: string | undefined, id: string): string {
    return threadId && threadId !== this.nativeSessionId ? `thread:${encodeURIComponent(threadId)}:${id}` : id;
  }

  /** Writes and interruption of the thread (`dispatch.ts`). */
  get steerTarget(): (NativeTurnTarget & { ownerRunId?: string }) | undefined { return this.dispatch.steerTarget; }
  ownedForegroundTurn(): (NativeTurnTarget & { ownerRunId: string }) | undefined { return this.dispatch.ownedForegroundTurn(); }
  steer(input: Parameters<CodexDispatch['steer']>[0]): Promise<void> { return this.dispatch.steer(input); }
  send(input: SendInput): Promise<{ turnId: string }> { return this.dispatch.send(input); }
  interrupt(targetTurnId?: string, targetThreadId?: string): Promise<void> { return this.dispatch.interrupt(targetTurnId, targetThreadId); }
  requestInterrupt(): void { this.dispatch.requestInterrupt(); }
  recordSubmittedTurn(turnId: string, runId: string, commandId: string): void { this.dispatch.recordSubmittedTurn(turnId, runId, commandId); }

  /** Routes one notification, after the gate released it in order (`notifications.ts`). */
  private onNotification(method: string, params: Record<string, unknown>): void { this.notifications.route(method, params); }

  private async onServerRequest(request: JsonRpcServerRequest): Promise<unknown> {
    const threadId = str(request.params.threadId) ?? this.nativeSessionId;
    if (threadId && threadId !== this.nativeSessionId && !this.subagents.owns(threadId)) {
      throw new Error(`Request belongs to a different ${this.label} thread.`);
    }
    // The owner's files are not the 助理's to change in any mode (docs/ASSISTANT.md §2): the profile has them
    // read-only, and the approval Codex then asks for is declined here, as Claude Code's deny rule does.
    if (request.method === 'item/fileChange/requestApproval') {
      const writes = this.thread.standingWritesOf(str(request.params.itemId) ?? '');
      const standing = writes?.length ? this.thread.standing() : undefined;
      if (standing && writes!.some(path => standingProtects(path, standing))) return { decision: 'decline' };
    }
    const requestId = this.scopedRequestId(threadId, String(request.id));
    const main = threadId === this.nativeSessionId;
    const requestedTurnId = str(request.params.turnId);
    if (main && requestedTurnId && !this.dispatch.nativeCommand) this.turns.bindDispatchedTurn(requestedTurnId);
    return await this.interactions.raise(request, requestId, threadId, main);
  }

  /** The newest proposed plan of a turn, from the transcript, so the reader can see what they approve. */
  private latestPlanText(turnId: string | undefined, threadId = this.nativeSessionId): string | undefined {
    const prefix = turnId ? `${threadId ?? 'unknown'}:${turnId}:` : undefined;
    const events = threadId === this.nativeSessionId ? this.log.events
      : [...this.subagents.values()].find(watch => watch.childId === threadId)?.events ?? [];
    return latestPlanTextOf(events, prefix);
  }

  /** Evidence of live traffic ends `starting` and `offline`; a link that already says work is going on stays. */
  private resumed(): 'quiet' | 'working' { return this.facts.link === 'working' ? 'working' : 'quiet'; }

  /** The only place a phase is computed: an interaction wins, then a tracked turn or other work in progress. */
  private livePhase(working: boolean): 'attention' | 'busy' | 'idle' { return this.interaction ? 'attention' : this.activeTurnId || working ? 'busy' : 'idle'; }

  /** The one place a status is computed, from `facts` (updated by `change` first), the interaction and the active turn. */
  private refreshStatus(change: Partial<typeof this.facts> = {}): void {
    const facts = Object.assign(this.facts, change);
    // Thread failure is a condition, independent of statuses rebuilt by child/interaction events.
    // Once recovered or owned by a failed turn, discard copies of its projected notice.
    if (this.threadError && (!this.threadErrorTurnId || this.turns.settledType(this.threadErrorTurnId) !== 'run_failed')) {
      facts.notice = { text: `${this.label} reported a thread-level system error.`, level: 'error', source: 'thread' };
    } else if (facts.notice?.source === 'thread') facts.notice = undefined;
    const requested = this.interactions.withAsyncQuestion({
      phase: facts.link === 'starting' || facts.link === 'offline' ? facts.link : this.livePhase(facts.link === 'working'),
      ...(facts.model ? { model: facts.model } : {}),
      ...(facts.notice ? { notice: facts.notice.text, noticeLevel: facts.notice.level } : {}),
      ...(this.interaction ? { interaction: this.interaction } : {}),
      ...(facts.connection ? { connection: facts.connection } : {}),
      ...(facts.history ? { history: facts.history } : {}),
      ...(facts.approval ? { approval: facts.approval } : {}),
    });
    const control = this.runtimeControl({ ...this.status, ...requested });
    const turnId = requested.phase === 'busy' || requested.phase === 'attention' ? this.activeTurnId : undefined;
    const next: NativeStatus = withActivity({
      ...requested,
      profilePending: this.connection.profilePending || undefined,
      phase: this.turnPhase(requested.phase),
      ...(turnId ? { activeTurnId: this.turns.turnRun(turnId)?.runId ?? turnId } : {}),
      ...(turnId && this.connection.attached && this.transport?.isOnline && !this.connection.bindingScopeMismatch && !this.connection.endpointBlocked &&
        facts.connection?.state === 'connected' && requested.phase === 'busy' && !this.currentInteraction && this.nativeSessionId
        && supportsSteerVersion(this.transport.serverUserAgent, this.flavor.id)
        ? { activeTurn: { nativeSessionId: this.nativeSessionId, turnId, ...(this.turns.turnRun(turnId)?.runId ? { ownerRunId: this.turns.turnRun(turnId)!.runId } : {}) } } : {}),
      ...(control ? { runtimeControl: control } : {}),
    }, this.activities.ledger.list(), { upgradePhase: false });
    // Compared by content: two paths that build the same status in a different key order (a notice
    // spread before or after the connection) are not a change, and every repeat is a frame to clients.
    if (canonicalJson(next) === canonicalJson(this.status)) return;
    this.status = next;
    this.log.emit({ type: 'status', status: next });
    // Losing (or regaining) the push feed is a gap: read at once rather than at the next slow tick.
    this.sync.statusChanged();
  }

  /** Every phase this runtime publishes passes through its tracker; the app-server protocol is the evidence. */
  private turnPhase(phase: NativeStatus['phase']): NativeStatus['phase'] {
    this.turn.observe({ source: 'protocol', phase: turnPhaseOf(phase), ...(phase === 'busy' && this.activeTurnId ? { turnId: this.activeTurnId } : {}) });
    return this.turn.nativePhase;
  }

  private applyThreadStatus(status: RpcThread['status']): void {
    if (status?.type === 'active') this.history.beginMaterialization();
    // TRAE's thread status aggregates background work. A confirmed foreground end wins until
    // a new native turn starts or a dispatch is in flight; Codex retains its aggregate-active phase.
    const foregroundEnded = this.flavor.id === 'traex' && this.foregroundEndedTurnId !== undefined
      && !this.activeTurnId && !this.dispatchCommandId;
    // Thread status is aggregate evidence. An observed turn keeps its target until its own
    // completion (or a matching terminal history record) arrives, including during retries.
    const phase = this.livePhase(Boolean(this.dispatchCommandId));
    // Only a thread recovery clears its own diagnostic. Transport/history recovery never does.
    if (status?.type === 'active' || status?.type === 'idle') {
      this.threadError = false;
      // Recovery ends the previous error's ownership. An active, unsettled turn is fresh evidence;
      // a historical/foreground end is never evidence for a later, unrelated system error.
      this.threadErrorTurnId = status.type === 'active' ? this.turns.unsettledActiveTurnId : undefined;
    } else if (status?.type === 'systemError') this.threadError = true;
    const update = threadStatusUpdate(status, this.status, this.facts.notice?.source === 'thread', this.interaction, phase, foregroundEnded, Boolean(this.transport?.isOnline));
    // The update's phase says whether the thread reports work beyond a tracked turn; an attention phase leaves that as it was.
    if (update) this.refreshStatus({ link: update.phase === 'offline' ? 'offline' : update.phase === 'attention' ? this.resumed() : update.phase === 'busy' ? 'working' : 'quiet', ...(update.notice ? {} : { notice: undefined }) });
  }

  private onExit(error: Error): void {
    this.dispatch.requestInterrupt();
    this.history.beginMaterialization();
    this.turns.rejectWaiters(turnId => new Error(`${this.label} app-server exited before confirming interruption for turn ${turnId}.`));
    this.interactions.abandon();
    this.drafts.clear();
    this.activities.lost();
    this.log.feedLost();
    this.refreshStatus({ link: 'offline', model: undefined, connection: { state: 'failed', message: safeProviderError(error, this.profileConfig) } });
    // A socket disconnect does not prove the child exited. Keep its handle so a
    // subsequent reopen or service shutdown can dispose it before starting another writer.
  }
}
