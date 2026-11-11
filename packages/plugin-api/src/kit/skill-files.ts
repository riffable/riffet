import { open, readdir, stat, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { NativeSlashItem } from '@riffet/contracts';

const MAX_DEPTH = 4;
const MAX_FILES_PER_ROOT = 200;
const MAX_HEADER_BYTES = 16 * 1024;

/**
 * The YAML front matter's scalar keys. Only the flat `key: value` lines skills use are read; a
 * folded value (`>` / `|`) takes its indented continuation lines, which is how long descriptions
 * are usually written.
 */
export function frontMatter(source: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  if (!match) return {};
  const values: Record<string, string> = {};
  const lines = match[1]!.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[index]!);
    if (!pair) continue;
    let value = pair[2]!.trim();
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const continued: string[] = [];
      while (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1]!)) continued.push(lines[++index]!.trim());
      value = continued.join(value.startsWith('|') ? '\n' : ' ');
    }
    values[pair[1]!] = value.replace(/^(['"])([\s\S]*)\1$/, '$2');
  }
  return values;
}

/** The first `MAX_HEADER_BYTES` of a regular file; the front matter is all that is needed. */
async function readHeader(file: string): Promise<string | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(file, 'r');
    if (!(await handle.stat()).isFile()) return undefined;
    const buffer = Buffer.alloc(MAX_HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, MAX_HEADER_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch { return undefined; }
  finally { await handle?.close().catch(() => undefined); }
}

async function findFiles(root: string, matches: (name: string) => boolean, maxDepth = MAX_DEPTH): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth || found.length >= MAX_FILES_PER_ROOT) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      if (found.length >= MAX_FILES_PER_ROOT || entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      // Skill directories are commonly symlinked in from a shared checkout.
      const isDirectory = entry.isDirectory() || (entry.isSymbolicLink() && await stat(full).then(info => info.isDirectory(), () => false));
      if (isDirectory) await walk(full, depth + 1);
      else if (matches(entry.name)) found.push(full);
    }
  };
  await walk(root, 0);
  return found;
}

/**
 * `SKILL.md` skills under each root, in root order, one per name: the first root that defines a
 * name wins, so callers list project roots before user roots. A skill without a front-matter name
 * is named after its directory. `user-invocable: false` hides it from the menu.
 */
export async function scanSkillRoots(roots: string[]): Promise<NativeSlashItem[]> {
  const items: NativeSlashItem[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    for (const file of await findFiles(root, name => name === 'SKILL.md')) {
      const header = await readHeader(file);
      if (header === undefined) continue;
      const meta = frontMatter(header);
      const name = (meta.name || basename(dirname(file))).trim();
      if (!name || seen.has(name) || meta['user-invocable'] === 'false') continue;
      seen.add(name);
      items.push({ name, kind: 'skill', path: file, ...(meta.description ? { description: meta.description } : {}) });
    }
  }
  return items;
}

/** Markdown custom commands directly in each root, named by their file name; first root wins. */
export async function scanCommandRoots(roots: string[]): Promise<NativeSlashItem[]> {
  const items: NativeSlashItem[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    for (const file of await findFiles(root, name => /\.md$/i.test(name), 0)) {
      const name = basename(file).replace(/\.md$/i, '');
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const header = await readHeader(file);
      const meta = header === undefined ? {} : frontMatter(header);
      const hint = meta['argument-hint'];
      items.push({ name, kind: 'command', path: file, ...(meta.description ? { description: meta.description } : {}), ...(hint ? { hint } : {}) });
    }
  }
  return items;
}
