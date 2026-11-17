import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlugin, packPlugin } from '../../../../packages/plugin-api/src/tooling.js';
import { satisfies } from '../../../../packages/contracts/src/semver.js';
import { integrityOf, readArchive, reroot, writeFiles, type PackageFile } from './archive.js';
import { inspectPackage } from './packages.js';
import { parseMarketReference } from './market.js';

// Builds a plugin index (docs/PLUGINS.md「插件市场」) from a registry directory. The public site
// (scripts/build-site.ts) and `riffet plugin index build` share it. A record in the registry is either
//   { "path": "<package directory>" }                                  a package built and packed here, or
//   { "id", "source", "readme"?, "license"?, "versions": [{ "version", "date", "archive", "integrity" }] }
// a package released elsewhere; `archive` and `readme` are an https address or a path relative to the registry.
// Every archive is read the way an install reads it and must have the integrity its record pins; the index
// then vouches for exactly those files.

export type Manifest = Record<string, any>;
export interface IndexRelease { version: string; date: string; archive?: string; size?: number; integrity?: string; capabilities?: string[]; hostApi?: Manifest; trusted?: boolean }
export interface IndexEntry { id: string; origin: 'registry' | 'builtin'; source?: string; license: string; manifest: Manifest; readme?: string; readmeHtml?: string; assets: Record<string, unknown>; versions: IndexRelease[] }

export interface PathRecord { path: string; license?: string; source?: string; date?: string }
export interface ExternalRecord { id: string; source: string; readme?: string; license?: string; versions: Array<{ version: string; date: string; archive: string; integrity: string }> }

export interface BuildOptions {
  /** The directory of the records (`<id>.json`). */
  registry: string;
  /** The index directory: `packages/` and `assets/` are written under it. */
  out: string;
  /** The index already published at this address (`undefined`: none). A release in it keeps its content. */
  published?: string;
  /** Keep the older releases of a `{ path }` record that the published index lists, re-hosted under `packages/`. */
  carryForward?: boolean;
  /** An unreadable published index fails the build (a missing one, HTTP 404, is none); otherwise it is only warned about. */
  strictPublished?: boolean;
  /** Where a `{ path }` record points; by default relative to the registry directory. */
  directory?(record: PathRecord, name: string): string;
  /** What the record's place says of the package. Without it: the record's own `source` and `date`, today's date. */
  describe?(record: PathRecord, directory: string): { source?: string; date?: string; readmeBase?: string };
  /** An HTML rendering of the README Markdown, for a page that shows it. */
  html?(readme: string): string;
  warn?(message: string): void;
}

const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const fail = (record: string, message: string): never => { throw new Error(`${record}: ${message}`); };
const today = () => new Date().toISOString().slice(0, 10);

export async function download(address: string): Promise<Buffer> {
  if (address.startsWith('file:')) return readFile(fileURLToPath(address));
  const response = await fetch(address, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw Object.assign(new Error(`${address} answered HTTP ${response.status}`), { status: response.status });
  return Buffer.from(await response.arrayBuffer());
}

/** A file the page loads by address, named by its content. */
async function asset(directory: string, data: Buffer | string, extension: string): Promise<string> {
  const name = `${sha(data).slice(0, 16)}.${extension}`;
  await writeFile(join(directory, 'assets', name), data);
  return `assets/${name}`;
}

/** The README without the heading that repeats the package's name; with `base`, relative links made absolute. */
export function normalizeReadme(text: string, base?: string): string {
  const body = text.replace(/^﻿?#\s[^\n]*\n+/, '').trim();
  if (!body || !base) return body;
  const folder = base.endsWith('/') ? base : base + '/';
  const absolute = (url: string) => /^[a-z][a-z0-9+.-]*:|^#|^\/\//i.test(url) ? url : new URL(url, folder).href;
  return body
    .replace(/(\]\()([^)\s]+)/g, (_, open: string, url: string) => open + absolute(url))
    .replace(/^(\s*\[[^\]]+\]:\s*)(\S+)/gm, (_, label: string, url: string) => label + absolute(url));
}

/** What the page shows of a package's appearance: palettes and icon packs inline, fonts, backgrounds and avatar samples as files. */
export async function assetsOf(directory: string, manifest: Manifest, file: (path: string) => Buffer | undefined, samples: Record<string, string> = {}): Promise<Record<string, unknown>> {
  await mkdir(join(directory, 'assets'), { recursive: true });
  const appearance = manifest.contributes?.appearance ?? {};
  const assets: Record<string, unknown> = {};
  const json = (path: string) => JSON.parse(file(path)?.toString('utf8') ?? 'null');
  for (const palette of appearance.palettes ?? []) { const value = json(palette.asset); if (value) assets[palette.id] = { palette: value.palette, ansi: value.ansi }; }
  for (const pack of appearance.iconPacks ?? []) { const value = json(pack.asset); if (value) assets[pack.id] = value.icons; }
  for (const font of appearance.fonts ?? []) { const data = file(font.files?.[0]?.path); if (data) assets[font.id] = await asset(directory, data, 'woff2'); }
  for (const background of appearance.backgrounds ?? []) { const data = file(background.asset); if (data) assets[background.id] = await asset(directory, data, background.asset.split('.').pop()); }
  for (const [id, svg] of Object.entries(samples)) assets[id] = await asset(directory, svg, 'svg');
  return assets;
}

/** Reads an archive the way an install does: its files, integrity, manifest and whether it needs explicit trust. */
export async function inspect(archive: Buffer) {
  const files = reroot(readArchive(archive), 'riffet-plugin.json');
  const directory = await mkdtemp(join(tmpdir(), 'riffet-index-'));
  let trusted = false;
  let checked;
  try {
    await writeFiles(directory, files);
    try { checked = await inspectPackage(directory); }
    catch (error) {
      if ((error as { code?: string }).code !== 'PLUGIN_TRUST_REQUIRED') throw error;
      trusted = true; checked = await inspectPackage(directory, { trusted: true });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
  const byPath = new Map(files.map((item: PackageFile) => [item.path, item.data]));
  // The page shows the manifest as the package has it (the checked one leaves out its entries).
  const manifest: Manifest = JSON.parse(byPath.get('riffet-plugin.json')!.toString('utf8'));
  delete manifest.$schema;
  return { integrity: integrityOf(files), manifest, capabilities: checked.capabilities, trusted, file: (path: string) => byPath.get(path) };
}
type Inspected = Awaited<ReturnType<typeof inspect>>;

const release = (manifest: Manifest, inspected: Inspected, date: string, archive: string, size: number): IndexRelease => ({
  version: manifest.version, date, archive, size, integrity: inspected.integrity, capabilities: inspected.capabilities,
  ...(manifest.hostApi ? { hostApi: manifest.hostApi } : {}), ...(inspected.trusted ? { trusted: true } : {}),
});

const newestFirst = (a: IndexRelease, b: IndexRelease) => a.version === b.version ? 0 : satisfies(a.version, `>${b.version}`) ? -1 : 1;

/** The releases an already published index lists, by package. */
export interface Published { url: string; plugins: Map<string, IndexRelease[]> }

export async function readPublished(url: string, strict: boolean, warn: (message: string) => void = console.warn): Promise<Published | undefined> {
  if (!url || url === 'none') return undefined;
  try {
    const index = JSON.parse((await download(url)).toString('utf8')) as { plugins?: Array<{ id: string; versions?: IndexRelease[] }> };
    return { url, plugins: new Map((index.plugins ?? []).map(entry => [entry.id, entry.versions ?? []])) };
  } catch (error) {
    if ((error as { status?: number }).status === 404 && strict) return undefined;
    if (strict) throw new Error(`could not read the published index ${url}: ${error instanceof Error ? error.message : String(error)}; pass --published none to build without it`);
    warn(`not checked against ${url}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/** Installs pin a release by its integrity, so one the published index lists may not change content under the same version. */
function checkPublished(plugins: IndexEntry[], published?: Published): void {
  if (!published) return;
  for (const entry of plugins) for (const item of entry.versions) {
    const was = published.plugins.get(entry.id)?.find(old => old.version === item.version)?.integrity;
    if (was && item.integrity && was !== item.integrity) throw new Error(`${entry.id} ${item.version} is already published with other content; give the package a new version`);
  }
}

/** The older releases the published index lists, downloaded, verified against the integrity it lists and hosted again under `packages/`. */
async function carried(out: string, entry: IndexEntry, published: Published): Promise<IndexRelease[]> {
  const current = entry.versions[0]!;
  const kept: IndexRelease[] = [];
  for (const old of published.plugins.get(entry.id) ?? []) {
    if (!old.archive || !old.integrity || entry.versions.some(item => item.version === old.version) || !satisfies(old.version, `<${current.version}`)) continue;
    const address = new URL(old.archive, published.url).href;
    const bytes = await download(address);
    const inspected = await inspect(bytes);
    if (inspected.manifest.id !== entry.id || inspected.manifest.version !== old.version) fail(entry.id, `${address} is ${inspected.manifest.id} ${inspected.manifest.version}`);
    if (inspected.integrity !== old.integrity) fail(entry.id, `${old.version}: the published archive's integrity is ${inspected.integrity}, not ${old.integrity}`);
    const file = `${entry.id}-${old.version}.tgz`;
    await writeFile(join(out, 'packages', file), bytes);
    kept.push(release(inspected.manifest, inspected, old.date, `packages/${file}`, bytes.length));
  }
  return kept;
}

async function local(options: BuildOptions, name: string, record: PathRecord): Promise<IndexEntry> {
  if (typeof record.path !== 'string' || !record.path) fail(name, 'path must be text');
  const directory = options.directory?.(record, name) ?? resolve(options.registry, record.path);
  const built = await buildPlugin(directory);
  const packed = await packPlugin(built.directory);
  const inspected = await inspect(packed.archive);
  const manifest = { ...inspected.manifest };
  const file = `${manifest.id}-${manifest.version}.tgz`;
  await writeFile(join(options.out, 'packages', file), packed.archive);
  const place = options.describe?.(record, directory) ?? {};
  const source = place.source ?? record.source;
  const readme = normalizeReadme(await readFile(join(directory, 'README.md'), 'utf8').catch(() => ''), place.readmeBase);
  return {
    id: manifest.id, origin: 'registry', ...(source ? { source } : {}), license: record.license ?? 'Apache-2.0', manifest,
    ...(readme ? { readme, ...(options.html ? { readmeHtml: options.html(readme) } : {}) } : {}),
    assets: await assetsOf(options.out, manifest, inspected.file),
    versions: [release(manifest, inspected, place.date ?? record.date ?? today(), `packages/${file}`, packed.archive.length)],
  };
}

/** An archive or README given as an https address or as a path relative to the registry. */
const fetchRecordFile = (options: BuildOptions, address: string) => /^https:\/\//.test(address) ? download(address) : readFile(resolve(options.registry, address));

async function external(options: BuildOptions, name: string, record: ExternalRecord): Promise<IndexEntry> {
  if (!record.source?.startsWith('https://')) fail(name, 'source must be an https address');
  if (!Array.isArray(record.versions) || !record.versions.length) fail(name, 'versions must list at least one release');
  let latest: { manifest: Manifest; inspected: Inspected } | undefined;
  const versions: IndexRelease[] = [];
  for (const [at, item] of record.versions.entries()) {
    if (!parseMarketReference(`${record.id}@${item.version}`)) fail(name, `${item.version} is not a version (x.y.z)`);
    const newer = record.versions[at - 1]?.version;
    if (newer && !satisfies(newer, `>${item.version}`)) fail(name, `versions must be listed newest first: ${newer} comes before ${item.version}`);
    if (typeof item.archive !== 'string' || !item.archive || /^[a-z][a-z0-9+.-]*:/i.test(item.archive) && !item.archive.startsWith('https://')) fail(name, `${item.version}: archive must be an https address or a path relative to the registry`);
    const hosted = !item.archive.startsWith('https://');
    const archive = await fetchRecordFile(options, item.archive);
    const inspected = await inspect(archive);
    if (inspected.manifest.id !== record.id || inspected.manifest.version !== item.version) fail(name, `${item.archive} is ${inspected.manifest.id} ${inspected.manifest.version}`);
    if (inspected.integrity !== item.integrity) fail(name, `${item.version}: the archive's integrity is ${inspected.integrity}, not ${item.integrity}`);
    let address = item.archive;
    if (hosted) { address = `packages/${record.id}-${item.version}.tgz`; await writeFile(join(options.out, address), archive); }
    versions.push(release(inspected.manifest, inspected, item.date, address, archive.length));
    latest ??= { manifest: inspected.manifest, inspected };
  }
  const readme = record.readme ? normalizeReadme((await fetchRecordFile(options, record.readme)).toString('utf8'), record.readme.startsWith('https://') ? record.readme.replace(/[^/]*$/, '') : undefined) : '';
  return {
    id: record.id, origin: 'registry', source: record.source, license: record.license ?? '', manifest: latest!.manifest,
    ...(readme ? { readme, ...(options.html ? { readmeHtml: options.html(readme) } : {}) } : {}),
    assets: await assetsOf(options.out, latest!.manifest, latest!.inspected.file), versions,
  };
}

/** The entries of every record in the registry, their archives hosted under `<out>/packages`. */
export async function buildRegistry(options: BuildOptions): Promise<IndexEntry[]> {
  await mkdir(join(options.out, 'packages'), { recursive: true });
  await mkdir(join(options.out, 'assets'), { recursive: true });
  const published = await readPublished(options.published ?? 'none', options.strictPublished === true, options.warn);
  const entries: IndexEntry[] = [];
  for (const name of (await readdir(options.registry)).filter(item => item.endsWith('.json')).sort()) {
    const record = JSON.parse(await readFile(join(options.registry, name), 'utf8')) as PathRecord | ExternalRecord;
    const isPath = 'path' in record;
    const entry = isPath ? await local(options, name, record) : await external(options, name, record);
    if (`${entry.id}.json` !== name) fail(name, `the file must be named ${entry.id}.json`);
    if (isPath && options.carryForward && published) {
      // The date of a release the published index already lists stays as it was.
      const listed = published.plugins.get(entry.id)?.find(old => old.version === entry.versions[0]!.version && old.integrity === entry.versions[0]!.integrity);
      if (listed?.date) entry.versions[0]!.date = listed.date;
      entry.versions.push(...await carried(options.out, entry, published));
      entry.versions.sort(newestFirst);
    }
    entries.push(entry);
  }
  checkPublished(entries, published);
  const seen = new Set<string>();
  for (const entry of entries) { if (seen.has(entry.id)) throw new Error(`${entry.id} is listed twice`); seen.add(entry.id); }
  return entries;
}

/** `<out>/index.json`. */
export async function writeIndex(out: string, index: { plugins: IndexEntry[]; name?: string; page?: string }): Promise<void> {
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'index.json'), JSON.stringify({ schemaVersion: 1, ...(index.name ? { name: index.name } : {}), ...(index.page ? { page: index.page } : {}), generated: new Date().toISOString(), plugins: index.plugins }));
}
