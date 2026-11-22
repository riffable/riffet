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
// Pages replaces the whole site, so older archives and their index entries are carried forward.

import { execFileSync } from 'node:child_process';
import { cp, mkdir, rm } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { assetsOf, buildRegistry, writeIndex, type IndexEntry, type PathRecord } from '../apps/server/src/plugins-host/index-builder.js';
import { builtinPlugins } from '../plugins/index.js';
import { DEFAULT_PLUGIN_INDEX } from '../apps/server/src/plugins-host/market.js';

const root = resolve(import.meta.dirname, '..');
const outFlag = process.argv.indexOf('--out');
const out = resolve(root, outFlag >= 0 ? process.argv[outFlag + 1]! : 'dist/site');
const publishedFlag = process.argv.indexOf('--published');
const published = publishedFlag >= 0 ? process.argv[publishedFlag + 1]! : DEFAULT_PLUGIN_INDEX;
const repository = 'https://github.com/riffable/riffet';
const registry = join(root, 'site/plugins/registry');
const pluginsDir = join(out, 'plugins');

const gitDate = (path: string) => execFileSync('git', ['log', '-1', '--format=%ad', '--date=short', '--', path], { cwd: root, encoding: 'utf8' }).trim() || new Date().toISOString().slice(0, 10);

/** The page shows HTML made here from the README Markdown: raw HTML dropped, only safe link protocols kept (react-markdown's defaults). Clients render the Markdown with their own renderer. */
const html = (readme: string) => renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [remarkGfm], urlTransform: defaultUrlTransform }, readme));

async function builtin(): Promise<IndexEntry[]> {
  return Promise.all(builtinPlugins.map(async plugin => {
    const manifest = JSON.parse(JSON.stringify(plugin.manifest)) as Record<string, any>;
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
      assets: await assetsOf(pluginsDir, manifest, () => undefined, samples), versions: [{ version: manifest.version, date: gitDate(`plugins/riffet/${name}`) }],
    } satisfies IndexEntry;
  }));
}

async function main(): Promise<void> {
  await rm(out, { recursive: true, force: true });
  await cp(join(root, 'site'), out, { recursive: true, filter: source => !source.startsWith(registry) });
  await mkdir(pluginsDir, { recursive: true });
  const plugins = await buildRegistry({
    registry, out: pluginsDir, published, carryForward: true, strictPublished: true,
    directory: (record: PathRecord, name) => {
      const directory = resolve(root, record.path);
      if (relative(root, directory).startsWith('..')) throw new Error(`${name}: path must be inside this repository`);
      return directory;
    },
    describe: record => ({ source: `${repository}/tree/main/${record.path}`, date: gitDate(record.path), readmeBase: `${repository}/blob/main/${record.path}/` }),
    html,
  });
  const builtins = await builtin();
  const seen = new Set(plugins.map(entry => entry.id));
  for (const entry of builtins) { if (seen.has(entry.id)) throw new Error(`${entry.id} is listed twice`); seen.add(entry.id); }
  await writeIndex(pluginsDir, { plugins: [...plugins, ...builtins], page: './' });
  console.log(`${out}: ${plugins.length + builtins.length} plugins`);
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
