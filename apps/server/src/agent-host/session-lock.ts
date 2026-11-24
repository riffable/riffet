import { AsyncLocalStorage } from 'node:async_hooks';

interface LockScope { sessionId: string; active: boolean; }

/**
 * The per-session lock every backend operation (start, configure, send, interrupt, respond) runs
 * under. It belongs to the host, not to any backend: one instance serves the dispatcher, the routes
 * and each driver, whichever backends are registered.
 */
export class SessionLock {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly context = new AsyncLocalStorage<LockScope[]>();

  /** Reentrant per-session lock; an inherited async context is ignored after its scope closes. */
  async withSession<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    if (this.context.getStore()?.some(scope => scope.sessionId === sessionId && scope.active)) return fn();

    const previous = this.tails.get(sessionId);
    let release!: () => void;
    const gate = new Promise<void>(resolveGate => { release = resolveGate; });
    const tail = (previous ?? Promise.resolve()).catch(() => undefined).then(() => gate);
    this.tails.set(sessionId, tail);
    const scope: LockScope = { sessionId, active: true };
    const run = async () => {
      const parent = (this.context.getStore() ?? []).filter(item => item.active);
      try { return await this.context.run([...parent, scope], fn); }
      finally {
        scope.active = false;
        release();
        if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId);
      }
    };
    // First owner enters synchronously so it can reserve SessionState=starting before another
    // request performs its workspace availability check. A queued same-session owner waits.
    if (previous) await previous.catch(() => undefined);
    return run();
  }

  /**
   * `withSession` for work scheduled from timers: a timer inherits the async context of whoever
   * armed it, and an inherited still-active scope would otherwise let it skip the queue.
   */
  withDetachedSession<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return this.context.exit(() => this.withSession(sessionId, fn));
  }

  /** Settles once every operation queued so far has finished. */
  settled(): Promise<unknown> {
    return Promise.allSettled([...this.tails.values()]);
  }
}

/** What callers that only take the lock depend on. */
export type SessionLockHandle = Pick<SessionLock, 'withSession' | 'withDetachedSession'>;
