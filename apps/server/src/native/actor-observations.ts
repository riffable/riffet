import type { NativeStatus, NativeWorkbenchEvent, Run, TerminalInfo } from '../../../../packages/contracts/src/index.js';
import { samePromptText } from '../../../../packages/contracts/src/prompt-match.js';
import type { Store } from '../store.js';
import type { NativeBackendTraits } from '../backends/types.js';
import { UNSPECIFIED_NATIVE_RUN_FAILURE } from '../errors.js';
import { isAgentTerminal } from '../terminal/kinds.js';
import { redactSensitiveText } from '../settings/config-documents.js';
import { steerTurnEnded } from './lane.js';
import type { DispatchObservation, NativeDispatcherBackend } from './dispatch.js';
import type { ExecutionAdapter } from './execution-adapter.js';
import type { StopReceipt } from './stop-receipt.js';

/**
 * How long an observed run waits on an idle CLI for its turn's end before it closes as unconfirmed. Long enough
 * for a Stop hook chain and a batched transcript write (docs/TURN-LIFECYCLE.md T4).
 */
export const IDLE_RECONCILE_MS = 60_000;
export const OUTCOME_MEMORY = 256;

const now = () => Date.now();
const turnOf = (event: NativeWorkbenchEvent) => event.type === 'native_input_receipt' && typeof event.data.targetTurnId === 'string' ? event.data.targetTurnId : event.nativeTurnId;
export const isTurnOutcome = (event: NativeWorkbenchEvent) => ['run_completed', 'run_failed', 'run_cancelled', 'native_turn_reopened'].includes(event.type);
export const outcomeRevision = (event: NativeWorkbenchEvent): number => Number.isSafeInteger(event.data.outcomeRevision) && Number(event.data.outcomeRevision) > 0 ? Number(event.data.outcomeRevision) : 1;
export const turnKey = (nativeSessionId: string, turnId: string): string => JSON.stringify([nativeSessionId, turnId]);

/** Whether the CLI answers this run in its own pane: the provider's verdict when it gave one, else a leading `/`. */
export function isSlashCommand(native: NonNullable<Run['native']>): boolean {
  return native.slashCommand ?? native.input.text.trimStart().startsWith('/');
}

/** A replayable native outcome may refine lost-result recovery, never a user's resolution. */
export function canApplyTurnOutcome(run: Run): boolean {
  const native = run.native;
  if (!native || ['completed', 'failed', 'cancelled'].includes(run.state)
    || ['acknowledged', 'cancelled', 'steer_rejected', 'steer_stopped'].includes(native.stage ?? '')
    || native.delivery === 'failed') return false;
  return native.delivery !== 'cancelled'
    || run.state === 'interrupted' && ['turn_outcome_unknown', 'runtime_exit'].includes(native.stage ?? '');
}

export interface ActorObservationDeps {
  readonly store: Store;
  readonly native: NativeDispatcherBackend;
  readonly adapter: ExecutionAdapter;
  readonly options: {
    confirmationMs?: number;
    idleReconcileMs?: number;
  };
  readonly idleSince: Map<string, number>;
  readonly pendingSteerOutcomes: Map<string, NativeWorkbenchEvent>;
  readonly pendingTurnOutcomes: Map<string, NativeWorkbenchEvent>;
  readonly turnOutcomeRevisions: Map<string, number>;
  /** Turns a status has named as active: proof that the provider's turn ids are the ones runs are bound to. */
  readonly namedTurns: Set<string>;
  isClosed(): boolean;
  isInterrupting(): boolean;
  traits(backendId: string | undefined): NativeBackendTraits;
  requeueSteer(runId: string): boolean;
  wakeSoon(): void;
}

export function matchingTerminal(store: Store, run: Run): TerminalInfo | undefined {
  const details = run.native;
  if (!details?.terminalId) return undefined;
  const session = store.getSession(run.sessionId);
  const linkedSessionId = session.nativeSessionId;
  const expectedSessionId = details.nativeSessionId;
  if (session.kind !== 'native' || session.terminalId !== details.terminalId || (expectedSessionId && linkedSessionId !== expectedSessionId)) return undefined;
  try {
    const terminal = store.getTerminal(details.terminalId);
    if (terminal.id !== details.terminalId || terminal.projectId !== session.projectId || !isAgentTerminal(terminal) || terminal.sessionId !== session.id) return undefined;
    return terminal;
  } catch {
    return undefined;
  }
}

export function turnOutcomeScope(store: Store, sessionId: string, event: NativeWorkbenchEvent): { key: string; nativeSessionId: string; turnId: string } | undefined {
  if (event.sessionId !== sessionId || !event.nativeTurnId) return undefined;
  const command = typeof event.data.commandId === 'string' ? store.findRunByCommand(sessionId, event.data.commandId) : undefined;
  const nativeSessionId = typeof event.data.nativeSessionId === 'string' ? event.data.nativeSessionId
    : command?.native?.nativeSessionId;
  const session = store.getSession(sessionId);
  if (!nativeSessionId || nativeSessionId !== session.nativeSessionId) return undefined;
  if (command?.native && ((command.native.nativeSessionId ?? nativeSessionId) !== nativeSessionId
    || command.native.nativeTurnId && command.native.nativeTurnId !== event.nativeTurnId)) return undefined;
  return { key: turnKey(nativeSessionId, event.nativeTurnId), nativeSessionId, turnId: event.nativeTurnId };
}

function noteActiveTurn(deps: ActorObservationDeps, status: NativeStatus): void {
  const target = status.activeTurn;
  if (!target) return;
  const key = turnKey(target.nativeSessionId, target.turnId);
  deps.namedTurns.delete(key);
  deps.namedTurns.add(key);
  if (deps.namedTurns.size > OUTCOME_MEMORY) deps.namedTurns.delete(deps.namedTurns.values().next().value!);
}

/**
 * T5 (docs/TURN-LIFECYCLE.md): evidence about a run is evidence about its own turn. An event or status naming another
 * turn says nothing about it — typically the turn stopped just before it, still flushing output or lagging in a status.
 * A run is written at most once, so its write fence already marks the attempt: evidence counts only after it.
 */
function ownTurn(store: Store, run: Run, turnId: string | undefined, nativeSessionId?: string, ownerRunId?: string): boolean {
  const native = run.native!;
  if (!turnId) return true;
  if (native.nativeTurnId) return turnId === native.nativeTurnId && (!nativeSessionId || !native.nativeSessionId || nativeSessionId === native.nativeSessionId);
  if (ownerRunId) return ownerRunId === run.id || ownerRunId === native.ownerRunId;
  const chat = nativeSessionId ?? native.nativeSessionId ?? store.getSession(run.sessionId).nativeSessionId;
  return !chat || !store.findRunsByNativeTurn(run.sessionId, chat, turnId).some(other => other.id !== run.id);
}

/** A turn one of our earlier messages started: a status naming it as running lags behind its end. */
function earlierTurn(store: Store, run: Run, target: NonNullable<NativeStatus['activeTurn']>): boolean {
  let owners: Run[];
  if (target.ownerRunId) {
    try { owners = [store.getRun(target.ownerRunId)]; } catch { owners = []; }
  } else owners = store.findRunsByNativeTurn(run.sessionId, target.nativeSessionId, target.turnId);
  return owners.some(other => other.id !== run.id && other.id !== run.native?.ownerRunId && other.createdAt <= run.createdAt);
}

export function releaseEndedSteers(store: Store, runs: readonly Run[], status?: NativeStatus): boolean {
  let released = false;
  for (const run of runs) {
    if (run.native?.intent !== 'steer' || run.native.delivery !== 'uncertain' || run.native.queueReleasedAt) continue;
    if (!steerTurnEnded(run, status, item => store.isSteerTargetTurnEnded(item))) continue;
    if (store.transitionNativeRun(run.id, ['uncertain'], { queueReleasedAt: new Date().toISOString() })) released = true;
  }
  return released;
}

export function watchDeliveries(deps: ActorObservationDeps, runs: readonly Run[], at = now()): void {
  for (const run of runs) {
    if (run.native?.queueReleasedAt) continue;
    if (run.native?.delivery === 'observed' && typeof deps.native.status === 'function') {
      applyObservation(deps, run.sessionId, { type: 'status', status: deps.native.status(run.sessionId) });
    }
    if (run.native?.delivery === 'input_sent' && at - (run.native.timings?.inputSentAt ?? at) > (deps.options.confirmationMs ?? 30_000)) {
      const terminal = matchingTerminal(deps.store, run);
      const session = deps.store.getSession(run.sessionId);
      const linkedProtocol = deps.adapter.hasDriverSend() && run.native.nativeSessionId
        && run.native.nativeSessionId === session.nativeSessionId
        && run.native.backendId === session.backendId;
      const status = linkedProtocol || (terminal && terminal.state !== 'exited')
        ? deps.native.status(run.sessionId) : undefined;
      const unacceptedSteer = run.native.intent === 'steer' && !run.native.timings?.providerAcceptedAt;
      if (!unacceptedSteer && (status?.phase === 'busy' || status?.phase === 'attention')) continue;
      deps.store.transitionNativeRun(run.id, ['input_sent'], { delivery: 'uncertain', stage: 'confirmation',
        diagnostic: { code: 'NATIVE_RECEIPT_TIMEOUT', message: 'The provider receipt did not arrive within the confirmation window', stage: 'confirmation', at: new Date().toISOString() },
      }, { state: 'interrupted', error: '暂时无法确认是否已发送' });
    }
  }
}

function replayTurnOutcome(deps: ActorObservationDeps, run: Run): void {
  const native = run.native;
  if (!native || native.intent || !native.nativeMessageId || !native.nativeSessionId || !native.nativeTurnId) return;
  const key = turnKey(native.nativeSessionId, native.nativeTurnId);
  const outcome = deps.pendingTurnOutcomes.get(key);
  if (!outcome) return;
  deps.pendingTurnOutcomes.delete(key);
  applyObservation(deps, run.sessionId, { type: 'events', events: [outcome] });
}

/** Take all correction evidence before receipts can replay cached outcomes from this batch. */
function reconcileTurnCorrections(deps: ActorObservationDeps, sessionId: string, events: NativeWorkbenchEvent[]): void {
  const newest = new Map<string, { nativeSessionId: string; turnId: string; revision: number; type: string; error?: string; reopenedRevision?: number }>();
  for (const event of events) {
    if (!isTurnOutcome(event)) continue;
    const scope = turnOutcomeScope(deps.store, sessionId, event);
    if (!scope) continue;
    const revision = outcomeRevision(event);
    const previous = newest.get(scope.key);
    const reopenedRevision = Math.max(previous?.reopenedRevision ?? 0, event.type === 'native_turn_reopened' ? revision : 0);
    const error = typeof event.data.error === 'string' ? event.data.error : typeof event.data.reason === 'string' ? event.data.reason : undefined;
    if (revision > (previous?.revision ?? 0)) newest.set(scope.key, { ...scope, revision, type: event.type, ...(error ? { error } : {}), ...(reopenedRevision ? { reopenedRevision } : {}) });
    else if (previous && reopenedRevision) previous.reopenedRevision = reopenedRevision;
  }
  for (const [key, correction] of newest) {
    const previousRevision = deps.turnOutcomeRevisions.get(key) ?? 1;
    if (correction.revision <= previousRevision) continue;
    deps.turnOutcomeRevisions.delete(key);
    deps.turnOutcomeRevisions.set(key, correction.revision);
    if (deps.turnOutcomeRevisions.size > OUTCOME_MEMORY) deps.turnOutcomeRevisions.delete(deps.turnOutcomeRevisions.keys().next().value!);
    deps.pendingTurnOutcomes.delete(key);
    for (const run of deps.store.findRunsByNativeTurn(sessionId, correction.nativeSessionId, correction.turnId)) {
      deps.pendingSteerOutcomes.delete(run.id);
      const native = run.native!;
      const matches = correction.type === 'run_completed' && run.state === 'completed' && native.stage === 'completed'
        || correction.type === 'run_failed' && run.state === 'failed' && native.stage === 'provider_failed'
        || correction.type === 'run_cancelled' && run.state === 'interrupted' && native.stage === 'provider_cancelled';
      if (matches && run.error === correction.error) continue;
      if (matches && correction.type === 'run_failed' && correction.error
        && (!run.error || run.error === UNSPECIFIED_NATIVE_RUN_FAILURE)) {
        deps.store.transitionNativeRun(run.id, ['failed'], {}, { error: redactSensitiveText(correction.error).slice(0, 1000) });
        continue;
      }
      const cancellation = correction.type !== 'run_cancelled' && run.state === 'interrupted'
        && native.delivery === 'cancelled' && native.stage === 'provider_cancelled';
      const retracted = (correction.reopenedRevision ?? 0) > previousRevision
        && (run.state === 'failed' && native.delivery === 'failed' && native.stage === 'provider_failed'
          || run.state === 'completed' && native.delivery === 'observed' && native.stage === 'completed');
      if ((!cancellation && !retracted) || native.queueReleasedAt) continue;
      const stopped = Object.values(deps.store.getSetting<Record<string, StopReceipt>>(`native-stops:${sessionId}`, {}))
        .some(receipt => receipt.request.nativeSessionId === correction.nativeSessionId && receipt.request.turnId === correction.turnId);
      if (stopped) continue;
      deps.idleSince.delete(run.id);
      const { completedAt: _completed, interruptedAt: _interrupted, ...timings } = native.timings ?? {};
      deps.store.transitionNativeRun(run.id, [native.delivery], {
        delivery: native.nativeMessageId ? 'observed' : 'input_sent',
        stage: native.nativeMessageId ? 'executing' : native.intent === 'steer' ? 'steer_confirmation' : 'confirmation',
        timings,
      }, { state: 'running', error: undefined });
    }
  }
}

function reconcileIdleRun(deps: ActorObservationDeps, sessionId: string, runId: string, status: NativeStatus): void {
  const current = deps.store.getRun(runId);
  const claimed = status.activeTurn;
  const staleClaim = claimed !== undefined && (claimed.turnId === current.native?.nativeTurnId
    && (current.native?.nativeSessionId === undefined || claimed.nativeSessionId === current.native.nativeSessionId)
    || current.native !== undefined && earlierTurn(deps.store, current, claimed));
  if (status.phase !== 'idle' || (claimed && !staleClaim) || current.native?.delivery !== 'observed' || current.state !== 'running' || deps.isInterrupting()) {
    deps.idleSince.delete(runId);
    return;
  }
  const since = deps.idleSince.get(runId) ?? now();
  deps.idleSince.set(runId, since);
  if (now() - since < (deps.options.idleReconcileMs ?? IDLE_RECONCILE_MS)) return;
  deps.idleSince.delete(runId);
  const closed = deps.store.transitionNativeRun(runId, ['observed'], {
    delivery: 'cancelled', stage: 'turn_outcome_unknown', timings: { ...current.native.timings, interruptedAt: now() },
  }, { state: 'interrupted', error: '会话已回到空闲，但未收到该任务的完成确认，结果未确认；消息已送达，不会重发。' });
  if (closed) deps.wakeSoon();
}

/** Applies one observation to the conversation's runs. Handlers call it directly for what they read themselves. */
export function applyObservation(deps: ActorObservationDeps, sessionId: string, message: DispatchObservation): void {
  if (deps.isClosed()) return;
  if (message.type === 'events') {
    reconcileTurnCorrections(deps, sessionId, message.events);
    for (const source of message.events) {
      const event = source;
      if (event.type === 'native_input_rejected' && event.data.receiptKind === 'native_command') {
        const commandId = typeof event.data.commandId === 'string' ? event.data.commandId : undefined;
        const run = commandId ? deps.store.findRunByCommand(sessionId, commandId) : undefined;
        const native = run?.native;
        const session = deps.store.getSession(sessionId);
        if (event.sessionId !== sessionId || !run || !native || native.intent === 'steer' || native.slashCommand !== true
          || event.nativeTurnId || native.nativeTurnId || native.nativeMessageId
          || native.backendId !== session.backendId || !native.nativeSessionId || event.data.nativeSessionId !== native.nativeSessionId
          || session.nativeSessionId !== native.nativeSessionId || event.runId !== undefined && event.runId !== run.id
          || !['dispatching', 'input_sent', 'uncertain'].includes(native.delivery) || !canApplyTurnOutcome(run)) continue;
        const error = typeof event.data.error === 'string' ? redactSensitiveText(event.data.error).slice(0, 1000) : 'The native command was rejected.';
        deps.store.transitionNativeRun(run.id, [native.delivery], { delivery: 'failed', stage: 'provider_failed',
          timings: { ...native.timings, completedAt: now() } }, { state: 'failed', error });
        continue;
      }
      if (isTurnOutcome(event)) {
        const scope = turnOutcomeScope(deps.store, sessionId, event);
        if (typeof event.data.nativeSessionId === 'string' && !scope) continue;
        if (scope && outcomeRevision(event) < (deps.turnOutcomeRevisions.get(scope.key) ?? 1)) continue;
        if (event.type === 'native_turn_reopened') continue;
      }
      const taggedCommandId = typeof event.data.commandId === 'string' ? event.data.commandId : undefined;
      if (!taggedCommandId && event.nativeTurnId && ['run_completed', 'run_failed', 'run_cancelled'].includes(event.type)
        && typeof event.data.nativeSessionId === 'string') {
        const session = deps.store.getSession(sessionId), nativeSessionId = event.data.nativeSessionId;
        if (session.nativeSessionId !== nativeSessionId) continue;
        const key = turnKey(nativeSessionId, event.nativeTurnId);
        deps.pendingTurnOutcomes.set(key, event);
        if (deps.pendingTurnOutcomes.size > OUTCOME_MEMORY) deps.pendingTurnOutcomes.delete(deps.pendingTurnOutcomes.keys().next().value!);
        const turnRuns = deps.store.findRunsByNativeTurn(sessionId, nativeSessionId, event.nativeTurnId);
        const owner = turnRuns.find(run => !run.native?.intent && run.native?.nativeMessageId);
        if (!owner) continue;
        deps.pendingTurnOutcomes.delete(key);
        const outcomes = turnRuns.filter(run => run.native?.nativeMessageId && canApplyTurnOutcome(run))
          .map(run => ({ ...event, runId: owner.id, data: { ...event.data, commandId: run.commandId } }));
        if (outcomes.length) applyObservation(deps, sessionId, { type: 'events', events: outcomes });
        continue;
      }
      const matchingRun = taggedCommandId ? deps.store.findRunByCommand(sessionId, taggedCommandId)
        : event.type === 'user_message_chunk' ? deps.store.findRunByNativeMessage(sessionId, event.nativeId) : undefined;
      if (!matchingRun?.native) continue;
      const commandId = taggedCommandId ?? matchingRun.commandId;
      const current = deps.store.getRun(matchingRun.id);
      if (!current.native) continue;
      if ((event.type === 'native_input_rejected' || event.type === 'native_input_submitted') && current.native.intent !== 'steer') continue;
      const eventTurn = turnOf(event);
      if (current.native.nativeTurnId && eventTurn && current.native.nativeTurnId !== eventTurn) continue;
      if (current.native.intent === 'steer' && eventTurn !== current.native.nativeTurnId) continue;
      if (eventTurn && !current.native.nativeTurnId) deps.store.transitionNativeRun(current.id, [current.native.delivery], { nativeTurnId: eventTurn });
      if (current.native.intent === 'steer' && !current.native.ownerRunId && current.native.nativeSessionId && current.native.nativeTurnId
        && (event.type === 'user_message_chunk' || event.type === 'native_input_receipt')) {
        const owner = deps.store.findRunsByNativeTurn(sessionId, current.native.nativeSessionId, current.native.nativeTurnId).find(run => !run.native?.intent);
        if (owner) deps.store.transitionNativeRun(current.id, [current.native.delivery], { ownerRunId: owner.id });
      }
      const receiptEvent = message.events.find(item => (item.type === 'user_message_chunk' || item.type === 'native_input_receipt')
        && item.data.commandId === commandId && (!current.native!.nativeTurnId || turnOf(item) === current.native!.nativeTurnId));
      if (event.type === 'native_input_rejected' && current.native.intent === 'steer' && event.data.beforeWrite === true) {
        deps.requeueSteer(current.id);
        continue;
      }
      if (event.type === 'native_input_submitted' && current.native.intent === 'steer') {
        deps.store.transitionNativeRun(current.id, ['dispatching'], { delivery: 'input_sent', stage: 'steer_confirmation',
          timings: { ...current.native.timings, inputSentAt: now() } });
        continue;
      }
      if (event.type === 'run_completed' || event.type === 'run_failed' || event.type === 'run_cancelled') {
        if (current.native.intent === 'steer' && ['steer_rejected', 'acknowledged', 'cancelled'].includes(current.native.stage ?? '')) {
          deps.pendingSteerOutcomes.delete(current.id);
          continue;
        }
        if (current.native.intent === 'steer' && !current.native.nativeMessageId && !receiptEvent) {
          deps.pendingSteerOutcomes.set(current.id, event);
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
          if (!current.native.nativeMessageId && nativeMessageId) deps.store.transitionNativeRun(current.id, [current.native.delivery], { nativeMessageId });
          continue;
        }
        if (!canApplyTurnOutcome(current)) continue;
        if (event.type === 'run_completed') {
          deps.store.transitionNativeRun(current.id, [current.native.delivery], {
            delivery: 'observed', stage: 'completed', ...(nativeMessageId ? { nativeMessageId } : {}),
            timings: { ...current.native.timings, observedAt: current.native.timings?.observedAt ?? now(), completedAt: now() },
          }, { state: 'completed', error: undefined });
        } else if (event.type === 'run_failed') {
          const error = typeof event.data.error === 'string' ? event.data.error.slice(0, 1000) : UNSPECIFIED_NATIVE_RUN_FAILURE;
          deps.store.transitionNativeRun(current.id, [current.native.delivery], {
            delivery: 'failed', stage: 'provider_failed', ...(nativeMessageId ? { nativeMessageId } : {}),
            timings: { ...current.native.timings, completedAt: now() },
          }, { state: 'failed', error });
        } else {
          const reason = typeof event.data.reason === 'string' ? event.data.reason.slice(0, 1000) : undefined;
          deps.store.transitionNativeRun(current.id, [current.native.delivery], {
            delivery: 'cancelled', stage: 'provider_cancelled', ...(nativeMessageId ? { nativeMessageId } : {}),
            timings: { ...current.native.timings, interruptedAt: now() },
          }, { state: 'interrupted', error: reason });
        }
        deps.store.updateSessionActivity(current.sessionId);
      } else if ((event.type === 'user_message_chunk' || event.type === 'native_input_receipt') && !current.native.nativeMessageId) {
        const isFinished = current.native.delivery !== 'uncertain'
          && (['completed', 'failed', 'cancelled', 'interrupted'].includes(current.state) || ['failed', 'cancelled'].includes(current.native.delivery));
        const stoppedSteer = current.native.intent === 'steer' && current.native.stage === 'steer_stopped';
        const session = deps.store.getSession(sessionId);
        const linkedSessionId = session.nativeSessionId;
        const expectedSessionId = current.native.nativeSessionId;
        const eventSessionId = typeof event.data.nativeSessionId === 'string' ? event.data.nativeSessionId : undefined;
        if (expectedSessionId && linkedSessionId !== expectedSessionId) continue;
        if (eventSessionId && ((expectedSessionId && eventSessionId !== expectedSessionId) || (linkedSessionId && eventSessionId !== linkedSessionId))) continue;
        deps.store.transitionNativeRun(current.id, [current.native.delivery], isFinished
          ? { nativeMessageId: event.nativeId }
          : {
            delivery: stoppedSteer ? 'cancelled' : 'observed', stage: stoppedSteer ? 'interrupted' : 'executing', nativeMessageId: event.nativeId,
            ...(linkedSessionId ? { nativeSessionId: linkedSessionId } : {}),
            timings: { ...current.native.timings, observedAt: current.native.timings?.observedAt ?? now(), ...(event.type === 'native_input_receipt' ? { providerAcceptedAt: now() } : {}) },
          }, isFinished ? {} : { state: stoppedSteer || current.native.queueReleasedAt ? 'interrupted' : 'running', error: undefined });
        const outcome = deps.pendingSteerOutcomes.get(current.id);
        if (outcome) { deps.pendingSteerOutcomes.delete(current.id); applyObservation(deps, sessionId, { type: 'events', events: [outcome] }); }
      }
      if (event.type === 'user_message_chunk' || event.type === 'native_input_receipt') replayTurnOutcome(deps, deps.store.getRun(current.id));
    }
  }
  if (message.type === 'status') noteActiveTurn(deps, message.status);
  const runs = deps.store.listUnfinishedNativeRuns(sessionId);
  for (const run of runs) {
    const delivery = run.native!;
    const backendId = deps.store.getSession(sessionId).backendId;
    if (deps.traits(backendId).settlesSlashOnSubmit && isSlashCommand(delivery)) continue;
    if (delivery.intent !== 'steer' && message.type === 'events' && ['dispatching', 'input_sent', 'uncertain', 'observed'].includes(delivery.delivery)) {
      const session = deps.store.getSession(sessionId);
      const linkedSessionId = session.nativeSessionId;
      const expectedSessionId = delivery.nativeSessionId;
      if ((delivery.terminalId && session.terminalId !== delivery.terminalId) || (expectedSessionId && expectedSessionId !== linkedSessionId)) continue;
      const sent = (delivery.renderedText ?? delivery.input.text).trim();
      const afterBaseline = message.events.filter(event => event.sequence > (delivery.baselineSequence ?? Infinity));
      const matches = deps.traits(session.backendId).untaggedEcho
        ? delivery.queueReleasedAt
          ? []
          : afterBaseline.filter(event => event.type === 'user_message_chunk'
            && samePromptText(sent, ((event.data.content as { text?: string } | undefined)?.text ?? '').trim()))
        : message.events.filter(event => event.type === 'user_message_chunk' && event.data.commandId === run.commandId);
      if (!delivery.nativeMessageId && matches.length === 1) {
        deps.store.transitionNativeRun(run.id, ['dispatching', 'input_sent', 'uncertain'], {
          delivery: 'observed', nativeMessageId: matches[0]!.nativeId,
          ...(matches[0]!.nativeTurnId ? { nativeTurnId: matches[0]!.nativeTurnId } : {}),
          ...(session.nativeSessionId ? { nativeSessionId: session.nativeSessionId } : {}),
          stage: 'executing', timings: { ...delivery.timings, observedAt: now() },
        }, { state: delivery.queueReleasedAt ? 'interrupted' : 'running', error: undefined });
        replayTurnOutcome(deps, deps.store.getRun(run.id));
      }
      const updated = deps.store.getRun(run.id);
      if (updated.native?.delivery === 'observed' && !updated.native.timings?.firstOutputAt && message.events.some(event => event.sequence > (delivery.baselineSequence ?? Infinity) && event.type === 'agent_message_chunk'
        && ownTurn(deps.store, updated, event.nativeTurnId, typeof event.data.nativeSessionId === 'string' ? event.data.nativeSessionId : undefined))) {
        deps.store.transitionNativeRun(run.id, ['observed'], { timings: { ...updated.native.timings, firstOutputAt: updated.native.timings?.firstOutputAt ?? now() } });
      }
    }
    if (message.type === 'status') {
      let current = deps.store.getRun(run.id);
      if (current.native?.queueReleasedAt) { deps.idleSince.delete(run.id); continue; }
      const terminal = matchingTerminal(deps.store, current);
      const target = message.status.activeTurn;
      const linkedSession = deps.store.getSession(sessionId);
      const expectedSessionId = current.native?.nativeSessionId;
      if ((expectedSessionId && expectedSessionId !== linkedSession.nativeSessionId)
        || current.native?.terminalId && !terminal) {
        deps.idleSince.delete(run.id);
        continue;
      }
      if (current.native?.delivery === 'uncertain' && current.native.stage === 'turn_outcome_unknown'
        && current.native.nativeMessageId && current.native.nativeSessionId && current.native.nativeTurnId
        && ['busy', 'attention', 'idle'].includes(message.status.phase)
        && (!target || target.nativeSessionId === current.native.nativeSessionId)
        && current.native.nativeSessionId === linkedSession.nativeSessionId) {
        current = deps.store.transitionNativeRun(run.id, ['uncertain'], {
          delivery: 'observed', stage: 'executing',
        }, { state: 'running', error: undefined }) ?? current;
      }
      // Another named turn running says this one is over; only for runs whose turn ids a status has used.
      if (current.native?.delivery === 'observed' && current.native.nativeMessageId && current.native.nativeTurnId && current.native.nativeSessionId
        && (current.native.intent === 'steer' || deps.namedTurns.has(turnKey(current.native.nativeSessionId, current.native.nativeTurnId))) && target
        && ['busy', 'attention'].includes(message.status.phase)
        && target.nativeSessionId === current.native.nativeSessionId
        && target.turnId !== current.native.nativeTurnId && !earlierTurn(deps.store, current, target)) {
        deps.store.transitionNativeRun(run.id, ['observed'], {
          delivery: 'cancelled', stage: 'turn_outcome_unknown', timings: { ...current.native.timings, interruptedAt: now() },
        }, { state: 'interrupted', error: '会话已进入后续任务，但未收到原任务的完成确认；消息已送达，不会重发。' });
        deps.idleSince.delete(run.id);
        deps.wakeSoon();
        continue;
      }
      if (current.native?.delivery === 'uncertain' && current.native.stage === 'runtime_exit'
        && current.native.nativeMessageId
        && ['busy', 'idle', 'attention'].includes(message.status.phase)
        && terminal && terminal.state !== 'exited') {
        current = deps.store.transitionNativeRun(run.id, ['uncertain'], {
          delivery: 'observed', stage: 'executing',
        }, { state: 'running', error: undefined }) ?? current;
      }
      // An idle screen names no turn: it never completes a run (T4), it only starts the wait in `reconcileIdleRun`.
      if (message.status.phase === 'busy' && ['input_sent', 'observed'].includes(current.native?.delivery ?? '') && !current.native?.timings?.busyAt
        && ownTurn(deps.store, current, target?.turnId, target?.nativeSessionId, target?.ownerRunId)) {
        deps.store.transitionNativeRun(run.id, ['input_sent', 'observed'], { timings: { ...current.native?.timings, busyAt: now() } });
      } else if (message.status.phase === 'offline' && ['dispatching', 'input_sent', 'observed'].includes(current.native?.delivery ?? '')) {
        const mayBeRunning = deps.traits(deps.store.getSession(sessionId).backendId).offlineMayBeRunning;
        const terminalExited = matchingTerminal(deps.store, current)?.state === 'exited';
        if (terminalExited) {
          if (current.native?.delivery === 'observed') {
            deps.store.transitionNativeRun(run.id, ['observed'], { delivery: 'cancelled', stage: 'runtime_exit', timings: { ...current.native.timings, interruptedAt: now() } }, { state: 'interrupted', error: 'CLI 在回复过程中退出，这条回复可能不完整。' });
          } else {
            const startupError = deps.store.getSession(sessionId).error;
            deps.store.transitionNativeRun(run.id, ['dispatching', 'input_sent'], { delivery: 'uncertain', stage: 'runtime_exit' }, { state: 'interrupted', error: startupError ? `${startupError} 尚未确认消息是否送达，系统不会自动重发。` : 'Native backend exited before delivery could be confirmed. The message will not be resent automatically.' });
          }
        } else if (mayBeRunning && current.native?.delivery !== 'observed') {
          deps.store.transitionNativeRun(run.id, ['dispatching', 'input_sent', 'observed'], {
            delivery: 'uncertain', stage: 'runtime_exit',
          }, { state: 'interrupted', error: 'Native backend connection was lost while its process may still be running. The message will not be resent automatically.' });
        }
      }
      reconcileIdleRun(deps, sessionId, run.id, message.status);
    }
  }
  releaseEndedSteers(deps.store, deps.store.listUnfinishedNativeRuns(sessionId), message.type === 'status' ? message.status : undefined);
}
