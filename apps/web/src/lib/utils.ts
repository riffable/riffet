import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Controls marked `data-closes-overlay` navigate away, so the popover or sheet showing them should close. */
export function closesOverlay(target: EventTarget): boolean {
  return target instanceof Element && Boolean(target.closest('[data-closes-overlay]'));
}

// Kept here for the callers that predate `lib/i18n/format`; new code imports them from there.
export { formatClock, formatDateTime, isJustNow, relativeTime, timeAgo } from './i18n/format';
// Lives beside `HttpError`, whose code it puts into words.
export { errorMessage } from './errors';

export function formatBytes(size: number | undefined): string {
  if (size === undefined) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(1)} GB`;
}


/**
 * How long to wait before redialing a stream the browser gave up on (an `EventSource` closes for
 * good on an HTTP error). Doubles from one second up to thirty, with jitter so every open tab does
 * not hit a restarting server in the same instant.
 */
export function reconnectDelay(attempt: number): number {
  const base = Math.min(1000 * 2 ** Math.max(0, Math.min(attempt - 1, 5)), 30_000);
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

export function newId(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** Positive integer pixel edge from an untrusted payload; anything else is unknown. */
export function pixelEdge(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Model names from a CLI sometimes carry zero-width padding and doubled spaces. */
export function cleanLabel(value: string): string {
  return value.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
}

export function downloadJson(name: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

export function readStored(key: string): string {
  try { return window.localStorage.getItem(key) ?? ''; } catch { return ''; }
}

export function writeStored(key: string, value: string | undefined): void {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch { /* Private mode storage can be unavailable. */ }
}

/** What this tab kept under [key] as JSON, or `undefined`; the caller checks its shape. */
export function readSession(key: string): unknown {
  try {
    const raw = window.sessionStorage.getItem(key);
    return raw === null ? undefined : JSON.parse(raw);
  } catch { return undefined; }
}

/** Keeps [value] as JSON for this tab; `undefined` drops the key. */
export function writeSession(key: string, value: unknown): void {
  try {
    if (value === undefined) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch { /* Private mode storage can be unavailable. */ }
}

/**
 * Shares one [read] between callers: a call while it runs joins it. `fresh` (after a write) waits
 * for it and reads once more, since that answer may predate the write; fresh callers share that
 * read. Only `true` counts, so an event handed in by a listener is not taken for it.
 */
export function singleFlight(read: () => Promise<void>): (fresh?: boolean) => Promise<void> {
  let running: Promise<void> | undefined;
  let again: Promise<void> | undefined;
  const run = () => (running ??= read().finally(() => { running = undefined; }));
  const later = () => { again = undefined; return run(); };
  return (fresh) => (running && fresh === true ? (again ??= running.then(later, later)) : run());
}

export function basename(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path;
}

/**
 * The global `prefers-reduced-motion` rule in `styles/index.css` shortens CSS animation and
 * transition durations, but it says nothing about a programmatic smooth scroll, which browsers do
 * not gate on the media query. The few places that would otherwise glide have to ask separately.
 */
export function scrollBehavior(): ScrollBehavior {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

/** Shortens a `/Users/<name>/…` path to `~/…`; other absolute paths are shown verbatim. */
export function tildePath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, '~');
}
