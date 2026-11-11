import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BranchInfo, Checkpoint, CheckpointChange, CheckState, GitDiff, GitEntry, GitStatus, MergeResult, PullRequestCheck, PullRequestInfo, PullRequestStatus, PushResult, WorktreeComparison, WorktreeInfo } from '../../../../packages/contracts/src/index.js';
import { AppError, requireString } from '../errors.js';
import { assertWithin, isWithin, projectRoot, resolveScopedPath, toProjectRelative, type ProjectRef } from '../workspace/scope.js';
import { runProcess, type ProcessResult } from './exec.js';

const MAX_CHECKPOINT_FILE_BYTES = 32 * 1024 * 1024;
const MAX_CHECKPOINT_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_CHECKPOINT_FILES = 5_000;
const MAX_DIFF_BYTES = 1024 * 1024;
const MAX_COUNTED_UNTRACKED = 200;
const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
/** Turn checkpoints kept per project; manual ones are never pruned. Each copies the dirty files of its moment. */
const TURN_CHECKPOINTS_KEPT = 50;
/** A push or `gh` call must fail rather than wait for a credential prompt nobody can answer. */
const NON_INTERACTIVE_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' };
/**
 * Left out of a shadow snapshot on top of the directory's own `.gitignore`: dependency and cache
 * folders that a fresh checkout rebuilds, which would otherwise dwarf the sources being compared.
 */
const SHADOW_EXCLUDES = ['node_modules/', '.venv/', 'venv/', '__pycache__/', '.gradle/', '.kotlin/', '.next/', '.turbo/', '.DS_Store'];
/** A directory larger than this is not snapshotted: each of its attempts would copy it whole. */
const MAX_SHADOW_FILES = 20_000;
const MAX_SHADOW_BYTES = 512 * 1024 * 1024;
const PR_FIELDS = 'number,url,title,state,isDraft,headRefName,baseRefName,mergeable,reviewDecision,statusCheckRollup';

interface Image { exists: boolean; kind: 'file' | 'symlink' | 'missing'; mode: number; hash?: string; blob?: string; linkTarget?: string; size?: number; }
interface CheckpointFile { path: string; index: Image; worktree: Image; }
interface CheckpointManifest { checkpoint: Checkpoint; projectRoot: string; head?: string; files: CheckpointFile[]; }
/** `shadow` is the git directory of a project's shadow repository (see `shadowRepo`), used instead of one found in its directory. */
interface Repo { root: string; projectRoot: string; projectId: string; shadow?: string; }
interface LineStat { added: number; removed: number; }
interface ParsedStatus { branch: string; paths: Array<{ status: string; path: string; originalPath?: string }>; }

/** Keep the source project recognizable; unnamed conversations retain a dated, unique suffix. */
export function generatedBranch(projectName: string, options: { name?: string; suffix?: string } = {}): string {
  const project = Array.from(projectName.normalize('NFKC').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^[-_]+|[-_]+$/g, '')).slice(0, 48).join('').replace(/[-_]+$/g, '') || 'project';
  if (options.name !== undefined && typeof options.name !== 'string') throw new AppError('INVALID_INPUT', 'name must be a string');
  const name = options.name?.trim();
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = options.suffix ? `-${options.suffix.replace(/[^a-zA-Z0-9_-]/g, '-')}` : '';
  const branch = `riffet/${project}_${name || `${stamp}-${randomUUID().slice(0, 4)}${suffix}`}`;
  if (Buffer.byteLength(branch, 'utf8') > 255) throw new AppError('INVALID_BRANCH', 'Branch name is too long');
  // GitService.createWorktree validates the complete name with Git before creating any files or refs.
  return branch;
}

function projectId(project: ProjectRef, root: string): string {
  return typeof project === 'string' ? hash(root).slice(0, 32) : project.id;
}

function literalPath(filePath: string): string { return `:(literal)${filePath}`; }

function gitError(result: ProcessResult, operation: string): AppError {
  const message = (result.stderr || result.stdout || `git ${operation} failed`).trim().slice(0, 2000);
  return new AppError('GIT_OPERATION_FAILED', message, 422, { operation, code: result.code, timedOut: result.timedOut });
}

function parseStatus(output: string): ParsedStatus {
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

function asRelativePath(root: string, projectRootPath: string, file: string): string | undefined {
  const absolute = path.resolve(root, file);
  if (!isWithin(projectRootPath, absolute)) return undefined;
  return toProjectRelative(projectRootPath, absolute);
}

function normalizeChanges(changes: CheckpointChange[]): string {
  return JSON.stringify(changes.map(change => ({ path: change.path, kind: change.kind, beforeHash: change.beforeHash, afterHash: change.afterHash })).sort((a, b) => a.path.localeCompare(b.path)));
}

async function countLines(absolute: string): Promise<number | undefined> {
  const info = await lstat(absolute).catch(() => undefined);
  if (!info?.isFile() || info.size > MAX_DIFF_BYTES) return undefined;
  const data = await readFile(absolute).catch(() => undefined);
  if (!data || data.includes(0)) return undefined;
  return data.length ? data.toString('utf8').split('\n').length - (data.at(-1) === 10 ? 1 : 0) : 0;
}

/** One `statusCheckRollup` entry: a check run reports status+conclusion, a commit status a single state. */
function checkState(item: Record<string, unknown>): CheckState {
  const value = String(item.conclusion || item.state || '').toUpperCase();
  if (item.status && String(item.status).toUpperCase() !== 'COMPLETED') return 'pending';
  if (value === 'SUCCESS') return 'success';
  if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(value)) return 'failure';
  if (value === 'NEUTRAL') return 'neutral';
  if (value === 'SKIPPED' || value === 'STALE') return 'skipped';
  return 'pending';
}

function pullRequestInfo(data: Record<string, unknown>): PullRequestInfo {
  const items: PullRequestCheck[] = (Array.isArray(data.statusCheckRollup) ? data.statusCheckRollup as Array<Record<string, unknown>> : []).map(item => {
    const url = item.detailsUrl || item.targetUrl;
    return { name: String(item.name || item.context || 'check'), state: checkState(item), ...(typeof url === 'string' && url ? { url } : {}) };
  });
  const state: PullRequestInfo['checks']['state'] = !items.length ? 'none'
    : items.some(item => item.state === 'failure') ? 'failure'
    : items.some(item => item.state === 'pending') ? 'pending' : 'success';
  return {
    number: Number(data.number), url: String(data.url ?? ''), title: String(data.title ?? ''),
    state: (['OPEN', 'CLOSED', 'MERGED'].includes(String(data.state)) ? data.state : 'OPEN') as PullRequestInfo['state'],
    isDraft: data.isDraft === true, headRefName: String(data.headRefName ?? ''), baseRefName: String(data.baseRefName ?? ''),
    ...(typeof data.mergeable === 'string' && data.mergeable ? { mergeable: data.mergeable } : {}),
    ...(typeof data.reviewDecision === 'string' && data.reviewDecision ? { reviewDecision: data.reviewDecision } : {}),
    checks: { state, items },
  };
}

function ghError(result: ProcessResult, operation: string): AppError {
  if (result.code === null && /ENOENT/.test(result.stderr)) return new AppError('GH_UNAVAILABLE', 'GitHub CLI (gh) is not installed on this machine', 422);
  const message = (result.stderr || result.stdout || `gh ${operation} failed`).trim().slice(0, 2000);
  return new AppError('GH_OPERATION_FAILED', message, 422, { operation, code: result.code, timedOut: result.timedOut });
}

function fileStateHash(index: Image, worktree: Image): string {
  const shape = (image: Image) => ({ exists: image.exists, kind: image.kind, mode: image.mode, hash: image.hash });
  return hash(JSON.stringify({ index: shape(index), worktree: shape(worktree) }));
}

export class GitService {
  readonly stateDir: string;
  private readonly repositoryMutations = new Set<string>();
  private readonly turnCheckpoints = new Map<string, Promise<Checkpoint | undefined>>();
  constructor(options: { stateDir: string }) {
    if (!options?.stateDir || !path.isAbsolute(options.stateDir)) throw new AppError('INVALID_STATE_DIR', 'stateDir must be an absolute path');
    this.stateDir = path.resolve(options.stateDir);
  }

  private async repo(project: ProjectRef): Promise<Repo> {
    const root = await projectRoot(project);
    const found = await runProcess('git', ['rev-parse', '--show-toplevel'], { cwd: root, timeoutMs: 10_000, maxOutputBytes: 64 * 1024 });
    if (found.truncated) throw new AppError('GIT_OUTPUT_TOO_LARGE', 'Git returned an unexpectedly large repository path', 413);
    if (found.code !== 0 || !found.stdout.trim()) throw new AppError('NOT_A_GIT_REPOSITORY', 'Project is not inside a Git repository', 422);
    const gitRoot = await realpath(found.stdout.trim());
    assertWithin(gitRoot, root, 'INVALID_GIT_ROOT');
    return { root: gitRoot, projectRoot: root, projectId: projectId(project, root) };
  }

  private async git(repo: Repo, args: string[], options: { timeoutMs?: number; maxOutputBytes?: number; input?: Buffer } = {}): Promise<ProcessResult> {
    if (!repo.shadow) return runProcess('git', args, { cwd: repo.root, timeoutMs: options.timeoutMs, maxOutputBytes: options.maxOutputBytes, input: options.input });
    // The person's hooks and signing are for their own commits: run against a shadow repository they
    // would see their directory as the repository, and could prompt, fail or rewrite files in it.
    return runProcess('git', ['-c', `core.hooksPath=${path.join(repo.shadow, 'no-hooks')}`, '-c', 'commit.gpgsign=false', ...args], {
      cwd: repo.root, timeoutMs: options.timeoutMs, maxOutputBytes: options.maxOutputBytes, input: options.input,
      env: { ...process.env, GIT_DIR: repo.shadow, GIT_WORK_TREE: repo.root },
    });
  }

  private shadowDir(projectId: string): string { return path.join(this.stateDir, 'shadow-repos', `${hash(projectId).slice(0, 24)}.git`); }

  /**
   * A directory outside any repository can still be split into worktrees through a private, bare
   * repository kept under the state directory, with the directory as its work tree. Nothing is
   * written into the directory itself: no `.git`, and its own Git tooling keeps seeing no repository.
   * Only worktree operations (attempts, their comparison, adoption and cleanup) reach it; status, the
   * changes panel and checkpoints still report the directory as not a repository.
   */
  private async shadowRepo(project: ProjectRef, create: boolean): Promise<Repo | undefined> {
    const root = await projectRoot(project);
    const id = projectId(project, root);
    const gitDir = this.shadowDir(id);
    const repo: Repo = { root, projectRoot: root, projectId: id, shadow: gitDir };
    const exists = () => stat(path.join(gitDir, 'HEAD')).then(() => true, () => false);
    if (await exists()) return repo;
    if (!create) return undefined;
    // Built aside and renamed into place, so a repository found by its HEAD is always complete: a
    // snapshot taken before the excludes were written would track node_modules for good.
    const pending = `${gitDir}.${randomUUID()}.tmp`;
    await mkdir(path.dirname(gitDir), { recursive: true });
    try {
      const init = await runProcess('git', ['init', '--quiet', '--bare', '--initial-branch=main', pending], { cwd: path.dirname(gitDir), timeoutMs: 30_000, maxOutputBytes: 64 * 1024 });
      if (init.code !== 0) throw gitError(init, 'init shadow repository');
      // Snapshot and merge commits are Riffet's own; they never leave this repository.
      for (const [key, value] of [['user.name', 'Riffet'], ['user.email', 'riffet@localhost']]) {
        const configured = await runProcess('git', ['config', key, value], { cwd: pending, timeoutMs: 10_000, maxOutputBytes: 4096, env: { ...process.env, GIT_DIR: pending } });
        if (configured.code !== 0) throw gitError(configured, 'configure shadow repository');
      }
      const excludes = [...SHADOW_EXCLUDES];
      if (isWithin(root, this.stateDir)) excludes.push(`/${path.relative(root, this.stateDir).split(path.sep).join('/')}/`);
      await mkdir(path.join(pending, 'info'), { recursive: true });
      await writeFile(path.join(pending, 'info', 'exclude'), `${excludes.join('\n')}\n`);
      await rename(pending, gitDir).catch(async (error: NodeJS.ErrnoException) => { if (!(await exists())) throw error; });
    } finally { await rm(pending, { recursive: true, force: true }); }
    return repo;
  }

  /**
   * The repository a project's worktrees belong to: its own, else, when [shadow] allows it, the
   * shadow one its attempts made. Only attempts use a shadow repository; other worktrees of a
   * directory outside Git would start from a stale snapshot, so they keep reporting no repository.
   */
  private async worktreeRepo(project: ProjectRef, shadow = false): Promise<Repo> {
    try { return await this.repo(project); }
    catch (error) {
      if (!shadow || !(error instanceof AppError) || error.code !== 'NOT_A_GIT_REPOSITORY') throw error;
      const found = await this.shadowRepo(project, false);
      if (!found) throw error;
      return found;
    }
  }

  /**
   * Commits the directory as it is now onto the shadow repository's `main`, and returns that commit;
   * an unchanged directory keeps the commit it has, so merging into it can still fast-forward.
   */
  private async snapshot(repo: Repo): Promise<string> {
    const listed = await this.git(repo, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { timeoutMs: 60_000, maxOutputBytes: 16 * 1024 * 1024 });
    if (listed.code !== 0) throw gitError(listed, 'list directory');
    const files = listed.stdout.split('\0').filter(Boolean);
    const tooLarge = () => new AppError('DIRECTORY_TOO_LARGE', `This directory has more than ${MAX_SHADOW_FILES} files or ${MAX_SHADOW_BYTES / 1024 / 1024} MB outside .gitignore; add a .gitignore or make it a Git repository first`, 413, { files: MAX_SHADOW_FILES, bytes: MAX_SHADOW_BYTES });
    if (listed.truncated || files.length > MAX_SHADOW_FILES) throw tooLarge();
    // A repository inside the directory would be recorded as a bare pointer and reach the attempts
    // empty, so whatever they changed in it would be dropped without a word.
    const nested = files.filter(file => file.endsWith('/'));
    if (nested.length) throw new AppError('NESTED_GIT_REPOSITORY', 'This directory contains other Git repositories; open one of them as the project instead', 422, { paths: nested.slice(0, 20).map(file => file.slice(0, -1)) });
    let bytes = 0;
    for (const file of files) {
      bytes += await lstat(path.join(repo.root, file)).then(info => info.size, () => 0);
      if (bytes > MAX_SHADOW_BYTES) throw tooLarge();
    }
    const staged = await this.git(repo, ['add', '--all'], { timeoutMs: 120_000, maxOutputBytes: 1024 * 1024 });
    if (staged.code !== 0) throw gitError(staged, 'add');
    const previous = await this.headCommit(repo);
    if (previous && (await this.git(repo, ['diff', '--cached', '--quiet'], { timeoutMs: 60_000, maxOutputBytes: 4096 })).code === 0) return previous;
    const committed = await this.git(repo, ['commit', '--quiet', '--no-verify', ...(previous ? [] : ['--allow-empty']), '--message', 'Snapshot'], { timeoutMs: 120_000, maxOutputBytes: 1024 * 1024 });
    if (committed.code !== 0) throw gitError(committed, 'commit snapshot');
    const head = await this.headCommit(repo);
    if (!head) throw new AppError('GIT_OPERATION_FAILED', 'The directory snapshot could not be read back', 500);
    return head;
  }

  /**
   * Where a set of worktrees starts: the commit [spec] names, and whether the project has changes
   * that commit leaves out. A directory outside any repository is snapshotted as it is, so its
   * attempts start from exactly what is on disk and leave nothing out.
   */
  async worktreeBase(project: ProjectRef, spec = 'HEAD'): Promise<{ commit?: string; uncommitted: boolean }> {
    if (!spec || spec.length > 255 || spec.startsWith('-') || spec.includes('\0')) throw new AppError('INVALID_BASE', 'Commit reference is invalid');
    let repo: Repo;
    try { repo = await this.repo(project); }
    catch (error) {
      if (!(error instanceof AppError) || error.code !== 'NOT_A_GIT_REPOSITORY') throw error;
      if (spec !== 'HEAD') throw new AppError('INVALID_BASE', 'A directory outside Git can only start from what is on disk', 422);
      const shadow = (await this.shadowRepo(project, true))!;
      return { commit: await this.mutate(shadow, () => this.snapshot(shadow)), uncommitted: false };
    }
    const commit = await this.revision(repo, `${spec}^{commit}`);
    return { ...(commit ? { commit } : {}), uncommitted: (await this.statusRaw(repo)).paths.some(item => asRelativePath(repo.root, repo.projectRoot, item.path) !== undefined) };
  }

  private async mutate<T>(repo: Repo, operation: () => Promise<T>): Promise<T> {
    const common = await this.git(repo, ['rev-parse', '--git-common-dir'], { maxOutputBytes: 4096 });
    if (common.code !== 0 || common.truncated || !common.stdout.trim()) throw gitError(common, 'inspect repository');
    const directory = await realpath(path.resolve(repo.root, common.stdout.trim()));
    if (this.repositoryMutations.has(directory)) throw new AppError('GIT_OPERATION_IN_PROGRESS', 'Another Git operation is already changing this repository', 409);
    this.repositoryMutations.add(directory);
    try { return await operation(); }
    finally { this.repositoryMutations.delete(directory); }
  }

  private async statusRaw(repo: Repo): Promise<ParsedStatus> {
    const result = await this.git(repo, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all'], { maxOutputBytes: 32 * 1024 * 1024 });
    if (result.code !== 0) throw gitError(result, 'status');
    if (result.truncated) throw new AppError('GIT_STATUS_TOO_LARGE', 'Git status contains too many changed paths to return safely', 413);
    return parseStatus(result.stdout);
  }

  async status(project: ProjectRef): Promise<GitStatus> {
    const repo = await this.repo(project);
    const raw = await this.statusRaw(repo);
    const stats = await this.lineStats(repo, raw).catch(() => new Map<string, LineStat>());
    const entries: GitEntry[] = [];
    let added = 0, removed = 0;
    for (const item of raw.paths) {
      const relative = asRelativePath(repo.root, repo.projectRoot, item.path);
      if (relative === undefined) continue;
      const originalPath = item.originalPath ? asRelativePath(repo.root, repo.projectRoot, item.originalPath) : undefined;
      const stat = stats.get(item.path);
      if (stat) { added += stat.added; removed += stat.removed; }
      entries.push({ path: relative, ...(originalPath === undefined ? {} : { originalPath }), index: item.status[0], worktree: item.status[1], ...(stat ?? {}) });
    }
    return { root: repo.root, branch: raw.branch, entries, added, removed };
  }

  /** Lines added/removed per git-relative path, against HEAD (or the empty tree before the first commit). */
  private async lineStats(repo: Repo, raw: ParsedStatus): Promise<Map<string, LineStat>> {
    const stats = new Map<string, LineStat>();
    if (!raw.paths.length) return stats;
    let base = await this.headCommit(repo);
    if (!base) {
      const empty = await this.git(repo, ['hash-object', '-t', 'tree', '/dev/null'], { maxOutputBytes: 4096 });
      if (empty.code !== 0) return stats;
      base = empty.stdout.trim();
    }
    const diff = await this.git(repo, ['diff', '--numstat', '-z', '--no-renames', '--no-ext-diff', base, '--'], { timeoutMs: 15_000, maxOutputBytes: 8 * 1024 * 1024 });
    if (diff.code === 0 && !diff.truncated) {
      for (const record of diff.stdout.split('\0')) {
        const match = /^(\d+)\t(\d+)\t([\s\S]+)$/.exec(record);
        if (match) stats.set(match[3], { added: Number(match[1]), removed: Number(match[2]) });
      }
    }
    let budget = MAX_COUNTED_UNTRACKED;
    for (const item of raw.paths) {
      if (item.status !== '??' || budget-- <= 0) continue;
      const lines = await countLines(path.join(repo.root, item.path));
      if (lines !== undefined) stats.set(item.path, { added: lines, removed: 0 });
    }
    return stats;
  }

  private async resolveGitPath(repo: Repo, filePath: string): Promise<{ absolute: string; projectRelative: string; gitRelative: string }> {
    if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) throw new AppError('INVALID_PATH', 'Git path is invalid');
    const absolute = await resolveScopedPath(repo.projectRoot, filePath);
    const projectRelative = toProjectRelative(repo.projectRoot, absolute);
    if (!projectRelative) throw new AppError('INVALID_PATH', 'Repository root cannot be used as a file path');
    return { absolute, projectRelative, gitRelative: path.relative(repo.root, absolute).split(path.sep).join('/') };
  }

  private async show(repo: Repo, revision: string): Promise<Buffer | undefined> {
    const result = await this.git(repo, ['show', '--no-ext-diff', revision], { maxOutputBytes: MAX_CHECKPOINT_FILE_BYTES + 1, timeoutMs: 15_000 });
    if (result.code !== 0) return undefined;
    return result.stdoutData;
  }

  private async readDiffWorktreeFile(absolute: string): Promise<Buffer | undefined> {
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

  async diff(project: ProjectRef, filePath: string, staged = false): Promise<GitDiff> {
    const repo = await this.repo(project);
    const file = await this.resolveGitPath(repo, filePath);
    const status = await this.statusRaw(repo);
    const statusItem = status.paths.find(item => item.path === file.gitRelative || item.originalPath === file.gitRelative);
    const untracked = statusItem?.status === '??';
    let before: Buffer | undefined;
    let after: Buffer | undefined;
    if (staged) {
      before = await this.show(repo, `HEAD:${file.gitRelative}`);
      after = await this.show(repo, `:${file.gitRelative}`);
    } else if (untracked) {
      before = Buffer.alloc(0);
      after = await this.readDiffWorktreeFile(file.absolute);
    } else {
      before = await this.show(repo, `:${file.gitRelative}`) ?? await this.show(repo, `HEAD:${file.gitRelative}`);
      after = await this.readDiffWorktreeFile(file.absolute);
    }
    before ??= Buffer.alloc(0);
    after ??= Buffer.alloc(0);
    const binary = before.includes(0) || after.includes(0);
    const args = ['diff', '--no-ext-diff', '--no-color', '--unified=3'];
    if (staged) args.push('--cached');
    if (untracked && !staged) args.push('--no-index', '--', '/dev/null', file.gitRelative);
    else args.push('--', literalPath(file.gitRelative));
    const patch = await this.git(repo, args, { maxOutputBytes: MAX_DIFF_BYTES + 1, timeoutMs: 15_000 });
    if (patch.code !== 0 && patch.code !== 1) throw gitError(patch, 'diff');
    const rendered = patch.stdout;
    return {
      path: file.projectRelative,
      before: binary ? '' : before.subarray(0, MAX_DIFF_BYTES).toString('utf8'),
      after: binary ? '' : after.subarray(0, MAX_DIFF_BYTES).toString('utf8'),
      patch: binary ? 'Binary files differ' : rendered.slice(0, MAX_DIFF_BYTES),
      binary,
      ...((before.length > MAX_DIFF_BYTES || after.length > MAX_DIFF_BYTES || patch.truncated || rendered.length > MAX_DIFF_BYTES) ? { truncated: true } : {}),
    };
  }

  async stage(project: ProjectRef, paths: string[]): Promise<GitStatus> {
    const repo = await this.repo(project);
    return this.mutate(repo, async () => {
      const safe = await this.gitPaths(repo, paths);
      if (!safe.length) throw new AppError('INVALID_PATHS', 'At least one project path is required');
      const result = await this.git(repo, ['add', '--', ...safe.map(literalPath)], { timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 });
      if (result.code !== 0) throw gitError(result, 'stage');
      return this.status(project);
    });
  }

  async unstage(project: ProjectRef, paths: string[]): Promise<GitStatus> {
    const repo = await this.repo(project);
    return this.mutate(repo, async () => {
      const safe = await this.gitPaths(repo, paths);
      if (!safe.length) throw new AppError('INVALID_PATHS', 'At least one project path is required');
      for (const filePath of safe) {
        const spec = literalPath(filePath);
        let result = await this.git(repo, ['restore', '--staged', '--', spec], { timeoutMs: 15_000, maxOutputBytes: 1024 * 1024 });
        if (result.code !== 0) {
          result = await this.git(repo, ['rm', '--cached', '--force', '--ignore-unmatch', '--', spec], { timeoutMs: 15_000, maxOutputBytes: 1024 * 1024 });
          if (result.code !== 0) throw gitError(result, 'unstage');
        }
      }
      return this.status(project);
    });
  }

  private async gitPaths(repo: Repo, paths: string[]): Promise<string[]> {
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

  async commit(project: ProjectRef, message: string): Promise<{ hash: string; message: string; status: GitStatus }> {
    requireString(message, 'message', 5_000);
    const repo = await this.repo(project);
    return this.mutate(repo, async () => {
      const result = await this.git(repo, ['commit', '--message', message], { timeoutMs: 120_000, maxOutputBytes: 2 * 1024 * 1024 });
      if (result.code !== 0) throw gitError(result, 'commit');
      const head = await this.git(repo, ['rev-parse', 'HEAD'], { maxOutputBytes: 4096 });
      if (head.code !== 0) throw gitError(head, 'rev-parse');
      return { hash: head.stdout.trim(), message, status: await this.status(project) };
    });
  }

  private checkpointFolder(repo: Repo): string { return path.join(this.stateDir, 'checkpoints', hash(repo.projectId).slice(0, 32)); }
  private checkpointPath(repo: Repo, id: string): string { return path.join(this.checkpointFolder(repo), id); }

  private async headCommit(repo: Repo): Promise<string | undefined> {
    const result = await this.git(repo, ['rev-parse', '--verify', 'HEAD'], { maxOutputBytes: 4096 });
    return result.code === 0 ? result.stdout.trim() : undefined;
  }

  private async dirtyPaths(repo: Repo): Promise<string[]> {
    const status = await this.statusRaw(repo);
    const paths = new Set<string>();
    for (const item of status.paths) {
      if (asRelativePath(repo.root, repo.projectRoot, item.path) !== undefined) paths.add(item.path);
      if (item.originalPath && asRelativePath(repo.root, repo.projectRoot, item.originalPath) !== undefined) paths.add(item.originalPath);
    }
    return [...paths].sort((a, b) => a.localeCompare(b));
  }

  private async storeBlob(folder: string, data: Buffer): Promise<{ blob: string; hash: string }> {
    const digest = hash(data);
    const blob = `blob-${digest}`;
    const target = path.join(folder, blob);
    try {
      const handle = await open(target, 'wx', 0o600);
      try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    return { blob, hash: digest };
  }

  private async readWorktreeImage(repo: Repo, projectRelative: string, folder?: string): Promise<Image> {
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
    if (folder) Object.assign(image, await this.storeBlob(folder, data));
    else image.hash = hash(data);
    if (kind === 'symlink') image.linkTarget = data.toString('utf8');
    return image;
  }

  private async objectImage(repo: Repo, oid: string, mode: string, folder?: string): Promise<Image> {
    const result = await this.git(repo, ['cat-file', 'blob', oid], { maxOutputBytes: MAX_CHECKPOINT_FILE_BYTES + 1, timeoutMs: 15_000 });
    if (result.code !== 0) throw gitError(result, 'cat-file');
    const data = result.stdoutData;
    if (data.length > MAX_CHECKPOINT_FILE_BYTES || result.truncated) throw new AppError('CHECKPOINT_FILE_TOO_LARGE', 'Checkpoint Git blob exceeds the per-file limit', 413, { size: data.length });
    const symlinkMode = mode === '120000';
    const image: Image = { exists: true, kind: symlinkMode ? 'symlink' : 'file', mode: parseInt(mode, 8), size: data.length };
    if (folder) Object.assign(image, await this.storeBlob(folder, data));
    else image.hash = hash(data);
    if (symlinkMode) image.linkTarget = data.toString('utf8');
    return image;
  }

  private async indexImage(repo: Repo, gitPath: string, folder?: string): Promise<Image> {
    const result = await this.git(repo, ['ls-files', '--stage', '-z', '--', literalPath(gitPath)], { maxOutputBytes: 128 * 1024 });
    if (result.code !== 0) throw gitError(result, 'ls-files');
    const records = result.stdout.split('\0').filter(Boolean).map(row => row.slice(0, row.indexOf('\t')));
    if (!records.length) return { exists: false, kind: 'missing', mode: 0 };
    if (records.length > 1 || records.some(record => !record.endsWith(' 0'))) throw new AppError('CHECKPOINT_UNMERGED_INDEX', 'Checkpoint cannot snapshot an unresolved Git index entry', 409, { path: gitPath });
    const [mode, oid] = records[0].split(' ');
    return this.objectImage(repo, oid, mode, folder);
  }

  private async treeImage(repo: Repo, head: string | undefined, gitPath: string, folder?: string): Promise<Image> {
    if (!head) return { exists: false, kind: 'missing', mode: 0 };
    const result = await this.git(repo, ['ls-tree', '-z', head, '--', literalPath(gitPath)], { maxOutputBytes: 128 * 1024 });
    if (result.code !== 0) throw gitError(result, 'ls-tree');
    const record = result.stdout.split('\0').filter(Boolean).find(row => row.slice(row.indexOf('\t') + 1) === gitPath);
    if (!record) return { exists: false, kind: 'missing', mode: 0 };
    const [mode, type, oid] = record.slice(0, record.indexOf('\t')).split(' ');
    if (type !== 'blob') return { exists: false, kind: 'missing', mode: 0 };
    return this.objectImage(repo, oid, mode, folder);
  }

  private async createCheckpointRecord(repo: Repo, options: { sessionId?: string; runId?: string; title?: string }): Promise<CheckpointManifest> {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const title = options.title?.trim().slice(0, 300) || `Checkpoint ${createdAt}`;
    const folder = this.checkpointPath(repo, id);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const head = await this.headCommit(repo);
    const manifest: CheckpointManifest = {
      checkpoint: { id, projectId: repo.projectId, ...(options.sessionId ? { sessionId: options.sessionId } : {}), ...(options.runId ? { runId: options.runId } : {}), title, createdAt, files: 0, excluded: [] },
      projectRoot: repo.projectRoot,
      ...(head ? { head } : {}),
      files: [],
    };
    const dirty = await this.dirtyPaths(repo);
    let totalBytes = 0;
    for (const gitPath of dirty.slice(0, MAX_CHECKPOINT_FILES)) {
      const relative = asRelativePath(repo.root, repo.projectRoot, gitPath);
      if (relative === undefined) continue;
      try {
        const index = await this.indexImage(repo, gitPath, folder);
        const worktree = await this.readWorktreeImage(repo, relative, folder);
        totalBytes += (index.size ?? 0) + (worktree.size ?? 0);
        if (totalBytes > MAX_CHECKPOINT_TOTAL_BYTES) throw new AppError('CHECKPOINT_TOTAL_TOO_LARGE', 'Checkpoint exceeds the total size limit', 413);
        manifest.files.push({ path: relative, index, worktree });
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
    manifest.checkpoint.files = manifest.files.length;
    await writeFile(path.join(folder, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600, flag: 'wx' });
    return manifest;
  }

  async createCheckpoint(project: ProjectRef, options: { sessionId?: string; runId?: string; title?: string } = {}): Promise<Checkpoint> {
    const repo = await this.repo(project);
    return (await this.createCheckpointRecord(repo, options)).checkpoint;
  }

  /**
   * The checkpoint a turn starts from, so the turn can be undone. Older turn checkpoints of the
   * project are pruned past a fixed count; ones a person took by hand are left alone.
   */
  async createTurnCheckpoint(project: ProjectRef, options: { sessionId: string; runId: string; title: string; late?: () => boolean }): Promise<Checkpoint | undefined> {
    const repo = await this.repo(project);
    const key = JSON.stringify([repo.projectId, options.sessionId, options.runId]);
    const pending = this.turnCheckpoints.get(key);
    if (pending) return pending;
    const capture = (async () => {
      const existing = (await this.checkpoints(project)).find(item => item.runId === options.runId && item.sessionId === options.sessionId);
      if (existing) return existing;
      const checkpoint = (await this.createCheckpointRecord(repo, options)).checkpoint;
      // Finished after the turn began, so it may hold some of the turn's own edits: restoring it would
      // undo less than it claims, and no checkpoint is better than a misleading one.
      if (options.late?.()) { await rm(this.checkpointPath(repo, checkpoint.id), { recursive: true, force: true }).catch(() => undefined); return undefined; }
      const turns = (await this.checkpoints(project)).filter(item => item.runId);
      for (const stale of turns.slice(TURN_CHECKPOINTS_KEPT)) await rm(this.checkpointPath(repo, stale.id), { recursive: true, force: true }).catch(() => undefined);
      return checkpoint;
    })();
    this.turnCheckpoints.set(key, capture);
    try { return await capture; }
    finally { this.turnCheckpoints.delete(key); }
  }

  private async readManifest(repo: Repo, id: string): Promise<CheckpointManifest> {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new AppError('CHECKPOINT_NOT_FOUND', 'Checkpoint does not exist', 404);
    try {
      const folder = this.checkpointPath(repo, id);
      const manifestPath = path.join(folder, 'manifest.json');
      const manifestInfo = await lstat(manifestPath);
      if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile() || manifestInfo.size > 16 * 1024 * 1024) throw new Error('invalid checkpoint manifest');
      const data = JSON.parse(await readFile(manifestPath, 'utf8')) as CheckpointManifest;
      const actualFolder = await realpath(folder);
      const checkpointRoot = await realpath(this.checkpointFolder(repo));
      if (!data || typeof data !== 'object' || !data.checkpoint || typeof data.checkpoint !== 'object' || !Array.isArray(data.files) || data.files.length > MAX_CHECKPOINT_FILES || !Array.isArray(data.checkpoint.excluded) || data.checkpoint.excluded.length > MAX_CHECKPOINT_FILES || !actualFolder.startsWith(`${checkpointRoot}${path.sep}`) || data.checkpoint.id !== id || data.checkpoint.projectId !== repo.projectId || data.projectRoot !== repo.projectRoot || !Number.isSafeInteger(data.checkpoint.files) || data.checkpoint.files !== data.files.length || typeof data.checkpoint.title !== 'string' || (data.checkpoint.runId !== undefined && typeof data.checkpoint.runId !== 'string') || typeof data.checkpoint.createdAt !== 'string' || (data.head !== undefined && !/^[a-f0-9]{40,64}$/i.test(data.head))) throw new Error('checkpoint does not belong to project');
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

  async checkpoints(project: ProjectRef): Promise<Checkpoint[]> {
    const repo = await this.repo(project);
    const folder = this.checkpointFolder(repo);
    const names = await readdir(folder).catch(() => [] as string[]);
    const records: Checkpoint[] = [];
    for (const name of names) {
      try { records.push((await this.readManifest(repo, name)).checkpoint); } catch { /* Ignore incomplete or foreign records. */ }
    }
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private async checkpointState(repo: Repo, manifest: CheckpointManifest, projectPath: string, folder: string): Promise<{ index: Image; worktree: Image }> {
    const saved = manifest.files.find(item => item.path === projectPath);
    if (saved) return { index: saved.index, worktree: saved.worktree };
    const gitPath = path.relative(repo.root, path.resolve(repo.projectRoot, projectPath)).split(path.sep).join('/');
    const tree = await this.treeImage(repo, manifest.head, gitPath, folder);
    return { index: tree, worktree: tree };
  }

  private async currentState(repo: Repo, projectPath: string, folder?: string): Promise<{ index: Image; worktree: Image }> {
    const absolute = await resolveScopedPath(repo.projectRoot, projectPath, true);
    const gitPath = path.relative(repo.root, absolute).split(path.sep).join('/');
    const index = await this.indexImage(repo, gitPath, folder);
    const worktree = await this.readWorktreeImage(repo, projectPath, folder);
    return { index, worktree };
  }

  private async changeList(repo: Repo, manifest: CheckpointManifest): Promise<CheckpointChange[]> {
    if (manifest.checkpoint.excluded.length) throw new AppError('CHECKPOINT_EXCLUDED_CHANGES', 'Checkpoint includes paths that cannot be safely inspected', 409, { paths: manifest.checkpoint.excluded });
    const allPaths = new Set(manifest.files.map(item => item.path));
    for (const gitPath of await this.dirtyPaths(repo)) {
      const relative = asRelativePath(repo.root, repo.projectRoot, gitPath);
      if (relative !== undefined) allPaths.add(relative);
    }
    const result: CheckpointChange[] = [];
    for (const filePath of [...allPaths].sort((a, b) => a.localeCompare(b))) {
      const before = await this.checkpointState(repo, manifest, filePath, this.checkpointPath(repo, manifest.checkpoint.id));
      const after = await this.currentState(repo, filePath);
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

  async checkpointChanges(project: ProjectRef, id: string): Promise<CheckpointChange[]> {
    const repo = await this.repo(project);
    const manifest = await this.readManifest(repo, id);
    return this.changeList(repo, manifest);
  }

  private async imageData(folder: string, image: Image): Promise<Buffer> {
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

  private async atomicWorktreeImage(repo: Repo, projectRelative: string, image: Image, folder: string): Promise<void> {
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
    const parent = path.dirname(target);
    await mkdir(parent, { recursive: true, mode: 0o755 });
    const parentRelative = toProjectRelative(repo.projectRoot, parent);
    await resolveScopedPath(repo.projectRoot, parentRelative || '.', true);
    const data = await this.imageData(folder, image);
    const temporary = `${target}.${randomUUID()}.codex-tmp`;
    try {
      if (image.kind === 'symlink') {
        const linkTarget = image.linkTarget ?? data.toString('utf8');
        assertWithin(repo.projectRoot, path.resolve(parent, linkTarget), 'CHECKPOINT_SYMLINK_OUTSIDE_PROJECT');
        await symlink(linkTarget, temporary);
      } else {
        const handle = await open(temporary, 'wx', image.mode & 0o777 || 0o600);
        try { await handle.writeFile(data); await handle.chmod(image.mode & 0o777 || 0o600); await handle.sync(); } finally { await handle.close(); }
      }
      await resolveScopedPath(repo.projectRoot, parentRelative || '.', true);
      try {
        const existing = await lstat(target);
        if (existing.isDirectory()) throw new AppError('RESTORE_TARGET_DIRECTORY', 'Refusing to replace a directory during checkpoint restore', 409, { path: projectRelative });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await rename(temporary, target);
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
  }

  private async setIndexImage(repo: Repo, projectRelative: string, image: Image, folder: string): Promise<void> {
    const absolute = await resolveScopedPath(repo.projectRoot, projectRelative, true);
    const gitPath = path.relative(repo.root, absolute).split(path.sep).join('/');
    if (!image.exists) {
      const removed = await this.git(repo, ['update-index', '--force-remove', '--', literalPath(gitPath)], { maxOutputBytes: 1024 * 1024 });
      if (removed.code !== 0) throw gitError(removed, 'update-index');
      return;
    }
    const data = await this.imageData(folder, image);
    const blob = await this.git(repo, ['hash-object', '-w', '--stdin'], { input: data, maxOutputBytes: 4096 });
    if (blob.code !== 0) throw gitError(blob, 'hash-object');
    const result = await this.git(repo, ['update-index', '--add', '--cacheinfo', image.mode.toString(8), blob.stdout.trim(), gitPath], { maxOutputBytes: 1024 * 1024 });
    if (result.code !== 0) throw gitError(result, 'update-index');
  }

  private async applyManifest(repo: Repo, manifest: CheckpointManifest, paths: string[]): Promise<void> {
    const folder = this.checkpointPath(repo, manifest.checkpoint.id);
    for (const filePath of paths) {
      const state = await this.checkpointState(repo, manifest, filePath, folder);
      await this.atomicWorktreeImage(repo, filePath, state.worktree, folder);
      await this.setIndexImage(repo, filePath, state.index, folder);
    }
  }

  async restoreCheckpoint(project: ProjectRef, id: string, expectedChanges: CheckpointChange[]): Promise<{ restored: number; backup: Checkpoint }> {
    const repo = await this.repo(project);
    return this.mutate(repo, async () => {
      const manifest = await this.readManifest(repo, id);
      if (manifest.checkpoint.excluded.length) throw new AppError('CHECKPOINT_EXCLUDED_CHANGES', 'Checkpoint contains files that cannot be safely restored', 409, { paths: manifest.checkpoint.excluded });
      if (!Array.isArray(expectedChanges) || expectedChanges.length > MAX_CHECKPOINT_FILES) throw new AppError('INVALID_EXPECTED_CHANGES', 'Expected checkpoint changes are invalid');
      const current = await this.changeList(repo, manifest);
      if (normalizeChanges(current) !== normalizeChanges(expectedChanges)) throw new AppError('CHECKPOINT_CONFLICT', 'Project files changed since the checkpoint preview; refresh the changes before restoring', 409, { changes: current });
      if (!current.length) return { restored: 0, backup: await this.createCheckpoint(project, { title: `Before restore: ${manifest.checkpoint.title}` }) };

      const backupManifest = await this.createCheckpointRecord(repo, { title: `Before restore: ${manifest.checkpoint.title}` });
      const changedPaths = current.map(change => change.path);
      const checkedAgain = await this.changeList(repo, manifest);
      if (normalizeChanges(current) !== normalizeChanges(checkedAgain)) throw new AppError('CHECKPOINT_CONFLICT', 'Project files changed while restoring; no files were restored', 409, { changes: checkedAgain, backup: backupManifest.checkpoint });
      try {
        await this.applyManifest(repo, manifest, changedPaths);
      } catch (error) {
        try { await this.applyManifest(repo, backupManifest, changedPaths); } catch { /* Keep the pre-restore checkpoint for manual recovery. */ }
        if (error instanceof AppError) throw error;
        throw new AppError('CHECKPOINT_RESTORE_FAILED', 'Could not complete checkpoint restore; a pre-restore checkpoint was saved', 500, { backupId: backupManifest.checkpoint.id });
      }
      return { restored: changedPaths.length, backup: backupManifest.checkpoint };
    });
  }

  async worktrees(project: ProjectRef): Promise<WorktreeInfo[]> {
    return this.listWorktrees(await this.repo(project));
  }

  private async listWorktrees(repo: Repo): Promise<WorktreeInfo[]> {
    const result = await this.git(repo, ['worktree', 'list', '--porcelain', '-z'], { maxOutputBytes: 4 * 1024 * 1024 });
    if (result.code !== 0) throw gitError(result, 'worktree list');
    if (result.truncated) throw new AppError('GIT_WORKTREES_TOO_LARGE', 'Git returned too many worktrees to list safely', 413);
    const records: WorktreeInfo[] = [];
    let current: Partial<WorktreeInfo> | undefined;
    for (const item of result.stdout.split('\0')) {
      if (!item) {
        if (current?.path) records.push(current as WorktreeInfo);
        current = undefined;
        continue;
      }
      const space = item.indexOf(' ');
      const key = space === -1 ? item : item.slice(0, space);
      const value = space === -1 ? '' : item.slice(space + 1);
      if (key === 'worktree') current = { path: value, head: '' };
      else if (!current) continue;
      else if (key === 'HEAD') current.head = value;
      else if (key === 'branch') current.branch = value.replace(/^refs\/heads\//, '');
      else if (key === 'bare') current.bare = true;
    }
    if (current?.path) records.push(current as WorktreeInfo);
    return Promise.all(records.map(async item => ({
      ...item,
      current: (await realpath(item.path).catch(() => path.resolve(item.path))) === repo.root,
    })));
  }

  /** [options.shadow]: an attempt, which may cut from a directory's shadow repository (see `worktreeRepo`). */
  async createWorktree(project: ProjectRef, input: { branch: string; path?: string; base?: string }, options: { shadow?: boolean } = {}): Promise<WorktreeInfo> {
    const branch = requireString(input?.branch, 'branch', 255);
    const repo = await this.worktreeRepo(project, options.shadow);
    return this.mutate(repo, async () => {
      // An unclean source is not an obstacle: git builds the new tree from a commit, so uncommitted
      // work simply stays where it is. Refusing here made the common reason to want a worktree —
      // starting something separate without disturbing what is already in progress — impossible.
      const checkBranch = await this.git(repo, ['check-ref-format', '--branch', branch], { maxOutputBytes: 4096 });
      if (checkBranch.code !== 0) throw new AppError('INVALID_BRANCH', 'Branch name is invalid');
      const base = input.base?.trim();
      let target: string;
      if (input.path) {
        target = path.resolve(repo.projectRoot, input.path);
        if (target === repo.root || target === repo.projectRoot) throw new AppError('INVALID_WORKTREE_PATH', 'Worktree path cannot be the source project');
      } else {
        // Keep Unicode names distinct while replacing characters that cannot be used on all hosts.
        target = path.join(this.stateDir, 'worktrees', hash(repo.projectId).slice(0, 24), branch.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-'));
      }
      try { await lstat(target); throw new AppError('WORKTREE_PATH_EXISTS', 'Worktree destination already exists', 409); }
      catch (error) { if (error instanceof AppError) throw error; if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const args = ['worktree', 'add', '-b', branch, target];
      if (base) {
        if (base.length > 255 || base.startsWith('-') || base.includes('\0')) throw new AppError('INVALID_BASE', 'Worktree base is invalid');
        const verified = await this.git(repo, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`], { maxOutputBytes: 4096 });
        if (verified.code !== 0) throw new AppError('INVALID_BASE', 'Worktree base does not identify a commit');
        args.push(verified.stdout.trim());
      }
      const result = await this.git(repo, args, { timeoutMs: 120_000, maxOutputBytes: 2 * 1024 * 1024 });
      if (result.code !== 0) throw gitError(result, 'worktree add');
      const canonicalTarget = await realpath(target);
      const created = (await this.listWorktrees(repo)).find(item => path.resolve(item.path) === canonicalTarget || path.resolve(item.path) === path.resolve(target));
      if (!created) throw new AppError('WORKTREE_CREATE_FAILED', 'Git created the worktree but it could not be listed', 500, { path: target });
      return created;
    });
  }

  async removeWorktree(project: ProjectRef, worktreePath: string, options: { shadow?: boolean } = {}): Promise<void> {
    const repo = await this.worktreeRepo(project, options.shadow);
    return this.mutate(repo, async () => {
      if (typeof worktreePath !== 'string' || !worktreePath.trim()) throw new AppError('INVALID_WORKTREE_PATH', 'Worktree path is required');
      const records = await this.listWorktrees(repo);
      let requestedPath: string;
      try { requestedPath = await realpath(path.resolve(worktreePath)); }
      catch { throw new AppError('WORKTREE_NOT_FOUND', 'Worktree path is unavailable', 404); }
      let target: WorktreeInfo | undefined;
      for (const record of records) {
        try { if (await realpath(record.path) === requestedPath) { target = record; break; } }
        catch { /* Prunable worktrees are not candidates for filesystem removal. */ }
      }
      if (!target) throw new AppError('WORKTREE_NOT_FOUND', 'Path is not a registered worktree', 404);
      const commonDirResult = await this.git(repo, ['rev-parse', '--git-common-dir'], { maxOutputBytes: 4096 });
      if (commonDirResult.code !== 0 || commonDirResult.truncated) throw gitError(commonDirResult, 'find common Git directory');
      const commonDir = await realpath(path.resolve(repo.root, commonDirResult.stdout.trim()));
      let mainPath: string | undefined;
      for (const record of records) {
        const gitDir = await runProcess('git', ['rev-parse', '--git-dir'], { cwd: record.path, timeoutMs: 10_000, maxOutputBytes: 4096 });
        if (gitDir.code !== 0 || !gitDir.stdout.trim()) continue;
        try {
          const resolvedGitDir = await realpath(path.resolve(record.path, gitDir.stdout.trim()));
          if (resolvedGitDir === commonDir) { mainPath = await realpath(record.path); break; }
        } catch { /* Skip worktrees which became unavailable while being inspected. */ }
      }
      if (!mainPath) throw new AppError('WORKTREE_MAIN_UNAVAILABLE', 'Could not identify the main worktree safely; nothing was removed', 409);
      if (requestedPath === mainPath) throw new AppError('WORKTREE_MAIN', 'The main working tree cannot be removed', 409, { path: target.path });
      const dirty = await runProcess('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: target.path, maxOutputBytes: 16 * 1024 * 1024, timeoutMs: 15_000 });
      if (dirty.code !== 0) throw gitError(dirty, 'worktree status');
      if (dirty.truncated) throw new AppError('GIT_STATUS_TOO_LARGE', 'Worktree status contains too many paths to verify safely', 413);
      if (dirty.stdout) throw new AppError('WORKTREE_DIRTY', 'Commit or stash worktree changes before removing it', 409, { path: target.path, entries: dirty.stdout.split('\0').filter(Boolean).length });

      const headResult = await runProcess('git', ['rev-parse', '--verify', 'HEAD'], { cwd: target.path, timeoutMs: 10_000, maxOutputBytes: 4096 });
      if (headResult.code !== 0 || !/^[a-f0-9]{40,64}$/i.test(headResult.stdout.trim())) throw gitError(headResult, 'inspect worktree HEAD');
      const head = headResult.stdout.trim();
      const branchResult = await runProcess('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: target.path, timeoutMs: 10_000, maxOutputBytes: 4096 });
      if (branchResult.code !== 0 && branchResult.code !== 1) throw gitError(branchResult, 'inspect worktree branch');
      if (branchResult.code !== 0) {
        // `rev-list --all` includes detached worktree HEADs on current Git
        // versions, which would make the target's own detached commit appear
        // referenced. Compare against actual refs while keeping HEAD positive.
        const refsResult = await runProcess('git', ['for-each-ref', '--format=%(refname)'], { cwd: target.path, timeoutMs: 10_000, maxOutputBytes: 256 * 1024 });
        if (refsResult.code !== 0) throw gitError(refsResult, 'inspect Git refs');
        if (refsResult.truncated) throw new AppError('WORKTREE_REFS_TOO_LARGE', 'Git has too many refs to verify this worktree safely; nothing was removed', 413);
        const refs = refsResult.stdout.split(/\r?\n/).filter(Boolean);
        if (refs.length > 5000 || refs.some(ref => !ref.startsWith('refs/') || ref.length>4096 || /[\0\r\n]/.test(ref))) throw new AppError('WORKTREE_REFS_UNSAFE', 'Could not verify worktree refs safely; nothing was removed', 409);
        const revisions = ['rev-list', '--count', head];
        if (refs.length) revisions.push('--not', ...refs);
        const unreferenced = await runProcess('git', revisions, { cwd: target.path, timeoutMs: 15_000, maxOutputBytes: 4096 });
        const count = Number(unreferenced.stdout.trim());
        if (unreferenced.code !== 0 || !Number.isSafeInteger(count)) throw gitError(unreferenced, 'inspect detached commits');
        if (count > 0) throw new AppError('WORKTREE_UNREFERENCED_COMMITS', 'Detached worktree contains commits that are not reachable from any Git ref; create a branch or preserve the commits before removal', 409, { path: target.path, head, commits: count });
      } else {
        const branch = branchResult.stdout.trim();
        const upstreamResult = await runProcess('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { cwd: target.path, timeoutMs: 10_000, maxOutputBytes: 4096 });
        const noUpstream = upstreamResult.code !== 0 && !upstreamResult.timedOut && /no upstream configured/i.test(upstreamResult.stderr);
        if (upstreamResult.code !== 0 && !noUpstream) throw gitError(upstreamResult, 'inspect worktree upstream');
        let comparisonBase: string;
        let baseLabel: string;
        if (!noUpstream && upstreamResult.stdout.trim()) {
          const upstreamCommit = await runProcess('git', ['rev-parse', '--verify', '--end-of-options', '@{upstream}^{commit}'], { cwd: target.path, timeoutMs: 10_000, maxOutputBytes: 4096 });
          if (upstreamCommit.code !== 0 || !/^[a-f0-9]{40,64}$/i.test(upstreamCommit.stdout.trim())) throw gitError(upstreamCommit, 'inspect worktree upstream');
          comparisonBase = upstreamCommit.stdout.trim();
          baseLabel = upstreamResult.stdout.trim();
        } else {
          const mainHead = await runProcess('git', ['rev-parse', '--verify', 'HEAD'], { cwd: mainPath, timeoutMs: 10_000, maxOutputBytes: 4096 });
          if (mainHead.code !== 0 || !/^[a-f0-9]{40,64}$/i.test(mainHead.stdout.trim())) throw new AppError('WORKTREE_MAIN_UNAVAILABLE', 'Could not read the main worktree commit safely; nothing was removed', 409);
          comparisonBase = mainHead.stdout.trim();
          baseLabel = 'main worktree';
        }
        const counts = await runProcess('git', ['rev-list', '--left-right', '--count', `${comparisonBase}...${head}`], { cwd: target.path, timeoutMs: 15_000, maxOutputBytes: 4096 });
        const [, aheadText] = counts.stdout.trim().split(/\s+/);
        const ahead = Number(aheadText);
        if (counts.code !== 0 || !Number.isSafeInteger(ahead)) throw gitError(counts, 'inspect worktree commits');
        if (ahead > 0) throw new AppError('WORKTREE_UNPUSHED_COMMITS', `Worktree branch has ${ahead} commit(s) not present in ${baseLabel}; push or preserve them before removal`, 409, { path: target.path, branch, base: baseLabel, ahead });
      }
      const result = await this.git(repo, ['worktree', 'remove', '--', target.path], { timeoutMs: 120_000, maxOutputBytes: 2 * 1024 * 1024 });
      if (result.code !== 0) throw gitError(result, 'worktree remove');
    });
  }

  private async revision(repo: Repo, spec: string): Promise<string | undefined> {
    const result = await this.git(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', spec], { timeoutMs: 10_000, maxOutputBytes: 4096 });
    return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
  }

  async branchInfo(project: ProjectRef): Promise<BranchInfo> {
    const repo = await this.repo(project);
    return this.branchOf(repo);
  }

  private async branchOf(repo: Repo): Promise<BranchInfo> {
    const symbolic = await this.git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { timeoutMs: 10_000, maxOutputBytes: 4096 });
    if (symbolic.code !== 0 || !symbolic.stdout.trim()) throw new AppError('GIT_DETACHED_HEAD', 'This checkout is not on a branch', 409);
    const branch = symbolic.stdout.trim();
    const remotes = (await this.git(repo, ['remote'], { timeoutMs: 10_000, maxOutputBytes: 64 * 1024 })).stdout.split(/\r?\n/).filter(Boolean);
    const head = await this.revision(repo, 'HEAD^{commit}');
    const upstreamName = await this.git(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { timeoutMs: 10_000, maxOutputBytes: 4096 });
    const upstream = upstreamName.code === 0 ? upstreamName.stdout.trim() || undefined : undefined;
    let ahead = 0, behind = 0;
    if (upstream && head) {
      const counts = await this.git(repo, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], { timeoutMs: 15_000, maxOutputBytes: 4096 });
      const [left, right] = counts.stdout.trim().split(/\s+/).map(Number);
      if (counts.code === 0 && Number.isSafeInteger(left) && Number.isSafeInteger(right)) { behind = left; ahead = right; }
    }
    return { branch, ...(head ? { head } : {}), ...(upstream ? { upstream } : {}), ahead, behind, remotes };
  }

  /**
   * Publishes the current branch. A first push sets the upstream, to the only remote or `origin`.
   * Never forced: rewriting a shared branch is a decision to make in a terminal, not from a button.
   */
  async push(project: ProjectRef, options: { remote?: string } = {}): Promise<PushResult> {
    const repo = await this.repo(project);
    const before = await this.branchOf(repo);
    if (!before.head) throw new AppError('GIT_NOTHING_TO_PUSH', 'This branch has no commits yet', 409);
    let remote = options.remote;
    let destination = `refs/heads/${before.branch}`;
    if (before.upstream && !remote) {
      const upstream = await this.git(repo, ['for-each-ref', '--format=%(upstream:remotename)%00%(upstream:remoteref)', `refs/heads/${before.branch}`], { maxOutputBytes: 4096 });
      if (upstream.code !== 0 || upstream.truncated) throw gitError(upstream, 'inspect push upstream');
      const [upstreamRemote, upstreamRef] = upstream.stdout.trim().split('\0');
      remote = upstreamRemote;
      if (!upstreamRef?.startsWith('refs/heads/')) throw new AppError('GIT_NO_REMOTE', 'The upstream is not a remote branch', 422);
      destination = upstreamRef;
    }
    remote ??= before.remotes.length === 1 ? before.remotes[0] : before.remotes.includes('origin') ? 'origin' : undefined;
    if (!remote) throw new AppError('GIT_NO_REMOTE', before.remotes.length ? 'Choose which remote to push to' : 'This repository has no remote to push to', 422, { remotes: before.remotes });
    if (!before.remotes.includes(remote)) throw new AppError('GIT_NO_REMOTE', 'Remote does not exist', 422, { remotes: before.remotes });
    // An explicit refspec also bypasses push.default=matching and configured forced refspecs.
    const args = ['-c', `remote.${remote}.mirror=false`, 'push', '--porcelain', '--no-force', '--no-follow-tags', '--set-upstream', '--', remote, `refs/heads/${before.branch}:${destination}`];
    const result = await runProcess('git', args, { cwd: repo.root, timeoutMs: 120_000, maxOutputBytes: 1024 * 1024, env: NON_INTERACTIVE_ENV });
    if (result.code !== 0) throw gitError(result, 'push');
    return { branch: await this.branchOf(repo), output: `${result.stdout}${result.stderr}`.trim().slice(0, 4000) };
  }

  /**
   * What a worktree changed since [base], committed and not: the view an attempt is judged by.
   * Untracked files count as added, since an agent rarely stages what it creates.
   */
  async compare(project: ProjectRef, base: string): Promise<WorktreeComparison> {
    const repo = await this.repo(project);
    const baseCommit = await this.revision(repo, `${base}^{commit}`);
    if (!baseCommit) throw new AppError('INVALID_BASE', 'Comparison base does not identify a commit', 422);
    const head = await this.headCommit(repo);
    const count = head ? await this.git(repo, ['rev-list', '--count', `${baseCommit}..${head}`], { maxOutputBytes: 4096 }) : undefined;
    const names = await this.git(repo, ['diff', '--name-status', '-z', '--no-renames', '--no-ext-diff', baseCommit, '--'], { timeoutMs: 15_000, maxOutputBytes: 8 * 1024 * 1024 });
    if (names.code !== 0) throw gitError(names, 'diff');
    const numbers = await this.git(repo, ['diff', '--numstat', '-z', '--no-renames', '--no-ext-diff', baseCommit, '--'], { timeoutMs: 15_000, maxOutputBytes: 8 * 1024 * 1024 });
    const stats = new Map<string, LineStat>();
    for (const record of numbers.code === 0 ? numbers.stdout.split('\0') : []) {
      const match = /^(\d+)\t(\d+)\t([\s\S]+)$/.exec(record);
      if (match) stats.set(match[3], { added: Number(match[1]), removed: Number(match[2]) });
    }
    const files: WorktreeComparison['files'] = [];
    const parts = names.stdout.split('\0');
    for (let index = 0; index + 1 < parts.length; index += 2) {
      const relative = asRelativePath(repo.root, repo.projectRoot, parts[index + 1]);
      if (relative !== undefined) files.push({ path: relative, status: parts[index], ...(stats.get(parts[index + 1]) ?? {}) });
    }
    let budget = MAX_COUNTED_UNTRACKED;
    for (const item of (await this.statusRaw(repo)).paths) {
      if (item.status !== '??') continue;
      const relative = asRelativePath(repo.root, repo.projectRoot, item.path);
      if (relative === undefined) continue;
      const lines = budget-- > 0 ? await countLines(path.join(repo.root, item.path)) : undefined;
      files.push({ path: relative, status: '?', ...(lines !== undefined ? { added: lines, removed: 0 } : {}) });
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    return {
      base: baseCommit, ...(head ? { head } : {}), commits: Number(count?.stdout.trim()) || 0, files,
      added: files.reduce((sum, file) => sum + (file.added ?? 0), 0), removed: files.reduce((sum, file) => sum + (file.removed ?? 0), 0),
    };
  }

  /**
   * Brings a worktree's branch into the branch its origin project has checked out.
   *
   * The origin must have no tracked changes: a squash stages into its index, and a merge that has
   * to stop half way should leave nothing of the person's own to untangle. Uncommitted work in the
   * worktree is committed first only when `commitPending` gives the message, since agents seldom
   * commit their own work. A conflict is aborted, never left in the tree, and reported with its paths.
   */
  async mergeWorktree(origin: ProjectRef, worktree: ProjectRef, options: { strategy?: 'merge' | 'squash'; message?: string; commitPending?: string; removeWorktree?: boolean; shadow?: boolean } = {}): Promise<MergeResult> {
    const strategy = options.strategy ?? 'merge';
    if (strategy !== 'merge' && strategy !== 'squash') throw new AppError('INVALID_MERGE_STRATEGY', 'Choose merge or squash');
    const target = await this.worktreeRepo(origin, options.shadow);
    const source = await this.repo(worktree);
    const [targetCommon, sourceCommon] = await Promise.all([target, source].map(async repo => {
      const found = await this.git(repo, ['rev-parse', '--git-common-dir'], { timeoutMs: 10_000, maxOutputBytes: 4096 });
      return found.code === 0 ? realpath(path.resolve(repo.root, found.stdout.trim())).catch(() => undefined) : undefined;
    }));
    if (!targetCommon || targetCommon !== sourceCommon || target.root === source.root) throw new AppError('WORKTREE_NOT_FOUND', 'These projects are not worktrees of the same repository', 422);
    if (this.repositoryMutations.has(targetCommon)) throw new AppError('MERGE_IN_PROGRESS', 'Another worktree merge is already running in this repository', 409);
    this.repositoryMutations.add(targetCommon);
    try {
      for (const repo of [target, source]) {
        const gitDir = await this.git(repo, ['rev-parse', '--absolute-git-dir'], { maxOutputBytes: 4096 });
        if (gitDir.code !== 0 || gitDir.truncated || !gitDir.stdout.trim()) throw gitError(gitDir, 'inspect worktree state');
        for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
          try {
            await lstat(path.join(gitDir.stdout.trim(), marker));
            throw new AppError('GIT_OPERATION_IN_PROGRESS', 'Finish or abort the existing Git operation before merging worktrees', 409, { path: repo.root, operation: marker });
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
      }
      const into = (await this.branchOf(target)).branch;
      const branch = (await this.branchOf(source)).branch;
      // A shadow repository's directory is edited outside Git: what is on disk now becomes the
      // target, so the merge weighs the attempt against it rather than against the starting point.
      if (target.shadow) await this.snapshot(target);
      const tracked = await this.git(target, ['status', '--porcelain=v1', '-z', '--untracked-files=no'], { maxOutputBytes: 1024 * 1024 });
      if (tracked.code !== 0) throw gitError(tracked, 'status');
      if (tracked.stdout) throw new AppError('MERGE_TARGET_DIRTY', `Commit or stash the changes on ${into} before merging into it`, 409, { into });
      const sourceStatus = await this.statusRaw(source);
      if (sourceStatus.paths.length) {
        if (!options.commitPending) throw new AppError('WORKTREE_DIRTY', 'The worktree has uncommitted changes; commit them or pass a commit message', 409, { branch });
        requireString(options.commitPending, 'commitPending', 5_000);
        if (sourceStatus.paths.some(item => asRelativePath(source.root, source.projectRoot, item.path) === undefined || (item.originalPath && asRelativePath(source.root, source.projectRoot, item.originalPath) === undefined))) {
          throw new AppError('WORKTREE_DIRTY_OUTSIDE_PROJECT', 'The worktree has changes outside this project; commit them separately before merging', 409);
        }
        const scope = path.relative(source.root, source.projectRoot).split(path.sep).join('/') || '.';
        const staged = await this.git(source, ['add', '--all', '--', literalPath(scope)], { timeoutMs: 60_000, maxOutputBytes: 1024 * 1024 });
        if (staged.code !== 0) throw gitError(staged, 'add');
        const committed = await this.git(source, ['commit', '--message', options.commitPending], { timeoutMs: 120_000, maxOutputBytes: 2 * 1024 * 1024 });
        if (committed.code !== 0) throw gitError(committed, 'commit');
      }
      const sourceHead = await this.headCommit(source);
      const targetHead = await this.headCommit(target);
      const counted = sourceHead ? await this.git(target, ['rev-list', '--count', targetHead ? `${targetHead}..${sourceHead}` : sourceHead], { maxOutputBytes: 4096 }) : undefined;
      if (counted && counted.code !== 0) throw gitError(counted, 'count worktree commits');
      const commits = Number(counted?.stdout.trim()) || 0;
      if (!sourceHead || !commits) {
        const head = await this.headCommit(target);
        return { merged: false, strategy, branch, into, ...(head ? { head } : {}), commits: 0 };
      }
      // A file the branch adds that the target already has on disk, untracked or ignored, has no copy
      // anywhere: a three-way merge writes over an ignored one regardless of --no-overwrite-ignore, and
      // `reset --merge` after a conflict would then delete it. Such a merge is refused up front.
      if (targetHead) {
        const added = await this.git(target, ['diff', '--name-only', '-z', '--no-renames', '--diff-filter=A', targetHead, sourceHead], { timeoutMs: 15_000, maxOutputBytes: 8 * 1024 * 1024 });
        if (added.code !== 0 || added.truncated) throw gitError(added, 'diff');
        const occupied: string[] = [];
        for (const file of added.stdout.split('\0').filter(Boolean)) {
          if (await lstat(path.join(target.root, file)).then(() => true, () => false)) occupied.push(file);
        }
        if (occupied.length) throw new AppError('MERGE_CONFLICT', `${branch} would overwrite files in ${into} that Git does not track; nothing was merged`, 409, { branch, into, paths: occupied });
      }
      const message = options.message?.trim().slice(0, 5_000) || `Merge ${branch} into ${into}`;
      const merge = strategy === 'squash'
        ? await this.git(target, ['merge', '--squash', '--no-overwrite-ignore', sourceHead], { timeoutMs: 120_000, maxOutputBytes: 2 * 1024 * 1024 })
        : await this.git(target, ['merge', '--no-edit', '--no-overwrite-ignore', '--message', message, sourceHead], { timeoutMs: 120_000, maxOutputBytes: 2 * 1024 * 1024 });
      if (merge.code !== 0) {
        const conflicts = await this.git(target, ['diff', '--name-only', '--diff-filter=U', '-z'], { maxOutputBytes: 1024 * 1024 });
        const paths = conflicts.stdout.split('\0').filter(Boolean);
        const recovery = await this.git(target, ['reset', '--merge', ...(targetHead ? [targetHead] : [])], { timeoutMs: 60_000, maxOutputBytes: 1024 * 1024 });
        if (recovery.code !== 0) throw new AppError('MERGE_RECOVERY_FAILED', 'The merge failed and Git could not restore the target; resolve the worktree before retrying', 409, { branch, into, paths, output: recovery.stderr.slice(0, 2000) });
        if (paths.length) throw new AppError('MERGE_CONFLICT', `${branch} conflicts with ${into}; nothing was merged`, 409, { branch, into, paths });
        throw gitError(merge, 'merge');
      }
      if (strategy === 'squash') {
        const committed = await this.git(target, ['commit', '--message', message], { timeoutMs: 120_000, maxOutputBytes: 2 * 1024 * 1024 });
        if (committed.code !== 0) {
          const recovery = await this.git(target, ['reset', '--merge', ...(targetHead ? [targetHead] : [])], { timeoutMs: 60_000, maxOutputBytes: 1024 * 1024 });
          if (recovery.code !== 0) throw new AppError('MERGE_RECOVERY_FAILED', 'The squash commit failed and Git could not restore the target; resolve the worktree before retrying', 409, { branch, into, output: recovery.stderr.slice(0, 2000) });
          throw gitError(committed, 'commit');
        }
      }
      let removedWorktree = false;
      // The branch itself is kept: after a squash it is the only record of the individual commits.
      if (options.removeWorktree) removedWorktree = (await this.git(target, ['worktree', 'remove', '--', source.root], { timeoutMs: 120_000, maxOutputBytes: 1024 * 1024 })).code === 0;
      const head = await this.headCommit(target);
      return { merged: true, strategy, branch, into, ...(head ? { head } : {}), commits, ...(options.removeWorktree ? { removedWorktree } : {}) };
    } finally { this.repositoryMutations.delete(targetCommon); }
  }

  private async gh(repo: Repo, args: string[], timeoutMs = 60_000): Promise<ProcessResult> {
    return runProcess('gh', args, { cwd: repo.root, timeoutMs, maxOutputBytes: 4 * 1024 * 1024, env: NON_INTERACTIVE_ENV });
  }

  /** The branch's pull request and its checks, through the GitHub CLI and whatever account it is signed in to. */
  async pullRequest(project: ProjectRef): Promise<PullRequestStatus> {
    const repo = await this.repo(project);
    const branch = await this.branchOf(repo);
    const result = await this.gh(repo, ['pr', 'view', branch.branch, '--json', PR_FIELDS]);
    if (result.code !== 0) {
      if (/no (open )?pull requests? found/i.test(result.stderr)) return { branch, pullRequest: null };
      throw ghError(result, 'pr view');
    }
    try { return { branch, pullRequest: pullRequestInfo(JSON.parse(result.stdout) as Record<string, unknown>) }; }
    catch { throw new AppError('GH_OPERATION_FAILED', 'GitHub CLI returned an unreadable pull request', 502); }
  }

  /** Pushes first when the remote is behind, since a pull request can only show what was pushed. */
  async createPullRequest(project: ProjectRef, options: { title?: string; body?: string; base?: string; draft?: boolean; remote?: string } = {}): Promise<PullRequestStatus> {
    if (options.base && (options.base.length > 255 || options.base.startsWith('-') || /[\0\s]/.test(options.base))) throw new AppError('INVALID_BASE', 'Pull request base is invalid');
    const repo = await this.repo(project);
    const branch = await this.branchOf(repo);
    if (options.remote || !branch.upstream || branch.ahead > 0) await this.push(project, options.remote ? { remote: options.remote } : {});
    const args = ['pr', 'create', '--head', branch.branch];
    if (options.base) {
      args.push('--base', options.base);
    }
    const title = options.title?.trim();
    if (title) args.push('--title', title.slice(0, 300), '--body', options.body?.slice(0, 60_000) ?? '');
    else {
      args.push('--fill');
      if (options.body !== undefined) args.push('--body', options.body.slice(0, 60_000));
    }
    if (options.draft) args.push('--draft');
    const created = await this.gh(repo, args, 120_000);
    if (created.code !== 0) throw ghError(created, 'pr create');
    return this.pullRequest(project);
  }
}

export type { CheckpointChange, GitDiff, GitEntry, GitStatus, WorktreeInfo } from '../../../../packages/contracts/src/index.js';
