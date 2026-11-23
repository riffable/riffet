import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { AppError } from '../errors.js';
import { NativeDispatcher } from '../native/dispatch.js';
import type { RouteDeps } from '../routes/deps.js';
import { registerGitRoutes } from '../routes/git.js';
import { Store } from '../store.js';
import { GitService } from './index.js';
import type { WorktreeInfo } from '../../../../packages/contracts/src/index.js';

const exec = promisify(execFile);
const temporary: string[] = [];
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();
}
/** A turn's start, a moment after the files a test wrote before it (see `changedSince`). */
async function turnStart(): Promise<number> {
  await new Promise(resolve => setTimeout(resolve, 150));
  return Date.now();
}

async function repository() {
  const folder = await mkdtemp(path.join(tmpdir(), 'riffet-git-'));
  temporary.push(folder);
  const root = path.join(folder, 'main');
  await mkdir(root);
  await git(root, 'init', '-b', 'main');
  await git(root, 'config', 'user.email', 'test@example.invalid');
  await git(root, 'config', 'user.name', 'Riffet Test');
  await git(root, 'config', 'commit.gpgSign', 'false');
  await git(root, 'config', 'core.hooksPath', path.join(folder, 'no-hooks'));
  await writeFile(path.join(root, 'file.txt'), 'base\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'initial');
  const source = path.join(folder, 'source');
  await git(root, 'worktree', 'add', '-b', 'attempt', source);
  return { folder, root, source, service: new GitService({ stateDir: path.join(folder, 'state') }) };
}
async function change(root: string, text: string) {
  await writeFile(path.join(root, 'file.txt'), text);
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', text.trim());
}
afterEach(async () => { await Promise.all(temporary.splice(0).map(folder => rm(folder, { recursive: true, force: true }))); });

it('lists real checkouts with Riffet provenance and notifies other clients when worktrees change', async () => {
  const { folder, root, source, service } = await repository();
  const store = new Store(':memory:');
  const app = Fastify();
  try {
    const origin = store.createProject(await realpath(root), 'main');
    // Registered external checkouts count as Riffet projects; a branch prefix alone does not.
    const associated = store.createProject(await realpath(source), 'associated', { originProjectId: origin.id, branch: 'attempt' });
    store.updateProject(associated.id, { createdAt: '2020-01-01T00:00:00.000Z' });
    const external = path.join(folder, 'external');
    await git(root, 'worktree', 'add', '-b', 'riffet/external', external);
    registerGitRoutes(app, { store, git: service } as unknown as RouteDeps);
    const changed = vi.fn();
    store.onListsChanged(changed);
    const before = store.getProject(origin.id).updatedAt;
    const projectRevision = store.projectRevision;
    const created = await app.inject({ method: 'POST', url: `/api/projects/${origin.id}/worktrees`, payload: { branch: 'feature/renamed' } });
    expect(created.statusCode).toBe(200);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(store.getProject(origin.id).updatedAt).not.toBe(before);
    expect(store.projectRevision).toBeGreaterThan(projectRevision);
    const createdPath = created.json<WorktreeInfo>().path;
    const response = await app.inject({ method: 'GET', url: `/api/projects/${origin.id}/worktrees` });
    expect(response.statusCode).toBe(200);
    const records = response.json<WorktreeInfo[]>();
    expect(records.map(item => item.branch)).toEqual(['main', 'feature/renamed', 'attempt', 'riffet/external']);
    expect(records.filter(item => item.current).map(item => item.branch)).toEqual(['main']);
    expect(records.filter(item => item.managed && !item.current).map(item => item.branch)).toEqual(['feature/renamed', 'attempt']);

    // Resolve the current checkout at its repository root, even through a symlink and a subdirectory.
    const nested = path.join(source, 'nested');
    await mkdir(nested);
    const alias = path.join(folder, 'alias');
    if (process.platform !== 'win32') await symlink(nested, alias);
    const subproject = store.createProject(process.platform === 'win32' ? nested : alias, 'nested');
    const fromNested = await app.inject({ method: 'GET', url: `/api/projects/${subproject.id}/worktrees` });
    expect(fromNested.json<WorktreeInfo[]>()[0]).toMatchObject({ branch: 'attempt', current: true });

    const removed = await app.inject({ method: 'DELETE', url: `/api/projects/${origin.id}/worktrees`, payload: { path: createdPath } });
    expect(removed.statusCode).toBe(200);
    expect(changed).toHaveBeenCalledTimes(3); // Subproject registration, then worktree removal.
    const after = await app.inject({ method: 'GET', url: `/api/projects/${origin.id}/worktrees` });
    expect(after.json<WorktreeInfo[]>().some(item => item.path === createdPath)).toBe(false);
    const afterRemoval = store.projectRevision;
    store.createSession({ projectId: origin.id, kind: 'native' });
    expect(store.projectRevision).toBe(afterRemoval);
  } finally { await app.close(); store.close(); }
});

it('names conversation worktrees for their original project and preserves explicit branch and adoption requests', async () => {
  const { root, source, service } = await repository();
  const store = new Store(':memory:');
  const app = Fastify();
  try {
    const origin = store.createProject(await realpath(root), 'arch_agent');
    const associated = store.createProject(await realpath(source), 'arch_agent · attempt', { originProjectId: origin.id, branch: 'attempt' });
    registerGitRoutes(app, { store, git: service } as unknown as RouteDeps);
    const create = (id: string, payload: { name?: string; branch?: string; base?: string; path?: string } = {}) => app.inject({ method: 'POST', url: `/api/projects/${id}/worktree-projects`, payload });
    for (const payload of [{}, { name: '   ' }]) {
      const response = await create(origin.id, payload);
      expect(response.statusCode).toBe(200);
      expect(response.json().worktree.branch).toMatch(/^riffet\/arch_agent_\d{8}-[a-f0-9]{4}$/);
    }
    const named = await create(associated.id, { name: 'fix-login' });
    expect(named.statusCode).toBe(200);
    expect(named.json().worktree).toEqual({ originProjectId: associated.id, branch: 'riffet/arch_agent_fix-login' });
    const explicit = await create(origin.id, { branch: 'feature/manual', base: 'main' });
    expect(explicit.statusCode).toBe(200);
    expect(explicit.json().worktree.branch).toBe('feature/manual');
    store.updateProject(origin.id, { name: '项目演示' });
    const directories: string[] = [];
    for (const name of ['修复登录', '修复搜索']) {
      const response = await create(origin.id, { name });
      expect(response.statusCode).toBe(200);
      expect(response.json().worktree.branch).toBe(`riffet/项目演示_${name}`);
      directories.push(response.json().cwd);
    }
    expect(new Set(directories).size).toBe(2);
    const adopted = await create(origin.id, { path: source });
    expect(adopted.statusCode).toBe(200);
    expect(adopted.json().id).toBe(associated.id);
  } finally { await app.close(); store.close(); }
});

it('rejects invalid conversation worktree names without creating worktrees, branches or projects', async () => {
  const { root, service } = await repository();
  const store = new Store(':memory:');
  const app = Fastify();
  try {
    const origin = store.createProject(await realpath(root), 'arch.agent / demo');
    registerGitRoutes(app, { store, git: service } as unknown as RouteDeps);
    const worktrees = await git(root, 'worktree', 'list', '--porcelain');
    const branches = await git(root, 'branch', '--list');
    for (const name of ['bad name', '../escape', 'feature.lock', 'x'.repeat(256), 12]) {
      const response = await app.inject({ method: 'POST', url: `/api/projects/${origin.id}/worktree-projects`, payload: { name } });
      expect(response.statusCode).toBe(400);
      expect(store.listProjects()).toHaveLength(1);
      expect(await git(root, 'worktree', 'list', '--porcelain')).toBe(worktrees);
      expect(await git(root, 'branch', '--list')).toBe(branches);
    }
    const response = await app.inject({ method: 'POST', url: `/api/projects/${origin.id}/worktree-projects`, payload: { name: 'fix' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().worktree.branch).toBe('riffet/arch-agent-demo_fix');
  } finally { await app.close(); store.close(); }
});

it('pushes only the current branch despite matching, force and mirror configuration', async () => {
  const { folder, root, service } = await repository();
  const remote = path.join(folder, 'remote.git');
  await git(root, 'init', '--bare', remote);
  await git(root, 'remote', 'add', 'origin', remote);
  await git(root, 'branch', 'other');
  await git(root, 'push', '-u', 'origin', 'main', 'other');
  const otherHead = await git(remote, 'rev-parse', 'refs/heads/other');
  await git(root, 'switch', 'other');
  await change(root, 'other change\n');
  await git(root, 'switch', 'main');
  await change(root, 'main change\n');
  await git(root, 'config', 'push.default', 'matching');
  await git(root, 'config', 'remote.origin.push', '+refs/heads/*:refs/heads/*');
  await git(root, 'config', 'remote.origin.mirror', 'true');
  const result = await service.push(root);
  expect(result.branch.ahead).toBe(0);
  expect(await git(remote, 'rev-parse', 'refs/heads/main')).toBe(await git(root, 'rev-parse', 'HEAD'));
  expect(await git(remote, 'rev-parse', 'refs/heads/other')).toBe(otherHead);
});

it.each(['merge', 'squash'] as const)('restores target HEAD, files and index after a %s conflict', async strategy => {
  const { root, source, service } = await repository();
  await change(root, 'main change\n');
  await change(source, 'attempt change\n');
  const head = await git(root, 'rev-parse', 'HEAD');
  await expect(service.mergeWorktree(root, source, { strategy })).rejects.toMatchObject({ code: 'MERGE_CONFLICT', details: { paths: ['file.txt'] } });
  expect(await git(root, 'rev-parse', 'HEAD')).toBe(head);
  expect(await git(root, 'status', '--porcelain')).toBe('');
  expect(await readFile(path.join(root, 'file.txt'), 'utf8')).toBe('main change\n');
  await expect(readFile(path.join(root, '.git', 'MERGE_HEAD'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('preserves an existing unfinished Git operation', async () => {
  const { root, source, service } = await repository();
  const head = await git(root, 'rev-parse', 'HEAD');
  await writeFile(path.join(root, '.git', 'MERGE_HEAD'), `${head}\n`);
  await expect(service.mergeWorktree(root, source)).rejects.toMatchObject({ code: 'GIT_OPERATION_IN_PROGRESS' });
  expect(await readFile(path.join(root, '.git', 'MERGE_HEAD'), 'utf8')).toBe(`${head}\n`);
});

it('does not auto-commit dirty files outside a worktree project directory', async () => {
  const { root, source, service } = await repository();
  const subproject = path.join(source, 'subproject');
  await mkdir(subproject);
  await writeFile(path.join(subproject, 'new.txt'), 'inside\n');
  await writeFile(path.join(source, 'outside.txt'), 'outside\n');
  const head = await git(source, 'rev-parse', 'HEAD');
  await expect(service.mergeWorktree(root, subproject, { commitPending: 'save changes' })).rejects.toMatchObject({ code: 'WORKTREE_DIRTY_OUTSIDE_PROJECT' });
  expect(await git(source, 'rev-parse', 'HEAD')).toBe(head);
  expect(await git(source, 'diff', '--cached', '--name-only')).toBe('');
});

it('commits pending work before squashing and keeps its branch when removing the worktree', async () => {
  const { root, source, service } = await repository();
  await writeFile(path.join(source, 'file.txt'), 'pending change\n');
  await writeFile(path.join(source, 'new.txt'), 'new file\n');
  const result = await service.mergeWorktree(root, source, { strategy: 'squash', commitPending: 'Save pending work', removeWorktree: true });
  expect(result).toMatchObject({ merged: true, strategy: 'squash', commits: 1, removedWorktree: true });
  expect(await readFile(path.join(root, 'file.txt'), 'utf8')).toBe('pending change\n');
  expect(await readFile(path.join(root, 'new.txt'), 'utf8')).toBe('new file\n');
  expect(await git(root, 'status', '--porcelain')).toBe('');
  expect(await git(root, 'log', '-1', '--format=%s', 'attempt')).toBe('Save pending work');
});

it('preserves ignored target files that the source branch would overwrite', async () => {
  const { root, source, service } = await repository();
  await writeFile(path.join(source, 'local.txt'), 'source\n');
  await git(source, 'add', 'local.txt');
  await git(source, 'commit', '-m', 'add local.txt');
  await mkdir(path.join(root, '.git', 'info'), { recursive: true });
  await writeFile(path.join(root, '.git', 'info', 'exclude'), 'local.txt\n');
  await writeFile(path.join(root, 'local.txt'), 'private local data\n');
  const head = await git(root, 'rev-parse', 'HEAD');
  await expect(service.mergeWorktree(root, source)).rejects.toBeDefined();
  expect(await readFile(path.join(root, 'local.txt'), 'utf8')).toBe('private local data\n');
  expect(await git(root, 'rev-parse', 'HEAD')).toBe(head);
});

it('rejects simultaneous merges before they can abort each other', async () => {
  const { root, source, service } = await repository();
  await change(source, 'attempt change\n');
  const results = await Promise.allSettled([service.mergeWorktree(root, source), service.mergeWorktree(root, source)]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'MERGE_IN_PROGRESS' } });
  expect(await readFile(path.join(root, 'file.txt'), 'utf8')).toBe('attempt change\n');
  expect(await git(root, 'status', '--porcelain')).toBe('');
});

it('keeps the original turn checkpoint across concurrent capture, dispatch retries and restart', async () => {
  const { root, service } = await repository();
  await writeFile(path.join(root, 'file.txt'), 'before turn\n');
  const options = { sessionId: 'session', runId: 'run', title: 'Before turn', since: await turnStart() };
  const [first, concurrent] = await Promise.all([service.createTurnCheckpoint(root, options), service.createTurnCheckpoint(root, options)]);
  expect(first).toBeDefined();
  expect(concurrent?.id).toBe(first!.id);
  await writeFile(path.join(root, 'file.txt'), 'agent changes\n');
  const restarted = new GitService({ stateDir: service.stateDir });
  expect((await restarted.createTurnCheckpoint(root, options))?.id).toBe(first!.id);
  expect(await restarted.checkpoints(root)).toHaveLength(1);
  await restarted.restoreCheckpoint(root, first!.id, await restarted.checkpointChanges(root, first!.id));
  expect(await readFile(path.join(root, 'file.txt'), 'utf8')).toBe('before turn\n');
});

it('leaves out of a turn checkpoint what the turn changed while it was taken, and keeps none once HEAD moved', async () => {
  const { root, service } = await repository();
  await writeFile(path.join(root, 'file.txt'), 'before turn\n');
  await writeFile(path.join(root, 'notes.txt'), 'before turn\n');
  await writeFile(path.join(root, 'gone.txt'), 'committed\n');
  await git(root, 'add', 'gone.txt');
  await git(root, 'commit', '-m', 'gone');
  const since = await turnStart();
  // The turn reached these two before the checkpoint did: their content from before it is gone.
  await writeFile(path.join(root, 'notes.txt'), 'turn edit\n');
  await rm(path.join(root, 'gone.txt'));
  const checkpoint = await service.createTurnCheckpoint(root, { sessionId: 'session', runId: 'run', title: 'Turn', since });
  expect(checkpoint).toMatchObject({ files: 1, excluded: ['gone.txt', 'notes.txt'] });
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'turn');
  expect(await service.createTurnCheckpoint(root, { sessionId: 'session', runId: 'next', title: 'Turn', since })).toBeUndefined();
});

it.each(['active-session', 'unfinished-run'] as const)('fences checkpoint restoration when another client has an %s', async busy => {
  const { root, service } = await repository();
  const store = new Store(':memory:');
  const app = Fastify();
  const dispatch = new NativeDispatcher(store, { subscribe: () => () => {} } as never, {} as never, {} as never, { intervalMs: 60_000 });
  try {
    const project = store.createProject(root, 'test');
    const session = store.createSession({ projectId: project.id, kind: 'native', backendId: 'codex' });
    if (busy === 'active-session') store.updateSession(session.id, { state: 'running' });
    else {
      const run = store.acceptNativeRun(session.id, 'command', { text: 'change files', attachmentIds: [], context: [] }, { mode: 'agent' });
      store.transitionNativeRun(run.id, ['queued'], { delivery: 'uncertain' });
    }
    registerGitRoutes(app, { store, git: service, dispatch } as unknown as RouteDeps);
    const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/checkpoints/not-a-checkpoint/restore`, payload: { expectedChanges: [] } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'PROJECT_BUSY' });
    expect(await readFile(path.join(root, 'file.txt'), 'utf8')).toBe('base\n');
  } finally { await app.close(); await dispatch.close(); store.close(); }
});

it('validates a pull request base before any push side effect', async () => {
  const { root, service } = await repository();
  await expect(service.createPullRequest(root, { base: '-invalid' })).rejects.toMatchObject({ code: 'INVALID_BASE' });
});

it('holds the workspace fence throughout an asynchronous restore and releases it on failure', async () => {
  const { root, service } = await repository();
  const store = new Store(':memory:');
  const app = Fastify();
  const dispatch = new NativeDispatcher(store, { subscribe: () => () => {} } as never, {} as never, {} as never, { intervalMs: 60_000 });
  try {
    const project = store.createProject(root, 'test');
    const session = store.createSession({ projectId: project.id, kind: 'native', backendId: 'codex' });
    vi.spyOn(service, 'restoreCheckpoint').mockImplementation(async () => {
      expect(() => dispatch.reserveSessionStart(session.id)).toThrowError(expect.objectContaining({ code: 'PROJECT_BUSY' }));
      await new Promise(resolve => setImmediate(resolve));
      expect(() => dispatch.reserveSessionStart(session.id)).toThrowError(expect.objectContaining({ code: 'PROJECT_BUSY' }));
      throw new AppError('RESTORE_FAILED', 'simulated restore failure', 422);
    });
    registerGitRoutes(app, { store, git: service, dispatch } as unknown as RouteDeps);
    const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/checkpoints/checkpoint/restore`, payload: { expectedChanges: [] } });
    expect(response.statusCode).toBe(422);
    const release = dispatch.reserveSessionStart(session.id);
    release();
  } finally { await app.close(); await dispatch.close(); store.close(); }
});

it('stages, unstages and discards chosen lines, and refuses a diff that has gone stale', async () => {
  const { root, service } = await repository();
  await change(root, 'a\nb\nc\n');
  // One line rewritten, and one added without a final newline.
  await writeFile(path.join(root, 'file.txt'), 'a\nB\nc\nd');
  const unstaged = await service.diff(root, 'file.txt');
  await service.applyLines(root, { path: 'file.txt', action: 'stage', changes: [{ before: [1, 2], after: [1, 2] }], version: unstaged.version! });
  expect(await exec('git', ['show', ':file.txt'], { cwd: root }).then(result => result.stdout)).toBe('a\nB\nc\n');
  expect(await readFile(path.join(root, 'file.txt'), 'utf8')).toBe('a\nB\nc\nd');
  await expect(service.applyLines(root, { path: 'file.txt', action: 'stage', changes: [{ before: [3, 3], after: [3, 4] }], version: unstaged.version! })).rejects.toMatchObject({ code: 'GIT_DIFF_STALE' });

  const staged = await service.diff(root, 'file.txt', { staged: true });
  await service.applyLines(root, { path: 'file.txt', action: 'unstage', changes: [{ before: [1, 2], after: [1, 2] }], version: staged.version! });
  expect(await git(root, 'diff', '--cached', '--name-only')).toBe('');

  // Taking back only the rewritten line keeps the added one, and the file keeps its missing final newline.
  const again = await service.diff(root, 'file.txt');
  const { backup } = await service.applyLines(root, { path: 'file.txt', action: 'discard', changes: [{ before: [1, 2], after: [1, 2] }], version: again.version! });
  expect(await readFile(path.join(root, 'file.txt'), 'utf8')).toBe('a\nb\nc\nd');
  await service.restoreCheckpoint(root, backup!.id, await service.checkpointChanges(root, backup!.id));
  expect(await readFile(path.join(root, 'file.txt'), 'utf8')).toBe('a\nB\nc\nd');
});

it('discards files into a checkpoint that puts back only those files', async () => {
  const { root, service } = await repository();
  await writeFile(path.join(root, 'other.txt'), 'other\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'other');
  await writeFile(path.join(root, 'file.txt'), 'edited\n');
  await writeFile(path.join(root, 'other.txt'), 'kept\n');
  await mkdir(path.join(root, 'new'));
  await writeFile(path.join(root, 'new', 'draft.txt'), 'draft\n');

  const { status, backup } = await service.discard(root, ['file.txt', 'new']);
  expect(status.entries.map(entry => entry.path)).toEqual(['other.txt']);
  expect(await readFile(path.join(root, 'file.txt'), 'utf8')).toBe('base\n');
  await expect(readFile(path.join(root, 'new', 'draft.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(backup).toMatchObject({ partial: true, files: 2 });

  // Work done after the discard is not the checkpoint's to touch; a file it held untracked leaves the index again.
  await writeFile(path.join(root, 'other.txt'), 'later\n');
  await mkdir(path.join(root, 'new'));
  await writeFile(path.join(root, 'new', 'draft.txt'), 'again\n');
  await git(root, 'add', 'new/draft.txt');
  await service.restoreCheckpoint(root, backup!.id, await service.checkpointChanges(root, backup!.id));
  expect(await readFile(path.join(root, 'file.txt'), 'utf8')).toBe('edited\n');
  expect(await readFile(path.join(root, 'new', 'draft.txt'), 'utf8')).toBe('draft\n');
  expect(await readFile(path.join(root, 'other.txt'), 'utf8')).toBe('later\n');
  expect(await git(root, 'status', '--porcelain', '--', 'new')).toBe('?? new/');
});

it('answers a followed status from the last read and tells followers of a change after a write', async () => {
  const { root, service } = await repository();
  const seen: string[][] = [];
  const unfollow = await service.followStatus(root, status => seen.push(status.entries.map(entry => `${entry.index}${entry.worktree} ${entry.path}`)));
  try {
    await vi.waitFor(() => expect(seen).toEqual([[]]));
    expect(await service.status(root)).toBe(await service.status(root));
    await writeFile(path.join(root, 'file.txt'), 'edited\n');
    // Whether or not the file watcher has reported the edit yet, a fresh read sees it and followers hear of it once.
    expect((await service.status(root, true)).entries.map(entry => entry.path)).toEqual(['file.txt']);
    await service.stage(root, ['file.txt']);
    await vi.waitFor(() => expect(seen.at(-1)).toEqual(['M  file.txt']));
    expect(seen.filter(entries => entries.join() === ' M file.txt')).toHaveLength(1);
  } finally { unfollow(); service.close(); }
});

it('reads head, a file at a commit, and blame with uncommitted lines marked by the zero hash', async () => {
  const { root, service } = await repository();
  const project = await realpath(root);
  await writeFile(path.join(root, 'file.txt'), 'base\nsecond\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'second line');
  const second = await git(root, 'rev-parse', 'HEAD');
  await writeFile(path.join(root, 'file.txt'), 'base\nsecond\nlocal\n');
  await writeFile(path.join(root, 'fresh.txt'), 'new\n');
  try {
    expect(await service.head(project)).toMatchObject({ branch: 'main', head: second });
    expect(await service.fileAtRev(project, 'file.txt')).toMatchObject({ text: 'base\nsecond\n' });
    expect(await service.fileAtRev(project, 'fresh.txt')).toMatchObject({ missing: true });
    await expect(service.fileAtRev(project, 'file.txt', 'HEAD~1')).rejects.toMatchObject({ code: 'INVALID_REV' });
    await expect(service.fileAtRev(project, '../outside.txt')).rejects.toBeInstanceOf(AppError);
    const blame = await service.blame(project, 'file.txt', 1, 50);
    expect(blame).toMatchObject({ start: 1, end: 3 });
    expect(blame.ranges.map(range => [range.start, range.count, range.hash === second])).toEqual([[1, 1, false], [2, 1, true], [3, 1, false]]);
    expect(blame.ranges[2]!.hash).toBe('0'.repeat(40));
    expect(blame.commits[second]).toMatchObject({ author: 'Riffet Test', summary: 'second line' });
    await expect(service.blame(project, '../outside.txt', 1, 2)).rejects.toBeInstanceOf(AppError);
    expect((await service.blame(project, 'fresh.txt', 1, 1)).ranges).toEqual([{ start: 1, count: 1, hash: '0'.repeat(40) }]);
  } finally { service.close(); }
});
