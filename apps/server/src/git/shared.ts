import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rm, rmdir, symlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Checkpoint, CheckpointChange } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import { assertWithin, isWithin, projectRoot, resolveScopedPath, toProjectRelative, type ProjectRef } from '../workspace/scope.js';
import { runProcess, type ProcessResult } from './exec.js';

export const KIB = 1024;
export const MB = KIB * KIB;

export const MAX_CHECKPOINT_FILE_BYTES = 32 * MB;
export const MAX_CHECKPOINT_TOTAL_BYTES = 256 * MB;
export const MAX_CHECKPOINT_FILES = 5_000;
/** Paths one `ls-files` reads for a checkpoint; keeps the argument list far below the system's limit. */
export const INDEX_BATCH_PATHS = 500;
export const MAX_DIFF_BYTES = 1 * MB;
export const MAX_COUNTED_UNTRACKED = 200;
export const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

/** Turn checkpoints kept per project; manual ones are never pruned. Each copies the dirty files of its moment. */
export const TURN_CHECKPOINTS_KEPT = 50;
/** How old a checkpoint folder without a manifest is before it counts as one a stopped capture left. */
export const UNFINISHED_CHECKPOINT_MS = 60 * 60_000;
/** Partial checkpoints kept per project: the copies taken before a discard, which is what undoes it. */
export const PARTIAL_CHECKPOINTS_KEPT = 20;
export const MAX_LINE_CHANGES = 2_000;
/** Past this many files, untracked directories are shown as themselves rather than file by file. */
export const MAX_LISTED_UNTRACKED = 2_000;

/**
 * A read must not take the index lock: `git status` refreshes the index when it can, and an agent's
 * own `git add` or `git commit` running at that moment would fail on `index.lock`.
 */
export const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
/** A push or `gh` call must fail rather than wait for a credential prompt nobody can answer. */
export const NON_INTERACTIVE_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' };

/**
 * Left out of a shadow snapshot on top of the directory's own `.gitignore`: dependency and cache
 * folders that a fresh checkout rebuilds, which would otherwise dwarf the sources being compared.
 */
export const SHADOW_EXCLUDES = ['node_modules/', '.venv/', 'venv/', '__pycache__/', '.gradle/', '.kotlin/', '.next/', '.turbo/', '.DS_Store'];
/** A directory larger than this is not snapshotted: each of its attempts would copy it whole. */
export const MAX_SHADOW_FILES = 20_000;
export const MAX_SHADOW_BYTES = 512 * MB;
export const PR_FIELDS = 'number,url,title,state,isDraft,headRefName,baseRefName,mergeable,reviewDecision,statusCheckRollup';

export interface Image { exists: boolean; kind: 'file' | 'symlink' | 'missing'; mode: number; hash?: string; blob?: string; linkTarget?: string; size?: number; }
export interface CheckpointFile { path: string; index: Image; worktree: Image; }
export interface CheckpointManifest { checkpoint: Checkpoint; projectRoot: string; head?: string; files: CheckpointFile[]; }
/** `shadow` is the git directory of a project's shadow repository (see `shadowRepo`), used instead of one found in its directory. */
export interface Repo { root: string; projectRoot: string; projectId: string; shadow?: string; }
export interface LineStat { added: number; removed: number; }
/** One side of a file comparison. `mode` is Git's; `id` names the content; `oid` is set when it is a Git blob. */
export interface Side { exists: boolean; mode: number; data: Buffer; id: string; oid?: string; truncated?: boolean; }
export type DiffScope = { kind: 'worktree' | 'staged' } | { kind: 'commit'; commit: string } | { kind: 'checkpoint'; manifest: CheckpointManifest }
  /** What one commit changed: `parent` is its first parent, absent for a root commit; `from` is the path a renamed file had there. */
  | { kind: 'revision'; commit: string; parent?: string; from?: string };

export const LOG_PAGE = 150;
export const REMOTE_BRANCHES_LISTED = 50;
/** Line counts are read per file; a change wider than this is listed without them. */
export const MAX_STAT_FILES = 300;
/** Files of one commit or comparison sent to a client. */
export const MAX_CHANGED_FILES = 2_000;
/** Porcelain codes of a path in the middle of a merge: its contents are both sides, not something to discard. */
export const UNMERGED = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
export const LOG_FORMAT = ['%H', '%P', '%an', '%ae', '%aI', '%s'].join('%x1f');

export interface GitFile { absolute: string; projectRelative: string; gitRelative: string; }
export const MISSING_SIDE: Side = { exists: false, mode: 0, data: Buffer.alloc(0), id: '' };
export interface ParsedStatus { branch: string; paths: Array<{ status: string; path: string; originalPath?: string }>; }

export interface GitHost {
  readonly stateDir: string;
  readonly repositoryMutations: Set<string>;
  readonly turnCheckpoints: Map<string, Promise<Checkpoint | undefined>>;
  repo(project: ProjectRef): Promise<Repo>;
  git(repo: Repo, args: string[], options?: { timeoutMs?: number; maxOutputBytes?: number; input?: Buffer }): Promise<ProcessResult>;
  mutate<T>(repo: Repo, operation: () => Promise<T>): Promise<T>;
  status(project: ProjectRef, fresh?: boolean): Promise<import('../../../../packages/contracts/src/index.js').GitStatus>;
  statusRaw(repo: Repo, untracked?: 'collapsed' | 'listed' | 'all'): Promise<ParsedStatus>;
}

export function projectId(project: ProjectRef, root: string): string {
  return typeof project === 'string' ? hash(root).slice(0, 32) : project.id;
}

export function literalPath(filePath: string): string { return `:(literal)${filePath}`; }

/**
 * Whether an entry's ctime is at or after `since` (epoch milliseconds). File systems stamp from a
 * coarse kernel clock, up to a few milliseconds behind the one `since` was read from; one that keeps
 * whole seconds only (a ctime with no fraction) is given two.
 */
export function changedSince(info: { ctimeMs: number }, since: number): boolean {
  return info.ctimeMs >= since - (info.ctimeMs % 1000 === 0 ? 2_000 : 100);
}

export function gitError(result: ProcessResult, operation: string): AppError {
  const message = (result.stderr || result.stdout || `git ${operation} failed`).trim().slice(0, 2000);
  return new AppError('GIT_OPERATION_FAILED', message, 422, { operation, code: result.code, timedOut: result.timedOut });
}

export function parseStatus(output: string): ParsedStatus {
  const items = output.split('\0');
  let branch = '(unknown)';
  const paths: ParsedStatus['paths'] = [];
  let index = 0;
  if (items[0]?.startsWith('## ')) {
    const description = items[0].slice(3);
    branch = description === 'HEAD (no branch)' || description.startsWith('HEAD ') ? '(detached)' : description.replace(/^No commits yet on /, '');
    if (branch.includes('...')) branch = branch.split('...', 1)[0];
    index = 1;
  }
  while (index < items.length) {
    const row = items[index++];
    if (!row || row.length < 4) continue;
    const status = row.slice(0, 2);
    const filePath = row.slice(3);
    let originalPath: string | undefined;
    if (status.includes('R') || status.includes('C')) originalPath = items[index++] || undefined;
    paths.push({ status, path: filePath, ...(originalPath ? { originalPath } : {}) });
  }
  return { branch, paths };
}

export function asRelativePath(root: string, projectRootPath: string, file: string): string | undefined {
  const absolute = path.resolve(root, file);
  if (!isWithin(projectRootPath, absolute)) return undefined;
  return toProjectRelative(projectRootPath, absolute);
}

export function normalizeChanges(changes: CheckpointChange[]): string {
  return JSON.stringify(changes.map(change => ({ path: change.path, kind: change.kind, beforeHash: change.beforeHash, afterHash: change.afterHash })).sort((a, b) => a.path.localeCompare(b.path)));
}

export async function countLines(absolute: string): Promise<number | undefined> {
  const info = await lstat(absolute).catch(() => undefined);
  if (!info?.isFile() || info.size > MAX_DIFF_BYTES) return undefined;
  const data = await readFile(absolute).catch(() => undefined);
  if (!data || data.includes(0)) return undefined;
  return data.length ? data.toString('utf8').split('\n').length - (data.at(-1) === 10 ? 1 : 0) : 0;
}

export async function resolveRepo(project: ProjectRef): Promise<Repo> {
  const root = await projectRoot(project);
  const found = await runProcess('git', ['rev-parse', '--show-toplevel'], { cwd: root, timeoutMs: 10_000, maxOutputBytes: 64 * KIB });
  if (found.truncated) throw new AppError('GIT_OUTPUT_TOO_LARGE', 'Git returned an unexpectedly large repository path', 413);
  if (found.code !== 0 || !found.stdout.trim()) throw new AppError('NOT_A_GIT_REPOSITORY', 'Project is not inside a Git repository', 422);
  const gitRoot = await realpath(found.stdout.trim());
  assertWithin(gitRoot, root, 'INVALID_GIT_ROOT');
  return { root: gitRoot, projectRoot: root, projectId: projectId(project, root) };
}

export function runRepoGit(repo: Repo, args: string[], options: { timeoutMs?: number; maxOutputBytes?: number; input?: Buffer } = {}): Promise<ProcessResult> {
  if (!repo.shadow) return runProcess('git', args, { cwd: repo.root, timeoutMs: options.timeoutMs, maxOutputBytes: options.maxOutputBytes, input: options.input, env: GIT_ENV });
  // The person's hooks and signing are for their own commits: run against a shadow repository they
  // would see their directory as the repository, and could prompt, fail or rewrite files in it.
  return runProcess('git', ['-c', `core.hooksPath=${path.join(repo.shadow, 'no-hooks')}`, '-c', 'commit.gpgsign=false', ...args], {
    cwd: repo.root, timeoutMs: options.timeoutMs, maxOutputBytes: options.maxOutputBytes, input: options.input,
    env: { ...GIT_ENV, GIT_DIR: repo.shadow, GIT_WORK_TREE: repo.root },
  });
}

export async function resolveGitPath(repo: Repo, filePath: string): Promise<GitFile> {
  if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) throw new AppError('INVALID_PATH', 'Git path is invalid');
  const absolute = await resolveScopedPath(repo.projectRoot, filePath);
  const projectRelative = toProjectRelative(repo.projectRoot, absolute);
  if (!projectRelative) throw new AppError('INVALID_PATH', 'Repository root cannot be used as a file path');
  return { absolute, projectRelative, gitRelative: path.relative(repo.root, absolute).split(path.sep).join('/') };
}

export async function gitPaths(repo: Repo, paths: string[]): Promise<string[]> {
  if (!Array.isArray(paths) || paths.length > 500) throw new AppError('INVALID_PATHS', 'Git path list is invalid or too large');
  const safe = new Set<string>();
  for (const item of paths) {
    const absolute = await resolveScopedPath(repo.projectRoot, item);
    const relative = path.relative(repo.root, absolute).split(path.sep).join('/');
    if (!relative || relative === '..' || relative.startsWith('../')) throw new AppError('INVALID_PATH', 'Git path must stay inside the project');
    safe.add(relative);
  }
  return [...safe];
}

export async function headCommit(host: GitHost, repo: Repo): Promise<string | undefined> {
  const result = await host.git(repo, ['rev-parse', '--verify', 'HEAD'], { maxOutputBytes: 4096 });
  return result.code === 0 ? result.stdout.trim() : undefined;
}

export async function revision(host: GitHost, repo: Repo, spec: string): Promise<string | undefined> {
  const result = await host.git(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', spec], { timeoutMs: 10_000, maxOutputBytes: 4096 });
  return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
}

export async function emptyTree(host: GitHost, repo: Repo): Promise<string> {
  const empty = await host.git(repo, ['hash-object', '-t', 'tree', '/dev/null'], { maxOutputBytes: 4096 });
  if (empty.code !== 0) throw gitError(empty, 'hash-object');
  return empty.stdout.trim();
}

export async function commitParents(host: GitHost, repo: Repo, spec: string): Promise<string[]> {
  if (typeof spec !== 'string' || !/^[0-9a-f]{7,64}$/i.test(spec)) throw new AppError('INVALID_COMMIT', 'Commit reference is invalid');
  const result = await host.git(repo, ['rev-parse', `${spec}^{commit}`, `${spec}^@`], { timeoutMs: 30_000, maxOutputBytes: 64 * KIB });
  const hashes = result.stdout.split('\n').filter(Boolean);
  if (result.code !== 0 || !hashes.length) throw new AppError('COMMIT_NOT_FOUND', 'That commit is not in this repository', 404);
  return hashes;
}

export async function writeIndex(host: GitHost, repo: Repo, gitPath: string, content?: { data: Buffer; mode: number; clean?: boolean }): Promise<void> {
  if (!content) {
    const removed = await host.git(repo, ['update-index', '--force-remove', '--', gitPath], { maxOutputBytes: 1 * MB });
    if (removed.code !== 0) throw gitError(removed, 'update-index');
    return;
  }
  // `clean` content comes from the working tree, so it passes through the path's filters (line endings, say) as `git add` would.
  const blob = await host.git(repo, ['hash-object', '-w', ...(content.clean ? [`--path=${gitPath}`] : []), '--stdin'], { input: content.data, maxOutputBytes: 4096 });
  if (blob.code !== 0) throw gitError(blob, 'hash-object');
  const result = await host.git(repo, ['update-index', '--add', '--cacheinfo', content.mode.toString(8), blob.stdout.trim(), gitPath], { maxOutputBytes: 1 * MB });
  if (result.code !== 0) throw gitError(result, 'update-index');
}

/** Deletes a file and the directories it leaves empty, as far up as the project's own. */
export async function removeWorktreeFile(repo: Repo, absolute: string): Promise<void> {
  await rm(absolute, { force: true });
  for (let folder = path.dirname(absolute); folder !== repo.projectRoot && isWithin(repo.projectRoot, folder); folder = path.dirname(folder)) {
    if (!(await rmdir(folder).then(() => true, () => false))) break;
  }
}

/** Writes a file (or symlink) beside its destination and renames it into place. Without `mode` an existing file keeps its own. */
export async function replaceWorktreeFile(repo: Repo, projectRelative: string, content: { data: Buffer; mode?: number; link?: string }): Promise<void> {
  const target = await resolveScopedPath(repo.projectRoot, projectRelative, true);
  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true, mode: 0o755 });
  const parentRelative = toProjectRelative(repo.projectRoot, parent);
  await resolveScopedPath(repo.projectRoot, parentRelative || '.', true);
  const temporary = `${target}.${randomUUID()}.codex-tmp`;
  try {
    let existingMode: number | undefined;
    try {
      const existing = await lstat(target);
      if (existing.isDirectory()) throw new AppError('RESTORE_TARGET_DIRECTORY', 'Refusing to replace a directory with a file', 409, { path: projectRelative });
      if (existing.isFile()) existingMode = existing.mode & 0o777;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (content.link !== undefined) {
      assertWithin(repo.projectRoot, path.resolve(parent, content.link), 'CHECKPOINT_SYMLINK_OUTSIDE_PROJECT');
      await symlink(content.link, temporary);
    } else {
      const mode = content.mode ?? existingMode ?? 0o644;
      const handle = await open(temporary, 'wx', mode);
      try { await handle.writeFile(content.data); await handle.chmod(mode); await handle.sync(); } finally { await handle.close(); }
    }
    await resolveScopedPath(repo.projectRoot, parentRelative || '.', true);
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}
