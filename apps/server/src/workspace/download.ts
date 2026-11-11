import { TASK_WORKSPACE_MARKER } from '../task-workspaces/identity.js';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { crc32, createDeflateRaw } from 'node:zlib';
import { AppError } from '../errors.js';

const MAX_ARCHIVE_ENTRIES = 20_000;
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_DEPTH = 24;
const COMPRESSED_EXT = /\.(png|jpe?g|gif|webp|avif|ico|zip|gz|tgz|bz2|xz|7z|zst|rar|jar|mp4|mov|webm|mkv|mp3|m4a|ogg|flac|pdf|woff2?)$/i;

const INLINE_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac',
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
};

export interface RawFileType { contentType: string; inline: boolean }

/**
 * How a file is served when opened in a tab. The type comes from the extension and is pinned with
 * `nosniff`, so a mislabelled file renders broken instead of as something else; anything that is
 * neither a known media type nor text is only offered as a download.
 */
export function rawFileType(name: string, sample: Buffer): RawFileType {
  const ext = path.extname(name).slice(1).toLowerCase();
  const known = INLINE_TYPES[ext];
  if (known) return { contentType: known, inline: true };
  if (!sample.includes(0)) return { contentType: 'text/plain; charset=utf-8', inline: true };
  return { contentType: 'application/octet-stream', inline: false };
}

/** `filename*` carries the real name; the quoted fallback is ASCII for clients that ignore it. */
export function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\%;]/g, '_') || 'download';
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function readSample(filePath: string, bytes = 8192): Promise<Buffer> {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

const archiveTooLarge = () => new AppError('ARCHIVE_TOO_LARGE', `Folder exceeds the download limit of ${MAX_ARCHIVE_ENTRIES} entries or ${MAX_ARCHIVE_BYTES / 1024 / 1024 / 1024} GiB`, 413);

export interface ArchiveEntry { absolute: string; name: string; directory: boolean; size: number; mtime: Date; mode: number }

/**
 * Outside git: everything under `base`, named below a single top folder. Symlinks are skipped, as
 * in search, so an archive cannot reach outside the project; dependency and build folders below
 * the chosen one are left out the same way.
 */
export async function collectArchiveEntries(base: string, top: string, ignored: ReadonlySet<string>): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = [];
  let bytes = 0;
  const tooLarge = archiveTooLarge;
  const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
    if (depth > MAX_ARCHIVE_DEPTH) throw tooLarge();
    const names: string[] = [];
    try { for await (const entry of await opendir(dir)) names.push(entry.name); } catch { return; }
    names.sort((a, b) => a.localeCompare(b, 'en'));
    for (const name of names) {
      if (name === TASK_WORKSPACE_MARKER) continue;
      const absolute = path.join(dir, name);
      let info;
      try { info = await lstat(absolute); } catch { continue; }
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) continue;
      if (info.isDirectory() && ignored.has(name)) continue;
      const entryName = `${prefix}/${name}`;
      if (entries.length >= MAX_ARCHIVE_ENTRIES) throw tooLarge();
      if (info.isDirectory()) {
        entries.push({ absolute, name: entryName, directory: true, size: 0, mtime: info.mtime, mode: info.mode });
        await walk(absolute, entryName, depth + 1);
      } else {
        bytes += info.size;
        if (bytes > MAX_ARCHIVE_BYTES) throw tooLarge();
        entries.push({ absolute, name: entryName, directory: false, size: info.size, mtime: info.mtime, mode: info.mode });
      }
    }
  };
  await walk(base, top, 0);
  return entries;
}

/**
 * In a git work tree, the files git would show (tracked, or untracked and not ignored), the way
 * `git archive` and code hosts package a repository. Undefined outside a work tree.
 */
export async function gitArchiveEntries(base: string, top: string): Promise<ArchiveEntry[] | undefined> {
  const listed = await new Promise<string | undefined>((resolve) => {
    execFile('git', ['-C', base, 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'], { maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout) => resolve(error ? undefined : stdout));
  });
  if (listed === undefined) return undefined;
  const entries: ArchiveEntry[] = [];
  let bytes = 0;
  for (const relative of [...new Set(listed.split('\0').filter(Boolean))].sort((a, b) => a.localeCompare(b, 'en'))) {
    if (relative.split('/').includes(TASK_WORKSPACE_MARKER)) continue;
    const absolute = path.resolve(base, relative);
    if (path.relative(base, absolute).startsWith('..')) continue;
    let info;
    try { info = await lstat(absolute); } catch { continue; }
    if (!info.isFile()) continue;
    bytes += info.size;
    if (entries.length >= MAX_ARCHIVE_ENTRIES || bytes > MAX_ARCHIVE_BYTES) throw archiveTooLarge();
    entries.push({ absolute, name: `${top}/${relative}`, directory: false, size: info.size, mtime: info.mtime, mode: info.mode });
  }
  return entries;
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * A streamed ZIP: every file is deflated as it is read, with sizes and CRC in a trailing data
 * descriptor, so nothing is buffered whole. The entry and byte limits keep it below ZIP64.
 */
export function zipStream(entries: readonly ArchiveEntry[]): Readable {
  async function* generate(): AsyncGenerator<Buffer> {
    const central: Buffer[] = [];
    let offset = 0;
    for (const entry of entries) {
      const name = Buffer.from(entry.directory ? `${entry.name}/` : entry.name, 'utf8');
      const stamp = dosDateTime(entry.mtime);
      const flags = 0x0800 | (entry.directory ? 0 : 0x0008);
      const method = entry.directory ? 0 : 8;
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(flags, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(stamp.time, 10);
      local.writeUInt16LE(stamp.date, 12);
      local.writeUInt16LE(name.length, 26);
      const headerOffset = offset;
      yield local; yield name;
      offset += local.length + name.length;

      let crc = 0, size = 0, compressed = 0;
      if (!entry.directory) {
        const deflate = createDeflateRaw({ level: COMPRESSED_EXT.test(entry.name) ? 1 : 6 });
        const source = createReadStream(entry.absolute);
        source.on('data', (chunk) => { const bytes = chunk as Buffer; crc = crc32(bytes, crc); size += bytes.length; });
        source.on('error', (error) => deflate.destroy(error));
        source.pipe(deflate);
        for await (const chunk of deflate) {
          compressed += (chunk as Buffer).length;
          yield chunk as Buffer;
        }
        offset += compressed;
        if (offset > 0xffffffff || size > 0xffffffff) throw new AppError('ARCHIVE_TOO_LARGE', 'Folder grew past the download limit while it was being archived', 413);
        const descriptor = Buffer.alloc(16);
        descriptor.writeUInt32LE(0x08074b50, 0);
        descriptor.writeUInt32LE(crc >>> 0, 4);
        descriptor.writeUInt32LE(compressed, 8);
        descriptor.writeUInt32LE(size, 12);
        yield descriptor;
        offset += descriptor.length;
      }

      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE((3 << 8) | 20, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(flags, 8);
      header.writeUInt16LE(method, 10);
      header.writeUInt16LE(stamp.time, 12);
      header.writeUInt16LE(stamp.date, 14);
      header.writeUInt32LE(crc >>> 0, 16);
      header.writeUInt32LE(compressed, 20);
      header.writeUInt32LE(size, 24);
      header.writeUInt16LE(name.length, 28);
      header.writeUInt32LE((((entry.mode & 0o777) | (entry.directory ? 0o40000 : 0o100000)) << 16 | (entry.directory ? 0x10 : 0)) >>> 0, 38);
      header.writeUInt32LE(headerOffset, 42);
      central.push(header, name);
    }
    const directory = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    yield directory;
    yield end;
  }
  return Readable.from(generate(), { objectMode: false });
}
