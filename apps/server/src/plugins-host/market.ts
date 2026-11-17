import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PLUGIN_MARKET_BUDGET } from '../../../../packages/contracts/src/budgets.js';
import type { PluginMarketEntry, PluginMarketOffer, PluginSource } from '../../../../packages/contracts/src/index.js';
import { PLUGIN_SOURCE_BUILTIN } from '../../../../packages/contracts/src/plugin-packages.js';
import { PLUGIN_ID } from '../../../../packages/contracts/src/plugins.js';
import { satisfies } from '../../../../packages/contracts/src/semver.js';
import { AppError } from '../errors.js';
import { grantExecutables, grantModelSources } from '../plugins/declarations.js';
import { serverIncompatibility } from './compat.js';
import { MAX_ARCHIVE_BYTES } from './archive.js';
import { isLoopbackOrUnspecified } from './addresses.js';

// A plugin index (the public one is site/plugins, built by scripts/build-site.ts; anyone can build one
// with `riffet plugin index build`): which versions of a package exist, where each archive is and the
// integrity of its content. A server reads the built-in index and the sources added in plugins.json
// (docs/PLUGINS.md「插件市场」). Installing from one downloads
// the archive and then takes the same path as an upload; the package store refuses content whose
// integrity differs from the index's, so the index vouches for exactly the files it was built from.

export const DEFAULT_PLUGIN_INDEX = 'https://riffable.github.io/riffet/plugins/index.json';

/** The index this server and the CLI read: `RIFFET_PLUGIN_INDEX` (an https, loopback http or file URL), or the public one. */
export const pluginIndexUrl = () => process.env.RIFFET_PLUGIN_INDEX?.trim() || DEFAULT_PLUGIN_INDEX;

/** `source` is a source id; left out, the pinned source of an installed package, or the only enabled source listing the id. */
export interface MarketReference { id: string; version?: string; source?: string }

/** A source as plugins.json keeps it (`PluginStore.sources`): the built-in one is implicit and only records `enabled: false`. */
export interface StoredSource { id: string; url?: string; enabled?: boolean; addedAt?: string }
export interface SourceStore { sources(): StoredSource[]; setSources(sources: StoredSource[]): void }

/** A source to read: the built-in index, or one that was added. */
export interface MarketSource { id: string; url: string; enabled: boolean; builtin?: boolean; fixed?: boolean }

/** The selected version of each installed package and where it came from (its source record). */
export type InstalledPackages = ReadonlyMap<string, { version: string; source: string }>;

export interface MarketOptions {
  sources: readonly MarketSource[];
  /** The loopback ports this server answers on: no source or archive may point at them. */
  ports?: readonly number[];
  installed?: InstalledPackages;
  signal?: AbortSignal;
  fresh?: boolean;
}

/** One release as the index lists it, newest first. Built-in entries list versions without an archive. */
interface IndexRelease { version: string; date?: string; archive?: string; integrity?: string; size?: number; capabilities?: string[]; hostApi?: { server?: string; agent?: string; web?: string }; trusted?: boolean }
interface IndexManifest { vendor?: string; name?: string; title?: Record<string, string>; description?: Record<string, string>; contributes?: Record<string, unknown>; executables?: unknown }
interface IndexEntry { id: string; origin?: string; source?: string; license?: string; readme?: string; manifest?: IndexManifest; versions?: IndexRelease[] }

/** A release chosen from the index, ready to download. */
export interface MarketPackage extends PluginMarketOffer { integrity: string; archive: URL }
interface IndexDocument { url: URL; name?: string; page?: URL; entries: IndexEntry[] }

const MAX_REDIRECTS = 5;
const SOURCE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** `acme.thing` or `acme.thing@1.2.0`; anything else is not a market reference. */
export function parseMarketReference(text: string): MarketReference | undefined {
  const at = text.lastIndexOf('@');
  const id = at > 0 ? text.slice(0, at) : text;
  const version = at > 0 ? text.slice(at + 1) : undefined;
  if (!PLUGIN_ID.test(id) || id.length > 64 || (version !== undefined && !VERSION.test(version))) return undefined;
  return { id, ...(version ? { version } : {}) };
}

export function checkMarketReference(value: unknown): MarketReference {
  const { id, version, source } = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  const reference = typeof id === 'string' && (version === undefined || typeof version === 'string') ? parseMarketReference(version ? `${id}@${version}` : id) : undefined;
  if (!reference || (source !== undefined && (typeof source !== 'string' || !SOURCE_ID.test(source)))) throw new AppError('INVALID_INPUT', 'market must be { source?, id, version? } naming a plugin');
  return { ...reference, ...(source ? { source: source as string } : {}) };
}

const failed = (message: string, status = 502) => new AppError('PLUGIN_MARKET_UNAVAILABLE', message, status);

function checkedUrl(text: string, base?: URL): URL {
  let url: URL;
  try { url = new URL(text, base); } catch { throw failed('the plugin index has an invalid address'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  // An archive is fetched over https, or the way the index itself was (a local index for development).
  const allowed = url.protocol === 'https:' || (base ? url.protocol === base.protocol : url.protocol === 'file:' || (url.protocol === 'http:' && loopback));
  if (!allowed || (url.protocol === 'http:' && !loopback)) throw failed(`the plugin index may not point at ${url.protocol} addresses`);
  return url;
}

/** `base` is what a redirect is held to, as `checkedUrl` holds the address itself; `guard` sees the address and every hop. */
async function fetchBytes(url: URL, limit: number, timeout: number, signal?: AbortSignal, base?: URL, guard?: (url: URL) => void): Promise<Buffer> {
  if (url.protocol === 'file:') {
    const path = fileURLToPath(url);
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile()) throw failed(`${path} does not exist`, 404);
    if (info.size > limit) throw failed('the download is larger than allowed', 422);
    return readFile(path);
  }
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
  // A redirect may not leave the rule `checkedUrl` states (https, or the way the index was reached): the index is what vouches for every archive. Each hop is checked before it is requested.
  let target = url;
  let response: Response;
  for (let hops = 0; ; hops++) {
    guard?.(target);
    response = await fetch(target, { signal: requestSignal, redirect: 'manual' })
      .catch((error: unknown) => { throw failed(`could not reach ${target.host || target.pathname}: ${error instanceof Error ? error.message : String(error)}`); });
    const location = [301, 302, 303, 307, 308].includes(response.status) ? response.headers.get('location') : null;
    if (!location) break;
    void response.body?.cancel();
    if (hops >= MAX_REDIRECTS) throw failed('the download redirected too many times');
    let next: URL;
    try { next = new URL(location, target); } catch { throw failed('the download redirected to an invalid address'); }
    target = checkedUrl(next.href, base);
  }
  if (!response.ok) throw failed(`${url.host || url.pathname} answered HTTP ${response.status}`, response.status === 404 ? 404 : 502);
  if (Number(response.headers.get('content-length') ?? 0) > limit) throw failed('the download is larger than allowed', 422);
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body?.getReader();
  for (let read = await reader?.read(); reader && read && !read.done; read = await reader.read()) {
    total += read.value.length;
    if (total > limit) { void reader.cancel(); throw failed('the download is larger than allowed', 422); }
    chunks.push(Buffer.from(read.value));
  }
  return Buffer.concat(chunks);
}

const runs = (release: IndexRelease) => !serverIncompatibility({ hostApi: release.hostApi } as Parameters<typeof serverIncompatibility>[0]);
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
// An index is someone else's document: a release whose fields have the wrong types is left out rather than trusted.
const wellFormed = (item: unknown): item is IndexRelease => isObject(item)
  && typeof item.version === 'string' && typeof item.archive === 'string' && typeof item.integrity === 'string'
  && (item.hostApi === undefined || (isObject(item.hostApi) && Object.values(item.hostApi).every(range => typeof range === 'string')))
  && (item.capabilities === undefined || (Array.isArray(item.capabilities) && item.capabilities.every(name => typeof name === 'string')));
const installable = (entry: IndexEntry) => (Array.isArray(entry.versions) ? entry.versions : []).filter(wellFormed);
const texts = (value: unknown) => {
  if (!isObject(value)) return undefined;
  const kept = Object.fromEntries(Object.entries(value).filter((pair): pair is [string, string] => typeof pair[1] === 'string'));
  return Object.keys(kept).length ? kept : undefined;
};

// Browsing reads each index once a minute at most; installs check the content against it either way.
// At most one document per source (the built-in one and `maxSources` added), and a source's is dropped when it is removed or turned off.
// perf-rules: allow bounded by the source count and pruned on every listing
const cache = new Map<string, { at: number; document?: IndexDocument; error?: unknown }>();
const cacheKey = (source: MarketSource) => `${source.id}\n${source.url}`;

/** Drops what is kept of a source that was removed or turned off. */
export function forgetMarketSource(id: string): void {
  for (const key of [...cache.keys()]) if (key.startsWith(`${id}\n`)) cache.delete(key);
}

const refuseOwnPort = (url: URL, ports: readonly number[] = []) => {
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (isLoopbackOrUnspecified(url.hostname) && ports.includes(port)) throw new AppError('INVALID_INPUT', 'the address is this server');
};

/** An address a source may have: https, or http on this machine, and never this server itself. */
export function checkSourceAddress(text: string, ports?: readonly number[]): URL {
  let url: URL;
  try { url = new URL(text.trim()); } catch { throw new AppError('INVALID_INPUT', 'the source address is not a valid URL'); }
  const loopback = isLoopbackOrUnspecified(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new AppError('INVALID_INPUT', 'a source must be an https address (http only on this machine)');
  if (url.username || url.password) throw new AppError('INVALID_INPUT', 'a source address may not carry credentials');
  refuseOwnPort(url, ports);
  url.hash = '';
  return url;
}

/** The first label of the host and 16 hex digits of the address's hash: the same address always gives the same id, and another address cannot be made to give it. */
export function marketSourceId(url: URL): string {
  const label = url.hostname.split('.')[0]!.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 24) || 'source';
  return `${label}-${createHash('sha256').update(url.href).digest('hex').slice(0, 16)}`;
}

/** The built-in source first, then the added ones, as plugins.json has them. */
export function marketSources(store?: Pick<SourceStore, 'sources'>): MarketSource[] {
  const stored = store?.sources() ?? [];
  const builtin = stored.find(item => item.id === PLUGIN_SOURCE_BUILTIN);
  const fixed = Boolean(process.env.RIFFET_PLUGIN_INDEX?.trim());
  return [
    { id: PLUGIN_SOURCE_BUILTIN, url: pluginIndexUrl(), enabled: builtin?.enabled !== false, builtin: true, ...(fixed ? { fixed } : {}) },
    ...stored.flatMap((item): MarketSource[] => item.id !== PLUGIN_SOURCE_BUILTIN && item.url ? [{ id: item.id, url: item.url, enabled: item.enabled !== false }] : []),
  ];
}

/** The source record of a market install: `market:<source>/<id>@<version>`; the older `market:<id>@<version>` is the built-in source. */
export const marketRecord = (found: { sourceId: string; id: string; version: string }) => `market:${found.sourceId}/${found.id}@${found.version}`;

export function parseMarketRecord(source: string): { sourceId: string; id: string; version: string } | undefined {
  const match = /^market:(?:([a-z0-9][a-z0-9-]*)\/)?([^@/]+)@(.+)$/.exec(source);
  return match ? { sourceId: match[1] ?? PLUGIN_SOURCE_BUILTIN, id: match[2]!, version: match[3]! } : undefined;
}

export function installedPackages(records: Iterable<{ id: string; selected: string; versions: ReadonlyArray<{ version: string; source: string }> }>): InstalledPackages {
  const installed = new Map<string, { version: string; source: string }>();
  for (const record of records) {
    const selected = record.versions.find(item => item.version === record.selected);
    if (selected) installed.set(record.id, { version: selected.version, source: selected.source });
  }
  return installed;
}

/** A market install keeps the source the package came from; another origin needs the package uninstalled first. */
export function checkMarketSource(record: { selected: string; versions: ReadonlyArray<{ version: string; source: string }> } | undefined, source: string, id: string): void {
  const wanted = parseMarketRecord(source);
  const current = record?.versions.find(item => item.version === record.selected);
  if (!wanted || !current) return;
  const has = parseMarketRecord(current.source);
  if (has?.sourceId === wanted.sourceId) return;
  const origin = has ? `from source ${has.sourceId}` : current.source.startsWith('upload:') ? 'from an upload' : current.source.startsWith('path:') ? 'from a local path' : 'from another origin';
  throw new AppError('PLUGIN_SOURCE_CONFLICT', `${id} is installed ${origin}, not from source ${wanted.sourceId}; uninstall it first (its settings and data are kept)`, 409);
}

async function readSource(source: MarketSource, options: { ports?: readonly number[]; signal?: AbortSignal; fresh?: boolean }): Promise<IndexDocument> {
  const key = cacheKey(source);
  const kept = cache.get(key);
  // A failed read is remembered as long as a good one, so a source that hangs costs one wait a minute, not one per listing.
  if (!options.fresh && kept && Date.now() - kept.at < PLUGIN_MARKET_BUDGET.cacheMs) {
    if (kept.document) return kept.document;
    throw kept.error;
  }
  try {
    const document = await readIndex(source, options);
    cache.set(key, { at: Date.now(), document });
    return document;
  } catch (error) {
    // Stopped by the caller (the listing's deadline, a closed request): nothing was learned about the source.
    if (!options.signal?.aborted) cache.set(key, { at: Date.now(), error });
    throw error;
  }
}

async function readIndex(source: MarketSource, options: { ports?: readonly number[]; signal?: AbortSignal }): Promise<IndexDocument> {
  // An index that was added is held to its own protocol on redirects, and may not lead to this server.
  const url = source.builtin ? checkedUrl(source.url) : checkSourceAddress(source.url, options.ports);
  const guard = source.builtin ? undefined : (hop: URL) => refuseOwnPort(hop, options.ports);
  let index: { schemaVersion?: unknown; name?: unknown; page?: unknown; plugins?: unknown };
  try { index = JSON.parse((await fetchBytes(url, PLUGIN_MARKET_BUDGET.indexBytes, PLUGIN_MARKET_BUDGET.readMs, options.signal, source.builtin ? undefined : url, guard)).toString('utf8')) as typeof index; }
  catch (error) { throw error instanceof AppError ? error : failed('the plugin index is not valid JSON'); }
  if (!index || typeof index !== 'object' || Array.isArray(index) || !Array.isArray(index.plugins)) throw failed('the address does not serve a plugin index');
  if (index.schemaVersion !== undefined && index.schemaVersion !== 1) throw failed('the plugin index has a schema this Riffet does not read');
  let page: URL | undefined;
  if (typeof index.page === 'string') { try { const resolved = new URL(index.page, url); if (resolved.protocol === 'https:' || resolved.protocol === 'http:') page = resolved; } catch { /* no page */ } }
  const document: IndexDocument = {
    url, entries: (index.plugins as unknown[]).filter((item): item is IndexEntry => isObject(item) && typeof item.id === 'string' && (item.manifest === undefined || isObject(item.manifest))),
    ...(typeof index.name === 'string' && index.name.trim() ? { name: index.name.trim().slice(0, 80) } : {}), ...(page ? { page } : {}),
  };
  return document;
}

/** Runs `run` over `items`, at most `concurrentReads` at a time. */
async function limited<T, R>(items: readonly T[], run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, PLUGIN_MARKET_BUDGET.concurrentReads) }, async () => {
    for (let at = next++; at < items.length; at = next++) results[at] = await run(items[at]!);
  }));
  return results;
}

const reason = (error: unknown) => error instanceof Error ? error.message : String(error);

function entriesOf(source: MarketSource, document: IndexDocument, installed?: InstalledPackages): PluginMarketEntry[] {
  return document.entries.flatMap(entry => {
    try { return entryOf(source, document, entry, installed); }
    catch { return []; } // One entry this server cannot read leaves the rest of its source listed.
  });
}

function entryOf(source: MarketSource, document: IndexDocument, entry: IndexEntry, installed?: InstalledPackages): PluginMarketEntry[] {
  const releases = installable(entry);
  const release = releases.find(runs) ?? releases[0];
  if (entry.origin === 'builtin' || !release) return [];
  const manifest = entry.manifest ?? {};
  // A manifest without a title is shown by its name, as installed plugins are.
  const title = texts(manifest.title) ?? (typeof manifest.name === 'string' && manifest.name ? { en: manifest.name } : undefined), description = texts(manifest.description);
  const was = installed?.get(entry.id);
  const sameSource = was ? parseMarketRecord(was.source)?.sourceId === source.id : false;
  const update = sameSource && was !== undefined && runs(release) && satisfies(release.version, `>${was.version}`);
  return [{
    sourceId: source.id,
    ...(was ? { installed: { version: was.version, sameSource } } : {}), ...(update ? { update: true } : {}),
    id: entry.id, vendor: typeof manifest.vendor === 'string' ? manifest.vendor : entry.id.split('.')[0]!,
    ...(title ? { title } : {}), ...(description ? { description } : {}),
    version: release.version,
    ...(typeof release.date === 'string' ? { date: release.date } : {}),
    ...(typeof release.size === 'number' ? { size: release.size } : {}),
    ...(typeof entry.license === 'string' && entry.license ? { license: entry.license } : {}),
    ...(typeof entry.source === 'string' && entry.source.startsWith('https://') ? { source: entry.source } : {}),
    ...(typeof entry.readme === 'string' && entry.readme ? { readme: entry.readme } : {}),
    ...(document.page ? { page: `${document.page.href.split('#')[0]}#/${encodeURIComponent(entry.id)}` } : {}),
    contributes: isObject(manifest.contributes) ? Object.keys(manifest.contributes).sort() : [],
    capabilities: [...new Set(release.capabilities ?? [])].sort(),
    ...(grantModelSources(manifest.contributes) ? { modelSources: grantModelSources(manifest.contributes) } : {}),
    ...(grantExecutables(manifest) ? { executables: grantExecutables(manifest) } : {}),
    ...(release.trusted ? { trustedRequired: true } : {}),
    compatible: runs(release),
  }];
}

/** The packages a user can install from every enabled source, each at the newest release this server can run. A source that cannot be read carries its `error`; the others are listed regardless. */
export async function listMarket(options: MarketOptions): Promise<{ plugins: PluginMarketEntry[]; sources: PluginSource[] }> {
  const enabled = options.sources.filter(source => source.enabled);
  const live = new Set(enabled.map(cacheKey));
  for (const key of [...cache.keys()]) if (!live.has(key)) cache.delete(key);
  // One deadline for the whole listing: sources still unread by then are reported as such, and the rest are listed.
  const deadline = AbortSignal.timeout(PLUGIN_MARKET_BUDGET.listMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const read = new Map(await limited(enabled, async (source): Promise<[string, { document?: IndexDocument; error?: string }]> => {
    if (deadline.aborted && !cache.has(cacheKey(source))) return [source.id, { error: 'not read in time; refresh to try again' }];
    try { return [source.id, { document: await readSource(source, { ...options, signal }) }]; }
    catch (error) { return [source.id, { error: deadline.aborted && !options.signal?.aborted ? 'not read in time; refresh to try again' : reason(error) }]; }
  }));
  const plugins: PluginMarketEntry[] = [];
  const sources = options.sources.map((source): PluginSource => {
    const result = read.get(source.id);
    const document = result?.document;
    const entries = document ? entriesOf(source, document, options.installed) : [];
    plugins.push(...entries);
    return {
      id: source.id, url: source.url, ...(document?.name ? { name: document.name } : {}),
      ...(source.builtin ? { builtin: true } : {}), ...(source.fixed ? { fixed: true } : {}), enabled: source.enabled,
      ...(document ? { plugins: entries.length } : {}), ...(result?.error ? { error: result.error } : {}),
    };
  });
  return { plugins, sources };
}

/** The source a reference means: the one it names; else the one an installed package is pinned to; else the only enabled one that lists the id. */
async function chooseSource(reference: MarketReference, options: MarketOptions): Promise<{ source: MarketSource; document: IndexDocument }> {
  const find = (id: string) => options.sources.find(item => item.id === id);
  const named = reference.source ?? (() => {
    const was = options.installed?.get(reference.id);
    return was ? parseMarketRecord(was.source)?.sourceId : undefined;
  })();
  if (named) {
    const source = find(named);
    if (!source) throw new AppError('PLUGIN_SOURCE_NOT_FOUND', `there is no source ${named}`, 404);
    if (!source.enabled) throw new AppError('PLUGIN_SOURCE_DISABLED', `source ${named} is turned off`, 409);
    return { source, document: await readSource(source, options) };
  }
  const enabled = options.sources.filter(source => source.enabled);
  const found = (await limited(enabled, async source => {
    try { const document = await readSource(source, options); return document.entries.some(entry => entry.id === reference.id && entry.origin !== 'builtin' && installable(entry).length) ? [{ source, document }] : []; }
    catch { return []; }
  })).flat();
  if (found.length > 1) throw new AppError('PLUGIN_MARKET_AMBIGUOUS', `${reference.id} is listed by sources ${found.map(item => item.source.id).join(', ')}; choose one`, 409, { sources: found.map(item => item.source.id) });
  if (!found[0]) throw new AppError('PLUGIN_MARKET_NOT_FOUND', `${reference.id} is not in any plugin index`, 404);
  return found[0];
}

/** Reads the index and picks the release: the one asked for, or the newest this host can run. */
export async function resolveMarketPackage(reference: MarketReference, options: MarketOptions): Promise<MarketPackage> {
  const { source, document } = await chooseSource(reference, options);
  const entry = document.entries.find(item => item.id === reference.id);
  if (!entry) throw new AppError('PLUGIN_MARKET_NOT_FOUND', `${reference.id} is not in the plugin index of ${source.id}`, 404);
  if (entry.origin === 'builtin') throw new AppError('PLUGIN_ID_TAKEN', `${reference.id} ships with Riffet`, 409);
  const releases = installable(entry);
  const release = reference.version ? releases.find(item => item.version === reference.version) : releases.find(runs);
  if (!release) {
    throw new AppError('PLUGIN_MARKET_NOT_FOUND', reference.version ? `${reference.id} ${reference.version} is not in the plugin index of ${source.id}` : `no version of ${reference.id} in the plugin index of ${source.id} runs on this Riffet`, 404);
  }
  const title = texts(entry.manifest?.title);
  const models = grantModelSources(entry.manifest?.contributes);
  const archive = checkedUrl(release.archive!, document.url);
  if (!source.builtin) refuseOwnPort(archive, options.ports);
  return {
    sourceId: source.id, id: entry.id, version: release.version, integrity: release.integrity!, archive,
    capabilities: [...new Set((release.capabilities ?? []).map(String))].sort(),
    ...(title ? { title } : {}),
    ...(release.trusted ? { trustedRequired: true } : {}),
    ...(models ? { modelSources: models } : {}),
    ...(grantExecutables(entry.manifest) ? { executables: grantExecutables(entry.manifest) } : {}),
  };
}

export async function downloadMarketPackage(found: MarketPackage, options: { signal?: AbortSignal; ports?: readonly number[] } = {}): Promise<Buffer> {
  return fetchBytes(found.archive, MAX_ARCHIVE_BYTES, 120_000, options.signal, found.archive, hop => refuseOwnPort(hop, options.ports));
}

/** What a client shows before asking to install: the same shape as a grant request, so one dialog serves both. */
export const marketOffer = ({ integrity: _integrity, archive: _archive, ...offer }: MarketPackage): PluginMarketOffer => offer;

/** Adds the index at `text` as a source once it has been read; an address that cannot be read saves nothing. */
export async function addMarketSource(store: SourceStore, text: string, options: { ports?: readonly number[]; signal?: AbortSignal } = {}): Promise<MarketSource> {
  const url = checkSourceAddress(text, options.ports);
  const id = marketSourceId(url);
  const check = () => {
    if (marketSources(store).some(item => item.id === id || item.url === url.href)) throw new AppError('PLUGIN_SOURCE_EXISTS', 'this source is already added', 409);
    if (store.sources().filter(item => item.url).length >= PLUGIN_MARKET_BUDGET.maxSources) throw new AppError('PLUGIN_SOURCE_LIMIT', `at most ${PLUGIN_MARKET_BUDGET.maxSources} sources can be added; remove one first`, 409);
  };
  check();
  const source: MarketSource = { id, url: url.href, enabled: true };
  try { await readSource(source, { ...options, fresh: true }); }
  catch (error) { forgetMarketSource(id); throw new AppError('PLUGIN_SOURCE_UNREADABLE', `${url.host} cannot be used as a source: ${reason(error)}`, 422); }
  // The read may take a while; what other clients changed meanwhile is kept.
  check();
  store.setSources([...store.sources(), { id, url: url.href, addedAt: new Date().toISOString() }]);
  return source;
}

export function setMarketSourceEnabled(store: SourceStore, id: string, enabled: boolean): void {
  const stored = store.sources();
  if (id === PLUGIN_SOURCE_BUILTIN) store.setSources([...stored.filter(item => item.id !== id), ...(enabled ? [] : [{ id, enabled: false }])]);
  else if (stored.some(item => item.id === id)) store.setSources(stored.map(item => item.id === id ? { ...item, enabled } : item));
  else throw new AppError('PLUGIN_SOURCE_NOT_FOUND', `there is no source ${id}`, 404);
  if (!enabled) forgetMarketSource(id);
}

/** Packages installed from the source are untouched; they keep their records. */
export function removeMarketSource(store: SourceStore, id: string): void {
  if (id === PLUGIN_SOURCE_BUILTIN) throw new AppError('PLUGIN_SOURCE_BUILTIN', 'the built-in source cannot be removed; turn it off instead', 409);
  const stored = store.sources();
  if (!stored.some(item => item.id === id)) throw new AppError('PLUGIN_SOURCE_NOT_FOUND', `there is no source ${id}`, 404);
  store.setSources(stored.filter(item => item.id !== id));
  forgetMarketSource(id);
}

/** A source by its id or its address, for the command line. */
export function findMarketSource(store: Pick<SourceStore, 'sources'>, idOrUrl: string): MarketSource | undefined {
  const all = marketSources(store);
  const byId = all.find(item => item.id === idOrUrl);
  if (byId) return byId;
  try { const url = checkSourceAddress(idOrUrl); return all.find(item => item.url === url.href); } catch { return undefined; }
}
