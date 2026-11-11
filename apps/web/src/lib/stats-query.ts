import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { isNativeBackendId, type NativeBackendId, type StatsGranularity, type StatsSeriesMetric, type StatsSplit } from '@contracts';
import { formatDate } from './i18n/format';

export const STATS_QUERY_KEYS = ['view', 'range', 'from', 'to', 'backend', 'model', 'project', 'estimated', 'metric', 'split', 'rank', 'latency'] as const;

export type StatsRangePreset = 'today' | '7d' | '30d' | '90d' | '1y' | 'all' | 'custom';
export type RankMetric = 'tokens' | 'runs' | 'speed';
export type LatencyMetric = 'ttft' | 'duration' | 'speed';

export interface StatsUiState {
  preset: StatsRangePreset;
  /** Inclusive start. A calendar day (`YYYY-MM-DD`) or an ISO instant from the brush. */
  from?: string;
  /**
   * Inclusive end for a calendar day, exclusive instant for a brush selection.
   * The API `to` is always exclusive; day values gain one day at request time.
   */
  to?: string;
  backends: NativeBackendId[];
  models: string[];
  projects: string[];
  includeEstimated: boolean;
  metric: StatsSeriesMetric;
  split: StatsSplit;
  rank: RankMetric;
  latency: LatencyMetric;
}

const PRESETS = new Set<StatsRangePreset>(['today', '7d', '30d', '90d', '1y', 'all', 'custom']);
const METRICS = new Set<StatsSeriesMetric>(['totalTokens', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'runs', 'sessions', 'durationMs']);
const SPLITS = new Set<StatsSplit>(['backend', 'model', 'project']);
const RANKS = new Set<RankMetric>(['tokens', 'runs', 'speed']);
const LATENCIES = new Set<LatencyMetric>(['ttft', 'duration', 'speed']);

/** A missing `from` on the server means the last 30 days, so "全部" still sends an explicit start. */
const ALL_FROM = new Date(2018, 0, 1);

const WINDOW_LABELS: Partial<Record<StatsRangePreset, MessageDescriptor>> = {
  today: msg`今天`,
  '7d': msg`近 7 天`,
  '30d': msg`近 30 天`,
  '90d': msg`近 90 天`,
  '1y': msg`近一年`,
  all: msg`全部时间`,
};

export function defaultStatsUi(): StatsUiState {
  return {
    preset: '30d',
    backends: [],
    models: [],
    projects: [],
    includeEstimated: true,
    metric: 'totalTokens',
    split: 'backend',
    rank: 'tokens',
    latency: 'ttft',
  };
}

export function clientTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function readStatsSearch(search: string): { open: boolean; state: StatsUiState } {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const state = defaultStatsUi();
  const range = params.get('range');
  if (range && PRESETS.has(range as StatsRangePreset)) state.preset = range as StatsRangePreset;
  const from = params.get('from') ?? undefined;
  const to = params.get('to') ?? undefined;
  if (from) state.from = from;
  if (to) state.to = to;
  if ((from || to) && !range) state.preset = 'custom';
  state.backends = params.getAll('backend').filter(isNativeBackendId);
  state.models = params.getAll('model').filter(Boolean);
  state.projects = params.getAll('project').filter(Boolean);
  if (params.get('estimated') === '0') state.includeEstimated = false;
  const metric = params.get('metric');
  if (metric && METRICS.has(metric as StatsSeriesMetric)) state.metric = metric as StatsSeriesMetric;
  const split = params.get('split');
  if (split && SPLITS.has(split as StatsSplit)) state.split = split as StatsSplit;
  const rank = params.get('rank');
  if (rank && RANKS.has(rank as RankMetric)) state.rank = rank as RankMetric;
  const latency = params.get('latency');
  if (latency && LATENCIES.has(latency as LatencyMetric)) state.latency = latency as LatencyMetric;
  return { open: params.get('view') === 'stats', state };
}

/** Rewrite the stats keys and leave every other query parameter where it was. */
export function writeStatsSearch(current: string, open: boolean, state: StatsUiState): string {
  const params = new URLSearchParams(current.startsWith('?') ? current.slice(1) : current);
  for (const key of STATS_QUERY_KEYS) params.delete(key);
  if (!open) {
    const rest = params.toString();
    return rest ? `?${rest}` : '';
  }
  params.set('view', 'stats');
  if (state.preset !== '30d') params.set('range', state.preset);
  if (state.preset === 'custom') {
    if (state.from) params.set('from', state.from);
    if (state.to) params.set('to', state.to);
  }
  for (const id of state.backends) params.append('backend', id);
  for (const id of state.models) params.append('model', id);
  for (const id of state.projects) params.append('project', id);
  if (!state.includeEstimated) params.set('estimated', '0');
  if (state.metric !== 'totalTokens') params.set('metric', state.metric);
  if (state.split !== 'backend') params.set('split', state.split);
  if (state.rank !== 'tokens') params.set('rank', state.rank);
  if (state.latency !== 'ttft') params.set('latency', state.latency);
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function toInstant(value: string, exclusiveEnd: boolean): string {
  if (value.includes('T')) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toISOString();
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return (exclusiveEnd ? addDays(date, 1) : date).toISOString();
}

export function resolveWindow(state: StatsUiState, now: Date): { from: string; to: string } {
  if (state.preset === 'custom' && state.from && state.to) {
    return { from: toInstant(state.from, false), to: toInstant(state.to, !state.to.includes('T')) };
  }
  const to = addDays(startOfDay(now), 1).toISOString();
  if (state.preset === 'today') return { from: startOfDay(now).toISOString(), to };
  if (state.preset === '7d') return { from: addDays(startOfDay(now), -6).toISOString(), to };
  if (state.preset === '90d') return { from: addDays(startOfDay(now), -89).toISOString(), to };
  if (state.preset === '1y') return { from: addDays(startOfDay(now), -364).toISOString(), to };
  if (state.preset === 'all') return { from: ALL_FROM.toISOString(), to };
  return { from: addDays(startOfDay(now), -29).toISOString(), to };
}

export function granularityFor(state: StatsUiState, now: Date): StatsGranularity {
  if (state.preset === 'today') return 'hour';
  if (state.preset === '7d' || state.preset === '30d') return 'day';
  if (state.preset === '90d') return 'week';
  if (state.preset === '1y' || state.preset === 'all') return 'month';
  const window = resolveWindow(state, now);
  const span = new Date(window.to).getTime() - new Date(window.from).getTime();
  const day = 86_400_000;
  if (!Number.isFinite(span) || span <= 2 * day) return 'hour';
  if (span <= 62 * day) return 'day';
  if (span <= 200 * day) return 'week';
  return 'month';
}

const shortDate = (value: string | number) => formatDate(value, { month: 'numeric', day: 'numeric' });

/** A period said in one breath: presets by name, anything else by its two ends. */
export function windowLabel(state: StatsUiState, now: Date): string {
  const named = WINDOW_LABELS[state.preset];
  if (named) return i18n._(named);
  if (state.preset !== 'custom') return '';
  const window = resolveWindow(state, now);
  // The API end is exclusive, but the reader picked an inclusive day: name the day they asked for.
  const end = state.to && !state.to.includes('T') ? state.to : window.to;
  const from = state.from ?? window.from;
  return `${shortDate(from)}–${shortDate(end)}`;
}

/** The equal-length period the KPI deltas are measured against: the window shifted back one span. */
export function previousWindowLabel(state: StatsUiState, now: Date): string {
  // "All time" has nothing before it; an equal-length window would reach into years with no data.
  if (state.preset === 'all') return '';
  const window = resolveWindow(state, now);
  const from = new Date(window.from).getTime();
  const to = new Date(window.to).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return '';
  const span = to - from;
  // The previous window also ends exclusively, so its label ends where the current one starts.
  return `${shortDate(from - span)}–${shortDate(from)}`;
}

export function statsFilterParams(state: StatsUiState, now: Date, tz: string): URLSearchParams {
  const params = new URLSearchParams();
  const window = resolveWindow(state, now);
  params.set('from', window.from);
  params.set('to', window.to);
  params.set('tz', tz);
  for (const id of state.backends) params.append('backend', id);
  for (const id of state.models) params.append('model', id);
  for (const id of state.projects) params.append('project', id);
  if (!state.includeEstimated) params.set('includeEstimated', 'false');
  return params;
}

/** Identity of the filter, ignoring chart-local switches that do not change the dashboard query. */
export function statsFilterKey(state: StatsUiState): string {
  return JSON.stringify({
    preset: state.preset,
    from: state.from ?? '',
    to: state.to ?? '',
    backends: state.backends,
    models: state.models,
    projects: state.projects,
    includeEstimated: state.includeEstimated,
  });
}

export function dateInputValue(value: string | undefined): string {
  if (!value) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export interface RefreshThrottle {
  push: (run: () => void) => void;
  cancel: () => void;
}

/**
 * Leading-edge throttle with one trailing call. The first `stats_changed` paints immediately;
 * anything inside `waitMs` collapses into a single follow-up, so a burst never refetches sooner
 * than the interval.
 */
export function createRefreshThrottle(
  waitMs: number,
  schedule: (fn: () => void, ms: number) => number = (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clear: (id: number) => void = (id) => clearTimeout(id),
  now: () => number = () => Date.now(),
): RefreshThrottle {
  let last = Number.NEGATIVE_INFINITY;
  let timer: number | undefined;
  return {
    push(run) {
      const elapsed = now() - last;
      if (last !== Number.NEGATIVE_INFINITY && elapsed < waitMs) {
        if (timer !== undefined) return;
        timer = schedule(() => {
          timer = undefined;
          last = now();
          run();
        }, waitMs - elapsed);
        return;
      }
      last = now();
      run();
    },
    cancel() {
      if (timer !== undefined) clear(timer);
      timer = undefined;
    },
  };
}
