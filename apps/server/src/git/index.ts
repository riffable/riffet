import { watch as watchFiles, type FSWatcher } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { BranchInfo, Checkpoint, CheckpointChange, GitBlame, GitCommitDetail, GitDiff, GitEntry, GitFileAtRev, GitHead, GitLineChange, GitLog, GitRefs, GitStatus, MergeResult, PullRequestStatus, PushResult, WorktreeComparison, WorktreeInfo } from '../../../../packages/contracts/src/index.js';
import { FILE_BUDGET, GIT_READ_BUDGET } from '../../../../packages/contracts/src/budgets.js';
import { AppError, requireString } from '../errors.js';
import { projectRoot, type ProjectRef } from '../workspace/scope.js';
import * as branches from './branches.js';
import * as checkpointsApi from './checkpoints.js';
import * as diffApi from './diff.js';
import { runProcess, type ProcessResult } from './exec.js';
import { BlameCache, parseBlame, READ_ENV, readFailure, SerialQueue, ZERO_HASH } from './read.js';
import {
  asRelativePath, countLines, emptyTree, gitError, headCommit, literalPath,
  MAX_COUNTED_UNTRACKED, MAX_LISTED_UNTRACKED, MB, parseStatus, resolveGitPath, resolveRepo,
  runRepoGit, type GitHost, type LineStat, type ParsedStatus, type Repo,
} from './shared.js';
import * as worktreesApi from './worktrees.js';

export { generatedBranch } from './branches.js';

/**
 * A project whose status someone is following. Its files are watched, so the last status read stays
 * good until something changes; then it is read again, no more often than the read itself allows.
 */
interface StatusWatch {
  project: ProjectRef; listeners: Set<(status: GitStatus) => void>; watchers: FSWatcher[];
  value?: GitStatus; json?: string; stale: boolean; running?: Promise<GitStatus>;
  timer?: NodeJS.Timeout; poll?: NodeJS.Timeout; lastRun: number; lastDuration: number;
}
/** Quiet time after a change before status is read again, so a burst of writes costs one read. */
const STATUS_SETTLE_MS = 400;
/** A status read takes seconds in a very large repository; reads are spaced by this many times what the last one took. */
const STATUS_SPACING = 4;
const STATUS_SPACING_MAX_MS = 20_000;

export class GitService implements GitHost {
  readonly stateDir: string;
  readonly repositoryMutations = new Set<string>();
  readonly turnCheckpoints = new Map<string, Promise<Checkpoint | undefined>>();
  private readonly statusWatches = new Map<string, StatusWatch>();
  private closed = false;
  private readonly blameQueue = new SerialQueue();
  private readonly blameCache = new BlameCache();

  constructor(options: { stateDir: string }) {
    if (!options?.stateDir || !path.isAbsolute(options.stateDir)) throw new AppError('INVALID_STATE_DIR', 'stateDir must be an absolute path');
    this.stateDir = path.resolve(options.stateDir);
  }

  repo(project: ProjectRef): Promise<Repo> {
    return resolveRepo(project);
  }

  git(repo: Repo, args: string[], options: { timeoutMs?: number; maxOutputBytes?: number; input?: Buffer } = {}): Promise<ProcessResult> {
    return runRepoGit(repo, args, options);
  }

  async mutate<T>(repo: Repo, operation: () => Promise<T>): Promise<T> {
    const common = await this.git(repo, ['rev-parse', '--git-common-dir'], { maxOutputBytes: 4096 });
    if (common.code !== 0 || common.truncated || !common.stdout.trim()) throw gitError(common, 'inspect repository');
    const directory = await realpath(path.resolve(repo.root, common.stdout.trim()));
    if (this.repositoryMutations.has(directory)) throw new AppError('GIT_OPERATION_IN_PROGRESS', 'Another Git operation is already changing this repository', 409);
    this.repositoryMutations.add(directory);
    try { return await operation(); }
    finally { this.repositoryMutations.delete(directory); }
  }

  /**
   * `git status`, asked for untracked directories as one entry each: listing every file under them
   * is what makes status slow in a large repository (several times the rest of the work together).
   * `untracked` then names the files of those directories where a caller needs them: `listed` while
   * there are few enough to show, `all` for a checkpoint, which has to copy each one. The distance
   * from the upstream is not asked for either: it is a walk through history, and `branchOf` reports it.
   */
  async statusRaw(repo: Repo, untracked: 'collapsed' | 'listed' | 'all' = 'collapsed'): Promise<ParsedStatus> {
    const result = await this.git(repo, ['status', '--porcelain=v1', '-z', '--branch', '--no-ahead-behind', '--untracked-files=normal'], { timeoutMs: 60_000, maxOutputBytes: 32 * MB });
    if (result.code !== 0) throw gitError(result, 'status');
    if (result.truncated) throw new AppError('GIT_STATUS_TOO_LARGE', 'Git status contains too many changed paths to return safely', 413);
    const parsed = parseStatus(result.stdout);
    const folders = parsed.paths.filter(item => item.status === '??' && item.path.endsWith('/'));
    if (untracked === 'collapsed' || !folders.length) return parsed;
    const listed = await this.git(repo, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...folders.map(item => literalPath(item.path))], { timeoutMs: 60_000, maxOutputBytes: 32 * MB });
    if (listed.code !== 0) throw gitError(listed, 'ls-files');
    if (listed.truncated) throw new AppError('GIT_STATUS_TOO_LARGE', 'Git status contains too many changed paths to return safely', 413);
    const files = listed.stdout.split('\0').filter(Boolean);
    if (untracked === 'listed' && files.length > MAX_LISTED_UNTRACKED) return parsed;
    return { branch: parsed.branch, paths: [...parsed.paths.filter(item => !folders.includes(item)), ...files.map(file => ({ status: '??', path: file }))].sort((a, b) => a.path.localeCompare(b.path)) };
  }

  /**
   * The project's status. While it is being followed (`followStatus`) the last read is returned as
   * long as nothing has changed since; `fresh` reads again regardless, as after a write of our own,
   * whose file events may not have arrived yet.
   */
  async status(project: ProjectRef, fresh = false): Promise<GitStatus> {
    const watch = this.statusWatches.get(await projectRoot(project));
    if (!watch) return this.readStatus(project);
    if (fresh) {
      await watch.running?.catch(() => undefined);
      watch.stale = true;
    }
    return !watch.stale && watch.value ? watch.value : this.refreshStatus(watch);
  }

  private refreshStatus(watch: StatusWatch): Promise<GitStatus> {
    if (watch.running) return watch.running;
    if (watch.timer) { clearTimeout(watch.timer); watch.timer = undefined; }
    watch.stale = false;
    const started = Date.now();
    const run = this.readStatus(watch.project).then(value => {
      watch.lastDuration = Date.now() - started;
      const json = JSON.stringify(value);
      const changed = json !== watch.json;
      watch.value = value; watch.json = json;
      if (changed) for (const listener of watch.listeners) listener(value);
      return value;
    }, (error: unknown) => {
      // A failed read is retried, and nothing answers from the value before it meanwhile.
      watch.stale = true;
      throw error;
    }).finally(() => {
      watch.lastRun = Date.now();
      watch.running = undefined;
      if (watch.stale) this.scheduleStatus(watch);
    });
    watch.running = run;
    return run;
  }

  private scheduleStatus(watch: StatusWatch): void {
    if (watch.timer || watch.running || !watch.listeners.size) return;
    const spacing = Math.min(watch.lastDuration * STATUS_SPACING, STATUS_SPACING_MAX_MS);
    watch.timer = setTimeout(() => {
      watch.timer = undefined;
      if (watch.listeners.size) void this.refreshStatus(watch).catch(() => undefined);
    }, Math.max(STATUS_SETTLE_MS, watch.lastRun + spacing - Date.now()));
    watch.timer.unref();
  }

  /**
   * Follows a project's status: [listener] gets it now and each time it changes, until the returned
   * function is called. The working tree is watched where the platform can watch a whole tree with
   * one handle (macOS, Windows); elsewhere a watch per directory would not scale to a large
   * repository, so only Git's own files are watched (a stage, commit or checkout) and edits to
   * files are found by reading status again at an interval.
   */
  async followStatus(project: ProjectRef, listener: (status: GitStatus) => void): Promise<() => void> {
    const repo = await this.repo(project);
    if (this.closed) return () => undefined;
    let watch = this.statusWatches.get(repo.projectRoot);
    if (!watch) {
      const created: StatusWatch = { project, listeners: new Set(), watchers: [], stale: true, lastRun: 0, lastDuration: 0 };
      watch = created;
      const changed = () => { created.stale = true; this.scheduleStatus(created); };
      const dirs = (await this.git(repo, ['rev-parse', '--absolute-git-dir', '--git-common-dir'], { maxOutputBytes: 8192 })).stdout.split('\n').map(line => line.trim());
      const gitDir = dirs[0], commonDir = dirs[1] ? path.resolve(repo.root, dirs[1]) : undefined;
      const follow = (target: string, recursive: boolean, relevant: (file: string) => boolean) => {
        try {
          const watcher = watchFiles(target, { recursive, persistent: false }, (_event, file) => { if (file === null || relevant(String(file))) changed(); });
          watcher.on('error', () => undefined);
          created.watchers.push(watcher);
          return true;
        } catch { return false; }
      };
      // Git's files: the index (a stage), HEAD (a checkout or commit) and the branch refs, which a
      // `reset --soft` or a commit in another worktree moves alone. Lock files and objects come and go
      // without changing what status says.
      const recursive = process.platform === 'darwin' || process.platform === 'win32';
      if (gitDir) follow(gitDir, false, file => file === 'index' || file === 'HEAD' || file === 'packed-refs');
      if (commonDir && commonDir !== gitDir) follow(commonDir, false, file => file === 'packed-refs');
      if (commonDir && recursive) follow(path.join(commonDir, 'refs'), true, file => !file.endsWith('.lock'));
      const wholeTree = recursive
        && follow(repo.projectRoot, true, file => { const parts = file.split(path.sep); return !parts.includes('.git') && !parts.includes('node_modules'); });
      if (!wholeTree) {
        const again = () => {
          created.poll = setTimeout(() => { changed(); again(); }, Math.max(5_000, created.lastDuration * 10));
          created.poll.unref();
        };
        again();
      }
      // Set after the awaits above: a second follower arriving meanwhile would otherwise find a watch with nothing watching yet.
      const existing = this.statusWatches.get(repo.projectRoot);
      if (this.closed) { this.closeStatusWatch(created); return () => undefined; }
      if (existing) { this.closeStatusWatch(created); watch = existing; } else this.statusWatches.set(repo.projectRoot, created);
    }
    const followed = watch;
    // The first status goes to this follower even when it is no news to the others.
    let told = false;
    const tell = (status: GitStatus) => { told = true; listener(status); };
    followed.listeners.add(tell);
    if (followed.value && !followed.stale) tell(followed.value);
    else void this.refreshStatus(followed).then(value => { if (!told && followed.listeners.has(tell)) tell(value); }, () => undefined);
    return () => {
      followed.listeners.delete(tell);
      if (followed.listeners.size || this.statusWatches.get(repo.projectRoot) !== followed) return;
      this.statusWatches.delete(repo.projectRoot);
      this.closeStatusWatch(followed);
    };
  }

  private closeStatusWatch(watch: StatusWatch): void {
    if (watch.timer) clearTimeout(watch.timer);
    if (watch.poll) clearTimeout(watch.poll);
    for (const watcher of watch.watchers.splice(0)) watcher.close();
  }

  /** A read for the code viewer: no optional locks, and no fetch from a promisor remote. */
  private readGit(repo: Repo, args: string[], options: { timeoutMs: number; maxOutputBytes?: number; input?: Buffer; signal?: AbortSignal }): Promise<ProcessResult> {
    return runProcess('git', ['--no-optional-locks', ...args], { cwd: repo.root, env: READ_ENV, ...options });
  }

  /** The checkout's HEAD commit and branch; two reads that only look at refs, so they stay quick in a huge repository. */
  async head(project: ProjectRef): Promise<GitHead> {
    const repo = await this.repo(project);
    const [commit, branch] = await Promise.all([
      this.readGit(repo, ['rev-parse', '--verify', 'HEAD'], { timeoutMs: GIT_READ_BUDGET.headMs, maxOutputBytes: 4096 }),
      this.readGit(repo, ['symbolic-ref', '-q', '--short', 'HEAD'], { timeoutMs: GIT_READ_BUDGET.headMs, maxOutputBytes: 4096 }),
    ]);
    const head = commit.stdout.trim();
    if (commit.timedOut) throw new AppError('GIT_TIMEOUT', 'Git took too long to read HEAD', 504);
    if (commit.code !== 0 || !head) throw new AppError('GIT_NO_COMMITS', 'This repository has no commits yet', 409);
    const name = branch.code === 0 ? branch.stdout.trim() : '';
    return { ...(name ? { branch: name } : {}), head, short: head.slice(0, 9) };
  }

  /** A file as a commit has it (`rev` is `HEAD` or a hash). One `cat-file`, so the cost is a single git call. */
  async fileAtRev(project: ProjectRef, filePath: string, rev = 'HEAD', signal?: AbortSignal): Promise<GitFileAtRev> {
    if (typeof rev !== 'string' || !(rev === 'HEAD' || /^[0-9a-f]{7,64}$/i.test(rev))) throw new AppError('INVALID_REV', 'rev must be HEAD or a commit hash');
    const repo = await this.repo(project);
    const file = await resolveGitPath(repo, filePath);
    if (file.gitRelative.includes('\n')) throw new AppError('INVALID_PATH', 'Git path is invalid');
    const cap = FILE_BUDGET.previewTextBytes;
    const result = await this.readGit(repo, ['cat-file', '--batch'], { timeoutMs: GIT_READ_BUDGET.fileMs, maxOutputBytes: cap + 1024, input: Buffer.from(`${rev}:${file.gitRelative}\n`), ...(signal ? { signal } : {}) });
    if (result.timedOut) throw new AppError('GIT_TIMEOUT', 'Git took too long to read the file', 504);
    const data = result.stdoutData, lineEnd = data.indexOf(10);
    if (lineEnd < 0) throw readFailure('cat-file', result.stderr);
    const header = data.subarray(0, lineEnd).toString('utf8');
    const answer = { path: file.projectRelative, rev };
    if (header.endsWith(' missing') || header.endsWith(' ambiguous')) {
      // `missing` is a path the commit lacks, or an object this clone does not hold; the tree listing tells which.
      const listing = await this.readGit(repo, ['ls-tree', '-z', rev, '--', literalPath(file.gitRelative)], { timeoutMs: GIT_READ_BUDGET.fileMs, maxOutputBytes: 64 * 1024, ...(signal ? { signal } : {}) });
      if (listing.timedOut) throw new AppError('GIT_TIMEOUT', 'Git took too long to read the file', 504);
      if (listing.code !== 0) {
        if (/not a valid object name|unknown revision/i.test(listing.stderr)) throw new AppError('GIT_REV_NOT_FOUND', `Commit ${rev} was not found`, 404);
        throw readFailure('ls-tree', listing.stderr);
      }
      if (listing.stdout.trim()) throw readFailure('cat-file', 'missing blob: not available without fetching');
      return { ...answer, missing: true };
    }
    const [, type, size] = /^\S+ (\w+) (\d+)$/.exec(header) ?? [];
    if (type !== 'blob' || size === undefined) throw new AppError('INVALID_PATH', 'Path is not a file in that commit', 422);
    const content = data.subarray(lineEnd + 1, lineEnd + 1 + Math.min(Number(size), cap));
    if (content.subarray(0, 8000).includes(0)) return { ...answer, binary: true };
    return { ...answer, text: content.toString('utf8'), ...(Number(size) > cap ? { truncated: true } : {}) };
  }

  /**
   * Who last changed each line of a window of the working-tree file. One blame runs per repository at
   * a time (a window takes seconds on a monorepo); answers are kept so scrolling back costs nothing.
   */
  async blame(project: ProjectRef, filePath: string, start: number, end: number, signal?: AbortSignal): Promise<GitBlame> {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) throw new AppError('INVALID_RANGE', 'start and end must be line numbers with start <= end');
    end = Math.min(end, start + GIT_READ_BUDGET.blameMaxLines - 1);
    const repo = await this.repo(project);
    const file = await resolveGitPath(repo, filePath);
    const info = await stat(file.absolute).catch(() => undefined);
    if (!info?.isFile()) throw new AppError('FILE_NOT_FOUND', 'File not found', 404);
    if (info.size > FILE_BUDGET.previewReadBytes) throw new AppError('FILE_TOO_LARGE', 'The file is too large to blame here', 413);
    const commit = await this.readGit(repo, ['rev-parse', '--verify', 'HEAD'], { timeoutMs: GIT_READ_BUDGET.headMs, maxOutputBytes: 4096, ...(signal ? { signal } : {}) });
    const head = commit.stdout.trim() || 'unborn';
    const key = JSON.stringify([repo.root, head, file.gitRelative, info.mtimeMs, info.size, start, end]);
    const cached = this.blameCache.get(key);
    if (cached) return cached;
    // The window is cut to the file's length here, because git refuses a range past the end.
    const data = await readFile(file.absolute);
    let lines = 0;
    for (let at = data.indexOf(10); at >= 0; at = data.indexOf(10, at + 1)) lines += 1;
    if (data.length && data[data.length - 1] !== 10) lines += 1;
    const last = Math.min(end, lines);
    if (start > lines) return { path: file.projectRelative, start, end: start - 1, ranges: [], commits: {} };
    return this.blameQueue.run(repo.root, signal, async () => {
      const again = this.blameCache.get(key);
      if (again) return again;
      const result = await this.readGit(repo, ['blame', '--porcelain', '-L', `${start},${last}`, '--', file.gitRelative], { timeoutMs: GIT_READ_BUDGET.blameMs, maxOutputBytes: GIT_READ_BUDGET.blameOutputBytes, ...(signal ? { signal } : {}) });
      if (result.aborted) throw new AppError('REQUEST_ABORTED', 'Request was cancelled', 499);
      if (result.timedOut) throw new AppError('GIT_TIMEOUT', `Blame took longer than ${GIT_READ_BUDGET.blameMs / 1000} s on this repository and was stopped`, 504);
      if (result.truncated) throw new AppError('GIT_OUTPUT_TOO_LARGE', 'Blame output is too large for this range', 413);
      let answer: GitBlame;
      if (result.code !== 0) {
        // A file git does not track yet has no history: every line is the working tree's own.
        if (!/no such path|not under version control/i.test(result.stderr)) throw readFailure('blame', result.stderr);
        answer = { path: file.projectRelative, start, end: last, ranges: [{ start, count: last - start + 1, hash: ZERO_HASH }], commits: {} };
      } else answer = parseBlame(result.stdout, file.projectRelative, start, last);
      this.blameCache.set(key, answer);
      return answer;
    });
  }

  /** Stops watching every followed project. */
  close(): void {
    this.closed = true;
    for (const watch of this.statusWatches.values()) { watch.listeners.clear(); this.closeStatusWatch(watch); }
    this.statusWatches.clear();
    this.blameCache.clear();
  }

  private async readStatus(project: ProjectRef): Promise<GitStatus> {
    const repo = await this.repo(project);
    // Both read the whole index, which is most of their cost in a large repository, so they run side by side.
    const [raw, tracked, base] = await Promise.all([this.statusRaw(repo, 'listed'), this.trackedStats(repo).catch(() => new Map<string, LineStat>()), branches.baseRef(this, repo).catch(() => undefined)]);
    const stats = await this.lineStats(repo, raw, tracked).catch(() => new Map<string, LineStat>());
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
    return { root: repo.root, branch: raw.branch, entries, added, removed, ...(base && base !== raw.branch ? { base } : {}) };
  }

  /** Lines added/removed per git-relative path of tracked files, against HEAD (or the empty tree before the first commit). */
  private async trackedStats(repo: Repo): Promise<Map<string, LineStat>> {
    const stats = new Map<string, LineStat>();
    const base = await headCommit(this, repo) ?? await emptyTree(this, repo);
    const diff = await this.git(repo, ['diff', '--numstat', '-z', '--no-renames', '--no-ext-diff', base, '--'], { timeoutMs: 60_000, maxOutputBytes: 8 * MB });
    if (diff.code === 0 && !diff.truncated) {
      for (const record of diff.stdout.split('\0')) {
        const match = /^(\d+)\t(\d+)\t([\s\S]+)$/.exec(record);
        if (match) stats.set(match[3], { added: Number(match[1]), removed: Number(match[2]) });
      }
    }
    return stats;
  }

  /** [tracked] with the line counts of untracked files added, as far as a fixed budget of them goes. */
  private async lineStats(repo: Repo, raw: ParsedStatus, tracked: Map<string, LineStat>): Promise<Map<string, LineStat>> {
    let budget = MAX_COUNTED_UNTRACKED;
    for (const item of raw.paths) {
      if (item.status !== '??' || item.path.endsWith('/') || budget-- <= 0) continue;
      const lines = await countLines(path.join(repo.root, item.path));
      if (lines !== undefined) tracked.set(item.path, { added: lines, removed: 0 });
    }
    return tracked;
  }

  async commit(project: ProjectRef, message: string): Promise<{ hash: string; message: string; status: GitStatus }> {
    requireString(message, 'message', 5_000);
    const repo = await this.repo(project);
    return this.mutate(repo, async () => {
      const result = await this.git(repo, ['commit', '--message', message], { timeoutMs: 120_000, maxOutputBytes: 2 * MB });
      if (result.code !== 0) throw gitError(result, 'commit');
      const head = await this.git(repo, ['rev-parse', 'HEAD'], { maxOutputBytes: 4096 });
      if (head.code !== 0) throw gitError(head, 'rev-parse');
      return { hash: head.stdout.trim(), message, status: await this.status(project, true) };
    });
  }

  worktreeBase(project: ProjectRef, spec = 'HEAD'): Promise<{ commit?: string; uncommitted: boolean }> {
    return worktreesApi.worktreeBase(this, project, spec);
  }
  diff(project: ProjectRef, filePath: string, options: { staged?: boolean; base?: string; commit?: string; from?: string } = {}): Promise<GitDiff> {
    return diffApi.diff(this, project, filePath, options);
  }
  stage(project: ProjectRef, paths: string[]): Promise<GitStatus> {
    return diffApi.stage(this, project, paths);
  }
  unstage(project: ProjectRef, paths: string[]): Promise<GitStatus> {
    return diffApi.unstage(this, project, paths);
  }
  discard(project: ProjectRef, paths: string[], options: { permanent?: boolean } = {}): Promise<{ status: GitStatus; backup?: Checkpoint }> {
    return diffApi.discard(this, project, paths, options);
  }
  applyLines(project: ProjectRef, input: { path: string; action: 'stage' | 'unstage' | 'discard'; changes: GitLineChange[]; version: string; base?: string }): Promise<{ status: GitStatus; backup?: Checkpoint }> {
    return diffApi.applyLines(this, project, input);
  }
  createCheckpoint(project: ProjectRef, options: { sessionId?: string; runId?: string; title?: string } = {}): Promise<Checkpoint> {
    return checkpointsApi.createCheckpoint(this, project, options);
  }
  createTurnCheckpoint(project: ProjectRef, options: { sessionId: string; runId: string; title: string; since: number }): Promise<Checkpoint | undefined> {
    return checkpointsApi.createTurnCheckpoint(this, project, options);
  }
  async checkpoints(project: ProjectRef): Promise<Checkpoint[]> {
    return checkpointsApi.listCheckpoints(this, await this.repo(project));
  }
  checkpointChanges(project: ProjectRef, id: string): Promise<CheckpointChange[]> {
    return checkpointsApi.checkpointChanges(this, project, id);
  }
  restoreCheckpoint(project: ProjectRef, id: string, expectedChanges: CheckpointChange[]): Promise<{ restored: number; backup: Checkpoint }> {
    return checkpointsApi.restoreCheckpoint(this, project, id, expectedChanges);
  }
  worktrees(project: ProjectRef): Promise<WorktreeInfo[]> {
    return worktreesApi.worktrees(this, project);
  }
  createWorktree(project: ProjectRef, input: { branch: string; path?: string; base?: string }, options: { shadow?: boolean } = {}): Promise<WorktreeInfo> {
    return worktreesApi.createWorktree(this, project, input, options);
  }
  createWorktreeFromCheckpoint(project: ProjectRef, input: { branch: string; checkpointId: string }): Promise<WorktreeInfo | undefined> {
    return worktreesApi.createWorktreeFromCheckpoint(this, project, input);
  }
  discardWorktree(project: ProjectRef, worktreePath: string, branch?: string): Promise<void> {
    return worktreesApi.discardWorktree(this, project, worktreePath, branch);
  }
  removeWorktree(project: ProjectRef, worktreePath: string, options: { shadow?: boolean } = {}): Promise<void> {
    return worktreesApi.removeWorktree(this, project, worktreePath, options);
  }
  branchInfo(project: ProjectRef): Promise<BranchInfo> {
    return branches.branchInfo(this, project);
  }
  log(project: ProjectRef, options: { all?: boolean; skip?: number; limit?: number } = {}): Promise<GitLog> {
    return branches.log(this, project, options);
  }
  commitDetail(project: ProjectRef, spec: string): Promise<GitCommitDetail> {
    return branches.commitDetail(this, project, spec);
  }
  refs(project: ProjectRef, options: { query?: string } = {}): Promise<GitRefs> {
    return branches.refs(this, project, options);
  }
  switchBranch(project: ProjectRef, input: { branch?: string; create?: boolean; base?: string; remote?: string }): Promise<GitRefs> {
    return branches.switchBranch(this, project, input);
  }
  fetch(project: ProjectRef): Promise<GitRefs> {
    return branches.fetch(this, project);
  }
  pull(project: ProjectRef): Promise<{ branch: BranchInfo; status: GitStatus }> {
    return branches.pull(this, project);
  }
  push(project: ProjectRef, options: { remote?: string } = {}): Promise<PushResult> {
    return branches.push(this, project, options);
  }
  compare(project: ProjectRef, base?: string): Promise<WorktreeComparison> {
    return worktreesApi.compare(this, project, base);
  }
  mergeWorktree(origin: ProjectRef, worktree: ProjectRef, options: { strategy?: 'merge' | 'squash'; message?: string; commitPending?: string; removeWorktree?: boolean; shadow?: boolean } = {}): Promise<MergeResult> {
    return worktreesApi.mergeWorktree(this, origin, worktree, options);
  }
  pullRequest(project: ProjectRef): Promise<PullRequestStatus> {
    return branches.pullRequest(this, project);
  }
  createPullRequest(project: ProjectRef, options: { title?: string; body?: string; base?: string; draft?: boolean; remote?: string } = {}): Promise<PullRequestStatus> {
    return branches.createPullRequest(this, project, options);
  }
}

export type { CheckpointChange, GitDiff, GitEntry, GitStatus, WorktreeInfo } from '../../../../packages/contracts/src/index.js';
