import { useCallback, useEffect, useRef, useState } from 'react';
import type { NativeBackendId, NativeSlashCatalog } from '@contracts';
import { api } from '@/lib/api';
import { boundedCache } from '@/lib/bounded-cache';
import { registerBounded } from '@/lib/cache-registry';

/** Matches the server's own reuse window. */
const FRESH_MS = 60_000;

interface CatalogEntry { at: number; value?: NativeSlashCatalog; request?: Promise<NativeSlashCatalog> }
const catalogs = boundedCache<string, CatalogEntry>({ limit: 32 });
registerBounded('slash-catalogs', catalogs, 32);

/** Extension edits can affect shared roots used by several profiles. */
export function invalidateSlashCatalogs(): void { catalogs.clear(); }

/**
 * One request per scope at a time. `refresh` asks the server to list again rather than answer
 * from its own cache, which it would otherwise do with the very copy that went stale here.
 */
function load(key: string, backendId: NativeBackendId, scope: { projectId?: string; profileId?: string; sessionId?: string; scope?: 'global' }, refresh: boolean): Promise<NativeSlashCatalog> {
  const entry = catalogs.get(key) ?? { at: 0 };
  catalogs.set(key, entry);
  entry.request ??= api.slashCatalog(backendId, scope, { refresh })
    .then((value) => { entry.value = value; entry.at = Date.now(); return value; })
    .finally(() => { entry.request = undefined; });
  return entry.request;
}

/**
 * The `/` menu for a backend in a project or conversation. Discovery can take seconds on backends
 * that spawn their CLI to answer, so the last listing is kept per scope for the whole page; a
 * conversation opened again shows its menu at once. `refresh` re-reads a listing that has gone
 * stale and is meant for the moment the menu opens.
 */
export function useSlashCatalog(backendId: NativeBackendId | undefined, scope: { projectId?: string; profileId?: string; sessionId?: string; scope?: 'global' }): { catalog?: NativeSlashCatalog; refresh: () => void } {
  const { projectId, profileId, sessionId, scope: globalScope } = scope;
  const key = backendId && (projectId || sessionId || globalScope) ? JSON.stringify([backendId, projectId ?? '', profileId ?? '', sessionId ?? '', globalScope ?? '']) : '';
  // The listing is stored with its scope so a scope change never shows the old scope's menu for a frame.
  const [held, setHeld] = useState<{ key: string; value: NativeSlashCatalog } | undefined>(undefined);
  const catalog = !key ? undefined : held?.key === key ? held.value : catalogs.get(key)?.value;
  // A listing that lands after the scope moved on belongs to the old backend or profile.
  const currentKey = useRef(key);
  currentKey.current = key;

  const fetchIfStale = useCallback(() => {
    if (!key || !backendId) return;
    const entry = catalogs.get(key);
    if (entry?.value) setHeld({ key, value: entry.value });
    if (entry?.value && Date.now() - entry.at <= FRESH_MS) return;
    load(key, backendId, { projectId, profileId, sessionId, scope: globalScope }, Boolean(entry?.value))
      .then((value) => { if (currentKey.current === key) setHeld({ key, value }); })
      .catch(() => undefined);
  }, [key, backendId, projectId, profileId, sessionId, globalScope]);

  useEffect(() => {
    fetchIfStale();
  }, [key, fetchIfStale]);

  return { ...(catalog ? { catalog } : {}), refresh: fetchIfStale };
}
