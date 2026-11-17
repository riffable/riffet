import { MODEL_PICKER_BUDGET, type NativeBackendCatalogEntry, type NativeBackendUsage } from '@contracts';

/**
 * What the model picker last read, kept across reloads so it paints at once while a fresh read
 * runs behind it: model catalogs per project/provider (and per conversation), and quota readings per
 * usage scope. Only usable catalogs are kept: one that failed or came back empty is something to
 * report, not to replay. A reading past `storedMaxAgeMs` is not shown.
 */
interface Stored<T> { key: string; entry: T; savedAt?: number }

function storedReadings<T>(storageKey: string, valid: (entry: unknown) => boolean) {
  let entries: Stored<T>[] | undefined;
  const load = (): Stored<T>[] => {
    if (entries) return entries;
    try {
      const parsed = JSON.parse(window.localStorage.getItem(storageKey) ?? '[]') as unknown;
      entries = Array.isArray(parsed) ? parsed.filter((item): item is Stored<T> => typeof item?.key === 'string' && valid(item?.entry)) : [];
    } catch { entries = []; }
    return entries;
  };
  const persist = (list: Stored<T>[]): void => {
    for (let kept = list; kept.length; kept = kept.slice(0, Math.floor(kept.length / 2))) {
      try { window.localStorage.setItem(storageKey, JSON.stringify(kept)); return; }
      catch { /* Over quota: retry with the newer half. */ }
    }
    try { window.localStorage.removeItem(storageKey); } catch { /* Storage may be unavailable. */ }
  };
  return {
    read(key: string, now = Date.now()): T | undefined {
      const stored = load().find((item) => item.key === key);
      return stored && typeof stored.savedAt === 'number' && now - stored.savedAt <= MODEL_PICKER_BUDGET.storedMaxAgeMs ? stored.entry : undefined;
    },
    write(key: string, entry: T, now = Date.now()): void {
      entries = [{ key, entry, savedAt: now }, ...load().filter((item) => item.key !== key)].slice(0, MODEL_PICKER_BUDGET.storedScopes);
      persist(entries);
    },
    clear(): void {
      entries = [];
      try { window.localStorage.removeItem(storageKey); } catch { /* Storage may be unavailable. */ }
    },
  };
}

const catalogs = storedReadings<NativeBackendCatalogEntry>('riffet.modelCatalogs', (entry) => Array.isArray((entry as NativeBackendCatalogEntry | undefined)?.models));
const usages = storedReadings<NativeBackendUsage>('riffet.modelUsage', (entry) => typeof entry === 'object' && entry !== null && typeof (entry as NativeBackendUsage).models === 'object');

export function cachedCatalog(key: string, now = Date.now()): NativeBackendCatalogEntry | undefined {
  return catalogs.read(key, now);
}

export function rememberCatalog(key: string, entry: NativeBackendCatalogEntry, now = Date.now()): void {
  if (!entry.available || entry.reason || !entry.models.length) return;
  catalogs.write(key, entry, now);
}

export const cachedUsage = (key: string): NativeBackendUsage | undefined => usages.read(key);
export const rememberUsage = (key: string, usage: NativeBackendUsage): void => usages.write(key, usage);
export const forgetUsage = (): void => usages.clear();
