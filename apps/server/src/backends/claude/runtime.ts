import { randomUUID } from 'node:crypto';
import { AppError } from '../../errors.js';
import type { NativeActivity, NativeInteraction, NativeInteractionResponse, NativeInteractionResult, NativeRuntimeActionRequest, NativeRuntimeControl, NativeStatus, NativeStopRequest, NativeTurnTarget, Project, Run, Session } from '../../../../../packages/contracts/src/index.js';
import { isLiveActivity, withActivity } from '../../journal/activity.js';
import { DeferredSteerInputs } from '../shared/deferred-steer.js';
import { cliVersionStatus, type CliVersionRange } from '../shared/cli-version.js';
import type { NativeBackendHost, NativeBackendProfileConfig, NativeBackendSendRequest, NativeControlMessage } from '../types.js';
import { ClaudeHookBridge } from './hook-bridge.js';
import { waitFor } from '../shared/wait-for.js';
import { ClaudeStepMetering } from './metering.js';
import { ClaudeTranscript, findClaudeTranscript, type ClaudeTranscriptLifecycle } from './history.js';
import { CLAUDE_TURN_FAILED } from './rows.js';
import { ClaudeTranscriptChanges, ClaudeTranscriptSource } from './transcript-source.js';
import { activeTurnOf, initialState, phaseOf, reduce, replay, type ClaudeProcess, type ClaudeSessionState, type ClaudeSignal, type Transition } from './session-state.js';
import { executableOf, runHelp, backendId, CLAUDE_CLI_VERSIONS, configDirOf } from './launch.js';
import { ComposerDriver, type PendingSend } from './composer.js';
import { ClaudeHookOverlay } from './hook-overlay.js';
import { ClaudeInteractions } from './interactions.js';
import { TranscriptAdoption } from './title-adoption.js';
import { LaunchCrashGuard } from './launch-guard.js';
import { ReadyGate } from './ready-gate.js';
import type { WorkspaceObserver } from '../shared/workspace-observer.js';
import { ClaudeSends, rewriteKey } from './sends.js';
import { ClaudeStops } from './stops.js';
import { ClaudeTerminalBinding } from './binding.js';
import { ClaudeTranscriptReads } from './transcript-reads.js';
import { ClaudeScreenWatch } from './screen-watch.js';
import { ClaudeHookRoutes } from './hook-routes.js';

export { QUICK_EXIT_MS, QUICK_EXIT_LIMIT } from './launch-guard.js';
/**
 * Screen convergence reads the footer's tasks entry and agent rows, which were captured from this version on; older
 * versions the adapter supports may draw them differently, and a misread there would drop live work.
 */
const SCREEN_CONVERGENCE_VERSIONS: CliVersionRange = { minimum: '2.1.302', testedThrough: CLAUDE_CLI_VERSIONS.testedThrough };
/**
 * A turn that is neither ended nor showing any sign of life — no transcript growth, no hook — for this long
 * is reported with a notice. The state is not changed: only a record or a hook ends a turn.
 */
const TURN_SILENCE_MS = 30 * 60_000;
const TURN_SILENCE_NOTICE = 'Claude Code has shown no activity; check the terminal.';
/** The runtime action that applies a picked setting at once, ending the background work its relaunch waits on. */
const APPLY_CONFIG_ACTION = 'apply-config';
const STARTUP_FAILED_MESSAGE = 'Claude Code startup timed out; check the terminal.';

export class ClaudeSessionRuntime {
  readonly nativeSessionId: string;
  readonly transcript: ClaudeTranscript;
  readonly listeners = new Set<(message: NativeControlMessage) => void>();
  /**
   * The conversation's state. Transcript rows and the participating hooks are the only inputs
   * (`session-state.ts` owns the transitions); `status.phase` is read off it and never inferred from the
   * screen. Only `dispatchSignal` and `replay` change it.
   */
  private state: ClaudeSessionState = initialState();
  private current: NativeStatus = { phase: 'offline', transcript: 'unavailable' };
  get status(): NativeStatus { return this.current; }
  private monitorStarted = false;
  /** A dialog the CLI drew itself is on screen. It blocks the CLI, so the phase says so; it is not turn state. */
  private screenAttention = false;
  private readonly readyGate = new ReadyGate({
    phase: () => this.status.phase,
    process: () => this.state.process,
    isDisposed: () => this.disposed,
    onFail: () => { this.setStatus({ ...this.status, notice: STARTUP_FAILED_MESSAGE, noticeLevel: 'error', connection: { state: 'failed', message: STARTUP_FAILED_MESSAGE } }); },
    onOpen: () => { this.dispatchSignal({ type: 'process', process: 'alive' }, { ...this.status, notice: undefined, noticeLevel: undefined }); },
  });
  private readonly launchGuard: LaunchCrashGuard;
  private readonly adoption: TranscriptAdoption;
  private readonly overlay: ClaudeHookOverlay;
  private readonly composer: ComposerDriver;
  private nativeTurn?: NativeTurnTarget & { ownerRunId?: string };
  private readonly steerTools = new Set<string>();
  private readonly steering: DeferredSteerInputs;
  private readonly interactions: ClaudeInteractions;
  private readonly statusWaiters = new Set<() => void>();
  /** Hooks can prove execution before the CLI flushes its assistant/tool rows. */
  private outputPromptId?: string;
  /** Counts the turns that have started, so a stop can tell "my turn ended" from "another began". */
  private turnSeq = 0;
  /** Last sign of life from the CLI (a hook, transcript growth), for the long-silence notice. */
  private lastActivityAt = Date.now();
  private silenceNoticed = false;
  private disposed = false;
  /** When the CLI was first found gone since it last ran (see `exitedAt`). */
  private exitSeen?: string;
  private session: Session;
  private readonly metering: ClaudeStepMetering;

  private readonly sends: ClaudeSends;
  private readonly stops: ClaudeStops;
  private readonly binding: ClaudeTerminalBinding;
  private readonly reads: ClaudeTranscriptReads;
  private readonly watch: ClaudeScreenWatch;
  private readonly hooks: ClaudeHookRoutes;
  constructor(private readonly host: NativeBackendHost, session: Session, private readonly project: Project, profile: NativeBackendProfileConfig, private readonly resumeRequested: boolean, private readonly bridge: ClaudeHookBridge, launchNotice?: string, private readonly changes?: ClaudeTranscriptChanges, private readonly observer?: WorkspaceObserver) {
    this.session = session;
    this.launchGuard = new LaunchCrashGuard({
      host,
      session: () => this.session,
      isDisposed: () => this.disposed,
      isTerminalExited: () => this.binding.terminalExited,
    });
    this.adoption = new TranscriptAdoption({
      host,
      session: () => this.session,
      transcriptState: () => this.transcript.state,
      emit: message => this.emit(message),
    });
    this.composer = new ComposerDriver({
      terminal: host.terminal,
      sessionId: () => this.session.id,
      assertExpectedStop: (stop, terminalId, allowEnded) => this.stops.assertExpectedStop(stop, terminalId, allowEnded),
    });
    this.metering = new ClaudeStepMetering(host, session.id, message => this.emit(message));
    this.interactions = new ClaudeInteractions({
      host,
      project,
      observer,
      session: () => this.session,
      status: () => this.status,
      mainTurn: () => this.state.mainTurn,
      isDisposed: () => this.disposed,
      transcript: () => this.transcript,
      setStatus: status => this.setStatus(status),
      dispatchSignal: (signal, status) => { this.dispatchSignal(signal, status); },
      refreshTranscript: () => this.reads.refreshTranscript(),
      refreshScreenState: () => this.watch.refreshScreenState(),
      clearQuestionHookDue: toolUseId => { this.watch.questionAsked(toolUseId); },
      respondScreenDialog: (response, fingerprint) => this.watch.respondScreenDialog(response, fingerprint),
    });
    this.nativeSessionId = session.nativeSessionId ?? randomUUID();
    this.overlay = new ClaudeHookOverlay({
      host,
      bridge,
      nativeSessionId: this.nativeSessionId,
      project,
      profile: () => this.binding.profile,
      session: () => this.session,
      isDisposed: () => this.disposed,
      onHook: (payload, deliveryId, signal) => this.hooks.handleHook(payload, deliveryId, signal),
    });
    this.steering = new DeferredSteerInputs(host, { backendId, sessionId: session.id, currentTarget: () => this.steerTarget() });
    if (session.terminalId) {
      this.state = initialState('starting');
      this.current = { phase: 'starting', transcript: 'unavailable' };
    }
    this.transcript = new ClaudeTranscript({ ...session, nativeSessionId: this.nativeSessionId }, this.nativeSessionId, {
      precedingConfigDir: configDirOf(profile),
      additionalContext: (text, nativeId, createdAt) => this.steering.receiptEvents(text, nativeId, createdAt),
      commandForUserMessage: message => this.sends.commandForUserMessage(message),
      promptText: prompt => this.sends.rewrites.get(rewriteKey(prompt)),
      putBlob: text => this.host.journal?.putSessionBlob(this.session.id, Buffer.from(text)),
      observedChanges: toolUseId => this.observer?.changes(this.session.id, toolUseId),
      onToolUse: (id, name, input) => this.interactions.onToolUse(id, name, input),
      onToolResult: (toolUseId, failed) => this.interactions.onToolResult(toolUseId, failed),
      // Transcript `model` is a display name ("Sonnet 4.5"), not the alias or id `--model` accepts, so
      // it may only be shown. Following it into the record would leave the next launch with a value
      // Claude Code cannot resolve — the opposite of what reading the CLI's own state is for.
      onModel: model => { this.setStatus({ ...this.status, model }); },
    });
    this.sends = new ClaudeSends({
      composer: this.composer,
      host: this.host,
      nativeSessionId: this.nativeSessionId,
      transcript: this.transcript,
      disposed: () => this.disposed,
      session: () => this.session,
      started: () => this.binding.started,
      state: () => this.state,
      status: () => this.status,
      terminalId: () => this.binding.terminalId,
      assertExpectedStop: (...args) => this.stops.assertExpectedStop(...args),
      endorsesDialog: (...args) => this.watch.endorsesDialog(...args),
      noteActivity: (...args) => this.noteActivity(...args),
      ownPublishedTurn: (...args) => this.ownPublishedTurn(...args),
      refreshTranscript: (...args) => this.reads.refreshTranscript(...args),
      schedulePolling: (...args) => this.watch.schedulePolling(...args),
      stopLateTurn: (...args) => this.stops.stopLateTurn(...args),
      untestedVersion: (...args) => this.untestedVersion(...args),
      waitUntil: (...args) => this.waitUntil(...args),
    });
    this.stops = new ClaudeStops({
      composer: this.composer,
      host: this.host,
      interactions: this.interactions,
      nativeSessionId: this.nativeSessionId,
      sends: this.sends,
      statusWaiters: this.statusWaiters,
      steering: this.steering,
      transcript: this.transcript,
      lastActivityAt: () => this.lastActivityAt,
      nativeTurn: () => this.nativeTurn,
      outputPromptId: () => this.outputPromptId,
      screenAttention: () => this.screenAttention,
      session: () => this.session,
      state: () => this.state,
      status: () => this.status,
      terminalExited: () => this.binding.terminalExited,
      terminalId: () => this.binding.terminalId,
      turnSeq: () => this.turnSeq,
      dispatchSignal: (...args) => this.dispatchSignal(...args),
      publishActivity: (...args) => this.reads.publishActivity(...args),
      refreshTerminalStatus: (...args) => this.binding.refreshTerminalStatus(...args),
      refreshTranscript: (...args) => this.reads.refreshTranscript(...args),
      setStatus: (...args) => this.setStatus(...args),
      untestedVersion: (...args) => this.untestedVersion(...args),
      waitUntil: (...args) => this.waitUntil(...args),
      withdrawPublishedTurn: (...args) => this.withdrawPublishedTurn(...args),
    });
    this.binding = new ClaudeTerminalBinding({
      bridge: this.bridge,
      host: this.host,
      interactions: this.interactions,
      launchGuard: this.launchGuard,
      nativeSessionId: this.nativeSessionId,
      overlay: this.overlay,
      project: this.project,
      readyGate: this.readyGate,
      resumeRequested: this.resumeRequested,
      transcript: this.transcript,
      disposed: () => this.disposed,
      session: () => this.session,
      state: () => this.state,
      status: () => this.status,
      dispatchSignal: (...args) => this.dispatchSignal(...args),
      emit: (...args) => this.emit(...args),
      endorsesDialog: (...args) => this.watch.endorsesDialog(...args),
      idleForRelaunch: (...args) => this.idleForRelaunch(...args),
      quiet: (...args) => this.quiet(...args),
      refreshTranscript: (...args) => this.reads.refreshTranscript(...args),
      setScreenAttention: (...args) => this.setScreenAttention(...args),
      setSession: (...args) => this.setSession(...args),
      setStatus: (...args) => this.setStatus(...args),
    }, profile, session, launchNotice);
    this.reads = new ClaudeTranscriptReads({
      adoption: this.adoption,
      changes: this.changes,
      host: this.host,
      metering: this.metering,
      nativeSessionId: this.nativeSessionId,
      sends: this.sends,
      transcript: this.transcript,
      disposed: () => this.disposed,
      session: () => this.session,
      state: () => this.state,
      status: () => this.status,
      applyLifecycle: (...args) => this.applyLifecycle(...args),
      dispatchSignal: (...args) => this.dispatchSignal(...args),
      emit: (...args) => this.emit(...args),
      noteActivity: (...args) => this.noteActivity(...args),
      setStatus: (...args) => this.setStatus(...args),
    });
    this.watch = new ClaudeScreenWatch({
      binding: this.binding,
      composer: this.composer,
      host: this.host,
      interactions: this.interactions,
      listeners: this.listeners,
      nativeSessionId: this.nativeSessionId,
      reads: this.reads,
      sends: this.sends,
      stops: this.stops,
      transcript: this.transcript,
      disposed: () => this.disposed,
      monitorStarted: () => this.monitorStarted,
      nativeTurn: () => this.nativeTurn,
      screenAttention: () => this.screenAttention,
      session: () => this.session,
      state: () => this.state,
      status: () => this.status,
      checkSilence: (...args) => this.checkSilence(...args),
      dispatchSignal: (...args) => this.dispatchSignal(...args),
      idleForRelaunch: (...args) => this.idleForRelaunch(...args),
      screenConvergenceSupported: (...args) => this.screenConvergenceSupported(...args),
      setScreenAttention: (...args) => this.setScreenAttention(...args),
      setStatus: (...args) => this.setStatus(...args),
    });
    this.hooks = new ClaudeHookRoutes({
      binding: this.binding,
      changes: this.changes,
      host: this.host,
      interactions: this.interactions,
      nativeSessionId: this.nativeSessionId,
      observer: this.observer,
      project: this.project,
      reads: this.reads,
      readyGate: this.readyGate,
      sends: this.sends,
      steerTools: this.steerTools,
      steering: this.steering,
      stops: this.stops,
      transcript: this.transcript,
      watch: this.watch,
      disposed: () => this.disposed,
      nativeTurn: () => this.nativeTurn,
      session: () => this.session,
      state: () => this.state,
      status: () => this.status,
      dispatchSignal: (...args) => this.dispatchSignal(...args),
      emit: (...args) => this.emit(...args),
      finishSteering: (...args) => this.finishSteering(...args),
      markTurnOutput: (...args) => this.markTurnOutput(...args),
      noteActivity: (...args) => this.noteActivity(...args),
      setSession: (...args) => this.setSession(...args),
      setStatus: (...args) => this.setStatus(...args),
      steerTarget: (...args) => this.steerTarget(...args),
    });
  }

  /** Polling the transcript, so each settled response reaches the ledger without a backfill read. */
  get recordsUsage(): boolean { return this.monitorStarted && !this.disposed; }

  async monitor(): Promise<void> {
    if (this.monitorStarted || this.disposed) return;
    this.monitorStarted = true;
    // A CLI that outlived a restart keeps posting hooks; its conversation has to be routable before
    // anything else about it is known. Cold monitoring works from the transcript when this fails.
    if (this.binding.terminalId) await this.overlay.registerHooks().catch(() => undefined);
    const configDir = configDirOf(this.binding.profile);
    const file = await findClaudeTranscript(configDir, this.nativeSessionId);
    if (file) await this.transcript.setFile(file);
    this.watch.schedulePolling();
    await this.reads.refreshTranscript();
    await this.binding.refreshTerminalStatus();
  }

  /**
   * The CLI's version when its screens were never captured (newer than `CLAUDE_CLI_VERSIONS.testedThrough`, or
   * unreadable). Walking a screen over several keys (the footer's agent list, the background task list) is left
   * to the reader on such a version: one misread step there presses keys into a surface nobody checked.
   */
  private async untestedVersion(): Promise<string | undefined> {
    const probe = await runHelp(executableOf(this.binding.profile)).catch(() => undefined);
    return cliVersionStatus(CLAUDE_CLI_VERSIONS, probe?.parsed) === 'supported' ? undefined : probe?.parsed.text ?? 'of an unknown version';
  }

  /** The CLI draws its footer the way screen convergence reads it (`SCREEN_CONVERGENCE_VERSIONS`). */
  private async screenConvergenceSupported(): Promise<boolean> {
    const probe = await runHelp(executableOf(this.binding.profile)).catch(() => undefined);
    return cliVersionStatus(SCREEN_CONVERGENCE_VERSIONS, probe?.parsed) === 'supported';
  }

  /** Nothing is running, waiting or queued: relaunching the CLI would end nothing. `endingBackground`: but for background work. */
  private quiet(endingBackground = false): boolean {
    return this.state.mainTurn.kind === 'idle' && (endingBackground || this.state.background.length === 0) && this.state.cliQueue.length === 0;
  }

  private idleForRelaunch(endingBackground = false): boolean {
    return this.state.process === 'alive' && !this.screenAttention && this.quiet(endingBackground);
  }

  /**
   * A picked setting whose relaunch only background work holds back: the reader is told, and offered to apply it
   * now. Messages queued meanwhile wait for the relaunch (`lane.ts#admission`), so without this a background
   * task that never ends (a dev server) would hold them with nothing on screen saying why.
   */
  private relaunchControl(): NativeRuntimeControl | undefined {
    if (!this.state.background.length || !this.idleForRelaunch(true) || !this.host.getSession(this.session.id).configPending) return undefined;
    return {
      owner: backendId, revision: `${APPLY_CONFIG_ACTION}:${this.binding.terminalId ?? ''}`,
      notice: {
        tone: 'neutral',
        label: { 'zh-Hans': '新设置在后台任务结束后生效', en: 'New settings apply once background tasks finish' },
        action: { id: APPLY_CONFIG_ACTION, label: { 'zh-Hans': '结束后台任务并应用', en: 'End background tasks and apply' } },
      },
    };
  }

  async runtimeAction(request: NativeRuntimeActionRequest): Promise<void> {
    const control = this.relaunchControl();
    if (request.action !== APPLY_CONFIG_ACTION || !control || request.revision !== control.revision) {
      throw new AppError('RUNTIME_CONTROL_UNAVAILABLE', 'The new settings were already applied or can no longer be applied this way', 409);
    }
    try { await this.binding.applyPendingConfig(true); }
    finally { this.setStatus({ ...this.status }); }
  }

  subscribe(listener: (message: NativeControlMessage) => void): () => void {
    this.listeners.add(listener);
    this.watch.schedulePolling();
    queueMicrotask(() => {
      if (!this.listeners.has(listener)) return;
      if (this.hooks.context) this.safeCall(listener, { type: 'context', context: this.hooks.context });
      this.safeCall(listener, { type: 'status', status: this.status });
    });
    return () => this.unsubscribe(listener);
  }

  unsubscribe(listener: (message: NativeControlMessage) => void): void {
    this.listeners.delete(listener);
    this.watch.schedulePolling();
  }

  private safeCall(listener: (message: NativeControlMessage) => void, message: NativeControlMessage): void {
    try { listener(message); } catch { /* A disconnected stream does not stop the CLI watcher. */ }
  }

  private emit(message: NativeControlMessage): void {
    for (const listener of this.listeners) this.safeCall(listener, message);
  }

  /** `NativeStatus.phase`: the process and the main turn, plus a dialog that blocks the CLI itself. */
  private phase(): NativeStatus['phase'] {
    const phase = phaseOf(this.state);
    return this.screenAttention && phase !== 'offline' ? 'attention' : phase;
  }

  /**
   * The live turn as clients group the transcript: the app Run that owns it, the prompt id every row of a
   * turn the CLI opened on its own carries as `nativeTurnId` (a peer's hand-back, a prompt typed in the
   * terminal), or for a task report's turn, whose rows carry no `nativeTurnId`, the `runId` they do carry.
   * Without it a client has to guess the turn from the latest visible prompt — and a turn opened by a hidden
   * row has none, so its rows read as finished while the CLI is still working.
   */
  private activeTurnId(phase: NativeStatus['phase']): string | undefined {
    if (phase !== 'busy' && phase !== 'attention') return undefined;
    const promptId = activeTurnOf(this.state.mainTurn)?.promptId;
    if (!promptId) return undefined;
    if (this.reads.journalTurn?.promptId === promptId && this.reads.journalTurn.turnId !== promptId) return this.reads.journalTurn.turnId;
    if (this.nativeTurn?.turnId === promptId && this.nativeTurn.ownerRunId) return this.nativeTurn.ownerRunId;
    return this.transcript.rowTurnOf(promptId) ?? promptId;
  }

  /** Publish everything but the phase, which always comes from the state. */
  private setStatus(requested: Omit<NativeStatus, 'phase'>): void {
    const phase = this.phase();
    if (phase !== 'starting') this.readyGate.clear();
    // The launch failure is only true while the launch has not recovered.
    const { activeTurn: _oldTarget, activeTurnId: _oldTurnId, phase: _ignored, runtimeControl: _oldControl, connection, notice: requestedNotice, noticeLevel: requestedLevel, interaction: requestedInteraction, ...withoutInteraction } = requested as NativeStatus;
    // A card the CLI raised through a hook lives exactly as long as the request behind it: a status built before the request
    // went away must not bring it back.
    const interaction = requestedInteraction?.transport === 'protocol' && !this.interactions.has(requestedInteraction.id) ? undefined : requestedInteraction;
    const rest = { ...withoutInteraction, ...(interaction ? { interaction } : {}) };
    // The long-silence notice is withdrawn as soon as the CLI shows life or the turn ends.
    const notice = requestedNotice === TURN_SILENCE_NOTICE && !this.silenceNoticed ? undefined : requestedNotice;
    const activeTurnId = this.activeTurnId(phase);
    const runtimeControl = this.relaunchControl();
    // Background work and compaction in progress, independent of the main turn. A CLI that has exited has none: its tasks died with it.
    const status: NativeStatus = withActivity({ ...rest, ...(notice !== undefined ? { notice, noticeLevel: requestedLevel } : {}), ...(activeTurnId ? { activeTurnId } : {}), phase, transcript: this.transcript.state,
      ...(connection && !(phase !== 'starting' && connection.state === 'failed') ? { connection } : {}), ...(this.nativeTurn && (phase === 'busy' || phase === 'attention') ? { activeTurn: this.nativeTurn } : {}),
      ...(runtimeControl ? { runtimeControl } : {}) },
    this.state.process === 'exited' ? [] : this.transcript.activities(), { upgradePhase: false });
    if (JSON.stringify(this.status) === JSON.stringify(status)) return;
    this.current = status;
    this.emit({ type: 'status', status });
    this.watch.schedulePolling();
  }

  /**
   * Feed one signal to the state, carry out what the transition means, and publish. `status` is what
   * to publish alongside; the phase in it is always the state's.
   */
  private dispatchSignal(signal: ClaudeSignal, status?: Omit<NativeStatus, 'phase'>): Transition {
    const transition = reduce(this.state, signal);
    this.state = transition.state;
    if (transition.ended) this.onTurnEnded(transition.ended);
    if (transition.started) this.onTurnStarted(transition.started);
    if (transition.queue) this.sends.onQueue(transition.queue);
    if (signal.type === 'process') this.onProcess(signal.process);
    if (signal.type === 'compact_boundary' || signal.type === 'agents_killed') this.noteActivity();
    // The boundary completes the compaction its hook started; one a remap of the file lost track of is completed with it.
    if (signal.type === 'compact_boundary') {
      for (const activity of this.transcript.activities()) if (activity.kind === 'compaction' && isLiveActivity(activity)) this.reads.publishActivity({ ...activity, status: 'completed' });
    }
    // The callbacks above publish on their own (a turn that ends clears the card it left open): the status that goes out
    // is the one they left, not the one from before them.
    this.setStatus(status ?? this.status);
    for (const wake of [...this.statusWaiters]) wake();
    return transition;
  }

  /**
   * Take a transcript read into the state. A first read (or a rewritten file) is the whole conversation:
   * the state is re-derived from it without carrying out any of the transitions along the way — they
   * are history. What is still open at its end is what the CLI is doing now.
   */
  private async applyLifecycle(lifecycle: ClaudeTranscriptLifecycle): Promise<void> {
    if (lifecycle.replay) {
      const previous = this.state;
      let state = replay(this.state, lifecycle.signals);
      const turn = activeTurnOf(state.mainTurn);
      if (turn?.promptId && this.binding.terminalId && this.host.transcript) {
        const promptId = turn.promptId;
        const closed = await this.host.transcript.withSource(this.session.id, (source, w) => source instanceof ClaudeTranscriptSource && source.closedPrompt(w, promptId));
        // A stop before the first answer need not write anything to JSONL. Its journal cursor is durable;
        // old versions could, however, confirm without inspecting the terminal, so verify its native idle
        // surface too. A busy CLI or another prompt is never hidden by an old cancellation.
        const idle = closed && await this.stops.stopIdleScreen(this.binding.terminalId);
        // Hooks may have advanced the state while the journal/terminal was read.
        if (this.state !== previous) state = replay(this.state, lifecycle.signals);
        if (idle && activeTurnOf(state.mainTurn)?.promptId === promptId) state = reduce(state, { type: 'turn_end', source: 'hook', reason: 'interrupted', promptId }).state;
      }
      this.state = state;
      if (this.nativeTurn && this.nativeTurn.turnId !== activeTurnOf(state.mainTurn)?.promptId) {
        this.nativeTurn = undefined;
        this.steerTools.clear();
      }
      this.setStatus(this.status);
      for (const wake of [...this.statusWaiters]) wake();
      return;
    }
    for (const signal of lifecycle.signals) this.dispatchSignal(signal);
  }

  /** The record as the running CLI was last launched or last reported itself. */
  private setSession(session: Session): void { this.session = session; }

  /** A dialog the CLI drew itself is, or is no longer, on screen. */
  private setScreenAttention(shown: boolean): void { this.screenAttention = shown; }

  /** A tool hook of the running prompt arrived: the turn is executing, whatever the rows show yet. */
  private markTurnOutput(promptId: string | undefined): void { this.outputPromptId = promptId; }

  /** Takes the published turn down, with the tools a steer was waiting on, and returns what it was. */
  private withdrawPublishedTurn(): (NativeTurnTarget & { ownerRunId?: string }) | undefined {
    const target = this.nativeTurn;
    this.nativeTurn = undefined;
    this.steerTools.clear();
    return target;
  }

  /** Names the run the published turn belongs to, when it is the turn `promptId` names (or no prompt is named). */
  private ownPublishedTurn(promptId: string | undefined, runId: string): void {
    if (this.nativeTurn && (!promptId || this.nativeTurn.turnId === promptId)) this.nativeTurn = { ...this.nativeTurn, ownerRunId: runId };
  }

  private onTurnStarted(started: NonNullable<Transition['started']>): void {
    this.noteActivity();
    this.outputPromptId = undefined;
    this.turnSeq += 1;
    if (started.source === 'hook' && started.promptId && this.state.process !== 'exited') {
      this.nativeTurn = { nativeSessionId: this.nativeSessionId, turnId: started.promptId, ...(this.sends.activeWebTurn ? { ownerRunId: this.sends.activeWebTurn.runId } : {}) };
    } else if (started.source === 'transcript' && started.promptId && !this.nativeTurn && this.state.process !== 'exited') {
      // A cold start replays the transcript, so a turn that was already running is announced by its
      // own rows, not by the hook that opened it. The status still has to name that turn: a Run the
      // restart left unconfirmed is resumed only by activity of this exact session and turn.
      this.nativeTurn = { nativeSessionId: this.nativeSessionId, turnId: started.promptId };
    }
    // A row that opened the turn after the CLI took it off its own queue names the send it belongs to.
    if (started.source === 'transcript' && started.uuid) this.sends.rowOpenedTurn(started.uuid, started.promptId);
  }

  /** Whatever ended the turn closes everything that hung on it, now, without asking the screen. */
  private onTurnEnded(ended: NonNullable<Transition['ended']>): void {
    this.noteActivity();
    // A compaction that ends any way but its boundary did not finish; the rows may say so later, the hook says so now.
    if (ended.compact && (ended.reason === 'stop_failure' || ended.reason === 'interrupted')) this.reads.settleCompactions(ended.reason === 'interrupted' ? 'stopped' : 'failed');
    const target = this.nativeTurn;
    this.nativeTurn = undefined;
    this.steerTools.clear();
    if (this.interactions.hasPending()) this.interactions.cancelPending('Claude returned to its prompt without confirming the submitted response.');
    const outcome = ended.reason === 'stop_failure' ? 'run_failed' : ended.reason === 'interrupted' || this.stops.interrupting ? 'run_cancelled' : ended.reason === 'exit' ? 'run_failed' : 'run_completed';
    const reason = ended.reason === 'interrupted' || this.stops.interrupting ? 'Claude confirmed that the turn was interrupted.'
      : ended.reason === 'exit' ? 'Claude hook connection was lost.' : undefined;
    this.steering.reject(ended.reason === 'exit' ? 'Claude hook connection was lost.' : 'Claude finished before receiving further guidance.', target);
    const error = ended.reason === 'stop_failure' ? ended.error ?? CLAUDE_TURN_FAILED : undefined;
    if (target) this.steering.finish(target, { type: outcome, ...(reason ? { reason } : {}), ...(error ? { error } : {}) });
    const web = this.sends.takeWebTurn();
    if (web && ended.reason !== 'exit') {
      // An end the transcript records (an answer's duration row, the API error a failure writes, the next prompt) settles
      // the Run through the journal's turn mark.
      const marked = !this.stops.interrupting && (ended.reason === 'stop' || ended.reason === 'duration' || ended.reason === 'superseded' || ended.reason === 'stop_failure');
      this.sends.emitRunTerminal(outcome, web, error, reason, marked);
    }
  }

  private onProcess(process: ClaudeProcess): void {
    if (process === 'exited') {
      this.interactions.cancelPending('Claude Code terminal exited before confirming the response.');
      this.sends.dropQueued();
      this.reads.abandonActivities();
      if (!this.exitSeen) {
        this.exitSeen = new Date().toISOString();
        this.host.transcript?.wake(this.session.id);
      }
    } else this.exitSeen = undefined;
    if (process === 'starting') this.screenAttention = false;
  }

  /**
   * Since when the CLI is known to be gone, while it is. The journal's reader ends the turn and the activities it left
   * open as of then, once it has read what is on disk (`ClaudeTranscriptSource`), however much later that read comes.
   */
  get exitedAt(): string | undefined { return this.exitSeen; }

  /** Any sign of life from the CLI: the long-silence notice is withdrawn. */
  private noteActivity(): void {
    this.lastActivityAt = Date.now();
    this.watch.wakePolling(this.lastActivityAt);
    if (!this.silenceNoticed) return;
    this.silenceNoticed = false;
    this.setStatus(this.status);
  }

  /** A turn that neither ends nor shows life for a very long time is said out loud; its state is left alone. */
  private checkSilence(): void {
    const turn = activeTurnOf(this.state.mainTurn);
    if (!turn || this.interactions.hasPending() || this.silenceNoticed || Date.now() - this.lastActivityAt < TURN_SILENCE_MS) return;
    this.silenceNoticed = true;
    this.setStatus({ ...this.status, notice: TURN_SILENCE_NOTICE, noticeLevel: 'warning' });
  }


  private steerTarget(): NativeTurnTarget | undefined {
    const current = this.host.getSession(this.session.id);
    // Guidance answers this turn's tool hooks: a CLI this service did not launch (a restart) takes it once they arrive here.
    return (this.binding.started || this.outputPromptId === this.nativeTurn?.turnId) && !this.disposed && !this.binding.terminalExited && !this.stops.interrupting
      && this.overlay.registered && current.terminalId === this.binding.terminalId
      && current.nativeSessionId === this.nativeSessionId
      && (this.status.phase === 'busy' || this.status.phase === 'attention') ? this.nativeTurn : undefined;
  }

  steer(request: NativeBackendSendRequest & { target: NativeTurnTarget }, renderedText: string): { deferred: true } {
    return this.steering.enqueue(request, renderedText, { terminalId: this.binding.terminalId, ...(this.nativeTurn?.ownerRunId ? { ownerRunId: this.nativeTurn.ownerRunId } : {}) });
  }

  private finishSteering(type: 'run_completed' | 'run_failed' | 'run_cancelled', reason?: string): void {
    const target = this.nativeTurn;
    if (target) this.steering.finish(target, { type, ...(reason ? { reason } : {}) });
    this.nativeTurn = undefined;
    this.steerTools.clear();
  }

  /**
   * Waits for `done`, re-reading the transcript so a record written now is seen now. The condition is read once
   * more after the window and the window gives back time the event loop lost (`waitFor`).
   */
  private async waitUntil(done: () => boolean, timeoutMs: number, probe?: () => Promise<boolean>): Promise<boolean> {
    if (done()) return true;
    const reached = await waitFor(async () => {
      await this.reads.refreshTranscript().catch(() => undefined);
      await probe?.().catch(() => undefined);
      return done() ? true : undefined;
    }, { timeoutMs, intervalMs: 250, wake: notify => { this.statusWaiters.add(notify); return () => { this.statusWaiters.delete(notify); }; } });
    return reached === true;
  }

  /**
   * The id `/clear` moved the CLI to. This observer belongs to the id it was made for, so the backend replaces it
   * with one for the new id (the same CLI, taken over as after a restart) before the next message.
   */
  get clearedTo(): string | undefined { return this.hooks.clearedTo; }
  get terminalId(): string | undefined { return this.binding.terminalId; }
  /** Whether this process launched or took over the CLI; the tests set it to stand in for a restart. */
  get started(): boolean { return this.binding.started; }
  set started(value: boolean) { this.binding.started = value; }
  get profileId(): string { return this.binding.profileId; }
  start(): Promise<{ nativeSessionId: string; terminalId?: string }> { return this.binding.start(); }
  setStartRequested(): Promise<void> { return this.binding.setStartRequested(); }
  isLive(): boolean { return this.binding.isLive(); }
  setConfiguring(configuring: boolean): void { this.binding.setConfiguring(configuring); }
  launchedMatches(next: Session, profile?: NativeBackendProfileConfig): boolean { return this.binding.launchedMatches(next, profile); }
  /** A pick was recorded; the status says whether its relaunch waits on background work. */
  deferConfig(): void { this.binding.deferConfig(); this.setStatus({ ...this.status }); }
  useProfile(profile: NativeBackendProfileConfig): void { this.binding.useProfile(profile); }
  reconfigure(next: Session, profile?: NativeBackendProfileConfig): Promise<{ nativeSessionId: string; terminalId?: string }> { return this.binding.reconfigure(next, profile); }
  /** Reads the saved terminal now, as the tests ask for it. */
  refreshTerminalStatus(force?: boolean): Promise<void> { return this.binding.refreshTerminalStatus(force); }
  canReleaseInput(run: Run): Promise<boolean> { return this.watch.canReleaseInput(run); }
  endorsesDialog(dialog: NativeInteraction): boolean { return this.watch.endorsesDialog(dialog); }
  /** The screen read in flight and the two reads the tests drive by hand. */
  get screenDialogTask(): Promise<void> | undefined { return this.watch.screenDialogTask; }
  refreshScreenState(): Promise<void> { return this.watch.refreshScreenState(); }
  convergeBackground(screen: string): Promise<void> { return this.watch.convergeBackground(screen); }
  /** Reads the transcript now; the recorder and the tests ask for it. */
  refreshTranscript(follow?: boolean): Promise<void> { return this.reads.refreshTranscript(follow); }
  send(request: NativeBackendSendRequest, options: { deliverText?: string; command?: boolean } = {}): Promise<void> { return this.sends.send(request, options); }
  requestInterrupt(): void { this.sends.requestInterrupt(); }
  interrupt(options: { clearPrompt?: boolean; expectedStop?: NativeStopRequest } = {}): Promise<void> { return this.stops.interrupt(options); }
  stopActivity(activityId: string): Promise<NativeActivity> { return this.stops.stopActivity(activityId); }
  releaseQueuedInput(commandId: string): void { this.sends.releaseQueuedInput(commandId); }
  commandForUserMessage(message: { uuid: string; promptId?: string; text: string }): string | undefined { return this.sends.commandForUserMessage(message); }
  get rewrites(): Map<string, string> { return this.sends.rewrites; }
  /** The send in flight, as the tests read it. */
  get pendingSend(): PendingSend | undefined { return this.sends.pendingSend; }

  respond(response: NativeInteractionResponse): Promise<NativeInteractionResult> { return this.interactions.respond(response); }

  extendInteraction(interactionId: string): NativeInteraction { return this.interactions.extendInteraction(interactionId); }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    // Closing this observer (including a service restart) does not stop the persistent CLI.
    // Receipted inputs keep their result open for the next observer; only unwritten input is rejected.
    this.steering.reject('Claude hook connection was closed.');
    this.disposed = true;
    this.interactions.cancelPending('Claude runtime was closed.');
    this.watch.dispose();
    this.binding.dispose();
    this.sends.dispose();
    this.launchGuard.dispose();
    this.listeners.clear();
    const overlayDisposed = this.overlay.dispose();
    this.readyGate.clear();
    await overlayDisposed;
  }
}
