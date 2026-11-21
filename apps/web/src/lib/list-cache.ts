import { WORK_ITEM_STATUSES, type WorkItemSummary } from '@contracts';
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
/** A linked server's lists are kept under `riffet.lists.<serverId>` (docs/SERVER-LINKS.md §5). */
const LINKED_PREFIX = `${KEY}.`;
/** Sessions beyond the pinned and running ones that the copy keeps. */
const KEPT_SESSIONS = 300;

/**
 * Rebuilds the cached lists, or nothing when the stored value is not a list cache. A value written
 * by an older build may not have the shape this one expects, and a cache is never worth a crash on
 * startup, so every field is checked before it is used.
 */
export function parseCachedLists(raw: string): CachedLists | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { bootstrap?: Partial<Bootstrap>; savedAt?: unknown };
    const { projects, sessions, terminals, settings, protocol, owner, workItemSummaries, serverId, servers } = parsed?.bootstrap ?? {};
    if (!Array.isArray(projects) || !Array.isArray(sessions) || !Array.isArray(terminals)) return undefined;
    if (!settings || typeof settings !== 'object') return undefined;
    const validSummaries = Array.isArray(workItemSummaries)
      ? workItemSummaries.filter((item): item is WorkItemSummary =>
        Boolean(item) && typeof item === 'object' && typeof item.id === 'string' && typeof item.number === 'number' && WORK_ITEM_STATUSES.includes(item.status))
      : undefined;
    return {
      bootstrap: {
        projects, sessions, terminals, settings, csrfToken: '',
        ...(owner && typeof owner === 'object' && typeof owner.revision === 'number' ? { owner } : {}),
        ...(protocol && Array.isArray(protocol.features) ? { protocol } : {}),
        ...(validSummaries ? { workItemSummaries: validSummaries } : {}),
        // The linked servers, so their cached lists are painted before the bootstrap answers.
        ...(typeof serverId === 'string' ? { serverId } : {}),
        ...(Array.isArray(servers) ? { servers: servers.filter((item) => Boolean(item) && typeof item.id === 'string' && typeof item.name === 'string') } : {}),
      },
      savedAt: typeof parsed?.savedAt === 'number' && Number.isFinite(parsed.savedAt) ? parsed.savedAt : 0,
    };
  } catch { return undefined; }
}

/** The CSRF token is a live credential tied to this session, so it is never written to disk. */
export function serializeCachedLists(bootstrap: Bootstrap, savedAt: number): string {
  const { csrfToken: _csrfToken, ...rest } = bootstrap;
  return JSON.stringify({ bootstrap: rest, savedAt });
}

/** The part of the lists the copy keeps: all projects, the pinned and running sessions, the newest others, their terminals, and open or session-linked work item summaries. */
export function boundedLists(bootstrap: Bootstrap): Bootstrap {
  const live = bootstrap.sessions.filter((item) => !isSessionDeleted(item.id));
  const keepSessions = live.length <= KEPT_SESSIONS && live.length === bootstrap.sessions.length
    ? live
    : (() => {
        const must = live.filter((item) => item.pinnedAt || isActiveSession(item));
        const rest = live.filter((item) => !item.pinnedAt && !isActiveSession(item)).sort((a, b) => Date.parse(sessionActivityAt(b)) - Date.parse(sessionActivityAt(a))).slice(0, KEPT_SESSIONS);
        const keep = new Set([...must, ...rest].map((item) => item.id));
        return live.filter((item) => keep.has(item.id));
      })();
  const terminalIds = new Set(keepSessions.map((item) => item.terminalId));
  const sessionWorkItemIds = new Set(keepSessions.map((item) => item.workItemId).filter((id): id is string => Boolean(id)));
  const workItemSummaries = bootstrap.workItemSummaries?.filter(
    (item) => (item.status !== 'done' && item.status !== 'cancelled') || sessionWorkItemIds.has(item.id),
  );
  return {
    ...bootstrap,
    sessions: keepSessions,
    terminals: bootstrap.terminals.filter((item) => terminalIds.has(item.id)),
    ...(workItemSummaries !== undefined ? { workItemSummaries } : {}),
  };
}

const withoutSavedAt = (text: string): string => text.slice(0, text.lastIndexOf(',"savedAt"'));

export interface ListCache {
  load(): CachedLists | undefined;
  save(bootstrap: Bootstrap): void;
  /**
   * Brings an existing copy up to date. Only a bootstrap creates one, so a refresh scheduled before a
   * sign-out cleared the copy cannot write the lists back.
   */
  refresh(bootstrap: Bootstrap): void;
  clear(): void;
  /** Stops writing for good: the store holding it is gone. A write already scheduled is dropped. */
  retire(): void;
}

/** Counts sign-outs; a linked server's handle made before one writes nothing after it. */
let signOuts = 0;

function createListCache(key: string, linked = false): ListCache {
  /** The copy was found or written, so `refresh` may update it; sign-out clears it. */
  let held = false;
  let lastText = '';
  let pending: { cancel: () => void } | undefined;
  let retired = false;
  const born = signOuts;
  /** The servers named by the last bootstrap; a refresh carries only lists, and must not drop them. */
  let links: Pick<Bootstrap, 'serverId' | 'servers'> = {};
  const linksOf = (bootstrap: Bootstrap): Pick<Bootstrap, 'serverId' | 'servers'> => ({
    ...(bootstrap.serverId ? { serverId: bootstrap.serverId } : {}),
    ...(bootstrap.servers ? { servers: bootstrap.servers } : {}),
  });
  const write = (bootstrap: Bootstrap): void => {
    if (retired || (linked && born !== signOuts)) return;
    const text = serializeCachedLists(boundedLists(bootstrap), Date.now());
    // `savedAt` differs every time; only the lists decide whether there is anything new to store.
    const body = withoutSavedAt(text);
    if (body === lastText) return;
    lastText = body;
    writeStored(key, text);
    held = true;
  };
  /** Writes the copy when the page is idle (at the latest after a second); a newer call replaces one still waiting. */
  const schedule = (bootstrap: Bootstrap): void => {
    pending?.cancel();
    const run = () => { pending = undefined; write(bootstrap); };
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(run, { timeout: 1_000 });
      pending = { cancel: () => window.cancelIdleCallback(id) };
    } else {
      const id = window.setTimeout(run, 50);
      pending = { cancel: () => window.clearTimeout(id) };
    }
  };
  return {
    load() {
      const raw = readStored(key);
      const lists = parseCachedLists(raw);
      held = Boolean(lists);
      lastText = lists ? withoutSavedAt(raw) : '';
      links = lists ? linksOf(lists.bootstrap) : {};
      return lists;
    },
    save(bootstrap) { if (retired) return; held = true; links = linksOf(bootstrap); schedule(bootstrap); },
    refresh(bootstrap) { if (held && !retired) schedule({ ...links, ...bootstrap }); },
    clear() {
      pending?.cancel();
      pending = undefined;
      held = false;
      lastText = '';
      writeStored(key, undefined);
    },
    retire() {
      retired = true;
      pending?.cancel();
      pending = undefined;
    },
  };
}

/** The entry server's own lists. */
export const entryListCache = createListCache(KEY);
/** A linked server's lists: a new handle on its kept copy, held by that server's lists store for as long as it lives. */
export function linkedListCache(serverId: string): ListCache {
  return createListCache(LINKED_PREFIX + serverId, true);
}

export const loadCachedLists = (): CachedLists | undefined => entryListCache.load();
export const saveCachedLists = (bootstrap: Bootstrap): void => entryListCache.save(bootstrap);
export const refreshCachedLists = (bootstrap: Bootstrap): void => entryListCache.refresh(bootstrap);

/** Sign-out: every server's copy goes, including those of servers this page has not opened yet. */
export function clearCachedLists(): void {
  signOuts += 1;
  entryListCache.clear();
  try {
    for (const key of Object.keys(window.localStorage)) if (key.startsWith(LINKED_PREFIX)) window.localStorage.removeItem(key);
  } catch { /* storage unavailable */ }
}
