import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { manifestSchema } from './manifest.js';
import { packPlugin, validatePackage, type ArchiveFormat, type Packed, type PluginPackageManifest } from './tooling.js';

export interface PluginBuildOptions { entries?: string[] }
export interface PluginBuildResult { manifest: PluginPackageManifest; directory: string; sourceDirectory: string }
export interface PluginPackOptions extends PluginBuildOptions { format?: ArchiveFormat; out?: string }
export interface PluginPackResult extends Packed, PluginBuildResult { file: string }
export interface PluginWatchOptions extends PluginBuildOptions {
  onBuild?: (result: PluginBuildResult) => void | Promise<void>;
  onError?: (error: unknown) => void;
}
export interface PluginWatcher { initial: PluginBuildResult; close: () => void }

const has = async (file: string) => (await stat(file).catch(() => undefined))?.isFile() === true;
const ignored = /(?:^|[\\/])(?:dist|node_modules|vendor|tests?|__tests__|\.git|\.DS_Store)(?:[\\/]|$)/;
const inside = (root: string, path: string) => path.startsWith(root + sep);

async function sourceFile(root: string, name: string): Promise<string> {
  const file = resolve(root, name);
  const actual = await realpath(file);
  if (!inside(root, actual) || !(await stat(actual)).isFile()) throw new Error(`${name} is not a file inside this plugin`);
  return actual;
}

async function copyResource(root: string, output: string, name: string): Promise<void> {
  const source = resolve(root, name), target = resolve(output, name);
  if (!inside(root, source) || !inside(output, target)) throw new Error(`${name} is not a path inside this plugin`);
  const info = await lstat(source).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined; });
  if (!info) return;
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, filter: async file => {
    if (ignored.test(relative(root, file))) return false;
    if ((await lstat(file)).isSymbolicLink()) throw new Error(`${relative(root, file)} must not be a symbolic link`);
    return true;
  } });
}

async function firstSource(root: string, candidates: string[]): Promise<string> {
  for (const file of candidates) if (await has(resolve(root, file))) return sourceFile(root, file);
  throw new Error(`Plugin source is missing: ${candidates.join(' or ')}`);
}

/** Build and validate in isolation, then replace the last successful package atomically. */
export async function buildPlugin(sourceDir = '.', options: PluginBuildOptions = {}): Promise<PluginBuildResult> {
  const root = await realpath(resolve(sourceDir));
  // A previously built package remains a valid input to pack/check without source scaffolding.
  if (basename(root) === 'package' && basename(dirname(root)) === 'dist') {
    const { manifest } = await validatePackage(root);
    return { manifest, directory: root, sourceDirectory: root };
  }
  const manifest = manifestSchema.parse(JSON.parse(await readFile(join(root, 'riffet-plugin.json'), 'utf8'))) as PluginPackageManifest;
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return '{}';
  })) as { dependencies?: Record<string, string>; riffetPlugin?: { build?: { entries?: Record<string, string> } } };
  const extras: Record<string, string> = { ...metadata.riffetPlugin?.build?.entries };
  for (const entry of options.entries ?? []) {
    const at = entry.indexOf('=');
    if (at <= 0 || at === entry.length - 1) throw new Error('--entry must be name=source');
    extras[entry.slice(0, at)] = entry.slice(at + 1);
  }
  if (Object.keys(extras).length && !manifest.entries?.server) throw new Error('Additional server entries require entries.server');
  for (const [name, source] of Object.entries(extras)) {
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(name) || name === '.' || name === '..') throw new Error('entry name must use lowercase letters, digits, dots or hyphens');
    if (typeof source !== 'string' || !source) throw new Error(`Invalid source for entry ${name}`);
  }
  const target = join(root, 'dist', 'package');
  await mkdir(dirname(target), { recursive: true });
  const output = await mkdtemp(join(root, 'dist', '.package-'));
  try {
    await writeFile(join(output, 'riffet-plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const resources = new Set(['assets', 'LICENSE', 'NOTICE']);
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if ((entry.isFile() || entry.isSymbolicLink())
        && (/^README(?:\.[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3})?\.md$/.test(entry.name) || entry.name === 'readme.md')) resources.add(entry.name);
    }
    for (const declaration of [...(manifest.contributes?.views ?? []), ...(manifest.contributes?.agentBackends ?? [])]) if (declaration.icon?.svg) resources.add(declaration.icon.svg);
    const appearance = manifest.contributes?.appearance;
    for (const asset of [...(appearance?.palettes ?? []), ...(appearance?.iconPacks ?? []), ...(appearance?.backgrounds ?? [])]) resources.add(asset.asset);
    for (const font of appearance?.fonts ?? []) for (const file of font.files) resources.add(file.path);
    for (const resource of resources) await copyResource(root, output, resource);
    if (manifest.entries?.server) {
      const { build } = await import('esbuild');
      const entryName = manifest.entries.server.replace(/\.[^.]+$/, '');
      const source = await firstSource(root, ['index.ts', 'index.mts', 'index.tsx', 'index.mjs', 'index.js', 'index.cjs', manifest.entries.server]);
      const entryPoints: Record<string, string> = { [entryName]: source };
      for (const [name, file] of Object.entries(extras)) {
        const outputName = join(dirname(manifest.entries.server), name);
        if (outputName === entryName) throw new Error(`Additional entry ${name} replaces entries.server`);
        entryPoints[outputName] = await sourceFile(root, file);
      }
      await build({ absWorkingDir: root, entryPoints, outdir: output, outExtension: { '.js': extname(manifest.entries.server) }, bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'bundle', sourcemap: true, legalComments: 'linked' });
    }
    if (manifest.entries?.web) {
      const { build } = await import('esbuild');
      const source = await firstSource(root, ['web/index.ts', 'web/index.tsx', 'web/index.mjs', 'web/index.js', manifest.entries.web]);
      await build({ absWorkingDir: root, entryPoints: [source], outfile: join(output, manifest.entries.web), bundle: true, platform: 'browser', format: 'iife', target: 'es2023', legalComments: 'linked' });
    }
    // Bundled runtime dependency licenses travel with the artifact; development dependencies do not.
    for (const name of Object.keys(metadata.dependencies ?? {})) {
      if (name.startsWith('@riffet/')) continue;
      const directory = join(root, 'node_modules', name);
      for (const filename of await readdir(directory).catch(() => [] as string[])) if (/^(?:licen[cs]e|notice)(?:\.|$)/i.test(filename)) {
        const source = join(directory, filename);
        if (await has(source)) { await mkdir(join(output, 'licenses'), { recursive: true }); await cp(source, join(output, 'licenses', `${name.replaceAll('/', '-')}-${filename}`)); }
      }
    }
    await validatePackage(output);
    const previous = `${output}.previous`;
    let hadPrevious = false;
    try { await rename(target, previous); hadPrevious = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    try { await rename(output, target); }
    catch (error) { if (hadPrevious) await rename(previous, target); throw error; }
    if (hadPrevious) await rm(previous, { recursive: true, force: true });
    return { manifest, directory: target, sourceDirectory: root };
  } finally { await rm(output, { recursive: true, force: true }); }
}

/** Build current sources before archiving; a failed build never overwrites the previous archive. */
export async function packSource(sourceDir = '.', options: PluginPackOptions = {}): Promise<PluginPackResult> {
  const requested = options.format ?? (options.out?.toLowerCase().endsWith('.zip') ? 'zip' : options.out?.toLowerCase().endsWith('.tar') ? 'tar' : 'tgz');
  if (!['tgz', 'tar', 'zip'].includes(requested)) throw new Error('format must be tgz, tar or zip');
  const built = await buildPlugin(sourceDir, options);
  const packed = await packPlugin(built.directory, { format: requested });
  const outputDir = built.directory === built.sourceDirectory && basename(built.directory) === 'package' && basename(dirname(built.directory)) === 'dist' ? dirname(built.directory) : join(built.sourceDirectory, 'dist');
  const file = resolve(options.out ?? join(outputDir, `${packed.id}-${packed.version}.${requested}`));
  const archivePath = relative(built.directory, file);
  if (!archivePath.startsWith('..' + sep) && archivePath !== '..' && !archivePath.startsWith(sep)) throw new Error('Archive output must be outside the built package');
  await mkdir(dirname(file), { recursive: true });
  const temporary = await mkdtemp(join(dirname(file), '.archive-'));
  try {
    const pending = join(temporary, 'archive');
    await writeFile(pending, packed.archive);
    await rename(pending, file);
  } finally { await rm(temporary, { recursive: true, force: true }); }
  return { ...packed, ...built, file };
}

/** Watch sources with serialized builds. Callbacks also run for the first successful build. */
export async function watchPlugin(sourceDir = '.', options: PluginWatchOptions = {}): Promise<PluginWatcher> {
  const root = await realpath(resolve(sourceDir));
  let closed = false, rebuilding = false, pending = false, timer: NodeJS.Timeout | undefined;
  const report = (error: unknown) => { options.onError?.(error); };
  const rebuild = async () => {
    if (closed) return;
    if (rebuilding) { pending = true; return; }
    rebuilding = true;
    try {
      const result = await buildPlugin(root, options);
      if (!closed) await options.onBuild?.(result);
    } catch (error) { report(error); }
    finally { rebuilding = false; if (pending && !closed) { pending = false; void rebuild(); } }
  };
  // Start watching before the initial build so edits during compilation are not lost.
  rebuilding = true;
  const watcher = watch(root, { recursive: true }, (_event, filename) => {
    if (!filename || ignored.test(filename) || /(?:^|[\\/])\.[^\\/]+/.test(filename)) return;
    clearTimeout(timer); timer = setTimeout(() => void rebuild(), 150);
  });
  const close = () => { closed = true; watcher.close(); clearTimeout(timer); };
  watcher.on('error', report);
  try {
    const initial = await buildPlugin(root, options);
    await options.onBuild?.(initial);
    rebuilding = false;
    if (pending) { pending = false; void rebuild(); }
    return { initial, close };
  } catch (error) { close(); throw error; }
}
