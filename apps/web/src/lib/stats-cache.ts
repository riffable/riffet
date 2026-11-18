import type { StatsDashboard, StatsLatency } from '@contracts';

/**
 * The last dashboard the page painted, so a refetch or a reload can draw it before the next
 * response. Same contract as the list cache: a value this build does not recognise is dropped,
 * never allowed to crash the first paint.
 */
export interface CachedStats { key: string; savedAt: number; dashboard: StatsDashboard; latency?: StatsLatency }

const KEY = 'riffet.stats';

function isDashboard(value: unknown): value is StatsDashboard {
  if (!value || typeof value !== 'object') return false;
  const dashboard = value as StatsDashboard;
  return Boolean(
    dashboard.summary?.current?.tokens
    && dashboard.summary.previous?.tokens
    && dashboard.summary.current.states
    && dashboard.series?.points
    && Array.isArray(dashboard.series.points)
    && Array.isArray(dashboard.series.keys)
    && dashboard.backends?.rows
    && dashboard.models?.rows
    && dashboard.tools?.rows
    && Array.isArray(dashboard.heatmap?.weekHour)
    && Array.isArray(dashboard.heatmap?.calendar)
    && dashboard.options,
  );
}

export function parseStatsCache(raw: string): CachedStats | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { key?: unknown; savedAt?: unknown; dashboard?: unknown; latency?: unknown };
    if (typeof parsed?.key !== 'string' || !isDashboard(parsed.dashboard)) return undefined;
    const latency = parsed.latency && typeof parsed.latency === 'object' && Array.isArray((parsed.latency as StatsLatency).rows)
      ? parsed.latency as StatsLatency
      : undefined;
    return {
      key: parsed.key,
      savedAt: typeof parsed.savedAt === 'number' && Number.isFinite(parsed.savedAt) ? parsed.savedAt : 0,
      dashboard: parsed.dashboard,
      ...(latency ? { latency } : {}),
    };
  } catch {
    return undefined;
  }
}

export function serializeStatsCache(key: string, dashboard: StatsDashboard, savedAt: number, latency?: StatsLatency): string {
  return JSON.stringify({ key, savedAt, dashboard, ...(latency ? { latency } : {}) });
}

export function loadStatsCache(): CachedStats | undefined {
  try {
    if (typeof sessionStorage === 'undefined') return undefined;
    return parseStatsCache(sessionStorage.getItem(KEY) ?? '');
  } catch {
    return undefined;
  }
}

export function saveStatsCache(key: string, dashboard: StatsDashboard, latency?: StatsLatency): void {
  try {
    if (typeof sessionStorage === 'undefined') return;
    const current = loadStatsCache();
    sessionStorage.setItem(KEY, serializeStatsCache(key, dashboard, Date.now(), latency ?? (current?.key === key ? current.latency : undefined)));
  } catch {
    // A full or disabled sessionStorage is not a reason to drop the page.
  }
}
