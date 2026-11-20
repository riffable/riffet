import type { NativeQueue, NativeStatus, Run } from '../../../../packages/contracts/src/index.js';

/**
 * One conversation's queue: which message starts next, and what holds it. The dispatcher starts a
 * message only when nothing does, and clients are told the same answer (`NativeStatus.queue`), so the
 * dock and the dispatcher decide by one rule. The answer goes out with each status and run change; a
 * hold that ends in the dispatcher alone (a reservation, a retry delay) is corrected by the run change
 * that follows when the message starts.
 *
 * A message is admitted only while the CLI can take a new turn. The CLI is never handed a message to
 * refuse: refusing would move the message through `preparing` and back on every attempt, and take the
 * turn's checkpoint while the turn before it is still editing files.
 */
export interface LaneFacts {
  /** The conversation's unfinished native runs, oldest first. */
  runs: readonly Run[];
  /** The provider's status, or undefined when it cannot be read. */
  status: NativeStatus | undefined;
  /** A dispatch worker holds the conversation. */
  sending: boolean;
  stopping: boolean;
  recovering: boolean;
  workspaceReserved: boolean;
  /** The provider would take a message into its own inbox while it starts as well (`acceptsInputWhileBusy`). */
  waitsWhileStarting: boolean;
  /** The session has a config change that only a relaunch applies (`relaunchesForPendingConfig` and `configPending`). */
  pendingRelaunch?: boolean;
  /** When the run may be tried again after the CLI refused it, in epoch ms. */
  retryAt(runId: string): number;
  now: number;
}

export type QueueHold = NonNullable<NativeQueue['held']>;
export interface Admission { next?: Run; held?: QueueHold }

const IN_FLIGHT = new Set(['preparing', 'dispatching', 'input_sent', 'observed', 'uncertain']);

/**
 * Whether the turn a steer was addressed to is over. A steer reaches only its own turn (a hook's
 * context at that turn's tool boundary, or a provider call naming the turn), so once the CLI is no
 * longer in that turn nothing of it can reach a later one: it no longer holds back other messages.
 * Over means the CLI is at its prompt, or names another turn of the same chat; an offline or
 * starting CLI proves nothing (a provider may keep running a turn its connection lost).
 */
export function steerTurnEnded(run: Run, status: NativeStatus | undefined): boolean {
  if (!status || run.native?.intent !== 'steer') return false;
  const active = status.activeTurn;
  if (active) return active.nativeSessionId === run.native.nativeSessionId && active.turnId !== run.native.nativeTurnId;
  return status.phase === 'idle';
}

/** An unconfirmed delivery holds the conversation: what the CLI may still be running must not be raced. */
export function holdsUnconfirmed(run: Run, status: NativeStatus | undefined): boolean {
  return run.native?.delivery === 'uncertain' && !run.native.queueReleasedAt && !steerTurnEnded(run, status);
}

/** The queued message that starts first: a stop's follow-up, then a steer sent on as a message, then the oldest. */
function nextQueued(runs: readonly Run[]): Run | undefined {
  const queued = runs.filter(run => run.native?.intent !== 'steer' && run.native?.delivery === 'queued');
  return queued.find(run => run.native!.stage === 'interrupt_followup') ?? queued.find(run => Number.isFinite(run.native!.timings?.fallbackAt)) ?? queued[0];
}

export function admission(facts: LaneFacts): Admission {
  const { runs, status } = facts;
  const next = nextQueued(runs);
  const held = (reason: QueueHold['reason'], runId?: string): Admission => ({ ...(next ? { next } : {}), held: { reason, ...(runId ? { runId } : {}) } });
  // An unknown delivery is named before anything else: it is the one hold the user has to settle, and
  // clients read "an unconfirmed message holds the conversation" from it (`holdsUnconfirmed`).
  const unconfirmed = runs.find(run => holdsUnconfirmed(run, status));
  if (unconfirmed) return held('unconfirmed', unconfirmed.id);
  if (facts.workspaceReserved) return held('workspace');
  if (facts.stopping) return held('stopping');
  if (facts.recovering) return held('recovering');
  // An earlier message that may still be on its way in holds every later one: its execution may still be
  // in flight. A released one does not; a steer whose turn is over cannot; a preparing one only while a
  // worker is preparing it (one left behind has written nothing and must not stall the queue).
  const holding = runs.filter(run => run.native && !run.native.queueReleasedAt && IN_FLIGHT.has(run.native.delivery) && !steerTurnEnded(run, status)
    && (run.native.delivery !== 'preparing' || run.native.intent === 'steer' || facts.sending));
  // Steers are sent only by their own operation, never by the queue, and go first.
  const steering = runs.find(run => run.native?.intent === 'steer' && (run.native.delivery === 'queued' || run.native.delivery === 'preparing'));
  if (steering) return held('steering', steering.id);
  const earlier = holding[0];
  if (earlier) return held(earlier.native!.delivery === 'observed' ? 'turn_running' : 'sending', earlier.id);
  if (facts.sending) return held('sending');
  // Released history does not waive the provider's current execution boundary.
  if (runs.some(run => run.native?.queueReleasedAt)
    && (!status || status.phase !== 'idle' || status.activeTurn || status.activity?.background || status.activity?.compacting)) return held('turn_running');
  if (status?.phase === 'busy') return held('turn_running');
  if (status?.phase === 'attention') return held('attention');
  // The relaunch that applies a pending config waits for the CLI's turn and background work to finish; admitting the
  // message now would only have the backend refuse it (CLI_BUSY) and put it back, over and over.
  if (facts.pendingRelaunch && (status?.activeTurn || status?.activity?.background || status?.activity?.compacting)) return held('turn_running');
  if (status?.phase === 'starting' && facts.waitsWhileStarting) return held('turn_running');
  if (next && facts.retryAt(next.id) > facts.now) return held('retrying');
  return next ? { next } : {};
}

/** The projection clients read, by id. Empty when nothing waits and nothing holds: present means known. */
export function queueOf(admitted: Admission): NativeQueue {
  return { ...(admitted.next ? { next: admitted.next.id } : {}), ...(admitted.held ? { held: admitted.held } : {}) };
}

/** A message is next and only the provider's status holds it: no run of ours, no operation of ours. */
export function heldByProvider(admitted: Admission): boolean {
  return Boolean(admitted.next && admitted.held && !admitted.held.runId && (admitted.held.reason === 'turn_running' || admitted.held.reason === 'attention'));
}

export interface LookFacts {
  runs: readonly Run[];
  now: number;
  /** How often something that has no deadline of its own is looked at again. */
  intervalMs: number;
  confirmationMs: number;
  retryAt(runId: string): number;
  /** Since when an observed run's provider has been idle with no turn, if it has. */
  idleSince(runId: string): number | undefined;
  idleWindow(run: Run): number;
  /** `heldByProvider` for these runs; asked only when a message is queued. */
  held(): boolean;
}

/**
 * The next moment a conversation has to be looked at again: a retry, a receipt window, an idle grace, a
 * status read while an observed run is not idle yet, or a queue that only the provider's status holds —
 * the push that would free it may never come. Undefined when nothing waits on the clock.
 */
export function nextLook(facts: LookFacts): number | undefined {
  const at = facts.now;
  let next: number | undefined;
  let queued = false;
  const consider = (when: number) => { if (next === undefined || when < next) next = when; };
  for (const run of facts.runs) {
    const native = run.native;
    if (!native || native.queueReleasedAt) continue;
    if (native.delivery === 'queued' && native.intent !== 'steer') {
      queued = true;
      const retry = facts.retryAt(run.id);
      if (retry > at) consider(retry);
    } else if (native.delivery === 'input_sent') {
      const due = (native.timings?.inputSentAt ?? at) + facts.confirmationMs + 1;
      // Past the window but still input_sent: the provider was busy. Look again on this conversation only.
      consider(due > at ? due : at + facts.intervalMs);
    } else if (native.delivery === 'observed') {
      const since = facts.idleSince(run.id);
      if (since !== undefined) consider(since + facts.idleWindow(run) > at ? since + facts.idleWindow(run) : at + facts.intervalMs);
      else consider(at + facts.intervalMs);
    }
  }
  if (queued && facts.held()) consider(at + facts.intervalMs);
  return next;
}
