/** Durations, sizes, counts and clock times as the trace writes them: compact, in the units an engineer reads. */

export function formatMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '';
  if (ms < 1) return '<1 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(2)} s`;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60), rest = Math.round(s - m * 60);
  if (m < 60) return rest ? `${m}m ${rest}s` : `${m}m`;
  const h = Math.floor(m / 60), mm = m - h * 60;
  return mm ? `${h}h ${mm}m` : `${h}h`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 2 : 1)}M`;
}

export const formatExact = (value: number): string => value.toLocaleString('en-US');

const pad = (value: number, size = 2) => String(value).padStart(size, '0');

/** Local wall time with milliseconds. */
export function formatClock(epoch: number): string {
  const date = new Date(epoch);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/** Local date and time, for the first moment of a turn. */
export function formatDateTime(epoch: number): string {
  const date = new Date(epoch);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${formatClock(epoch)}`;
}

/** Offset from a reference, signed: `+1.24 s`. */
export const formatOffset = (ms: number): string => `${ms < 0 ? '−' : '+'}${formatMs(Math.abs(ms))}`;
