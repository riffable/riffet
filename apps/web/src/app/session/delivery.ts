import type { NativeQueue, Run, SessionControlSnapshot } from '@contracts';
import { hasNativeInputReceipt } from '../../../../../packages/timeline/src/model';
export { nativeTaskOutcome } from '../../../../../packages/timeline/src/failures';

export type NativeDeliveryStatus = '' | 'sending' | 'resuming' | 'outcome_unknown' | 'unconfirmed' | 'task_failed' | 'send_failed' | 'stopped' | 'cancelled';

/**
 * What a prompt says about its delivery. A turn stopped after the prompt arrived is the turn's
 * outcome, not the prompt's: `stopShown` false leaves `stopped` to the row that ends the turn.
 */
export function nativeDeliveryStatus(run: Run, stopShown = true, hasTurnOutput = false): NativeDeliveryStatus {
  if (!run.native) return '';
  const native = run.native;
  const isSteer = native.intent === 'steer';
  const received = hasNativeInputReceipt(native) || native.stage === 'provider_failed' || native.stage === 'turn_outcome_unknown'
    || (!isSteer && (hasTurnOutput || run.state === 'running'));
  switch (native.delivery) {
    case 'queued': return received ? '' : 'sending';
    case 'preparing': return received ? '' : native.stage === 'resuming' ? 'resuming' : 'sending';
    case 'dispatching': return received ? '' : 'sending';
    case 'input_sent': return received || (!isSteer && run.state === 'completed') ? '' : 'sending';
    case 'observed': return '';
    case 'uncertain': return received ? 'outcome_unknown' : 'unconfirmed';
    case 'failed': return received ? 'task_failed' : 'send_failed';
    case 'cancelled': return native.stage === 'acknowledged' ? received ? 'outcome_unknown' : 'unconfirmed' : native.stage === 'turn_outcome_unknown' ? 'outcome_unknown' : native.nativeMessageId || run.state === 'interrupted' ? stopShown ? 'stopped' : '' : 'cancelled';
  }
}

/**
 * Where a message sent to the CLI stands, as the client sees it. The places that ask "is it still
 * queued", "can it still be sent now or withdrawn" and "where does it show" all read it here, so
 * they cannot disagree about the same run in the same frame.
 *
 *   submitting ─▶ queued ─▶ starting ─▶ sent
 *        └───────────┴──────────┴──────▶ uncertain · failed · cancelled
 *
 * `submitting` is this tab's own copy before the server answered (`http_pending`); `starting` is
 * the server preparing and dispatching it; `sent` is the CLI having it.
 */
export type SendPhase = 'submitting' | 'queued' | 'starting' | 'sent' | 'uncertain' | 'failed' | 'cancelled';

export function sendPhase(run: Run): SendPhase | undefined {
  const native = run.native;
  if (!native) return undefined;
  switch (native.delivery) {
    case 'queued': return native.stage === 'http_pending' ? 'submitting' : 'queued';
    case 'preparing': case 'dispatching': return 'starting';
    case 'input_sent': case 'observed': return 'sent';
    default: return native.delivery;
  }
}

/**
 * A queued message (not a steer) the server holds: it can still be sent now, edited or withdrawn.
 * The control snapshot decides (`placement === 'queued'`); only a server that sends none (an older
 * one) leaves it to the run's own delivery state.
 */
export function inQueue(run: Run, control?: SessionControlSnapshot): boolean {
  if (control) return control.inbox.some((entry) => entry.placement === 'queued' && (entry.id === run.id || entry.commandId === run.commandId));
  return run.native?.intent !== 'steer' && sendPhase(run) === 'queued';
}

/**
 * Where the message shows: in the dock above the composer while it waits its turn, else in the
 * transcript.
 *
 * The server says where its queue stands (`NativeStatus.queue`): a queued message is in the dock
 * unless it is the one starting now (`next`, nothing holding it), and a send it has not answered yet
 * goes where it will land, the dock when something holds the queue or starts before it. A run newer
 * than the answer it arrived with (no `next` yet) is placed by [next], the oldest one the server holds.
 *
 * An older server says nothing of its queue. Then a send the server has not answered goes to the dock
 * while the session is working, and the one it starts first when nothing runs ([next], with no stated
 * reason to wait) stays in the transcript, so a direct send does not pass through the dock.
 */
export function messagePlace(run: Run, sessionWorking: boolean, next = false, queue?: NativeQueue): 'dock' | 'transcript' {
  if (run.native?.intent === 'steer') return 'transcript';
  const phase = sendPhase(run);
  if (queue) {
    if (phase === 'queued') return queue.held ? 'dock' : queue.next === run.id || !queue.next && next ? 'transcript' : 'dock';
    return phase === 'submitting' && (queue.held || queue.next) ? 'dock' : 'transcript';
  }
  if (phase === 'queued') return sessionWorking || !next || run.native?.stage ? 'dock' : 'transcript';
  return phase === 'submitting' && sessionWorking ? 'dock' : 'transcript';
}
