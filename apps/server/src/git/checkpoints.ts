import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, readdir, readlink, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Checkpoint, CheckpointChange } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import { assertWithin, isWithin, resolveScopedPath, type ProjectRef } from '../workspace/scope.js';
import {
  asRelativePath, changedSince, gitError, hash, headCommit, INDEX_BATCH_PATHS, literalPath,
  MAX_CHECKPOINT_FILE_BYTES, MAX_CHECKPOINT_FILES, MAX_CHECKPOINT_TOTAL_BYTES, MB, normalizeChanges,
  PARTIAL_CHECKPOINTS_KEPT, replaceWorktreeFile, TURN_CHECKPOINTS_KEPT, UNFINISHED_CHECKPOINT_MS,
  writeIndex, type CheckpointManifest, type GitHost, type Image, type Repo,
} from './shared.js';

function fileStateHash(index: Image, worktree: Image): string {
  const shape = (image: Image) => ({ exists: image.exists, kind: image.kind, mode: image.mode, hash: image.hash });
  return hash(JSON.stringify({ index: shape(index), worktree: shape(worktree) }));
}

export function checkpointFolder(host: GitHost, repo: Repo): string {
  return path.join(host.stateDir, 'checkpoints', hash(repo.projectId).slice(0, 32));
}

export function checkpointPath(host: GitHost, repo: Repo, id: string): string {
  return path.join(checkpointFolder(host, repo), id);
}

async function dirtyPaths(host: GitHost, repo: Repo): Promise<string[]> {
  const status = await host.statusRaw(repo, 'all');
  const paths = new Set<string>();
  for (const item of status.paths) {
    if (asRelativePath(repo.root, repo.projectRoot, item.path) !== undefined) paths.add(item.path);
    if (item.originalPath && asRelativePath(repo.root, repo.projectRoot, item.originalPath) !== undefined) paths.add(item.originalPath);
  }
  return [...paths].sort((a, b) => a.localeCompare(b));
}

async function storeBlob(folder: string, data: Buffer): Promise<{ blob: string; hash: string }> {
  const digest = hash(data);
  const blob = `blob-${digest}`;
  const target = path.join(folder, blob);
  // Deduplicate identical dirty-file snapshots across a project's checkpoints using a per-project
  // hard-linked `.objects/` pool. Publish into `.objects/` atomically via a temp file + `link` so a
  // crash or concurrent write never exposes a truncated file at the canonical object path.
  const objectsDir = path.join(path.dirname(folder), '.objects');
  const shared = path.join(objectsDir, blob);
  try {
    await mkdir(objectsDir, { recursive: true, mode: 0o700 });
    if (!await lstat(shared).then(() => true, () => false)) {
      const temp = path.join(objectsDir, `.${blob}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
      try {
        // No fsync: one per blob cost about 5 ms each on macOS, a second for a hundred changes, which a
        // turn running meanwhile gets to use. The manifest is not synced either, so it bought no crash safety.
        const handle = await open(temp, 'wx', 0o600);
        try { await handle.writeFile(data); } finally { await handle.close(); }
        try { await link(temp, shared); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      } finally {
        await unlink(temp).catch(() => undefined);
      }
    }
    try {
      await link(shared, target);
      return { blob, hash: digest };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { blob, hash: digest };
    }
  } catch { /* fall back to standalone file below */ }
  try {
    const handle = await open(target, 'wx', 0o600);
    try { await handle.writeFile(data); } finally { await handle.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  return { blob, hash: digest };
}

/** Removes `.objects/` entries no longer hard-linked by any retained checkpoint (nlink <= 1 and past grace). */
export async function pruneOrphanCheckpointObjects(host: GitHost, repo: Repo): Promise<void> {
  const objectsDir = path.join(checkpointFolder(host, repo), '.objects');
  const cutoff = Date.now() - 5 * 60_000;
  for (const name of await readdir(objectsDir).catch(() => [] as string[])) {
    const isObject = /^blob-[a-f0-9]{64}$/.test(name);
    const isStaleTmp = name.startsWith('.blob-') && name.endsWith('.tmp');
    if (!isObject && !isStaleTmp) continue;
    const entry = path.join(objectsDir, name);
    const info = await lstat(entry).catch(() => undefined);
    if (info?.isFile() && info.mtimeMs < cutoff && (isStaleTmp || info.nlink <= 1)) await unlink(entry).catch(() => undefined);
  }
}

async function readWorktreeImage(repo: Repo, projectRelative: string, folder?: string): Promise<Image> {
  const target = await resolveScopedPath(repo.projectRoot, projectRelative, true);
  let info;
  try { info = await lstat(target); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return { exists: false, kind: 'missing', mode: 0 };
    throw error;
  }
  if (info.isDirectory()) throw new AppError('CHECKPOINT_UNSUPPORTED_FILE', 'Checkpoint cannot snapshot a directory path', 422, { path: projectRelative });
  let data: Buffer;
  let kind: Image['kind'];
  let mode: number;
  if (info.isSymbolicLink()) {
    const targetText = await readlink(target);
    const resolvedLink = path.resolve(path.dirname(target), targetText);
    assertWithin(repo.projectRoot, resolvedLink, 'CHECKPOINT_SYMLINK_OUTSIDE_PROJECT');
    data = Buffer.from(targetText);
    kind = 'symlink';
    mode = 0o120000;
  } else if (info.isFile()) {
    if (info.size > MAX_CHECKPOINT_FILE_BYTES) throw new AppError('CHECKPOINT_FILE_TOO_LARGE', 'Checkpoint file exceeds the per-file limit', 413, { path: projectRelative, size: info.size });
    data = await readFile(target);
    kind = 'file';
    mode = info.mode & 0o777;
  } else {
    throw new AppError('CHECKPOINT_UNSUPPORTED_FILE', 'Checkpoint only supports regular files and symlinks', 422, { path: projectRelative });
  }
  const image: Image = { exists: true, kind, mode, size: data.length };
  if (folder) Object.assign(image, await storeBlob(folder, data));
  else image.hash = hash(data);
  if (kind === 'symlink') image.linkTarget = data.toString('utf8');
  return image;
}

async function blobImage(data: Buffer, mode: string, folder?: string): Promise<Image> {
  const symlinkMode = mode === '120000';
  const image: Image = { exists: true, kind: symlinkMode ? 'symlink' : 'file', mode: parseInt(mode, 8), size: data.length };
  if (folder) Object.assign(image, await storeBlob(folder, data));
  else image.hash = hash(data);
  if (symlinkMode) image.linkTarget = data.toString('utf8');
  return image;
}

async function objectImage(host: GitHost, repo: Repo, oid: string, mode: string, folder?: string): Promise<Image> {
  const result = await host.git(repo, ['cat-file', 'blob', oid], { maxOutputBytes: MAX_CHECKPOINT_FILE_BYTES + 1, timeoutMs: 15_000 });
  if (result.code !== 0) throw gitError(result, 'cat-file');
  const data = result.stdoutData;
  if (data.length > MAX_CHECKPOINT_FILE_BYTES || result.truncated) throw new AppError('CHECKPOINT_FILE_TOO_LARGE', 'Checkpoint Git blob exceeds the per-file limit', 413, { size: data.length });
  return blobImage(data, mode, folder);
}

/**
 * The index side of many paths, from their `indexRecords`, with two more Git processes rather than
 * two per path: `cat-file --batch-check` for sizes, one `cat-file --batch` for the blobs. Per path a
 * worktree with a hundred changes took seconds, and a turn's checkpoint, taken while the turn runs,
 * has to be done before the turn reaches the files. A path this cannot settle (unmerged, not a blob,
 * over the per-file limit, a failed batch) is left out, and the caller reads it with `indexImage`,
 * which reports it the way it always has.
 */
async function indexImages(host: GitHost, repo: Repo, gitPaths: string[], records: Map<string, string[]>, folder: string): Promise<Map<string, Image>> {
  const images = new Map<string, Image>();
  const entries = new Map<string, { mode: string; oid: string }>();
  for (const gitPath of gitPaths) {
    const found = records.get(gitPath);
    if (!found) continue;
    if (!found.length) { images.set(gitPath, { exists: false, kind: 'missing', mode: 0 }); continue; }
    if (found.length !== 1 || !found[0]!.endsWith(' 0')) continue;
    const [mode, oid] = found[0]!.split(' ');
    if (mode !== '160000') entries.set(gitPath, { mode: mode!, oid: oid! });
  }
  // Paths under a directory pathspec would list as other paths; only an exact match counts as missing.
  for (const [gitPath, image] of images) if (!image.exists && gitPaths.some(other => other !== gitPath && other.startsWith(`${gitPath}/`))) images.delete(gitPath);
  const oids = [...new Set([...entries.values()].map(entry => entry.oid))];
  if (!oids.length) return images;
  const checked = await host.git(repo, ['cat-file', '--batch-check'], { input: Buffer.from(`${oids.join('\n')}\n`), maxOutputBytes: oids.length * 128 });
  if (checked.code !== 0 || checked.truncated) return images;
  const sizes = new Map<string, number>();
  for (const line of checked.stdout.split('\n')) {
    const [oid, type, size] = line.split(' ');
    if (oid && type === 'blob' && Number(size) <= MAX_CHECKPOINT_FILE_BYTES) sizes.set(oid, Number(size));
  }
  const wanted = oids.filter(oid => sizes.has(oid));
  const total = wanted.reduce((sum, oid) => sum + sizes.get(oid)!, 0);
  if (!wanted.length || total > MAX_CHECKPOINT_TOTAL_BYTES) return images;
  const read = await host.git(repo, ['cat-file', '--batch'], { input: Buffer.from(`${wanted.join('\n')}\n`), maxOutputBytes: total + wanted.length * 128, timeoutMs: 60_000 });
  if (read.code !== 0 || read.truncated) return images;
  const blobs = new Map<string, Buffer>();
  let offset = 0;
  const out = read.stdoutData;
  for (const oid of wanted) {
    const end = out.indexOf(0x0a, offset);
    if (end < 0) break;
    const [headOid, type, size] = out.subarray(offset, end).toString('utf8').split(' ');
    const length = Number(size);
    if (headOid !== oid || type !== 'blob' || length !== sizes.get(oid)) break;
    blobs.set(oid, out.subarray(end + 1, end + 1 + length));
    offset = end + 1 + length + 1;
  }
  for (const [gitPath, entry] of entries) {
    const data = blobs.get(entry.oid);
    if (data) images.set(gitPath, await blobImage(data, entry.mode, folder));
  }
  return images;
}

/**
 * The index rows (`mode oid stage`) of each path, from `ls-files --stage` in batches: none for a path
 * the index does not hold. A path of a batch Git failed to list is absent.
 */
async function indexRecords(host: GitHost, repo: Repo, gitPaths: string[]): Promise<Map<string, string[]>> {
  const records = new Map<string, string[]>();
  for (let start = 0; start < gitPaths.length; start += INDEX_BATCH_PATHS) {
    const batch = gitPaths.slice(start, start + INDEX_BATCH_PATHS);
    // A row is a path and 50 bytes of mode, id and stage; a path is at most 4 KiB.
    const listed = await host.git(repo, ['ls-files', '--stage', '-z', '--', ...batch.map(literalPath)], { maxOutputBytes: batch.length * 4_200 });
    if (listed.code !== 0 || listed.truncated) continue;
    for (const gitPath of batch) records.set(gitPath, []);
    for (const row of listed.stdout.split('\0').filter(Boolean)) {
      const tab = row.indexOf('\t');
      const rowPath = row.slice(tab + 1);
      records.set(rowPath, [...records.get(rowPath) ?? [], row.slice(0, tab)]);
    }
  }
  return records;
}

/**
 * Whether the entry at `absolute`, or for one that is gone the nearest folder above it that is not,
 * changed at or after `since`: by its ctime, which a write, a rename into place, a mode change and a
 * removal from a folder (the folder's) all move.
 */
async function touchedSince(repo: Repo, absolute: string, since: number): Promise<boolean> {
  for (let target = absolute; ; target = path.dirname(target)) {
    try { return changedSince(await lstat(target), since); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== 'ENOENT' && code !== 'ENOTDIR') || target === repo.root || !isWithin(repo.root, target)) return true;
    }
  }
}

/** Whether HEAD, the branch it is on or its reflog changed at or after `since`, or HEAD is no longer `head`. */
async function headMovedSince(host: GitHost, repo: Repo, head: string | undefined, since: number): Promise<boolean> {
  if (await headCommit(host, repo) !== head) return true;
  const located = await host.git(repo, ['rev-parse', '--git-path', 'HEAD', '--git-path', 'logs/HEAD', '--symbolic-full-name', 'HEAD'], { maxOutputBytes: 64 * 1024 });
  const [headFile, reflog, branch] = located.stdout.split('\n');
  const files = [headFile, reflog];
  if (branch?.startsWith('refs/')) files.push((await host.git(repo, ['rev-parse', '--git-path', branch], { maxOutputBytes: 64 * 1024 })).stdout.trim());
  for (const file of files) {
    if (!file) continue;
    const info = await lstat(path.resolve(repo.root, file)).catch(() => undefined);
    if (info && changedSince(info, since)) return true;
  }
  return false;
}

async function indexImage(host: GitHost, repo: Repo, gitPath: string, folder?: string): Promise<Image> {
  const result = await host.git(repo, ['ls-files', '--stage', '-z', '--', literalPath(gitPath)], { maxOutputBytes: 128 * 1024 });
  if (result.code !== 0) throw gitError(result, 'ls-files');
  const records = result.stdout.split('\0').filter(Boolean).map(row => row.slice(0, row.indexOf('\t')));
  if (!records.length) return { exists: false, kind: 'missing', mode: 0 };
  if (records.length > 1 || records.some(record => !record.endsWith(' 0'))) throw new AppError('CHECKPOINT_UNMERGED_INDEX', 'Checkpoint cannot snapshot an unresolved Git index entry', 409, { path: gitPath });
  const [mode, oid] = records[0].split(' ');
  return objectImage(host, repo, oid, mode, folder);
}

async function treeImage(host: GitHost, repo: Repo, head: string | undefined, gitPath: string, folder?: string): Promise<Image> {
  if (!head) return { exists: false, kind: 'missing', mode: 0 };
  const result = await host.git(repo, ['ls-tree', '-z', head, '--', literalPath(gitPath)], { maxOutputBytes: 128 * 1024 });
  if (result.code !== 0) throw gitError(result, 'ls-tree');
  const record = result.stdout.split('\0').filter(Boolean).find(row => row.slice(row.indexOf('\t') + 1) === gitPath);
  if (!record) return { exists: false, kind: 'missing', mode: 0 };
  const [mode, type, oid] = record.slice(0, record.indexOf('\t')).split(' ');
  if (type !== 'blob') return { exists: false, kind: 'missing', mode: 0 };
  return objectImage(host, repo, oid, mode, folder);
}

/**
 * With `paths` (project-relative files) the checkpoint is partial: it holds those files, changed or not, and nothing else.
 *
 * With `since`, it is taken while something may already be changing the files (a turn sent at that
 * time), so it holds only what it can tell is from before: a file whose worktree side changed after
 * `since`, or whose index entry changed while it was read, is left out (`excluded`), and if HEAD moved
 * it holds nothing at all (`CHECKPOINT_HEAD_MOVED`). A file changed after `since` that was clean
 * before needs nothing: status did not list it, and the checkpoint takes it from HEAD.
 */
export async function createCheckpointRecord(host: GitHost, repo: Repo, options: { sessionId?: string; runId?: string; title?: string; paths?: string[]; since?: number }): Promise<CheckpointManifest> {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const title = options.title?.trim().slice(0, 300) || `Checkpoint ${createdAt}`;
  const folder = checkpointPath(host, repo, id);
  // Status first: a change a running turn makes before it lists a file that is clean, or gone, by then is one nothing can see.
  const [dirty, head] = await Promise.all([
    options.paths ? options.paths.map(item => path.relative(repo.root, path.resolve(repo.projectRoot, item)).split(path.sep).join('/')) : dirtyPaths(host, repo),
    headCommit(host, repo),
    mkdir(folder, { recursive: true, mode: 0o700 }),
  ]);
  const manifest: CheckpointManifest = {
    checkpoint: { id, projectId: repo.projectId, ...(options.sessionId ? { sessionId: options.sessionId } : {}), ...(options.runId ? { runId: options.runId } : {}), title, createdAt, files: 0, excluded: [], ...(options.paths ? { partial: true } : {}) },
    projectRoot: repo.projectRoot,
    ...(head ? { head } : {}),
    files: [],
  };
  let totalBytes = 0;
  const kept = dirty.slice(0, MAX_CHECKPOINT_FILES);
  const records = await indexRecords(host, repo, kept);
  const staged = await indexImages(host, repo, kept, records, folder);
  const gitPaths = new Map<string, string>();
  const { since } = options;
  for (const gitPath of kept) {
    const relative = asRelativePath(repo.root, repo.projectRoot, gitPath);
    if (relative === undefined) continue;
    try {
      const index = staged.get(gitPath) ?? await indexImage(host, repo, gitPath, folder);
      const worktree = await readWorktreeImage(repo, relative, folder);
      // Checked after the read: unchanged since `since` until now, what was read is from before it.
      if (since !== undefined && await touchedSince(repo, path.join(repo.root, gitPath), since)) { manifest.checkpoint.excluded.push(relative); continue; }
      totalBytes += (index.size ?? 0) + (worktree.size ?? 0);
      if (totalBytes > MAX_CHECKPOINT_TOTAL_BYTES) throw new AppError('CHECKPOINT_TOTAL_TOO_LARGE', 'Checkpoint exceeds the total size limit', 413);
      manifest.files.push({ path: relative, index, worktree });
      gitPaths.set(relative, gitPath);
    } catch (error) {
      const code = error instanceof AppError ? error.code : '';
      if (code.startsWith('CHECKPOINT_') || code === 'PATH_OUTSIDE_PROJECT') manifest.checkpoint.excluded.push(relative);
      else throw error;
    }
  }
  for (const gitPath of dirty.slice(MAX_CHECKPOINT_FILES)) {
    const relative = asRelativePath(repo.root, repo.projectRoot, gitPath);
    if (relative !== undefined) manifest.checkpoint.excluded.push(relative);
  }
  if (since !== undefined) {
    // Status leaves the index alone (`GIT_OPTIONAL_LOCKS`), so a row that differs now was changed by someone else meanwhile.
    const now = await indexRecords(host, repo, [...gitPaths.values()]);
    const same = (a?: string[], b?: string[]) => a !== undefined && b !== undefined && a.join('\n') === b.join('\n');
    const moved = new Set(manifest.files.filter(item => !same(records.get(gitPaths.get(item.path)!), now.get(gitPaths.get(item.path)!))).map(item => item.path));
    manifest.files = manifest.files.filter(item => !moved.has(item.path));
    manifest.checkpoint.excluded.push(...moved);
    if (await headMovedSince(host, repo, head, since)) {
      await rm(folder, { recursive: true, force: true }).catch(() => undefined);
      throw new AppError('CHECKPOINT_HEAD_MOVED', 'HEAD moved while the checkpoint was taken', 409);
    }
  }
  manifest.checkpoint.files = manifest.files.length;
  await writeFile(path.join(folder, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600, flag: 'wx' });
  return manifest;
}

/** Saves [paths] as they are now, before a discard changes them. Without `permanent`, a path that cannot be saved stops the discard. */
export async function discardBackup(host: GitHost, repo: Repo, paths: string[], permanent = false): Promise<Checkpoint | undefined> {
  const title = `Before discard: ${paths[0]}${paths.length > 1 ? ` and ${paths.length - 1} more` : ''}`;
  const { checkpoint } = await createCheckpointRecord(host, repo, { title, paths });
  if (checkpoint.excluded.length) {
    // A checkpoint with files left out cannot be restored, so it would only promise an undo it cannot give.
    await rm(checkpointPath(host, repo, checkpoint.id), { recursive: true, force: true });
    if (!permanent) throw new AppError('DISCARD_UNRECOVERABLE', 'Some of these files cannot be saved first, so discarding them could not be undone', 409, { paths: checkpoint.excluded });
    return undefined;
  }
  for (const stale of (await listCheckpoints(host, repo)).filter(item => item.partial).slice(PARTIAL_CHECKPOINTS_KEPT)) {
    await rm(checkpointPath(host, repo, stale.id), { recursive: true, force: true }).catch(() => undefined);
  }
  await pruneOrphanCheckpointObjects(host, repo);
  return checkpoint;
}

/** Folders a capture left without a manifest when the service stopped during it, an hour on. */
async function pruneUnfinishedCheckpoints(host: GitHost, repo: Repo): Promise<void> {
  const folder = checkpointFolder(host, repo);
  for (const name of await readdir(folder).catch(() => [] as string[])) {
    if (!/^[a-f0-9-]{36}$/i.test(name)) continue;
    const entry = path.join(folder, name);
    if (await lstat(path.join(entry, 'manifest.json')).then(() => true, () => false)) continue;
    const info = await lstat(entry).catch(() => undefined);
    if (info?.isDirectory() && Date.now() - info.mtimeMs > UNFINISHED_CHECKPOINT_MS) await rm(entry, { recursive: true, force: true }).catch(() => undefined);
  }
  await pruneOrphanCheckpointObjects(host, repo);
}

export async function readManifest(host: GitHost, repo: Repo, id: string): Promise<CheckpointManifest> {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new AppError('CHECKPOINT_NOT_FOUND', 'Checkpoint does not exist', 404);
  try {
    const folder = checkpointPath(host, repo, id);
    const manifestPath = path.join(folder, 'manifest.json');
    const manifestInfo = await lstat(manifestPath);
    if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile() || manifestInfo.size > 16 * MB) throw new Error('invalid checkpoint manifest');
    const data = JSON.parse(await readFile(manifestPath, 'utf8')) as CheckpointManifest;
    const actualFolder = await realpath(folder);
    const checkpointRoot = await realpath(checkpointFolder(host, repo));
    if (!data || typeof data !== 'object' || !data.checkpoint || typeof data.checkpoint !== 'object' || !Array.isArray(data.files) || data.files.length > MAX_CHECKPOINT_FILES || !Array.isArray(data.checkpoint.excluded) || data.checkpoint.excluded.length > MAX_CHECKPOINT_FILES || !actualFolder.startsWith(`${checkpointRoot}${path.sep}`) || data.checkpoint.id !== id || data.checkpoint.projectId !== repo.projectId || data.projectRoot !== repo.projectRoot || !Number.isSafeInteger(data.checkpoint.files) || data.checkpoint.files !== data.files.length || typeof data.checkpoint.title !== 'string' || (data.checkpoint.runId !== undefined && typeof data.checkpoint.runId !== 'string') || typeof data.checkpoint.createdAt !== 'string' || (data.checkpoint.partial !== undefined && data.checkpoint.partial !== true) || (data.head !== undefined && !/^[a-f0-9]{40,64}$/i.test(data.head))) throw new Error('checkpoint does not belong to project');
    const seen = new Set<string>();
    const validImage = (image: Image): boolean => Boolean(image && typeof image === 'object' && typeof image.exists === 'boolean' && Number.isSafeInteger(image.mode) && image.mode >= 0 && image.mode <= 0o177777 && (image.exists
      ? (image.kind === 'file' || image.kind === 'symlink') && Number.isSafeInteger(image.size) && image.size! >= 0 && image.size! <= MAX_CHECKPOINT_FILE_BYTES && typeof image.blob === 'string' && /^blob-[a-f0-9]{64}$/.test(image.blob) && typeof image.hash === 'string' && /^[a-f0-9]{64}$/.test(image.hash) && (image.kind !== 'symlink' || typeof image.linkTarget === 'string')
      : image.kind === 'missing'));
    for (const item of data.files) {
      if (!item || typeof item.path !== 'string' || !item.path || item.path.includes('\0') || path.isAbsolute(item.path) || !isWithin(repo.projectRoot, path.resolve(repo.projectRoot, item.path)) || seen.has(item.path) || !validImage(item.index) || !validImage(item.worktree)) throw new Error('invalid checkpoint files');
      seen.add(item.path);
    }
    if (data.checkpoint.excluded.some(item => typeof item !== 'string' || !item || item.includes('\0') || path.isAbsolute(item) || !isWithin(repo.projectRoot, path.resolve(repo.projectRoot, item)))) throw new Error('invalid excluded checkpoint paths');
    return data;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('CHECKPOINT_NOT_FOUND', 'Checkpoint does not exist for this project', 404);
  }
}

export async function listCheckpoints(host: GitHost, repo: Repo): Promise<Checkpoint[]> {
  const folder = checkpointFolder(host, repo);
  const names = await readdir(folder).catch(() => [] as string[]);
  const records: Checkpoint[] = [];
  for (const name of names) {
    try { records.push((await readManifest(host, repo, name)).checkpoint); } catch { /* Ignore incomplete or foreign records. */ }
  }
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function checkpointState(host: GitHost, repo: Repo, manifest: CheckpointManifest, projectPath: string, folder: string): Promise<{ index: Image; worktree: Image }> {
  const saved = manifest.files.find(item => item.path === projectPath);
  if (saved) return { index: saved.index, worktree: saved.worktree };
  const gitPath = path.relative(repo.root, path.resolve(repo.projectRoot, projectPath)).split(path.sep).join('/');
  const tree = await treeImage(host, repo, manifest.head, gitPath, folder);
  return { index: tree, worktree: tree };
}

async function currentState(host: GitHost, repo: Repo, projectPath: string, folder?: string): Promise<{ index: Image; worktree: Image }> {
  const absolute = await resolveScopedPath(repo.projectRoot, projectPath, true);
  const gitPath = path.relative(repo.root, absolute).split(path.sep).join('/');
  const index = await indexImage(host, repo, gitPath, folder);
  const worktree = await readWorktreeImage(repo, projectPath, folder);
  return { index, worktree };
}

async function changeList(host: GitHost, repo: Repo, manifest: CheckpointManifest): Promise<CheckpointChange[]> {
  if (manifest.checkpoint.excluded.length) throw new AppError('CHECKPOINT_EXCLUDED_CHANGES', 'Checkpoint includes paths that cannot be safely inspected', 409, { paths: manifest.checkpoint.excluded });
  const allPaths = new Set(manifest.files.map(item => item.path));
  // A partial checkpoint speaks only for its own files; anything else changed is not its to put back.
  for (const gitPath of manifest.checkpoint.partial ? [] : await dirtyPaths(host, repo)) {
    const relative = asRelativePath(repo.root, repo.projectRoot, gitPath);
    if (relative !== undefined) allPaths.add(relative);
  }
  const result: CheckpointChange[] = [];
  for (const filePath of [...allPaths].sort((a, b) => a.localeCompare(b))) {
    const before = await checkpointState(host, repo, manifest, filePath, checkpointPath(host, repo, manifest.checkpoint.id));
    const after = await currentState(host, repo, filePath);
    const beforeHash = fileStateHash(before.index, before.worktree);
    const afterHash = fileStateHash(after.index, after.worktree);
    if (beforeHash === afterHash) continue;
    const wasPresent = before.worktree.exists;
    const isPresent = after.worktree.exists;
    const kind: CheckpointChange['kind'] = !wasPresent && isPresent ? 'added' : wasPresent && !isPresent ? 'deleted' : 'modified';
    result.push({ path: filePath, kind, beforeHash, afterHash });
  }
  return result;
}

export async function imageData(folder: string, image: Image): Promise<Buffer> {
  if (!image.exists) return Buffer.alloc(0);
  if (!image.blob || !/^blob-[a-f0-9]{64}$/.test(image.blob)) throw new AppError('CHECKPOINT_CORRUPT', 'Checkpoint file content is missing', 500);
  const target = path.join(folder, image.blob);
  const realFolder = await realpath(folder);
  const realTarget = await realpath(target);
  if (!realTarget.startsWith(`${realFolder}${path.sep}`)) throw new AppError('CHECKPOINT_CORRUPT', 'Checkpoint file content is invalid', 500);
  const handle = await open(realTarget, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_CHECKPOINT_FILE_BYTES || info.size !== image.size) throw new AppError('CHECKPOINT_CORRUPT', 'Checkpoint file content has an invalid size', 500);
    const data = Buffer.alloc(info.size);
    let read = 0;
    while (read < data.length) {
      const result = await handle.read(data, read, data.length - read, read);
      if (!result.bytesRead) throw new AppError('CHECKPOINT_CORRUPT', 'Checkpoint file content was truncated', 500);
      read += result.bytesRead;
    }
    if ((await handle.stat()).size !== info.size || hash(data) !== image.hash) throw new AppError('CHECKPOINT_CORRUPT', 'Checkpoint file content failed its integrity check', 500);
    return data;
  } finally { await handle.close(); }
}

export async function atomicWorktreeImage(repo: Repo, projectRelative: string, image: Image, folder: string): Promise<void> {
  const target = await resolveScopedPath(repo.projectRoot, projectRelative, true);
  if (!image.exists) {
    try {
      const info = await lstat(target);
      if (info.isDirectory()) throw new AppError('RESTORE_TARGET_DIRECTORY', 'Refusing to remove a directory during checkpoint restore', 409, { path: projectRelative });
      await rm(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error;
    }
    return;
  }
  const data = await imageData(folder, image);
  await replaceWorktreeFile(repo, projectRelative, image.kind === 'symlink' ? { data, link: image.linkTarget ?? data.toString('utf8') } : { data, mode: image.mode & 0o777 || 0o600 });
}

export async function setIndexImage(host: GitHost, repo: Repo, projectRelative: string, image: Image, folder: string): Promise<void> {
  const absolute = await resolveScopedPath(repo.projectRoot, projectRelative, true);
  const gitPath = path.relative(repo.root, absolute).split(path.sep).join('/');
  if (!image.exists) {
    // `update-index` takes plain paths: given pathspec magic it removed nothing and reported success.
    return writeIndex(host, repo, gitPath);
  }
  await writeIndex(host, repo, gitPath, { data: await imageData(folder, image), mode: image.mode });
}

async function applyManifest(host: GitHost, repo: Repo, manifest: CheckpointManifest, paths: string[]): Promise<void> {
  const folder = checkpointPath(host, repo, manifest.checkpoint.id);
  for (const filePath of paths) {
    const state = await checkpointState(host, repo, manifest, filePath, folder);
    await atomicWorktreeImage(repo, filePath, state.worktree, folder);
    await setIndexImage(host, repo, filePath, state.index, folder);
  }
}

export async function createCheckpoint(host: GitHost, project: ProjectRef, options: { sessionId?: string; runId?: string; title?: string } = {}): Promise<Checkpoint> {
  const repo = await host.repo(project);
  return (await createCheckpointRecord(host, repo, options)).checkpoint;
}

/**
 * The checkpoint a turn starts from, so the turn can be undone. Older turn checkpoints of the
 * project are pruned past a fixed count; ones a person took by hand are left alone.
 */
export async function createTurnCheckpoint(host: GitHost, project: ProjectRef, options: { sessionId: string; runId: string; title: string; since: number }): Promise<Checkpoint | undefined> {
  const repo = await host.repo(project);
  const key = JSON.stringify([repo.projectId, options.sessionId, options.runId]);
  const pending = host.turnCheckpoints.get(key);
  if (pending) return pending;
  const capture = (async () => {
    // Taken while the turn runs (`since`), so before anything else. A commit made meanwhile leaves no
    // way to tell which clean files were clean before it, and no checkpoint is better than a misleading one.
    const taken = await createCheckpointRecord(host, repo, options).then(manifest => manifest.checkpoint, error => {
      if (error instanceof AppError && error.code === 'CHECKPOINT_HEAD_MOVED') return undefined;
      throw error;
    });
    // One this turn already has (a retry after a restart) stays the one it is undone to.
    const all = await listCheckpoints(host, repo);
    const earlier = all.find(item => item.runId === options.runId && item.sessionId === options.sessionId && item.id !== taken?.id);
    if (earlier && taken) await rm(checkpointPath(host, repo, taken.id), { recursive: true, force: true }).catch(() => undefined);
    const checkpoint = earlier ?? taken;
    const turns = all.filter(item => item.runId && item.id !== (earlier && taken?.id));
    for (const stale of turns.slice(TURN_CHECKPOINTS_KEPT)) await rm(checkpointPath(host, repo, stale.id), { recursive: true, force: true }).catch(() => undefined);
    await pruneUnfinishedCheckpoints(host, repo);
    return checkpoint;
  })();
  host.turnCheckpoints.set(key, capture);
  try { return await capture; }
  finally { host.turnCheckpoints.delete(key); }
}

export async function checkpointChanges(host: GitHost, project: ProjectRef, id: string): Promise<CheckpointChange[]> {
  const repo = await host.repo(project);
  const manifest = await readManifest(host, repo, id);
  return changeList(host, repo, manifest);
}

export async function restoreCheckpoint(host: GitHost, project: ProjectRef, id: string, expectedChanges: CheckpointChange[]): Promise<{ restored: number; backup: Checkpoint }> {
  const repo = await host.repo(project);
  return host.mutate(repo, async () => {
    const manifest = await readManifest(host, repo, id);
    if (manifest.checkpoint.excluded.length) throw new AppError('CHECKPOINT_EXCLUDED_CHANGES', 'Checkpoint contains files that cannot be safely restored', 409, { paths: manifest.checkpoint.excluded });
    if (!Array.isArray(expectedChanges) || expectedChanges.length > MAX_CHECKPOINT_FILES) throw new AppError('INVALID_EXPECTED_CHANGES', 'Expected checkpoint changes are invalid');
    const current = await changeList(host, repo, manifest);
    if (normalizeChanges(current) !== normalizeChanges(expectedChanges)) throw new AppError('CHECKPOINT_CONFLICT', 'Project files changed since the checkpoint preview; refresh the changes before restoring', 409, { changes: current });
    const scope = manifest.checkpoint.partial ? { paths: manifest.files.map(item => item.path) } : {};
    if (!current.length) return { restored: 0, backup: (await createCheckpointRecord(host, repo, { title: `Before restore: ${manifest.checkpoint.title}`, ...scope })).checkpoint };

    const backupManifest = await createCheckpointRecord(host, repo, { title: `Before restore: ${manifest.checkpoint.title}`, ...scope });
    const changedPaths = current.map(change => change.path);
    const checkedAgain = await changeList(host, repo, manifest);
    if (normalizeChanges(current) !== normalizeChanges(checkedAgain)) throw new AppError('CHECKPOINT_CONFLICT', 'Project files changed while restoring; no files were restored', 409, { changes: checkedAgain, backup: backupManifest.checkpoint });
    try {
      await applyManifest(host, repo, manifest, changedPaths);
    } catch (error) {
      try { await applyManifest(host, repo, backupManifest, changedPaths); } catch { /* Keep the pre-restore checkpoint for manual recovery. */ }
      if (error instanceof AppError) throw error;
      throw new AppError('CHECKPOINT_RESTORE_FAILED', 'Could not complete checkpoint restore; a pre-restore checkpoint was saved', 500, { backupId: backupManifest.checkpoint.id });
    }
    return { restored: changedPaths.length, backup: backupManifest.checkpoint };
  });
}
