import type { StatsDashboard } from '@contracts';

/**
 * The last dashboard the page painted, so a refetch or a reload can draw it before the next
 * response. Same contract as the list cache: a value this build does not recognise is dropped,
 * never allowed to crash the first paint.
 */
export interface CachedStats { key: string; savedAt: number; dashboard: StatsDashboard }

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
    const parsed = JSON.parse(raw) as { key?: unknown; savedAt?: unknown; dashboard?: unknown };
    if (typeof parsed?.key !== 'string' || !isDashboard(parsed.dashboard)) return undefined;
    return {
      key: parsed.key,
      savedAt: typeof parsed.savedAt === 'number' && Number.isFinite(parsed.savedAt) ? parsed.savedAt : 0,
      dashboard: parsed.dashboard,
    };
  } catch {
    return undefined;
  }
}

export function serializeStatsCache(key: string, dashboard: StatsDashboard, savedAt: number): string {
  return JSON.stringify({ key, savedAt, dashboard });
}

export function loadStatsCache(): CachedStats | undefined {
  try {
    if (typeof sessionStorage === 'undefined') return undefined;
    return parseStatsCache(sessionStorage.getItem(KEY) ?? '');
  } catch {
    return undefined;
  }
}

export function saveStatsCache(key: string, dashboard: StatsDashboard): void {
  try {
    if (typeof sessionStorage === 'undefined') return;
    sessionStorage.setItem(KEY, serializeStatsCache(key, dashboard, Date.now()));
  } catch {
    // A full or disabled sessionStorage is not a reason to drop the page.
  }
}
