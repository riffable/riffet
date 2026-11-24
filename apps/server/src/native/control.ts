import type { ActiveTurnState, InboxAction, InboxEntry, SessionControlSnapshot } from '../../../../packages/contracts/src/control.js';
import type { NativeQueue, NativeRunDetails, NativeStatus, Run, Session } from '../../../../packages/contracts/src/index.js';

/**
 * The control snapshot clients render (docs/DISPATCH-ARCHITECTURE.md §4.2). Pure: the dispatcher
 * still owns transitions. `placement: 'sending'` is a direct send and never offers `send_now`.
 */
export interface ControlSnapshotInput {
  revision: number;
  session: Session;
  status: NativeStatus;
  /** `NativeDispatcher.queue` for this status. */
  queue: NativeQueue;
  /** Unfinished runs, plus any recent failure that may still need a decision. */
  runs: readonly Run[];
  capabilities?: { supportsInterrupt?: boolean; supportsTargetedStop?: boolean; supportsSteer?: boolean };
  /** `NativeDispatcher.taken`: the queued run a worker has taken up and not moved on yet. */
  taken?: string;
}

const OPEN_DELIVERY = new Set<NativeRunDetails['delivery']>(['queued', 'preparing', 'dispatching', 'input_sent', 'uncertain']);
/** Stages where the input may already have reached the CLI, so it cannot be put back in the composer. */
const MAYBE_SENT = new Set(['confirmation', 'runtime_exit', 'http_unknown', 'acknowledged', 'turn_outcome_unknown', 'steer_stopped', 'provider_failed', 'provider_cancelled']);

function runtimeOf(status: NativeStatus): SessionControlSnapshot['runtime'] {
  if (status.connection?.state === 'conflict') return 'conflict';
  if (status.connection?.state === 'failed') return 'failed';
  if (status.phase === 'offline') return 'offline';
  if (status.phase === 'starting') return 'starting';
  return 'ready';
}

function observedForeground(runs: readonly Run[]): Run | undefined {
  return runs.find(run => run.state === 'running' && run.native?.delivery === 'observed' && run.native.intent !== 'steer');
}

function activeTurnOf(input: ControlSnapshotInput, foreground: Run | undefined): ActiveTurnState | null {
  const { session, status, queue, capabilities } = input;
  const present = status.phase === 'busy' || status.phase === 'attention' || queue.held?.reason === 'stopping'
    || Boolean(status.activeTurn) || (Boolean(foreground) && status.phase !== 'offline');
  if (!present) return null;
  const phase: ActiveTurnState['phase'] = queue.held?.reason === 'stopping' ? 'stopping'
    : status.phase === 'attention' ? 'attention'
    : status.phase === 'starting' ? 'starting'
    : 'running';
  const archived = Boolean(session.archivedAt);
  const active = status.activeTurn;
  const owner = (active?.ownerRunId ? input.runs.find(run => run.id === active.ownerRunId) : undefined)
    ?? (active?.turnId ? input.runs.find(run => run.native?.nativeTurnId === active.turnId && (!run.native.nativeSessionId || run.native.nativeSessionId === active.nativeSessionId)) : undefined)
    ?? foreground;
  const turnId = status.activeTurnId ?? owner?.id ?? active?.turnId;
  const nativeTurnId = active?.turnId ?? owner?.native?.nativeTurnId;
  const nativeSessionId = active?.nativeSessionId ?? owner?.native?.nativeSessionId;
  const ownerRunId = active?.ownerRunId ?? owner?.id;
  return {
    ...(turnId ? { turnId } : {}),
    ...(ownerRunId ? { ownerRunId } : {}),
    ...(nativeSessionId ? { nativeSessionId } : {}),
    ...(nativeTurnId ? { nativeTurnId } : {}),
    phase,
    ...(owner?.createdAt ? { startedAt: owner.createdAt } : {}),
    canStop: !archived && Boolean(capabilities?.supportsInterrupt && capabilities?.supportsTargetedStop) && phase !== 'stopping',
    canSteer: !archived && Boolean(capabilities?.supportsSteer && active && phase === 'running' && !status.interaction && queue.held?.reason !== 'unconfirmed'),
  };
}

function sent(native: NativeRunDetails): boolean {
  return Boolean(native.nativeMessageId || native.timings?.observedAt || native.timings?.providerAcceptedAt || native.timings?.inputSentAt || native.timings?.dispatchAt);
}

/** A failure that never left the server, or an uncertain run with no evidence it was written. */
function canRestore(run: Run): boolean {
  const native = run.native;
  if (!native || native.queueReleasedAt || sent(native) || (native.stage !== undefined && MAYBE_SENT.has(native.stage))) return false;
  if (native.delivery === 'uncertain') return true;
  return run.state === 'failed' && native.delivery === 'failed'
    && (native.stage === undefined || native.stage === 'steer_rejected' || native.stage === 'outbox_failure' || native.stage === 'prepare');
}

function executing(run: Run, status: NativeStatus, foreground: Run | undefined): boolean {
  const native = run.native;
  if (!native || native.delivery !== 'observed') return false;
  if (foreground?.id === run.id) return true;
  const active = status.activeTurn;
  if (active?.ownerRunId === run.id) return true;
  return Boolean(active?.turnId && native.nativeTurnId === active.turnId);
}

function inInbox(run: Run, session: Session, status: NativeStatus, foreground: Run | undefined): boolean {
  const native = run.native;
  if (!native || run.sessionId !== session.id || run.state === 'completed') return false;
  if (!OPEN_DELIVERY.has(native.delivery) && native.stage !== 'turn_outcome_unknown' && !(native.delivery === 'failed' && canRestore(run))) return false;
  return !executing(run, status, foreground);
}

function entryStatus(native: NativeRunDetails): InboxEntry['status'] {
  if (native.stage === 'turn_outcome_unknown' || native.delivery === 'uncertain') return 'uncertain';
  if (native.delivery === 'failed') return 'failed';
  if (native.delivery === 'preparing') return 'preparing';
  if (native.delivery === 'dispatching' || native.delivery === 'input_sent') return 'sending';
  return 'queued';
}

/**
 * Whether what holds the queue is only the next message's own way in (A6): the worker that took it
 * up and is waiting for the session lock, the backoff after the CLI refused it, or the CLI that its
 * delivery launched still starting. Background work, a dialog, a turn, a stop or an earlier message
 * is something else it waits behind.
 */
function ownProgress(run: Run, input: ControlSnapshotInput): boolean {
  const held = input.queue.held;
  if (!held || held.runId) return false;
  if (held.reason === 'sending') return input.taken === run.id;
  if (held.reason === 'retrying') return true;
  const { status } = input;
  return held.reason === 'turn_running' && status.phase === 'starting' && run.native!.attempt > 0
    && !status.activity?.background && !status.activity?.compacting;
}

function placementOf(run: Run, active: ActiveTurnState | null, input: ControlSnapshotInput): InboxEntry['placement'] {
  const native = run.native!;
  const { queue } = input;
  // Only a still-queued ordinary message waiting behind a turn or hold belongs in the queue dock.
  // Direct sends, steers, and uncertain/failed deliveries stay in the transcript so their recovery
  // actions remain visible and the dock never hides or mislabels them.
  if (native.intent === 'steer' || native.delivery !== 'queued') return 'sending';
  if (active !== null || queue.next !== run.id) return 'queued';
  return !queue.held || ownProgress(run, input) ? 'sending' : 'queued';
}

function actionsOf(run: Run, placement: InboxEntry['placement'], status: InboxEntry['status'], active: ActiveTurnState | null, session: Session, queue: NativeQueue): InboxAction[] {
  const archived = Boolean(session.archivedAt);
  const native = run.native!;
  if (status === 'uncertain') {
    const actions: InboxAction[] = [];
    if (!archived && native.stage === 'http_unknown') actions.push('retry');
    actions.push('check');
    if (!archived && canRestore(run)) actions.push('restore');
    return actions;
  }
  if (status === 'failed') {
    if (archived) return [];
    return canRestore(run) ? ['restore'] : ['retry'];
  }
  if (native.intent === 'steer' || placement === 'sending') {
    return !archived && (native.delivery === 'queued' || native.delivery === 'preparing') ? ['cancel'] : [];
  }
  const actions: InboxAction[] = [];
  if (!archived && active?.canStop === true && queue.held?.reason !== 'unconfirmed') actions.push('send_now');
  if (!archived && active?.canSteer === true) actions.push('steer');
  if (!archived && native.delivery === 'queued') actions.push('edit', 'cancel');
  return actions;
}

function rank(run: Run): number {
  const native = run.native;
  if (native?.intent === 'steer') return 0;
  if (native?.stage === 'interrupt_followup') return 1;
  if (typeof native?.timings?.fallbackAt === 'number') return 2;
  return 3;
}

function inboxOf(input: ControlSnapshotInput, active: ActiveTurnState | null, foreground: Run | undefined): InboxEntry[] {
  const { session, status, queue } = input;
  return input.runs.filter(run => inInbox(run, session, status, foreground))
    .slice()
    .sort((left, right) => rank(left) - rank(right) || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    .map(run => {
      const native = run.native!;
      const placement = placementOf(run, active, input);
      const entryStatusValue = entryStatus(native);
      return {
        id: run.id,
        commandId: run.commandId,
        kind: native.intent === 'steer' ? 'steer' as const : 'message' as const,
        placement,
        status: entryStatusValue,
        prompt: native.input,
        ...(native.contextSnapshots ? { contextSnapshots: native.contextSnapshots } : {}),
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        ...(run.error ? { error: run.error } : {}),
        ...(native.diagnostic ? { diagnostic: native.diagnostic } : {}),
        actions: actionsOf(run, placement, entryStatusValue, active, session, queue),
      };
    });
}

export function buildSessionControlSnapshot(input: ControlSnapshotInput): SessionControlSnapshot {
  const { revision, status, queue } = input;
  const foreground = observedForeground(input.runs);
  const activeTurn = activeTurnOf(input, foreground);
  const inbox = inboxOf(input, activeTurn, foreground);
  return {
    revision,
    runtime: runtimeOf(status),
    activeTurn,
    inbox,
    ...(queue.held ? { held: queue.held } : {}),
    capabilities: {
      canStop: activeTurn?.canStop ?? false,
      canSteer: activeTurn?.canSteer ?? false,
      canSendNow: inbox.some(entry => entry.actions.includes('send_now')),
    },
    interaction: status.interaction ?? null,
    activity: status.activity ?? { compacting: false, background: 0 },
    ...(status.outputRate ? { outputRate: status.outputRate } : {}),
    ...(status.connection ? { connection: status.connection } : {}),
    ...(status.history ? { history: status.history } : {}),
    ...(status.runtimeControl ? { runtimeControl: status.runtimeControl } : {}),
    ...(status.notice !== undefined ? { notice: status.notice } : {}),
    ...(status.noticeLevel ? { noticeLevel: status.noticeLevel } : {}),
    ...(status.model !== undefined ? { model: status.model } : {}),
    ...(status.permission !== undefined ? { permission: status.permission } : {}),
    ...(status.approval !== undefined ? { approval: status.approval } : {}),
    ...(status.profilePending !== undefined ? { profilePending: status.profilePending } : {}),
    ...(status.transcript ? { transcript: status.transcript } : {}),
  };
}
