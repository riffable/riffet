import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MergeResult, WorktreeComparison, WorktreeInfo } from '../../../../packages/contracts/src/index.js';
import { AppError, requireString } from '../errors.js';
import { isWithin, projectRoot, type ProjectRef } from '../workspace/scope.js';
import { branchBase, branchOf, changedFiles, numstat } from './branches.js';
import { atomicWorktreeImage, checkpointPath, readManifest, setIndexImage } from './checkpoints.js';
import { runProcess } from './exec.js';
import {
  asRelativePath, countLines, GIT_ENV, gitError, hash, headCommit, literalPath,
  MAX_CHANGED_FILES, MAX_COUNTED_UNTRACKED, MAX_SHADOW_BYTES, MAX_SHADOW_FILES, MAX_STAT_FILES,
  MB, projectId, revision, SHADOW_EXCLUDES, type GitHost, type LineStat, type Repo,
} from './shared.js';

function shadowDir(host: GitHost, id: string): string {
  return path.join(host.stateDir, 'shadow-repos', `${hash(id).slice(0, 24)}.git`);
}

/**
 * A directory outside any repository can still be split into worktrees through a private, bare
 * repository kept under the state directory, with the directory as its work tree. Nothing is
 * written into the directory itself: no `.git`, and its own Git tooling keeps seeing no repository.
 * Only worktree operations (attempts, their comparison, adoption and cleanup) reach it; status, the
 * changes panel and checkpoints still report the directory as not a repository.
 */
async function shadowRepo(host: GitHost, project: ProjectRef, create: boolean): Promise<Repo | undefined> {
  const root = await projectRoot(project);
  const id = projectId(project, root);
  const gitDir = shadowDir(host, id);
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
    if (isWithin(root, host.stateDir)) excludes.push(`/${path.relative(root, host.stateDir).split(path.sep).join('/')}/`);
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
async function worktreeRepo(host: GitHost, project: ProjectRef, shadow = false): Promise<Repo> {
  try { return await host.repo(project); }
  catch (error) {
    if (!shadow || !(error instanceof AppError) || error.code !== 'NOT_A_GIT_REPOSITORY') throw error;
    const found = await shadowRepo(host, project, false);
    if (!found) throw error;
    return found;
  }
}

/**
 * Commits the directory as it is now onto the shadow repository's `main`, and returns that commit;
 * an unchanged directory keeps the commit it has, so merging into it can still fast-forward.
 */
async function snapshot(host: GitHost, repo: Repo): Promise<string> {
  const listed = await host.git(repo, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { timeoutMs: 60_000, maxOutputBytes: 16 * MB });
  if (listed.code !== 0) throw gitError(listed, 'list directory');
  const files = listed.stdout.split('\0').filter(Boolean);
  const tooLarge = () => new AppError('DIRECTORY_TOO_LARGE', `This directory has more than ${MAX_SHADOW_FILES} files or ${MAX_SHADOW_BYTES / MB} MB outside .gitignore; add a .gitignore or make it a Git repository first`, 413, { files: MAX_SHADOW_FILES, bytes: MAX_SHADOW_BYTES });
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
  const staged = await host.git(repo, ['add', '--all'], { timeoutMs: 120_000, maxOutputBytes: 1 * MB });
  if (staged.code !== 0) throw gitError(staged, 'add');
  const previous = await headCommit(host, repo);
  if (previous && (await host.git(repo, ['diff', '--cached', '--quiet'], { timeoutMs: 60_000, maxOutputBytes: 4096 })).code === 0) return previous;
  const committed = await host.git(repo, ['commit', '--quiet', '--no-verify', ...(previous ? [] : ['--allow-empty']), '--message', 'Snapshot'], { timeoutMs: 120_000, maxOutputBytes: 1 * MB });
  if (committed.code !== 0) throw gitError(committed, 'commit snapshot');
  const head = await headCommit(host, repo);
  if (!head) throw new AppError('GIT_OPERATION_FAILED', 'The directory snapshot could not be read back', 500);
  return head;
}

/**
 * Where a set of worktrees starts: the commit [spec] names, and whether the project has changes
 * that commit leaves out. A directory outside any repository is snapshotted as it is, so its
 * attempts start from exactly what is on disk and leave nothing out.
 */
export async function worktreeBase(host: GitHost, project: ProjectRef, spec = 'HEAD'): Promise<{ commit?: string; uncommitted: boolean }> {
  if (!spec || spec.length > 255 || spec.startsWith('-') || spec.includes('\0')) throw new AppError('INVALID_BASE', 'Commit reference is invalid');
  let repo: Repo;
  try { repo = await host.repo(project); }
  catch (error) {
    if (!(error instanceof AppError) || error.code !== 'NOT_A_GIT_REPOSITORY') throw error;
    if (spec !== 'HEAD') throw new AppError('INVALID_BASE', 'A directory outside Git can only start from what is on disk', 422);
    const shadow = (await shadowRepo(host, project, true))!;
    return { commit: await host.mutate(shadow, () => snapshot(host, shadow)), uncommitted: false };
  }
  const commit = await revision(host, repo, `${spec}^{commit}`);
  return { ...(commit ? { commit } : {}), uncommitted: (await host.statusRaw(repo)).paths.some(item => asRelativePath(repo.root, repo.projectRoot, item.path) !== undefined) };
}

async function listWorktrees(host: GitHost, repo: Repo): Promise<WorktreeInfo[]> {
  const result = await host.git(repo, ['worktree', 'list', '--porcelain', '-z'], { maxOutputBytes: 4 * MB });
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

export async function worktrees(host: GitHost, project: ProjectRef): Promise<WorktreeInfo[]> {
  return listWorktrees(host, await host.repo(project));
}

/** [options.shadow]: an attempt, which may cut from a directory's shadow repository (see `worktreeRepo`). */
export async function createWorktree(host: GitHost, project: ProjectRef, input: { branch: string; path?: string; base?: string }, options: { shadow?: boolean } = {}): Promise<WorktreeInfo> {
  const branch = requireString(input?.branch, 'branch', 255);
  const repo = await worktreeRepo(host, project, options.shadow);
  return host.mutate(repo, async () => {
    // An unclean source is not an obstacle: git builds the new tree from a commit, so uncommitted
    // work simply stays where it is. Refusing here made the common reason to want a worktree —
    // starting something separate without disturbing what is already in progress — impossible.
    const checkBranch = await host.git(repo, ['check-ref-format', '--branch', branch], { maxOutputBytes: 4096 });
    if (checkBranch.code !== 0) throw new AppError('INVALID_BRANCH', 'Branch name is invalid');
    const base = input.base?.trim();
    let target: string;
    if (input.path) {
      target = path.resolve(repo.projectRoot, input.path);
      if (target === repo.root || target === repo.projectRoot) throw new AppError('INVALID_WORKTREE_PATH', 'Worktree path cannot be the source project');
    } else {
      // Keep Unicode names distinct while replacing characters that cannot be used on all hosts.
      target = path.join(host.stateDir, 'worktrees', hash(repo.projectId).slice(0, 24), branch.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-'));
    }
    try { await lstat(target); throw new AppError('WORKTREE_PATH_EXISTS', 'Worktree destination already exists', 409); }
    catch (error) { if (error instanceof AppError) throw error; if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const args = ['worktree', 'add', '-f', '-b', branch, target]; // -f: a tree deleted behind git's back stays registered, and `add` would refuse its path
    if (base) {
      if (base.length > 255 || base.startsWith('-') || base.includes('\0')) throw new AppError('INVALID_BASE', 'Worktree base is invalid');
      const verified = await host.git(repo, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`], { maxOutputBytes: 4096 });
      if (verified.code !== 0) throw new AppError('INVALID_BASE', 'Worktree base does not identify a commit');
      args.push(verified.stdout.trim());
    }
    const result = await host.git(repo, args, { timeoutMs: 120_000, maxOutputBytes: 2 * MB });
    if (result.code !== 0) throw gitError(result, 'worktree add');
    const canonicalTarget = await realpath(target);
    const created = (await listWorktrees(host, repo)).find(item => path.resolve(item.path) === canonicalTarget || path.resolve(item.path) === path.resolve(target));
    if (!created) throw new AppError('WORKTREE_CREATE_FAILED', 'Git created the worktree but it could not be listed', 500, { path: target });
    return created;
  });
}

/**
 * Force-removes a freshly created worktree (even if dirty from a restored checkpoint) and deletes
 * its newly created branch, used only when rolling back an aborted fork/attempt before launch.
 */
export async function discardWorktree(host: GitHost, project: ProjectRef, worktreePath: string, branch?: string): Promise<void> {
  const repo = await host.repo(project);
  return host.mutate(repo, async () => {
    await host.git(repo, ['worktree', 'remove', '--force', '--', worktreePath], { timeoutMs: 30_000, maxOutputBytes: 256 * 1024 }).catch(() => undefined);
    await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
    if (branch && !branch.startsWith('-')) {
      await host.git(repo, ['branch', '-D', '--', branch], { timeoutMs: 15_000, maxOutputBytes: 64 * 1024 }).catch(() => undefined);
    }
  });
}

/**
 * Creates a worktree starting at a turn checkpoint's exact commit and file state (worktree + index).
 * Returns `undefined` when the checkpoint is partial, has excluded paths, or its commit is gone,
 * allowing the caller to fall back to `HEAD`.
 */
export async function createWorktreeFromCheckpoint(host: GitHost, project: ProjectRef, input: { branch: string; checkpointId: string }): Promise<WorktreeInfo | undefined> {
  const originRepo = await host.repo(project);
  const manifest = await readManifest(host, originRepo, input.checkpointId).catch(() => undefined);
  if (!manifest || manifest.checkpoint.partial || manifest.checkpoint.excluded.length || !manifest.head) return undefined;
  const verified = await revision(host, originRepo, `${manifest.head}^{commit}`);
  if (!verified) return undefined;
  const created = await createWorktree(host, project, { branch: input.branch, base: verified });
  if (!manifest.files.length) return created;
  const originSubpath = path.relative(originRepo.root, originRepo.projectRoot);
  const canonicalRoot = await realpath(created.path);
  const targetProjectRoot = originSubpath ? path.join(canonicalRoot, originSubpath) : canonicalRoot;
  const targetRepo: Repo = {
    root: canonicalRoot,
    projectRoot: await realpath(targetProjectRoot).catch(() => targetProjectRoot),
    projectId: originRepo.projectId,
  };
  const folder = checkpointPath(host, originRepo, manifest.checkpoint.id);
  try {
    for (const file of manifest.files) {
      await atomicWorktreeImage(targetRepo, file.path, file.worktree, folder);
      await setIndexImage(host, targetRepo, file.path, file.index, folder);
    }
    return created;
  } catch (error) {
    await discardWorktree(host, project, created.path, created.branch ?? input.branch).catch(() => undefined);
    throw error;
  }
}

export async function removeWorktree(host: GitHost, project: ProjectRef, worktreePath: string, options: { shadow?: boolean } = {}): Promise<void> {
  const repo = await worktreeRepo(host, project, options.shadow);
  return host.mutate(repo, async () => {
    if (typeof worktreePath !== 'string' || !worktreePath.trim()) throw new AppError('INVALID_WORKTREE_PATH', 'Worktree path is required');
    const records = await listWorktrees(host, repo);
    let requestedPath: string;
    try { requestedPath = await realpath(path.resolve(worktreePath)); }
    catch { throw new AppError('WORKTREE_NOT_FOUND', 'Worktree path is unavailable', 404); }
    let target: WorktreeInfo | undefined;
    for (const record of records) {
      try { if (await realpath(record.path) === requestedPath) { target = record; break; } }
      catch { /* Prunable worktrees are not candidates for filesystem removal. */ }
    }
    if (!target) throw new AppError('WORKTREE_NOT_FOUND', 'Path is not a registered worktree', 404);
    const commonDirResult = await host.git(repo, ['rev-parse', '--git-common-dir'], { maxOutputBytes: 4096 });
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
    const dirty = await runProcess('git', ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], { cwd: target.path, maxOutputBytes: 16 * MB, timeoutMs: 60_000, env: GIT_ENV });
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
      if (refs.length > 5000 || refs.some(ref => !ref.startsWith('refs/') || ref.length > 4096 || /[\0\r\n]/.test(ref))) throw new AppError('WORKTREE_REFS_UNSAFE', 'Could not verify worktree refs safely; nothing was removed', 409);
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
    const result = await host.git(repo, ['worktree', 'remove', '--', target.path], { timeoutMs: 120_000, maxOutputBytes: 2 * MB });
    if (result.code !== 0) throw gitError(result, 'worktree remove');
  });
}

/**
 * What a worktree changed since [base], committed and not: the view an attempt is judged by.
 * Without a base it is what the branch changed since it left the main line (see `branchBase`).
 * Untracked files count as added, since an agent rarely stages what it creates.
 */
export async function compare(host: GitHost, project: ProjectRef, base?: string): Promise<WorktreeComparison> {
  const repo = await host.repo(project);
  if (base !== undefined && (typeof base !== 'string' || !base || base.length > 255 || base.startsWith('-') || base.includes('\0'))) throw new AppError('INVALID_BASE', 'Comparison base is invalid');
  const branch = base === undefined ? await branchBase(host, repo) : undefined;
  const baseCommit = branch?.commit ?? await revision(host, repo, `${base}^{commit}`);
  if (!baseCommit) throw new AppError('INVALID_BASE', 'Comparison base does not identify a commit', 422);
  const head = await headCommit(host, repo);
  const count = head ? await host.git(repo, ['rev-list', '--count', `${baseCommit}..${head}`], { timeoutMs: 60_000, maxOutputBytes: 4096 }) : undefined;
  const names = await host.git(repo, ['diff', '--name-status', '-z', '--no-renames', '--no-ext-diff', baseCommit, '--'], { timeoutMs: 120_000, maxOutputBytes: 32 * MB });
  if (names.code !== 0) throw gitError(names, 'diff');
  const changed = changedFiles(repo, names.stdout);
  // Counting lines reads both versions of every changed file: fine for an attempt, minutes for a branch tens of thousands of files from its base.
  const stats = changed.length <= MAX_STAT_FILES
    ? numstat((await host.git(repo, ['diff', '--numstat', '-z', '--no-renames', '--no-ext-diff', baseCommit, '--'], { timeoutMs: 60_000, maxOutputBytes: 8 * MB })).stdout)
    : new Map<string, LineStat>();
  const files: WorktreeComparison['files'] = changed.map(file => ({ path: file.path, status: file.status, ...(stats.get(file.git) ?? {}) }));
  let budget = MAX_COUNTED_UNTRACKED;
  for (const item of (await host.statusRaw(repo, 'listed')).paths) {
    if (item.status !== '??') continue;
    const relative = asRelativePath(repo.root, repo.projectRoot, item.path);
    if (relative === undefined) continue;
    const lines = !item.path.endsWith('/') && budget-- > 0 ? await countLines(path.join(repo.root, item.path)) : undefined;
    files.push({ path: relative, status: '?', ...(lines !== undefined ? { added: lines, removed: 0 } : {}) });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    base: baseCommit, ...(branch ? { ref: branch.ref } : {}), ...(head ? { head } : {}), commits: Number(count?.stdout.trim()) || 0, files: files.slice(0, MAX_CHANGED_FILES),
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
export async function mergeWorktree(host: GitHost, origin: ProjectRef, worktree: ProjectRef, options: { strategy?: 'merge' | 'squash'; message?: string; commitPending?: string; removeWorktree?: boolean; shadow?: boolean } = {}): Promise<MergeResult> {
  const strategy = options.strategy ?? 'merge';
  if (strategy !== 'merge' && strategy !== 'squash') throw new AppError('INVALID_MERGE_STRATEGY', 'Choose merge or squash');
  const target = await worktreeRepo(host, origin, options.shadow);
  const source = await host.repo(worktree);
  const [targetCommon, sourceCommon] = await Promise.all([target, source].map(async repo => {
    const found = await host.git(repo, ['rev-parse', '--git-common-dir'], { timeoutMs: 10_000, maxOutputBytes: 4096 });
    return found.code === 0 ? realpath(path.resolve(repo.root, found.stdout.trim())).catch(() => undefined) : undefined;
  }));
  if (!targetCommon || targetCommon !== sourceCommon || target.root === source.root) throw new AppError('WORKTREE_NOT_FOUND', 'These projects are not worktrees of the same repository', 422);
  if (host.repositoryMutations.has(targetCommon)) throw new AppError('MERGE_IN_PROGRESS', 'Another worktree merge is already running in this repository', 409);
  host.repositoryMutations.add(targetCommon);
  try {
    for (const repo of [target, source]) {
      const gitDir = await host.git(repo, ['rev-parse', '--absolute-git-dir'], { maxOutputBytes: 4096 });
      if (gitDir.code !== 0 || gitDir.truncated || !gitDir.stdout.trim()) throw gitError(gitDir, 'inspect worktree state');
      for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
        try {
          await lstat(path.join(gitDir.stdout.trim(), marker));
          throw new AppError('GIT_OPERATION_IN_PROGRESS', 'Finish or abort the existing Git operation before merging worktrees', 409, { path: repo.root, operation: marker });
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    }
    const into = (await branchOf(host, target)).branch;
    const branch = (await branchOf(host, source)).branch;
    // A shadow repository's directory is edited outside Git: what is on disk now becomes the
    // target, so the merge weighs the attempt against it rather than against the starting point.
    if (target.shadow) await snapshot(host, target);
    const tracked = await host.git(target, ['status', '--porcelain=v1', '-z', '--untracked-files=no'], { maxOutputBytes: 1 * MB });
    if (tracked.code !== 0) throw gitError(tracked, 'status');
    if (tracked.stdout) throw new AppError('MERGE_TARGET_DIRTY', `Commit or stash the changes on ${into} before merging into it`, 409, { into });
    const sourceStatus = await host.statusRaw(source);
    if (sourceStatus.paths.length) {
      if (!options.commitPending) throw new AppError('WORKTREE_DIRTY', 'The worktree has uncommitted changes; commit them or pass a commit message', 409, { branch });
      requireString(options.commitPending, 'commitPending', 5_000);
      if (sourceStatus.paths.some(item => asRelativePath(source.root, source.projectRoot, item.path) === undefined || (item.originalPath && asRelativePath(source.root, source.projectRoot, item.originalPath) === undefined))) {
        throw new AppError('WORKTREE_DIRTY_OUTSIDE_PROJECT', 'The worktree has changes outside this project; commit them separately before merging', 409);
      }
      const scope = path.relative(source.root, source.projectRoot).split(path.sep).join('/') || '.';
      const staged = await host.git(source, ['add', '--all', '--', literalPath(scope)], { timeoutMs: 60_000, maxOutputBytes: 1 * MB });
      if (staged.code !== 0) throw gitError(staged, 'add');
      const committed = await host.git(source, ['commit', '--message', options.commitPending], { timeoutMs: 120_000, maxOutputBytes: 2 * MB });
      if (committed.code !== 0) throw gitError(committed, 'commit');
    }
    const sourceHead = await headCommit(host, source);
    const targetHead = await headCommit(host, target);
    const counted = sourceHead ? await host.git(target, ['rev-list', '--count', targetHead ? `${targetHead}..${sourceHead}` : sourceHead], { maxOutputBytes: 4096 }) : undefined;
    if (counted && counted.code !== 0) throw gitError(counted, 'count worktree commits');
    const commits = Number(counted?.stdout.trim()) || 0;
    if (!sourceHead || !commits) {
      const head = await headCommit(host, target);
      return { merged: false, strategy, branch, into, ...(head ? { head } : {}), commits: 0 };
    }
    // A file the branch adds that the target already has on disk, untracked or ignored, has no copy
    // anywhere: a three-way merge writes over an ignored one regardless of --no-overwrite-ignore, and
    // `reset --merge` after a conflict would then delete it. Such a merge is refused up front.
    if (targetHead) {
      const added = await host.git(target, ['diff', '--name-only', '-z', '--no-renames', '--diff-filter=A', targetHead, sourceHead], { timeoutMs: 15_000, maxOutputBytes: 8 * MB });
      if (added.code !== 0 || added.truncated) throw gitError(added, 'diff');
      const occupied: string[] = [];
      for (const file of added.stdout.split('\0').filter(Boolean)) {
        if (await lstat(path.join(target.root, file)).then(() => true, () => false)) occupied.push(file);
      }
      if (occupied.length) throw new AppError('MERGE_CONFLICT', `${branch} would overwrite files in ${into} that Git does not track; nothing was merged`, 409, { branch, into, paths: occupied });
    }
    const message = options.message?.trim().slice(0, 5_000) || `Merge ${branch} into ${into}`;
    const merge = strategy === 'squash'
      ? await host.git(target, ['merge', '--squash', '--no-overwrite-ignore', sourceHead], { timeoutMs: 120_000, maxOutputBytes: 2 * MB })
      : await host.git(target, ['merge', '--no-edit', '--no-overwrite-ignore', '--message', message, sourceHead], { timeoutMs: 120_000, maxOutputBytes: 2 * MB });
    if (merge.code !== 0) {
      const conflicts = await host.git(target, ['diff', '--name-only', '--diff-filter=U', '-z'], { maxOutputBytes: 1 * MB });
      const paths = conflicts.stdout.split('\0').filter(Boolean);
      const recovery = await host.git(target, ['reset', '--merge', ...(targetHead ? [targetHead] : [])], { timeoutMs: 60_000, maxOutputBytes: 1 * MB });
      if (recovery.code !== 0) throw new AppError('MERGE_RECOVERY_FAILED', 'The merge failed and Git could not restore the target; resolve the worktree before retrying', 409, { branch, into, paths, output: recovery.stderr.slice(0, 2000) });
      if (paths.length) throw new AppError('MERGE_CONFLICT', `${branch} conflicts with ${into}; nothing was merged`, 409, { branch, into, paths });
      throw gitError(merge, 'merge');
    }
    if (strategy === 'squash') {
      const committed = await host.git(target, ['commit', '--message', message], { timeoutMs: 120_000, maxOutputBytes: 2 * MB });
      if (committed.code !== 0) {
        const recovery = await host.git(target, ['reset', '--merge', ...(targetHead ? [targetHead] : [])], { timeoutMs: 60_000, maxOutputBytes: 1 * MB });
        if (recovery.code !== 0) throw new AppError('MERGE_RECOVERY_FAILED', 'The squash commit failed and Git could not restore the target; resolve the worktree before retrying', 409, { branch, into, output: recovery.stderr.slice(0, 2000) });
        throw gitError(committed, 'commit');
      }
    }
    let removedWorktree = false;
    // The branch itself is kept: after a squash it is the only record of the individual commits.
    if (options.removeWorktree) removedWorktree = (await host.git(target, ['worktree', 'remove', '--', source.root], { timeoutMs: 120_000, maxOutputBytes: 1 * MB })).code === 0;
    const head = await headCommit(host, target);
    return { merged: true, strategy, branch, into, ...(head ? { head } : {}), commits, ...(options.removeWorktree ? { removedWorktree } : {}) };
  } finally { host.repositoryMutations.delete(targetCommon); }
}
