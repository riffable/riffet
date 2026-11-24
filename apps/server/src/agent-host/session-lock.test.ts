import { describe, expect, it } from 'vitest';
import { SessionLock } from './session-lock.js';

describe('SessionLock', () => {
  it('allows re-entry after an inherited async scope has closed without self-deadlocking', async () => {
    const lock = new SessionLock();
    let background!: Promise<string>;

    await lock.withSession('s1', async () => {
      // Background work launched inside the lock inherits its AsyncLocalStorage scope.
      background = (async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return lock.withSession('s1', async () =>
          lock.withSession('s1', async () => 'reentered'));
      })();
    });

    const outcome = await Promise.race([
      background,
      new Promise<string>(resolve => setTimeout(() => resolve('deadlocked'), 300)),
    ]);
    expect(outcome).toBe('reentered');
  });

  it('queues inherited work behind a new lock owner once its original scope closed', async () => {
    const lock = new SessionLock();
    const order: string[] = [];
    let releaseSecond!: () => void;
    const secondHold = new Promise<void>(resolve => { releaseSecond = resolve; });
    let startInherited!: () => void;
    const ready = new Promise<void>(resolve => { startInherited = resolve; });
    let inheritedTask!: Promise<void>;

    await lock.withSession('s1', async () => {
      inheritedTask = (async () => {
        await ready;
        await lock.withSession('s1', async () => { order.push('inherited'); });
      })();
    });

    const second = lock.withSession('s1', async () => {
      order.push('second-enter');
      startInherited();
      await secondHold;
      order.push('second-exit');
    });

    await new Promise(resolve => setTimeout(resolve, 10));
    expect(order).toEqual(['second-enter']);
    releaseSecond();
    await Promise.all([second, inheritedTask]);
    expect(order).toEqual(['second-enter', 'second-exit', 'inherited']);
  });

  it('preserves re-entrancy across nested multi-session locks and synchronous first entry', async () => {
    const lock = new SessionLock();
    let enteredSync = false;

    const task = lock.withSession('s1', async () => {
      enteredSync = true;
      return lock.withSession('s2', async () =>
        lock.withSession('s1', async () => 'ok'));
    });

    expect(enteredSync).toBe(true);
    await expect(task).resolves.toBe('ok');
  });
});
