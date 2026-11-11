import { useSyncExternalStore } from 'react';

/**
 * One wall clock for every elapsed-time label on the page. Each ticking label used to own a 1s
 * interval; they now share a single one that only runs while something is subscribed.
 */
const TICK_MS = 1_000;
const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;

function tick() {
  now = Date.now();
  for (const listener of listeners) listener();
}

export function subscribeNow(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === undefined) {
    // The value may be from long ago if nothing was subscribed; React re-reads it right after
    // subscribing, so the first frame is corrected without waiting for a tick.
    now = Date.now();
    timer = setInterval(tick, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

export function getNow(): number {
  return now;
}

/** Whether the shared interval is running; exposed for tests. */
export function nowTicking(): boolean {
  return timer !== undefined;
}

const idle = () => () => {};

/**
 * The current time, re-rendering once a second while `active`. An inactive caller neither ticks nor
 * holds the interval open, and must not rely on the returned value being fresh.
 */
export function useNow(active = true): number {
  return useSyncExternalStore(active ? subscribeNow : idle, getNow, getNow);
}
