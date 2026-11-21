/**
 * Which server a request goes to (docs/guide/multi-server.md §3.2). The entry server's own API is `/api/<rest>`;
 * a linked server's is `/api/servers/<serverId>/<rest>`, which the entry forwards through the link.
 *
 * A request about a work object goes where the object lives. The lists record which server each conversation,
 * project and terminal is on (`locate`), and ids are UUIDs, so a path that names one is routed without its caller
 * knowing which server it is on. A request that names no object (a new conversation, a server's own lists, its
 * Agents and models) says its server: `api.for(serverId)` in `api.ts`, or `serverPath(path, serverId)`.
 */

/** Object id → the linked server it lives on. The entry's own objects are absent. It keeps an object that has left
 *  a list, since a request for it (a deletion being confirmed) must still reach its server; a server's entries go
 *  when its lists are closed (`forgetServer`). */
// perf-rules: allow bounded by the objects of the linked servers' lists, released per server by forgetServer
const located = new Map<string, string>();

/** Records that these objects live on `serverId`; `undefined` is the entry server. */
export function locate(ids: Iterable<string>, serverId: string | undefined): void {
  for (const id of ids) {
    if (serverId) located.set(id, serverId);
    else located.delete(id);
  }
}

/** Drops where `serverId`'s objects are, when its lists are closed (unlinked, or no longer operable from here). */
export function forgetServer(serverId: string): void {
  for (const [id, server] of located) if (server === serverId) located.delete(id);
}

/** The linked server an object lives on, or `undefined` for the entry server (or an object no list has named). */
export function serverOfObject(id: string | undefined): string | undefined {
  return id ? located.get(id) : undefined;
}

let scoped: string | undefined;
let scopedRequests = 0;

/**
 * Runs `call` with every request it starts synchronously sent to `serverId`. Throws when `call` started none:
 * a request issued after an `await` would leave the scope and silently reach the entry server instead.
 */
export function withServer<T>(serverId: string | undefined, call: () => T): T {
  if (!serverId) return call();
  const previous = scoped, before = scopedRequests;
  scoped = serverId;
  try {
    const result = call();
    if (scopedRequests === before) throw new Error('A request routed to a linked server must be issued before its first await');
    return result;
  } finally {
    scoped = previous;
  }
}

/** The server the request being built now goes to; read by builders that finish after an `await`. */
export function currentServer(): string | undefined {
  return scoped;
}

const OBJECT_PATH = /^\/api\/(?:v3\/)?(?:sessions|projects|terminals|attempts)\/([^/?#]+)/;
const OBJECT_QUERY = ['sessionId', 'projectId'] as const;

/**
 * `path` addressed to the server it belongs to: `serverId` when given, else the scope of `withServer`, else the
 * server of the object the path names. Paths outside `/api/`, and ones already addressed, pass unchanged.
 */
export function serverPath(path: string, serverId?: string): string {
  if (!path.startsWith('/api/') || path.startsWith('/api/servers/')) return path;
  if (scoped !== undefined) scopedRequests += 1;
  const target = serverId ?? scoped ?? objectServer(path);
  return target ? `/api/servers/${encodeURIComponent(target)}/${path.slice('/api/'.length)}` : path;
}

function objectServer(path: string): string | undefined {
  const match = OBJECT_PATH.exec(path);
  if (match) return located.get(decodeURIComponent(match[1]!));
  const query = path.indexOf('?');
  if (query < 0) return undefined;
  const params = new URLSearchParams(path.slice(query + 1).split('#')[0]);
  for (const name of OBJECT_QUERY) {
    const server = located.get(params.get(name) ?? '');
    if (server) return server;
  }
  return undefined;
}
