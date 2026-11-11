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
  const options = { sessionId: 'session', runId: 'run', title: 'Before turn' };
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
