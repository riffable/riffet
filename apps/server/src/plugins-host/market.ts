import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { PluginMarketEntry, PluginMarketOffer } from '../../../../packages/contracts/src/index.js';
import { PLUGIN_ID } from '../../../../packages/contracts/src/plugins.js';
import { AppError } from '../errors.js';
import { serverIncompatibility } from './compat.js';
import { MAX_ARCHIVE_BYTES } from './archive.js';

// The public plugin index (site/plugins, built by scripts/build-site.ts): which versions of a
// package exist, where each archive is and the integrity of its content. Installing from it downloads
// the archive and then takes the same path as an upload; the package store refuses content whose
// integrity differs from the index's, so the index vouches for exactly the files it was built from.

export const DEFAULT_PLUGIN_INDEX = 'https://riffetai.github.io/riffet/plugins/index.json';

/** The index this server and the CLI read: `RIFFET_PLUGIN_INDEX` (an https, loopback http or file URL), or the public one. */
export const pluginIndexUrl = () => process.env.RIFFET_PLUGIN_INDEX?.trim() || DEFAULT_PLUGIN_INDEX;

export interface MarketReference { id: string; version?: string }

/** One release as the index lists it, newest first. Built-in entries list versions without an archive. */
interface IndexRelease { version: string; date?: string; archive?: string; integrity?: string; size?: number; capabilities?: string[]; hostApi?: { server?: string; agent?: string; web?: string }; trusted?: boolean }
interface IndexManifest { vendor?: string; name?: string; title?: Record<string, string>; description?: Record<string, string>; contributes?: Record<string, unknown> }
interface IndexEntry { id: string; origin?: string; source?: string; license?: string; readme?: string; manifest?: IndexManifest; versions?: IndexRelease[] }

/** A release chosen from the index, ready to download. */
export interface MarketPackage extends PluginMarketOffer { integrity: string; archive: URL }

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
  const { id, version } = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  const reference = typeof id === 'string' && (version === undefined || typeof version === 'string') ? parseMarketReference(version ? `${id}@${version}` : id) : undefined;
  if (!reference) throw new AppError('INVALID_INPUT', 'market must be { id, version? } naming a plugin');
  return reference;
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

/** `base` is what a redirect is held to, as `checkedUrl` holds the address itself. */
async function fetchBytes(url: URL, limit: number, timeout: number, signal?: AbortSignal, base?: URL): Promise<Buffer> {
  if (url.protocol === 'file:') {
    const path = fileURLToPath(url);
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile()) throw failed(`${path} does not exist`, 404);
    if (info.size > limit) throw failed('the download is larger than allowed', 422);
    return readFile(path);
  }
  const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout), redirect: 'follow' })
    .catch((error: unknown) => { throw failed(`could not reach ${url.host || url.pathname}: ${error instanceof Error ? error.message : String(error)}`); });
  // A redirect may not leave https: the index is what vouches for every archive.
  if (response.redirected) { try { checkedUrl(response.url, base); } catch (error) { void response.body?.cancel(); throw error; } }
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
const installable = (entry: IndexEntry) => (entry.versions ?? []).filter(item => typeof item?.version === 'string' && typeof item.archive === 'string' && typeof item.integrity === 'string');
const texts = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, string> : undefined;

// Browsing reads the index once a minute at most; installs check the content against it either way.
let cached: { url: string; at: number; entries: IndexEntry[] } | undefined;
const CACHE_MS = 60_000;

async function readIndex(options: { index?: string; signal?: AbortSignal; fresh?: boolean }): Promise<{ url: URL; entries: IndexEntry[] }> {
  const url = checkedUrl(options.index ?? pluginIndexUrl());
  if (!options.fresh && cached?.url === url.href && Date.now() - cached.at < CACHE_MS) return { url, entries: cached.entries };
  let index: { plugins?: IndexEntry[] };
  try { index = JSON.parse((await fetchBytes(url, 16 * 1024 * 1024, 20_000, options.signal)).toString('utf8')) as typeof index; }
  catch (error) { throw error instanceof AppError ? error : failed('the plugin index is not valid JSON'); }
  const entries = Array.isArray(index.plugins) ? index.plugins.filter(item => item && typeof item.id === 'string') : [];
  cached = { url: url.href, at: Date.now(), entries };
  return { url, entries };
}

/** The packages a user can install from the index, each at the newest release this server can run. */
export async function listMarket(options: { index?: string; signal?: AbortSignal; fresh?: boolean } = {}): Promise<PluginMarketEntry[]> {
  const { url, entries } = await readIndex(options);
  // The marketplace page sits next to its index and routes by `#/<id>`.
  const site = url.protocol === 'https:' || url.protocol === 'http:' ? new URL('./', url) : undefined;
  return entries.flatMap(entry => {
    const releases = installable(entry);
    const release = releases.find(runs) ?? releases[0];
    if (entry.origin === 'builtin' || !release) return [];
    const manifest = entry.manifest ?? {};
    // A manifest without a title is shown by its name, as installed plugins are.
    const title = texts(manifest.title) ?? (typeof manifest.name === 'string' && manifest.name ? { en: manifest.name } : undefined), description = texts(manifest.description);
    return [{
      id: entry.id, vendor: typeof manifest.vendor === 'string' ? manifest.vendor : entry.id.split('.')[0]!,
      ...(title ? { title } : {}), ...(description ? { description } : {}),
      version: release.version,
      ...(typeof release.date === 'string' ? { date: release.date } : {}),
      ...(typeof release.size === 'number' ? { size: release.size } : {}),
      ...(typeof entry.license === 'string' && entry.license ? { license: entry.license } : {}),
      ...(typeof entry.source === 'string' && entry.source.startsWith('https://') ? { source: entry.source } : {}),
      ...(typeof entry.readme === 'string' && entry.readme ? { readme: entry.readme } : {}),
      ...(site ? { page: `${site.href}#/${encodeURIComponent(entry.id)}` } : {}),
      contributes: Object.keys(manifest.contributes ?? {}).sort(),
      capabilities: [...new Set((release.capabilities ?? []).map(String))].sort(),
      ...(release.trusted ? { trustedRequired: true } : {}),
      compatible: runs(release),
    }];
  });
}

/** Reads the index and picks the release: the one asked for, or the newest this host can run. */
export async function resolveMarketPackage(reference: MarketReference, options: { index?: string; signal?: AbortSignal } = {}): Promise<MarketPackage> {
  const { url: indexUrl, entries } = await readIndex(options);
  const entry = entries.find(item => item.id === reference.id);
  if (!entry) throw new AppError('PLUGIN_MARKET_NOT_FOUND', `${reference.id} is not in the plugin index`, 404);
  if (entry.origin === 'builtin') throw new AppError('PLUGIN_ID_TAKEN', `${reference.id} ships with Riffet`, 409);
  const releases = installable(entry);
  const release = reference.version ? releases.find(item => item.version === reference.version) : releases.find(runs);
  if (!release) {
    throw new AppError('PLUGIN_MARKET_NOT_FOUND', reference.version ? `${reference.id} ${reference.version} is not in the plugin index` : `no version of ${reference.id} in the plugin index runs on this Riffet`, 404);
  }
  const title = texts(entry.manifest?.title);
  return {
    id: entry.id, version: release.version, integrity: release.integrity!, archive: checkedUrl(release.archive!, indexUrl),
    capabilities: [...new Set((release.capabilities ?? []).map(String))].sort(),
    ...(title ? { title } : {}),
    ...(release.trusted ? { trustedRequired: true } : {}),
  };
}

export async function downloadMarketPackage(found: MarketPackage, signal?: AbortSignal): Promise<Buffer> {
  return fetchBytes(found.archive, MAX_ARCHIVE_BYTES, 120_000, signal, found.archive);
}

/** What a client shows before asking to install: the same shape as a grant request, so one dialog serves both. */
export const marketOffer = ({ integrity: _integrity, archive: _archive, ...offer }: MarketPackage): PluginMarketOffer => offer;
