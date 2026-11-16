import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AssistantPack } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import { assistantPackFile } from '../prompts/index.js';
import { SERVER_VERSION } from '../version.js';
import { commitAssistantHome } from './home.js';

/*
 * The 助理's capability packs (docs/ASSISTANT.md §8.2). A pack is a Claude Code plugin folder under `packs/`: its
 * skills, its `memory.md` (the topic file it keeps, seeded once), and its `.mcp.json`. Riffet's own file `pack.json`
 * names it for the owner and says which command starts its work. Riffet ships some packs; adding one writes its
 * folder, and removing it deletes the folder, which the directory's history keeps. The memory topic stays.
 */

const PACKS_DIR = 'packs';
const MANIFEST = 'pack.json';
const ID = /^[a-z][a-z0-9-]{0,39}$/;

interface PackManifest { title: string; description?: string; entry?: string }

interface BuiltInPack extends PackManifest {
  id: string;
  /** Files of the folder, by path inside it. */
  files: () => Record<string, string>;
}

const BUILT_IN: readonly BuiltInPack[] = [
  {
    id: 'travel',
    title: '旅行',
    description: '规划行程，记住出行偏好',
    entry: 'plan',
    files: () => ({ 'skills/plan/SKILL.md': assistantPackFile('pack.travel.skill'), 'memory.md': assistantPackFile('pack.travel.memory') }),
  },
];

function manifestOf(dir: string): PackManifest | undefined {
  try {
    const value = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8')) as Partial<PackManifest>;
    if (typeof value.title !== 'string' || !value.title.trim()) return undefined;
    return {
      title: value.title.trim().slice(0, 40),
      ...(typeof value.description === 'string' && value.description.trim() ? { description: value.description.trim().slice(0, 200) } : {}),
      ...(typeof value.entry === 'string' && /^[\w-]+$/.test(value.entry) ? { entry: value.entry } : {}),
    };
  } catch { return undefined; }
}

function isPlugin(dir: string): boolean {
  try { return lstatSync(dir).isDirectory() && lstatSync(join(dir, '.claude-plugin', 'plugin.json')).isFile(); } catch { return false; }
}

/** Riffet's packs, added or not, then the owner's own, by name. */
export function listAssistantPacks(cwd: string): AssistantPack[] {
  const root = join(cwd, PACKS_DIR);
  let names: string[] = [];
  try { if (lstatSync(root).isDirectory()) names = readdirSync(root).filter(name => !name.startsWith('.')).sort(); } catch { /* none yet */ }
  const entry = (id: string, name?: string) => name ? `/${id}:${name}` : undefined;
  const builtIn = BUILT_IN.map((pack): AssistantPack => {
    const installed = isPlugin(join(root, pack.id));
    const manifest = installed ? manifestOf(join(root, pack.id)) ?? pack : pack;
    const command = entry(pack.id, manifest.entry);
    return { id: pack.id, title: manifest.title, ...(manifest.description ? { description: manifest.description } : {}), ...(command ? { entry: command } : {}), installed, builtIn: true };
  });
  const own = names.filter(name => !BUILT_IN.some(pack => pack.id === name) && isPlugin(join(root, name))).map((name): AssistantPack => {
    const manifest = manifestOf(join(root, name));
    const command = entry(name, manifest?.entry);
    return { id: name, title: manifest?.title ?? name, ...(manifest?.description ? { description: manifest.description } : {}), ...(command ? { entry: command } : {}), installed: true, builtIn: false };
  });
  return [...builtIn, ...own];
}

/** Writes one of Riffet's packs into the directory, replacing an earlier copy of it, and commits it. */
export async function addAssistantPack(cwd: string, id: string): Promise<AssistantPack[]> {
  const pack = BUILT_IN.find(item => item.id === id);
  if (!pack) throw new AppError('NOT_FOUND', 'No such pack', 404);
  const dir = join(cwd, PACKS_DIR, pack.id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), `${JSON.stringify({ name: pack.id, version: SERVER_VERSION, description: pack.description ?? pack.title }, null, 2)}\n`, { mode: 0o600 });
  const manifest: PackManifest = { title: pack.title, ...(pack.description ? { description: pack.description } : {}), ...(pack.entry ? { entry: pack.entry } : {}) };
  writeFileSync(join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  for (const [path, text] of Object.entries(pack.files())) {
    const file = join(dir, path);
    mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`, { mode: 0o600 });
  }
  await commitAssistantHome(cwd);
  return listAssistantPacks(cwd);
}

/** Removes a pack's folder; its memory topic file stays, and the history keeps the folder. */
export async function removeAssistantPack(cwd: string, id: string): Promise<AssistantPack[]> {
  if (!ID.test(id)) throw new AppError('INVALID_ARGUMENT', 'Invalid pack id', 400);
  const dir = join(cwd, PACKS_DIR, id);
  if (!isPlugin(dir)) throw new AppError('NOT_FOUND', 'No such pack', 404);
  rmSync(dir, { recursive: true, force: true });
  await commitAssistantHome(cwd);
  return listAssistantPacks(cwd);
}
