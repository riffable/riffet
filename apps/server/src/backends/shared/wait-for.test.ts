import { describe, expect, it } from 'vitest';
import { waitFor } from './wait-for.js';

const block = (ms: number) => { const until = Date.now() + ms; while (Date.now() < until) { /* a stalled event loop */ } };

describe('waitFor under event-loop stalls', () => {
  it('reads a condition met during a stall that outlasts the window instead of timing out', async () => {
    let met = false;
    setTimeout(() => { met = true; block(400); }, 20).unref();
    const result = await waitFor(() => met, { timeoutMs: 100, intervalMs: 50, maxStallAllowanceMs: 0 });
    expect(result).toBe(true);
  });

  it('gives back the time a stall took from the window', async () => {
    let calls = 0;
    const started = Date.now();
    // The condition holds only on the fourth read; a stall eats most of the 150 ms window before it.
    setTimeout(() => block(200), 10).unref();
    const result = await waitFor(() => ++calls >= 4 && 'ready', { timeoutMs: 150, intervalMs: 40 });
    expect(result).toBe('ready');
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
  });

  it('times out with undefined when the condition never holds', async () => {
    expect(await waitFor(() => false, { timeoutMs: 60, intervalMs: 20 })).toBeUndefined();
  });

  it('re-runs the probe as soon as it is woken', async () => {
    let met = false;
    let notify: (() => void) | undefined;
    const started = Date.now();
    setTimeout(() => { met = true; notify?.(); }, 10).unref();
    expect(await waitFor(() => met, { timeoutMs: 5_000, intervalMs: 2_000, wake: callback => { notify = callback; return () => { notify = undefined; }; } })).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
