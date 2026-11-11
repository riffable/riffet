import type { NativeContext, NativeStatus } from '../../../../packages/contracts/src/index.js';
import type { NativeBackendService } from '../backends/service.js';
import type { TimelineService } from '../timeline/service.js';
import type { TranscriptIngest } from '../sync/ingest.js';

/*
 * What following a conversation holds while a turn of it is open (docs/design/channels.md, 跟随会话):
 * the transcript read kept current, the lane's changes, and the control path, which also keeps the
 * provider's listener open. Run changes are heard once, globally, by the service. The composition
 * mirrors `SyncService.attach` without the SSE framing.
 */

export interface FollowDeps {
  ingest: Pick<TranscriptIngest, 'follow'>;
  timeline: Pick<TimelineService, 'ready' | 'subscribe'>;
  control: NativeBackendService['watchControl'];
}

export interface FollowHandlers {
  /** The main lane changed (rows or outline). */
  rows(): void;
  /** Status, queue or interaction moved; also called once with the status at the start. */
  status(status: NativeStatus): void;
  /** The provider's context meter moved; undefined once it is no longer reported. */
  context?(context: NativeContext | undefined): void;
  /** The control path could not be opened; rows still flow. */
  controlFailed?(error: unknown): void;
}

export interface Following { status(): NativeStatus | undefined; close(): void }

export function followSession(deps: FollowDeps, sessionId: string, handlers: FollowHandlers): Following {
  const offs: Array<() => void> = [deps.ingest.follow(sessionId)];
  let closed = false;
  let control: ReturnType<FollowDeps['control']> | undefined;
  try {
    control = deps.control(sessionId, message => { if (closed) return; if (message.type === 'status') handlers.status(message.status); else if (message.type === 'context') handlers.context?.(message.context); });
    offs.push(() => control!.close());
  } catch (error) { handlers.controlFailed?.(error); }
  void deps.timeline.ready(sessionId, 'main').then(() => {
    if (closed) return;
    offs.push(deps.timeline.subscribe(sessionId, 'main', () => { if (!closed) handlers.rows(); }));
    handlers.rows();
  }, error => handlers.controlFailed?.(error));
  if (control) queueMicrotask(() => { if (closed) return; handlers.status(control!.status()); handlers.context?.(control!.context()); });
  return {
    status: () => control?.status(),
    close() {
      if (closed) return;
      closed = true;
      for (const off of offs.splice(0)) { try { off(); } catch { /* every hold is let go */ } }
    },
  };
}
