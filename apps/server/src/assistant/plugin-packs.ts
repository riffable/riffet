import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { ASSISTANT_BUDGET } from '../../../../packages/contracts/src/budgets.js';
import { builtInPackIds, PACK_ID } from './packs.js';
import { commitAssistantHome } from './home.js';

/*
 * Capability packs a plugin ships (docs/ASSISTANT.md §8.2). While the plugin is enabled its folder
 * (`contributes.assistantPack`) is copied into the 助理's `packs/<name>/`, where the CLI reads it like any other pack. `name` is the
 * `name` of the folder's `.claude-plugin/plugin.json`. The copy carries a marker naming the plugin, its version and a digest of the
 * files; the marker is what tells such a pack from the owner's, so a sync only ever replaces or removes folders it made.
 */

export const PLUGIN_PACK_MARKER = '.riffet-plugin.json';
const PACKS_DIR = 'packs';

export interface PluginPackSource { pluginId: string; version: string; root: string; path: string }
interface Marker { pluginId: string; version: string; digest: string }
interface Pack { name: string; files: Array<{ path: string; data: Buffer }>; digest: string }

export interface PluginPackSync {
  /** Whether a folder was written or removed, so the main conversation's CLI must restart to see it. */
  changed: boolean;
  /** Why a plugin's pack was not installed, by plugin id. */
  problems: Map<string, string>;
}

export function pluginPackMarker(dir: string): Marker | undefined {
  try {
    const value = JSON.parse(readFileSync(join(dir, PLUGIN_PACK_MARKER), 'utf8')) as Partial<Marker>;
    return typeof value.pluginId === 'string' && typeof value.version === 'string' && typeof value.digest === 'string' ? { pluginId: value.pluginId, version: value.version, digest: value.digest } : undefined;
  } catch { return undefined; }
}

/** The pack folder as a list of plain files; anything else (links, devices) or too much is refused. */
function readPack(root: string, path: string): Pack {
  const base = resolve(root, path);
  if (!base.startsWith(resolve(root) + sep)) throw new Error('the pack folder leaves the package');
  // A linked `assets/` or pack folder would bring files from outside the package; entries inside are checked one by one below.
  if (!realpathSync(base).startsWith(realpathSync(root) + sep)) throw new Error('the pack folder leaves the package');
  const files: Pack['files'] = [];
  let total = 0;
  const walk = (relative: string, depth: number): void => {
    if (depth > 8) throw new Error('the pack folder is nested too deeply');
    for (const name of readdirSync(join(base, relative)).sort()) {
      const file = relative ? `${relative}/${name}` : name;
      const info = lstatSync(join(base, file));
      if (info.isDirectory()) { walk(file, depth + 1); continue; }
      if (!info.isFile()) throw new Error(`${file} is not a plain file`);
      total += info.size;
      if (files.length >= ASSISTANT_BUDGET.packFiles || total > ASSISTANT_BUDGET.packBytes) throw new Error(`the pack is over ${ASSISTANT_BUDGET.packFiles} files or ${ASSISTANT_BUDGET.packBytes} bytes`);
      files.push({ path: file, data: readFileSync(join(base, file)) });
    }
  };
  walk('', 0);
  const manifest = files.find(file => file.path === '.claude-plugin/plugin.json');
  if (!manifest) throw new Error('the pack folder has no .claude-plugin/plugin.json');
  let name: unknown;
  try { name = (JSON.parse(manifest.data.toString('utf8')) as { name?: unknown }).name; } catch { throw new Error('.claude-plugin/plugin.json is not valid JSON'); }
  if (typeof name !== 'string' || !PACK_ID.test(name)) throw new Error('.claude-plugin/plugin.json needs a "name" of lowercase letters, digits and hyphens (at most 40 characters)');
  const hash = createHash('sha256');
  for (const file of files) hash.update(file.path).update('\0').update(file.data).update('\0');
  return { name, files, digest: hash.digest('hex') };
}

/** Whether a folder in `packs/` is a pack a plugin installed (its marker), by plugin id. */
function marked(cwd: string): Array<{ name: string; marker: Marker }> {
  const root = join(cwd, PACKS_DIR);
  let names: string[] = [];
  try { names = readdirSync(root).filter(name => !name.startsWith('.')); } catch { return []; }
  return names.flatMap(name => { const marker = pluginPackMarker(join(root, name)); return marker ? [{ name, marker }] : []; });
}

/**
 * Makes `packs/` hold exactly the packs of [sources], the enabled plugins' (those whose plugin is off, uninstalled or no
 * longer declares a pack lose theirs): installs new ones, replaces a changed one (another version or other content), removes the
 * rest, then commits. A pack named like one of Riffet's own, the owner's, or another plugin's is not installed; the reason is returned.
 */
export async function syncPluginPacks(cwd: string, sources: readonly PluginPackSource[], builtIn: readonly string[] = builtInPackIds()): Promise<PluginPackSync> {
  const problems = new Map<string, string>();
  const wanted = new Map<string, { source: PluginPackSource; pack: Pack }>();
  for (const source of sources) {
    try {
      const pack = readPack(source.root, source.path);
      const holder = wanted.get(pack.name);
      if (builtIn.includes(pack.name)) throw new Error(`the pack name "${pack.name}" is one of Riffet's own packs`);
      if (holder) throw new Error(`the pack name "${pack.name}" is already provided by ${holder.source.pluginId}`);
      wanted.set(pack.name, { source, pack });
    } catch (error) { problems.set(source.pluginId, `assistant pack not installed: ${error instanceof Error ? error.message : String(error)}`); }
  }
  let changed = false;
  const root = join(cwd, PACKS_DIR);
  for (const { name, marker } of marked(cwd)) {
    const keep = wanted.get(name);
    if (keep?.source.pluginId === marker.pluginId) continue;
    rmSync(join(root, name), { recursive: true, force: true });
    changed = true;
  }
  for (const [name, { source, pack }] of wanted) {
    const dir = join(root, name);
    const existing = pluginPackMarker(dir);
    if (existing && existing.pluginId === source.pluginId && existing.version === source.version && existing.digest === pack.digest) continue;
    let occupied = false;
    try { lstatSync(dir); occupied = true; } catch { /* free */ }
    if (occupied && existing?.pluginId !== source.pluginId) { problems.set(source.pluginId, `assistant pack not installed: packs/${name} already exists and is not this plugin's`); continue; }
    // Written beside it and moved in, so the CLI never reads half of a pack.
    const staging = join(root, `.${name}.staging`);
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    for (const file of pack.files) {
      const target = join(staging, file.path);
      mkdirSync(join(target, '..'), { recursive: true, mode: 0o700 });
      writeFileSync(target, file.data, { mode: 0o600 });
    }
    writeFileSync(join(staging, PLUGIN_PACK_MARKER), `${JSON.stringify({ pluginId: source.pluginId, version: source.version, digest: pack.digest } satisfies Marker, null, 2)}\n`, { mode: 0o600 });
    rmSync(dir, { recursive: true, force: true });
    renameSync(staging, dir);
    changed = true;
  }
  if (changed) await commitAssistantHome(cwd);
  return { changed, problems };
}
