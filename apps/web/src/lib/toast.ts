import { createStore, useStore } from './store';
import { MIN_FEEDBACK_VISIBLE_MS } from './feedback';

export interface ToastAction { label: string; onClick: () => void; }
export interface ToastOptions { action?: ToastAction; duration?: number; details?: string; }
export interface ToastItem { id: number; tone: 'success' | 'error' | 'info'; message: string; leaving: boolean; action?: ToastAction; details?: string; }

const store = createStore<{ items: ToastItem[] }>({ items: [] });
let sequence = 0;

/** Matches `--duration-exit-base` in the toaster; the row is dropped only once it has played. */
const TOAST_EXIT_MS = 140;
/** An undo needs time to be read and reached, so a toast carrying one outlives a plain one. */
const ACTION_DURATION_MS = 6000;

/** Pending rows have a clock, but consume no time until the host has fully presented them. */
interface ToastClock {
  timer: number | undefined;
  remaining: number;
  startedAt: number;
  presented: boolean;
  pauses: Set<string>;
  generation: number;
}
const clocks = new Map<number, ToastClock>();
let observingVisibility = false;

function stopClock(clock: ToastClock): void {
  clock.generation++;
  if (clock.timer === undefined) return;
  window.clearTimeout(clock.timer);
  clock.timer = undefined;
  clock.remaining = Math.max(0, clock.remaining - (performance.now() - clock.startedAt));
}

function startClock(id: number): void {
  const clock = clocks.get(id);
  if (!clock || clock.timer !== undefined || !clock.presented || clock.pauses.size || document.visibilityState === 'hidden' || !Number.isFinite(clock.remaining)) return;
  clock.startedAt = performance.now();
  const generation = ++clock.generation;
  clock.timer = window.setTimeout(() => {
    if (clocks.get(id) !== clock || generation !== clock.generation) return;
    clock.timer = undefined;
    if (!clock.presented || clock.pauses.size || document.visibilityState === 'hidden') return;
    clock.remaining = 0;
    dismissToast(id);
  }, clock.remaining);
}

function onVisibilityChange(): void {
  for (const [id, clock] of clocks) {
    if (document.visibilityState === 'hidden') stopClock(clock);
    else startClock(id);
  }
}

/** The host reports complete visibility after its entrance and whenever the viewport changes. */
export function setToastPresented(id: number, presented: boolean): void {
  const clock = clocks.get(id);
  if (!clock || clock.presented === presented) return;
  clock.presented = presented;
  if (presented) startClock(id);
  else stopClock(clock);
}

function removeToast(id: number): void {
  const { items } = store.get();
  const next = items.filter((item) => item.id !== id);
  if (next.length === items.length) return;
  store.set({ items: next });
  if (!clocks.size && observingVisibility) {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    observingVisibility = false;
  }
}

/**
 * Marks the row as leaving rather than dropping it, so the exit animation has something to
 * animate. A second call for the same row (the timer racing the close button) does nothing.
 */
export function dismissToast(id: number): void {
  const clock = clocks.get(id);
  if (clock) stopClock(clock);
  clocks.delete(id);
  const { items } = store.get();
  const target = items.find((item) => item.id === id);
  if (!target || target.leaving) return;
  store.set({ items: items.map((item) => (item.id === id ? { ...item, leaving: true } : item)) });
  window.setTimeout(() => removeToast(id), TOAST_EXIT_MS);
}

/** Holds the auto-dismiss while the pointer or focus is on the toast; `resumeToast` restarts it. */
export function pauseToast(id: number, reason = 'interaction'): void {
  const clock = clocks.get(id);
  if (!clock || clock.pauses.has(reason)) return;
  clock.pauses.add(reason);
  stopClock(clock);
  // Preserve the existing grace after reading or reaching an action with the keyboard.
  clock.remaining = Math.max(1000, clock.remaining);
}

export function resumeToast(id: number, reason = 'interaction'): void {
  clocks.get(id)?.pauses.delete(reason);
  startClock(id);
}

/** Runs the toast's action once and dismisses it, so a second click cannot undo twice. */
export function runToastAction(id: number): void {
  const target = store.get().items.find((item) => item.id === id);
  if (!target?.action || target.leaving) return;
  dismissToast(id);
  target.action.onClick();
}

function push(tone: ToastItem['tone'], message: string, duration: number, options?: ToastOptions): void {
  if (!message) return;
  const requestedDuration = options?.duration ?? duration;
  const lifetime = Math.max(options?.action ? ACTION_DURATION_MS : MIN_FEEDBACK_VISIBLE_MS, Number.isNaN(requestedDuration) ? duration : requestedDuration);
  const details = options?.details || undefined;
  const { items } = store.get();
  // Keep a repeated row mounted. Each undo belongs to its own change and stays independent.
  const repeated = items.find((existing) => !existing.leaving && existing.tone === tone && existing.message === message && existing.details === details && !existing.action && !options?.action);
  if (repeated) {
    const clock = clocks.get(repeated.id);
    if (clock) {
      stopClock(clock);
      clock.remaining = lifetime;
      startClock(repeated.id);
    }
    return;
  }
  const item: ToastItem = { id: ++sequence, tone, message, leaving: false, ...(details ? { details } : {}), ...(options?.action ? { action: options.action } : {}) };
  clocks.set(item.id, { timer: undefined, remaining: lifetime, startedAt: 0, presented: false, pauses: new Set(), generation: 0 });
  if (!observingVisibility) {
    document.addEventListener('visibilitychange', onVisibilityChange);
    observingVisibility = true;
  }
  // The host admits at most four rows, and leaves rows that do not fit waiting without a timer.
  store.set({ items: [...items, item] });
}

export const toast = {
  success: (message: string, options?: ToastOptions) => push('success', message, 2800, options),
  info: (message: string, options?: ToastOptions) => push('info', message, 3500, options),
  error: (message: string, options?: ToastOptions) => push('error', message, 6500, options),
};

export function useToasts(): ToastItem[] {
  return useStore(store, (state) => state.items);
}
