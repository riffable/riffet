import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FileDeletion, FileVersion } from '../../../../packages/contracts/src/index.js';
import { FILE_BUDGET } from '../../../../packages/contracts/src/budgets.js';
import { AppError } from '../errors.js';
import { isSecretPath, projectRoot, resolveScopedPath, toProjectRelative, type ProjectRef } from './scope.js';

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/**
 * Where the workbench may write: inside the project, never the project itself, never Git's own files
 * (a hook there runs on the next commit), and none of the stores reads refuse. Unlike reads there is
 * no outside-project escape hatch. Returns the path as named, inside the project.
 */
export async function resolveWritablePath(root: string, input: string, deniedRoots: readonly string[] = []): Promise<{ target: string; relative: string }> {
  const target = await resolveScopedPath(root, input);
  const relative = toProjectRelative(root, target);
  if (!relative) throw new AppError('INVALID_PATH', 'The project folder itself cannot be changed');
  if (relative.split('/').includes('.git')) throw new AppError('PATH_DENIED', 'Git\'s own files are not changed through the workbench', 403);
  // A name not created yet is judged by the real folder it would go into.
  const real = await realpath(target).catch(async () => path.join(await realpath(path.dirname(target)).catch(() => path.dirname(target)), path.basename(target)));
  if (await isSecretPath(real, deniedRoots, false)) throw new AppError('PATH_DENIED', 'This file holds credentials and cannot be changed through the workbench', 403);
  return { target, relative };
}

/** UTF-8 text a save can write back unchanged in form; undefined for anything else. */
export function editableText(data: Buffer): string | undefined {
  const body = data.subarray(0, 3).equals(UTF8_BOM) ? data.subarray(3) : data;
  if (body.includes(0)) return undefined;
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body); } catch { return undefined; }
}

interface TrashRecord { root: string; path: string; at: number; bytes: number }

/**
 * Saves, creations, moves and deletions of project files. A save names the version it was edited
 * from (`FilePreview.hash`) and is refused when the file has changed since, so an agent's write is
 * never lost under the user's. Writes go to a temporary file beside the target and are renamed over
 * it, so a failure leaves the old file whole. A deletion is moved under the state directory for undo
 * (`FILE_BUDGET.trash*`); one too large to keep asks to be confirmed as permanent.
 */
export class FileWrites {
  private readonly trashDir: string;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly options: { stateDir: string; noteWrite?: (absolutePath: string) => void }) {
    this.trashDir = path.join(options.stateDir, 'file-trash');
  }

  async save(project: ProjectRef, input: { path: string; content: string; expectedHash: string }): Promise<FileVersion> {
    if (typeof input?.content !== 'string') throw new AppError('INVALID_CONTENT', 'content must be a string');
    if (typeof input.expectedHash !== 'string' || !input.expectedHash) throw new AppError('INVALID_HASH', 'expectedHash is required');
    if (Buffer.byteLength(input.content) > FILE_BUDGET.saveBytes) throw new AppError('FILE_TOO_LARGE', 'The text is too large to save here', 413);
    const root = await projectRoot(project);
    const { target, relative } = await this.writable(root, input.path);
    const real = await realpath(target).catch(() => { throw new AppError('FILE_NOT_FOUND', 'File does not exist', 404); });
    return this.locked(real, async () => {
      const info = await stat(real);
      if (!info.isFile()) throw new AppError('NOT_A_FILE', 'Path is not a regular file');
      if (info.size > FILE_BUDGET.previewReadBytes) throw new AppError('FILE_CHANGED', 'The file changed since it was opened', 409);
      const current = await readFile(real);
      if (hash(current) !== input.expectedHash) throw new AppError('FILE_CHANGED', 'The file changed since it was opened', 409);
      const text = editableText(current);
      if (text === undefined) throw new AppError('FILE_NOT_EDITABLE', 'Only UTF-8 text files can be edited here', 415);
      // The editor works in `\n`; a file written with `\r\n` throughout keeps it, and a BOM stays.
      const crlf = text.includes('\r\n') && !/(^|[^\r])\n/.test(text);
      const body = crlf ? input.content.replace(/\r?\n/g, '\r\n') : input.content;
      const data = Buffer.concat([current.subarray(0, 3).equals(UTF8_BOM) ? UTF8_BOM : Buffer.alloc(0), Buffer.from(body)]);
      if (!data.equals(current)) await atomicWrite(real, data, info.mode & 0o7777);
      this.options.noteWrite?.(path.join(root, relative));
      return { path: relative, hash: hash(data), size: data.byteLength };
    });
  }

  async create(project: ProjectRef, input: { path: string; kind: 'file' | 'directory' }): Promise<FileVersion> {
    if (input?.kind !== 'file' && input?.kind !== 'directory') throw new AppError('INVALID_KIND', 'kind must be file or directory');
    const root = await projectRoot(project);
    const { target, relative } = await this.writable(root, input.path);
    await mkdir(path.dirname(target), { recursive: true });
    try {
      if (input.kind === 'directory') await mkdir(target);
      else await writeFile(target, '', { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new AppError('FILE_EXISTS', 'Something with this name already exists', 409);
      throw error;
    }
    this.options.noteWrite?.(path.join(root, relative));
    return { path: relative, hash: hash(Buffer.alloc(0)), size: 0 };
  }

  async move(project: ProjectRef, input: { from: string; to: string }): Promise<{ path: string }> {
    const root = await projectRoot(project);
    const from = await this.writable(root, input?.from);
    const to = await this.writable(root, input?.to);
    if (from.target === to.target) return { path: to.relative };
    const source = await lstat(from.target).catch(() => { throw new AppError('FILE_NOT_FOUND', 'File does not exist', 404); });
    if (to.relative.startsWith(`${from.relative}/`)) throw new AppError('INVALID_PATH', 'A folder cannot be moved into itself');
    // `rename` replaces a file silently. The one existing target allowed is the source itself, as a
    // change of case finds it on a case-insensitive disk.
    const existing = await lstat(to.target).catch(() => undefined);
    if (existing && !(existing.dev === source.dev && existing.ino === source.ino)) throw new AppError('FILE_EXISTS', 'Something with this name already exists', 409);
    await mkdir(path.dirname(to.target), { recursive: true });
    await rename(from.target, to.target);
    this.options.noteWrite?.(path.join(root, from.relative));
    this.options.noteWrite?.(path.join(root, to.relative));
    return { path: to.relative };
  }

  async remove(project: ProjectRef, input: { path: string; permanent?: boolean }): Promise<FileDeletion> {
    const root = await projectRoot(project);
    const { target, relative } = await this.writable(root, input?.path);
    const info = await lstat(target).catch(() => { throw new AppError('FILE_NOT_FOUND', 'File does not exist', 404); });
    this.options.noteWrite?.(path.join(root, relative));
    if (input.permanent) {
      await rm(target, { recursive: true, force: true });
      return { path: relative };
    }
    const bytes = info.isDirectory() ? await treeBytes(target, FILE_BUDGET.trashItemBytes) : info.size;
    if (bytes > FILE_BUDGET.trashItemBytes) throw new AppError('DELETE_UNRECOVERABLE', 'This is too large to keep for undo', 409);
    const id = randomUUID();
    const slot = path.join(this.trashDir, id);
    await mkdir(slot, { recursive: true, mode: 0o700 });
    await moveAcross(target, path.join(slot, 'item'));
    const record: TrashRecord = { root, path: relative, at: Date.now(), bytes };
    await writeFile(path.join(slot, 'record.json'), JSON.stringify(record), { mode: 0o600 });
    void this.prune().catch(() => undefined);
    return { path: relative, restoreId: id };
  }

  async restore(project: ProjectRef, restoreId: string): Promise<{ path: string }> {
    if (!/^[0-9a-f-]{36}$/.test(String(restoreId))) throw new AppError('INVALID_ID', 'Unknown deletion');
    const root = await projectRoot(project);
    const slot = path.join(this.trashDir, restoreId);
    const record = await readFile(path.join(slot, 'record.json'), 'utf8').then(text => JSON.parse(text) as TrashRecord, () => undefined);
    if (!record || record.root !== root) throw new AppError('RESTORE_EXPIRED', 'This deletion can no longer be undone', 410);
    const { target, relative } = await this.writable(root, record.path);
    if (await lstat(target).then(() => true, () => false)) throw new AppError('FILE_EXISTS', 'Something with this name already exists', 409);
    await mkdir(path.dirname(target), { recursive: true });
    await moveAcross(path.join(slot, 'item'), target);
    await rm(slot, { recursive: true, force: true });
    this.options.noteWrite?.(path.join(root, relative));
    return { path: relative };
  }

  /** Drops deletions past their retention, then the oldest until the rest fit `FILE_BUDGET.trashBytes`. */
  async prune(now = Date.now()): Promise<void> {
    const slots = await readdir(this.trashDir).catch(() => [] as string[]);
    const kept: { slot: string; record?: TrashRecord }[] = [];
    for (const name of slots) {
      const slot = path.join(this.trashDir, name);
      const record = await readFile(path.join(slot, 'record.json'), 'utf8').then(text => JSON.parse(text) as TrashRecord, () => undefined);
      kept.push({ slot, record });
    }
    kept.sort((a, b) => (b.record?.at ?? 0) - (a.record?.at ?? 0));
    let total = 0;
    for (const { slot, record } of kept) {
      total += record?.bytes ?? 0;
      // A slot without a record is a deletion that failed half way; nothing can restore it.
      if (!record || now - record.at > FILE_BUDGET.trashRetentionMs || total > FILE_BUDGET.trashBytes) await rm(slot, { recursive: true, force: true });
    }
  }

  private writable(root: string, input: unknown) {
    if (typeof input !== 'string' || !input) throw new AppError('INVALID_PATH', 'Path is required');
    return resolveWritablePath(root, input, [this.options.stateDir]);
  }

  /** One write at a time per file: the version check and the write must not interleave with another save. */
  private locked<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.then(run, run);
    const settled = next.catch(() => undefined);
    this.locks.set(key, settled);
    void settled.then(() => { if (this.locks.get(key) === settled) this.locks.delete(key); });
    return next;
  }
}

async function atomicWrite(target: string, data: Buffer, mode: number): Promise<void> {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.riffet-${randomUUID().slice(0, 8)}.tmp`);
  const handle = await open(temporary, 'wx', mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
    await handle.chmod(mode);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try { await rename(temporary, target); }
  catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
}

/** A rename, or a copy and removal when the state directory is on another disk. */
async function moveAcross(from: string, to: string): Promise<void> {
  try { await rename(from, to); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error; }
  await cp(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, errorOnExist: true, force: false });
  await rm(from, { recursive: true, force: true });
}

/** Bytes under a folder, stopping once past `limit`; links count as themselves. */
async function treeBytes(folder: string, limit: number): Promise<number> {
  let total = 0;
  const pending = [folder];
  while (pending.length) {
    const current = pending.pop()!;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else total += (await lstat(full)).size;
      if (total > limit) return total;
    }
  }
  return total;
}
