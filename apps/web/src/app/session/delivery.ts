import type { NativeQueue, Run } from '@contracts';
export { nativeTaskOutcome } from '../../../../../packages/timeline/src/failures';

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

/** A queued message (not a steer) the server holds: it can still be sent now, edited or withdrawn. */
export function inQueue(run: Run): boolean {
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
