import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

/** Earlier history is requested once the loaded content starts within this many viewports above the reader. */
export const PREFETCH_VIEWPORTS = 2;
/** Failures in a row that retry silently; the next one shows the reader a way to retry. */
export const QUIET_FAILURES = 3;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/** Longest an idle prefetch waits for the browser to be free before it goes anyway. */
const IDLE_TIMEOUT_MS = 3_000;

/**
 * How one request for earlier history ended. `progress`: the history moved on (a page landed, or the
 * cursor advanced past a page with nothing new to show). `none`: nothing was asked, or the answer is
 * no longer wanted (superseded, stale, paused elsewhere) - not a failure. `failed`: the request failed
 * or did not move the cursor, so repeating it would repeat the same answer.
 */
export type EarlierLoad = 'progress' | 'none' | 'failed';

/** Wait before retrying after the [failures]th failure in a row: 1s, 2s, 4s… up to 30s. */
export const retryDelay = (failures: number) => Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));

/** Runs [task] once the browser has a moment, or after [IDLE_TIMEOUT_MS] regardless. Returns the cancel. */
export function whenIdle(task: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const handle = window.requestIdleCallback(task, { timeout: IDLE_TIMEOUT_MS });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(task, 500);
  return () => window.clearTimeout(handle);
}

/**
 * Loads earlier history before the reader gets to it, so the top of the transcript never shows a
 * button. One request at a time: a page is asked for when the loaded content starts within
 * [PREFETCH_VIEWPORTS] viewports above the view (judged on scroll, and again after every page and
 * layout change), and once when the browser is idle after the first screen. A failure backs off
 * quietly; after [QUIET_FAILURES] in a row automatic loading stops until the reader retries.
 *
 * [probeRef] is an element at the top of the loaded content, outside any windowed rows, so its
 * position says how much is loaded above the reader whichever rows happen to be mounted.
 * [load] reports how the request ended; only a `failed` one counts towards backing off. [version] is anything that changes when content does.
 */
export function useEarlierHistory({ scrollRef, probeRef, scope, enabled, paused, version, load, below = false }: {
  scrollRef: RefObject<HTMLElement | null>;
  probeRef: RefObject<HTMLElement | null>;
  /** The history lies below the reader instead (a window moved away from the end): [probeRef] is at the bottom of the loaded content. */
  below?: boolean;
  /** What the history belongs to; a different scope starts over. */
  scope: string;
  enabled: boolean;
  /** A request is in flight elsewhere, or the history is waiting to be re-synced. */
  paused: boolean;
  version: number;
  load?: () => Promise<EarlierLoad>;
}): { failed: boolean; check: () => void; retry: () => void } {
  const [failed, setFailed] = useState(false);
  const state = useRef({ busy: false, failures: 0, epoch: 0, timer: undefined as number | undefined });
  const latest = useRef({ enabled, paused, load });
  latest.current = { enabled, paused, load };

  const run = useCallback(async () => {
    const s = state.current;
    const { load } = latest.current;
    if (s.busy || !load) return;
    s.busy = true;
    const epoch = s.epoch;
    let outcome: EarlierLoad = 'failed';
    try { outcome = await load(); } catch { outcome = 'failed'; }
    if (epoch !== s.epoch) return;
    s.busy = false;
    if (outcome === 'progress') { s.failures = 0; return; }
    // Nothing failed, so there is nothing to retry; a change of version or pause checks again.
    if (outcome === 'none') return;
    s.failures += 1;
    if (s.failures >= QUIET_FAILURES) { setFailed(true); return; }
    s.timer = window.setTimeout(() => { s.timer = undefined; check(); }, retryDelay(s.failures));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- check only reads refs
  }, []);

  const check = useCallback(() => {
    const s = state.current;
    const { enabled, paused } = latest.current;
    if (!enabled || paused || s.busy || s.timer !== undefined || s.failures >= QUIET_FAILURES) return;
    const scroller = scrollRef.current;
    const probe = probeRef.current;
    if (!scroller || !probe) return;
    // How much of the loaded content lies beyond the edge of the view the history is on.
    const view = scroller.getBoundingClientRect();
    const edge = probe.getBoundingClientRect();
    const beyond = below ? edge.bottom - view.bottom : view.top - edge.top;
    if (beyond < scroller.clientHeight * PREFETCH_VIEWPORTS) void run();
  }, [scrollRef, probeRef, run, below]);

  const retry = useCallback(() => {
    const s = state.current;
    window.clearTimeout(s.timer);
    s.timer = undefined;
    s.failures = 0;
    setFailed(false);
    void run();
  }, [run]);

  // Another conversation, or a history that was replaced: nothing carries over.
  const idled = useRef<string | undefined>(undefined);
  useEffect(() => {
    const s = state.current;
    s.epoch += 1;
    s.busy = false;
    s.failures = 0;
    setFailed(false);
    return () => { window.clearTimeout(s.timer); s.timer = undefined; };
  }, [scope]);

  // After a page lands or the view moves, the position may still call for the next one.
  useEffect(() => { check(); }, [enabled, paused, version, failed, check]);

  // One page ahead of any scrolling, once the first screen is up.
  useEffect(() => {
    if (!enabled || idled.current === scope) return;
    return whenIdle(() => {
      idled.current = scope;
      const { enabled, paused } = latest.current;
      const s = state.current;
      if (enabled && !paused && s.timer === undefined && s.failures < QUIET_FAILURES) void run();
    });
  }, [enabled, scope, run]);

  return { failed, check, retry };
}
