// Builds the public site: a copy of site/ plus the plugin index the marketplace page and every Riffet
// read (docs/PLUGINS.md「插件市场」).
//
//   pnpm build:site [--out dist/site] [--published <index url>|none]
//
// A record in site/plugins/registry/<id>.json is either
//   { "path": "examples/plugins/echo" }                       a package in this repository, packed here, or
//   { "id", "source", "readme"?, "license"?, "versions": [{ "version", "date", "archive", "integrity" }] }
// a package released elsewhere. Every archive is read the way an install reads it and must have the
// integrity its record pins; the index then vouches for exactly those files. Built-in plugins are listed
// from plugins/index.ts so the page can say they ship with Riffet. A release the published index (by default
// the public one) already lists must keep its content: a changed package needs a new version.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { buildPlugin, packPlugin } from '../packages/plugin-api/src/tooling.js';
import { integrityOf, readArchive, reroot, writeFiles, type PackageFile } from '../apps/server/src/plugins-host/archive.js';
import { inspectPackage } from '../apps/server/src/plugins-host/packages.js';
import { builtinPlugins } from '../plugins/index.js';
import { DEFAULT_PLUGIN_INDEX, parseMarketReference } from '../apps/server/src/plugins-host/market.js';
import { satisfies } from '../packages/contracts/src/semver.js';

const root = resolve(import.meta.dirname, '..');
const outFlag = process.argv.indexOf('--out');
const out = resolve(root, outFlag >= 0 ? process.argv[outFlag + 1]! : 'dist/site');
const publishedFlag = process.argv.indexOf('--published');
const published = publishedFlag >= 0 ? process.argv[publishedFlag + 1]! : DEFAULT_PLUGIN_INDEX;
const repository = 'https://github.com/riffable/riffet';
const registry = join(root, 'site/plugins/registry');
const assetsDir = join(out, 'plugins/assets');
const packagesDir = join(out, 'plugins/packages');

type Manifest = Record<string, any>;
interface Version { version: string; date: string; archive?: string; size?: number; integrity?: string; capabilities?: string[]; hostApi?: Manifest; trusted?: boolean }
interface Entry { id: string; origin: 'registry' | 'builtin'; source: string; license: string; manifest: Manifest; readme?: string; readmeHtml?: string; assets: Record<string, unknown>; versions: Version[] }

const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const gitDate = (path: string) => execFileSync('git', ['log', '-1', '--format=%ad', '--date=short', '--', path], { cwd: root, encoding: 'utf8' }).trim() || new Date().toISOString().slice(0, 10);
const fail = (record: string, message: string): never => { throw new Error(`${record}: ${message}`); };

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** A file the page loads by address, named by its content. */
async function asset(data: Buffer | string, extension: string): Promise<string> {
  const name = `${sha(data).slice(0, 16)}.${extension}`;
  await writeFile(join(assetsDir, name), data);
  return `assets/${name}`;
}

/** The README without the heading that repeats the package's name, relative links pointing into its source. */
function readmeOf(text: string, base: string): { readme: string; readmeHtml: string } | Record<string, never> {
  const body = text.replace(/^\uFEFF?#\s[^\n]*\n+/, '').trim();
  if (!body) return {};
  const folder = base.endsWith('/') ? base : base + '/';
  const absolute = (url: string) => /^[a-z][a-z0-9+.-]*:|^#|^\/\//i.test(url) ? url : new URL(url, folder).href;
  // Clients render the Markdown with their own renderer; the page shows HTML made here, with raw HTML
  // dropped and only safe link protocols kept (react-markdown's defaults).
  const readme = body
    .replace(/(\]\()([^)\s]+)/g, (_, open: string, url: string) => open + absolute(url))
    .replace(/^(\s*\[[^\]]+\]:\s*)(\S+)/gm, (_, label: string, url: string) => label + absolute(url));
  const urlTransform = (url: string) => { const safe = defaultUrlTransform(url); return safe ? absolute(safe) : safe; };
  return { readme, readmeHtml: renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [remarkGfm], urlTransform }, readme)) };
}

/** What the page shows of a package's appearance: palettes and icon packs inline, fonts, backgrounds and avatar samples as files. */
async function assetsOf(manifest: Manifest, file: (path: string) => Buffer | undefined, samples: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const appearance = manifest.contributes?.appearance ?? {};
  const assets: Record<string, unknown> = {};
  const json = (path: string) => JSON.parse(file(path)?.toString('utf8') ?? 'null');
  for (const palette of appearance.palettes ?? []) { const value = json(palette.asset); if (value) assets[palette.id] = { palette: value.palette, ansi: value.ansi }; }
  for (const pack of appearance.iconPacks ?? []) { const value = json(pack.asset); if (value) assets[pack.id] = value.icons; }
  for (const font of appearance.fonts ?? []) { const data = file(font.files?.[0]?.path); if (data) assets[font.id] = await asset(data, 'woff2'); }
  for (const background of appearance.backgrounds ?? []) { const data = file(background.asset); if (data) assets[background.id] = await asset(data, background.asset.split('.').pop()); }
  for (const [id, svg] of Object.entries(samples)) assets[id] = await asset(svg, 'svg');
  return assets;
}

/** Reads an archive the way an install does: its files, integrity, manifest and whether it needs explicit trust. */
async function inspect(archive: Buffer) {
  const files = reroot(readArchive(archive), 'riffet-plugin.json');
  const directory = join(out, '.inspect', sha(archive).slice(0, 16));
  await writeFiles(directory, files);
  let trusted = false;
  let checked;
  try { checked = await inspectPackage(directory); }
  catch (error) {
    if ((error as { code?: string }).code !== 'PLUGIN_TRUST_REQUIRED') throw error;
    trusted = true; checked = await inspectPackage(directory, { trusted: true });
  } finally { await rm(directory, { recursive: true, force: true }); }
  const byPath = new Map(files.map((item: PackageFile) => [item.path, item.data]));
  // The page shows the manifest as the package has it (the checked one leaves out its entries).
  const manifest: Manifest = JSON.parse(byPath.get('riffet-plugin.json')!.toString('utf8'));
  delete manifest.$schema;
  return { integrity: integrityOf(files), manifest, capabilities: checked.capabilities, trusted, file: (path: string) => byPath.get(path) };
}

const release = (manifest: Manifest, inspected: Awaited<ReturnType<typeof inspect>>, date: string, archive: string, size: number): Version => ({
  version: manifest.version, date, archive, size, integrity: inspected.integrity, capabilities: inspected.capabilities,
  ...(manifest.hostApi ? { hostApi: manifest.hostApi } : {}), ...(inspected.trusted ? { trusted: true } : {}),
});

async function local(name: string, record: { path: string; license?: string }): Promise<Entry> {
  const directory = resolve(root, record.path);
  if (relative(root, directory).startsWith('..')) fail(name, 'path must be inside this repository');
  const built = await buildPlugin(directory);
  const packed = await packPlugin(built.directory);
  const inspected = await inspect(packed.archive);
  const manifest = { ...inspected.manifest };
  const file = `${manifest.id}-${manifest.version}.tgz`;
  await writeFile(join(packagesDir, file), packed.archive);
  const source = `${repository}/tree/main/${record.path}`;
  const readme = await readFile(join(directory, 'README.md'), 'utf8').catch(() => '');
  return {
    id: manifest.id, origin: 'registry', source, license: record.license ?? 'Apache-2.0', manifest,
    ...readmeOf(readme, `${repository}/blob/main/${record.path}/`),
    assets: await assetsOf(manifest, inspected.file),
    versions: [release(manifest, inspected, gitDate(record.path), `packages/${file}`, packed.archive.length)],
  };
}

async function external(name: string, record: { id: string; source: string; readme?: string; license?: string; versions: Array<{ version: string; date: string; archive: string; integrity: string }> }): Promise<Entry> {
  if (!record.source?.startsWith('https://')) fail(name, 'source must be an https address');
  if (!Array.isArray(record.versions) || !record.versions.length) fail(name, 'versions must list at least one release');
  let latest: { manifest: Manifest; inspected: Awaited<ReturnType<typeof inspect>> } | undefined;
  const versions: Version[] = [];
  for (const [at, item] of record.versions.entries()) {
    if (!parseMarketReference(`${record.id}@${item.version}`)) fail(name, `${item.version} is not a version (x.y.z)`);
    const newer = record.versions[at - 1]?.version;
    if (newer && !satisfies(newer, `>${item.version}`)) fail(name, `versions must be listed newest first: ${newer} comes before ${item.version}`);
    if (!item.archive?.startsWith('https://')) fail(name, `${item.version}: archive must be an https address`);
    const archive = await download(item.archive);
    const inspected = await inspect(archive);
    if (inspected.manifest.id !== record.id || inspected.manifest.version !== item.version) fail(name, `${item.archive} is ${inspected.manifest.id} ${inspected.manifest.version}`);
    if (inspected.integrity !== item.integrity) fail(name, `${item.version}: the archive's integrity is ${inspected.integrity}, not ${item.integrity}`);
    versions.push(release(inspected.manifest, inspected, item.date, item.archive, archive.length));
    latest ??= { manifest: inspected.manifest, inspected };
  }
  const readme = record.readme ? (await download(record.readme)).toString('utf8') : '';
  return {
    id: record.id, origin: 'registry', source: record.source, license: record.license ?? '', manifest: latest!.manifest,
    ...(record.readme ? readmeOf(readme, record.readme.replace(/[^/]*$/, '')) : {}),
    assets: await assetsOf(latest!.manifest, latest!.inspected.file), versions,
  };
}

async function builtin(): Promise<Entry[]> {
  return Promise.all(builtinPlugins.map(async plugin => {
    const manifest = JSON.parse(JSON.stringify(plugin.manifest)) as Manifest;
    const name = manifest.id.split('.').pop();
    const samples: Record<string, string> = {};
    // Avatar styles are generated: the page shows one sample of each.
    if (manifest.contributes?.avatarStyles?.length) {
      const provided = await plugin.activate({} as never, {} as never) as { avatarStyles?: Record<string, { generate(input: object): string | Promise<string> }> };
      for (const style of manifest.contributes.avatarStyles) {
        const generate = provided.avatarStyles?.[style.id];
        if (generate) samples[style.id] = await generate.generate({ seed: 'riffet', size: 96, ink: '#15171a', paper: '#eae7e1', name: 'Riffet' });
      }
    }
    return {
      id: manifest.id, origin: 'builtin', source: `${repository}/tree/main/plugins/riffet/${name}`, license: 'Apache-2.0', manifest,
      assets: await assetsOf(manifest, () => undefined, samples), versions: [{ version: manifest.version, date: gitDate(`plugins/riffet/${name}`) }],
    } satisfies Entry;
  }));
}

/** Installs pin a release by its integrity, so one the published index lists may not change content under the same version. */
async function keepsPublished(plugins: Entry[]): Promise<void> {
  if (published === 'none') return;
  let index: { plugins?: Array<{ id: string; versions?: Version[] }> };
  try { index = JSON.parse((await download(published)).toString('utf8')) as typeof index; }
  catch (error) { console.warn(`not checked against ${published}: ${error instanceof Error ? error.message : String(error)}`); return; }
  const before = new Map((index.plugins ?? []).flatMap(entry => (entry.versions ?? []).map(item => [`${entry.id}@${item.version}`, item.integrity] as const)));
  for (const entry of plugins) for (const item of entry.versions) {
    const was = before.get(`${entry.id}@${item.version}`);
    if (was && item.integrity && was !== item.integrity) throw new Error(`${entry.id} ${item.version} is already published with other content; give the package a new version`);
  }
}

async function main(): Promise<void> {
  await rm(out, { recursive: true, force: true });
  await cp(join(root, 'site'), out, { recursive: true, filter: source => !source.startsWith(registry) });
  await mkdir(assetsDir, { recursive: true });
  await mkdir(packagesDir, { recursive: true });
  const plugins: Entry[] = [];
  for (const name of (await readdir(registry)).filter(item => item.endsWith('.json')).sort()) {
    const record = JSON.parse(await readFile(join(registry, name), 'utf8'));
    const entry = 'path' in record ? await local(name, record) : await external(name, record);
    if (`${entry.id}.json` !== name) fail(name, `the file must be named ${entry.id}.json`);
    plugins.push(entry);
  }
  plugins.push(...await builtin());
  const seen = new Set<string>();
  for (const entry of plugins) { if (seen.has(entry.id)) throw new Error(`${entry.id} is listed twice`); seen.add(entry.id); }
  await rm(join(out, '.inspect'), { recursive: true, force: true });
  await keepsPublished(plugins);
  await writeFile(join(out, 'plugins/index.json'), JSON.stringify({ schemaVersion: 1, generated: new Date().toISOString(), plugins }));
  console.log(`${out}: ${plugins.length} plugins`);
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
