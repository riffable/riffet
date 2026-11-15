#!/usr/bin/env node
// Layers of the server (apps/server/src), lowest first. A file imports its own module and lower layers only:
//
//   base       errors, process environment, identity helpers, metrics; knows nothing of sessions
//   kernel     sessions and runs (store), delivery (native), journal, timeline, sync, the driver seam
//              (backends/*.ts), terminals, settings; names no concrete backend
//   kit        backends/shared/ and adapters/: what drivers are built from (child processes, hooks, waits)
//   drivers    backends/<name>/: one CLI each, written against the kernel's seam
//   features   git, workspace, orchestration, shares, stats, search, tasks, extensions, plugins, …
//   surfaces   routes and channels: protocol translation
//   root       app.ts and the CLI: the only place that names every module
//
// Drivers and features are one layer. Base, kernel, kit and root modules may import one another; a driver,
// a feature or a surface imports no other module of its own layer: a driver does not reach into another
// driver or a feature, a feature does not reach into another feature. What they need of each other is
// handed in by the root.
//
// Also: apps/server and apps/web do not import each other; what both need lives in packages/.
//
// What breaks these rules today is counted per module pair in scripts/layers-baseline.json: the number of
// files of the other module the pair reaches into. A pair may not grow and a new pair may not appear.
// (Files, not import statements: splitting a file in two does not add a dependency.)
//
//   node scripts/check-layers.mjs            exit 1 and list the imports past the baseline
//   node scripts/check-layers.mjs --update   lower the baseline (it never raises an entry)
//   node scripts/check-layers.mjs --update --add '<from> -> <to>'   also record that pair at its current count
//   node scripts/check-layers.mjs --list     print every counted file and the imports behind it, grouped by pair
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = 'apps/server/src/';
const WEB = 'apps/web/src/';
const baselinePath = join(root, 'scripts/layers-baseline.json');
const update = process.argv.includes('--update');
const list = process.argv.includes('--list');
const added = new Set(process.argv.flatMap((arg, at, all) => (arg === '--add' && all[at + 1] ? [all[at + 1]] : [])));
if (added.size && !update) {
  console.error('layers: --add only works with --update');
  process.exit(2);
}

// A module is a directory or a top-level file of apps/server/src; `backends/` is three kinds of module.
const LAYERS = [
  ['base', ['errors.ts', 'exec.ts', 'version.ts', 'environment.ts', 'compat.ts', 'server-log.ts', 'server-id.ts', 'mdns-name.ts',
    'connection-addresses.ts', 'discovery.ts', 'service-files.ts', 'loop-health.ts', 'pairing.ts', 'auth.ts',
    'clientLogs.ts', 'wal-checkpoint.ts', 'session-identity.ts', 'session-title.ts', 'metrics', 'prompts']],
  ['kernel', ['store.ts', 'journal', 'timeline', 'sync', 'native', 'backends', 'agent-host', 'terminal', 'settings', 'auxiliary']],
  ['kit', ['backends/shared', 'adapters']],
  ['drivers', ['backends/*']],
  ['features', ['git', 'workspace', 'task-workspaces', 'orchestration', 'shares', 'stats', 'search', 'tasks', 'extensions',
    'titles', 'turn-summary', 'context-references', 'chat', 'marks.ts', 'work-items', 'owner', 'appearance', 'themes', 'previews', 'push',
    'plugins', 'plugins-host', 'riffet-mcp', 'monitor.ts', 'system.ts', 'session-deletion.ts', 'update.ts', 'update-npm.ts',
    'visualization.ts', 'static-assets.ts', 'math-assets.ts', 'diagram-assets.ts']],
  ['surfaces', ['routes', 'channels']],
  ['root', ['app.ts', 'index.ts', 'cli.ts', 'cli-drain.ts', 'cli-pairing.ts', 'cli-plugins.ts', 'cli-resume.ts', 'cli-update.ts', 'doctor.ts']],
];
// Drivers and features are one rank: neither is below the other.
const RANK = { base: 0, kernel: 1, kit: 2, drivers: 3, features: 3, surfaces: 4, root: 5 };
/** Layers whose modules may import one another. */
const OPEN = new Set(['base', 'kernel', 'kit', 'root']);
const layerOf = new Map(LAYERS.flatMap(([layer, modules]) => modules.map(module => [module, layer])));

const posix = path => path.split(sep).join('/');
/** The module a server-relative path belongs to. */
function moduleOf(path) {
  const parts = path.split('/');
  if (parts.length === 1) return parts[0];
  if (parts[0] !== 'backends' || parts.length === 2) return parts[0];
  return parts[1] === 'shared' ? 'backends/shared' : `backends/${parts[1]}`;
}
const layerOfModule = module => layerOf.get(module) ?? (module.startsWith('backends/') ? layerOf.get('backends/*') : undefined);

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'apps/server/src', 'apps/web/src'], { cwd: root, encoding: 'utf8' })
  .split('\n').filter(file => /\.(?:[cm]?[jt]s|tsx)$/.test(file) && !/\.test\.[jt]sx?$/.test(file));

const problems = [];
/** `<from> -> <to>` to the files it imports there, each with the import sites behind it. */
const pairs = new Map();
const count = (pair, target, site) => {
  const targets = pairs.get(pair) ?? new Map();
  targets.set(target, [...(targets.get(target) ?? []), site]);
  pairs.set(pair, targets);
};

for (const file of files) {
  let text;
  try { text = readFileSync(resolve(root, file), 'utf8'); } catch { continue; }
  const inServer = file.startsWith(SERVER);
  const from = inServer ? moduleOf(file.slice(SERVER.length)) : undefined;
  const fromLayer = from === undefined ? undefined : layerOfModule(from);
  if (inServer && fromLayer === undefined) {
    problems.push(`${file}: module \`${from}\` has no layer; add it to LAYERS in scripts/check-layers.mjs`);
    continue;
  }
  for (const { fileName: specifier } of ts.preProcessFile(text, true, true).importedFiles) {
    if (!specifier.startsWith('.')) continue;
    const target = posix(relative(root, resolve(root, dirname(file), specifier)));
    const site = `${file} (${specifier})`;
    if (!inServer) {
      if (target.startsWith('apps/server/')) count('apps/web -> apps/server', target, site);
      continue;
    }
    if (target.startsWith('apps/web/')) { count('apps/server -> apps/web', target, site); continue; }
    if (!target.startsWith(SERVER)) continue;
    const to = moduleOf(target.slice(SERVER.length).replace(/\.[cm]?js$/, '.ts'));
    if (to === from) continue;
    const toLayer = layerOfModule(to);
    // A target outside the listed modules is an asset or a directory with no code; its importer is judged when code appears there.
    if (toLayer === undefined) continue;
    const lower = RANK[toLayer] < RANK[fromLayer];
    const peers = toLayer === fromLayer && OPEN.has(fromLayer);
    if (!lower && !peers) count(`${from} -> ${to}`, target, site);
  }
}

const counts = Object.fromEntries([...pairs].map(([pair, targets]) => [pair, targets.size]));
const sitesOf = targets => [...targets].sort(([a], [b]) => a.localeCompare(b)).map(([target, sites]) => `  ${target}\n${sites.map(site => `    ${site}`).join('\n')}`).join('\n');
const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {};
const describe = pair => {
  if (pair.startsWith('apps/')) return 'the server and the web app share code through packages/';
  const [from, to] = pair.split(' -> ');
  const [a, b] = [layerOfModule(from), layerOfModule(to)];
  return RANK[a] === RANK[b] ? `${a === b ? `${a} do` : `${a} and ${b} do`} not import one another` : `${a} may not import ${b}`;
};

if (list) {
  for (const [pair, targets] of [...pairs].sort(([a], [b]) => a.localeCompare(b))) console.log(`${pair}  (${describe(pair)})\n${sitesOf(targets)}`);
} else if (update) {
  const next = {};
  for (const [pair, current] of Object.entries(counts)) {
    if (pair in baseline) next[pair] = Math.min(baseline[pair], current);
    else if (added.has(pair)) next[pair] = current;
  }
  for (const pair of added) if (!(pair in counts)) console.warn(`layers: --add ${pair}: no such import, nothing recorded`);
  const sorted = Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(baselinePath, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`layers: baseline written (${Object.keys(sorted).length} pairs, ${Object.values(sorted).reduce((sum, n) => sum + n, 0)} imported files)`);
} else {
  for (const [pair, targets] of pairs) {
    const limit = baseline[pair] ?? 0;
    if (targets.size > limit) problems.push(`${pair}: ${targets.size} files imported, baseline ${limit} — ${describe(pair)}\n${sitesOf(targets)}`);
  }
  const lowered = Object.entries(baseline).filter(([pair, limit]) => (counts[pair] ?? 0) < limit);
  if (lowered.length && !problems.length) console.log(`layers: ${lowered.length} pair(s) now below the baseline; run with --update to lock it in`);
}

if (problems.length) {
  console.error(problems.join('\n'));
  console.error('\nlayers: pass what the lower module needs as a parameter from app.ts, or move the shared piece down a layer.');
  process.exit(1);
}
if (!list && !update) console.log(`layers: hold (${files.length} files, ${Object.keys(baseline).length} baseline pairs, ${Object.values(baseline).reduce((sum, n) => sum + n, 0)} imported files).`);
