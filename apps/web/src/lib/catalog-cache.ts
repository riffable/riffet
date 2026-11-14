import type { NativeBackendCatalogEntry } from '@contracts';

/**
 * The last good model catalog per project/provider (and per conversation), kept across reloads so
 * the picker is usable at once while a fresh catalog loads behind it. Only usable catalogs are
 * kept: one that failed or came back empty is something to report, not to replay.
 */
const STORAGE_KEY = 'riffet.modelCatalogs';
// Room for every agent's providers, which the new-session model menu lists, beside recent conversations'.
const MAX_ENTRIES = 32;
/** A stored catalog older than this is only a stale hint; the next open reads it fresh. */
export const CATALOG_CACHE_TTL_MS = 5 * 60_000;

interface Stored { key: string; entry: NativeBackendCatalogEntry; savedAt?: number }

let entries: Stored[] | undefined;

function load(): Stored[] {
  if (entries) return entries;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]') as unknown;
    entries = Array.isArray(parsed)
      ? parsed.filter((item): item is Stored => typeof item?.key === 'string' && Array.isArray(item?.entry?.models))
      : [];
  } catch { entries = []; }
  return entries;
}

function persist(list: Stored[]): void {
  for (let kept = list; kept.length; kept = kept.slice(0, Math.floor(kept.length / 2))) {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(kept)); return; }
    catch { /* Over quota: retry with the newer half. */ }
  }
  try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* Storage may be unavailable. */ }
}

export function cachedCatalog(key: string, now = Date.now()): NativeBackendCatalogEntry | undefined {
  const stored = load().find((item) => item.key === key);
  return stored && typeof stored.savedAt === 'number' && now - stored.savedAt <= CATALOG_CACHE_TTL_MS ? stored.entry : undefined;
}

export function rememberCatalog(key: string, entry: NativeBackendCatalogEntry, now = Date.now()): void {
  if (!entry.available || entry.reason || !entry.models.length) return;
  entries = [{ key, entry, savedAt: now }, ...load().filter((item) => item.key !== key)].slice(0, MAX_ENTRIES);
  persist(entries);
}
