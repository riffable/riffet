/**
 * Condition wait for anything another process does: a TUI repainting, a transcript row, a hook, an RPC reply.
 * See docs/DELIVERY.md (等待原语).
 *
 * Two rules keep a busy server from turning "already happened" into "timed out":
 *
 *   final probe       the condition is read once more after the deadline. After an event-loop stall Node runs
 *                     expired timers before it reads the I/O that arrived meanwhile, so a wait without this
 *                     loses every race the stall decides.
 *   stall allowance   a poll that wakes later than its interval (the loop was blocked) moves the deadline by
 *                     the lateness, up to `maxStallAllowanceMs`: the window measures time the wait was given,
 *                     not wall time the loop spent elsewhere.
 *
 * A timeout only says the window ran out. What the caller does next (keep watching at a slower cadence,
 * hand over to a later stage, report to the user) is its own decision; dropping the tracking is not one.
 */
export interface WaitForOptions {
  timeoutMs: number;
  /** Poll spacing. The probe also runs whenever `wake` fires. */
  intervalMs: number;
  /** Registers a callback that re-runs the probe at once (a hook landed, a status changed); returns its unregister. */
  wake?: (notify: () => void) => () => void;
  /** Stops the wait early; the result is then `undefined` without a final probe. */
  signal?: AbortSignal;
  /** Most the deadline may move for stalls. Defaults to the timeout itself. */
  maxStallAllowanceMs?: number;
}

type Probe<T> = () => T | false | undefined | Promise<T | false | undefined>;

/** Resolves with the probe's first value that is neither `false` nor `undefined`, or `undefined` once the window is spent. */
export async function waitFor<T>(probe: Probe<T>, options: WaitForOptions): Promise<T | undefined> {
  const { timeoutMs, intervalMs, signal } = options;
  const maxAllowance = options.maxStallAllowanceMs ?? timeoutMs;
  const read = async (): Promise<T | undefined> => {
    try {
      const value = await probe();
      return value === false || value === undefined ? undefined : value;
    } catch { return undefined; }
  };
  if (signal?.aborted) return undefined;
  const first = await read();
  if (first !== undefined) return first;
  let deadline = Date.now() + timeoutMs;
  let allowance = 0;
  let woken: (() => void) | undefined;
  // A wake that lands while the probe runs (no sleep to cut short) still makes the next sleep end at once.
  let missed = false;
  const unregister = options.wake?.(() => { if (woken) woken(); else missed = true; });
  try {
    for (;;) {
      if (signal?.aborted) return undefined;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const step = missed ? 0 : Math.min(intervalMs, remaining);
      missed = false;
      const sleptFrom = Date.now();
      await new Promise<void>(resolve => {
        const timer = setTimeout(done, step);
        timer.unref?.();
        const onAbort = () => done();
        signal?.addEventListener('abort', onAbort, { once: true });
        woken = done;
        function done() { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); woken = undefined; resolve(); }
      });
      const late = Date.now() - sleptFrom - step;
      if (late > 0 && allowance < maxAllowance) {
        const moved = Math.min(late, maxAllowance - allowance);
        allowance += moved;
        deadline += moved;
      }
      if (signal?.aborted) return undefined;
      const value = await read();
      if (value !== undefined) return value;
    }
    // The final probe: whatever arrived while the loop was blocked is read before the wait is called lost.
    return await read();
  } finally { unregister?.(); }
}
