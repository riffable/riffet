import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Zip, ZipDeflate } from 'fflate';
import { APPEARANCE_MAX_ICON_PACK_BYTES, iconPackProblem, APPEARANCE_MAX_FONT_BYTES, APPEARANCE_MAX_IMAGE_BYTES, APPEARANCE_MAX_PALETTE_BYTES, validateCustomThemes } from '@riffet/contracts';
import { manifestSchema } from './manifest.js';
import type { PluginManifest } from './index.js';
import { satisfies } from './semver.js';
import { MAX_ARCHIVE_BYTES, readDirectory, integrityOf, type PackageFile } from './package-files.js';
export { MAX_ARCHIVE_BYTES, readDirectory, integrityOf, type PackageFile } from './package-files.js';

const BLOCK = 512;
/** Junk that is never part of a package. */
const SKIPPED = /(?:^|\/)(?:\.DS_Store|\.git(?:\/|$))|\.(?:tgz|tar(?:\.gz)?|zip)$/i;

function field(header: Buffer, text: string, offset: number, length: number): void {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > length) throw new Error(`"${text}" does not fit a tar header field`);
  bytes.copy(header, offset);
}
const octal = (value: number, length: number): string => `${value.toString(8).padStart(length - 1, '0')}\0`;

/** A ustar entry: the path is split into prefix and name when it is longer than 100 bytes. */
function entry(file: PackageFile): Buffer[] {
  const header = Buffer.alloc(BLOCK);
  let name = file.path;
  let prefix = '';
  if (Buffer.byteLength(name) > 100) {
    const cut = [...name.matchAll(/\//g)].map(match => match.index!).reverse()
      .find(at => Buffer.byteLength(name.slice(at + 1)) <= 100 && Buffer.byteLength(name.slice(0, at)) <= 155);
    if (cut === undefined) throw new Error(`${file.path} is too long for a tar header`);
    prefix = name.slice(0, cut);
    name = name.slice(cut + 1);
  }
  field(header, name, 0, 100);
  field(header, octal(file.executable ? 0o755 : 0o644, 8), 100, 8);
  field(header, octal(0, 8), 108, 8);
  field(header, octal(0, 8), 116, 8);
  field(header, octal(file.data.length, 12), 124, 12);
  field(header, octal(0, 12), 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  field(header, 'ustar\0', 257, 6);
  field(header, '00', 263, 2);
  field(header, prefix, 345, 155);
  let sum = 0;
  for (const byte of header) sum += byte;
  field(header, `${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  const padding = Buffer.alloc((BLOCK - (file.data.length % BLOCK)) % BLOCK);
  return [header, file.data, padding];
}

/** The same bytes for the same files: sorted, normalized, and a gzip header that carries neither time nor platform. */
export function tarball(files: readonly PackageFile[]): Buffer {
  const archive = gzipSync(archiveFiles(files, 'tar'), { level: 9 });
  archive[4] = archive[5] = archive[6] = archive[7] = 0; // modification time
  archive[9] = 3; // the operating system byte: Unix, whatever packed it
  return archive;
}

export type ArchiveFormat = 'tgz' | 'tar' | 'zip';

/** Fixed metadata and entry order make every supported container reproducible. */
export function archiveFiles(files: readonly PackageFile[], format: ArchiveFormat): Buffer {
  if (format === 'tgz') return tarball(files);
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (format === 'tar') return Buffer.concat([...sorted.flatMap(entry), Buffer.alloc(BLOCK * 2)]);
  const chunks: Buffer[] = [];
  const archive = new Zip((error, chunk) => {
    if (error) throw error;
    chunks.push(Buffer.from(chunk));
  });
  for (const file of sorted) {
    const zipped = new ZipDeflate(file.path, { level: 9 });
    zipped.os = 3;
    zipped.attrs = (file.executable ? 0o100755 : 0o100644) << 16;
    // ZIP stores local calendar fields, without an offset.
    zipped.mtime = new Date(1980, 0, 1);
    archive.add(zipped);
    zipped.push(file.data, true);
  }
  archive.end();
  return Buffer.concat(chunks);
}


export interface PluginPackageManifest extends PluginManifest { $schema?: string; entries?: { server?: string; web?: string } }
export interface CheckedPackage { manifest: PluginPackageManifest; entries: { server?: string; web?: string }; capabilities: string[] }

async function confined(root: string, relative: string): Promise<string> {
  const file = await realpath(resolve(root, relative)).catch(() => undefined);
  if (!file || !file.startsWith(root + sep) || !(await stat(file)).isFile()) throw new Error(`${relative} is not a file inside the package`);
  return file;
}

/** The same static content validation used by the host; this never imports or executes a plugin. */
export async function validatePackage(directory: string): Promise<CheckedPackage> {
  const root = await realpath(directory);
  const file = await confined(root, 'riffet-plugin.json');
  if ((await stat(file)).size > 256 * 1024) throw new Error('riffet-plugin.json is too large');
  const manifest = manifestSchema.parse(JSON.parse(await readFile(file, 'utf8'))) as PluginPackageManifest;
  if (!manifest.version) throw new Error('version must be a semantic version');
  for (const [kind, range] of Object.entries(manifest.hostApi ?? {})) if (range && ['server', 'web', 'agent'].includes(kind) && !satisfies(1, range)) throw new Error(`needs ${kind} API ${range}; this SDK provides v1`);
  const entries = manifest.entries ?? {};
  for (const [kind, path] of Object.entries(entries)) {
    await confined(root, path);
    if (kind === 'server' && !/\.(?:[cm]?js|[cm]?ts)$/.test(path)) throw new Error('entries.server must be a JavaScript or TypeScript module');
  }
  for (const declaration of [...(manifest.contributes?.views ?? []), ...(manifest.contributes?.agentBackends ?? [])]) if (declaration.icon?.svg) await confined(root, declaration.icon.svg);
  const appearance = manifest.contributes?.appearance;
  const assets: Array<readonly [string, 'palette' | 'font' | 'image' | 'icons']> = [
    ...(appearance?.palettes ?? []).map(item => [item.asset, 'palette'] as const),
    ...(appearance?.iconPacks ?? []).map(item => [item.asset, 'icons'] as const),
    ...(appearance?.fonts ?? []).flatMap(item => item.files.map(file => [file.path, 'font'] as const)),
    ...(appearance?.backgrounds ?? []).map(item => [item.asset, 'image'] as const),
  ];
  for (const [path, kind] of assets) {
    const file = await confined(root, path);
    const limit = kind === 'palette' ? APPEARANCE_MAX_PALETTE_BYTES : kind === 'icons' ? APPEARANCE_MAX_ICON_PACK_BYTES : kind === 'font' ? APPEARANCE_MAX_FONT_BYTES : APPEARANCE_MAX_IMAGE_BYTES;
    if ((await stat(file)).size > limit) throw new Error(`${path} exceeds its asset size limit`);
    const bytes = await readFile(file);
    if (kind === 'palette') {
      const issue = validateCustomThemes([JSON.parse(bytes.toString('utf8'))]).issues[0];
      if (issue) throw new Error(`${path} is not a theme: ${issue.path} ${issue.message}`);
    } else if (kind === 'icons') {
      const issue = iconPackProblem(JSON.parse(bytes.toString('utf8')));
      if (issue) throw new Error(`${path}: ${issue}`);
    } else if (kind === 'font') {
      if (bytes.subarray(0, 4).toString('latin1') !== 'wOF2') throw new Error(`${path} is not a WOFF2 font`);
    } else {
      const extension = extname(path).toLowerCase();
      const valid = extension === '.png' ? bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) : /^\.jpe?g$/.test(extension) ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff : extension === '.webp' && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP';
      if (!valid) throw new Error(`${path} has an invalid image signature`);
    }
  }
  return { manifest, entries, capabilities: [...new Set(manifest.capabilities ?? [])].sort() };
}

export interface Packed { archive: Buffer; id: string; version: string; files: number; integrity: string; capabilities: string[]; warnings: string[] }
export async function packPlugin(directory: string, options: { format?: ArchiveFormat } = {}): Promise<Packed> {
  const checked = await validatePackage(directory);
  const files = (await readDirectory(directory)).filter(file => !SKIPPED.test(file.path));
  const archive = archiveFiles(files, options.format ?? 'tgz');
  if (archive.length > MAX_ARCHIVE_BYTES) throw new Error(`the archive is larger than ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB`);
  return { archive, id: checked.manifest.id, version: checked.manifest.version!, files: files.length, integrity: integrityOf(files), capabilities: checked.capabilities, warnings: checked.manifest.contributes?.agentBackends?.length ? ['Agent backends require explicitly trusted installation.'] : [] };
}

export { buildPlugin, packSource, watchPlugin, type PluginBuildOptions, type PluginBuildResult, type PluginPackOptions, type PluginPackResult, type PluginWatchOptions, type PluginWatcher } from './build.js';
