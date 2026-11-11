import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { crc32, gunzipSync, inflateRawSync } from 'node:zlib';
import { AppError } from '../errors.js';
import { MAX_ARCHIVE_BYTES, MAX_UNPACKED_BYTES, MAX_FILES, normalizeEntryPath, readDirectory, integrityOf, type PackageFile } from '../../../../packages/plugin-api/src/package-files.js';
export { MAX_ARCHIVE_BYTES, normalizeEntryPath, readDirectory, integrityOf, type PackageFile };

// Getting a package's files into a directory of our own: from a tar, gzipped tar, ZIP or directory. Nothing
// here runs code. An entry must be a plain file or directory with a path that stays inside the
// destination; links, devices and anything else are refused, so what lands on disk cannot point
// elsewhere.

const BLOCK = 512;

const invalid = (message: string) => new AppError('PLUGIN_PACKAGE_INVALID', message, 422);

function octal(bytes: Buffer): number {
  const text = bytes.toString('latin1').replace(/\0.*$/s, '').trim();
  if (!text) return 0;
  if (!/^[0-7]+$/.test(text)) throw invalid('the archive has a damaged header');
  return parseInt(text, 8);
}

function text(bytes: Buffer): string { return bytes.toString('utf8').replace(/\0.*$/s, ''); }

/** `key=value` records of a pax extended header (`<length> key=value\n`). */
function paxRecords(data: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const length = Number(data.toString('latin1', at, space));
    if (space < 0 || !Number.isInteger(length) || length <= space - at || at + length > data.length) throw invalid('the archive has a damaged extended header');
    const record = data.toString('utf8', space + 1, at + length - 1);
    const equals = record.indexOf('=');
    if (equals > 0) records.set(record.slice(0, equals), record.slice(equals + 1));
    at += length;
  }
  return records;
}

/** The regular files of a gzipped tar. Directories are implied by file paths. Throws on a link, a device or a path that escapes. */
export function readTarball(archive: Buffer): PackageFile[] {
  if (archive.length > MAX_ARCHIVE_BYTES) throw invalid(`the archive is larger than ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB`);
  let tar: Buffer;
  try { tar = gunzipSync(archive, { maxOutputLength: MAX_UNPACKED_BYTES }); }
  catch (error) { throw invalid((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE' ? 'the archive unpacks to more than the allowed size' : 'the file is not a gzipped tar archive'); }
  return readTar(tar);
}

function readTar(tar: Buffer): PackageFile[] {
  const files = new Map<string, PackageFile>();
  let longName: string | undefined;
  let pax: Map<string, string> | undefined;
  let total = 0;
  for (let at = 0; at + BLOCK <= tar.length;) {
    const header = tar.subarray(at, at + BLOCK);
    if (header.every(byte => byte === 0)) break;
    // The checksum counts the checksum field itself as spaces.
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
    if (sum !== octal(header.subarray(148, 156))) throw invalid('the archive has a damaged header');
    const type = String.fromCharCode(header[156] || 0x30);
    const size = octal(header.subarray(124, 136));
    const start = at + BLOCK;
    if (start + size > tar.length) throw invalid('the archive is truncated');
    const body = tar.subarray(start, start + size);
    at = start + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'x') { pax = paxRecords(body); continue; }
    if (type === 'g') continue;
    if (type === 'L') { longName = text(body); continue; }
    const prefix = text(header.subarray(345, 500));
    const name = pax?.get('path') ?? longName ?? (prefix ? `${prefix}/${text(header.subarray(0, 100))}` : text(header.subarray(0, 100)));
    pax = undefined; longName = undefined;
    if (type === '5') { normalizeEntryPath(name); continue; }
    if (type !== '0') throw invalid(`the archive has an entry that is not a plain file (${JSON.stringify(name.slice(0, 80))}); links and devices are not allowed`);
    const path = normalizeEntryPath(name);
    if (files.has(path)) throw invalid(`the archive lists ${path} twice`);
    total += size;
    if (files.size >= MAX_FILES) throw invalid(`the archive has more than ${MAX_FILES} files`);
    files.set(path, { path, data: Buffer.from(body), executable: (octal(header.subarray(100, 108)) & 0o100) !== 0 });
  }
  if (!files.size) throw invalid('the archive is empty');
  if (total > MAX_UNPACKED_BYTES) throw invalid('the archive unpacks to more than the allowed size');
  return [...files.values()];
}

/** Detect the container by its bytes; the filename never controls how it is extracted. */
export function readArchive(archive: Buffer): PackageFile[] {
  if (archive.length > MAX_ARCHIVE_BYTES) throw invalid(`the archive is larger than ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB`);
  if (archive[0] === 0x1f && archive[1] === 0x8b) return readTarball(archive);
  if (archive.length >= 4 && [0x04034b50, 0x06054b50].includes(archive.readUInt32LE(0))) return readZip(archive);
  if (archive.length >= BLOCK) return readTar(archive);
  throw invalid('the file is not a ZIP, tar or gzipped tar archive');
}

/**
 * Check ZIP metadata before inflating. fflate's convenience unzip API does not expose Unix file
 * types or enforce an output limit; Node's bounded inflater also checks a forged uncompressed size.
 * ZIP64, multi-volume, encrypted and non-DEFLATE compression are deliberately refused.
 */
function readZip(archive: Buffer): PackageFile[] {
  let end = archive.length - 22;
  for (; end >= Math.max(0, archive.length - 65557); end--) {
    if (archive.readUInt32LE(end) === 0x06054b50 && end + 22 + archive.readUInt16LE(end + 20) === archive.length) break;
  }
  if (end < Math.max(0, archive.length - 65557)) throw invalid('the ZIP archive has a damaged directory');
  const count = archive.readUInt16LE(end + 10);
  const directorySize = archive.readUInt32LE(end + 12);
  let at = archive.readUInt32LE(end + 16);
  if (archive.readUInt16LE(end + 4) || archive.readUInt16LE(end + 6) || archive.readUInt16LE(end + 8) !== count
    || count === 0xffff || at === 0xffffffff || directorySize === 0xffffffff) throw invalid('ZIP64 and multi-volume ZIP archives are not supported');
  if (count > MAX_FILES) throw invalid(`the archive has more than ${MAX_FILES} entries`);
  if (at + directorySize !== end) throw invalid('the ZIP archive has a damaged directory');
  const directoryStart = at;
  const files = new Map<string, PackageFile>();
  const paths = new Set<string>();
  let total = 0;
  for (let index = 0; index < count; index++) {
    if (at + 46 > end || archive.readUInt32LE(at) !== 0x02014b50) throw invalid('the ZIP archive has a damaged header');
    const flags = archive.readUInt16LE(at + 8);
    const compression = archive.readUInt16LE(at + 10);
    const checksum = archive.readUInt32LE(at + 16);
    const size = archive.readUInt32LE(at + 20);
    const originalSize = archive.readUInt32LE(at + 24);
    const nameLength = archive.readUInt16LE(at + 28);
    const extraLength = archive.readUInt16LE(at + 30);
    const commentLength = archive.readUInt16LE(at + 32);
    const disk = archive.readUInt16LE(at + 34);
    const attributes = archive.readUInt32LE(at + 38);
    const offset = archive.readUInt32LE(at + 42);
    const next = at + 46 + nameLength + extraLength + commentLength;
    if (next > end || disk || size === 0xffffffff || originalSize === 0xffffffff || offset === 0xffffffff) throw invalid('the ZIP archive has an unsupported or damaged header');
    if (flags & (1 | 0x40 | 0x2000)) throw invalid('encrypted ZIP archives are not supported');
    if (compression !== 0 && compression !== 8) throw invalid('the ZIP archive must use stored or DEFLATE compression');
    const rawName = archive.subarray(at + 46, at + 46 + nameLength);
    const name = rawName.toString('utf8');
    const path = normalizeEntryPath(name);
    if (paths.has(path)) throw invalid(`the archive lists ${path} twice`);
    paths.add(path);
    const mode = attributes >>> 16;
    const type = mode & 0o170000;
    if (type && type !== 0o100000 && type !== 0o040000) throw invalid(`the archive has an entry that is not a plain file (${JSON.stringify(name.slice(0, 80))}); links and devices are not allowed`);
    const directory = name.endsWith('/') || type === 0o040000 || (attributes & 0x10) !== 0;
    if (directory && originalSize !== 0) throw invalid('the ZIP archive has a directory with file contents');
    total += originalSize;
    if (total > MAX_UNPACKED_BYTES) throw invalid('the archive unpacks to more than the allowed size');
    if (offset + 30 > directoryStart || archive.readUInt32LE(offset) !== 0x04034b50) throw invalid('the ZIP archive has a damaged local header');
    const localNameLength = archive.readUInt16LE(offset + 26);
    const start = offset + 30 + localNameLength + archive.readUInt16LE(offset + 28);
    if (start + size > directoryStart || archive.readUInt16LE(offset + 6) !== flags || archive.readUInt16LE(offset + 8) !== compression
      || !archive.subarray(offset + 30, offset + 30 + localNameLength).equals(rawName)) throw invalid('the ZIP archive has inconsistent headers');
    if (!(flags & 8) && (archive.readUInt32LE(offset + 14) !== checksum || archive.readUInt32LE(offset + 18) !== size || archive.readUInt32LE(offset + 22) !== originalSize)) throw invalid('the ZIP archive has inconsistent sizes');
    const compressed = archive.subarray(start, start + size);
    let data: Buffer;
    try { data = compression === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: Math.max(1, originalSize) }); }
    catch { throw invalid('the ZIP archive has damaged or oversized file contents'); }
    if (data.length !== originalSize || crc32(data) !== checksum) throw invalid('the ZIP archive has damaged file contents');
    if (!directory) files.set(path, { path, data, executable: (mode & 0o100) !== 0 });
    at = next;
  }
  if (at !== end) throw invalid('the ZIP archive has a damaged directory');
  if (!files.size) throw invalid('the archive is empty');
  return [...files.values()];
}

/** npm-style archives hold everything under one directory (`package/`): the files are re-rooted when that directory holds the manifest. */
export function reroot(files: PackageFile[], manifest: string): PackageFile[] {
  if (files.some(file => file.path === manifest)) return files;
  const roots = new Set(files.map(file => file.path.split('/')[0]));
  const [only] = [...roots];
  if (roots.size !== 1 || !files.some(file => file.path === `${only}/${manifest}`) || files.some(file => !file.path.includes('/'))) return files;
  return files.map(file => ({ ...file, path: file.path.slice(only!.length + 1) }));
}

/** Writes `files` into the empty directory `destination`. A path is checked again here, and a file is never opened over an existing one. */
export async function writeFiles(destination: string, files: readonly PackageFile[]): Promise<void> {
  const root = resolve(destination);
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const file of files) {
    const target = resolve(root, file.path);
    if (!target.startsWith(root + sep)) throw invalid(`${file.path} leaves the package`);
    await mkdir(dirname(target), { recursive: true, mode: 0o755 });
    // O_EXCL | O_NOFOLLOW: a duplicate (or a case-insensitive twin) fails instead of overwriting.
    const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, file.executable ? 0o755 : 0o644)
      .catch((error: NodeJS.ErrnoException) => { throw invalid(error.code === 'EEXIST' ? `${file.path} collides with another file` : `${file.path} could not be written`); });
    try { await handle.writeFile(file.data); } finally { await handle.close(); }
  }
}
