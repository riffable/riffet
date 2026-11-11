import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { StatsGranularity, StatsTokens } from '@contracts';
import { formatNumber } from './i18n/format';

export type KpiFormat = 'tokens' | 'count' | 'days' | 'percent' | 'duration' | 'speed';

const UNAVAILABLE = '—';

export interface MetricDelta {
  kind: 'none' | 'flat' | 'ratio' | 'new';
  /** Signed change relative to the previous window. Null when it cannot be a ratio. */
  ratio: number | null;
  lowerIsBetter: boolean;
  /** Whether the change is an improvement. Null when there is nothing to judge. */
  improved: boolean | null;
}

function trimNumber(value: number, digits: number): string {
  return value.toFixed(digits).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

/** Compact token count. Null stays unavailable — it is never rendered as zero. */
export function formatTokens(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return UNAVAILABLE;
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (abs < 1000) return `${sign}${Math.round(abs)}`;
  const units = ['K', 'M', 'B'] as const;
  let scaled = abs / 1000;
  let unit = 0;
  while (scaled >= 999.5 && unit < units.length - 1) {
    scaled /= 1000;
    unit += 1;
  }
  const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${sign}${trimNumber(scaled, digits)}${units[unit]}`;
}

export function formatCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return UNAVAILABLE;
  return formatNumber(Math.round(value));
}

/** `value` is a ratio in 0–1, such as a cache hit rate. */
export function formatPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return UNAVAILABLE;
  const pct = Math.round(value * 1000) / 10;
  return `${Number.isInteger(pct) ? String(pct) : pct.toFixed(1)}%`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return UNAVAILABLE;
  const sign = ms < 0 ? '-' : '';
  const abs = Math.abs(ms);
  if (abs < 1000) return `${sign}${Math.round(abs)}ms`;
  if (abs < 60_000) return `${sign}${trimNumber(abs / 1000, abs >= 10_000 ? 1 : 2)}s`;
  const minutes = abs / 60_000;
  return `${sign}${trimNumber(minutes, minutes >= 10 ? 0 : 1)}min`;
}

export function formatSpeed(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return UNAVAILABLE;
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${trimNumber(value, digits)} token/s`;
}

export function formatMetric(value: number | null | undefined, format: KpiFormat): string {
  if (format === 'tokens') return formatTokens(value);
  if (format === 'percent') return formatPercent(value);
  if (format === 'duration') return formatDuration(value);
  if (format === 'speed') return formatSpeed(value);
  return formatCount(value);
}

export function formatRatio(ratio: number): string {
  const pct = Math.abs(ratio * 100);
  const digits = pct >= 100 ? 0 : 1;
  return `${ratio > 0 ? '+' : '-'}${trimNumber(pct, digits)}%`;
}

/**
 * Compare a metric with the previous window of equal length.
 * A missing side stays `none` so the UI can show "—" instead of inventing a change from zero.
 */
export function metricDelta(current: number | null | undefined, previous: number | null | undefined, lowerIsBetter = false): MetricDelta {
  if (current == null || previous == null || !Number.isFinite(current) || !Number.isFinite(previous)) {
    return { kind: 'none', ratio: null, lowerIsBetter, improved: null };
  }
  if (previous === 0) {
    if (current === 0) return { kind: 'flat', ratio: 0, lowerIsBetter, improved: null };
    return { kind: 'new', ratio: null, lowerIsBetter, improved: lowerIsBetter ? current < 0 : current > 0 };
  }
  const ratio = (current - previous) / Math.abs(previous);
  if (Math.abs(ratio) < 0.005) return { kind: 'flat', ratio: 0, lowerIsBetter, improved: null };
  const improved = lowerIsBetter ? ratio < 0 : ratio > 0;
  return { kind: 'ratio', ratio, lowerIsBetter, improved };
}

export function formatTimestamp(iso: string | undefined): string {
  if (!iso) return UNAVAILABLE;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return UNAVAILABLE;
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${month}/${day} ${hours}:${minutes}`;
}

function isSameDay(date: Date, other: Date): boolean {
  return date.getFullYear() === other.getFullYear() && date.getMonth() === other.getMonth() && date.getDate() === other.getDate();
}

/**
 * The `时间` column of the runs table. A whole day of rows shares one date, so the date is only
 * spelled out when it changes the answer: today keeps the clock, yesterday says so, older is dated.
 */
export function formatRowTime(iso: string | undefined, now: Date): string {
  const full = formatTimestamp(iso);
  if (full === UNAVAILABLE) return full;
  const date = new Date(iso ?? '');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  if (isSameDay(date, now)) return `${hours}:${minutes}`;
  if (isSameDay(date, new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) {
    const time = `${hours}:${minutes}`;
    return i18n._(msg`昨天 ${time}`);
  }
  return full;
}

/** The detail a row hides: the instant it started, to the second. */
export function formatExactTimestamp(iso: string | undefined): string {
  if (!iso) return UNAVAILABLE;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return UNAVAILABLE;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function formatBucket(iso: string, granularity: StatsGranularity): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  if (granularity === 'hour') return `${date.getHours()}:00`;
  if (granularity === 'month') return `${date.getFullYear()}/${date.getMonth() + 1}`;
  if (granularity === 'week') return `${date.getMonth() + 1}/${date.getDate()}`;
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

const RUN_STATE_LABELS: Record<string, MessageDescriptor> = {
  queued: msg({ message: '排队', context: 'common-status-queued' }),
  running: msg({ message: '进行中', context: 'common-status-running' }),
  completed: msg({ message: '完成', context: 'common-status-completed' }),
  failed: msg`失败`,
  cancelled: msg({ message: '取消', context: 'run-state' }),
  interrupted: msg({ message: '中断', context: 'common-status-interrupted' }),
};

/** Translated where a row renders, so the reader's current language wins over the stored state. */
export function runStateLabel(state: string): string {
  const label = RUN_STATE_LABELS[state];
  return label ? i18n._(label) : state;
}

/** A token total is unavailable only when nothing was reported. An explicit zero stays zero. */
export function tokensDisplay(tokens: StatsTokens | undefined, total: number | null | undefined): { text: string; estimated: boolean; unavailable: boolean } {
  if (!tokens) return { text: UNAVAILABLE, estimated: false, unavailable: true };
  const measured = [tokens.input, tokens.cacheRead, tokens.cacheWrite, tokens.output, tokens.reasoning];
  const estimated = tokens.estimatedOutput > 0;
  const any = measured.some((value) => value != null) || estimated || (typeof total === 'number' && total > 0);
  if (!any) return { text: UNAVAILABLE, estimated: false, unavailable: true };
  return { text: formatTokens(total ?? null), estimated, unavailable: false };
}
