/**
 * Every in-memory cache the page keeps, by name (docs/guide/performance.md §3.1). `cacheSnapshot`
 * feeds the metrics report; `clearCaches` answers memory pressure and signing out. A cache stays
 * correct after `clear`: it only costs a read the next time.
 */
export interface CacheInfo { name: string; size: number; limit?: number; weight?: number; maxWeight?: number }
interface Registered { size: () => number; weight?: () => number; limit?: number; maxWeight?: number; clear: () => void }

// perf-rules: allow one entry per cache, registered at module load
const registry = new Map<string, Registered>();

/** Registers a cache once, at module load; a second registration under the same name replaces the first. */
export function registerCache(name: string, cache: Registered): void { registry.set(name, cache); }

/** Registers a `boundedCache` (or anything shaped like one). */
export function registerBounded(name: string, cache: { size: number; weight: number; clear: () => void }, limit: number, maxWeight?: number): void {
  registerCache(name, { size: () => cache.size, weight: maxWeight ? () => cache.weight : undefined, limit, maxWeight, clear: () => cache.clear() });
}

export function cacheSnapshot(): CacheInfo[] {
  return [...registry].map(([name, cache]) => ({ name, size: cache.size(), ...(cache.limit ? { limit: cache.limit } : {}), ...(cache.weight ? { weight: cache.weight() } : {}), ...(cache.maxWeight ? { maxWeight: cache.maxWeight } : {}) }));
}

export function clearCaches(): void { for (const cache of registry.values()) cache.clear(); }
