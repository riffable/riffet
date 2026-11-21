import { isAssistantBackend } from '../../../../packages/contracts/src/assistant-choice.js';
import type { NativeDeliveryState, NativeQueue, NativeRunRecovery, NativeStatus, NativeStopRequest, NativeWorkbenchEvent, Run, Session, TerminalInfo } from '../../../../packages/contracts/src/index.js';
import { samePromptText } from '../../../../packages/contracts/src/prompt-match.js';
import type { Store } from '../store.js';
import type { WorkspaceService } from '../workspace/index.js';
import type { NativeBackendTraits } from '../backends/types.js';
import { AppError, UNSPECIFIED_NATIVE_RUN_FAILURE } from '../errors.js';
import { isAgentTerminal } from '../terminal/kinds.js';
import { redactSensitiveText } from '../settings/config-documents.js';
import { admission, heldByProvider, holdsUnconfirmed, nextLook, queueOf, steerTurnEnded, type Admission } from './lane.js';
import type { DispatchObservation, NativeDispatcherBackend } from './dispatch.js';
import { ExecutionAdapter, type TurnDeliveryResult } from './execution-adapter.js';
import { Mailbox } from './mailbox.js';
import { assertStopBinding, readStopReceipt, saveStopReceipt, stopFingerprint, type StopReceipt } from './stop-receipt.js';
import { DispatchTrace, phaseOf, type DispatchTraceEntry, type SessionPhase } from './trace.js';

const now = () => Date.now();
/** The turn an event speaks for: a steer's receipt names its target, whatever turn its row was grouped into. */
const turnOf = (event: NativeWorkbenchEvent) => event.type === 'native_input_receipt' && typeof event.data.targetTurnId === 'string' ? event.data.targetTurnId : event.nativeTurnId;
/**
 * How long a message may keep bouncing off a CLI that is not at a prompt *and* is not running a turn
 * (still starting, or a screen we cannot read) before it is failed. Waiting behind a live turn is the
 * queue working as intended and is never counted; this only bounds a wedge that would otherwise retry
 * silently for ever. Longer than a cold Claude Code start with MCP servers and a large resume.
 */
const CLI_BUSY_LIMIT_MS = 3 * 60_000;
/**
 * How long a provider may report idle with no active turn before a run still tracked as `observed`
 * is closed as interrupted. Short enough that a lost completion event stops pinning the session as
 * busy; long enough to ride out the gap between a turn's last status and its completion event.
 */
const IDLE_RECONCILE_MS = 15_000;
/**
 * How long a run that is already waiting for its turn outcome may stay idle before it is closed as
 * unconfirmed. The plain idle window is too short for a Stop hook chain: hooks other than ours run
 * after the turn ends, and the outcome (`turn_duration` in Claude's log, `turn/completed` for
 * Codex) only lands once they finish. Closing at 15 s would show "result unconfirmed" and then
 * correct itself when that outcome arrives. Still bounded, so a truly lost outcome cannot pin the
 * session for ever.
 */
const IDLE_OUTCOME_GRACE_MS = 60_000;
/** Outcomes remembered per session; the journal is authority again after the actor is evicted. */
const OUTCOME_MEMORY = 256;

/** Whether the CLI answers this run in its own pane: the provider's verdict when it gave one, else a leading `/`. */
function isSlashCommand(native: NonNullable<Run['native']>): boolean {
  return native.slashCommand ?? native.input.text.trimStart().startsWith('/');
}

/** A replayable native outcome may refine lost-result recovery, never a user's resolution. */
function canApplyTurnOutcome(run: Run): boolean {
  const native = run.native;
  if (!native || ['completed', 'failed', 'cancelled'].includes(run.state)
    || ['acknowledged', 'cancelled', 'steer_rejected', 'steer_stopped'].includes(native.stage ?? '')
    || native.delivery === 'failed') return false;
  return native.delivery !== 'cancelled'
    || run.state === 'interrupted' && ['turn_outcome_unknown', 'runtime_exit'].includes(native.stage ?? '');
}

const isTurnOutcome = (event: NativeWorkbenchEvent) => ['run_completed', 'run_failed', 'run_cancelled', 'native_turn_reopened'].includes(event.type);
const outcomeRevision = (event: NativeWorkbenchEvent): number => Number.isSafeInteger(event.data.outcomeRevision) && Number(event.data.outcomeRevision) > 0 ? Number(event.data.outcomeRevision) : 1;

export interface SessionDispatchOptions {
  intervalMs?: number;
  confirmationMs?: number;
  beforeTurn?: (session: Session, run: Run, since: number) => Promise<unknown>;
  busyLimitMs?: number;
  idleReconcileMs?: number;
  idleOutcomeGraceMs?: number;
  /** Where phase and delivery changes are reported (`trace.ts`). Absent: nothing is traced. */
  log?: (entry: DispatchTraceEntry) => void;
}

/**
 * What a conversation's mailbox carries. `wake`: look at the queue and the deadlines again (a new
 * message, a timer, an operation that finished). `observation`: events or a status from the provider.
 * `settle`: a command that does not itself dispatch has returned.
 */
type ActorMessage =
  | { type: 'wake' }
  | { type: 'observation'; sessionId: string; observation: DispatchObservation }
  | { type: 'settle' };

/**
 * Whether an unfinished native run still needs a standing live watch on its provider.
 * A steer whose target turn already ended (`queueReleasedAt`) can never run in a later turn, so
 * it must not pin the provider watch or keep an idle CLI from being reclaimed; late journal
 * receipts still settle it through `subscribeCorrections`.
 */
export function runNeedsDispatchWatch(run: Run): boolean {
  return !(run.native?.intent === 'steer' && Boolean(run.native.queueReleasedAt));
}

/** Process-wide services a session actor may use. Cross-session state stays on the coordinator. */
export interface SessionActorHost {
  readonly store: Store;
  readonly native: NativeDispatcherBackend;
  readonly runtime: {
    withSession<T>(sessionId: string, operation: () => Promise<T>): Promise<T>;
    ensure(session: Session, options?: { initialPrompt?: string; beforeSpawn?: () => void | Promise<void> }): Promise<unknown>;
  };
  readonly workspace: WorkspaceService;
  readonly options: SessionDispatchOptions;
  readonly closed: boolean;
  draining(): boolean;
  workspaceReserved(session: Session): boolean;
  workspaceBusy(): AppError;
  onIdle(sessionId: string, actor: SessionActor): void;
  current(sessionId: string): SessionActor | undefined;
}

/**
 * One conversation's dispatch mailbox: its in-flight work, retry and confirmation deadlines, and the
 * single timer that wakes it. Idle actors are dropped by the coordinator so a long-lived process does
 * not keep a timer and an observer for every session it has ever touched.
 *
 * Everything that reaches the conversation from outside — a wake, a provider observation, a settled
 * command — goes through `post` and is handled one message at a time, in arrival order. A message
 * that arrives while another is being handled waits its turn; no handler runs inside another. The
 * asynchronous operations (a delivery, a steer, a stop, a recovery read) run under the session lock
 * and come back through the same mailbox when they observe something or finish.
 */
export class SessionActor {
  /** The delivery worker, when one holds this conversation. Replaces the coordinator's worker and lease maps. */
  worker: Promise<void> | undefined;
  /** Live provider subscription. Cleared when the conversation has nothing unfinished left to watch. */
  unsubscribeObserver: (() => void) | undefined;
  /** When a queued run may be tried again, in epoch ms. */
  readonly nextAttempt = new Map<string, number>();
  /** Explicit /start calls overlapped while provider startup awaits I/O. */
  startReservations = 0;
  /** A confirmed interrupt fences delivery and idle reconciliation until it settles. */
  interrupting = false;
  interruptionTask: { commandId?: string; fingerprint?: string; task: Promise<Run | undefined> } | undefined;
  /** Per-run recovery reads. Keyed by `[sessionId, runId]` so a repeated check joins the one in flight. */
  readonly recoveryChecks = new Map<string, Promise<NativeRunRecovery>>();
  /** A recovery action (release, or replaying a stop receipt) holds the conversation. */
  recoveryActive = false;
  readonly steerTasks = new Map<string, Promise<Run>>();
  readonly pendingSteerOutcomes = new Map<string, NativeWorkbenchEvent>();
  /** Native Stop can precede the transcript row that identifies its ordinary execution owner. Keyed by `[nativeSessionId, turnId]`. */
  readonly pendingTurnOutcomes = new Map<string, NativeWorkbenchEvent>();
  /** Ephemeral revision fences. Keyed by `[nativeSessionId, turnId]`; the journal supplies authority again after eviction. */
  readonly turnOutcomeRevisions = new Map<string, number>();
  readonly hookedTurns = new Set<string>();
  /** When each observed run was first seen with an idle, turn-less provider (see `IDLE_RECONCILE_MS`). */
  readonly idleSince = new Map<string, number>();
  /** Steers that arrived during a drain, sent once it ends. */
  readonly drainHeldSteers = new Set<string>();
  /** The one deadline timer for this conversation. Absent when nothing is waiting on the clock. */
  timer: NodeJS.Timeout | undefined;

  private timerAt: number | undefined;
  /** A wake right behind another looks at nothing new, and a wake also does what a settle does. */
  private readonly mailbox = new Mailbox<ActorMessage>(message => this.receive(message),
    (last, next) => next.type !== 'observation' && (last.type === 'wake' || last.type === next.type),
    (message, error) => console.warn(`[dispatch] a queued ${message.type} for ${this.sessionId} failed:`, error));
  private waking = false;
  private subscribing = false;
  /** A completion is allowed to deliver the rest of the current turn's events before the watch is dropped. */
  private idleQueued = false;
  private readonly traced: DispatchTrace | undefined;

  private readonly adapter: ExecutionAdapter;

  constructor(private readonly host: SessionActorHost, readonly sessionId: string) {
    this.adapter = new ExecutionAdapter({
      store: host.store,
      native: host.native,
      runtime: host.runtime,
      workspace: host.workspace,
      traits: backendId => (backendId && host.native.traits?.(backendId)) || {},
    });
    if (host.options.log) this.traced = new DispatchTrace(sessionId, host.options.log);
  }

  private get store() { return this.host.store; }
  private get native() { return this.host.native; }
  private get runtime() { return this.host.runtime; }
  private get options() { return this.host.options; }

  /** No unfinished work, no in-flight operation, and no timer left to fire. */
  isIdle(runs = this.store.listUnfinishedNativeRuns(this.sessionId)): boolean {
    return !runs.some(runNeedsDispatchWatch) && this.worker === undefined && !this.interrupting && this.interruptionTask === undefined
      && !this.recoveryActive && this.recoveryChecks.size === 0 && this.steerTasks.size === 0
      && this.startReservations === 0 && this.drainHeldSteers.size === 0 && this.timer === undefined;
  }

  /** A restore/merge must wait for a delivery, start, steer, or stop already in this conversation. */
  blocksWorkspace(): boolean {
    return this.worker !== undefined || this.startReservations > 0 || this.steerTasks.size > 0 || this.interrupting;
  }

  /** Where the conversation's queue stands, read against the status it goes out with. */
  queue(status: NativeStatus): NativeQueue {
    return queueOf(this.admission(this.sessionId, this.store.listUnfinishedNativeRuns(this.sessionId), status));
  }

  /** Ask for a scheduling step. It runs now, or after the message being handled. */
  step(): void { this.mailbox.post({ type: 'wake' }); }
  /** What the provider reported. Applied now, or after the message being handled. */
  observe(sessionId: string, message: DispatchObservation): void { this.mailbox.post({ type: 'observation', sessionId, observation: message }); }

  /** Arm the timer and drop this actor once a command that does not itself dispatch has settled. */
  settle(): void { this.mailbox.post({ type: 'settle' }); }

  private receive(message: ActorMessage): void {
    if (message.type === 'wake') { this.wake(); return; }
    if (message.type === 'settle') {
      if (!this.host.closed && this.attached()) this.finish(false, message.type);
      return;
    }
    if (this.host.closed) return;
    // A status or correction that arrives on its own arms the next deadline once it is applied.
    try { this.apply(message.sessionId, message.observation); }
    finally { this.finish(false, message.type); }
  }

  /** Run one scheduling step: admit a queued run, then apply confirmation and idle deadlines that are already due. */
  private wake(): void {
    if (this.host.closed || !this.attached()) return;
    let startedIdle = false;
    try {
      let runs = this.store.listUnfinishedNativeRuns(this.sessionId);
      // A watch is released only once a later step finds the conversation already finished. The step
      // that observed the completion keeps it, so the rest of that turn's events still have a listener.
      startedIdle = !runs.some(runNeedsDispatchWatch);
      if (startedIdle) this.dropObserver();
      const unfinishedIds = new Set(runs.map(run => run.id));
      for (const id of this.nextAttempt.keys()) if (!unfinishedIds.has(id)) this.nextAttempt.delete(id);
      for (const id of this.pendingSteerOutcomes.keys()) if (!unfinishedIds.has(id)) this.pendingSteerOutcomes.delete(id);
      for (const id of this.idleSince.keys()) if (!unfinishedIds.has(id)) this.idleSince.delete(id);
      if (!this.host.draining()) this.resumeDrainHeldSteers();
      let session: Session;
      try { session = this.store.getSession(this.sessionId); }
      catch { return; }
      if (!this.host.workspaceReserved(session)) {
        // Opening the watch resolves the conversation's profile, which may no longer exist. That is this
        // conversation's problem: it goes on unobserved, and the send below fails its queued run with the same error.
        if (runs.some(runNeedsDispatchWatch)) this.ensureObserver();
        if (!this.native.pending?.(session.backendId ?? '')) {
          if (this.releaseEndedSteers(runs)) runs = this.store.listUnfinishedNativeRuns(this.sessionId);
          if (this.sendOrphanedSteers(this.sessionId, runs)) runs = this.store.listUnfinishedNativeRuns(this.sessionId);
          // Nothing to start: the provider's status is not read for it. Draining: nothing new reaches a CLI.
          if (runs.some(run => run.native?.intent !== 'steer' && run.native?.delivery === 'queued') && !this.host.draining() && this.worker === undefined) {
            const { next: run, held } = this.admission(this.sessionId, runs);
            if (!held && run) this.startWorker(run.id);
          }
        }
      }
      this.watchDeliveries(runs);
      const afterWatch = this.store.listUnfinishedNativeRuns(this.sessionId);
      if (afterWatch.some(run => run.native?.intent === 'steer' && run.native.delivery === 'uncertain' && !run.native.queueReleasedAt)) {
        this.releaseEndedSteers(afterWatch, this.readStatus(this.sessionId));
      }
    } finally {
      this.finish(startedIdle, 'wake');
    }
  }

  /** Stop the timer, detach the observer, and wait for work already inside the session lock. */
  shutdown(): Promise<void> {
    this.dropObserver();
    this.clearTimer();
    const pending: Array<Promise<unknown>> = [];
    if (this.worker) pending.push(this.worker);
    for (const task of this.steerTasks.values()) pending.push(task);
    if (this.interruptionTask) pending.push(this.interruptionTask.task);
    this.pendingSteerOutcomes.clear();
    this.pendingTurnOutcomes.clear();
    this.turnOutcomeRevisions.clear();
    this.hookedTurns.clear();
    this.idleSince.clear();
    this.nextAttempt.clear();
    this.drainHeldSteers.clear();
    this.traced?.clear();
    this.mailbox.clear();
    return Promise.allSettled(pending).then(() => undefined);
  }

  private attached(): boolean {
    return this.host.current(this.sessionId) === this;
  }

  /** After every message: re-arm the watch and the timer, trace what changed, then wake again or let go. */
  private finish(evictNow: boolean, cause: ActorMessage['type']): void {
    if (this.host.closed || !this.attached()) { this.clearTimer(); return; }
    let runs = this.store.listUnfinishedNativeRuns(this.sessionId);
    // Re-arm the watch when a correction reopened a turn. Releasing it waits until a later step
    // finds the conversation already idle, so events already in hand still reach this listener.
    if (runs.some(runNeedsDispatchWatch) && !this.workspaceBlocked()) this.ensureObserver();
    if (!this.attached()) { this.clearTimer(); return; }
    runs = this.store.listUnfinishedNativeRuns(this.sessionId);
    this.scheduleTimer(runs);
    this.traced?.record(runs, this.phase(runs), cause, id => { try { return this.store.getRun(id); } catch { return undefined; } });
    // The message behind this one finishes in its turn, against what it leaves.
    if (this.mailbox.pending) return;
    if (this.shouldDispatch(runs)) this.wakeSoon();
    else if (this.isIdle(runs)) {
      if (evictNow) this.host.onIdle(this.sessionId, this);
      else this.deferIdle();
    }
  }

  /** Where the conversation stands (`trace.ts#SessionPhase`). */
  phase(runs: readonly Run[] = this.store.listUnfinishedNativeRuns(this.sessionId)): SessionPhase {
    return phaseOf(runs, { stopping: this.interrupting || this.interruptionTask !== undefined, recovering: this.recoveryActive, sending: this.worker !== undefined || this.steerTasks.size > 0 });
  }

  /** Let the caller finish delivering this turn, then drop the actor if nothing new arrived. */
  private deferIdle(): void {
    if (this.idleQueued || this.host.closed) return;
    this.idleQueued = true;
    queueMicrotask(() => {
      this.idleQueued = false;
      if (this.host.closed || !this.attached() || !this.isIdle()) return;
      this.dropObserver();
      this.host.onIdle(this.sessionId, this);
    });
  }

  /** A queued message can start now. The clock is not involved; an observation that freed the queue wakes one step. */
  private shouldDispatch(runs: readonly Run[]): boolean {
    if (this.worker !== undefined || this.host.closed || this.host.draining()) return false;
    if (!runs.some(run => run.native?.intent !== 'steer' && run.native?.delivery === 'queued')) return false;
    try {
      const session = this.store.getSession(this.sessionId);
      if (this.host.workspaceReserved(session) || this.native.pending?.(session.backendId ?? '')) return false;
    } catch { return false; }
    const { next, held } = this.admission(this.sessionId, runs);
    return Boolean(next && !held);
  }

  private wakeSoon(): void {
    if (this.waking || this.host.closed) return;
    this.waking = true;
    queueMicrotask(() => {
      this.waking = false;
      if (!this.host.closed && this.attached()) this.step();
    });
  }

  private workspaceBlocked(): boolean {
    try { return this.host.workspaceReserved(this.store.getSession(this.sessionId)); }
    catch { return false; }
  }

  private startWorker(runId: string): void {
    let release!: (result: Promise<void>) => void;
    const gate = new Promise<Promise<void>>(resolve => { release = resolve; });
    const work = gate.then(inner => inner).finally(() => {
      if (this.worker === work) this.worker = undefined;
      if (!this.host.closed && this.attached()) this.step();
    });
    // Set before the session lock runs so a re-entrant admission sees the conversation as busy.
    this.worker = work;
    release(this.runtime.withSession(this.sessionId, () => this.execute(runId)).then(() => undefined, () => undefined));
  }

  private ensureObserver(): void {
    if (this.unsubscribeObserver || this.subscribing) return;
    this.subscribing = true;
    try {
      const unsubscribe = this.native.subscribe(this.sessionId, message => this.observe(this.sessionId, message));
      // A status delivered during subscribe may have already settled the conversation and evicted this actor.
      if (!this.attached()) unsubscribe();
      else this.unsubscribeObserver = unsubscribe;
    } catch { /* unresolvable profile: the send fails the queued run with the same error */ }
    finally { this.subscribing = false; }
  }

  private dropObserver(): void {
    const unsubscribe = this.unsubscribeObserver;
    if (!unsubscribe) return;
    this.unsubscribeObserver = undefined;
    unsubscribe();
  }

  clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.timerAt = undefined;
  }

  /**
   * The next moment this conversation has to look again: a retry, a receipt window, an idle grace,
   * or a status read while an observed run is not idle yet. Nothing pending clears the timer.
   * Only this conversation is read; there is no process-wide poll.
   */
  private scheduleTimer(runs: readonly Run[]): void {
    if (this.host.closed || !this.attached()) { this.clearTimer(); return; }
    const idleWindow = (run: Run) => run.native?.expectsTurnOutcome ? (this.options.idleOutcomeGraceMs ?? IDLE_OUTCOME_GRACE_MS) : (this.options.idleReconcileMs ?? IDLE_RECONCILE_MS);
    const at = nextLook({ runs, now: now(), intervalMs: this.options.intervalMs ?? 500, confirmationMs: this.options.confirmationMs ?? 30_000,
      retryAt: id => this.nextAttempt.get(id) ?? 0, idleSince: id => this.idleSince.get(id), idleWindow, held: () => this.providerHold(runs) });
    if (at === undefined) { this.clearTimer(); return; }
    if (this.timer && this.timerAt !== undefined && this.timerAt <= at) return;
    this.clearTimer();
    this.timerAt = at;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.timerAt = undefined;
      if (!this.host.closed && this.attached()) this.step();
    }, Math.max(0, at - now()));
    this.timer.unref?.();
  }

  /** Whether a queued message waits only on what the provider says (a turn Riffet did not start, a dialog). */
  private providerHold(runs: readonly Run[]): boolean {
    if (this.worker !== undefined || this.host.closed || this.host.draining()) return false;
    try { return heldByProvider(this.admission(this.sessionId, runs)); } catch { return false; }
  }

  private turnKey(nativeSessionId: string, turnId: string): string {
    return JSON.stringify([nativeSessionId, turnId]);
  }

  /** Confirmation timeouts and idle-completion polls for this conversation's runs. */
  private watchDeliveries(runs: readonly Run[]): void {
    for (const run of runs) {
      if (run.native?.queueReleasedAt) continue;
      // A receipt alone starts the status reads: a turn over before its echo was seen gets no further status push.
      const since = run.native?.timings?.firstOutputAt ?? run.native?.timings?.busyAt ?? run.native?.timings?.observedAt;
      if (run.native?.delivery === 'observed' && typeof this.native.status === 'function'
        && (run.native.expectsTurnOutcome || run.native.intent === 'steer' || this.idleSince.has(run.id) || since === undefined || now() - since >= 500)) {
        this.apply(run.sessionId, { type: 'status', status: this.native.status(run.sessionId) });
      }
      if (run.native?.delivery === 'input_sent' && now() - (run.native.timings?.inputSentAt ?? now()) > (this.options.confirmationMs ?? 30_000)) {
        const terminal = this.matchingTerminal(run);
        const session = this.store.getSession(run.sessionId);
        // RPC backends such as DSH have no PTY to match. Their fenced provider/chat identity is
        // the link: a busy inbox may take longer than the confirmation window to emit its echo.
        const linkedProtocol = this.adapter.hasDriverSend() && run.native.nativeSessionId
          && run.native.nativeSessionId === session.nativeSessionId
          && run.native.backendId === session.backendId;
        const status = linkedProtocol || (terminal && terminal.state !== 'exited')
          ? this.native.status(run.sessionId) : undefined;
        // A live, correctly linked CLI that is still busy or showing a dialog may simply be
        // taking a long time to persist its transcript echo. Keep the write fenced as
        // input_sent; status alone is never a receipt and must not fabricate observed.
        // A hook-based steer (no `providerAcceptedAt`) enters an already-busy turn, so the
        // owner turn's busy/attention status is never evidence that the steer is being processed.
        const unacceptedSteer = run.native.intent === 'steer' && !run.native.timings?.providerAcceptedAt;
        if (!unacceptedSteer && (status?.phase === 'busy' || status?.phase === 'attention')) continue;
        this.store.transitionNativeRun(run.id, ['input_sent'], { delivery: 'uncertain', stage: 'confirmation',
          diagnostic: { code: 'NATIVE_RECEIPT_TIMEOUT', message: 'The provider receipt did not arrive within the confirmation window', stage: 'confirmation', at: new Date().toISOString() },
        }, { state: 'interrupted', error: '暂时无法确认是否已发送' });
      }
    }
  }

  /** A drain that ended without a restart lets the steers it held go to their turn; one whose turn is over meanwhile goes on as the next message. */
  private resumeDrainHeldSteers(): void {
    for (const runId of [...this.drainHeldSteers]) {
      this.drainHeldSteers.delete(runId);
      try { void this.steer(this.sessionId, runId).catch(() => undefined); } catch { /* sent on as a message or gone */ }
    }
  }

  /** `admission` over the conversation's runs and what this dispatcher is doing with it right now. */
  private admission(sessionId: string, runs: readonly Run[], status = this.readStatus(sessionId)): Admission {
    const session = this.store.getSession(sessionId);
    return admission({
      runs, status,
      sending: this.worker !== undefined, stopping: this.interrupting, recovering: this.recoveryActive,
      workspaceReserved: this.host.workspaceReserved(session),
      waitsWhileStarting: Boolean(this.traits(session.backendId).acceptsInputWhileBusy),
      pendingRelaunch: Boolean(session.configPending && this.traits(session.backendId).relaunchesForPendingConfig),
      steerTurnSettled: run => this.store.isSteerTargetTurnEnded(run),
      retryAt: runId => this.nextAttempt.get(runId) ?? 0, now: now(),
    });
  }

  private readStatus(sessionId: string): NativeStatus | undefined {
    try { return this.native.status(sessionId); } catch { return undefined; }
  }

  /**
   * Persists the release of any unconfirmed steer whose target turn is already over, so an offline
   * CLI or later restart cannot resurrect it as a queue hold while still keeping its receipt history.
   */
  private releaseEndedSteers(runs: readonly Run[], status?: NativeStatus): boolean {
    let released = false;
    for (const run of runs) {
      if (run.native?.intent !== 'steer' || run.native.delivery !== 'uncertain' || run.native.queueReleasedAt) continue;
      if (!steerTurnEnded(run, status, item => this.store.isSteerTargetTurnEnded(item))) continue;
      if (this.store.transitionNativeRun(run.id, ['uncertain'], { queueReleasedAt: new Date().toISOString() })) released = true;
    }
    return released;
  }

  /**
   * A steer still waiting for its turn when that turn is over goes out as the next message. Its
   * provider rejects what it still holds when a turn ends; this covers a steer the provider never
   * reported back on (its hook connection lost, a service restart before the steer was taken).
   */
  private sendOrphanedSteers(sessionId: string, runs: readonly Run[]): boolean {
    const orphaned = runs.filter(run => run.native?.intent === 'steer' && ['queued', 'preparing'].includes(run.native.delivery) && !this.steerTasks.has(run.id));
    if (!orphaned.length) return false;
    const status = this.readStatus(sessionId);
    let moved = false;
    for (const run of orphaned) if (steerTurnEnded(run, status, item => this.store.isSteerTargetTurnEnded(item))) moved = this.requeueSteer(run.id) || moved;
    return moved;
  }

  private requeueSteer(runId: string): boolean {
    this.pendingSteerOutcomes.delete(runId);
    this.nextAttempt.delete(runId);
    return Boolean(this.store.requeueSteer(runId));
  }

  /**
   * Moves a queued run to `preparing`, outside the delivery try. A compare that loses is not an
   * uncertain write, and a shutdown before this point leaves the message queued.
   */
  private armDelivery(run: Run, initial: NonNullable<Run['native']>): { prepareAt: number; checkpoint: boolean } | undefined {
    if (this.host.closed || run.native?.delivery !== 'queued') return undefined;
    const checkpoint = Boolean(this.options.beforeTurn && !initial.checkpointAttempted && !isSlashCommand(initial));
    const prepareAt = now();
    if (!this.store.transitionNativeRun(run.id, ['queued'], {
      delivery: 'preparing', stage: 'runtime', attempt: initial.attempt + 1,
      ...(checkpoint ? { checkpointAttempted: true } : {}),
      timings: { ...initial.timings, prepareAt },
    })) return undefined;
    return { prepareAt, checkpoint };
  }

  /** Archive and assistant checks, then the turn's checkpoint. A failure here is still `preparing`. */
  private openDelivery(run: Run, armed: { prepareAt: number; checkpoint: boolean }): Session {
    const session = this.store.getSession(run.sessionId);
    if (session.archivedAt) throw new AppError('ARCHIVED_SESSION', 'This conversation is archived', 409);
    const project = this.store.getProject(session.projectId);
    if (project.archivedAt) throw new AppError('ARCHIVED_PROJECT', 'Restore this project before running a conversation', 409);
    // A 助理 conversation started on an agent it no longer runs on (docs/ASSISTANT.md §4) would run with the owner's configuration.
    if (project.system === 'assistant' && !isAssistantBackend(session.backendId)) throw new AppError('ASSISTANT_BACKEND_UNSUPPORTED', 'The personal assistant runs on Claude Code or Codex', 409);
    // Started, and waited for nowhere: a send to a running CLI used to wait for all of it. `prepareAt`
    // precedes anything the CLI is given, which is how the checkpoint tells what the turn changed meanwhile.
    if (armed.checkpoint) void Promise.resolve().then(() => this.options.beforeTurn!(session, run, armed.prepareAt)).catch(() => undefined);
    return session;
  }

  /** Delivers one queued run. Replacing a live turn goes through `adapter.replaceTurn` instead. */
  private async execute(runId: string): Promise<void> {
    const run = this.store.getRun(runId);
    if (run.native?.intent === 'steer') throw new AppError('STEER_ACTION_UNSUPPORTED', 'A steer message cannot be sent as a new turn', 409);
    if (this.host.draining()) return;
    if (!run.native || run.native.delivery !== 'queued') return;
    const initial = run.native;
    const armed = this.armDelivery(run, initial);
    if (!armed) return;
    try {
      const session = this.openDelivery(run, armed);
      const result = await this.adapter.startTurn({
        session, run, initial, isSlash: isSlashCommand(initial),
        isClosed: () => this.host.closed,
        isInterrupting: () => this.interrupting,
        readStatus: (sessionId) => this.readStatus(sessionId),
      });
      this.observeSnapshot(session.id, result);
    } catch (error) {
      this.recoverDelivery(runId, initial, {}, error);
    }
  }

  /** Applies the post-send snapshot the adapter fetched. A settled slash command has none. */
  private observeSnapshot(sessionId: string, result: TurnDeliveryResult): void {
    if (!result.snapshot) return;
    this.observe(sessionId, { type: 'events', events: result.snapshot.events });
    this.observe(sessionId, { type: 'status', status: result.snapshot.status });
  }

  /**
   * A write that never left `preparing` can be retried. One that passed the fence becomes
   * `uncertain` and is not sent again. A replacement whose stop target moved is put back
   * on the queue and rethrown, so Stop does not act on the new target.
   */
  private recoverDelivery(runId: string, initial: NonNullable<Run['native']>, options: { now?: boolean; expectedStop?: NativeStopRequest }, error: unknown): void {
    const run = this.store.getRun(runId);
    const delivery = run.native?.delivery;
    if (delivery === 'cancelled' || delivery === 'observed') return;
    const message = error instanceof Error ? error.message : '无法执行消息';
    if (delivery === 'dispatching' || delivery === 'input_sent') {
      this.store.transitionNativeRun(runId, [delivery], {
        delivery: 'uncertain', stage: 'confirmation',
        diagnostic: { ...(error instanceof AppError ? { code: error.code } : {}),
          message: redactSensitiveText(message).slice(0, 1000), stage: run.native?.stage, at: new Date().toISOString() },
      }, { state: 'interrupted', error: '暂时无法确认是否已发送' });
    } else if (delivery === 'preparing') {
      const code = error instanceof AppError ? error.code : '';
      // The replacement never crossed the write fence. Put it back on the queue and surface the
      // conflict: failing the run, or falling through into Stop, would act on a target that moved.
      if (code === 'NATIVE_STOP_TARGET_CHANGED' && options.now && options.expectedStop) {
        const { promotedAt: _promoted, ...timings } = run.native?.timings ?? {};
        this.store.transitionNativeRun(runId, ['preparing'], { delivery: 'queued', stage: undefined, timings }, { state: 'queued', error: undefined });
        throw error;
      }
      if (['CLI_BUSY', 'CLI_INTERACTION_REQUIRED', 'TERMINAL_INTERACTION_BUSY', 'TERMINAL_INTERACTION_STALE', 'TERMINAL_CONTROL_STALE', 'TERMINAL_DETACHED', 'DISPATCH_STOPPED', 'NATIVE_INTERRUPT_IN_PROGRESS', 'NATIVE_LAUNCH_ABORTED'].includes(code)) {
        // Nothing reached the CLI (the run never left `preparing`), so failing here repeats no side effect.
        const { blockedAt: since, ...timings } = run.native?.timings ?? {};
        const blockedAt = code === 'CLI_BUSY' && !this.runningTurn(run.sessionId) ? since ?? now() : undefined;
        const limit = this.options.busyLimitMs ?? CLI_BUSY_LIMIT_MS;
        if (blockedAt !== undefined && now() - blockedAt >= limit) {
          this.store.transitionNativeRun(runId, ['preparing'], { delivery: 'failed', stage: 'prepare', timings }, {
            state: 'failed',
            error: '终端未就绪，请检查后重试。',
          });
          return;
        }
        this.nextAttempt.set(run.id, now() + 1500);
        this.store.transitionNativeRun(runId, ['preparing'], { delivery: 'queued', stage: initial.stage === 'interrupt_followup' ? 'interrupt_followup' : code === 'CLI_INTERACTION_REQUIRED' ? 'interaction' : 'waiting', timings: blockedAt === undefined ? timings : { ...timings, blockedAt } }, { state: 'queued', error: undefined });
      } else {
        this.store.transitionNativeRun(runId, ['preparing'], { delivery: 'failed', stage: 'prepare' }, { state: 'failed', error: message });
      }
    }
  }

  private traits(backendId: string | undefined): NativeBackendTraits {
    return (backendId && this.native.traits?.(backendId)) || {};
  }

  /** A turn (or a dialog inside one) is in flight: a busy CLI is then waiting its turn, not wedged. */
  private runningTurn(sessionId: string): boolean {
    try {
      const status = this.native.status(sessionId);
      if (['busy', 'attention'].includes(status.phase)) return true;
      // A settings relaunch waits for background work to end; the message waits with it and is not failed meanwhile.
      // Otherwise background work does not count: a CLI wedged away from its prompt is still bounded by the limit.
      const session = this.store.getSession(sessionId);
      return Boolean(session.configPending && this.traits(session.backendId).relaunchesForPendingConfig
        && (status.activity?.background || status.activity?.compacting));
    } catch { return false; }
  }

  /** Delivers exactly one additional input to its original live turn under the session lock. */
  steer(sessionId: string, runId: string): Promise<Run> {
    const existing = this.steerTasks.get(runId);
    if (existing) return existing;
    const run = this.store.getRun(runId);
    if (this.host.workspaceReserved(this.store.getSession(sessionId))) return Promise.reject(this.host.workspaceBusy());
    if (run.sessionId !== sessionId || run.native?.intent !== 'steer') throw new AppError('RUN_NOT_FOUND', 'The steer message does not exist', 404);
    if (run.native.delivery !== 'queued') return Promise.resolve(run);
    // Draining: a steer waits like any other send. A boundary wait could hold the restart for the rest of the
    // turn; the steer stays queued instead, goes to its turn if the drain ends without a restart, and becomes
    // the next message after one (the store's recovery), as a steer a restart caught before writing does.
    if (this.host.draining()) { this.drainHeldSteers.add(runId); return Promise.resolve(run); }
    const task = this.runtime.withSession(sessionId, async () => {
      let current = this.store.getRun(runId);
      if (current.native?.delivery !== 'queued') return current;
      this.store.transitionNativeRun(runId, ['queued'], { delivery: 'preparing', stage: 'steer_preparing', attempt: current.native.attempt + 1 });
      try {
        const check = () => {
          if (this.host.closed) throw new AppError('DISPATCH_STOPPED', 'The service is shutting down; the steer message was not sent', 503);
          if (this.interrupting) throw new AppError('NATIVE_INTERRUPT_IN_PROGRESS', 'The current turn is stopping; the steer message was not sent', 409);
          const session = this.store.getSession(sessionId);
          if (session.archivedAt) throw new AppError('ARCHIVED_SESSION', 'This conversation is archived', 409);
          const status = this.native.status(sessionId), target = status.activeTurn;
          if (status.interaction) throw new AppError('CLI_INTERACTION_REQUIRED', 'Handle the pending confirmation first', 409);
          if (!target || session.nativeSessionId !== current.native!.nativeSessionId || target.nativeSessionId !== current.native!.nativeSessionId || target.turnId !== current.native!.nativeTurnId) {
            throw new AppError('STEER_TARGET_CHANGED', 'The target turn ended or changed; the steer message was not sent', 409);
          }
          const owner = this.store.findRunsByNativeTurn(sessionId, target.nativeSessionId, target.turnId).find(run => !run.native?.intent);
          if (owner) this.trackTurnOutcome(owner, status);
          if (this.store.listUnfinishedNativeRuns(sessionId).some(other => other.id !== runId && holdsUnconfirmed(other, status, item => this.store.isSteerTargetTurnEnded(item)))) {
            throw new AppError('NATIVE_DELIVERY_UNCERTAIN', 'Another message has an unconfirmed outcome; check it first', 409);
          }
          return session;
        };
        const session = check();
        // A validated live target is required before subscribing; a cold backend must not be
        // launched merely because an expired steer was retried. Support is confirmed first.
        const result = await this.adapter.steerTurn(session, current, binding => {
          // A steer sent on as the next message is no steer any more: a late claim of it must not write it.
          if (this.store.getRun(runId).native?.intent !== 'steer') throw new AppError('RUN_CANCELLED', 'The steer message was sent on as the next message', 409);
          check();
          if (binding?.nativeSessionId && binding.nativeSessionId !== current.native!.nativeSessionId || binding?.nativeTurnId && binding.nativeTurnId !== current.native!.nativeTurnId) {
            throw new AppError('STEER_TARGET_CHANGED', 'The steer target changed', 409);
          }
          if (this.native.commitDispatchFence) return this.native.commitDispatchFence(runId, binding);
          const changed = this.store.transitionNativeRun(runId, ['preparing'], { ...binding, delivery: 'dispatching', stage: 'steer_input', timings: { ...this.store.getRun(runId).native?.timings, dispatchAt: now() } });
          if (!changed) throw new AppError('RUN_CANCELLED', 'The steer message was cancelled', 409);
          return changed;
        }, () => this.ensureObserver());
        const delivered = this.store.getRun(runId);
        if (result?.deferred) {
          // The input is still ours until the next matching native tool boundary. Keep the
          // preparation cancellable, and release this short lock so hooks/config/stop can run.
          this.store.transitionNativeRun(runId, ['preparing'], { stage: 'steer_waiting_boundary' });
          return this.store.getRun(runId);
        }
        if (delivered.native!.delivery === 'preparing') throw new AppError('STEER_REJECTED', 'The backend has not accepted the steer message', 409);
        this.store.transitionNativeRun(runId, [delivered.native!.delivery], {
          ...(delivered.native!.delivery === 'dispatching' ? { delivery: 'input_sent' as const, stage: 'steer_confirmation' } : {}),
          timings: { ...delivered.native!.timings, inputSentAt: now(), providerAcceptedAt: now() },
        });
        const snapshot = await this.native.snapshot(sessionId).catch(() => undefined);
        if (snapshot) this.observe(sessionId, { type: 'events', events: snapshot.events });
      } catch (error) {
        const failed = this.store.getRun(runId);
        const delivery = failed.native!.delivery;
        const code = error instanceof AppError ? error.code : undefined;
        // Only a steer that missed its turn (target changed, stop in progress, or shutdown before write)
        // falls back as the next message. Explicit rejections (invalid/oversized input, unsupported backend,
        // archived session, pending interaction, unconfirmed delivery) fail without silently re-queueing.
        if (delivery === 'queued' || delivery === 'preparing') {
          if (code === 'STEER_TARGET_CHANGED' || code === 'NATIVE_STEER_TARGET_GONE' || code === 'NATIVE_INTERRUPT_IN_PROGRESS' || code === 'DISPATCH_STOPPED') {
            this.requeueSteer(runId);
          } else {
            this.pendingSteerOutcomes.delete(runId);
            this.store.transitionNativeRun(runId, [delivery], {
              delivery: 'failed', stage: 'steer_rejected',
              diagnostic: { ...(code ? { code } : {}), message: redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 1000), stage: failed.native?.stage, at: new Date().toISOString() },
            }, {
              state: 'failed', error: error instanceof Error ? error.message : '引导消息未发送',
            });
          }
        } else if (!['observed', 'failed', 'cancelled'].includes(delivery)) {
          const definite = code !== undefined && ['STEER_TARGET_CHANGED', 'STEER_REJECTED', 'STEER_UNSUPPORTED', 'RUN_CANCELLED'].includes(code);
          if (definite) this.pendingSteerOutcomes.delete(runId);
          this.store.transitionNativeRun(runId, [delivery], { delivery: definite ? 'failed' : 'uncertain', stage: definite ? 'steer_rejected' : 'steer_confirmation',
            diagnostic: { ...(code ? { code } : {}), message: redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 1000), stage: failed.native?.stage, at: new Date().toISOString() },
          }, {
            state: definite ? 'failed' : 'interrupted', error: definite && error instanceof Error ? error.message : '暂时无法确认是否已发送',
          });
        }
      }
      return this.store.getRun(runId);
    }).finally(() => { this.steerTasks.delete(runId); this.step(); });
    this.steerTasks.set(runId, task);
    return task;
  }

  /** Applies one observation to the conversation's runs. Handlers call it directly for what they read themselves. */
  private apply(sessionId: string, message: DispatchObservation): void {
    if (this.host.closed) return;
    if (message.type === 'events') {
      this.reconcileTurnCorrections(sessionId, message.events);
      for (const source of message.events) {
        let event = source;
        if (event.type === 'native_input_rejected' && event.data.receiptKind === 'native_command') {
          const commandId = typeof event.data.commandId === 'string' ? event.data.commandId : undefined;
          const run = commandId ? this.store.findRunByCommand(sessionId, commandId) : undefined;
          const native = run?.native;
          const session = this.store.getSession(sessionId);
          // Command rejection has no provider turn. Validate its own dispatch identity instead
          // of routing it through the turn-outcome filter or inventing a turn to pass that filter.
          if (event.sessionId !== sessionId || !run || !native || native.intent === 'steer' || native.slashCommand !== true
            || event.nativeTurnId || native.nativeTurnId || native.nativeMessageId
            || native.backendId !== session.backendId || !native.nativeSessionId || event.data.nativeSessionId !== native.nativeSessionId
            || session.nativeSessionId !== native.nativeSessionId || event.runId !== undefined && event.runId !== run.id
            || !['dispatching', 'input_sent', 'uncertain'].includes(native.delivery) || !canApplyTurnOutcome(run)) continue;
          const error = typeof event.data.error === 'string' ? redactSensitiveText(event.data.error).slice(0, 1000) : 'The native command was rejected.';
          this.store.transitionNativeRun(run.id, [native.delivery], { delivery: 'failed', stage: 'provider_failed',
            timings: { ...native.timings, completedAt: now() } }, { state: 'failed', error });
          continue;
        }
        if (isTurnOutcome(event)) {
          const scope = this.turnOutcomeScope(sessionId, event);
          // Explicit chat identities must match even for command-tagged outcomes.
          if (typeof event.data.nativeSessionId === 'string' && !scope) continue;
          if (scope && outcomeRevision(event) < (this.turnOutcomeRevisions.get(scope.key) ?? 1)) continue;
          if (event.type === 'native_turn_reopened') continue;
        }
        let taggedCommandId = typeof event.data.commandId === 'string' ? event.data.commandId : undefined;
        if (!taggedCommandId && event.nativeTurnId && ['run_completed', 'run_failed', 'run_cancelled'].includes(event.type)
          && typeof event.data.nativeSessionId === 'string') {
          const session = this.store.getSession(sessionId), nativeSessionId = event.data.nativeSessionId;
          if (session.nativeSessionId !== nativeSessionId) continue;
          const key = this.turnKey(nativeSessionId, event.nativeTurnId);
          this.pendingTurnOutcomes.set(key, event);
          if (this.pendingTurnOutcomes.size > OUTCOME_MEMORY) this.pendingTurnOutcomes.delete(this.pendingTurnOutcomes.keys().next().value!);
          const turnRuns = this.store.findRunsByNativeTurn(sessionId, nativeSessionId, event.nativeTurnId);
          const owner = turnRuns.find(run => !run.native?.intent && run.native?.nativeMessageId);
          if (!owner) continue;
          this.pendingTurnOutcomes.delete(key);
          // A historical outcome names a turn, not one Riffet submission. The ordinary owner may
          // already be settled while receipted steers in that turn still await its real outcome.
          const outcomes = turnRuns.filter(run => run.native?.nativeMessageId && canApplyTurnOutcome(run))
            .map(run => ({ ...event, runId: owner.id, data: { ...event.data, commandId: run.commandId } }));
          if (outcomes.length) this.apply(sessionId, { type: 'events', events: outcomes });
          continue;
        }
        const matchingRun = taggedCommandId ? this.store.findRunByCommand(sessionId, taggedCommandId)
          : event.type === 'user_message_chunk' ? this.store.findRunByNativeMessage(sessionId, event.nativeId) : undefined;
        if (!matchingRun?.native) continue;
        const commandId = taggedCommandId ?? matchingRun.commandId;
        const current = this.store.getRun(matchingRun.id);
        if (!current.native) continue;
        // A steer's own lifecycle, arriving after it was sent on as the next message (a late claim the fence
        // refused, a provider ending the turn after the sweep): it speaks for the old turn, not this run's.
        if ((event.type === 'native_input_rejected' || event.type === 'native_input_submitted') && current.native.intent !== 'steer') continue;
        const eventTurn = turnOf(event);
        if (current.native.nativeTurnId && eventTurn && current.native.nativeTurnId !== eventTurn) continue;
        if (current.native.intent === 'steer' && eventTurn !== current.native.nativeTurnId) continue;
        if (eventTurn && !current.native.nativeTurnId) this.store.transitionNativeRun(current.id, [current.native.delivery], { nativeTurnId: eventTurn });
        if (current.native.intent === 'steer' && !current.native.ownerRunId && current.native.nativeSessionId && current.native.nativeTurnId
          && (event.type === 'user_message_chunk' || event.type === 'native_input_receipt')) {
          const owner = this.store.findRunsByNativeTurn(sessionId, current.native.nativeSessionId, current.native.nativeTurnId).find(run => !run.native?.intent);
          if (owner) this.store.transitionNativeRun(current.id, [current.native.delivery], { ownerRunId: owner.id });
        }
        const receiptEvent = message.events.find(item => (item.type === 'user_message_chunk' || item.type === 'native_input_receipt')
          && item.data.commandId === commandId && (!current.native!.nativeTurnId || turnOf(item) === current.native!.nativeTurnId));
        // The provider let go of a steer it never wrote (its turn ended or stopped first): it becomes the next message.
        if (event.type === 'native_input_rejected' && current.native.intent === 'steer' && event.data.beforeWrite === true) {
          this.requeueSteer(current.id);
          continue;
        }
        if (event.type === 'native_input_submitted' && current.native.intent === 'steer') {
          this.store.transitionNativeRun(current.id, ['dispatching'], { delivery: 'input_sent', stage: 'steer_confirmation',
            timings: { ...current.native.timings, inputSentAt: now() } });
          continue;
        }
        if (event.type === 'run_completed' || event.type === 'run_failed' || event.type === 'run_cancelled') {
          if (current.native.intent === 'steer' && ['steer_rejected', 'acknowledged', 'cancelled'].includes(current.native.stage ?? '')) {
            this.pendingSteerOutcomes.delete(current.id);
            continue;
          }
          if (current.native.intent === 'steer' && !current.native.nativeMessageId && !receiptEvent) {
            this.pendingSteerOutcomes.set(current.id, event);
            continue;
          }
          const providerMessageId = typeof event.data.nativeMessageId === 'string' && event.data.nativeMessageId.length <= 500
            ? event.data.nativeMessageId : undefined;
          const nativeMessageId = receiptEvent?.nativeId ?? providerMessageId ?? current.native.nativeMessageId;
          const sameTerminal = event.type === 'run_completed'
            ? current.state === 'completed' && current.native.delivery === 'observed'
            : event.type === 'run_failed'
              ? current.state === 'failed' && current.native.delivery === 'failed'
              : current.state === 'interrupted' && current.native.delivery === 'cancelled';
          if (sameTerminal) {
            if (!current.native.nativeMessageId && nativeMessageId) this.store.transitionNativeRun(current.id, [current.native.delivery], { nativeMessageId });
            continue;
          }
          if (!canApplyTurnOutcome(current)) continue;
          if (event.type === 'run_completed') {
            this.store.transitionNativeRun(current.id, [current.native.delivery], {
              delivery: 'observed', stage: 'completed', ...(nativeMessageId ? { nativeMessageId } : {}),
              timings: { ...current.native.timings, observedAt: current.native.timings?.observedAt ?? now(), completedAt: now() },
            }, { state: 'completed', error: undefined });
          } else if (event.type === 'run_failed') {
            const error = typeof event.data.error === 'string' ? event.data.error.slice(0, 1000) : UNSPECIFIED_NATIVE_RUN_FAILURE;
            this.store.transitionNativeRun(current.id, [current.native.delivery], {
              delivery: 'failed', stage: 'provider_failed', ...(nativeMessageId ? { nativeMessageId } : {}),
              timings: { ...current.native.timings, completedAt: now() },
            }, { state: 'failed', error });
          } else {
            const reason = typeof event.data.reason === 'string' ? event.data.reason.slice(0, 1000) : undefined;
            this.store.transitionNativeRun(current.id, [current.native.delivery], {
              delivery: 'cancelled', stage: 'provider_cancelled', ...(nativeMessageId ? { nativeMessageId } : {}),
              timings: { ...current.native.timings, interruptedAt: now() },
            }, { state: 'interrupted', error: reason });
          }
          // A turn that ended is the conversation's latest activity. The sidebar orders each day by
          // when a conversation last ran, so a long turn must not fall back to the time its prompt
          // went out and sink below conversations that were merely touched since.
          this.store.updateSessionActivity(current.sessionId);
        } else if ((event.type === 'user_message_chunk' || event.type === 'native_input_receipt') && !current.native.nativeMessageId) {
          // A provider-echoed command id is durable receipt evidence. Its sequence may have been
          // rebuilt after restart and cannot be compared with the previous process's boundary.
          // An uncertain run is parked as interrupted only until its receipt turns up, which is this.
          const isFinished = current.native.delivery !== 'uncertain'
            && (['completed', 'failed', 'cancelled', 'interrupted'].includes(current.state) || ['failed', 'cancelled'].includes(current.native.delivery));
          const stoppedSteer = current.native.intent === 'steer' && current.native.stage === 'steer_stopped';
          const session = this.store.getSession(sessionId);
          const linkedSessionId = session.nativeSessionId;
          const expectedSessionId = current.native.nativeSessionId;
          if (expectedSessionId && linkedSessionId !== expectedSessionId) continue;
          this.store.transitionNativeRun(current.id, [current.native.delivery], isFinished
            ? { nativeMessageId: event.nativeId }
            : {
              delivery: stoppedSteer ? 'cancelled' : 'observed', stage: stoppedSteer ? 'interrupted' : 'executing', nativeMessageId: event.nativeId,
              ...(linkedSessionId ? { nativeSessionId: linkedSessionId } : {}),
              timings: { ...current.native.timings, observedAt: current.native.timings?.observedAt ?? now(), ...(event.type === 'native_input_receipt' ? { providerAcceptedAt: now() } : {}) },
            }, isFinished ? {} : { state: stoppedSteer || current.native.queueReleasedAt ? 'interrupted' : 'running', error: undefined });
          const outcome = this.pendingSteerOutcomes.get(current.id);
          if (outcome) { this.pendingSteerOutcomes.delete(current.id); this.apply(sessionId, { type: 'events', events: [outcome] }); }
        }
        if (event.type === 'user_message_chunk' || event.type === 'native_input_receipt') {
          const bound = this.store.getRun(current.id);
          this.trackTurnOutcome(bound);
          this.replayTurnOutcome(bound);
        }
      }
    }
    const runs = this.store.listUnfinishedNativeRuns(sessionId);
    for (const run of runs) {
      const delivery = run.native!;
      // A slash command answered in the CLI's own pane uses successful PTY submission as its completion
      // boundary. The CLI may also publish a transcript echo while deliver() is still resolving;
      // allowing that echo to move dispatching → observed would race the explicit command_sent
      // transition and leave the command pending forever when it has no assistant text output.
      const backendId = this.store.getSession(sessionId).backendId;
      if (this.traits(backendId).settlesSlashOnSubmit && isSlashCommand(delivery)) continue;
      if (delivery.intent !== 'steer' && message.type === 'events' && ['dispatching', 'input_sent', 'uncertain', 'observed'].includes(delivery.delivery)) {
        const session = this.store.getSession(sessionId);
        const linkedSessionId = session.nativeSessionId;
        const expectedSessionId = delivery.nativeSessionId;
        if ((delivery.terminalId && session.terminalId !== delivery.terminalId) || (expectedSessionId && expectedSessionId !== linkedSessionId)) continue;
        // Untagged echoes need the captured boundary; protocol command ids identify the
        // submission across restarts even when the transcript's sequence numbers have changed.
        // This is evidence of receipt, never a license to replay an ambiguous input.
        // The CLI's stored copy can differ from what we sent by a few mangled characters, so the
        // receipt is recognised through the shared tolerant comparison rather than by exact text.
        // Exact equality would leave this run `uncertain` forever, fencing every later message.
        const sent = (delivery.renderedText ?? delivery.input.text).trim();
        const backendId = session.backendId;
        const afterBaseline = message.events.filter(event => event.sequence > (delivery.baselineSequence ?? Infinity));
        const matches = this.traits(backendId).untaggedEcho
          ? afterBaseline.filter(event => event.type === 'user_message_chunk'
            && samePromptText(sent, ((event.data.content as { text?: string } | undefined)?.text ?? '').trim()))
          : message.events.filter(event => event.type === 'user_message_chunk' && event.data.commandId === run.commandId);
        if (!delivery.nativeMessageId && matches.length === 1) {
          this.store.transitionNativeRun(run.id, ['dispatching', 'input_sent', 'uncertain'], {
            delivery: 'observed', nativeMessageId: matches[0]!.nativeId,
            ...(matches[0]!.nativeTurnId ? { nativeTurnId: matches[0]!.nativeTurnId } : {}),
            ...(session.nativeSessionId ? { nativeSessionId: session.nativeSessionId } : {}),
            stage: 'executing', timings: { ...delivery.timings, observedAt: now() },
          }, { state: delivery.queueReleasedAt ? 'interrupted' : 'running', error: undefined });
          const bound = this.store.getRun(run.id);
          this.trackTurnOutcome(bound);
          this.replayTurnOutcome(bound);
        }
        const updated = this.store.getRun(run.id);
        if (updated.native?.delivery === 'observed' && !updated.native.timings?.firstOutputAt && message.events.some(event => event.sequence > (delivery.baselineSequence ?? Infinity) && event.type === 'agent_message_chunk')) {
          this.store.transitionNativeRun(run.id, ['observed'], { timings: { ...updated.native.timings, firstOutputAt: updated.native.timings?.firstOutputAt ?? now() } });
        }
      }
      if (message.type === 'status') {
        this.trackTurnOutcome(this.store.getRun(run.id), message.status);
        let current = this.store.getRun(run.id);
        // Keep historical released inputs observable until an actual end arrives. An idle timer
        // must not remove their observer or turn their old receipt into a new running task.
        if (current.native?.queueReleasedAt) { this.idleSince.delete(run.id); continue; }
        const matchingTerminal = this.matchingTerminal(current);
        const target = message.status.activeTurn;
        const linkedSession = this.store.getSession(sessionId);
        const expectedSessionId = current.native?.nativeSessionId;
        if ((expectedSessionId && expectedSessionId !== linkedSession.nativeSessionId)
          || current.native?.terminalId && !matchingTerminal) {
          this.idleSince.delete(run.id);
          continue;
        }
        if (current.native?.delivery === 'uncertain' && current.native.stage === 'turn_outcome_unknown'
          && current.native.nativeMessageId && current.native.nativeSessionId
          && this.traits(current.native.backendId).reportsTurnOutcome
          && ['busy', 'attention', 'idle'].includes(message.status.phase)
          && (!target || target.nativeSessionId === current.native.nativeSessionId)
          && current.native.nativeSessionId === linkedSession.nativeSessionId) {
          // Older service versions parked a known receipt as uncertain after losing its Stop.
          // Resume observation from the same chat's current state, without changing delivery facts.
          current = this.store.transitionNativeRun(run.id, ['uncertain'], {
            delivery: 'observed', stage: 'executing', expectsTurnOutcome: true,
          }, { state: 'running', error: undefined }) ?? current;
        }
        if (current.native?.delivery === 'observed' && current.native.nativeMessageId && current.native.nativeTurnId
          && (current.native.expectsTurnOutcome || current.native.intent === 'steer') && target
          && ['busy', 'attention'].includes(message.status.phase)
          && target.nativeSessionId === current.native.nativeSessionId
          && target.turnId !== current.native.nativeTurnId) {
          // A newer turn in this exact chat proves the old turn is no longer active, not that it
          // succeeded. Its known receipt must not fence that newer work or require a resend check.
          this.store.transitionNativeRun(run.id, ['observed'], {
            delivery: 'cancelled', stage: 'turn_outcome_unknown', timings: { ...current.native.timings, interruptedAt: now() },
          }, { state: 'interrupted', error: '会话已进入后续任务，但未收到原任务的完成确认；消息已送达，不会重发。' });
          this.idleSince.delete(run.id);
          this.wakeSoon();
          continue;
        }
        if (current.native?.delivery === 'uncertain' && current.native.stage === 'runtime_exit'
          && current.native.nativeMessageId
          && ['busy', 'idle', 'attention'].includes(message.status.phase)
          && matchingTerminal && matchingTerminal.state !== 'exited') {
          // runtime_exit is recoverable only when an exact transcript receipt already bound this
          // run, the same persisted CLI terminal still exists for this session/chat, and its
          // current state is busy/idle/attention. Terminal epoch changes track browser leases,
          // so they deliberately do not participate in process identity here.
          current = this.store.transitionNativeRun(run.id, ['uncertain'], {
            delivery: 'observed', stage: 'executing',
          }, { state: 'running', error: undefined }) ?? current;
        }
        if (current.native?.delivery === 'observed' && !current.native.intent && !current.native.expectsTurnOutcome && !(current.native.nativeTurnId && this.traits(current.native.backendId).completesOnTurnEvent) && message.status.phase === 'idle' && message.status.noticeLevel !== 'error' && (current.native.timings?.firstOutputAt || current.native.timings?.busyAt) && !this.interrupting) {
          this.store.transitionNativeRun(run.id, ['observed'], { stage: 'completed', timings: { ...current.native.timings, completedAt: now() } }, { state: 'completed' });
          this.store.updateSessionActivity(sessionId);
        } else if (message.status.phase === 'busy' && ['dispatching', 'input_sent', 'observed'].includes(current.native?.delivery ?? '') && !current.native?.timings?.busyAt) {
          this.store.transitionNativeRun(run.id, ['dispatching', 'input_sent', 'observed'], { timings: { ...current.native?.timings, busyAt: now() } });
        } else if (message.status.phase === 'offline' && ['dispatching', 'input_sent', 'observed'].includes(current.native?.delivery ?? '')) {
          const mayBeRunning = this.traits(this.store.getSession(sessionId).backendId).offlineMayBeRunning;
          const terminalExited = this.matchingTerminal(current)?.state === 'exited';
          if (terminalExited) {
            if (current.native?.delivery === 'observed') {
              // The CLI echoed this prompt, so delivery is settled, and an exited CLI cannot still be
              // running it. Close the turn like an interrupt instead of fencing later messages.
              this.store.transitionNativeRun(run.id, ['observed'], { delivery: 'cancelled', stage: 'runtime_exit', timings: { ...current.native.timings, interruptedAt: now() } }, { state: 'interrupted', error: 'CLI 在回复过程中退出，这条回复可能不完整。' });
            } else {
              const startupError = this.store.getSession(sessionId).error;
              this.store.transitionNativeRun(run.id, ['dispatching', 'input_sent'], { delivery: 'uncertain', stage: 'runtime_exit' }, { state: 'interrupted', error: startupError ? `${startupError} 尚未确认消息是否送达，系统不会自动重发。` : 'Native backend exited before delivery could be confirmed. The message will not be resent automatically.' });
            }
          } else if (mayBeRunning && current.native?.delivery !== 'observed') {
            // A lost app-server or hook connection does not prove that the native CLI child
            // stopped. Fence the run and its workspace until a later idle status or terminal exit.
            this.store.transitionNativeRun(run.id, ['dispatching', 'input_sent', 'observed'], {
              delivery: 'uncertain', stage: 'runtime_exit',
            }, { state: 'interrupted', error: 'Native backend connection was lost while its process may still be running. The message will not be resent automatically.' });
          }
        }
        this.reconcileIdleRun(sessionId, run.id, message.status);
      }
    }
    this.releaseEndedSteers(this.store.listUnfinishedNativeRuns(sessionId), message.type === 'status' ? message.status : undefined);
  }

  private turnOutcomeScope(sessionId: string, event: NativeWorkbenchEvent): { key: string; nativeSessionId: string; turnId: string } | undefined {
    if (event.sessionId !== sessionId || !event.nativeTurnId) return undefined;
    const command = typeof event.data.commandId === 'string' ? this.store.findRunByCommand(sessionId, event.data.commandId) : undefined;
    const nativeSessionId = typeof event.data.nativeSessionId === 'string' ? event.data.nativeSessionId
      : command?.native?.nativeSessionId;
    const session = this.store.getSession(sessionId);
    if (!nativeSessionId || nativeSessionId !== session.nativeSessionId) return undefined;
    if (command?.native && ((command.native.nativeSessionId ?? nativeSessionId) !== nativeSessionId
      || command.native.nativeTurnId && command.native.nativeTurnId !== event.nativeTurnId)) return undefined;
    return { key: this.turnKey(nativeSessionId, event.nativeTurnId), nativeSessionId, turnId: event.nativeTurnId };
  }

  /** Take all correction evidence before receipts can replay cached outcomes from this batch. */
  private reconcileTurnCorrections(sessionId: string, events: NativeWorkbenchEvent[]): void {
    const newest = new Map<string, { nativeSessionId: string; turnId: string; revision: number; type: string; error?: string; reopenedRevision?: number }>();
    for (const event of events) {
      if (!isTurnOutcome(event)) continue;
      const scope = this.turnOutcomeScope(sessionId, event);
      if (!scope) continue;
      const revision = outcomeRevision(event);
      const previous = newest.get(scope.key);
      const reopenedRevision = Math.max(previous?.reopenedRevision ?? 0, event.type === 'native_turn_reopened' ? revision : 0);
      const error = typeof event.data.error === 'string' ? event.data.error : typeof event.data.reason === 'string' ? event.data.reason : undefined;
      if (revision > (previous?.revision ?? 0)) newest.set(scope.key, { ...scope, revision, type: event.type, ...(error ? { error } : {}), ...(reopenedRevision ? { reopenedRevision } : {}) });
      else if (previous && reopenedRevision) previous.reopenedRevision = reopenedRevision;
    }
    for (const [key, correction] of newest) {
      // Revision 1 is the default fence, so only corrections are kept, and only the newest few.
      const previousRevision = this.turnOutcomeRevisions.get(key) ?? 1;
      if (correction.revision <= previousRevision) continue;
      this.turnOutcomeRevisions.delete(key);
      this.turnOutcomeRevisions.set(key, correction.revision);
      if (this.turnOutcomeRevisions.size > OUTCOME_MEMORY) this.turnOutcomeRevisions.delete(this.turnOutcomeRevisions.keys().next().value!);
      this.pendingTurnOutcomes.delete(key);
      for (const run of this.store.findRunsByNativeTurn(sessionId, correction.nativeSessionId, correction.turnId)) {
        this.pendingSteerOutcomes.delete(run.id);
        const native = run.native!;
        const matches = correction.type === 'run_completed' && run.state === 'completed' && native.stage === 'completed'
          || correction.type === 'run_failed' && run.state === 'failed' && native.stage === 'provider_failed'
          || correction.type === 'run_cancelled' && run.state === 'interrupted' && native.stage === 'provider_cancelled';
        if (matches && run.error === correction.error) continue;
        // A newer journal revision can supply the diagnostic after the provider already stopped.
        if (matches && correction.type === 'run_failed' && correction.error
          && (!run.error || run.error === UNSPECIFIED_NATIVE_RUN_FAILURE)) {
          this.store.transitionNativeRun(run.id, ['failed'], {}, { error: redactSensitiveText(correction.error).slice(0, 1000) });
          continue;
        }
        // A newer end can refine a provider cancellation; failures and completions require an
        // explicit retraction first. Ordinary late activity is never evidence to reopen a turn.
        // User stops and released tracking remain final even if the provider retracts its end.
        const cancellation = correction.type !== 'run_cancelled' && run.state === 'interrupted'
          && native.delivery === 'cancelled' && native.stage === 'provider_cancelled';
        const retracted = (correction.reopenedRevision ?? 0) > previousRevision
          && (run.state === 'failed' && native.delivery === 'failed' && native.stage === 'provider_failed'
            || run.state === 'completed' && native.delivery === 'observed' && native.stage === 'completed');
        if ((!cancellation && !retracted) || native.queueReleasedAt) continue;
        const stopped = Object.values(this.store.getSetting<Record<string, StopReceipt>>(`native-stops:${sessionId}`, {}))
          .some(receipt => receipt.request.nativeSessionId === correction.nativeSessionId && receipt.request.turnId === correction.turnId);
        if (stopped) continue;
        this.idleSince.delete(run.id);
        const { completedAt: _completed, interruptedAt: _interrupted, ...timings } = native.timings ?? {};
        this.store.transitionNativeRun(run.id, [native.delivery], {
          delivery: native.nativeMessageId ? 'observed' : 'input_sent',
          stage: native.nativeMessageId ? 'executing' : native.intent === 'steer' ? 'steer_confirmation' : 'confirmation',
          expectsTurnOutcome: true, timings,
        }, { state: 'running', error: undefined });
      }
    }
  }

  /**
   * A provider that stays idle is no longer running this run, yet a lost completion event (hook
   * Stop, app-server turn end) would leave it `observed` and the session busy for ever. An active
   * turn the status still claims for this very run is that same lost event's residue — for a
   * hook-driven provider it is set by a tool hook and only the lost Stop clears it — so it cannot veto the idle screen;
   * a claim naming another turn still can. Delivery is already confirmed, so nothing can be sent
   * twice: close it as interrupted with a `turn_outcome_unknown` stage (shown as "result
   * unconfirmed") that no longer fences later sends. A completion or failure event for the same
   * turn that turns up later still sets the real result.
   *
   * A run that is explicitly waiting for its turn outcome gets `IDLE_OUTCOME_GRACE_MS` instead of
   * the plain idle window: another Stop hook may still be running after ours, and judging the
   * result unconfirmed while it works is a false alarm the late outcome would then have to correct.
   */
  private reconcileIdleRun(sessionId: string, runId: string, status: NativeStatus): void {
    const current = this.store.getRun(runId);
    const claimed = status.activeTurn;
    const staleClaim = claimed !== undefined && claimed.turnId === current.native?.nativeTurnId
      && (current.native?.nativeSessionId === undefined || claimed.nativeSessionId === current.native.nativeSessionId);
    if (status.phase !== 'idle' || (claimed && !staleClaim) || current.native?.delivery !== 'observed' || current.state !== 'running' || this.interrupting) {
      this.idleSince.delete(runId);
      return;
    }
    const since = this.idleSince.get(runId) ?? now();
    this.idleSince.set(runId, since);
    // A run waiting for its reported turn outcome gets the longer grace: the outcome is already
    // known to be coming, and another Stop hook may simply still be running.
    const window = current.native?.expectsTurnOutcome
      ? (this.options.idleOutcomeGraceMs ?? IDLE_OUTCOME_GRACE_MS)
      : (this.options.idleReconcileMs ?? IDLE_RECONCILE_MS);
    if (now() - since < window) return;
    this.idleSince.delete(runId);
    const closed = this.store.transitionNativeRun(runId, ['observed'], {
      delivery: 'cancelled', stage: 'turn_outcome_unknown', timings: { ...current.native.timings, interruptedAt: now() },
    }, { state: 'interrupted', error: '会话已回到空闲，但未收到该任务的完成确认，结果未确认；消息已送达，不会重发。' });
    if (closed) this.wakeSoon();
  }

  private trackTurnOutcome(run: Run, status?: NativeStatus): void {
    const native = run.native, target = status?.activeTurn;
    if (!native || native.intent || !this.traits(native.backendId).reportsTurnOutcome) return;
    if (target) {
      this.hookedTurns.add(this.turnKey(target.nativeSessionId, target.turnId));
      if (this.hookedTurns.size > OUTCOME_MEMORY) this.hookedTurns.delete(this.hookedTurns.values().next().value!);
    }
    if (native.expectsTurnOutcome || !native.nativeSessionId || !native.nativeTurnId
      || !this.hookedTurns.has(this.turnKey(native.nativeSessionId, native.nativeTurnId))) return;
    this.store.transitionNativeRun(run.id, [native.delivery], { expectsTurnOutcome: true });
  }

  private replayTurnOutcome(run: Run): void {
    const native = run.native;
    if (!native || native.intent || !native.nativeMessageId || !native.nativeSessionId || !native.nativeTurnId) return;
    const key = this.turnKey(native.nativeSessionId, native.nativeTurnId);
    const outcome = this.pendingTurnOutcomes.get(key);
    if (!outcome) return;
    this.pendingTurnOutcomes.delete(key);
    this.apply(run.sessionId, { type: 'events', events: [outcome] });
  }

  /** Returns persisted terminal state only when the Run still belongs to this exact session/chat. */
  private matchingTerminal(run: Run): TerminalInfo | undefined {
    const details = run.native;
    if (!details?.terminalId) return undefined;
    const session = this.store.getSession(run.sessionId);
    const linkedSessionId = session.nativeSessionId;
    const expectedSessionId = details.nativeSessionId;
    if (session.kind !== 'native' || session.terminalId !== details.terminalId || (expectedSessionId && linkedSessionId !== expectedSessionId)) return undefined;
    try {
      const terminal = this.store.getTerminal(details.terminalId);
      if (terminal.id !== details.terminalId || terminal.projectId !== session.projectId || !isAgentTerminal(terminal) || terminal.sessionId !== session.id) return undefined;
      return terminal;
    } catch {
      return undefined;
    }
  }

  cancel(sessionId: string, runId: string): Run {
    const run = this.store.getRun(runId);
    if (run.sessionId !== sessionId || !run.native) throw new AppError('RUN_NOT_FOUND', 'The message does not exist', 404);
    const changed = this.store.transitionNativeRun(runId, ['queued', 'preparing'], { delivery: 'cancelled', stage: 'cancelled' }, { state: 'cancelled' });
    if (!changed && !['cancelled', 'completed', 'failed'].includes(run.state)) throw new AppError('RUN_ALREADY_DISPATCHED', 'The message may already be running; use Stop instead', 409);
    this.pendingSteerOutcomes.delete(runId);
    return changed ?? run;
  }

  /** Checks only the persisted request and existing provider evidence; never submits input. */
  check(sessionId: string, runId: string): Promise<NativeRunRecovery> {
    const key = JSON.stringify([sessionId, runId]);
    const existing = this.recoveryChecks.get(key);
    if (existing) return existing;
    const task = this.readRecovery(sessionId, runId).finally(() => {
      if (this.recoveryChecks.get(key) === task) this.recoveryChecks.delete(key);
    });
    this.recoveryChecks.set(key, task);
    return task;
  }

  private recoveryRun(sessionId: string, runId: string): Run {
    const run = this.store.getRun(runId);
    if (run.sessionId !== sessionId || !run.native) throw new AppError('RUN_NOT_FOUND', 'The message does not exist', 404);
    return run;
  }

  private queuedRunIds(sessionId: string): string[] {
    return this.store.listUnfinishedNativeRuns(sessionId)
      .filter(run => run.native?.delivery === 'queued' && !run.native.intent).map(run => run.id);
  }

  private async readRecovery(sessionId: string, runId: string): Promise<NativeRunRecovery> {
    this.recoveryRun(sessionId, runId);
    await this.native.reconcile?.(sessionId);
    const snapshot = await this.native.snapshot(sessionId);
    this.observe(sessionId, { type: 'events', events: snapshot.events });
    this.observe(sessionId, { type: 'status', status: snapshot.status });
    let run = this.recoveryRun(sessionId, runId);
    const session = this.store.getSession(sessionId);
    const native = run.native!;
    const status = snapshot.status;
    let canContinue = native.delivery === 'uncertain' && !native.queueReleasedAt
      && !session.archivedAt && this.worker === undefined && !this.interrupting
      && !this.host.workspaceReserved(session) && status.phase === 'idle' && !status.activeTurn
      && !status.activity?.background && !status.activity?.compacting
      && Boolean(native.nativeSessionId && native.nativeSessionId === session.nativeSessionId)
      && (!native.terminalId || native.terminalId === session.terminalId);
    if (canContinue) canContinue = await this.native.canReleaseInput?.(session, run) ?? false;
    // The proof awaited I/O. A receipt or rebind during that read invalidates the offered action.
    run = this.recoveryRun(sessionId, runId);
    const latest = this.store.getSession(sessionId);
    const currentStatus = this.native.status(sessionId);
    canContinue &&= run.native?.delivery === 'uncertain' && !run.native.queueReleasedAt
      && latest.nativeSessionId === session.nativeSessionId && latest.terminalId === session.terminalId
      && currentStatus.phase === 'idle' && !currentStatus.activeTurn
      && !currentStatus.activity?.background && !currentStatus.activity?.compacting;
    return { run, canContinue, queuedRunIds: this.queuedRunIds(sessionId) };
  }

  /** A user may release a proven-empty input, while late evidence still corrects its history. */
  async continue(sessionId: string, runId: string, queuedRunIds: string[]): Promise<Run> {
    const run = this.recoveryRun(sessionId, runId);
    if (run.native?.queueReleasedAt) return run;
    if (this.recoveryActive) throw new AppError('NATIVE_RECOVERY_BUSY', 'A recovery action is already running', 409);
    this.recoveryActive = true;
    try {
      return await this.runtime.withSession(sessionId, async () => {
        const checked = await this.readRecovery(sessionId, runId);
        if (!checked.canContinue) throw new AppError('NATIVE_RECOVERY_UNSAFE', 'The original input cannot yet be safely released', 409);
        if (JSON.stringify(checked.queuedRunIds) !== JSON.stringify(queuedRunIds)) throw new AppError('NATIVE_QUEUE_CHANGED', 'The queued messages changed; review them before continuing', 409);
        return this.store.transitionNativeRun(runId, ['uncertain'], { queueReleasedAt: new Date().toISOString() })
          ?? this.recoveryRun(sessionId, runId);
      });
    } finally { this.recoveryActive = false; this.step(); }
  }

  /**
   * Stop the in-flight CLI turn and, when requested, accept its replacement before the dispatch
   * fence is released. This makes the stop receipt and follow-up acceptance one ordered action:
   * no queued prompt can slip between the two HTTP calls.
   */
  interrupt(sessionId: string, stop?: NativeStopRequest): Promise<Run | undefined> {
    return this.beginInterrupt(sessionId, undefined, undefined, undefined, stop);
  }

  interruptAndSend(sessionId: string, commandId: string, submit: () => Run, stop?: NativeStopRequest, replacementFingerprint?: string): Promise<Run> {
    if (!commandId || commandId.length > 200) return Promise.reject(new AppError('INVALID_COMMAND_ID', 'commandId must be a non-empty string up to 200 characters'));
    if (stop && !replacementFingerprint) return Promise.reject(new AppError('NATIVE_STOP_CONFLICT', 'The replacement message must keep its original identity', 409));
    return this.beginInterrupt(sessionId, commandId, submit, undefined, stop, replacementFingerprint).then(run => {
      if (!run) throw new AppError('NATIVE_INTERRUPT_SUBMISSION_FAILED', 'The turn stopped, but the follow-up message could not be queued', 500);
      return run;
    });
  }

  /** Stop the current turn and promote an existing queued run ahead of the rest of its queue. */
  sendQueuedNow(sessionId: string, runId: string, stop?: NativeStopRequest): Promise<Run> {
    const operationKey = `queued:${runId}`;
    const inFlight = this.interruptionTask;
    if (!stop && inFlight?.commandId === operationKey) {
      return inFlight.task.then(run => {
        if (!run) throw new AppError('NATIVE_INTERRUPT_SUBMISSION_FAILED', 'The turn stopped, but the queued message could not be promoted', 500);
        return run;
      });
    }

    let run: Run;
    try { run = this.store.getRun(runId); }
    catch (error) { return Promise.reject(error); }
    if (run.sessionId !== sessionId || !run.native) return Promise.reject(new AppError('RUN_NOT_FOUND', 'The message does not exist', 404));
    if (run.native.intent === 'steer') return Promise.reject(new AppError('STEER_ACTION_UNSUPPORTED', 'A steer message cannot interrupt and be sent as a new turn', 409));
    // Repeated clicks after a successful promotion are idempotent and must not interrupt the
    // follow-up that may already be running.
    if (run.native.stage === 'interrupt_followup' || Number.isFinite(run.native.timings?.promotedAt)) return Promise.resolve(run);
    if (run.native.delivery !== 'queued' || run.state !== 'queued') {
      return Promise.reject(new AppError('NATIVE_RUN_NOT_QUEUED', 'Only a message that is still queued can run now', 409));
    }

    return this.beginInterrupt(sessionId, operationKey, () => {
      const current = this.store.getRun(runId);
      if (current.sessionId !== sessionId || !current.native) throw new AppError('RUN_NOT_FOUND', 'The message does not exist', 404);
      if (current.native.stage === 'interrupt_followup' || Number.isFinite(current.native.timings?.promotedAt)) return current;
      if (current.native.delivery !== 'queued' || current.state !== 'queued') {
        throw new AppError('NATIVE_RUN_NOT_QUEUED', 'The queued message was cancelled or already started', 409);
      }
      this.nextAttempt.delete(runId);
      return current;
    }, runId, stop).then(promoted => {
      if (!promoted) throw new AppError('NATIVE_INTERRUPT_SUBMISSION_FAILED', 'The turn stopped, but the queued message could not be promoted', 500);
      return promoted;
    });
  }

  private assertStopTarget(sessionId: string, stop: NativeStopRequest): void {
    assertStopBinding(this.store, sessionId, stop);
    const status = this.native.status(sessionId);
    if (status.phase === 'offline' || status.connection && status.connection.state !== 'connected') {
      throw new AppError('NATIVE_STOP_UNCONFIRMED', 'Reconnect before stopping the original task', 409);
    }
    if ((status.activeTurn?.turnId ?? undefined) !== stop.turnId
      || (status.activeTurn && status.activeTurn.nativeSessionId !== stop.nativeSessionId)) {
      throw new AppError('NATIVE_STOP_TARGET_CHANGED', 'The original task changed; no stop was sent', 409);
    }
  }

  /**
   * A targeted stop settles the turn it names, not a released input and not another turn.
   * `terminalEpoch` is only the browser write lease (a drawer reconnect bumps it) and is not
   * compared here; `assertStopBinding` still checks that lease when a stop receipt is recovered.
   * With no turn id — none yet, or lost on restart — every unfinished run of that conversation
   * on the same terminal is the target.
   */
  private stopTargets(sessionId: string, stop?: NativeStopRequest): Map<string, NativeDeliveryState> {
    return new Map(this.store.listUnfinishedNativeRuns(sessionId).filter(run => {
      const native = run.native;
      if (!native || native.delivery === 'queued' || native.queueReleasedAt) return false;
      if (!stop) return true;
      if (native.nativeSessionId !== stop.nativeSessionId) return false;
      if (stop.terminalId !== undefined && native.terminalId !== undefined && native.terminalId !== stop.terminalId) return false;
      if (stop.turnId === undefined) return true;
      if (native.nativeTurnId === stop.turnId) return true;
      // The turn id is not on the run yet, but the write is already in flight on this terminal.
      // A slash command parked uncertain is an earlier input: stopping the named turn does not cancel it.
      if (!native.nativeTurnId && (native.delivery === 'dispatching' || native.delivery === 'input_sent' || native.delivery === 'uncertain')) {
        return !(native.delivery === 'uncertain' && isSlashCommand(native));
      }
      return false;
    }).map(run => [run.id, run.native!.delivery]));
  }

  /** Exact provider ends or the original process's exit establish an end; idle alone never does. */
  private stopEnded(sessionId: string, receipt: StopReceipt, events: NativeWorkbenchEvent[]): boolean {
    const stop = receipt.request;
    if (receipt.terminalId && receipt.terminalEpoch !== undefined) {
      const terminal = this.store.getTerminal(receipt.terminalId);
      if (terminal.epoch === receipt.terminalEpoch && terminal.state === 'exited') return true;
    }
    if (!stop.turnId) return false;
    const turnId = stop.turnId;
    const outcome = (event: NativeWorkbenchEvent) => ['run_completed', 'run_failed', 'run_cancelled'].includes(event.type)
      && this.turnOutcomeScope(sessionId, event)?.nativeSessionId === stop.nativeSessionId && event.nativeTurnId === turnId
      && outcomeRevision(event) >= (this.turnOutcomeRevisions.get(this.turnKey(stop.nativeSessionId, turnId)) ?? 1);
    if (events.some(outcome)) return true;
    const key = this.turnKey(stop.nativeSessionId, turnId);
    const pending = this.pendingTurnOutcomes.get(key);
    if (pending && outcome(pending)) return true;
    return this.store.findRunsByNativeTurn(sessionId, stop.nativeSessionId, turnId).some(run =>
      run.native?.stage === 'provider_cancelled' && run.native.delivery === 'cancelled' && run.state === 'interrupted'
      || run.native?.stage === 'provider_failed' && run.state === 'failed'
      || run.native?.stage === 'completed' && run.state === 'completed');
  }

  private async recoverStop(sessionId: string, receipt: StopReceipt, submit?: () => Run, promotedRunId?: string): Promise<Run | undefined> {
    assertStopBinding(this.store, sessionId, receipt.request, receipt);
    await this.native.reconcile?.(sessionId);
    const snapshot = await this.native.snapshot(sessionId);
    this.observe(sessionId, { type: 'events', events: snapshot.events });
    this.observe(sessionId, { type: 'status', status: snapshot.status });
    assertStopBinding(this.store, sessionId, receipt.request, receipt);
    if (!this.stopEnded(sessionId, receipt, snapshot.events)) {
      throw new AppError('NATIVE_STOP_UNCONFIRMED', 'The previous stop has not been confirmed; check the original task status', 409);
    }
    const session = this.store.getSession(sessionId);
    const targets = this.stopTargets(sessionId, receipt.request);
    const original = (receipt.targets ?? []).map(([id]) => this.store.getRun(id))
      .find(run => !run.native?.queueReleasedAt && run.native?.nativeSessionId === receipt.request.nativeSessionId
        && run.native?.nativeTurnId === receipt.request.turnId)
      ?? this.store.findRunsByNativeTurn(sessionId, receipt.request.nativeSessionId, receipt.request.turnId ?? '').find(run => !run.native?.intent && !run.native?.queueReleasedAt);
    // A pending stop may have left input in the CLI's composer/queue. Only the backend can prove
    // it absent; a confirmed turn end alone does not make a replacement safe to submit.
    if (submit || this.traits(session.backendId).stopKeepsPendingInput) {
      const status = this.native.status(sessionId);
      if (status.phase !== 'idle' || status.activeTurn || status.activity?.background || status.activity?.compacting
        || status.connection && status.connection.state !== 'connected'
        || !original || !await this.native.canReleaseInput?.(session, original)) {
        throw new AppError('NATIVE_STOP_UNCONFIRMED', 'The original input has not been confirmed safe to continue', 409);
      }
      assertStopBinding(this.store, sessionId, receipt.request, receipt);
      const latest = this.native.status(sessionId);
      if (latest.phase !== 'idle' || latest.activeTurn || latest.activity?.background || latest.activity?.compacting
        || latest.connection && latest.connection.state !== 'connected') {
        throw new AppError('NATIVE_STOP_TARGET_CHANGED', 'A newer task is running; the replacement was not sent', 409);
      }
    }
    const settled = this.store.transaction(() => {
      const interrupted = this.settleInterrupted(targets, this.traits(session.backendId));
      const run = submit ? this.acceptFollowUp(submit, promotedRunId) : interrupted;
      saveStopReceipt(this.store, sessionId, { ...receipt, state: 'completed', ...(run ? { runId: run.id } : {}) });
      return run;
    });
    await this.adapter.endInterruptedTurns(sessionId, targets, receipt.request);
    return settled;
  }

  private beginInterrupt(sessionId: string, commandId?: string, submit?: () => Run, promotedRunId?: string, stop?: NativeStopRequest, replacementFingerprint?: string): Promise<Run | undefined> {
    if (this.host.workspaceReserved(this.store.getSession(sessionId))) return Promise.reject(this.host.workspaceBusy());
    const operation = commandId ?? 'stop';
    const operationKey = stop ? `stop:${stop.requestId}` : commandId;
    const fingerprint = stop ? stopFingerprint(stop, operation, replacementFingerprint) : undefined;
    const receipt = stop ? readStopReceipt(this.store, sessionId, stop) : undefined;
    if (receipt && stopFingerprint(receipt.request, receipt.operation, receipt.replacementFingerprint) !== fingerprint) {
      return Promise.reject(new AppError('NATIVE_STOP_CONFLICT', 'This stop request belongs to a different operation', 409));
    }
    if (receipt?.state === 'completed') return Promise.resolve(receipt.runId ? this.store.getRun(receipt.runId) : undefined);
    const existing = this.interruptionTask;
    if (existing) {
      if (operationKey && existing.commandId === operationKey) {
        if (existing.fingerprint !== fingerprint) return Promise.reject(new AppError('NATIVE_STOP_CONFLICT', 'This stop request belongs to a different operation', 409));
        return existing.task;
      }
      return Promise.reject(new AppError('NATIVE_INTERRUPT_IN_PROGRESS', 'The current turn is stopping; try again shortly', 409));
    }
    if (receipt && this.recoveryActive) return Promise.reject(new AppError('NATIVE_RECOVERY_BUSY', 'A recovery action is already running', 409));
    if (!receipt) {
      try { if (stop) this.assertStopTarget(sessionId, stop); }
      catch (error) { return Promise.reject(error); }
    }
    this.interrupting = true;
    if (receipt) this.recoveryActive = true;
    const targets = this.stopTargets(sessionId, stop);
    const task = Promise.resolve().then(() => {
      if (receipt) return this.runtime.withSession(sessionId, () => this.recoverStop(sessionId, receipt, submit, promotedRunId));
      // This releases only a read-only receipt wait; every external Stop remains under the lock.
      this.adapter.requestInterrupt(sessionId);
      return this.runtime.withSession(sessionId, async () => {
        if (stop) {
          this.assertStopTarget(sessionId, stop);
          const session = this.store.getSession(sessionId);
          const terminal = session.terminalId ? this.store.getTerminal(session.terminalId) : undefined;
          saveStopReceipt(this.store, sessionId, { request: stop, operation, state: 'pending', createdAt: new Date().toISOString(),
            ...(replacementFingerprint ? { replacementFingerprint } : {}), targets: [...targets],
            ...(terminal ? { terminalId: terminal.id, terminalEpoch: terminal.epoch } : {}) });
        }
        let run: Run | undefined;
        try { run = await this.performInterrupt(sessionId, submit, targets, promotedRunId, stop); }
        catch (error) {
          if (!stop || error instanceof AppError && error.code === 'NATIVE_STOP_TARGET_CHANGED') throw error;
          saveStopReceipt(this.store, sessionId, { ...readStopReceipt(this.store, sessionId, stop)!, error: {
            ...(error instanceof AppError ? { code: error.code } : {}),
            message: redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 1000),
          } });
          throw new AppError('NATIVE_STOP_UNCONFIRMED', 'The stop has not been confirmed; check the original task status', 409);
        }
        if (stop) saveStopReceipt(this.store, sessionId, { ...readStopReceipt(this.store, sessionId, stop)!, state: 'completed', ...(run ? { runId: run.id } : {}) });
        return run;
      });
    }).finally(() => {
      this.interrupting = false;
      if (receipt) this.recoveryActive = false;
      if (this.interruptionTask?.task === task) this.interruptionTask = undefined;
      this.step();
    });
    this.interruptionTask = { ...(operationKey ? { commandId: operationKey } : {}), ...(fingerprint ? { fingerprint } : {}), task };
    return task;
  }

  private async performInterrupt(sessionId: string, submit: (() => Run) | undefined, targets: Map<string, NativeDeliveryState>, promotedRunId?: string, stop?: NativeStopRequest): Promise<Run | undefined> {
    const session = this.store.getSession(sessionId);
    if (session.kind !== 'native') throw new AppError('NOT_NATIVE', 'Only native conversations can be interrupted', 409);
    const activeBefore = this.readStatus(sessionId)?.activeTurn;
    const activeTurnId = activeBefore && (!session.nativeSessionId || activeBefore.nativeSessionId === session.nativeSessionId)
      ? activeBefore.turnId : undefined;
    let accepted: Run | undefined;
    // A backend that replaces its turn itself gets the follow-up straight away. The adapter
    // decides that; this method only deals with the queue and the stop receipt. Should the CLI
    // never take the replacement, the run stays first in the queue and the stop below goes ahead.
    if (submit && !this.host.draining()) {
      const replacement = await this.adapter.replaceTurn({
        session,
        ...(stop ? { expectedStop: stop } : {}),
        isClosed: () => this.host.closed,
        isInterrupting: () => this.interrupting,
        readStatus: (id) => this.readStatus(id),
        claim: () => {
          if (stop) this.assertStopTarget(sessionId, stop);
          const run = this.acceptFollowUp(submit, promotedRunId);
          accepted = run;
          if (!run.native || isSlashCommand(run.native) || run.native.delivery !== 'queued' || run.state !== 'queued') return undefined;
          return { run, initial: run.native, isSlash: isSlashCommand(run.native) };
        },
        arm: (claimed) => this.armDelivery(claimed.run, claimed.initial),
        open: (claimed, armed) => this.openDelivery(claimed.run, armed),
        recover: (claimed, error) => this.recoverDelivery(claimed.run.id, claimed.initial, { now: true, ...(stop ? { expectedStop: stop } : {}) }, error),
        observe: (observedSessionId, result) => this.observeSnapshot(observedSessionId, result),
      });
      if (replacement.status === 'delivered') {
        const after = this.store.getRun(replacement.run.id);
        if (after.native?.delivery === 'failed') return after;
        if (after.native?.delivery !== 'queued') {
          this.settleInterrupted(targets, this.traits(session.backendId));
          await this.adapter.endInterruptedTurns(sessionId, targets, stop, activeTurnId);
          return after;
        }
        this.nextAttempt.delete(after.id);
      }
    }
    // NativeService only resolves after the live pane is confirmed idle or the same terminal
    // epoch exits. An error leaves the active run and the new draft untouched.
    if (stop) this.assertStopTarget(sessionId, stop);
    await this.adapter.stopTurn(session, { clearPrompt: Boolean(submit), hasTargets: targets.size > 0, ...(stop ? { expectedStop: stop } : {}) });
    const interrupted = this.settleInterrupted(targets, this.traits(session.backendId));
    await this.adapter.endInterruptedTurns(sessionId, targets, stop, activeTurnId);
    if (submit) return accepted ? this.store.getRun(accepted.id) : this.acceptFollowUp(submit, promotedRunId);
    return interrupted;
  }

  /** Accepts the follow-up of an interrupt as the first run of its queue. */
  private acceptFollowUp(submit: () => Run, promotedRunId?: string): Run {
    const accepted = submit();
    if (accepted.native?.delivery === 'queued' && accepted.state === 'queued') {
      return this.store.transitionNativeRun(accepted.id, ['queued'], {
        stage: 'interrupt_followup',
        ...(accepted.id === promotedRunId ? { timings: { ...accepted.native.timings, promotedAt: accepted.native.timings?.promotedAt ?? now() } } : {}),
      }) ?? accepted;
    }
    return accepted;
  }

  /** Closes the runs a confirmed stop ended; returns the last one the CLI had been running. */
  private settleInterrupted(targets: Map<string, NativeDeliveryState>, traits: NativeBackendTraits): Run | undefined {
    let interrupted: Run | undefined;
    for (const [runId, initialDelivery] of targets) {
      const run = this.store.getRun(runId);
      const delivery = run.native?.delivery;
      if (!delivery || ['completed', 'failed', 'cancelled'].includes(run.state)) continue;
      // Text a CLI may already hold in its input box or queue (Claude) is neither delivered nor taken
      // back by a stop: the stop only ends what was running. Its own records settle the run — a prompt
      // row starts it, a `queue-operation` removal or a cleared input box (reported as `run_cancelled`)
      // cancels it — so a message is never closed as cancelled while the CLI can still submit it.
      if (traits.stopKeepsPendingInput && run.native?.intent !== 'steer'
        && (delivery === 'dispatching' || delivery === 'input_sent'
          // Stop may have released a send's receipt wait to acquire this lock. That makes the
          // delivery uncertain; it does not prove the CLI removed the input it may still hold.
          || delivery === 'uncertain' && !run.native?.nativeMessageId
          // A queue receipt proves delivery, but names no executing turn. Stopping the main
          // turn cannot take back this input; its own native consumption/removal must settle it.
          || delivery === 'observed' && !run.native?.nativeTurnId)) continue;
      // Preparing never crossed the write fence, even if its worker has since returned it to the
      // queue because this interrupt request owned the terminal lock. Other states may have been
      // accepted by the CLI and remain visible as an interrupted run.
      const preparing = initialDelivery === 'preparing';
      // A steer the stop came before is kept as the next message, like the messages queued behind it.
      if (preparing && run.native?.intent === 'steer') { this.requeueSteer(run.id); continue; }
      const allowed: NativeDeliveryState[] = preparing ? ['queued', 'preparing'] : [delivery];
      if (!preparing && run.native?.intent === 'steer' && !run.native.nativeMessageId) {
        // Stopping the turn does not establish whether an unconfirmed input reached it,
        // but a confirmed stop ends the turn this steer was bound to, so release the queue hold.
        this.store.transitionNativeRun(run.id, allowed, {
          delivery: 'uncertain', stage: 'steer_stopped',
          queueReleasedAt: run.native.queueReleasedAt ?? new Date().toISOString(),
          timings: { ...run.native.timings, interruptedAt: now() },
        }, { state: 'interrupted', error: run.error ?? '任务已停止，补充消息是否收到仍无法确认。' });
        continue;
      }
      const changed = this.store.transitionNativeRun(run.id, allowed, {
        delivery: 'cancelled',
        stage: preparing ? 'cancelled' : 'interrupted',
        timings: { ...run.native?.timings, ...(preparing ? {} : { interruptedAt: now() }) },
      }, preparing
        ? { state: 'cancelled', error: undefined }
        : { state: 'interrupted', error: undefined });
      if (changed) this.pendingSteerOutcomes.delete(runId);
      if (changed && !preparing) interrupted = changed;
    }
    return interrupted;
  }
}
