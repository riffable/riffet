import { createHash, randomUUID } from 'node:crypto';
import { watch as watchFiles, type FSWatcher } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rename, rm, rmdir, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BranchInfo, Checkpoint, CheckpointChange, CheckState, GitBranchRef, GitCommit, GitCommitDetail, GitDiff, GitEntry, GitLineChange, GitLog, GitRefLabel, GitRefs, GitStatus, MergeResult, PullRequestCheck, PullRequestInfo, PullRequestStatus, PushResult, WorktreeComparison, WorktreeInfo } from '../../../../packages/contracts/src/index.js';
import { AppError, requireString } from '../errors.js';
import { assertWithin, isWithin, projectRoot, resolveScopedPath, toProjectRelative, type ProjectRef } from '../workspace/scope.js';
import { runProcess, type ProcessResult } from './exec.js';

const MAX_CHECKPOINT_FILE_BYTES = 32 * 1024 * 1024;
const MAX_CHECKPOINT_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_CHECKPOINT_FILES = 5_000;
/** Paths one `ls-files` reads for a checkpoint; keeps the argument list far below the system's limit. */
const INDEX_BATCH_PATHS = 500;
const MAX_DIFF_BYTES = 1024 * 1024;
const MAX_COUNTED_UNTRACKED = 200;
const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
/** Turn checkpoints kept per project; manual ones are never pruned. Each copies the dirty files of its moment. */
const TURN_CHECKPOINTS_KEPT = 50;
/** How old a checkpoint folder without a manifest is before it counts as one a stopped capture left. */
const UNFINISHED_CHECKPOINT_MS = 60 * 60_000;
/** Partial checkpoints kept per project: the copies taken before a discard, which is what undoes it. */
const PARTIAL_CHECKPOINTS_KEPT = 20;
const MAX_LINE_CHANGES = 2_000;
/** Past this many files, untracked directories are shown as themselves rather than file by file. */
const MAX_LISTED_UNTRACKED = 2_000;
/**
 * A read must not take the index lock: `git status` refreshes the index when it can, and an agent's
 * own `git add` or `git commit` running at that moment would fail on `index.lock`.
 */
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
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
/** One side of a file comparison. `mode` is Git's; `id` names the content; `oid` is set when it is a Git blob. */
interface Side { exists: boolean; mode: number; data: Buffer; id: string; oid?: string; truncated?: boolean; }
type DiffScope = { kind: 'worktree' | 'staged' } | { kind: 'commit'; commit: string } | { kind: 'checkpoint'; manifest: CheckpointManifest }
  /** What one commit changed: `parent` is its first parent, absent for a root commit; `from` is the path a renamed file had there. */
  | { kind: 'revision'; commit: string; parent?: string; from?: string };
const LOG_PAGE = 150;
const REMOTE_BRANCHES_LISTED = 50;
/** Line counts are read per file; a change wider than this is listed without them. */
const MAX_STAT_FILES = 300;
/** Files of one commit or comparison sent to a client. */
const MAX_CHANGED_FILES = 2_000;
/** Porcelain codes of a path in the middle of a merge: its contents are both sides, not something to discard. */
const UNMERGED = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
const LOG_FORMAT = ['%H', '%P', '%an', '%ae', '%aI', '%s'].join('%x1f');

interface GitFile { absolute: string; projectRelative: string; gitRelative: string; }
const MISSING_SIDE: Side = { exists: false, mode: 0, data: Buffer.alloc(0), id: '' };
interface ParsedStatus { branch: string; paths: Array<{ status: string; path: string; originalPath?: string }>; }

function logCommit(record: string, labels?: Map<string, GitRefLabel[]>): GitCommit | undefined {
  const [hash, parents, author, email, date, subject] = record.replace(/^\n/, '').split('\x1f');
  if (!hash || subject === undefined) return undefined;
  return { hash, parents: parents ? parents.split(' ') : [], subject, author, email, date, refs: labels?.get(hash) ?? [] };
}

/** A commit object as `cat-file` prints it: header lines, a blank line, the message. */
function rawCommit(hash: string, text: string): GitCommit & { body: string } {
  const split = text.indexOf('\n\n');
  const headers = (split === -1 ? text : text.slice(0, split)).split('\n');
  const message = split === -1 ? '' : text.slice(split + 2);
  const person = /^author (.*) <([^>]*)> (\d+) /.exec(headers.find(line => line.startsWith('author ')) ?? '');
  const subjectEnd = message.indexOf('\n\n');
  return {
    hash, parents: headers.filter(line => line.startsWith('parent ')).map(line => line.slice(7)),
    subject: (subjectEnd === -1 ? message : message.slice(0, subjectEnd)).replace(/\n/g, ' ').trim(), body: subjectEnd === -1 ? '' : message.slice(subjectEnd + 2).trim(),
    author: person?.[1] ?? '', email: person?.[2] ?? '', date: person ? new Date(Number(person[3]) * 1000).toISOString() : '', refs: [],
  };
}

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

/**
 * Whether an entry's ctime is at or after `since` (epoch milliseconds). File systems stamp from a
 * coarse kernel clock, up to a few milliseconds behind the one `since` was read from; one that keeps
 * whole seconds only (a ctime with no fraction) is given two.
 */
function changedSince(info: { ctimeMs: number }, since: number): boolean {
  return info.ctimeMs >= since - (info.ctimeMs % 1000 === 0 ? 2_000 : 100);
}

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

function fileStateHash(index: Image, worktree: Image): string {
  const shape = (image: Image) => ({ exists: image.exists, kind: image.kind, mode: image.mode, hash: image.hash });
  return hash(JSON.stringify({ index: shape(index), worktree: shape(worktree) }));
}

export class GitService {
  readonly stateDir: string;
  private readonly repositoryMutations = new Set<string>();
  private readonly turnCheckpoints = new Map<string, Promise<Checkpoint | undefined>>();
  private readonly statusWatches = new Map<string, StatusWatch>();
  private closed = false;
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
    if (!repo.shadow) return runProcess('git', args, { cwd: repo.root, timeoutMs: options.timeoutMs, maxOutputBytes: options.maxOutputBytes, input: options.input, env: GIT_ENV });
    // The person's hooks and signing are for their own commits: run against a shadow repository they
    // would see their directory as the repository, and could prompt, fail or rewrite files in it.
    return runProcess('git', ['-c', `core.hooksPath=${path.join(repo.shadow, 'no-hooks')}`, '-c', 'commit.gpgsign=false', ...args], {
      cwd: repo.root, timeoutMs: options.timeoutMs, maxOutputBytes: options.maxOutputBytes, input: options.input,
      env: { ...GIT_ENV, GIT_DIR: repo.shadow, GIT_WORK_TREE: repo.root },
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

  /**
   * `git status`, asked for untracked directories as one entry each: listing every file under them
   * is what makes status slow in a large repository (several times the rest of the work together).
   * `untracked` then names the files of those directories where a caller needs them: `listed` while
   * there are few enough to show, `all` for a checkpoint, which has to copy each one. The distance
   * from the upstream is not asked for either: it is a walk through history, and `branchOf` reports it.
   */
  private async statusRaw(repo: Repo, untracked: 'collapsed' | 'listed' | 'all' = 'collapsed'): Promise<ParsedStatus> {
    const result = await this.git(repo, ['status', '--porcelain=v1', '-z', '--branch', '--no-ahead-behind', '--untracked-files=normal'], { timeoutMs: 60_000, maxOutputBytes: 32 * 1024 * 1024 });
    if (result.code !== 0) throw gitError(result, 'status');
    if (result.truncated) throw new AppError('GIT_STATUS_TOO_LARGE', 'Git status contains too many changed paths to return safely', 413);
    const parsed = parseStatus(result.stdout);
    const folders = parsed.paths.filter(item => item.status === '??' && item.path.endsWith('/'));
    if (untracked === 'collapsed' || !folders.length) return parsed;
    const listed = await this.git(repo, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...folders.map(item => literalPath(item.path))], { timeoutMs: 60_000, maxOutputBytes: 32 * 1024 * 1024 });
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

  /** Stops watching every followed project. */
  close(): void {
    this.closed = true;
    for (const watch of this.statusWatches.values()) { watch.listeners.clear(); this.closeStatusWatch(watch); }
    this.statusWatches.clear();
  }

  private async readStatus(project: ProjectRef): Promise<GitStatus> {
    const repo = await this.repo(project);
    // Both read the whole index, which is most of their cost in a large repository, so they run side by side.
    const [raw, tracked, base] = await Promise.all([this.statusRaw(repo, 'listed'), this.trackedStats(repo).catch(() => new Map<string, LineStat>()), this.baseRef(repo).catch(() => undefined)]);
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
    const base = await this.headCommit(repo) ?? await this.emptyTree(repo);
    const diff = await this.git(repo, ['diff', '--numstat', '-z', '--no-renames', '--no-ext-diff', base, '--'], { timeoutMs: 60_000, maxOutputBytes: 8 * 1024 * 1024 });
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

  private async resolveGitPath(repo: Repo, filePath: string): Promise<GitFile> {
    if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) throw new AppError('INVALID_PATH', 'Git path is invalid');
    const absolute = await resolveScopedPath(repo.projectRoot, filePath);
    const projectRelative = toProjectRelative(repo.projectRoot, absolute);
    if (!projectRelative) throw new AppError('INVALID_PATH', 'Repository root cannot be used as a file path');
    return { absolute, projectRelative, gitRelative: path.relative(repo.root, absolute).split(path.sep).join('/') };
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

  /** The file's entry in the index: absent, or `unmerged` while a conflict keeps several versions of it. */
  private async indexEntry(repo: Repo, gitPath: string): Promise<{ mode: string; oid: string } | 'unmerged' | undefined> {
    const result = await this.git(repo, ['ls-files', '--stage', '-z', '--', literalPath(gitPath)], { maxOutputBytes: 128 * 1024 });
    if (result.code !== 0) throw gitError(result, 'ls-files');
    const records = result.stdout.split('\0').filter(row => row.slice(row.indexOf('\t') + 1) === gitPath).map(row => row.slice(0, row.indexOf('\t')).split(' '));
    if (!records.length) return undefined;
    if (records.length > 1 || records[0][2] !== '0') return 'unmerged';
    return { mode: records[0][0], oid: records[0][1] };
  }

  private async treeEntry(repo: Repo, commit: string | undefined, gitPath: string): Promise<{ mode: string; oid: string } | undefined> {
    if (!commit) return undefined;
    const result = await this.git(repo, ['ls-tree', '-z', commit, '--', literalPath(gitPath)], { maxOutputBytes: 128 * 1024 });
    if (result.code !== 0) throw gitError(result, 'ls-tree');
    const record = result.stdout.split('\0').find(row => row.slice(row.indexOf('\t') + 1) === gitPath);
    if (!record) return undefined;
    const [mode, type, oid] = record.slice(0, record.indexOf('\t')).split(' ');
    return type === 'blob' || type === 'commit' ? { mode, oid } : undefined;
  }

  private async blobSide(repo: Repo, entry: { mode: string; oid: string } | undefined): Promise<Side> {
    if (!entry) return MISSING_SIDE;
    const mode = parseInt(entry.mode, 8);
    // A submodule's entry names a commit of another repository; there is no content to compare here.
    if (mode === 0o160000) return { exists: true, mode, data: Buffer.alloc(0), id: entry.oid };
    const result = await this.git(repo, ['cat-file', 'blob', entry.oid], { maxOutputBytes: MAX_DIFF_BYTES + 1, timeoutMs: 15_000 });
    if (result.code !== 0 && !result.truncated) throw gitError(result, 'cat-file');
    return { exists: true, mode, data: result.stdoutData, id: entry.oid, oid: entry.oid, ...(result.truncated || result.stdoutData.length > MAX_DIFF_BYTES ? { truncated: true } : {}) };
  }

  private async worktreeSide(absolute: string): Promise<Side> {
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
    const data = await this.readDiffWorktreeFile(absolute) ?? Buffer.alloc(0);
    return { exists: true, mode: info.mode & 0o111 ? 0o100755 : 0o100644, data, id: hash(data), ...(data.length > MAX_DIFF_BYTES ? { truncated: true } : {}) };
  }

  /** The file as a checkpoint has it: its saved copy, or the commit the checkpoint was taken on for a file that was clean then. */
  private async checkpointSide(repo: Repo, manifest: CheckpointManifest, file: GitFile): Promise<Side> {
    const saved = manifest.files.find(item => item.path === file.projectRelative);
    if (!saved) return this.blobSide(repo, await this.treeEntry(repo, manifest.head, file.gitRelative));
    if (!saved.worktree.exists) return MISSING_SIDE;
    const data = await this.imageData(this.checkpointPath(repo, manifest.checkpoint.id), saved.worktree);
    return {
      exists: true, mode: saved.worktree.kind === 'symlink' ? 0o120000 : saved.worktree.mode & 0o111 ? 0o100755 : 0o100644,
      data: data.subarray(0, MAX_DIFF_BYTES + 1), id: saved.worktree.hash!, ...(data.length > MAX_DIFF_BYTES ? { truncated: true } : {}),
    };
  }

  /** What a diff compares the working tree with: the index, `checkpoint:<id>`, or a commit. `staged` compares the index with HEAD instead. */
  private async diffScope(repo: Repo, options: { staged?: boolean; base?: string; commit?: string; from?: string }): Promise<DiffScope> {
    if (options.commit) {
      const [commit, parent] = await this.commitParents(repo, options.commit);
      return { kind: 'revision', commit, ...(parent ? { parent } : {}), ...(options.from ? { from: (await this.resolveGitPath(repo, options.from)).gitRelative } : {}) };
    }
    if (options.staged) return { kind: 'staged' };
    const base = options.base;
    if (!base) return { kind: 'worktree' };
    if (typeof base !== 'string' || base.length > 255 || base.startsWith('-') || base.includes('\0')) throw new AppError('INVALID_BASE', 'Comparison base is invalid');
    if (base.startsWith('checkpoint:')) return { kind: 'checkpoint', manifest: await this.readManifest(repo, base.slice('checkpoint:'.length)) };
    const commit = await this.revision(repo, `${base}^{commit}`);
    if (!commit) throw new AppError('INVALID_BASE', 'Comparison base does not identify a commit', 422);
    return { kind: 'commit', commit };
  }

  private async diffSides(repo: Repo, file: GitFile, scope: DiffScope): Promise<{ before: Side; after: Side; unmerged?: boolean }> {
    const mode = (entry: { mode: string } | 'unmerged' | undefined) => (entry && entry !== 'unmerged' ? parseInt(entry.mode, 8) : 0o100644);
    if (scope.kind === 'revision') {
      const [before, after] = await this.readBlobs(repo, [...(scope.parent ? [`${scope.parent}:${scope.from ?? file.gitRelative}`] : []), `${scope.commit}:${file.gitRelative}`]).then(blobs => (scope.parent ? blobs : [undefined, blobs[0]]));
      return { before: this.blobAsSide(before, 0o100644), after: this.blobAsSide(after, 0o100644) };
    }
    if (scope.kind === 'staged') {
      const head = await this.headCommit(repo);
      const [index, tree, blobs] = await Promise.all([this.indexEntry(repo, file.gitRelative), this.treeEntry(repo, head, file.gitRelative), this.readBlobs(repo, [`HEAD:${file.gitRelative}`, `:${file.gitRelative}`])]);
      const before = tree ? this.blobAsSide(blobs[0], mode(tree)) : MISSING_SIDE;
      return index === 'unmerged' ? { before, after: MISSING_SIDE, unmerged: true } : { before, after: index ? this.blobAsSide(blobs[1], mode(index)) : MISSING_SIDE };
    }
    if (scope.kind === 'checkpoint') return { before: await this.checkpointSide(repo, scope.manifest, file), after: await this.worktreeSide(file.absolute) };
    if (scope.kind === 'commit') {
      const [tree, blobs, after] = await Promise.all([this.treeEntry(repo, scope.commit, file.gitRelative), this.readBlobs(repo, [`${scope.commit}:${file.gitRelative}`]), this.worktreeSide(file.absolute)]);
      return { before: tree ? this.blobAsSide(blobs[0], mode(tree)) : MISSING_SIDE, after };
    }
    const [index, blobs, after] = await Promise.all([this.indexEntry(repo, file.gitRelative), this.readBlobs(repo, [`:${file.gitRelative}`]), this.worktreeSide(file.absolute)]);
    // A conflicted file has no single staged version; what the branch had is the nearest thing to compare with.
    if (index === 'unmerged') return { before: await this.blobSide(repo, await this.treeEntry(repo, await this.headCommit(repo), file.gitRelative)), after, unmerged: true };
    return { before: index ? this.blobAsSide(blobs[0], mode(index)) : MISSING_SIDE, after };
  }

  /**
   * Several blobs in one Git process, each named as `cat-file` takes them (`:path`, `HEAD:path`,
   * `<commit>:path`); a name that resolves to nothing comes back undefined. Opening the object store
   * is the expensive step in a repository of many packs, so it is done once for all of them.
   */
  private async readBlobs(repo: Repo, names: string[]): Promise<Array<{ oid: string; data: Buffer; truncated?: boolean } | undefined>> {
    if (names.some(name => /[\n\0]/.test(name))) throw new AppError('INVALID_PATH', 'Git path is invalid');
    const result = await this.git(repo, ['cat-file', '--batch'], { input: Buffer.from(names.map(name => `${name}\n`).join('')), maxOutputBytes: names.length * (MAX_DIFF_BYTES + 4096), timeoutMs: 30_000 });
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

  private blobAsSide(blob: { oid: string; data: Buffer; truncated?: boolean } | undefined, mode: number): Side {
    if (mode === 0o160000) return { exists: true, mode, data: Buffer.alloc(0), id: blob?.oid ?? 'submodule' };
    if (!blob) return MISSING_SIDE;
    return { exists: true, mode, data: blob.data, id: blob.oid, oid: blob.oid, ...(blob.truncated ? { truncated: true } : {}) };
  }

  /**
   * The unified diff of two contents, made from the contents themselves: the repository is not
   * consulted again, so the patch always matches the `before` and `after` it is returned with.
   */
  private async patchText(file: GitFile, before: Side, after: Side): Promise<{ text: string; truncated: boolean }> {
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

  async diff(project: ProjectRef, filePath: string, options: { staged?: boolean; base?: string; commit?: string; from?: string } = {}): Promise<GitDiff> {
    const repo = await this.repo(project);
    const file = await this.resolveGitPath(repo, filePath);
    const scope = await this.diffScope(repo, options);
    const { before, after, unmerged } = await this.diffSides(repo, file, scope);
    const binary = before.data.includes(0) || after.data.includes(0);
    const patch = binary ? { text: '', truncated: false } : await this.patchText(file, before, after);
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

  async stage(project: ProjectRef, paths: string[]): Promise<GitStatus> {
    const repo = await this.repo(project);
    return this.mutate(repo, async () => {
      const safe = await this.gitPaths(repo, paths);
      if (!safe.length) throw new AppError('INVALID_PATHS', 'At least one project path is required');
      const result = await this.git(repo, ['add', '--', ...safe.map(literalPath)], { timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 });
      if (result.code !== 0) throw gitError(result, 'stage');
      return this.status(project, true);
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
      return this.status(project, true);
    });
  }

  /**
   * Throws away the working tree's changes to [paths] (files, or directories of them): tracked files
   * go back to what is staged, untracked ones are deleted. Their current content is saved first as a
   * partial checkpoint, returned as `backup`, so restoring it undoes the discard. When a file cannot
   * be saved (too large, say) nothing is discarded unless `permanent` accepts that there is no undo.
   */
  async discard(project: ProjectRef, paths: string[], options: { permanent?: boolean } = {}): Promise<{ status: GitStatus; backup?: Checkpoint }> {
    const repo = await this.repo(project);
    return this.mutate(repo, async () => {
      const safe = await this.gitPaths(repo, paths);
      if (!safe.length) throw new AppError('INVALID_PATHS', 'At least one project path is required');
      const chosen = (file: string) => safe.some(item => file === item || file.startsWith(`${item}/`));
      const targets = (await this.statusRaw(repo, 'all')).paths.filter(item => chosen(item.path) && (item.status === '??' || item.status[1] !== ' ') && !UNMERGED.has(item.status) && asRelativePath(repo.root, repo.projectRoot, item.path) !== undefined);
      if (!targets.length) return { status: await this.status(project, true) };
      const backup = await this.discardBackup(repo, targets.map(item => asRelativePath(repo.root, repo.projectRoot, item.path)!), options.permanent === true);
      const tracked = targets.filter(item => item.status !== '??').map(item => item.path);
      if (tracked.length) {
        const restored = await this.git(repo, ['restore', '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: Buffer.from(tracked.map(literalPath).join('\0')), timeoutMs: 60_000, maxOutputBytes: 1024 * 1024 });
        if (restored.code !== 0) throw gitError(restored, 'restore');
      }
      for (const item of targets) {
        if (item.status === '??') await this.removeWorktreeFile(repo, path.join(repo.root, item.path));
      }
      return { status: await this.status(project, true), ...(backup ? { backup } : {}) };
    });
  }

  /** Deletes a file and the directories it leaves empty, as far up as the project's own. */
  private async removeWorktreeFile(repo: Repo, absolute: string): Promise<void> {
    await rm(absolute, { force: true });
    for (let folder = path.dirname(absolute); folder !== repo.projectRoot && isWithin(repo.projectRoot, folder); folder = path.dirname(folder)) {
      if (!(await rmdir(folder).then(() => true, () => false))) break;
    }
  }

  /** Saves [paths] as they are now, before a discard changes them. Without `permanent`, a path that cannot be saved stops the discard. */
  private async discardBackup(repo: Repo, paths: string[], permanent = false): Promise<Checkpoint | undefined> {
    const title = `Before discard: ${paths[0]}${paths.length > 1 ? ` and ${paths.length - 1} more` : ''}`;
    const { checkpoint } = await this.createCheckpointRecord(repo, { title, paths });
    if (checkpoint.excluded.length) {
      // A checkpoint with files left out cannot be restored, so it would only promise an undo it cannot give.
      await rm(this.checkpointPath(repo, checkpoint.id), { recursive: true, force: true });
      if (!permanent) throw new AppError('DISCARD_UNRECOVERABLE', 'Some of these files cannot be saved first, so discarding them could not be undone', 409, { paths: checkpoint.excluded });
      return undefined;
    }
    for (const stale of (await this.listCheckpoints(repo)).filter(item => item.partial).slice(PARTIAL_CHECKPOINTS_KEPT)) await rm(this.checkpointPath(repo, stale.id), { recursive: true, force: true }).catch(() => undefined);
    await this.pruneOrphanCheckpointObjects(repo);
    return checkpoint;
  }

  private async writeIndex(repo: Repo, gitPath: string, content?: { data: Buffer; mode: number; clean?: boolean }): Promise<void> {
    if (!content) {
      const removed = await this.git(repo, ['update-index', '--force-remove', '--', gitPath], { maxOutputBytes: 1024 * 1024 });
      if (removed.code !== 0) throw gitError(removed, 'update-index');
      return;
    }
    // `clean` content comes from the working tree, so it passes through the path's filters (line endings, say) as `git add` would.
    const blob = await this.git(repo, ['hash-object', '-w', ...(content.clean ? [`--path=${gitPath}`] : []), '--stdin'], { input: content.data, maxOutputBytes: 4096 });
    if (blob.code !== 0) throw gitError(blob, 'hash-object');
    const result = await this.git(repo, ['update-index', '--add', '--cacheinfo', content.mode.toString(8), blob.stdout.trim(), gitPath], { maxOutputBytes: 1024 * 1024 });
    if (result.code !== 0) throw gitError(result, 'update-index');
  }

  /**
   * Stages, unstages or discards chosen lines of one file, the way a diff shows them: each change
   * pairs a range of the diff's `before` lines with a range of its `after` lines. `version` is the
   * one that diff carried; if either content has changed since, nothing is written and the reader
   * has to look again. A discard saves the file first and returns that checkpoint as `backup`; with
   * `base` it takes the lines back to a checkpoint or commit rather than to what is staged.
   */
  async applyLines(project: ProjectRef, input: { path: string; action: 'stage' | 'unstage' | 'discard'; changes: GitLineChange[]; version: string; base?: string }): Promise<{ status: GitStatus; backup?: Checkpoint }> {
    const changes = lineChanges(input?.changes);
    if (!['stage', 'unstage', 'discard'].includes(input.action)) throw new AppError('INVALID_INPUT', 'Choose stage, unstage or discard');
    const repo = await this.repo(project);
    return this.mutate(repo, async () => {
      const file = await this.resolveGitPath(repo, input.path);
      const scope = input.action === 'unstage' ? { kind: 'staged' as const } : await this.diffScope(repo, input.action === 'discard' ? { base: input.base } : {});
      const { before, after, unmerged } = await this.diffSides(repo, file, scope);
      const version = unmerged ? undefined : diffVersion(scope, before, after);
      if (!version) throw new AppError('GIT_LINES_UNSUPPORTED', 'Lines of this file cannot be changed one range at a time', 422);
      if (version !== input.version) throw new AppError('GIT_DIFF_STALE', 'The file changed since this diff was read', 409);
      if (input.action === 'stage') {
        const data = spliceLines(before.data, after.data, changes.map(change => ({ target: change.before, source: change.after })));
        await this.writeIndex(repo, file.gitRelative, !after.exists && !data.length ? undefined : { data, mode: before.exists ? before.mode : after.mode, clean: true });
        return { status: await this.status(project, true) };
      }
      if (input.action === 'unstage') {
        const data = spliceLines(after.data, before.data, changes.map(change => ({ target: change.after, source: change.before })));
        await this.writeIndex(repo, file.gitRelative, !before.exists && !data.length ? undefined : { data, mode: after.exists ? after.mode : before.mode });
        return { status: await this.status(project, true) };
      }
      // What Git stores may differ from what it checks out (line endings); the lines put back are the checked-out ones.
      let source = before.data;
      if (before.oid) {
        const smudged = await this.git(repo, ['cat-file', '--filters', `--path=${file.gitRelative}`, before.oid], { maxOutputBytes: 4 * MAX_DIFF_BYTES, timeoutMs: 15_000 });
        if (smudged.code !== 0 || smudged.truncated) throw gitError(smudged, 'cat-file');
        source = smudged.stdoutData;
        if (splitLines(source).length !== splitLines(before.data).length) throw new AppError('GIT_LINES_UNSUPPORTED', 'Lines of this file cannot be changed one range at a time', 422);
      }
      const data = spliceLines(after.data, source, changes.map(change => ({ target: change.after, source: change.before })));
      const backup = await this.discardBackup(repo, [file.projectRelative]);
      // The lines put back were worked out from the file as it was read above; an edit since then would be lost.
      if ((await this.worktreeSide(file.absolute)).id !== after.id) throw new AppError('GIT_DIFF_STALE', 'The file changed since this diff was read', 409);
      if (!before.exists && !data.length) await this.removeWorktreeFile(repo, file.absolute);
      else await this.replaceWorktreeFile(repo, file.projectRelative, { data, mode: before.exists && !after.exists ? (before.mode & 0o111 ? 0o755 : 0o644) : undefined });
      return { status: await this.status(project, true), ...(backup ? { backup } : {}) };
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
      return { hash: head.stdout.trim(), message, status: await this.status(project, true) };
    });
  }

  private checkpointFolder(repo: Repo): string { return path.join(this.stateDir, 'checkpoints', hash(repo.projectId).slice(0, 32)); }
  private checkpointPath(repo: Repo, id: string): string { return path.join(this.checkpointFolder(repo), id); }

  private async headCommit(repo: Repo): Promise<string | undefined> {
    const result = await this.git(repo, ['rev-parse', '--verify', 'HEAD'], { maxOutputBytes: 4096 });
    return result.code === 0 ? result.stdout.trim() : undefined;
  }

  private async dirtyPaths(repo: Repo): Promise<string[]> {
    const status = await this.statusRaw(repo, 'all');
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
  private async pruneOrphanCheckpointObjects(repo: Repo): Promise<void> {
    const objectsDir = path.join(this.checkpointFolder(repo), '.objects');
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
    return this.blobImage(data, mode, folder);
  }

  private async blobImage(data: Buffer, mode: string, folder?: string): Promise<Image> {
    const symlinkMode = mode === '120000';
    const image: Image = { exists: true, kind: symlinkMode ? 'symlink' : 'file', mode: parseInt(mode, 8), size: data.length };
    if (folder) Object.assign(image, await this.storeBlob(folder, data));
    else image.hash = hash(data);
    if (symlinkMode) image.linkTarget = data.toString('utf8');
    return image;
  }

  /**
   * The index side of many paths, from their `indexRecords`, with two more Git processes rather than
   * two per path: `cat-file --batch-check` for sizes, one `cat-file --batch` for the blobs. Per path a
   * worktree with a hundred changes took seconds, and a turn's checkpoint, taken while the turn runs,
   * has to be done before the turn reaches the files. A path this cannot settle (unmerged, not a blob,
   * over the per-file limit, a failed batch) is left out, and the caller reads it with `indexImage`,
   * which reports it the way it always has.
   */
  private async indexImages(repo: Repo, gitPaths: string[], records: Map<string, string[]>, folder: string): Promise<Map<string, Image>> {
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
    const checked = await this.git(repo, ['cat-file', '--batch-check'], { input: Buffer.from(`${oids.join('\n')}\n`), maxOutputBytes: oids.length * 128 });
    if (checked.code !== 0 || checked.truncated) return images;
    const sizes = new Map<string, number>();
    for (const line of checked.stdout.split('\n')) {
      const [oid, type, size] = line.split(' ');
      if (oid && type === 'blob' && Number(size) <= MAX_CHECKPOINT_FILE_BYTES) sizes.set(oid, Number(size));
    }
    const wanted = oids.filter(oid => sizes.has(oid));
    const total = wanted.reduce((sum, oid) => sum + sizes.get(oid)!, 0);
    if (!wanted.length || total > MAX_CHECKPOINT_TOTAL_BYTES) return images;
    const read = await this.git(repo, ['cat-file', '--batch'], { input: Buffer.from(`${wanted.join('\n')}\n`), maxOutputBytes: total + wanted.length * 128, timeoutMs: 60_000 });
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
      if (data) images.set(gitPath, await this.blobImage(data, entry.mode, folder));
    }
    return images;
  }

  /**
   * The index rows (`mode oid stage`) of each path, from `ls-files --stage` in batches: none for a path
   * the index does not hold. A path of a batch Git failed to list is absent.
   */
  private async indexRecords(repo: Repo, gitPaths: string[]): Promise<Map<string, string[]>> {
    const records = new Map<string, string[]>();
    for (let start = 0; start < gitPaths.length; start += INDEX_BATCH_PATHS) {
      const batch = gitPaths.slice(start, start + INDEX_BATCH_PATHS);
      // A row is a path and 50 bytes of mode, id and stage; a path is at most 4 KiB.
      const listed = await this.git(repo, ['ls-files', '--stage', '-z', '--', ...batch.map(literalPath)], { maxOutputBytes: batch.length * 4_200 });
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
  private async touchedSince(repo: Repo, absolute: string, since: number): Promise<boolean> {
    for (let target = absolute; ; target = path.dirname(target)) {
      try { return changedSince(await lstat(target), since); } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if ((code !== 'ENOENT' && code !== 'ENOTDIR') || target === repo.root || !isWithin(repo.root, target)) return true;
      }
    }
  }

  /** Whether HEAD, the branch it is on or its reflog changed at or after `since`, or HEAD is no longer `head`. */
  private async headMovedSince(repo: Repo, head: string | undefined, since: number): Promise<boolean> {
    if (await this.headCommit(repo) !== head) return true;
    const located = await this.git(repo, ['rev-parse', '--git-path', 'HEAD', '--git-path', 'logs/HEAD', '--symbolic-full-name', 'HEAD'], { maxOutputBytes: 64 * 1024 });
    const [headFile, reflog, branch] = located.stdout.split('\n');
    const files = [headFile, reflog];
    if (branch?.startsWith('refs/')) files.push((await this.git(repo, ['rev-parse', '--git-path', branch], { maxOutputBytes: 64 * 1024 })).stdout.trim());
    for (const file of files) {
      if (!file) continue;
      const info = await lstat(path.resolve(repo.root, file)).catch(() => undefined);
      if (info && changedSince(info, since)) return true;
    }
    return false;
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

  /**
   * With `paths` (project-relative files) the checkpoint is partial: it holds those files, changed or not, and nothing else.
   *
   * With `since`, it is taken while something may already be changing the files (a turn sent at that
   * time), so it holds only what it can tell is from before: a file whose worktree side changed after
   * `since`, or whose index entry changed while it was read, is left out (`excluded`), and if HEAD moved
   * it holds nothing at all (`CHECKPOINT_HEAD_MOVED`). A file changed after `since` that was clean
   * before needs nothing: status did not list it, and the checkpoint takes it from HEAD.
   */
  private async createCheckpointRecord(repo: Repo, options: { sessionId?: string; runId?: string; title?: string; paths?: string[]; since?: number }): Promise<CheckpointManifest> {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const title = options.title?.trim().slice(0, 300) || `Checkpoint ${createdAt}`;
    const folder = this.checkpointPath(repo, id);
    // Status first: a change a running turn makes before it lists a file that is clean, or gone, by then is one nothing can see.
    const [dirty, head] = await Promise.all([
      options.paths ? options.paths.map(item => path.relative(repo.root, path.resolve(repo.projectRoot, item)).split(path.sep).join('/')) : this.dirtyPaths(repo),
      this.headCommit(repo),
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
    const records = await this.indexRecords(repo, kept);
    const staged = await this.indexImages(repo, kept, records, folder);
    const gitPaths = new Map<string, string>();
    const { since } = options;
    for (const gitPath of kept) {
      const relative = asRelativePath(repo.root, repo.projectRoot, gitPath);
      if (relative === undefined) continue;
      try {
        const index = staged.get(gitPath) ?? await this.indexImage(repo, gitPath, folder);
        const worktree = await this.readWorktreeImage(repo, relative, folder);
        // Checked after the read: unchanged since `since` until now, what was read is from before it.
        if (since !== undefined && await this.touchedSince(repo, path.join(repo.root, gitPath), since)) { manifest.checkpoint.excluded.push(relative); continue; }
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
      const now = await this.indexRecords(repo, [...gitPaths.values()]);
      const same = (a?: string[], b?: string[]) => a !== undefined && b !== undefined && a.join('\n') === b.join('\n');
      const moved = new Set(manifest.files.filter(item => !same(records.get(gitPaths.get(item.path)!), now.get(gitPaths.get(item.path)!))).map(item => item.path));
      manifest.files = manifest.files.filter(item => !moved.has(item.path));
      manifest.checkpoint.excluded.push(...moved);
      if (await this.headMovedSince(repo, head, since)) {
        await rm(folder, { recursive: true, force: true }).catch(() => undefined);
        throw new AppError('CHECKPOINT_HEAD_MOVED', 'HEAD moved while the checkpoint was taken', 409);
      }
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
  async createTurnCheckpoint(project: ProjectRef, options: { sessionId: string; runId: string; title: string; since: number }): Promise<Checkpoint | undefined> {
    const repo = await this.repo(project);
    const key = JSON.stringify([repo.projectId, options.sessionId, options.runId]);
    const pending = this.turnCheckpoints.get(key);
    if (pending) return pending;
    const capture = (async () => {
      // Taken while the turn runs (`since`), so before anything else. A commit made meanwhile leaves no
      // way to tell which clean files were clean before it, and no checkpoint is better than a misleading one.
      const taken = await this.createCheckpointRecord(repo, options).then(manifest => manifest.checkpoint, error => {
        if (error instanceof AppError && error.code === 'CHECKPOINT_HEAD_MOVED') return undefined;
        throw error;
      });
      // One this turn already has (a retry after a restart) stays the one it is undone to.
      const all = await this.checkpoints(project);
      const earlier = all.find(item => item.runId === options.runId && item.sessionId === options.sessionId && item.id !== taken?.id);
      if (earlier && taken) await rm(this.checkpointPath(repo, taken.id), { recursive: true, force: true }).catch(() => undefined);
      const checkpoint = earlier ?? taken;
      const turns = all.filter(item => item.runId && item.id !== (earlier && taken?.id));
      for (const stale of turns.slice(TURN_CHECKPOINTS_KEPT)) await rm(this.checkpointPath(repo, stale.id), { recursive: true, force: true }).catch(() => undefined);
      await this.pruneUnfinishedCheckpoints(repo);
      return checkpoint;
    })();
    this.turnCheckpoints.set(key, capture);
    try { return await capture; }
    finally { this.turnCheckpoints.delete(key); }
  }

  /** Folders a capture left without a manifest when the service stopped during it, an hour on. */
  private async pruneUnfinishedCheckpoints(repo: Repo): Promise<void> {
    const folder = this.checkpointFolder(repo);
    for (const name of await readdir(folder).catch(() => [] as string[])) {
      if (!/^[a-f0-9-]{36}$/i.test(name)) continue;
      const entry = path.join(folder, name);
      if (await lstat(path.join(entry, 'manifest.json')).then(() => true, () => false)) continue;
      const info = await lstat(entry).catch(() => undefined);
      if (info?.isDirectory() && Date.now() - info.mtimeMs > UNFINISHED_CHECKPOINT_MS) await rm(entry, { recursive: true, force: true }).catch(() => undefined);
    }
    await this.pruneOrphanCheckpointObjects(repo);
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

  async checkpoints(project: ProjectRef): Promise<Checkpoint[]> {
    return this.listCheckpoints(await this.repo(project));
  }

  private async listCheckpoints(repo: Repo): Promise<Checkpoint[]> {
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
    // A partial checkpoint speaks only for its own files; anything else changed is not its to put back.
    for (const gitPath of manifest.checkpoint.partial ? [] : await this.dirtyPaths(repo)) {
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
    const data = await this.imageData(folder, image);
    await this.replaceWorktreeFile(repo, projectRelative, image.kind === 'symlink' ? { data, link: image.linkTarget ?? data.toString('utf8') } : { data, mode: image.mode & 0o777 || 0o600 });
  }

  /** Writes a file (or symlink) beside its destination and renames it into place. Without `mode` an existing file keeps its own. */
  private async replaceWorktreeFile(repo: Repo, projectRelative: string, content: { data: Buffer; mode?: number; link?: string }): Promise<void> {
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

  private async setIndexImage(repo: Repo, projectRelative: string, image: Image, folder: string): Promise<void> {
    const absolute = await resolveScopedPath(repo.projectRoot, projectRelative, true);
    const gitPath = path.relative(repo.root, absolute).split(path.sep).join('/');
    if (!image.exists) {
      // `update-index` takes plain paths: given pathspec magic it removed nothing and reported success.
      return this.writeIndex(repo, gitPath);
    }
    await this.writeIndex(repo, gitPath, { data: await this.imageData(folder, image), mode: image.mode });
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
      const scope = manifest.checkpoint.partial ? { paths: manifest.files.map(item => item.path) } : {};
      if (!current.length) return { restored: 0, backup: (await this.createCheckpointRecord(repo, { title: `Before restore: ${manifest.checkpoint.title}`, ...scope })).checkpoint };

      const backupManifest = await this.createCheckpointRecord(repo, { title: `Before restore: ${manifest.checkpoint.title}`, ...scope });
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
      const args = ['worktree', 'add', '-f', '-b', branch, target]; // -f: a tree deleted behind git's back stays registered, and `add` would refuse its path
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

  /**
   * Creates a worktree starting at a turn checkpoint's exact commit and file state (worktree + index).
   * Returns `undefined` when the checkpoint is partial, has excluded paths, or its commit is gone,
   * allowing the caller to fall back to `HEAD`.
   */
  async createWorktreeFromCheckpoint(project: ProjectRef, input: { branch: string; checkpointId: string }): Promise<WorktreeInfo | undefined> {
    const originRepo = await this.repo(project);
    const manifest = await this.readManifest(originRepo, input.checkpointId).catch(() => undefined);
    if (!manifest || manifest.checkpoint.partial || manifest.checkpoint.excluded.length || !manifest.head) return undefined;
    const verified = await this.revision(originRepo, `${manifest.head}^{commit}`);
    if (!verified) return undefined;
    const created = await this.createWorktree(project, { branch: input.branch, base: verified });
    if (!manifest.files.length) return created;
    const originSubpath = path.relative(originRepo.root, originRepo.projectRoot);
    const canonicalRoot = await realpath(created.path);
    const targetProjectRoot = originSubpath ? path.join(canonicalRoot, originSubpath) : canonicalRoot;
    const targetRepo: Repo = {
      root: canonicalRoot,
      projectRoot: await realpath(targetProjectRoot).catch(() => targetProjectRoot),
      projectId: originRepo.projectId,
    };
    const folder = this.checkpointPath(originRepo, manifest.checkpoint.id);
    try {
      for (const file of manifest.files) {
        await this.atomicWorktreeImage(targetRepo, file.path, file.worktree, folder);
        await this.setIndexImage(targetRepo, file.path, file.index, folder);
      }
      return created;
    } catch (error) {
      await this.discardWorktree(project, created.path, created.branch ?? input.branch).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Force-removes a freshly created worktree (even if dirty from a restored checkpoint) and deletes
   * its newly created branch, used only when rolling back an aborted fork/attempt before launch.
   */
  async discardWorktree(project: ProjectRef, worktreePath: string, branch?: string): Promise<void> {
    const repo = await this.repo(project);
    return this.mutate(repo, async () => {
      await this.git(repo, ['worktree', 'remove', '--force', '--', worktreePath], { timeoutMs: 30_000, maxOutputBytes: 256 * 1024 }).catch(() => undefined);
      await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
      if (branch && !branch.startsWith('-')) {
        await this.git(repo, ['branch', '-D', '--', branch], { timeoutMs: 15_000, maxOutputBytes: 64 * 1024 }).catch(() => undefined);
      }
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
      const dirty = await runProcess('git', ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], { cwd: target.path, maxOutputBytes: 16 * 1024 * 1024, timeoutMs: 60_000, env: GIT_ENV });
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
    const head = await this.headCommit(repo);
    const upstreamName = await this.git(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { timeoutMs: 10_000, maxOutputBytes: 4096 });
    const upstream = upstreamName.code === 0 ? upstreamName.stdout.trim() || undefined : undefined;
    let ahead = 0, behind = 0;
    // Level with its upstream is the usual case, and needs no walk through history to know.
    if (upstream && head && await this.revision(repo, '@{upstream}') !== head) {
      const counts = await this.git(repo, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], { timeoutMs: 60_000, maxOutputBytes: 4096 });
      const [left, right] = counts.stdout.trim().split(/\s+/).map(Number);
      if (counts.code === 0 && Number.isSafeInteger(left) && Number.isSafeInteger(right)) { behind = left; ahead = right; }
    }
    return { branch, ...(head ? { head } : {}), ...(upstream ? { upstream } : {}), ahead, behind, remotes };
  }

  private async emptyTree(repo: Repo): Promise<string> {
    const empty = await this.git(repo, ['hash-object', '-t', 'tree', '/dev/null'], { maxOutputBytes: 4096 });
    if (empty.code !== 0) throw gitError(empty, 'hash-object');
    return empty.stdout.trim();
  }

  private async commitHash(repo: Repo, spec: string): Promise<string> {
    if (typeof spec !== 'string' || !spec || spec.length > 255 || spec.startsWith('-') || spec.includes('\0')) throw new AppError('INVALID_COMMIT', 'Commit reference is invalid');
    const commit = await this.revision(repo, `${spec}^{commit}`);
    if (!commit) throw new AppError('COMMIT_NOT_FOUND', 'That commit is not in this repository', 404);
    return commit;
  }

  /** A commit and its parents, resolved by one Git process. */
  private async commitParents(repo: Repo, spec: string): Promise<string[]> {
    if (typeof spec !== 'string' || !/^[0-9a-f]{7,64}$/i.test(spec)) throw new AppError('INVALID_COMMIT', 'Commit reference is invalid');
    const result = await this.git(repo, ['rev-parse', `${spec}^{commit}`, `${spec}^@`], { timeoutMs: 30_000, maxOutputBytes: 64 * 1024 });
    const hashes = result.stdout.split('\n').filter(Boolean);
    if (result.code !== 0 || !hashes.length) throw new AppError('COMMIT_NOT_FOUND', 'That commit is not in this repository', 404);
    return hashes;
  }

  /** The directory a project covers, as a pathspec: history and commits of a project in a subdirectory show only what touched it. */
  private scopeArgs(repo: Repo): string[] {
    const scope = path.relative(repo.root, repo.projectRoot).split(path.sep).join('/');
    return scope ? ['--', literalPath(scope)] : [];
  }

  /**
   * What history is labelled with, by commit: local branches, tags, and the remote branches the
   * local ones track. Read from the refs alone and matched here: asking `git log` to label commits
   * makes it load every ref of the repository, tens of thousands of remote branches included.
   */
  private async shownRefs(repo: Repo): Promise<{ labels: Map<string, GitRefLabel[]>; upstreams: string[] }> {
    const listed = await this.git(repo, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(*objectname)%00%(HEAD)%00%(upstream)', 'refs/heads', 'refs/tags'], { timeoutMs: 30_000, maxOutputBytes: 16 * 1024 * 1024 });
    if (listed.code !== 0) throw gitError(listed, 'for-each-ref');
    const labels = new Map<string, GitRefLabel[]>();
    const add = (hash: string, label: GitRefLabel) => { const list = labels.get(hash); if (list) list.push(label); else labels.set(hash, [label]); };
    const upstreams = new Set<string>();
    let onBranch = false;
    for (const row of listed.stdout.split('\n')) {
      const [ref, hash, peeled, head, upstream] = row.split('\0');
      if (!ref || !hash) continue;
      if (ref.startsWith('refs/tags/')) { add(peeled || hash, { kind: 'tag', name: ref.slice(10) }); continue; }
      if (head === '*') onBranch = true;
      add(hash, { kind: 'branch', name: ref.slice(11), ...(head === '*' ? { current: true } : {}) });
      if (upstream?.startsWith('refs/remotes/')) upstreams.add(upstream);
    }
    const tracked = [...upstreams].slice(0, 200);
    if (tracked.length) {
      const remote = await this.git(repo, ['for-each-ref', '--format=%(refname)%00%(objectname)', ...tracked], { timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 });
      for (const row of remote.code === 0 ? remote.stdout.split('\n') : []) {
        const [ref, hash] = row.split('\0');
        if (ref && hash) add(hash, { kind: 'remote', name: ref.slice(13) });
      }
    }
    const head = onBranch ? undefined : await this.headCommit(repo);
    if (head) add(head, { kind: 'head', name: 'HEAD' });
    return { labels, upstreams: tracked };
  }

  /**
   * A page of history, newest first, with each commit's parents so the reader can draw the graph.
   * `all` walks every local branch and what it tracks rather than only what the checkout can reach.
   */
  async log(project: ProjectRef, options: { all?: boolean; skip?: number; limit?: number } = {}): Promise<GitLog> {
    const repo = await this.repo(project);
    const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? LOG_PAGE)), 500);
    const skip = Math.min(Math.max(0, Math.trunc(options.skip ?? 0)), 1_000_000);
    if (!(await this.headCommit(repo))) return { commits: [], more: false };
    const shown = await this.shownRefs(repo);
    // Git's own order streams the newest commits without first walking all of history, which a
    // topological order has to; a repository's remote branches can run to tens of thousands, so
    // `all` starts from the local ones and what they track rather than from every ref.
    const result = await this.git(repo, [
      'log', `--format=${LOG_FORMAT}%x1e`, `--max-count=${limit + 1}`, `--skip=${skip}`,
      // An upstream deleted on the remote is still named by its branch; it is skipped rather than failing the walk.
      ...(options.all ? ['--ignore-missing', '--branches', ...shown.upstreams, 'HEAD'] : ['HEAD']), ...this.scopeArgs(repo),
    ], { timeoutMs: 60_000, maxOutputBytes: 8 * 1024 * 1024 });
    if (result.code !== 0 || result.truncated) throw gitError(result, 'log');
    const commits = result.stdout.split('\x1e').map(record => logCommit(record, shown.labels)).filter((item): item is GitCommit => Boolean(item));
    return { commits: commits.slice(0, limit), more: commits.length > limit };
  }

  /** `--name-status -z` output, renames included, as project-relative files; those outside the project are left out. */
  private changedFiles(repo: Repo, output: string): Array<{ path: string; git: string; originalPath?: string; status: string }> {
    const files: Array<{ path: string; git: string; originalPath?: string; status: string }> = [];
    const parts = output.split('\0');
    for (let index = 0; index + 1 < parts.length;) {
      const status = parts[index++];
      const from = status.startsWith('R') || status.startsWith('C') ? parts[index++] : undefined;
      const file = parts[index++];
      const relative = file === undefined ? undefined : asRelativePath(repo.root, repo.projectRoot, file);
      if (file === undefined || relative === undefined) continue;
      const originalPath = from === undefined ? undefined : asRelativePath(repo.root, repo.projectRoot, from);
      files.push({ path: relative, git: file, ...(originalPath !== undefined ? { originalPath } : {}), status: status[0] });
    }
    return files;
  }

  /** `--numstat -z` output per git path; a renamed file's counts are followed by its two paths as separate fields. */
  private numstat(output: string): Map<string, LineStat> {
    const stats = new Map<string, LineStat>();
    const counted = output.split('\0');
    for (let index = 0; index < counted.length; index += 1) {
      const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(counted[index]);
      if (!match) continue;
      const file = match[3] || counted[index += 2];
      if (file && match[1] !== '-') stats.set(file, { added: Number(match[1]), removed: Number(match[2]) });
    }
    return stats;
  }

  /**
   * One commit: its whole message, and the files it changed against its first parent (a merge shows
   * what it brought in). Line counts mean reading every changed file, so they are left out of a
   * commit that touches more than [MAX_STAT_FILES]; past [MAX_CHANGED_FILES] the list itself is cut
   * and `filesTotal` says how long it was.
   */
  async commitDetail(project: ProjectRef, spec: string): Promise<GitCommitDetail> {
    const repo = await this.repo(project);
    if (typeof spec !== 'string' || !/^[0-9a-f]{7,64}$/i.test(spec)) throw new AppError('INVALID_COMMIT', 'Commit reference is invalid');
    const tree = ['diff-tree', '--root', '-r', '--no-commit-id', '-m', '--first-parent', '--no-ext-diff', '-z'];
    const [shown, names] = await Promise.all([
      // The commit object itself: `show` works out a merge's combined diff even when told to print none of it.
      this.git(repo, ['cat-file', 'commit', spec], { timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 }),
      this.git(repo, [...tree, '--no-renames', '--name-status', spec, ...this.scopeArgs(repo)], { timeoutMs: 60_000, maxOutputBytes: 32 * 1024 * 1024 }),
    ]);
    if (shown.code !== 0 || !shown.stdout.trim()) throw new AppError('COMMIT_NOT_FOUND', 'That commit is not in this repository', 404);
    if (names.code !== 0) throw gitError(names, 'diff-tree');
    const commit = rawCommit(spec, shown.stdout);
    let changed = this.changedFiles(repo, names.stdout);
    let stats = new Map<string, LineStat>();
    // Renames and line counts both read file contents, so they are worked out only for a commit of ordinary width.
    if (changed.length <= MAX_STAT_FILES) {
      const [renamed, numbers] = await Promise.all([
        this.git(repo, [...tree, '-M', '--name-status', spec, ...this.scopeArgs(repo)], { timeoutMs: 60_000, maxOutputBytes: 8 * 1024 * 1024 }),
        this.git(repo, [...tree, '-M', '--numstat', spec, ...this.scopeArgs(repo)], { timeoutMs: 60_000, maxOutputBytes: 8 * 1024 * 1024 }),
      ]);
      if (renamed.code === 0 && numbers.code === 0) { changed = this.changedFiles(repo, renamed.stdout); stats = this.numstat(numbers.stdout); }
    }
    const files = changed.slice(0, MAX_CHANGED_FILES).map(({ git, ...file }) => ({ ...file, ...(stats.get(git) ?? {}) }));
    return { ...commit, files, ...(changed.length > files.length || names.truncated ? { filesTotal: changed.length } : {}) };
  }

  /**
   * Local branches, tags, and the remote branches that have no local one yet. Only ref names and
   * the commits they point at are read: sorting by date or counting ahead/behind opens an object per
   * ref, which takes tens of seconds across thousands of them. `query` narrows the remote branches,
   * of which at most [REMOTE_BRANCHES_LISTED] come back; `remoteCount` is how many match in all.
   */
  async refs(project: ProjectRef, options: { query?: string } = {}): Promise<GitRefs> {
    const repo = await this.repo(project);
    const [heads, others] = await Promise.all([
      this.git(repo, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(upstream:short)%00%(HEAD)%00%(worktreepath)', 'refs/heads'], { timeoutMs: 30_000, maxOutputBytes: 8 * 1024 * 1024 }),
      this.git(repo, ['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/remotes', 'refs/tags'], { timeoutMs: 30_000, maxOutputBytes: 32 * 1024 * 1024 }),
    ]);
    if (heads.code !== 0 || heads.truncated) throw gitError(heads, 'for-each-ref');
    if (others.code !== 0 || others.truncated) throw gitError(others, 'for-each-ref');
    const refs: GitRefs = { branches: [], remotes: [], remoteCount: 0, tags: [] };
    for (const row of heads.stdout.split('\n')) {
      const [ref, hash, upstream, head, worktree] = row.split('\0');
      if (!ref || !hash) continue;
      const branch: GitBranchRef = { name: ref.slice(11), hash, ...(upstream ? { upstream } : {}) };
      if (head === '*') { branch.current = true; refs.head = branch.name; }
      else if (worktree) branch.elsewhere = true;
      refs.branches.push(branch);
    }
    refs.branches.sort((a, b) => Number(Boolean(b.current)) - Number(Boolean(a.current)));
    const local = new Set(refs.branches.map(branch => branch.name));
    const query = options.query?.trim().toLowerCase();
    for (const row of others.stdout.split('\n')) {
      const [ref, hash] = row.split('\0');
      if (!ref || !hash) continue;
      if (ref.startsWith('refs/tags/')) { if (refs.tags.length < 500) refs.tags.push({ name: ref.slice(10), hash }); continue; }
      const name = ref.slice(13);
      if (ref.endsWith('/HEAD') || local.has(name.slice(name.indexOf('/') + 1)) || (query && !name.toLowerCase().includes(query))) continue;
      refs.remoteCount += 1;
      if (refs.remotes.length < REMOTE_BRANCHES_LISTED) refs.remotes.push({ name, hash });
    }
    return refs;
  }

  /**
   * Checks out a branch: an existing local one, a new one (`create`, from `base` or the current
   * commit), or a remote one (`remote`, as in `origin/topic`), which gets a local branch tracking it.
   * Uncommitted changes travel along when they fit; when they would be overwritten Git refuses and
   * nothing changes.
   */
  async switchBranch(project: ProjectRef, input: { branch?: string; create?: boolean; base?: string; remote?: string }): Promise<GitRefs> {
    const repo = await this.repo(project);
    await this.mutate(repo, async () => {
      let args: string[];
      if (input.remote !== undefined) {
        const remote = requireString(input.remote, 'remote', 255);
        if (!(await this.revision(repo, `refs/remotes/${remote}`))) throw new AppError('INVALID_BRANCH', 'That remote branch does not exist', 404);
        const local = remote.slice(remote.indexOf('/') + 1);
        args = await this.revision(repo, `refs/heads/${local}`) ? ['switch', local] : ['switch', '--track', remote];
      } else {
        const branch = requireString(input.branch, 'branch', 255);
        const valid = await this.git(repo, ['check-ref-format', '--branch', branch], { maxOutputBytes: 4096 });
        if (valid.code !== 0) throw new AppError('INVALID_BRANCH', 'Branch name is invalid');
        if (input.create) {
          const base = input.base?.trim() ? await this.commitHash(repo, input.base.trim()) : undefined;
          args = ['switch', '--create', branch, ...(base ? [base] : [])];
        } else {
          if (!(await this.revision(repo, `refs/heads/${branch}`))) throw new AppError('INVALID_BRANCH', 'That branch does not exist', 404);
          args = ['switch', branch];
        }
      }
      const result = await this.git(repo, args, { timeoutMs: 120_000, maxOutputBytes: 1024 * 1024 });
      if (result.code !== 0) {
        if (/would be overwritten by checkout/i.test(result.stderr)) throw new AppError('GIT_SWITCH_BLOCKED', 'Uncommitted changes would be overwritten by switching; commit or discard them first', 409);
        throw gitError(result, 'switch');
      }
    });
    return this.refs(project);
  }

  /** Brings every remote's branches up to date and drops the ones deleted there. Nothing in the checkout changes. */
  async fetch(project: ProjectRef): Promise<GitRefs> {
    const repo = await this.repo(project);
    const result = await runProcess('git', ['fetch', '--all', '--prune', '--no-recurse-submodules'], { cwd: repo.root, timeoutMs: 120_000, maxOutputBytes: 1024 * 1024, env: NON_INTERACTIVE_ENV });
    if (result.code !== 0) throw gitError(result, 'fetch');
    return this.refs(project);
  }

  /**
   * Brings the branch up to its upstream when that only moves it forward. A branch that has also
   * gained commits of its own is left alone: merging or rebasing it is a choice, not a button.
   */
  async pull(project: ProjectRef): Promise<{ branch: BranchInfo; status: GitStatus }> {
    const repo = await this.repo(project);
    if (!(await this.branchOf(repo)).upstream) throw new AppError('GIT_NO_UPSTREAM', 'This branch has no upstream to pull from', 409);
    await this.mutate(repo, async () => {
      const result = await runProcess('git', ['pull', '--ff-only', '--no-rebase', '--no-recurse-submodules'], { cwd: repo.root, timeoutMs: 120_000, maxOutputBytes: 1024 * 1024, env: NON_INTERACTIVE_ENV });
      if (result.code === 0) return;
      if (/not possible to fast-forward|diverg/i.test(result.stderr)) throw new AppError('GIT_PULL_DIVERGED', 'This branch and its upstream have each gained commits; merge or rebase to bring them together', 409);
      throw gitError(result, 'pull');
    });
    return { branch: await this.branchOf(repo), status: await this.status(project, true) };
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

  /** The repository's main line as this checkout can name it: the remote's default branch, else a `main` or `master`. Only refs are read. */
  private async baseRef(repo: Repo): Promise<string | undefined> {
    const remoteHead = (await this.git(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { maxOutputBytes: 4096 })).stdout.trim();
    for (const ref of [remoteHead, 'origin/main', 'origin/master', 'main', 'master']) {
      // Asked for as a ref, without peeling it to a commit: that would open the object store, which is the slow part of a large repository.
      if (ref && await this.revision(repo, ref)) return ref;
    }
    return undefined;
  }

  /**
   * Where the checked-out branch left the main line: its merge base with `baseRef`. On the main
   * line itself that is its upstream, so the comparison shows what has not been pushed.
   */
  private async branchBase(repo: Repo): Promise<{ commit: string; ref: string }> {
    const current = (await this.git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { maxOutputBytes: 4096 })).stdout.trim();
    const ref = await this.baseRef(repo);
    if (ref && ref !== current) {
      // A long history without a commit graph can take this a while; it runs only when the comparison is asked for.
      const merged = await this.git(repo, ['merge-base', 'HEAD', ref], { timeoutMs: 120_000, maxOutputBytes: 4096 });
      if (merged.code === 0 && merged.stdout.trim()) return { commit: merged.stdout.trim(), ref };
    }
    throw new AppError('GIT_NO_BASE', 'This branch has no main line to compare with', 422);
  }

  /**
   * What a worktree changed since [base], committed and not: the view an attempt is judged by.
   * Without a base it is what the branch changed since it left the main line (see `branchBase`).
   * Untracked files count as added, since an agent rarely stages what it creates.
   */
  async compare(project: ProjectRef, base?: string): Promise<WorktreeComparison> {
    const repo = await this.repo(project);
    if (base !== undefined && (typeof base !== 'string' || !base || base.length > 255 || base.startsWith('-') || base.includes('\0'))) throw new AppError('INVALID_BASE', 'Comparison base is invalid');
    const branchBase = base === undefined ? await this.branchBase(repo) : undefined;
    const baseCommit = branchBase?.commit ?? await this.revision(repo, `${base}^{commit}`);
    if (!baseCommit) throw new AppError('INVALID_BASE', 'Comparison base does not identify a commit', 422);
    const head = await this.headCommit(repo);
    const count = head ? await this.git(repo, ['rev-list', '--count', `${baseCommit}..${head}`], { timeoutMs: 60_000, maxOutputBytes: 4096 }) : undefined;
    const names = await this.git(repo, ['diff', '--name-status', '-z', '--no-renames', '--no-ext-diff', baseCommit, '--'], { timeoutMs: 120_000, maxOutputBytes: 32 * 1024 * 1024 });
    if (names.code !== 0) throw gitError(names, 'diff');
    const changed = this.changedFiles(repo, names.stdout);
    // Counting lines reads both versions of every changed file: fine for an attempt, minutes for a branch tens of thousands of files from its base.
    const stats = changed.length <= MAX_STAT_FILES
      ? this.numstat((await this.git(repo, ['diff', '--numstat', '-z', '--no-renames', '--no-ext-diff', baseCommit, '--'], { timeoutMs: 60_000, maxOutputBytes: 8 * 1024 * 1024 })).stdout)
      : new Map<string, LineStat>();
    const files: WorktreeComparison['files'] = changed.map(file => ({ path: file.path, status: file.status, ...(stats.get(file.git) ?? {}) }));
    let budget = MAX_COUNTED_UNTRACKED;
    for (const item of (await this.statusRaw(repo, 'listed')).paths) {
      if (item.status !== '??') continue;
      const relative = asRelativePath(repo.root, repo.projectRoot, item.path);
      if (relative === undefined) continue;
      const lines = !item.path.endsWith('/') && budget-- > 0 ? await countLines(path.join(repo.root, item.path)) : undefined;
      files.push({ path: relative, status: '?', ...(lines !== undefined ? { added: lines, removed: 0 } : {}) });
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    return {
      base: baseCommit, ...(branchBase ? { ref: branchBase.ref } : {}), ...(head ? { head } : {}), commits: Number(count?.stdout.trim()) || 0, files: files.slice(0, MAX_CHANGED_FILES),
      ...(files.length > MAX_CHANGED_FILES ? { filesTotal: files.length } : {}),
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
