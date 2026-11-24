import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { BranchInfo, CheckState, GitBranchRef, GitCommit, GitCommitDetail, GitLog, GitRefLabel, GitRefs, GitStatus, PullRequestCheck, PullRequestInfo, PullRequestStatus, PushResult } from '../../../../packages/contracts/src/index.js';
import { AppError, requireString } from '../errors.js';
import type { ProjectRef } from '../workspace/scope.js';
import { runProcess, type ProcessResult } from './exec.js';
import {
  asRelativePath, gitError, headCommit, literalPath, LOG_FORMAT, LOG_PAGE, MAX_CHANGED_FILES,
  MAX_STAT_FILES, MB, NON_INTERACTIVE_ENV, PR_FIELDS, REMOTE_BRANCHES_LISTED, revision,
  type GitHost, type LineStat, type Repo,
} from './shared.js';

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

export async function branchOf(host: GitHost, repo: Repo): Promise<BranchInfo> {
  const symbolic = await host.git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { timeoutMs: 10_000, maxOutputBytes: 4096 });
  if (symbolic.code !== 0 || !symbolic.stdout.trim()) throw new AppError('GIT_DETACHED_HEAD', 'This checkout is not on a branch', 409);
  const branch = symbolic.stdout.trim();
  const remotes = (await host.git(repo, ['remote'], { timeoutMs: 10_000, maxOutputBytes: 64 * 1024 })).stdout.split(/\r?\n/).filter(Boolean);
  const head = await headCommit(host, repo);
  const upstreamName = await host.git(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { timeoutMs: 10_000, maxOutputBytes: 4096 });
  const upstream = upstreamName.code === 0 ? upstreamName.stdout.trim() || undefined : undefined;
  let ahead = 0, behind = 0;
  // Level with its upstream is the usual case, and needs no walk through history to know.
  if (upstream && head && await revision(host, repo, '@{upstream}') !== head) {
    const counts = await host.git(repo, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], { timeoutMs: 60_000, maxOutputBytes: 4096 });
    const [left, right] = counts.stdout.trim().split(/\s+/).map(Number);
    if (counts.code === 0 && Number.isSafeInteger(left) && Number.isSafeInteger(right)) { behind = left; ahead = right; }
  }
  return { branch, ...(head ? { head } : {}), ...(upstream ? { upstream } : {}), ahead, behind, remotes };
}

async function commitHash(host: GitHost, repo: Repo, spec: string): Promise<string> {
  if (typeof spec !== 'string' || !spec || spec.length > 255 || spec.startsWith('-') || spec.includes('\0')) throw new AppError('INVALID_COMMIT', 'Commit reference is invalid');
  const commit = await revision(host, repo, `${spec}^{commit}`);
  if (!commit) throw new AppError('COMMIT_NOT_FOUND', 'That commit is not in this repository', 404);
  return commit;
}

/** The directory a project covers, as a pathspec: history and commits of a project in a subdirectory show only what touched it. */
function scopeArgs(repo: Repo): string[] {
  const scope = path.relative(repo.root, repo.projectRoot).split(path.sep).join('/');
  return scope ? ['--', literalPath(scope)] : [];
}

/**
 * What history is labelled with, by commit: local branches, tags, and the remote branches the
 * local ones track. Read from the refs alone and matched here: asking `git log` to label commits
 * makes it load every ref of the repository, tens of thousands of remote branches included.
 */
async function shownRefs(host: GitHost, repo: Repo): Promise<{ labels: Map<string, GitRefLabel[]>; upstreams: string[] }> {
  const listed = await host.git(repo, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(*objectname)%00%(HEAD)%00%(upstream)', 'refs/heads', 'refs/tags'], { timeoutMs: 30_000, maxOutputBytes: 16 * MB });
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
    const remote = await host.git(repo, ['for-each-ref', '--format=%(refname)%00%(objectname)', ...tracked], { timeoutMs: 30_000, maxOutputBytes: 1 * MB });
    for (const row of remote.code === 0 ? remote.stdout.split('\n') : []) {
      const [ref, hash] = row.split('\0');
      if (ref && hash) add(hash, { kind: 'remote', name: ref.slice(13) });
    }
  }
  const head = onBranch ? undefined : await headCommit(host, repo);
  if (head) add(head, { kind: 'head', name: 'HEAD' });
  return { labels, upstreams: tracked };
}

/** `--name-status -z` output, renames included, as project-relative files; those outside the project are left out. */
export function changedFiles(repo: Repo, output: string): Array<{ path: string; git: string; originalPath?: string; status: string }> {
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
export function numstat(output: string): Map<string, LineStat> {
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

/** The repository's main line as this checkout can name it: the remote's default branch, else a `main` or `master`. Only refs are read. */
export async function baseRef(host: GitHost, repo: Repo): Promise<string | undefined> {
  const remoteHead = (await host.git(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { maxOutputBytes: 4096 })).stdout.trim();
  for (const ref of [remoteHead, 'origin/main', 'origin/master', 'main', 'master']) {
    // Asked for as a ref, without peeling it to a commit: that would open the object store, which is the slow part of a large repository.
    if (ref && await revision(host, repo, ref)) return ref;
  }
  return undefined;
}

/**
 * Where the checked-out branch left the main line: its merge base with `baseRef`. On the main
 * line itself that is its upstream, so the comparison shows what has not been pushed.
 */
export async function branchBase(host: GitHost, repo: Repo): Promise<{ commit: string; ref: string }> {
  const current = (await host.git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { maxOutputBytes: 4096 })).stdout.trim();
  const ref = await baseRef(host, repo);
  if (ref && ref !== current) {
    // A long history without a commit graph can take this a while; it runs only when the comparison is asked for.
    const merged = await host.git(repo, ['merge-base', 'HEAD', ref], { timeoutMs: 120_000, maxOutputBytes: 4096 });
    if (merged.code === 0 && merged.stdout.trim()) return { commit: merged.stdout.trim(), ref };
  }
  throw new AppError('GIT_NO_BASE', 'This branch has no main line to compare with', 422);
}

export async function branchInfo(host: GitHost, project: ProjectRef): Promise<BranchInfo> {
  return branchOf(host, await host.repo(project));
}

/**
 * A page of history, newest first, with each commit's parents so the reader can draw the graph.
 * `all` walks every local branch and what it tracks rather than only what the checkout can reach.
 */
export async function log(host: GitHost, project: ProjectRef, options: { all?: boolean; skip?: number; limit?: number } = {}): Promise<GitLog> {
  const repo = await host.repo(project);
  const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? LOG_PAGE)), 500);
  const skip = Math.min(Math.max(0, Math.trunc(options.skip ?? 0)), 1_000_000);
  if (!(await headCommit(host, repo))) return { commits: [], more: false };
  const shown = await shownRefs(host, repo);
  // Git's own order streams the newest commits without first walking all of history, which a
  // topological order has to; a repository's remote branches can run to tens of thousands, so
  // `all` starts from the local ones and what they track rather than from every ref.
  const result = await host.git(repo, [
    'log', `--format=${LOG_FORMAT}%x1e`, `--max-count=${limit + 1}`, `--skip=${skip}`,
    // An upstream deleted on the remote is still named by its branch; it is skipped rather than failing the walk.
    ...(options.all ? ['--ignore-missing', '--branches', ...shown.upstreams, 'HEAD'] : ['HEAD']), ...scopeArgs(repo),
  ], { timeoutMs: 60_000, maxOutputBytes: 8 * MB });
  if (result.code !== 0 || result.truncated) throw gitError(result, 'log');
  const commits = result.stdout.split('\x1e').map(record => logCommit(record, shown.labels)).filter((item): item is GitCommit => Boolean(item));
  return { commits: commits.slice(0, limit), more: commits.length > limit };
}

/**
 * One commit: its whole message, and the files it changed against its first parent (a merge shows
 * what it brought in). Line counts mean reading every changed file, so they are left out of a
 * commit that touches more than [MAX_STAT_FILES]; past [MAX_CHANGED_FILES] the list itself is cut
 * and `filesTotal` says how long it was.
 */
export async function commitDetail(host: GitHost, project: ProjectRef, spec: string): Promise<GitCommitDetail> {
  const repo = await host.repo(project);
  if (typeof spec !== 'string' || !/^[0-9a-f]{7,64}$/i.test(spec)) throw new AppError('INVALID_COMMIT', 'Commit reference is invalid');
  const tree = ['diff-tree', '--root', '-r', '--no-commit-id', '-m', '--first-parent', '--no-ext-diff', '-z'];
  const [shown, names] = await Promise.all([
    // The commit object itself: `show` works out a merge's combined diff even when told to print none of it.
    host.git(repo, ['cat-file', 'commit', spec], { timeoutMs: 30_000, maxOutputBytes: 1 * MB }),
    host.git(repo, [...tree, '--no-renames', '--name-status', spec, ...scopeArgs(repo)], { timeoutMs: 60_000, maxOutputBytes: 32 * MB }),
  ]);
  if (shown.code !== 0 || !shown.stdout.trim()) throw new AppError('COMMIT_NOT_FOUND', 'That commit is not in this repository', 404);
  if (names.code !== 0) throw gitError(names, 'diff-tree');
  const commit = rawCommit(spec, shown.stdout);
  let changed = changedFiles(repo, names.stdout);
  let stats = new Map<string, LineStat>();
  // Renames and line counts both read file contents, so they are worked out only for a commit of ordinary width.
  if (changed.length <= MAX_STAT_FILES) {
    const [renamed, numbers] = await Promise.all([
      host.git(repo, [...tree, '-M', '--name-status', spec, ...scopeArgs(repo)], { timeoutMs: 60_000, maxOutputBytes: 8 * MB }),
      host.git(repo, [...tree, '-M', '--numstat', spec, ...scopeArgs(repo)], { timeoutMs: 60_000, maxOutputBytes: 8 * MB }),
    ]);
    if (renamed.code === 0 && numbers.code === 0) { changed = changedFiles(repo, renamed.stdout); stats = numstat(numbers.stdout); }
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
export async function refs(host: GitHost, project: ProjectRef, options: { query?: string } = {}): Promise<GitRefs> {
  const repo = await host.repo(project);
  const [heads, others] = await Promise.all([
    host.git(repo, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(upstream:short)%00%(HEAD)%00%(worktreepath)', 'refs/heads'], { timeoutMs: 30_000, maxOutputBytes: 8 * MB }),
    host.git(repo, ['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/remotes', 'refs/tags'], { timeoutMs: 30_000, maxOutputBytes: 32 * MB }),
  ]);
  if (heads.code !== 0 || heads.truncated) throw gitError(heads, 'for-each-ref');
  if (others.code !== 0 || others.truncated) throw gitError(others, 'for-each-ref');
  const result: GitRefs = { branches: [], remotes: [], remoteCount: 0, tags: [] };
  for (const row of heads.stdout.split('\n')) {
    const [ref, hash, upstream, head, worktree] = row.split('\0');
    if (!ref || !hash) continue;
    const branch: GitBranchRef = { name: ref.slice(11), hash, ...(upstream ? { upstream } : {}) };
    if (head === '*') { branch.current = true; result.head = branch.name; }
    else if (worktree) branch.elsewhere = true;
    result.branches.push(branch);
  }
  result.branches.sort((a, b) => Number(Boolean(b.current)) - Number(Boolean(a.current)));
  const local = new Set(result.branches.map(branch => branch.name));
  const query = options.query?.trim().toLowerCase();
  for (const row of others.stdout.split('\n')) {
    const [ref, hash] = row.split('\0');
    if (!ref || !hash) continue;
    if (ref.startsWith('refs/tags/')) { if (result.tags.length < 500) result.tags.push({ name: ref.slice(10), hash }); continue; }
    const name = ref.slice(13);
    if (ref.endsWith('/HEAD') || local.has(name.slice(name.indexOf('/') + 1)) || (query && !name.toLowerCase().includes(query))) continue;
    result.remoteCount += 1;
    if (result.remotes.length < REMOTE_BRANCHES_LISTED) result.remotes.push({ name, hash });
  }
  return result;
}

/**
 * Checks out a branch: an existing local one, a new one (`create`, from `base` or the current
 * commit), or a remote one (`remote`, as in `origin/topic`), which gets a local branch tracking it.
 * Uncommitted changes travel along when they fit; when they would be overwritten Git refuses and
 * nothing changes.
 */
export async function switchBranch(host: GitHost, project: ProjectRef, input: { branch?: string; create?: boolean; base?: string; remote?: string }): Promise<GitRefs> {
  const repo = await host.repo(project);
  await host.mutate(repo, async () => {
    let args: string[];
    if (input.remote !== undefined) {
      const remote = requireString(input.remote, 'remote', 255);
      if (!(await revision(host, repo, `refs/remotes/${remote}`))) throw new AppError('INVALID_BRANCH', 'That remote branch does not exist', 404);
      const local = remote.slice(remote.indexOf('/') + 1);
      args = await revision(host, repo, `refs/heads/${local}`) ? ['switch', local] : ['switch', '--track', remote];
    } else {
      const branch = requireString(input.branch, 'branch', 255);
      const valid = await host.git(repo, ['check-ref-format', '--branch', branch], { maxOutputBytes: 4096 });
      if (valid.code !== 0) throw new AppError('INVALID_BRANCH', 'Branch name is invalid');
      if (input.create) {
        const base = input.base?.trim() ? await commitHash(host, repo, input.base.trim()) : undefined;
        args = ['switch', '--create', branch, ...(base ? [base] : [])];
      } else {
        if (!(await revision(host, repo, `refs/heads/${branch}`))) throw new AppError('INVALID_BRANCH', 'That branch does not exist', 404);
        args = ['switch', branch];
      }
    }
    const result = await host.git(repo, args, { timeoutMs: 120_000, maxOutputBytes: 1 * MB });
    if (result.code !== 0) {
      if (/would be overwritten by checkout/i.test(result.stderr)) throw new AppError('GIT_SWITCH_BLOCKED', 'Uncommitted changes would be overwritten by switching; commit or discard them first', 409);
      throw gitError(result, 'switch');
    }
  });
  return refs(host, project);
}

/** Brings every remote's branches up to date and drops the ones deleted there. Nothing in the checkout changes. */
export async function fetch(host: GitHost, project: ProjectRef): Promise<GitRefs> {
  const repo = await host.repo(project);
  const result = await runProcess('git', ['fetch', '--all', '--prune', '--no-recurse-submodules'], { cwd: repo.root, timeoutMs: 120_000, maxOutputBytes: 1 * MB, env: NON_INTERACTIVE_ENV });
  if (result.code !== 0) throw gitError(result, 'fetch');
  return refs(host, project);
}

/**
 * Brings the branch up to its upstream when that only moves it forward. A branch that has also
 * gained commits of its own is left alone: merging or rebasing it is a choice, not a button.
 */
export async function pull(host: GitHost, project: ProjectRef): Promise<{ branch: BranchInfo; status: GitStatus }> {
  const repo = await host.repo(project);
  if (!(await branchOf(host, repo)).upstream) throw new AppError('GIT_NO_UPSTREAM', 'This branch has no upstream to pull from', 409);
  await host.mutate(repo, async () => {
    const result = await runProcess('git', ['pull', '--ff-only', '--no-rebase', '--no-recurse-submodules'], { cwd: repo.root, timeoutMs: 120_000, maxOutputBytes: 1 * MB, env: NON_INTERACTIVE_ENV });
    if (result.code === 0) return;
    if (/not possible to fast-forward|diverg/i.test(result.stderr)) throw new AppError('GIT_PULL_DIVERGED', 'This branch and its upstream have each gained commits; merge or rebase to bring them together', 409);
    throw gitError(result, 'pull');
  });
  return { branch: await branchOf(host, repo), status: await host.status(project, true) };
}

/**
 * Publishes the current branch. A first push sets the upstream, to the only remote or `origin`.
 * Never forced: rewriting a shared branch is a decision to make in a terminal, not from a button.
 */
export async function push(host: GitHost, project: ProjectRef, options: { remote?: string } = {}): Promise<PushResult> {
  const repo = await host.repo(project);
  const before = await branchOf(host, repo);
  if (!before.head) throw new AppError('GIT_NOTHING_TO_PUSH', 'This branch has no commits yet', 409);
  let remote = options.remote;
  let destination = `refs/heads/${before.branch}`;
  if (before.upstream && !remote) {
    const upstream = await host.git(repo, ['for-each-ref', '--format=%(upstream:remotename)%00%(upstream:remoteref)', `refs/heads/${before.branch}`], { maxOutputBytes: 4096 });
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
  const result = await runProcess('git', args, { cwd: repo.root, timeoutMs: 120_000, maxOutputBytes: 1 * MB, env: NON_INTERACTIVE_ENV });
  if (result.code !== 0) throw gitError(result, 'push');
  return { branch: await branchOf(host, repo), output: `${result.stdout}${result.stderr}`.trim().slice(0, 4000) };
}

function gh(repo: Repo, args: string[], timeoutMs = 60_000): Promise<ProcessResult> {
  return runProcess('gh', args, { cwd: repo.root, timeoutMs, maxOutputBytes: 4 * MB, env: NON_INTERACTIVE_ENV });
}

/** The branch's pull request and its checks, through the GitHub CLI and whatever account it is signed in to. */
export async function pullRequest(host: GitHost, project: ProjectRef): Promise<PullRequestStatus> {
  const repo = await host.repo(project);
  const branch = await branchOf(host, repo);
  const result = await gh(repo, ['pr', 'view', branch.branch, '--json', PR_FIELDS]);
  if (result.code !== 0) {
    if (/no (open )?pull requests? found/i.test(result.stderr)) return { branch, pullRequest: null };
    throw ghError(result, 'pr view');
  }
  try { return { branch, pullRequest: pullRequestInfo(JSON.parse(result.stdout) as Record<string, unknown>) }; }
  catch { throw new AppError('GH_OPERATION_FAILED', 'GitHub CLI returned an unreadable pull request', 502); }
}

/** Pushes first when the remote is behind, since a pull request can only show what was pushed. */
export async function createPullRequest(host: GitHost, project: ProjectRef, options: { title?: string; body?: string; base?: string; draft?: boolean; remote?: string } = {}): Promise<PullRequestStatus> {
  if (options.base && (options.base.length > 255 || options.base.startsWith('-') || /[\0\s]/.test(options.base))) throw new AppError('INVALID_BASE', 'Pull request base is invalid');
  const repo = await host.repo(project);
  const branch = await branchOf(host, repo);
  if (options.remote || !branch.upstream || branch.ahead > 0) await push(host, project, options.remote ? { remote: options.remote } : {});
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
  const created = await gh(repo, args, 120_000);
  if (created.code !== 0) throw ghError(created, 'pr create');
  return pullRequest(host, project);
}
