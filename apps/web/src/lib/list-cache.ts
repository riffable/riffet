import type { Bootstrap } from './api';
import { isSessionDeleted } from './session-deletion';
import { readStored, writeStored } from './utils';

/**
 * The last project, session and terminal lists the server sent, kept so a reload paints the
 * workbench before anything is fetched. This is the list counterpart of `transcript-store`: the
 * conversation copy answers "what did this session say", this one answers "which sessions are
 * there", and both are droppable.
 *
 * localStorage rather than IndexedDB: a list is metadata, orders of magnitude smaller than a
 * transcript, and reading it synchronously lets the very first render already have it.
 */
export interface CachedLists { bootstrap: Bootstrap; savedAt: number }

const KEY = 'riffet.lists';

/**
 * Rebuilds the cached lists, or nothing when the stored value is not a list cache. A value written
 * by an older build may not have the shape this one expects, and a cache is never worth a crash on
 * startup, so every field is checked before it is used.
 */
export function parseCachedLists(raw: string): CachedLists | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { bootstrap?: Partial<Bootstrap>; savedAt?: unknown };
    const { projects, sessions, terminals, settings, protocol, owner } = parsed?.bootstrap ?? {};
    if (!Array.isArray(projects) || !Array.isArray(sessions) || !Array.isArray(terminals)) return undefined;
    if (!settings || typeof settings !== 'object') return undefined;
    return {
      bootstrap: { projects, sessions, terminals, settings, csrfToken: '', ...(owner && typeof owner === 'object' && typeof owner.revision === 'number' ? { owner } : {}), ...(protocol && Array.isArray(protocol.features) ? { protocol } : {}) },
      savedAt: typeof parsed?.savedAt === 'number' && Number.isFinite(parsed.savedAt) ? parsed.savedAt : 0,
    };
  } catch { return undefined; }
}

/** The CSRF token is a live credential tied to this session, so it is never written to disk. */
export function serializeCachedLists(bootstrap: Bootstrap, savedAt: number): string {
  const { csrfToken: _csrfToken, ...rest } = bootstrap;
  return JSON.stringify({ bootstrap: rest, savedAt });
}

export function loadCachedLists(): CachedLists | undefined {
  return parseCachedLists(readStored(KEY));
}

export function saveCachedLists(bootstrap: Bootstrap): void {
  const sessions = bootstrap.sessions.filter((item) => !isSessionDeleted(item.id));
  writeStored(KEY, serializeCachedLists(sessions.length === bootstrap.sessions.length ? bootstrap : { ...bootstrap, sessions }, Date.now()));
}

/**
 * Brings an existing copy up to date. Only a bootstrap creates one, so a refresh scheduled before a
 * sign-out cleared the copy cannot write the lists back.
 */
export function refreshCachedLists(bootstrap: Bootstrap): void {
  if (readStored(KEY)) saveCachedLists(bootstrap);
}

export function clearCachedLists(): void {
  writeStored(KEY, undefined);
}
