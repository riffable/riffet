import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { delimiter, extname, join, posix, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Plugin, PluginManifest } from '@riffet/plugin-api';
import { ASSISTANT_PACK_NAME } from '../../../../packages/contracts/src/index.js';
import { isPackagePath } from './declarations.js';

// Trusted local development packages (docs/PLUGIN_ARCHITECTURE.md): a directory named in
// `RIFFET_DEV_PLUGINS` holding `riffet-plugin.json`. The server imports its entry as application
// code when the plugin is first detected or activated, so listing a directory is the same trust decision as installing it.

export const MANIFEST_FILE = 'riffet-plugin.json';
const MAX_MANIFEST_BYTES = 256 * 1024;
const SERVER_ENTRY = /\.(?:[cm]?js|[cm]?ts)$/;
// Node retains ESM modules after uninstall. Refuse replacing an imported version's bytes in the
// same process: query strings alone cannot invalidate that entry's relative module imports.
const importedPackages = new Map<string, string>();

/** What `GET /api/integrations/:id/files/*` may serve. */
const FILE_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
};

export interface DevelopmentPackage { plugin: Plugin; root: string; entries: { server?: string; web?: string } }
export interface DevelopmentFailure { id: string; vendor: string; name: string; reason: string }

export function developmentDirectories(value = process.env.RIFFET_DEV_PLUGINS): string[] {
  return [...new Set((value ?? '').split(delimiter).map(item => item.trim()).filter(Boolean).map(item => resolve(item)))];
}

/** The real path of `relative` under `root` when it is a file there, following links only where they stay inside. */
export async function confined(root: string, relative: string): Promise<string | undefined> {
  const path = resolve(root, relative);
  if (!path.startsWith(root + sep)) return undefined;
  const file = await realpath(path).catch(() => undefined);
  if (!file || !file.startsWith(root + sep) || !(await stat(file).catch(() => undefined))?.isFile()) return undefined;
  return file;
}

/** `sha256-<hex>` of one file of a package, for a client that checks what it was served. */
export async function fileIntegrity(root: string, relative: string): Promise<string> {
  const file = await confined(root, relative);
  if (!file) throw new Error(`${relative} is not a file in the package`);
  return `sha256-${createHash('sha256').update(await readFile(file)).digest('hex')}`;
}

export function failure(directory: string, manifest: Record<string, unknown> | undefined, reason: string): DevelopmentFailure {
  const text = (value: unknown, fallback: string) => typeof value === 'string' && value ? value : fallback;
  const name = directory.split(sep).filter(Boolean).at(-1) ?? directory;
  return { id: text(manifest?.id, name), vendor: text(manifest?.vendor, ''), name: text(manifest?.name, name), reason };
}

/** Why a capability pack folder of the package cannot be installed into the 助理, if it cannot: it needs `.claude-plugin/plugin.json` with a usable `name`. */
export async function assistantPackProblem(root: string, path: unknown): Promise<string | undefined> {
  if (!isPackagePath(path) || !path.startsWith('assets/')) return 'contributes.assistantPack.path must be a folder under assets/';
  const file = await confined(root, `${path}/.claude-plugin/plugin.json`);
  if (!file) return `${path}/.claude-plugin/plugin.json is not a file in the package`;
  try {
    const name = (JSON.parse(await readFile(file, 'utf8')) as { name?: unknown }).name;
    return typeof name === 'string' && ASSISTANT_PACK_NAME.test(name) ? undefined : `${path}/.claude-plugin/plugin.json needs a "name" of lowercase letters, digits and hyphens (at most 40 characters)`;
  } catch { return `${path}/.claude-plugin/plugin.json is not valid JSON`; }
}

export interface PackageManifest { root: string; manifest: PluginManifest; entries: { server?: string; web?: string } }

/** Reads and validates a package directory's `riffet-plugin.json` and its entry paths without running anything: what a development package and an installed one share. */
export async function readPackage(directory: string): Promise<PackageManifest | DevelopmentFailure> {
  let root: string;
  try { root = await realpath(directory); if (!(await stat(root)).isDirectory()) throw new Error('not a directory'); }
  catch { return failure(directory, undefined, 'the directory does not exist'); }
  let manifest: Record<string, unknown> | undefined;
  const file = await confined(root, MANIFEST_FILE);
  if (!file) return failure(root, undefined, `${MANIFEST_FILE} is missing`);
  try {
    const text = await readFile(file, 'utf8');
    if (text.length > MAX_MANIFEST_BYTES) throw new Error('too large');
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    manifest = parsed as Record<string, unknown>;
  } catch (error) { return failure(root, undefined, `${MANIFEST_FILE} is unreadable: ${error instanceof Error ? error.message : String(error)}`); }
  const fail = (reason: string) => failure(root, manifest, reason);

  for (const key of ['id', 'vendor', 'name'] as const) if (typeof manifest[key] !== 'string' || !manifest[key]) return fail(`${key} must be text`);
  if (manifest.defaultEnabled !== 'auto' && typeof manifest.defaultEnabled !== 'boolean') return fail('defaultEnabled must be auto, true or false');
  const { entries: declared, ...rest } = manifest;
  if (declared !== undefined && (!declared || typeof declared !== 'object' || Array.isArray(declared))) return fail('entries must be an object');
  const entries: PackageManifest['entries'] = {};
  for (const key of ['server', 'web'] as const) {
    const path = (declared as Record<string, unknown> | undefined)?.[key];
    if (path === undefined) continue;
    if (!isPackagePath(path)) return fail(`entries.${key} must be a path inside the package`);
    if (!await confined(root, path)) return fail(`entries.${key} is not a file inside the package`);
    if (key === 'server' && !SERVER_ENTRY.test(path)) return fail('entries.server must be a JavaScript or TypeScript module');
    entries[key] = path;
  }
  const pack = (rest as { contributes?: { assistantPack?: { path?: unknown } } }).contributes?.assistantPack;
  if (pack) { const problem = await assistantPackProblem(root, pack.path); if (problem) return fail(problem); }
  return { root, manifest: rest as unknown as PluginManifest, entries };
}

/**
 * Validates the package without running it. Its server entry is imported the first time something needs it, which is
 * detection or an activation, so a package that is off, or only listed, never runs (design §3). A package without an entry only declares.
 */
export async function loadDevelopmentPackage(directory: string, options: { cacheDir?: string } = {}): Promise<DevelopmentPackage | DevelopmentFailure> {
  const read = await readPackage(directory);
  if ('reason' in read) return read;
  const { root, manifest, entries } = read;
  return { plugin: packagePlugin(root, manifest, entries, undefined, options.cacheDir), root, entries };
}

/** Fresh content paths invalidate entry and transitive ESM imports after a rebuild. */
async function developmentSnapshot(root: string, cache: string, id: string): Promise<string> {
  const files: Array<{ path: string; bytes: Buffer; mode: number }> = [];
  let size = 0;
  const visit = async (relative: string): Promise<void> => {
    for (const name of (await readdir(resolve(root, relative))).sort()) {
      if (['node_modules', '.git', '.riffet', '.cache'].includes(name) || /\.(?:tgz|zip|tar(?:\.gz)?)$/.test(name)) continue;
      const path = relative ? `${relative}/${name}` : name;
      const info = await lstat(resolve(root, path));
      if (info.isDirectory()) await visit(path);
      else if (info.isFile()) {
        if (files.length >= 4000 || (size += info.size) > 96 * 1024 * 1024) throw new Error('the development package is too large to reload');
        files.push({ path, bytes: await readFile(resolve(root, path)), mode: info.mode & 0o777 });
      } else if (!info.isSymbolicLink()) throw new Error(`development reload cannot snapshot ${path}: only regular files are supported`);
    }
  };
  await visit('');
  const hash = createHash('sha256');
  for (const file of files) hash.update(file.path).update('\0').update(String(file.mode)).update('\0').update(file.bytes);
  const parent = resolve(cache, id);
  const destination = resolve(parent, hash.digest('hex'));
  if (!(await stat(destination).catch(() => undefined))?.isDirectory()) {
    const temporary = `${destination}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await mkdir(temporary, { recursive: true, mode: 0o700 });
    try {
      for (const file of files) {
        const target = resolve(temporary, file.path);
        await mkdir(resolve(target, '..'), { recursive: true });
        await writeFile(target, file.bytes, { mode: file.mode });
        await chmod(target, file.mode);
      }
      const modules = resolve(root, 'node_modules');
      if ((await stat(modules).catch(() => undefined))?.isDirectory()) await symlink(modules, resolve(temporary, 'node_modules'), 'junction');
      await rename(temporary, destination);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  const previous = await Promise.all((await readdir(parent, { withFileTypes: true })).filter(entry => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name) && resolve(parent, entry.name) !== destination).map(async entry => ({ path: resolve(parent, entry.name), modified: (await stat(resolve(parent, entry.name))).mtimeMs })));
  for (const old of previous.sort((a, b) => b.modified - a.modified).slice(2)) await rm(old.path, { recursive: true, force: true });
  return destination;
}

/** Application code loaded only after the host has established trust in this directory/version. */
export function packagePlugin(root: string, manifest: PluginManifest, entries: PackageManifest['entries'], integrity?: string, cacheDir?: string): Plugin {
  const plugin = { manifest, activate: () => ({}) } as Plugin;
  if (entries.server) {
    const file = resolve(root, entries.server);
    let loaded: Promise<Partial<Plugin>> | undefined;
    const entry = (): Promise<Partial<Plugin>> => loaded ??= (async () => {
      try {
        if (integrity) {
          const previous = importedPackages.get(root);
          if (previous && previous !== integrity) throw new Error('this package version was already imported with different content; use a new version or restart Riffet');
          importedPackages.set(root, integrity);
        }
        const freshRoot = cacheDir ? await developmentSnapshot(root, cacheDir, manifest.id) : undefined;
        process.setSourceMapsEnabled(true);
        const exported = ((await import(pathToFileURL(freshRoot ? resolve(freshRoot, entries.server!) : file).href)) as { default?: unknown }).default as Partial<Plugin> | undefined;
        if (!exported || typeof exported.activate !== 'function' || (exported.detect !== undefined && typeof exported.detect !== 'function')) throw new Error('the server entry must export default { detect?, activate }');
        // The manifest file is the one the registry validated; an entry that carries its own may only agree with it.
        if (exported.manifest && exported.manifest.id !== manifest.id) throw new Error('the server entry names a different id than the manifest');
        return exported;
      } catch (error) {
        loaded = undefined;
        throw new Error(error instanceof Error && error.message.startsWith('the server entry') ? error.message : `the server entry failed to load: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
    plugin.detect = async host => { const exported = await entry(); return exported.detect ? exported.detect.call(exported, host) : false; };
    plugin.activate = async (host, scope) => { const exported = await entry(); return exported.activate!.call(exported, host, scope); };
  }
  return plugin;
}

/** Directories of a package that hold what a client may be given besides what the manifest names. */
const STATIC_DIRECTORIES = ['assets/', 'web/'];

/**
 * A file of a development or installed package that a client may fetch, when it stays inside `root` and is of a type that may be
 * served: the web entry (a script bundled to run on its own, whatever its extension), the files the declarations name, and what
 * sits under `assets/` or `web/`. Server code never leaves: not the server entry, not anything else outside those places.
 */
export async function developmentFile(root: string, path: string, allow: { web?: string; server?: string; declared?: readonly string[] } = {}): Promise<{ file: string; type: string } | undefined> {
  if (path.includes('\0') || path.split('/').some(part => part === '..')) return undefined;
  const relative = posix.normalize(path);
  if (allow.server !== undefined && relative === posix.normalize(allow.server)) return undefined;
  const web = allow.web !== undefined && relative === posix.normalize(allow.web);
  if (!web && !allow.declared?.includes(relative) && !STATIC_DIRECTORIES.some(directory => relative.startsWith(directory))) return undefined;
  const type = FILE_TYPES[web && /\.m?js$/i.test(relative) ? '.js' : extname(relative).toLowerCase()];
  if (!type) return undefined;
  const file = await confined(root, join('.', relative));
  return file ? { file, type } : undefined;
}
