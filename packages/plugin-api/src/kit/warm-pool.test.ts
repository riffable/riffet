import { describe, expect, it } from 'vitest';
import { WarmPool, WarmupRefused, type WarmStart } from './warm-pool.js';

/** Resources are numbers; `stopped` counts each end so a leak or a double stop shows. */
function harness(options: { leaseMs?: number; readyTimeoutMs?: number; failureBackoffMs?: number; takeWaitMs?: number } = {}) {
  const stopped: number[] = [];
  let next = 0;
  const pool = new WarmPool<number>({ stop: async resource => { stopped.push(resource); }, leaseMs: 1_000, readyTimeoutMs: 1_000, failureBackoffMs: 1_000, ...options });
  const started: number[] = [];
  /** A start that resolves when `open()` is called, or ends what it made when aborted first. */
  const gated = () => {
    let open!: () => void;
    const gate = new Promise<void>(resolve => { open = resolve; });
    const start = async ({ signal }: WarmStart) => {
      const id = ++next;
      started.push(id);
      await Promise.race([gate, new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true }))])
        .catch(async error => { stopped.push(id); throw error; });
      return id;
    };
    return { start, open };
  };
  const instant = async () => ++next;
  return { pool, stopped, started, gated, instant };
}

const ready = (pool: WarmPool<number>, key: string) => expect.poll(() => pool.request({ key }, async () => -1).then(result => result.state)).toBe('ready');

describe('WarmPool', () => {
  it('starts once per configuration and hands it to one session', async () => {
    const { pool, stopped, instant } = harness();
    expect((await pool.request({ key: 'a' }, instant)).state).toBe('preparing');
    await ready(pool, 'a');
    expect(await pool.take('a', async resource => resource)).toBe(1);
    // Taken: the next session starts its own, and nothing was stopped.
    expect(await pool.take('a', async resource => resource)).toBeUndefined();
    expect(stopped).toEqual([]);
    expect(pool.stats()).toMatchObject({ hits: 1, misses: 1, ready: 1, wasted: 0 });
  });

  it('lets a session wait for one still starting rather than start its own', async () => {
    const { pool, gated } = harness();
    const { start, open } = gated();
    await pool.request({ key: 'a' }, start);
    const taken = pool.take('a', async resource => resource);
    open();
    expect(await taken).toBe(1);
  });

  it('matches a session by the key the Agent resolved as well as the one asked for', async () => {
    const { pool } = harness();
    await pool.request({ key: 'asked' }, async ({ alias }) => { alias('resolved'); return 7; });
    await ready(pool, 'asked');
    expect(await pool.take(['resolved'], async resource => resource)).toBe(7);
  });

  it('leaves one for another configuration to its page', async () => {
    const { pool, stopped, instant } = harness();
    await pool.request({ key: 'a' }, instant);
    await ready(pool, 'a');
    expect(await pool.take('b', async resource => resource)).toBeUndefined();
    expect(stopped).toEqual([]);
    expect(await pool.take('a', async resource => resource)).toBe(1);
  });

  it('ends a replaced start exactly once, through its signal', async () => {
    const { pool, stopped, gated, instant } = harness();
    const first = gated();
    const held = await pool.request({ key: 'a' }, first.start);
    await pool.request({ key: 'b' }, instant);
    await expect.poll(() => stopped).toEqual([1]);
    // Renewing the replaced claim does not take the slot back from the other page.
    expect(await pool.request({ key: 'a', claimId: held.claimId }, instant)).toEqual({ state: 'skipped', reason: 'held_elsewhere' });
    // The replacement is not mistaken for a failure: `a` may start again at once.
    expect((await pool.request({ key: 'a' }, instant)).state).toBe('preparing');
    expect(pool.stats().failed).toBe(0);
  });

  it('ends one its page stopped renewing, and one its page released', async () => {
    const { pool, stopped, instant } = harness({ leaseMs: 30 });
    await pool.request({ key: 'a' }, instant);
    await expect.poll(() => stopped).toEqual([1]);
    const second = await pool.request({ key: 'b' }, instant);
    await pool.release(second.claimId!);
    await expect.poll(() => stopped).toEqual([1, 2]);
    expect(pool.stats().wasted).toBe(2);
  });

  it('backs off from a configuration whose start failed or timed out', async () => {
    const { pool, gated } = harness({ readyTimeoutMs: 20 });
    await pool.request({ key: 'a' }, async () => { throw new WarmupRefused('cli-attention-required'); });
    await expect.poll(() => pool.request({ key: 'a' }, async () => 1)).toEqual({ state: 'skipped', reason: 'cli-attention-required' });
    const slow = gated();
    await pool.request({ key: 'b' }, slow.start);
    await expect.poll(() => pool.request({ key: 'b' }, async () => 1)).toEqual({ state: 'skipped', reason: 'readiness-timeout' });
    expect(pool.stats().failed).toBe(2);
  });

  it('ends a resource whose adoption failed instead of leaving it held', async () => {
    const { pool, stopped, instant } = harness();
    await pool.request({ key: 'a' }, instant);
    await ready(pool, 'a');
    expect(await pool.take('a', async () => { throw new Error('claim refused'); })).toBeUndefined();
    expect(stopped).toEqual([1]);
  });

  it('stops waiting for one stuck starting, and the session starts its own', async () => {
    const { pool, gated } = harness({ takeWaitMs: 20 });
    const { start } = gated();
    await pool.request({ key: 'a' }, start);
    expect(await pool.take('a', async resource => resource)).toBeUndefined();
  });

  it('lets go one that ended while it waited instead of handing it to a session', async () => {
    const { pool, stopped } = harness();
    let lose!: () => void;
    await pool.request({ key: 'a' }, async ({ lost }) => { lose = lost; return 1; });
    await ready(pool, 'a');
    lose();
    await expect.poll(() => stopped).toEqual([1]);
    expect(await pool.take('a', async resource => resource)).toBeUndefined();
    // Like a failed start, the configuration is held back for a while.
    expect(await pool.request({ key: 'a' }, async () => 2)).toEqual({ state: 'skipped', reason: 'warm-exited' });
  });

  it('gives a resource to one of two sessions asking at once', async () => {
    const { pool, instant } = harness();
    await pool.request({ key: 'a' }, instant);
    await ready(pool, 'a');
    const taken = await Promise.all([pool.take('a', async resource => resource), pool.take('a', async resource => resource)]);
    expect(taken.filter(value => value !== undefined)).toEqual([1]);
  });
});
