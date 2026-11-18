import { appearanceAssetsToKeep, isShellResponse, serviceWorkerStrategy } from './lib/service-worker-strategy';

/**
 * The worker's own global. The `webworker` lib is deliberately not referenced: a lib reference is
 * program-wide, so it would switch DOM typings across the whole app. Only the members used here are
 * declared, and `Request`/`Response`/`Location` come from the DOM lib the app already has.
 */
interface InstallEvent {
  waitUntil(promise: Promise<unknown>): void;
}
interface FetchEvent {
  readonly request: Request;
  readonly preloadResponse: Promise<Response | undefined>;
  respondWith(response: Promise<Response> | Response): void;
  waitUntil(promise: Promise<unknown>): void;
}
interface MessageEventLike {
  readonly data: unknown;
  waitUntil(promise: Promise<unknown>): void;
}
interface WorkerScope {
  addEventListener(type: 'install' | 'activate', listener: (event: InstallEvent) => void): void;
  addEventListener(type: 'message', listener: (event: MessageEventLike) => void): void;
  addEventListener(type: 'fetch', listener: (event: FetchEvent) => void): void;
  skipWaiting(): Promise<void>;
  readonly location: Location;
  readonly navigator: { onLine: boolean };
  readonly registration: { navigationPreload?: NavigationPreloadManager };
  readonly clients: { claim(): Promise<void> };
}
declare const self: WorkerScope;

/**
 * Both literals are replaced by `serviceWorkerPrecache` in vite.config.ts once Rollup knows every
 * emitted file name. `CACHE_NAME` is derived from that same list, so a build whose output changed
 * gets a new cache and one whose output did not keeps the cache it already filled.
 */
const CACHE_NAME = '__RIFFET_CACHE__';
const PRECACHE_URLS = '__RIFFET_PRECACHE__' as unknown as readonly string[];
const CACHE_PREFIX = 'riffet-shell-';
/** Not a shell cache (the prefix differs), so an update leaves it: its files are named by their hash. */
const APPEARANCE_CACHE = 'riffet-appearance-v1';
const SHELL_URL = '/';
const SHELL_FALLBACK_URL = '/index.html';
/** How long a navigation waits for the network before the cached shell answers instead. */
const NAVIGATION_TIMEOUT_MS = 3_000;

function cacheableShell(response: Response): boolean {
  return isShellResponse({ ok: response.ok, type: response.type, contentType: response.headers.get('content-type'), cacheControl: response.headers.get('cache-control') });
}

/**
 * The document and the assets a reload needs. Build output under `/assets/` is named after its
 * contents, so a file the previous build already had is copied from its cache rather than fetched
 * again, and a new one may come from the HTTP cache. Everything else (the document, public files)
 * keeps its name across builds and is fetched past the HTTP cache, so it is this build's.
 */
async function precache(): Promise<void> {
  const cache = await caches.open(CACHE_NAME);
  const previous = await Promise.all((await caches.keys())
    .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
    .map((key) => caches.open(key)));
  await Promise.all(PRECACHE_URLS.map(async (url) => {
    // One missing file (an optional asset a build did not emit) must not fail the whole install:
    // whatever did arrive is still a usable offline shell.
    try {
      if (url === SHELL_URL || url === SHELL_FALLBACK_URL) {
        const response = await fetch(new Request(url, { cache: 'reload' }));
        if (cacheableShell(response)) await cache.put(url, response);
        return;
      }
      if (!url.startsWith('/assets/')) { await cache.add(new Request(url, { cache: 'reload' })); return; }
      for (const old of previous) {
        const kept = await old.match(url);
        if (kept) { await cache.put(url, kept); return; }
      }
      await cache.add(url);
    } catch { /* keep caching the rest */ }
  }));
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await self.registration.navigationPreload?.enable();
    const keys = await caches.keys();
    // An older build's cache holds an older shell. Leaving it behind would let an old document be
    // served after the new worker took over.
    await Promise.all(keys
      .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

/**
 * A page tells the worker which appearance assets its catalog still lists (after every catalog load);
 * the ones cached beyond that belong to a plugin version or plugin that is gone.
 */
self.addEventListener('message', (event) => {
  const keep = appearanceAssetsToKeep(event.data);
  if (!keep) return;
  event.waitUntil((async () => {
    const cache = await caches.open(APPEARANCE_CACHE);
    await Promise.all((await cache.keys()).filter((request) => !keep.has(new URL(request.url).pathname)).map((request) => cache.delete(request)));
  })().catch(() => undefined));
});

/** The cached shell for a navigation, keyed to the request first so an exact hit wins. */
async function shellFromCache(request: Request): Promise<Response | undefined> {
  const cache = await caches.open(CACHE_NAME);
  for (const key of [request, SHELL_URL, SHELL_FALLBACK_URL]) {
    const response = await cache.match(key);
    if (response && cacheableShell(response)) return response;
  }
  return undefined;
}

/**
 * Network first, so a reload after a deploy shows the new shell instead of the one the worker
 * happens to hold; the cache is only what keeps a flaky network usable. A network that has not
 * answered within a few seconds (a half-open connection, a server restarting behind a proxy) gets
 * the cached shell too, and its late answer still refreshes the cache.
 */
async function networkFirst(event: FetchEvent): Promise<Response> {
  const request = event.request;
  // Keep the browser's original navigation. A fetch issued by the worker can arrive
  // as Sec-Fetch-Dest: empty, which cannot attest that this is the top-level workbench.
  const network = event.preloadResponse.then(async (preloaded) => {
    const response = preloaded ?? await fetch(request);
    // Every shell path resolves to the same document, so the newest copy is stored under the shell
    // URL rather than duplicated under each deep link. Anything else (a redirect, a JSON error
    // page) is passed through without replacing it.
    if (cacheableShell(response)) {
      try {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(SHELL_URL, response.clone());
      } catch { /* Storage unavailable: the network document still answers. */ }
    }
    return response;
  });
  // Keeps the worker alive for a response that arrives after the cached shell answered.
  event.waitUntil(network.catch(() => undefined));
  const timedOut = new Promise<undefined>((resolve) => { setTimeout(resolve, NAVIGATION_TIMEOUT_MS); });
  try {
    const response = await Promise.race([network, timedOut]);
    // Timed out: the cached shell answers, unless there is none and the network is all there is.
    if (!response) return (await shellFromCache(request)) ?? await network;
    if (!response.ok) return (await shellFromCache(request)) ?? response;
    return response;
  } catch {
    return (await shellFromCache(request)) ?? Response.error();
  }
}

/** Cache first: a hashed name is proof the bytes cannot have changed. */
async function cacheFirst(request: Request, name = CACHE_NAME): Promise<Response> {
  const cache = await caches.open(name);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') await cache.put(request, response.clone());
    return response;
  } catch {
    return Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const strategy = serviceWorkerStrategy({
    url: request.url,
    method: request.method,
    mode: request.mode,
    accept: request.headers.get('accept') ?? '',
  }, self.location.origin);
  // `bypass` means the browser handles the request exactly as if no worker were installed: that is
  // what keeps API traffic, SSE streams and WebSocket upgrades out of the cache.
  if (strategy === 'bypass') return;
  if (strategy === 'network-first' && !self.registration.navigationPreload) {
    // Without preload, online navigations must go straight to the server. The installed
    // shell is still useful when the browser already knows it is offline.
    if (!self.navigator.onLine) event.respondWith(shellFromCache(request).then(cached => cached ?? fetch(request)));
    return;
  }
  event.respondWith(strategy === 'network-first' ? networkFirst(event) : cacheFirst(request, strategy === 'immutable' ? APPEARANCE_CACHE : CACHE_NAME));
});
