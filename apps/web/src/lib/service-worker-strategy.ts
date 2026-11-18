/**
 * The routing decision the service worker makes for one request.
 *
 * It lives here, away from the worker, so it can be unit-tested: this repo's node test environment
 * has no `self`, `caches` or `fetch`, and a test that reached for them would not run at all. The
 * worker therefore passes in the few fields this reads instead of a live `Request`.
 */
export type ServiceWorkerStrategy = 'network-first' | 'cache-first' | 'immutable' | 'bypass';

/** The slice of a `Request` this decision needs, named as the request names it. */
export interface ServiceWorkerRequest {
  url: string;
  method: string;
  /** `Request.mode`: `navigate` for a document, `websocket` for an upgrade. */
  mode?: string;
  /** `Request.headers.get('accept')`: an `EventSource` announces itself here. */
  accept?: string;
}

/**
 * Content-hashed build output and the small static shell files that are precached alongside it.
 * Both are safe to answer from cache because the cache itself is named after the build: a changed
 * file arrives with a new worker and a new cache, never as a stale hit.
 */
const CACHE_FIRST_PREFIXES = ['/assets/', '/icons/'] as const;
const CACHE_FIRST_PATHS = new Set(['/manifest.json', '/favicon.svg', '/theme-init.js']);
/**
 * Server pages that are not the app shell. A navigation to one is left to the browser: answering it
 * with the shell offline would show the wrong page, and storing it would replace the shell.
 */
const NON_SHELL_PATHS = new Set(['/math', '/mermaid', '/diagram', '/content-preview', '/health']);
const NON_SHELL_PREFIXES = ['/katex/'] as const;
/**
 * Plugin appearance files (fonts, images, palettes) are the one thing under `/api` that may be kept:
 * the content hash is in the path, so a stored answer cannot be stale. They outlive a build's shell.
 */
const IMMUTABLE_PREFIX = '/api/appearance/assets/';

/**
 * Whether a navigation response may be stored as the offline shell: only a successful same-origin
 * HTML document, since every shell navigation is answered with the same index.html.
 */
export function isShellResponse(response: { ok: boolean; type?: string; contentType?: string | null; cacheControl?: string | null }): boolean {
  if (!response.ok || (response.type !== undefined && response.type !== 'basic')) return false;
  if (response.cacheControl?.split(',').some((directive) => directive.trim().toLowerCase() === 'no-store')) return false;
  return (response.contentType ?? '').toLowerCase().includes('text/html');
}

export function serviceWorkerStrategy(request: ServiceWorkerRequest, origin?: string): ServiceWorkerStrategy {
  // The worker only owns reads. A POST is a command, and a range read or an upload has to reach the
  // server whole, so anything but GET/HEAD is left to the browser.
  if (request.method.toUpperCase() !== 'GET' && request.method.toUpperCase() !== 'HEAD') return 'bypass';
  // A WebSocket upgrade is a long-lived connection, not a response to store.
  if (request.mode === 'websocket') return 'bypass';
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return 'bypass';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'bypass';
  if (origin !== undefined && url.origin !== origin) return 'bypass';
  if (url.pathname.startsWith(IMMUTABLE_PREFIX)) return 'immutable';
  // Live server state: JSON, snapshots and every SSE stream (`/api/sessions/:id/native/stream`) live
  // under `/api`. Caching any of it would replay a transcript the server has already moved past.
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return 'bypass';
  // An event stream never ends and must not be stored, whichever path serves it.
  if (request.accept?.includes('text/event-stream')) return 'bypass';
  if (NON_SHELL_PATHS.has(url.pathname) || NON_SHELL_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return 'bypass';
  // A new build is never masked by an old document: the newest HTML wins, and the cached shell is
  // only the fallback for a flaky or absent network.
  if (request.mode === 'navigate') return 'network-first';
  if (CACHE_FIRST_PATHS.has(url.pathname)) return 'cache-first';
  if (CACHE_FIRST_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return 'cache-first';
  // No policy means no interception, so a path added later is fetched rather than silently cached.
  return 'bypass';
}

/** The message a page posts to the worker with the appearance asset addresses its catalog holds now. */
export const APPEARANCE_PRUNE_MESSAGE = 'riffet-appearance-assets';

/**
 * The paths the appearance cache keeps for a prune message, or `undefined` for anything else (a
 * malformed message must never empty the cache). Only content-addressed asset paths count.
 */
export function appearanceAssetsToKeep(data: unknown): Set<string> | undefined {
  const message = data as { type?: unknown; urls?: unknown } | null;
  if (!message || message.type !== APPEARANCE_PRUNE_MESSAGE || !Array.isArray(message.urls) || message.urls.some((url) => typeof url !== 'string')) return undefined;
  const keep = new Set<string>();
  for (const url of message.urls as string[]) {
    try { const { pathname } = new URL(url, 'http://riffet.invalid'); if (pathname.startsWith(IMMUTABLE_PREFIX)) keep.add(pathname); } catch { /* not an address */ }
  }
  return keep;
}
