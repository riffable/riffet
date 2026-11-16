import type { Bootstrap } from './api';
import { isSessionDeleted } from './session-deletion';
import { isActiveSession, sessionActivityAt } from './session-order';
import { readStored, writeStored } from './utils';

/**
 * The last project, session and terminal lists the server sent, kept so a reload paints the
 * workbench before anything is fetched. This is the list counterpart of `transcript-store`: the
 * conversation copy answers "what did this session say", this one answers "which sessions are
 * there", and both are droppable.
 *
 * localStorage rather than IndexedDB: reading it synchronously lets the very first render already
 * have it, which an asynchronous read cannot do. What keeps it small is the copy itself: every
 * project, but only the pinned and running sessions and the newest [KEPT_SESSIONS] by activity (the
 * rest arrive with the first fetch). It is written when idle and only when its text changed, so a
 * burst of list pushes costs no storage write and never blocks input.
 */
export interface CachedLists { bootstrap: Bootstrap; savedAt: number }

const KEY = 'riffet.lists';
/** Sessions beyond the pinned and running ones that the copy keeps. */
const KEPT_SESSIONS = 300;
/** The copy was found or written, so `refreshCachedLists` may update it; sign-out clears it. */
let held = false;
let lastText = '';
let pending: { cancel: () => void } | undefined;

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
  const raw = readStored(KEY);
  const lists = parseCachedLists(raw);
  held = Boolean(lists);
  lastText = lists ? withoutSavedAt(raw) : '';
  return lists;
}

/** The part of the lists the copy keeps: all projects, the pinned and running sessions, the newest others, and their terminals. */
export function boundedLists(bootstrap: Bootstrap): Bootstrap {
  const live = bootstrap.sessions.filter((item) => !isSessionDeleted(item.id));
  if (live.length <= KEPT_SESSIONS && live.length === bootstrap.sessions.length) return bootstrap;
  const must = live.filter((item) => item.pinnedAt || isActiveSession(item));
  const rest = live.filter((item) => !item.pinnedAt && !isActiveSession(item)).sort((a, b) => Date.parse(sessionActivityAt(b)) - Date.parse(sessionActivityAt(a))).slice(0, KEPT_SESSIONS);
  const keep = new Set([...must, ...rest].map((item) => item.id));
  const sessions = live.filter((item) => keep.has(item.id));
  const terminalIds = new Set(sessions.map((item) => item.terminalId));
  return { ...bootstrap, sessions, terminals: bootstrap.terminals.filter((item) => terminalIds.has(item.id)) };
}

const withoutSavedAt = (text: string): string => text.slice(0, text.lastIndexOf(',"savedAt"'));

function write(bootstrap: Bootstrap): void {
  const text = serializeCachedLists(boundedLists(bootstrap), Date.now());
  // `savedAt` differs every time; only the lists decide whether there is anything new to store.
  const body = withoutSavedAt(text);
  if (body === lastText) return;
  lastText = body;
  writeStored(KEY, text);
  held = true;
}

/** Writes the copy when the page is idle (at the latest after a second); a newer call replaces one still waiting. */
function schedule(bootstrap: Bootstrap): void {
  pending?.cancel();
  const run = () => { pending = undefined; write(bootstrap); };
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(run, { timeout: 1_000 });
    pending = { cancel: () => window.cancelIdleCallback(id) };
  } else {
    const id = window.setTimeout(run, 50);
    pending = { cancel: () => window.clearTimeout(id) };
  }
}

export function saveCachedLists(bootstrap: Bootstrap): void {
  held = true;
  schedule(bootstrap);
}

/**
 * Brings an existing copy up to date. Only a bootstrap creates one, so a refresh scheduled before a
 * sign-out cleared the copy cannot write the lists back.
 */
export function refreshCachedLists(bootstrap: Bootstrap): void {
  if (held) schedule(bootstrap);
}

export function clearCachedLists(): void {
  pending?.cancel();
  pending = undefined;
  held = false;
  lastText = '';
  writeStored(KEY, undefined);
}
