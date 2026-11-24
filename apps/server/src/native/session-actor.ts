import { isAssistantBackend } from '../../../../packages/contracts/src/assistant-choice.js';
import type { NativeQueue, NativeRunRecovery, NativeStatus, NativeStopRequest, NativeWorkbenchEvent, Run, Session } from '../../../../packages/contracts/src/index.js';
import type { Store } from '../store.js';
import type { NativeBackendTraits } from '../backends/types.js';
import { AppError } from '../errors.js';
import { redactSensitiveText } from '../settings/config-documents.js';
import { admission, heldByProvider, holdsUnconfirmed, nextLook, queueOf, steerTurnEnded, type Admission } from './lane.js';
import type { DispatchObservation, NativeDispatcherBackend } from './dispatch.js';
import { ExecutionAdapter, type TurnDeliveryResult } from './execution-adapter.js';
import { Mailbox } from './mailbox.js';
import { readStopReceipt } from './stop-receipt.js';
import { DispatchTrace, phaseOf, type DispatchTraceEntry, type SessionPhase } from './trace.js';
import {
  applyObservation, IDLE_OUTCOME_GRACE_MS, IDLE_RECONCILE_MS, isSlashCommand,
  releaseEndedSteers, trackTurnOutcome, watchDeliveries, type ActorObservationDeps,
} from './actor-observations.js';
import { awaitingLaterTurn, beginInterrupt, checkRecovery, continueRecovery, idleForRecovery, releaseAfterLaterTurn, type ActorControlDeps } from './actor-interrupt.js';

export { IDLE_OUTCOME_GRACE_MS, IDLE_RECONCILE_MS };

const now = () => Date.now();
/**
 * How long a message may keep bouncing off a CLI that is not at a prompt *and* is not running a turn
 * (still starting, or a screen we cannot read) before it is failed. Waiting behind a live turn is the
 * queue working as intended and is never counted; this only bounds a wedge that would otherwise retry
 * silently for ever. Longer than a cold Claude Code start with MCP servers and a large resume.
 */
export const CLI_BUSY_LIMIT_MS = 3 * 60_000;

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

type ActorMessage =
  | { type: 'wake' }
  | { type: 'observation'; sessionId: string; observation: DispatchObservation }
  | { type: 'settle' };

/**
 * Whether an unfinished native run still needs a standing live watch on its provider.
 * Released inputs are history. Late receipts and turn ends reach them through `subscribeCorrections`.
 */
export function runNeedsDispatchWatch(run: Run): boolean {
  return !run.native?.queueReleasedAt;
}

/** Process-wide services a session actor may use. Cross-session state stays on the coordinator. */
export interface SessionActorHost {
  readonly store: Store;
  readonly native: NativeDispatcherBackend;
  readonly runtime: {
    withSession<T>(sessionId: string, operation: () => Promise<T>, options?: { detached?: boolean }): Promise<T>;
    /** With an initial prompt, fence immediately before spawning the CLI. */
    ensure(session: Session, options?: { initialPrompt?: string; beforeSpawn?: () => void | Promise<void> }): Promise<unknown>;
  };
  readonly workspace: import('../workspace/index.js').WorkspaceService;
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
 */
export class SessionActor {
  worker: Promise<void> | undefined;
  unsubscribeObserver: (() => void) | undefined;
  readonly nextAttempt = new Map<string, number>();
  startReservations = 0;
  interrupting = false;
  interruptionTask: { commandId?: string; fingerprint?: string; task: Promise<Run | undefined> } | undefined;
  readonly recoveryChecks = new Map<string, Promise<NativeRunRecovery>>();
  recoveryActive = false;
  private releaseCheck?: Promise<void>;
  private releaseCheckPending = false;
  private releaseIdle = false;
  private releaseEndSequence = 0;
  readonly steerTasks = new Map<string, Promise<Run>>();
  readonly pendingSteerOutcomes = new Map<string, NativeWorkbenchEvent>();
  readonly pendingTurnOutcomes = new Map<string, NativeWorkbenchEvent>();
  readonly turnOutcomeRevisions = new Map<string, number>();
  readonly hookedTurns = new Set<string>();
  readonly idleSince = new Map<string, number>();
  readonly drainHeldSteers = new Set<string>();
  timer: NodeJS.Timeout | undefined;

  private timerAt: number | undefined;
  private readonly mailbox = new Mailbox<ActorMessage>(message => this.receive(message),
    (last, next) => next.type !== 'observation' && (last.type === 'wake' || last.type === next.type),
    (message, error) => console.warn(`[dispatch] a queued ${message.type} for ${this.sessionId} failed:`, error));
  private waking = false;
  private subscribing = false;
  private idleQueued = false;
  private readonly traced: DispatchTrace | undefined;
  private readonly adapter: ExecutionAdapter;
  private readonly obsDeps: ActorObservationDeps;
  private readonly ctrlDeps: ActorControlDeps;

  constructor(private readonly host: SessionActorHost, readonly sessionId: string) {
    this.adapter = new ExecutionAdapter({
      store: host.store,
      native: host.native,
      runtime: host.runtime,
      workspace: host.workspace,
      traits: backendId => (backendId && host.native.traits?.(backendId)) || {},
    });
    if (host.options.log) this.traced = new DispatchTrace(sessionId, host.options.log);
    this.obsDeps = {
      store: host.store,
      native: host.native,
      adapter: this.adapter,
      options: host.options,
      idleSince: this.idleSince,
      pendingSteerOutcomes: this.pendingSteerOutcomes,
      pendingTurnOutcomes: this.pendingTurnOutcomes,
      turnOutcomeRevisions: this.turnOutcomeRevisions,
      hookedTurns: this.hookedTurns,
      isClosed: () => this.host.closed,
      isInterrupting: () => this.interrupting,
      traits: backendId => this.traits(backendId),
      markSteerMissed: runId => this.markSteerMissed(runId),
      wakeSoon: () => this.wakeSoon(),
    };
    this.ctrlDeps = {
      store: host.store,
      native: host.native,
      adapter: this.adapter,
      runtime: host.runtime,
      nextAttempt: this.nextAttempt,
      recoveryChecks: this.recoveryChecks,
      pendingSteerOutcomes: this.pendingSteerOutcomes,
      pendingTurnOutcomes: this.pendingTurnOutcomes,
      turnOutcomeRevisions: this.turnOutcomeRevisions,
      sessionId,
      isClosed: () => this.host.closed,
      draining: () => this.host.draining(),
      workspaceReserved: session => this.host.workspaceReserved(session),
      workspaceBusy: () => this.host.workspaceBusy(),
      getInterrupting: () => this.interrupting,
      setInterrupting: value => { this.interrupting = value; },
      getRecoveryActive: () => this.recoveryActive,
      setRecoveryActive: value => { this.recoveryActive = value; },
      getInterruptionTask: () => this.interruptionTask,
      setInterruptionTask: task => { this.interruptionTask = task; },
      traits: backendId => this.traits(backendId),
      readStatus: id => this.readStatus(id),
      observe: (id, message) => this.observe(id, message),
      step: () => this.step(),
      markSteerMissed: runId => this.markSteerMissed(runId),
      armDelivery: (run, initial) => this.armDelivery(run, initial),
      openDelivery: (run, armed) => this.openDelivery(run, armed),
      recoverDelivery: (runId, initial, options, error) => this.recoverDelivery(runId, initial, options, error),
      observeSnapshot: (id, result) => this.observeSnapshot(id, result),
    };
  }

  private get store() { return this.host.store; }
  private get native() { return this.host.native; }
  private get runtime() { return this.host.runtime; }
  private get options() { return this.host.options; }

  isIdle(runs = this.store.listUnfinishedNativeRuns(this.sessionId)): boolean {
    return !runs.some(runNeedsDispatchWatch) && this.worker === undefined && !this.interrupting && this.interruptionTask === undefined
      && !this.recoveryActive && !this.releaseCheck && this.recoveryChecks.size === 0 && this.steerTasks.size === 0
      && this.startReservations === 0 && this.drainHeldSteers.size === 0 && this.timer === undefined;
  }

  blocksWorkspace(): boolean {
    return this.worker !== undefined || this.startReservations > 0 || this.steerTasks.size > 0 || this.interrupting;
  }

  queue(status: NativeStatus): NativeQueue {
    return queueOf(this.admission(this.sessionId, this.store.listUnfinishedNativeRuns(this.sessionId), status));
  }

  step(): void { this.mailbox.post({ type: 'wake' }); }
  observe(sessionId: string, message: DispatchObservation): void { this.mailbox.post({ type: 'observation', sessionId, observation: message }); }
  settle(): void { this.mailbox.post({ type: 'settle' }); }

  private receive(message: ActorMessage): void {
    if (message.type === 'wake') { this.wake(); return; }
    if (message.type === 'settle') {
      if (!this.host.closed && this.attached()) this.finish(false, message.type);
      return;
    }
    if (this.host.closed) return;
    try { this.apply(message.sessionId, message.observation); }
    finally { this.finish(false, message.type, message.observation); }
  }

  private wake(): void {
    if (this.host.closed || !this.attached()) return;
    let startedIdle = false;
    try {
      let runs = this.store.listUnfinishedNativeRuns(this.sessionId);
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
        if (runs.some(runNeedsDispatchWatch)) this.ensureObserver();
        if (!this.native.pending?.(session.backendId ?? '')) {
          if (releaseEndedSteers(this.store, runs)) runs = this.store.listUnfinishedNativeRuns(this.sessionId);
          if (this.settleOrphanedSteers(this.sessionId, runs)) runs = this.store.listUnfinishedNativeRuns(this.sessionId);
          if (runs.some(run => run.native?.intent !== 'steer' && run.native?.delivery === 'queued') && !this.host.draining() && this.worker === undefined) {
            const { next: run, held } = this.admission(this.sessionId, runs);
            if (!held && run) this.startWorker(run.id);
          }
        }
      }
      this.watchDeliveries(runs);
      const afterWatch = this.store.listUnfinishedNativeRuns(this.sessionId);
      if (afterWatch.some(run => run.native?.intent === 'steer' && run.native.delivery === 'uncertain' && !run.native.queueReleasedAt)) {
        releaseEndedSteers(this.store, afterWatch, this.readStatus(this.sessionId));
      }
    } finally {
      this.finish(startedIdle, 'wake');
    }
  }

  shutdown(): Promise<void> {
    this.dropObserver();
    this.clearTimer();
    const pending: Array<Promise<unknown>> = [];
    if (this.worker) pending.push(this.worker);
    // Deletion already holds the session lock. Any queued probe will see the detached actor.
    if (this.host.closed && this.releaseCheck) pending.push(this.releaseCheck);
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

  private attached(): boolean { return this.host.current(this.sessionId) === this; }

  private finish(evictNow: boolean, cause: ActorMessage['type'], observation?: DispatchObservation): void {
    if (this.host.closed || !this.attached()) { this.clearTimer(); return; }
    let runs = this.store.listUnfinishedNativeRuns(this.sessionId);
    if (runs.some(runNeedsDispatchWatch) && !this.workspaceBlocked()) this.ensureObserver();
    if (!this.attached()) { this.clearTimer(); return; }
    runs = this.store.listUnfinishedNativeRuns(this.sessionId);
    if (cause !== 'settle') this.checkForLaterTurn(runs, observation);
    this.scheduleTimer(runs);
    this.traced?.record(runs, this.phase(runs), cause, id => { try { return this.store.getRun(id); } catch { return undefined; } });
    if (this.mailbox.pending) return;
    if (this.shouldDispatch(runs)) this.wakeSoon();
    else if (this.isIdle(runs)) {
      if (evictNow) this.host.onIdle(this.sessionId, this);
      else this.deferIdle();
    }
  }

  private checkForLaterTurn(runs: readonly Run[], observation?: DispatchObservation): void {
    if (!this.native.canReleaseAfterLaterTurn) return;
    const available = () => this.attached() && !this.host.closed && !this.host.draining() && !this.recoveryActive
      && !this.interrupting && !this.interruptionTask && !this.worker && !this.steerTasks.size;
    if (!available()) return;
    const old = runs.find(awaitingLaterTurn);
    if (!old) return;
    // Refreshing the provider can echo idle and replay the same completed row. Only a new idle
    // boundary or a newer journal completion warrants another probe; explicit wakes always do.
    if (observation?.type === 'status') {
      const idle = idleForRecovery(observation.status);
      if (this.releaseIdle === idle) return;
      this.releaseIdle = idle;
      if (!idle) return;
    } else if (observation?.type === 'events') {
      const previous = this.releaseEndSequence;
      for (const event of observation.events) {
        if (event.type === 'run_completed') this.releaseEndSequence = Math.max(this.releaseEndSequence, event.sequence);
      }
      if (this.releaseEndSequence === previous) return;
    }
    if (!idleForRecovery(this.readStatus(this.sessionId))) return;
    this.releaseIdle = true;
    if (this.releaseCheck) { this.releaseCheckPending = true; return; }
    // The same session lock serializes this check with sends and stops. Success only lifts the hold;
    // the next message must go through normal admission and its own durable write fence.
    this.releaseCheck = Promise.resolve().then(() => this.runtime.withSession(this.sessionId, () =>
      releaseAfterLaterTurn(this.ctrlDeps, old.id, available), { detached: true }))
      .catch(() => false).then(released => {
        this.releaseCheck = undefined;
        const retry = this.releaseCheckPending;
        this.releaseCheckPending = false;
        if (released || retry) this.wakeSoon();
        else this.deferIdle();
      });
  }

  phase(runs: readonly Run[] = this.store.listUnfinishedNativeRuns(this.sessionId)): SessionPhase {
    return phaseOf(runs, { stopping: this.interrupting || this.interruptionTask !== undefined, recovering: this.recoveryActive, sending: this.worker !== undefined || this.steerTasks.size > 0 });
  }

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
    this.worker = work;
    release(this.runtime.withSession(this.sessionId, () => this.execute(runId)).then(() => undefined, () => undefined));
  }

  private ensureObserver(): void {
    if (this.unsubscribeObserver || this.subscribing) return;
    this.subscribing = true;
    try {
      const unsubscribe = this.native.subscribe(this.sessionId, message => this.observe(this.sessionId, message));
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

  private providerHold(runs: readonly Run[]): boolean {
    if (this.worker !== undefined || this.host.closed || this.host.draining()) return false;
    try { return heldByProvider(this.admission(this.sessionId, runs)); } catch { return false; }
  }

  private watchDeliveries(runs: readonly Run[]): void {
    watchDeliveries(this.obsDeps, runs);
  }

  private resumeDrainHeldSteers(): void {
    for (const runId of [...this.drainHeldSteers]) {
      this.drainHeldSteers.delete(runId);
      try { void this.steer(this.sessionId, runId).catch(() => undefined); } catch { /* sent on as a message or gone */ }
    }
  }

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

  private settleOrphanedSteers(sessionId: string, runs: readonly Run[]): boolean {
    const orphaned = runs.filter(run => run.native?.intent === 'steer' && ['queued', 'preparing'].includes(run.native.delivery) && !this.steerTasks.has(run.id));
    if (!orphaned.length) return false;
    const status = this.readStatus(sessionId);
    let moved = false;
    for (const run of orphaned) if (steerTurnEnded(run, status, item => this.store.isSteerTargetTurnEnded(item))) moved = this.markSteerMissed(run.id) || moved;
    return moved;
  }

  private markSteerMissed(runId: string): boolean {
    this.pendingSteerOutcomes.delete(runId);
    this.nextAttempt.delete(runId);
    return Boolean(this.store.markSteerMissed(runId));
  }

  private armDelivery(run: Run, initial: NonNullable<Run['native']>): { prepareAt: number; checkpoint: boolean } | undefined {
    if (this.host.closed || run.native?.delivery !== 'queued') return undefined;
    const checkpoint = Boolean(this.options.beforeTurn && !initial.checkpointAttempted && !isSlashCommand(initial));
    const prepareAt = now();
    if (!this.store.transitionNativeRun(run.id, ['queued'], {
      delivery: 'preparing', stage: 'runtime', attempt: initial.attempt + 1,
      ...(checkpoint ? { checkpointAttempted: true } : {}),
      timings: { ...initial.timings, ...(initial.stage === 'interrupt_followup' ? { promotedAt: initial.timings?.promotedAt ?? prepareAt } : {}), prepareAt },
    })) return undefined;
    return { prepareAt, checkpoint };
  }

  private openDelivery(run: Run, armed: { prepareAt: number; checkpoint: boolean }): Session {
    const session = this.store.getSession(run.sessionId);
    if (session.archivedAt) throw new AppError('ARCHIVED_SESSION', 'This conversation is archived', 409);
    const project = this.store.getProject(session.projectId);
    if (project.archivedAt) throw new AppError('ARCHIVED_PROJECT', 'Restore this project before running a conversation', 409);
    if (project.system === 'assistant' && !isAssistantBackend(session.backendId)) throw new AppError('ASSISTANT_BACKEND_UNSUPPORTED', 'The personal assistant runs on Claude Code, Codex, or Cursor', 409);
    if (armed.checkpoint) void Promise.resolve().then(() => this.options.beforeTurn!(session, run, armed.prepareAt)).catch(() => undefined);
    return session;
  }

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

  private observeSnapshot(sessionId: string, result: TurnDeliveryResult): void {
    if (!result.snapshot) return;
    this.observe(sessionId, { type: 'events', events: result.snapshot.events });
    this.observe(sessionId, { type: 'status', status: result.snapshot.status });
  }

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
      if (code === 'NATIVE_STOP_TARGET_CHANGED' && options.now && options.expectedStop) {
        const { promotedAt: _promoted, ...timings } = run.native?.timings ?? {};
        this.store.transitionNativeRun(runId, ['preparing'], { delivery: 'queued', stage: undefined, timings }, { state: 'queued', error: undefined });
        throw error;
      }
      if (['CLI_BUSY', 'CLI_INTERACTION_REQUIRED', 'TERMINAL_INTERACTION_BUSY', 'TERMINAL_INTERACTION_STALE', 'TERMINAL_CONTROL_STALE', 'TERMINAL_DETACHED', 'DISPATCH_STOPPED', 'NATIVE_INTERRUPT_IN_PROGRESS', 'NATIVE_LAUNCH_ABORTED'].includes(code)) {
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
        this.store.transitionNativeRun(run.id, ['preparing'], { delivery: 'queued', stage: initial.stage === 'interrupt_followup' ? 'interrupt_followup' : code === 'CLI_INTERACTION_REQUIRED' ? 'interaction' : 'waiting', timings: blockedAt === undefined ? timings : { ...timings, blockedAt } }, { state: 'queued', error: undefined });
      } else {
        this.store.transitionNativeRun(runId, ['preparing'], { delivery: 'failed', stage: 'prepare' }, { state: 'failed', error: message });
      }
    }
  }

  private traits(backendId: string | undefined): NativeBackendTraits {
    return (backendId && this.native.traits?.(backendId)) || {};
  }

  private runningTurn(sessionId: string): boolean {
    try {
      const status = this.native.status(sessionId);
      if (['busy', 'attention'].includes(status.phase)) return true;
      const session = this.store.getSession(sessionId);
      return Boolean(session.configPending && this.traits(session.backendId).relaunchesForPendingConfig
        && (status.activity?.background || status.activity?.compacting));
    } catch { return false; }
  }

  steer(sessionId: string, runId: string): Promise<Run> {
    const existing = this.steerTasks.get(runId);
    if (existing) return existing;
    const run = this.store.getRun(runId);
    if (this.host.workspaceReserved(this.store.getSession(sessionId))) return Promise.reject(this.host.workspaceBusy());
    if (run.sessionId !== sessionId || run.native?.intent !== 'steer') throw new AppError('RUN_NOT_FOUND', 'The steer message does not exist', 404);
    if (run.native.delivery !== 'queued') return Promise.resolve(run);
    if (this.host.draining()) { this.drainHeldSteers.add(runId); return Promise.resolve(run); }
    const task = this.runtime.withSession(sessionId, async () => {
      const current = this.store.getRun(runId);
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
          if (owner) trackTurnOutcome(this.obsDeps, owner, status);
          if (this.store.listUnfinishedNativeRuns(sessionId).some(other => other.id !== runId && holdsUnconfirmed(other, status, item => this.store.isSteerTargetTurnEnded(item)))) {
            throw new AppError('NATIVE_DELIVERY_UNCERTAIN', 'Another message has an unconfirmed outcome; check it first', 409);
          }
          return session;
        };
        const session = check();
        const result = await this.adapter.steerTurn(session, current, binding => {
          if (this.store.getRun(runId).native?.delivery !== 'preparing') throw new AppError('RUN_CANCELLED', 'The steer message was cancelled', 409);
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
          this.store.transitionNativeRun(runId, ['preparing'], { stage: 'steer_waiting_boundary' });
          return this.store.getRun(runId);
        }
        if (delivered.native!.stage === 'steer_missed' || delivered.native!.delivery === 'cancelled') return delivered;
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
        if (delivery === 'queued' || delivery === 'preparing') {
          if (code === 'STEER_TARGET_CHANGED' || code === 'NATIVE_STEER_TARGET_GONE' || code === 'NATIVE_INTERRUPT_IN_PROGRESS' || code === 'DISPATCH_STOPPED') {
            this.markSteerMissed(runId);
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

  private apply(sessionId: string, message: DispatchObservation): void {
    applyObservation(this.obsDeps, sessionId, message);
  }

  cancel(sessionId: string, runId: string): Run {
    const run = this.store.getRun(runId);
    if (run.sessionId !== sessionId || !run.native) throw new AppError('RUN_NOT_FOUND', 'The message does not exist', 404);
    const changed = this.store.transitionNativeRun(runId, ['queued', 'preparing'], { delivery: 'cancelled', stage: 'cancelled' }, { state: 'cancelled' });
    if (!changed && !['cancelled', 'completed', 'failed'].includes(run.state)) throw new AppError('RUN_ALREADY_DISPATCHED', 'The message may already be running; use Stop instead', 409);
    this.pendingSteerOutcomes.delete(runId);
    return changed ?? run;
  }

  async check(sessionId: string, runId: string): Promise<NativeRunRecovery> {
    const run = this.store.getRun(runId);
    if (run.sessionId === sessionId) this.checkForLaterTurn([run]);
    if (this.releaseCheck) await this.releaseCheck;
    return checkRecovery(this.ctrlDeps, sessionId, runId);
  }

  continue(sessionId: string, runId: string, queuedRunIds: string[]): Promise<Run> {
    return continueRecovery(this.ctrlDeps, sessionId, runId, queuedRunIds, () => this.worker !== undefined);
  }

  interrupt(sessionId: string, stop?: NativeStopRequest): Promise<Run | undefined> {
    return beginInterrupt(this.ctrlDeps, sessionId, undefined, undefined, undefined, stop);
  }

  interruptAndSend(sessionId: string, commandId: string, submit: () => Run, stop?: NativeStopRequest, replacementFingerprint?: string): Promise<Run> {
    if (!commandId || commandId.length > 200) return Promise.reject(new AppError('INVALID_COMMAND_ID', 'commandId must be a non-empty string up to 200 characters'));
    if (stop && !replacementFingerprint) return Promise.reject(new AppError('NATIVE_STOP_CONFLICT', 'The replacement message must keep its original identity', 409));
    return beginInterrupt(this.ctrlDeps, sessionId, commandId, submit, undefined, stop, replacementFingerprint).then(run => {
      if (!run) throw new AppError('NATIVE_INTERRUPT_SUBMISSION_FAILED', 'The turn stopped, but the follow-up message could not be queued', 500);
      return run;
    });
  }

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
    if (!stop || !readStopReceipt(this.store, sessionId, stop)) {
      const promoted = run.native.stage === 'interrupt_followup' || Number.isFinite(run.native.timings?.promotedAt);
      if (promoted && !stop) return Promise.resolve(run);
      if (promoted || run.native.delivery !== 'queued' || run.state !== 'queued') {
        return Promise.reject(new AppError('NATIVE_RUN_NOT_QUEUED', 'Only a message that is still queued can run now', 409));
      }
    }

    return beginInterrupt(this.ctrlDeps, sessionId, operationKey, () => {
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
}
