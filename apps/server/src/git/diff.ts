import { lstat, mkdtemp, open, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Checkpoint, GitDiff, GitLineChange, GitStatus } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import type { ProjectRef } from '../workspace/scope.js';
import { checkpointPath, discardBackup, imageData, readManifest } from './checkpoints.js';
import { runProcess } from './exec.js';
import {
  asRelativePath, commitParents, GIT_ENV, gitError, gitPaths, hash, headCommit, literalPath,
  MAX_DIFF_BYTES, MAX_LINE_CHANGES, MB, MISSING_SIDE, removeWorktreeFile, replaceWorktreeFile,
  resolveGitPath, revision, UNMERGED, writeIndex, type CheckpointManifest, type DiffScope,
  type GitFile, type GitHost, type Repo, type Side,
} from './shared.js';

/** The lines of [data], each with its terminator. */
function splitLines(data: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  for (let start = 0; start < data.length;) {
    const end = data.indexOf(10, start);
    lines.push(data.subarray(start, end === -1 ? data.length : end + 1));
    if (end === -1) break;
    start = end + 1;
  }
  return lines;
}

/**
 * [target] with each chosen range of its lines replaced by the matching range of [source]. Ranges
 * are clamped to the content, so an editor that counts the empty line after a final newline still
 * names a valid position.
 */
function spliceLines(target: Buffer, source: Buffer, changes: Array<{ target: [number, number]; source: [number, number] }>): Buffer {
  const lines = splitLines(target), origin = splitLines(source);
  const within = (range: [number, number], length: number): [number, number] => [Math.min(range[0], length), Math.min(range[1], length)];
  const ordered = changes.map(change => ({ target: within(change.target, lines.length), source: within(change.source, origin.length) }))
    .sort((a, b) => a.target[0] - b.target[0] || a.source[0] - b.source[0]);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].target[0] < ordered[index - 1].target[1] || ordered[index].source[0] < ordered[index - 1].source[1]) throw new AppError('INVALID_LINE_CHANGES', 'Line changes overlap');
  }
  for (const change of ordered.reverse()) lines.splice(change.target[0], change.target[1] - change.target[0], ...origin.slice(change.source[0], change.source[1]));
  // A last line without a newline that is no longer last would otherwise run into the one after it.
  const newline = Buffer.from((target.length ? target : source).includes('\r\n') ? '\r\n' : '\n');
  return Buffer.concat(lines.flatMap((line, index) => index < lines.length - 1 && line.at(-1) !== 10 ? [line, newline] : [line]));
}

function lineChanges(value: unknown): GitLineChange[] {
  const range = (item: unknown): item is [number, number] => Array.isArray(item) && item.length === 2 && item.every(part => Number.isSafeInteger(part) && part >= 0) && item[0] <= item[1];
  if (!Array.isArray(value) || !value.length || value.length > MAX_LINE_CHANGES) throw new AppError('INVALID_LINE_CHANGES', 'Select between 1 and 2000 changes');
  return value.map((item: GitLineChange) => {
    if (!item || !range(item.before) || !range(item.after) || (item.before[0] === item.before[1] && item.after[0] === item.after[1])) throw new AppError('INVALID_LINE_CHANGES', 'A line change is invalid');
    return { before: [item.before[0], item.before[1]], after: [item.after[0], item.after[1]] };
  });
}

/**
 * Names the two contents a diff compares, when their lines can be moved one range at a time: both
 * plain text files (or absent), whole, and without a bare carriage return, which some editors
 * count as a line break and Git does not.
 */
function diffVersion(scope: DiffScope, before: Side, after: Side): string | undefined {
  const bareReturn = (data: Buffer) => { for (let at = data.indexOf(13); at !== -1; at = data.indexOf(13, at + 1)) if (data[at + 1] !== 10) return true; return false; };
  const plain = (side: Side) => !side.exists || ((side.mode === 0o100644 || side.mode === 0o100755) && !side.truncated && !side.data.includes(0) && !bareReturn(side.data));
  if (!plain(before) || !plain(after)) return undefined;
  const base = scope.kind === 'checkpoint' ? scope.manifest.checkpoint.id : scope.kind === 'commit' || scope.kind === 'revision' ? scope.commit : scope.kind;
  return hash(JSON.stringify([base, before.exists, before.id, before.mode, after.exists, after.id, after.mode])).slice(0, 32);
}

async function readDiffWorktreeFile(absolute: string): Promise<Buffer | undefined> {
  let handle;
  try { handle = await open(absolute, 'r'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return undefined;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return undefined;
    const buffer = Buffer.alloc(Math.min(info.size, MAX_DIFF_BYTES + 1));
    if (!buffer.length) return buffer;
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

/** The file's entry in the index: absent, or `unmerged` while a conflict keeps several versions of it. */
async function indexEntry(host: GitHost, repo: Repo, gitPath: string): Promise<{ mode: string; oid: string } | 'unmerged' | undefined> {
  const result = await host.git(repo, ['ls-files', '--stage', '-z', '--', literalPath(gitPath)], { maxOutputBytes: 128 * 1024 });
  if (result.code !== 0) throw gitError(result, 'ls-files');
  const records = result.stdout.split('\0').filter(row => row.slice(row.indexOf('\t') + 1) === gitPath).map(row => row.slice(0, row.indexOf('\t')).split(' '));
  if (!records.length) return undefined;
  if (records.length > 1 || records[0][2] !== '0') return 'unmerged';
  return { mode: records[0][0], oid: records[0][1] };
}

async function treeEntry(host: GitHost, repo: Repo, commit: string | undefined, gitPath: string): Promise<{ mode: string; oid: string } | undefined> {
  if (!commit) return undefined;
  const result = await host.git(repo, ['ls-tree', '-z', commit, '--', literalPath(gitPath)], { maxOutputBytes: 128 * 1024 });
  if (result.code !== 0) throw gitError(result, 'ls-tree');
  const record = result.stdout.split('\0').find(row => row.slice(row.indexOf('\t') + 1) === gitPath);
  if (!record) return undefined;
  const [mode, type, oid] = record.slice(0, record.indexOf('\t')).split(' ');
  return type === 'blob' || type === 'commit' ? { mode, oid } : undefined;
}

async function blobSide(host: GitHost, repo: Repo, entry: { mode: string; oid: string } | undefined): Promise<Side> {
  if (!entry) return MISSING_SIDE;
  const mode = parseInt(entry.mode, 8);
  // A submodule's entry names a commit of another repository; there is no content to compare here.
  if (mode === 0o160000) return { exists: true, mode, data: Buffer.alloc(0), id: entry.oid };
  const result = await host.git(repo, ['cat-file', 'blob', entry.oid], { maxOutputBytes: MAX_DIFF_BYTES + 1, timeoutMs: 15_000 });
  if (result.code !== 0 && !result.truncated) throw gitError(result, 'cat-file');
  return { exists: true, mode, data: result.stdoutData, id: entry.oid, oid: entry.oid, ...(result.truncated || result.stdoutData.length > MAX_DIFF_BYTES ? { truncated: true } : {}) };
}

async function worktreeSide(absolute: string): Promise<Side> {
  const info = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
    throw error;
  });
  if (!info) return MISSING_SIDE;
  if (info.isSymbolicLink()) {
    const target = Buffer.from(await readlink(absolute));
    return { exists: true, mode: 0o120000, data: target, id: hash(target) };
  }
  if (!info.isFile()) return { exists: true, mode: 0o160000, data: Buffer.alloc(0), id: 'directory' };
  const data = await readDiffWorktreeFile(absolute) ?? Buffer.alloc(0);
  return { exists: true, mode: info.mode & 0o111 ? 0o100755 : 0o100644, data, id: hash(data), ...(data.length > MAX_DIFF_BYTES ? { truncated: true } : {}) };
}

/** The file as a checkpoint has it: its saved copy, or the commit the checkpoint was taken on for a file that was clean then. */
async function checkpointSide(host: GitHost, repo: Repo, manifest: CheckpointManifest, file: GitFile): Promise<Side> {
  const saved = manifest.files.find(item => item.path === file.projectRelative);
  if (!saved) return blobSide(host, repo, await treeEntry(host, repo, manifest.head, file.gitRelative));
  if (!saved.worktree.exists) return MISSING_SIDE;
  const data = await imageData(checkpointPath(host, repo, manifest.checkpoint.id), saved.worktree);
  return {
    exists: true, mode: saved.worktree.kind === 'symlink' ? 0o120000 : saved.worktree.mode & 0o111 ? 0o100755 : 0o100644,
    data: data.subarray(0, MAX_DIFF_BYTES + 1), id: saved.worktree.hash!, ...(data.length > MAX_DIFF_BYTES ? { truncated: true } : {}),
  };
}

/** What a diff compares the working tree with: the index, `checkpoint:<id>`, or a commit. `staged` compares the index with HEAD instead. */
async function diffScope(host: GitHost, repo: Repo, options: { staged?: boolean; base?: string; commit?: string; from?: string }): Promise<DiffScope> {
  if (options.commit) {
    const [commit, parent] = await commitParents(host, repo, options.commit);
    return { kind: 'revision', commit, ...(parent ? { parent } : {}), ...(options.from ? { from: (await resolveGitPath(repo, options.from)).gitRelative } : {}) };
  }
  if (options.staged) return { kind: 'staged' };
  const base = options.base;
  if (!base) return { kind: 'worktree' };
  if (typeof base !== 'string' || base.length > 255 || base.startsWith('-') || base.includes('\0')) throw new AppError('INVALID_BASE', 'Comparison base is invalid');
  if (base.startsWith('checkpoint:')) return { kind: 'checkpoint', manifest: await readManifest(host, repo, base.slice('checkpoint:'.length)) };
  const commit = await revision(host, repo, `${base}^{commit}`);
  if (!commit) throw new AppError('INVALID_BASE', 'Comparison base does not identify a commit', 422);
  return { kind: 'commit', commit };
}

/**
 * Several blobs in one Git process, each named as `cat-file` takes them (`:path`, `HEAD:path`,
 * `<commit>:path`); a name that resolves to nothing comes back undefined. Opening the object store
 * is the expensive step in a repository of many packs, so it is done once for all of them.
 */
async function readBlobs(host: GitHost, repo: Repo, names: string[]): Promise<Array<{ oid: string; data: Buffer; truncated?: boolean } | undefined>> {
  if (names.some(name => /[\n\0]/.test(name))) throw new AppError('INVALID_PATH', 'Git path is invalid');
  const result = await host.git(repo, ['cat-file', '--batch'], { input: Buffer.from(names.map(name => `${name}\n`).join('')), maxOutputBytes: names.length * (MAX_DIFF_BYTES + 4096), timeoutMs: 30_000 });
  if (result.code !== 0 && !result.truncated) throw gitError(result, 'cat-file');
  const output = result.stdoutData;
  const blobs: Array<{ oid: string; data: Buffer; truncated?: boolean } | undefined> = [];
  let at = 0;
  for (let index = 0; index < names.length; index += 1) {
    const end = output.indexOf(10, at);
    // Output cut short by a blob too large to show: that one and any after it are known only as too large.
    if (end === -1) { blobs.push(result.truncated ? { oid: names[index], data: Buffer.alloc(0), truncated: true } : undefined); continue; }
    const header = output.subarray(at, end).toString('utf8').split(' ');
    at = end + 1;
    if (header.length !== 3 || header[1] !== 'blob') { if (header.length === 3) at += Number(header[2]) + 1; blobs.push(undefined); continue; }
    const size = Number(header[2]);
    const data = output.subarray(at, Math.min(at + size, output.length));
    at += size + 1;
    blobs.push({ oid: header[0], data: data.subarray(0, MAX_DIFF_BYTES + 1), ...(data.length < size || size > MAX_DIFF_BYTES ? { truncated: true } : {}) });
  }
  return blobs;
}

function blobAsSide(blob: { oid: string; data: Buffer; truncated?: boolean } | undefined, mode: number): Side {
  if (mode === 0o160000) return { exists: true, mode, data: Buffer.alloc(0), id: blob?.oid ?? 'submodule' };
  if (!blob) return MISSING_SIDE;
  return { exists: true, mode, data: blob.data, id: blob.oid, oid: blob.oid, ...(blob.truncated ? { truncated: true } : {}) };
}

async function diffSides(host: GitHost, repo: Repo, file: GitFile, scope: DiffScope): Promise<{ before: Side; after: Side; unmerged?: boolean }> {
  const mode = (entry: { mode: string } | 'unmerged' | undefined) => (entry && entry !== 'unmerged' ? parseInt(entry.mode, 8) : 0o100644);
  if (scope.kind === 'revision') {
    const [before, after] = await readBlobs(host, repo, [...(scope.parent ? [`${scope.parent}:${scope.from ?? file.gitRelative}`] : []), `${scope.commit}:${file.gitRelative}`]).then(blobs => (scope.parent ? blobs : [undefined, blobs[0]]));
    return { before: blobAsSide(before, 0o100644), after: blobAsSide(after, 0o100644) };
  }
  if (scope.kind === 'staged') {
    const head = await headCommit(host, repo);
    const [index, tree, blobs] = await Promise.all([indexEntry(host, repo, file.gitRelative), treeEntry(host, repo, head, file.gitRelative), readBlobs(host, repo, [`HEAD:${file.gitRelative}`, `:${file.gitRelative}`])]);
    const before = tree ? blobAsSide(blobs[0], mode(tree)) : MISSING_SIDE;
    return index === 'unmerged' ? { before, after: MISSING_SIDE, unmerged: true } : { before, after: index ? blobAsSide(blobs[1], mode(index)) : MISSING_SIDE };
  }
  if (scope.kind === 'checkpoint') return { before: await checkpointSide(host, repo, scope.manifest, file), after: await worktreeSide(file.absolute) };
  if (scope.kind === 'commit') {
    const [tree, blobs, after] = await Promise.all([treeEntry(host, repo, scope.commit, file.gitRelative), readBlobs(host, repo, [`${scope.commit}:${file.gitRelative}`]), worktreeSide(file.absolute)]);
    return { before: tree ? blobAsSide(blobs[0], mode(tree)) : MISSING_SIDE, after };
  }
  const [index, blobs, after] = await Promise.all([indexEntry(host, repo, file.gitRelative), readBlobs(host, repo, [`:${file.gitRelative}`]), worktreeSide(file.absolute)]);
  // A conflicted file has no single staged version; what the branch had is the nearest thing to compare with.
  if (index === 'unmerged') return { before: await blobSide(host, repo, await treeEntry(host, repo, await headCommit(host, repo), file.gitRelative)), after, unmerged: true };
  return { before: index ? blobAsSide(blobs[0], mode(index)) : MISSING_SIDE, after };
}

/**
 * The unified diff of two contents, made from the contents themselves: the repository is not
 * consulted again, so the patch always matches the `before` and `after` it is returned with.
 */
async function patchText(file: GitFile, before: Side, after: Side): Promise<{ text: string; truncated: boolean }> {
  if (before.exists === after.exists && before.data.equals(after.data)) return { text: '', truncated: false };
  const folder = await mkdtemp(path.join(tmpdir(), 'riffet-diff-'));
  try {
    await Promise.all([writeFile(path.join(folder, 'a'), before.data), writeFile(path.join(folder, 'b'), after.data)]);
    const patch = await runProcess('git', ['diff', '--no-index', '--no-ext-diff', '--no-color', '--unified=3', '--', 'a', 'b'], { cwd: folder, maxOutputBytes: MAX_DIFF_BYTES + 1, timeoutMs: 15_000, env: { ...GIT_ENV, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    if (patch.code !== 0 && patch.code !== 1) throw gitError(patch, 'diff');
    const hunks = patch.stdout.indexOf('\n@@');
    const header = `diff --git a/${file.gitRelative} b/${file.gitRelative}\n--- ${before.exists ? `a/${file.gitRelative}` : '/dev/null'}\n+++ ${after.exists ? `b/${file.gitRelative}` : '/dev/null'}`;
    return { text: hunks === -1 ? '' : `${header}${patch.stdout.slice(hunks)}`, truncated: patch.truncated };
  } finally { await rm(folder, { recursive: true, force: true }).catch(() => undefined); }
}

export async function diff(host: GitHost, project: ProjectRef, filePath: string, options: { staged?: boolean; base?: string; commit?: string; from?: string } = {}): Promise<GitDiff> {
  const repo = await host.repo(project);
  const file = await resolveGitPath(repo, filePath);
  const scope = await diffScope(host, repo, options);
  const { before, after, unmerged } = await diffSides(host, repo, file, scope);
  const binary = before.data.includes(0) || after.data.includes(0);
  const patch = binary ? { text: '', truncated: false } : await patchText(file, before, after);
  const cut = before.truncated || after.truncated || patch.truncated || patch.text.length > MAX_DIFF_BYTES;
  // A commit is read, never changed; and a cut patch does not show whole runs of lines.
  const version = unmerged || cut || scope.kind === 'revision' ? undefined : diffVersion(scope, before, after);
  return {
    path: file.projectRelative,
    before: binary ? '' : before.data.subarray(0, MAX_DIFF_BYTES).toString('utf8'),
    after: binary ? '' : after.data.subarray(0, MAX_DIFF_BYTES).toString('utf8'),
    patch: binary ? 'Binary files differ' : patch.text.slice(0, MAX_DIFF_BYTES),
    binary,
    ...(cut ? { truncated: true } : {}),
    ...(version ? { version } : {}),
  };
}

export async function stage(host: GitHost, project: ProjectRef, paths: string[]): Promise<GitStatus> {
  const repo = await host.repo(project);
  return host.mutate(repo, async () => {
    const safe = await gitPaths(repo, paths);
    if (!safe.length) throw new AppError('INVALID_PATHS', 'At least one project path is required');
    const result = await host.git(repo, ['add', '--', ...safe.map(literalPath)], { timeoutMs: 30_000, maxOutputBytes: 1 * MB });
    if (result.code !== 0) throw gitError(result, 'stage');
    return host.status(project, true);
  });
}

export async function unstage(host: GitHost, project: ProjectRef, paths: string[]): Promise<GitStatus> {
  const repo = await host.repo(project);
  return host.mutate(repo, async () => {
    const safe = await gitPaths(repo, paths);
    if (!safe.length) throw new AppError('INVALID_PATHS', 'At least one project path is required');
    for (const filePath of safe) {
      const spec = literalPath(filePath);
      let result = await host.git(repo, ['restore', '--staged', '--', spec], { timeoutMs: 15_000, maxOutputBytes: 1 * MB });
      if (result.code !== 0) {
        result = await host.git(repo, ['rm', '--cached', '--force', '--ignore-unmatch', '--', spec], { timeoutMs: 15_000, maxOutputBytes: 1 * MB });
        if (result.code !== 0) throw gitError(result, 'unstage');
      }
    }
    return host.status(project, true);
  });
}

/**
 * Throws away the working tree's changes to [paths] (files, or directories of them): tracked files
 * go back to what is staged, untracked ones are deleted. Their current content is saved first as a
 * partial checkpoint, returned as `backup`, so restoring it undoes the discard. When a file cannot
 * be saved (too large, say) nothing is discarded unless `permanent` accepts that there is no undo.
 */
export async function discard(host: GitHost, project: ProjectRef, paths: string[], options: { permanent?: boolean } = {}): Promise<{ status: GitStatus; backup?: Checkpoint }> {
  const repo = await host.repo(project);
  return host.mutate(repo, async () => {
    const safe = await gitPaths(repo, paths);
    if (!safe.length) throw new AppError('INVALID_PATHS', 'At least one project path is required');
    const chosen = (file: string) => safe.some(item => file === item || file.startsWith(`${item}/`));
    const targets = (await host.statusRaw(repo, 'all')).paths.filter(item => chosen(item.path) && (item.status === '??' || item.status[1] !== ' ') && !UNMERGED.has(item.status) && asRelativePath(repo.root, repo.projectRoot, item.path) !== undefined);
    if (!targets.length) return { status: await host.status(project, true) };
    const backup = await discardBackup(host, repo, targets.map(item => asRelativePath(repo.root, repo.projectRoot, item.path)!), options.permanent === true);
    const tracked = targets.filter(item => item.status !== '??').map(item => item.path);
    if (tracked.length) {
      const restored = await host.git(repo, ['restore', '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: Buffer.from(tracked.map(literalPath).join('\0')), timeoutMs: 60_000, maxOutputBytes: 1 * MB });
      if (restored.code !== 0) throw gitError(restored, 'restore');
    }
    for (const item of targets) {
      if (item.status === '??') await removeWorktreeFile(repo, path.join(repo.root, item.path));
    }
    return { status: await host.status(project, true), ...(backup ? { backup } : {}) };
  });
}

/**
 * Stages, unstages or discards chosen lines of one file, the way a diff shows them: each change
 * pairs a range of the diff's `before` lines with a range of its `after` lines. `version` is the
 * one that diff carried; if either content has changed since, nothing is written and the reader
 * has to look again. A discard saves the file first and returns that checkpoint as `backup`; with
 * `base` it takes the lines back to a checkpoint or commit rather than to what is staged.
 */
export async function applyLines(host: GitHost, project: ProjectRef, input: { path: string; action: 'stage' | 'unstage' | 'discard'; changes: GitLineChange[]; version: string; base?: string }): Promise<{ status: GitStatus; backup?: Checkpoint }> {
  const changes = lineChanges(input?.changes);
  if (!['stage', 'unstage', 'discard'].includes(input.action)) throw new AppError('INVALID_INPUT', 'Choose stage, unstage or discard');
  const repo = await host.repo(project);
  return host.mutate(repo, async () => {
    const file = await resolveGitPath(repo, input.path);
    const scope = input.action === 'unstage' ? { kind: 'staged' as const } : await diffScope(host, repo, input.action === 'discard' ? { base: input.base } : {});
    const { before, after, unmerged } = await diffSides(host, repo, file, scope);
    const version = unmerged ? undefined : diffVersion(scope, before, after);
    if (!version) throw new AppError('GIT_LINES_UNSUPPORTED', 'Lines of this file cannot be changed one range at a time', 422);
    if (version !== input.version) throw new AppError('GIT_DIFF_STALE', 'The file changed since this diff was read', 409);
    if (input.action === 'stage') {
      const data = spliceLines(before.data, after.data, changes.map(change => ({ target: change.before, source: change.after })));
      await writeIndex(host, repo, file.gitRelative, !after.exists && !data.length ? undefined : { data, mode: before.exists ? before.mode : after.mode, clean: true });
      return { status: await host.status(project, true) };
    }
    if (input.action === 'unstage') {
      const data = spliceLines(after.data, before.data, changes.map(change => ({ target: change.after, source: change.before })));
      await writeIndex(host, repo, file.gitRelative, !before.exists && !data.length ? undefined : { data, mode: after.exists ? after.mode : before.mode });
      return { status: await host.status(project, true) };
    }
    // What Git stores may differ from what it checks out (line endings); the lines put back are the checked-out ones.
    let source = before.data;
    if (before.oid) {
      const smudged = await host.git(repo, ['cat-file', '--filters', `--path=${file.gitRelative}`, before.oid], { maxOutputBytes: 4 * MAX_DIFF_BYTES, timeoutMs: 15_000 });
      if (smudged.code !== 0 || smudged.truncated) throw gitError(smudged, 'cat-file');
      source = smudged.stdoutData;
      if (splitLines(source).length !== splitLines(before.data).length) throw new AppError('GIT_LINES_UNSUPPORTED', 'Lines of this file cannot be changed one range at a time', 422);
    }
    const data = spliceLines(after.data, source, changes.map(change => ({ target: change.after, source: change.before })));
    const backup = await discardBackup(host, repo, [file.projectRelative]);
    // The lines put back were worked out from the file as it was read above; an edit since then would be lost.
    if ((await worktreeSide(file.absolute)).id !== after.id) throw new AppError('GIT_DIFF_STALE', 'The file changed since this diff was read', 409);
    if (!before.exists && !data.length) await removeWorktreeFile(repo, file.absolute);
    else await replaceWorktreeFile(repo, file.projectRelative, { data, mode: before.exists && !after.exists ? (before.mode & 0o111 ? 0o755 : 0o644) : undefined });
    return { status: await host.status(project, true), ...(backup ? { backup } : {}) };
  });
}
