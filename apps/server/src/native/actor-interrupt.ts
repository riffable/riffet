import type {
  NativeDeliveryState, NativeRunRecovery, NativeStatus, NativeStopRequest, NativeWorkbenchEvent, Run, Session,
} from '../../../../packages/contracts/src/index.js';
import type { Store } from '../store.js';
import type { NativeBackendTraits } from '../backends/types.js';
import { AppError } from '../errors.js';
import { redactSensitiveText } from '../settings/config-documents.js';
import type { DispatchObservation, NativeDispatcherBackend } from './dispatch.js';
import type { ExecutionAdapter, TurnDeliveryResult } from './execution-adapter.js';
import { assertStopBinding, readStopReceipt, saveStopReceipt, stopFingerprint, type StopReceipt } from './stop-receipt.js';
import { isSlashCommand, outcomeRevision, turnKey, turnOutcomeScope } from './actor-observations.js';

const now = () => Date.now();

/** 4xx rejections proven before a stop could have reached the provider: drop any pending receipt and surface the error. */
const STOP_DEFINITE_REJECTIONS = new Set([
  'NATIVE_STOP_TARGET_CHANGED',
  'TARGETED_STOP_UNSUPPORTED',
  'CLEAR_INPUT_UNSUPPORTED',
  'NOT_NATIVE',
]);

function deleteStopReceipt(store: Store, sessionId: string, stop: NativeStopRequest): void {
  const key = `native-stops:${sessionId}`;
  const receipts = store.getSetting<Record<string, StopReceipt>>(key, {});
  const entryKey = JSON.stringify(stop.requestId);
  if (!(entryKey in receipts)) return;
  const { [entryKey]: _removed, ...rest } = receipts;
  if (Object.keys(rest).length) store.setSetting(key, rest);
  else store.deleteSetting(key);
}

export interface ActorControlDeps {
  readonly store: Store;
  readonly native: NativeDispatcherBackend;
  readonly adapter: ExecutionAdapter;
  readonly runtime: { withSession<T>(sessionId: string, operation: () => Promise<T>, options?: { detached?: boolean }): Promise<T> };
  readonly nextAttempt: Map<string, number>;
  readonly recoveryChecks: Map<string, Promise<NativeRunRecovery>>;
  readonly pendingSteerOutcomes: Map<string, NativeWorkbenchEvent>;
  readonly pendingTurnOutcomes: Map<string, NativeWorkbenchEvent>;
  readonly turnOutcomeRevisions: Map<string, number>;
  readonly sessionId: string;
  isClosed(): boolean;
  draining(): boolean;
  workspaceReserved(session: Session): boolean;
  workspaceBusy(): AppError;
  getInterrupting(): boolean;
  setInterrupting(value: boolean): void;
  getRecoveryActive(): boolean;
  setRecoveryActive(value: boolean): void;
  getInterruptionTask(): { commandId?: string; fingerprint?: string; task: Promise<Run | undefined> } | undefined;
  setInterruptionTask(task: { commandId?: string; fingerprint?: string; task: Promise<Run | undefined> } | undefined): void;
  traits(backendId: string | undefined): NativeBackendTraits;
  readStatus(sessionId: string): NativeStatus | undefined;
  observe(sessionId: string, message: DispatchObservation): void;
  step(): void;
  requeueSteer(runId: string): boolean;
  armDelivery(run: Run, initial: NonNullable<Run['native']>): { prepareAt: number; checkpoint: boolean } | undefined;
  openDelivery(run: Run, armed: { prepareAt: number; checkpoint: boolean }): Session;
  recoverDelivery(runId: string, initial: NonNullable<Run['native']>, options: { now?: boolean; expectedStop?: NativeStopRequest }, error: unknown): void;
  observeSnapshot(sessionId: string, result: TurnDeliveryResult): void;
}

function recoveryRun(store: Store, sessionId: string, runId: string): Run {
  const run = store.getRun(runId);
  if (run.sessionId !== sessionId || !run.native) throw new AppError('RUN_NOT_FOUND', 'The message does not exist', 404);
  return run;
}

function queuedRunIds(store: Store, sessionId: string): string[] {
  return store.listUnfinishedNativeRuns(sessionId)
    .filter(run => run.native?.delivery === 'queued' && !run.native.intent).map(run => run.id);
}

/** Checks only the persisted request and existing provider evidence; never submits input. */
export function checkRecovery(deps: ActorControlDeps, sessionId: string, runId: string): Promise<NativeRunRecovery> {
  const key = JSON.stringify([sessionId, runId]);
  const existing = deps.recoveryChecks.get(key);
  if (existing) return existing;
  const task = readRecovery(deps, sessionId, runId).finally(() => {
    if (deps.recoveryChecks.get(key) === task) deps.recoveryChecks.delete(key);
  });
  deps.recoveryChecks.set(key, task);
  return task;
}

export function idleForRecovery(status: NativeStatus | undefined): boolean {
  return Boolean(status && status.phase === 'idle' && !status.activeTurn && !status.interaction
    && !status.activity?.background && !status.activity?.compacting
    && (!status.connection || status.connection.state === 'connected'));
}

export function awaitingLaterTurn(run: Run): boolean {
  const native = run.native;
  return Boolean(native && native.delivery === 'uncertain' && !native.intent && !native.queueReleasedAt
    && !native.nativeMessageId && !isSlashCommand(native)
    && (native.timings?.inputSentAt !== undefined || native.timings?.dispatchAt !== undefined));
}

function mayReleaseInput(
  deps: ActorControlDeps, session: Session, run: Run, status: NativeStatus | undefined,
  options: { allowRecreatedTerminal?: boolean } = {},
): boolean {
  const native = run.native;
  return Boolean(native && native.delivery === 'uncertain' && !native.queueReleasedAt
    && !session.archivedAt && !deps.getInterrupting() && !deps.workspaceReserved(session)
    && idleForRecovery(status)
    && native.nativeSessionId && native.nativeSessionId === session.nativeSessionId
    && (options.allowRecreatedTerminal
      ? Boolean(session.terminalId) && (!native.backendId || native.backendId === session.backendId)
      : (!native.terminalId || native.terminalId === session.terminalId)));
}

/** Automatically releases a non-steer uncertain send once the backend proves a later turn completed. */
export async function releaseAfterLaterTurn(
  deps: ActorControlDeps, sessionId: string, runId: string, isWorkerActive: () => boolean,
): Promise<boolean> {
  if (!deps.native.canReleaseAfterLaterTurn || deps.isClosed() || isWorkerActive() || deps.getRecoveryActive()) return false;
  let run: Run, session: Session;
  try {
    run = recoveryRun(deps.store, sessionId, runId);
    session = deps.store.getSession(sessionId);
  } catch { return false; }
  if (!awaitingLaterTurn(run) || !mayReleaseInput(deps, session, run, deps.readStatus(sessionId), { allowRecreatedTerminal: true })) return false;
  const proven = await deps.native.canReleaseAfterLaterTurn(session, run).catch(() => false);
  if (!proven || deps.isClosed() || isWorkerActive() || deps.getRecoveryActive()) return false;
  let latestRun: Run, latestSession: Session;
  try {
    latestRun = recoveryRun(deps.store, sessionId, runId);
    latestSession = deps.store.getSession(sessionId);
  } catch { return false; }
  if (!awaitingLaterTurn(latestRun)
    || latestSession.nativeSessionId !== session.nativeSessionId
    || latestSession.terminalId !== session.terminalId
    || !mayReleaseInput(deps, latestSession, latestRun, deps.readStatus(sessionId), { allowRecreatedTerminal: true })) return false;
  return Boolean(deps.store.transitionNativeRun(runId, ['uncertain'], { queueReleasedAt: new Date().toISOString() }));
}

async function readRecovery(deps: ActorControlDeps, sessionId: string, runId: string): Promise<NativeRunRecovery> {
  recoveryRun(deps.store, sessionId, runId);
  await deps.native.reconcile?.(sessionId);
  const snapshot = await deps.native.snapshot(sessionId);
  deps.observe(sessionId, { type: 'events', events: snapshot.events });
  deps.observe(sessionId, { type: 'status', status: snapshot.status });
  let run = recoveryRun(deps.store, sessionId, runId);
  const session = deps.store.getSession(sessionId);
  const status = snapshot.status;
  let canContinue = mayReleaseInput(deps, session, run, status);
  if (canContinue) canContinue = await deps.native.canReleaseInput?.(session, run) ?? false;
  run = recoveryRun(deps.store, sessionId, runId);
  const latest = deps.store.getSession(sessionId);
  const currentStatus = deps.native.status(sessionId);
  canContinue &&= mayReleaseInput(deps, latest, run, currentStatus)
    && latest.nativeSessionId === session.nativeSessionId && latest.terminalId === session.terminalId;
  return { run, canContinue, queuedRunIds: queuedRunIds(deps.store, sessionId) };
}

/** A user may release a proven-empty input, while late evidence still corrects its history. */
export async function continueRecovery(deps: ActorControlDeps, sessionId: string, runId: string, expectedQueuedRunIds: string[], isWorkerActive: () => boolean): Promise<Run> {
  const run = recoveryRun(deps.store, sessionId, runId);
  if (run.native?.queueReleasedAt) return run;
  if (deps.getRecoveryActive()) throw new AppError('NATIVE_RECOVERY_BUSY', 'A recovery action is already running', 409);
  deps.setRecoveryActive(true);
  try {
    return await deps.runtime.withSession(sessionId, async () => {
      if (isWorkerActive()) throw new AppError('NATIVE_RECOVERY_UNSAFE', 'The original input cannot yet be safely released', 409);
      const checked = await readRecovery(deps, sessionId, runId);
      if (!checked.canContinue) throw new AppError('NATIVE_RECOVERY_UNSAFE', 'The original input cannot yet be safely released', 409);
      if (JSON.stringify(checked.queuedRunIds) !== JSON.stringify(expectedQueuedRunIds)) throw new AppError('NATIVE_QUEUE_CHANGED', 'The queued messages changed; review them before continuing', 409);
      return deps.store.transitionNativeRun(runId, ['uncertain'], { queueReleasedAt: new Date().toISOString() })
        ?? recoveryRun(deps.store, sessionId, runId);
    });
  } finally { deps.setRecoveryActive(false); deps.step(); }
}

function assertStopTarget(deps: ActorControlDeps, sessionId: string, stop: NativeStopRequest): void {
  assertStopBinding(deps.store, sessionId, stop);
  const status = deps.native.status(sessionId);
  if (status.phase === 'offline' || status.connection && status.connection.state !== 'connected') {
    throw new AppError('NATIVE_STOP_UNCONFIRMED', 'Reconnect before stopping the original task', 409);
  }
  if ((status.activeTurn?.turnId ?? undefined) !== stop.turnId
    || (status.activeTurn && status.activeTurn.nativeSessionId !== stop.nativeSessionId)) {
    throw new AppError('NATIVE_STOP_TARGET_CHANGED', 'The original task changed; no stop was sent', 409);
  }
}

function stopTargets(store: Store, sessionId: string, stop?: NativeStopRequest): Map<string, NativeDeliveryState> {
  return new Map(store.listUnfinishedNativeRuns(sessionId).filter(run => {
    const native = run.native;
    if (!native || native.delivery === 'queued' || native.queueReleasedAt) return false;
    if (!stop) return true;
    if (native.nativeSessionId !== stop.nativeSessionId) return false;
    if (stop.terminalId !== undefined && native.terminalId !== undefined && native.terminalId !== stop.terminalId) return false;
    if (stop.turnId === undefined) return true;
    if (native.nativeTurnId === stop.turnId) return true;
    if (!native.nativeTurnId && (native.delivery === 'dispatching' || native.delivery === 'input_sent' || native.delivery === 'uncertain')) {
      return !(native.delivery === 'uncertain' && isSlashCommand(native));
    }
    return false;
  }).map(run => [run.id, run.native!.delivery]));
}

function stopEnded(deps: ActorControlDeps, sessionId: string, receipt: StopReceipt, events: NativeWorkbenchEvent[]): boolean {
  const stop = receipt.request;
  if (receipt.terminalId && receipt.terminalEpoch !== undefined) {
    const terminal = deps.store.getTerminal(receipt.terminalId);
    if (terminal.epoch === receipt.terminalEpoch && terminal.state === 'exited') return true;
  }
  if (!stop.turnId) return false;
  const turnId = stop.turnId;
  const outcome = (event: NativeWorkbenchEvent) => ['run_completed', 'run_failed', 'run_cancelled'].includes(event.type)
    && turnOutcomeScope(deps.store, sessionId, event)?.nativeSessionId === stop.nativeSessionId && event.nativeTurnId === turnId
    && outcomeRevision(event) >= (deps.turnOutcomeRevisions.get(turnKey(stop.nativeSessionId, turnId)) ?? 1);
  if (events.some(outcome)) return true;
  const key = turnKey(stop.nativeSessionId, turnId);
  const pending = deps.pendingTurnOutcomes.get(key);
  if (pending && outcome(pending)) return true;
  return deps.store.findRunsByNativeTurn(sessionId, stop.nativeSessionId, turnId).some(run =>
    run.native?.stage === 'provider_cancelled' && run.native.delivery === 'cancelled' && run.state === 'interrupted'
    || run.native?.stage === 'provider_failed' && run.state === 'failed'
    || run.native?.stage === 'completed' && run.state === 'completed');
}

async function recoverStop(deps: ActorControlDeps, sessionId: string, receipt: StopReceipt, submit?: () => Run, promotedRunId?: string): Promise<Run | undefined> {
  assertStopBinding(deps.store, sessionId, receipt.request, receipt);
  await deps.native.reconcile?.(sessionId);
  const snapshot = await deps.native.snapshot(sessionId);
  deps.observe(sessionId, { type: 'events', events: snapshot.events });
  deps.observe(sessionId, { type: 'status', status: snapshot.status });
  assertStopBinding(deps.store, sessionId, receipt.request, receipt);
  if (!stopEnded(deps, sessionId, receipt, snapshot.events)) {
    throw new AppError('NATIVE_STOP_UNCONFIRMED', 'The previous stop has not been confirmed; check the original task status', 409);
  }
  const session = deps.store.getSession(sessionId);
  const targets = stopTargets(deps.store, sessionId, receipt.request);
  const original = (receipt.targets ?? []).map(([id]) => deps.store.getRun(id))
    .find(run => !run.native?.queueReleasedAt && run.native?.nativeSessionId === receipt.request.nativeSessionId
      && run.native?.nativeTurnId === receipt.request.turnId)
    ?? deps.store.findRunsByNativeTurn(sessionId, receipt.request.nativeSessionId, receipt.request.turnId ?? '').find(run => !run.native?.intent && !run.native?.queueReleasedAt);
  if (submit || deps.traits(session.backendId).stopKeepsPendingInput) {
    const status = deps.native.status(sessionId);
    if (status.phase !== 'idle' || status.activeTurn || status.activity?.background || status.activity?.compacting
      || status.connection && status.connection.state !== 'connected'
      || !original || !await deps.native.canReleaseInput?.(session, original)) {
      throw new AppError('NATIVE_STOP_UNCONFIRMED', 'The original input has not been confirmed safe to continue', 409);
    }
    assertStopBinding(deps.store, sessionId, receipt.request, receipt);
    const latest = deps.native.status(sessionId);
    if (latest.phase !== 'idle' || latest.activeTurn || latest.activity?.background || latest.activity?.compacting
      || latest.connection && latest.connection.state !== 'connected') {
      throw new AppError('NATIVE_STOP_TARGET_CHANGED', 'A newer task is running; the replacement was not sent', 409);
    }
  }
  const settled = deps.store.transaction(() => {
    const interrupted = settleInterrupted(deps, targets, deps.traits(session.backendId));
    const run = submit ? acceptFollowUp(deps.store, submit, promotedRunId) : interrupted;
    saveStopReceipt(deps.store, sessionId, { ...receipt, state: 'completed', ...(run ? { runId: run.id } : {}) });
    return run;
  });
  await deps.adapter.endInterruptedTurns(sessionId, targets, receipt.request);
  return settled;
}

export function beginInterrupt(deps: ActorControlDeps, sessionId: string, commandId?: string, submit?: () => Run, promotedRunId?: string, stop?: NativeStopRequest, replacementFingerprint?: string): Promise<Run | undefined> {
  if (deps.workspaceReserved(deps.store.getSession(sessionId))) return Promise.reject(deps.workspaceBusy());
  const operation = commandId ?? 'stop';
  const operationKey = stop ? `stop:${stop.requestId}` : commandId;
  const fingerprint = stop ? stopFingerprint(stop, operation, replacementFingerprint) : undefined;
  const receipt = stop ? readStopReceipt(deps.store, sessionId, stop) : undefined;
  if (receipt && stopFingerprint(receipt.request, receipt.operation, receipt.replacementFingerprint) !== fingerprint) {
    return Promise.reject(new AppError('NATIVE_STOP_CONFLICT', 'This stop request belongs to a different operation', 409));
  }
  if (receipt?.state === 'completed') return Promise.resolve(receipt.runId ? deps.store.getRun(receipt.runId) : undefined);
  const existing = deps.getInterruptionTask();
  if (existing) {
    if (operationKey && existing.commandId === operationKey) {
      if (existing.fingerprint !== fingerprint) return Promise.reject(new AppError('NATIVE_STOP_CONFLICT', 'This stop request belongs to a different operation', 409));
      return existing.task;
    }
    return Promise.reject(new AppError('NATIVE_INTERRUPT_IN_PROGRESS', 'The current turn is stopping; try again shortly', 409));
  }
  if (receipt && deps.getRecoveryActive()) return Promise.reject(new AppError('NATIVE_RECOVERY_BUSY', 'A recovery action is already running', 409));
  if (!receipt) {
    try { if (stop) assertStopTarget(deps, sessionId, stop); }
    catch (error) { return Promise.reject(error); }
  }
  deps.setInterrupting(true);
  if (receipt) deps.setRecoveryActive(true);
  const targets = stopTargets(deps.store, sessionId, stop);
  const task = Promise.resolve().then(() => {
    if (receipt) return deps.runtime.withSession(sessionId, () => recoverStop(deps, sessionId, receipt, submit, promotedRunId));
    deps.adapter.requestInterrupt(sessionId);
    return deps.runtime.withSession(sessionId, async () => {
      if (stop) {
        assertStopTarget(deps, sessionId, stop);
        const session = deps.store.getSession(sessionId);
        const terminal = session.terminalId ? deps.store.getTerminal(session.terminalId) : undefined;
        saveStopReceipt(deps.store, sessionId, { request: stop, operation, state: 'pending', createdAt: new Date().toISOString(),
          ...(replacementFingerprint ? { replacementFingerprint } : {}), targets: [...targets],
          ...(terminal ? { terminalId: terminal.id, terminalEpoch: terminal.epoch } : {}) });
      }
      let run: Run | undefined;
      try { run = await performInterrupt(deps, sessionId, submit, targets, promotedRunId, stop); }
      catch (error) {
        if (!stop) throw error;
        if (error instanceof AppError && STOP_DEFINITE_REJECTIONS.has(error.code)) {
          deleteStopReceipt(deps.store, sessionId, stop);
          throw error;
        }
        saveStopReceipt(deps.store, sessionId, { ...readStopReceipt(deps.store, sessionId, stop)!, error: {
          ...(error instanceof AppError ? { code: error.code } : {}),
          message: redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 1000),
        } });
        throw new AppError('NATIVE_STOP_UNCONFIRMED', 'The stop has not been confirmed; check the original task status', 409);
      }
      if (stop) saveStopReceipt(deps.store, sessionId, { ...readStopReceipt(deps.store, sessionId, stop)!, state: 'completed', ...(run ? { runId: run.id } : {}) });
      return run;
    });
  }).finally(() => {
    deps.setInterrupting(false);
    if (receipt) deps.setRecoveryActive(false);
    if (deps.getInterruptionTask()?.task === task) deps.setInterruptionTask(undefined);
    deps.step();
  });
  deps.setInterruptionTask({ ...(operationKey ? { commandId: operationKey } : {}), ...(fingerprint ? { fingerprint } : {}), task });
  return task;
}

async function performInterrupt(deps: ActorControlDeps, sessionId: string, submit: (() => Run) | undefined, targets: Map<string, NativeDeliveryState>, promotedRunId?: string, stop?: NativeStopRequest): Promise<Run | undefined> {
  const session = deps.store.getSession(sessionId);
  if (session.kind !== 'native') throw new AppError('NOT_NATIVE', 'Only native conversations can be interrupted', 409);
  const targetedStop = deps.native.supportsTargetedStop ? await deps.native.supportsTargetedStop(session) : true;
  if (submit && !targetedStop) {
    throw new AppError('TARGETED_STOP_UNSUPPORTED', 'This backend cannot atomically stop a specified execution', 409);
  }
  const activeBefore = deps.readStatus(sessionId)?.activeTurn;
  const activeTurnId = activeBefore && (!session.nativeSessionId || activeBefore.nativeSessionId === session.nativeSessionId)
    ? activeBefore.turnId : undefined;
  let accepted: Run | undefined;
  if (submit && !deps.draining()) {
    const replacement = await deps.adapter.replaceTurn({
      session,
      ...(stop ? { expectedStop: stop } : {}),
      isClosed: () => deps.isClosed(),
      isInterrupting: () => deps.getInterrupting(),
      readStatus: (id) => deps.readStatus(id),
      claim: () => {
        if (stop) assertStopTarget(deps, sessionId, stop);
        const run = acceptFollowUp(deps.store, submit, promotedRunId);
        accepted = run;
        if (!run.native || isSlashCommand(run.native) || run.native.delivery !== 'queued' || run.state !== 'queued') return undefined;
        return { run, initial: run.native, isSlash: isSlashCommand(run.native) };
      },
      arm: (claimed) => deps.armDelivery(claimed.run, claimed.initial),
      open: (claimed, armed) => deps.openDelivery(claimed.run, armed),
      recover: (claimed, error) => deps.recoverDelivery(claimed.run.id, claimed.initial, { now: true, ...(stop ? { expectedStop: stop } : {}) }, error),
      observe: (observedSessionId, result) => deps.observeSnapshot(observedSessionId, result),
    });
    if (replacement.status === 'delivered') {
      const after = deps.store.getRun(replacement.run.id);
      if (after.native?.delivery === 'failed') return after;
      if (after.native?.delivery !== 'queued') {
        const oldTurn = stop?.turnId ?? activeTurnId;
        const activeAfter = deps.readStatus(sessionId)?.activeTurn;
        const confirmedReplacement = after.native?.delivery === 'observed' && Boolean(after.native.nativeMessageId)
          && (!oldTurn || (Boolean(after.native.nativeTurnId) && after.native.nativeTurnId !== oldTurn && activeAfter?.turnId !== oldTurn));
        if (!confirmedReplacement) {
          throw new AppError('NATIVE_STOP_UNCONFIRMED', 'The replacement send did not confirm that the previous turn stopped', 409);
        }
        settleInterrupted(deps, targets, deps.traits(session.backendId));
        await deps.adapter.endInterruptedTurns(sessionId, targets, stop, activeTurnId);
        return after;
      }
      deps.nextAttempt.delete(after.id);
    }
  }
  if (stop) assertStopTarget(deps, sessionId, stop);
  await deps.adapter.stopTurn(session, { clearPrompt: Boolean(submit), hasTargets: targets.size > 0, ...(stop && targetedStop ? { expectedStop: stop } : {}) });
  const interrupted = settleInterrupted(deps, targets, deps.traits(session.backendId));
  await deps.adapter.endInterruptedTurns(sessionId, targets, stop, activeTurnId);
  if (submit) return accepted ? deps.store.getRun(accepted.id) : acceptFollowUp(deps.store, submit, promotedRunId);
  return interrupted;
}

function acceptFollowUp(store: Store, submit: () => Run, promotedRunId?: string): Run {
  const accepted = submit();
  if (accepted.native?.delivery === 'queued' && accepted.state === 'queued') {
    return store.transitionNativeRun(accepted.id, ['queued'], {
      stage: 'interrupt_followup',
      ...(accepted.id === promotedRunId ? { timings: { ...accepted.native.timings, promotedAt: accepted.native.timings?.promotedAt ?? now() } } : {}),
    }) ?? accepted;
  }
  return accepted;
}

function settleInterrupted(deps: ActorControlDeps, targets: Map<string, NativeDeliveryState>, traits: NativeBackendTraits): Run | undefined {
  let interrupted: Run | undefined;
  for (const [runId, initialDelivery] of targets) {
    const run = deps.store.getRun(runId);
    const delivery = run.native?.delivery;
    if (!delivery || ['completed', 'failed', 'cancelled'].includes(run.state)) continue;
    if (traits.stopKeepsPendingInput && run.native?.intent !== 'steer'
      && (delivery === 'dispatching' || delivery === 'input_sent'
        || delivery === 'uncertain' && !run.native?.nativeMessageId
        || delivery === 'observed' && !run.native?.nativeTurnId)) continue;
    const preparing = initialDelivery === 'preparing';
    if (preparing && run.native?.intent === 'steer') { deps.requeueSteer(run.id); continue; }
    const allowed: NativeDeliveryState[] = preparing ? ['queued', 'preparing'] : [delivery];
    if (!preparing && run.native?.intent === 'steer' && !run.native.nativeMessageId) {
      deps.store.transitionNativeRun(run.id, allowed, {
        delivery: 'uncertain', stage: 'steer_stopped',
        queueReleasedAt: run.native.queueReleasedAt ?? new Date().toISOString(),
        timings: { ...run.native.timings, interruptedAt: now() },
      }, { state: 'interrupted', error: run.error ?? '任务已停止，补充消息是否收到仍无法确认。' });
      continue;
    }
    const changed = deps.store.transitionNativeRun(run.id, allowed, {
      delivery: 'cancelled',
      stage: preparing ? 'cancelled' : 'interrupted',
      timings: { ...run.native?.timings, ...(preparing ? {} : { interruptedAt: now() }) },
    }, preparing
      ? { state: 'cancelled', error: undefined }
      : { state: 'interrupted', error: undefined });
    if (changed) deps.pendingSteerOutcomes.delete(runId);
    if (changed && !preparing) interrupted = changed;
  }
  return interrupted;
}
