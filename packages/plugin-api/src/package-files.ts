import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
export const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
export const MAX_UNPACKED_BYTES = 96 * 1024 * 1024;
export const MAX_FILES = 4000;
const MAX_DEPTH = 16;
const MAX_PATH = 256;
export interface PackageFile { path: string; data: Buffer; executable: boolean }
const invalid = (message: string) => Object.assign(new Error(message), { code: 'PLUGIN_PACKAGE_INVALID', statusCode: 422 });

export function normalizeEntryPath(raw: string): string {
  const path = raw.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
  if (!path || path.length > MAX_PATH || /[\\\0-\x1f\x7f]/.test(path) || path.startsWith('/') || /^[a-z]:/i.test(path)) throw invalid(`the archive has an entry with an invalid path: ${JSON.stringify(raw.slice(0, 80))}`);
  const parts = path.split('/');
  if (parts.length > MAX_DEPTH || parts.some(part => part === '' || part === '.' || part === '..')) throw invalid(`the archive has an entry that leaves the package: ${JSON.stringify(raw.slice(0, 80))}`);
  return path;
}

export async function readDirectory(directory: string): Promise<PackageFile[]> {
  const root = await realpath(directory);
  const files: PackageFile[] = [];
  let total = 0;
  const walk = async (relative: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) throw invalid('the directory is nested too deeply');
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      normalizeEntryPath(path);
      const full = join(root, path);
      const info = await lstat(full);
      if (info.isDirectory()) { await walk(path, depth + 1); continue; }
      if (!info.isFile()) throw invalid(`${path} is not a plain file; links and devices are not allowed`);
      total += info.size;
      if (files.length >= MAX_FILES || total > MAX_UNPACKED_BYTES) throw invalid('the directory is too large');
      files.push({ path, data: await readFile(full), executable: (info.mode & 0o100) !== 0 });
    }
  };
  await walk('', 0);
  if (!files.length) throw invalid('the directory is empty');
  return files;
}

export function integrityOf(files: readonly PackageFile[]): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(`${file.path}\0${file.executable ? 'x' : '-'}\0${file.data.length}\0`);
    hash.update(createHash('sha256').update(file.data).digest());
  }
  return `sha256-${hash.digest('hex')}`;
}
