import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Plugin, TaskPlan, TaskProvider } from '@riffet/plugin-api';
import type { Project, Task, TaskParams } from '../../../../packages/contracts/src/index.js';
import { createApp } from '../app.js';
import { PluginRegistry, type OwnedTaskProvider } from '../plugins/registry.js';
import { Store } from '../store.js';
import { projectContext } from './files.js';
import { isAlive, signalGroup } from './process.js';
import { TaskService } from './service.js';
import { TaskStore } from './store.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function until<T>(read: () => Promise<T> | T, done: (value: T) => boolean, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > end) throw new Error(`timed out; last: ${JSON.stringify(value)}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
const lines = async (file: string): Promise<number> => (await readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;

/** A provider whose actions run small `sh` commands. */
function provider(plans: Record<string, (params: TaskParams) => TaskPlan>, extra: Partial<TaskProvider> = {}): TaskProvider {
  return {
    id: 'acme.demo/run',
    detect: async () => true,
    actions: async () => Object.keys(plans).map(id => ({ id, title: { en: id } })),
    plan: async (actionId, params) => plans[actionId]!(params),
    ...extra,
  };
}
const sh = (script: string, more: Partial<TaskPlan> = {}): TaskPlan => ({ file: 'sh', args: ['-c', script], ...more });

async function harness(providers?: { taskProviders(): OwnedTaskProvider[] }) {
  const stateDir = await realpath(await mkdtemp(join(tmpdir(), 'riffet-tasks-')));
  const store = new Store(':memory:');
  const projects: Project[] = [];
  const project = async (name: string): Promise<Project> => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'riffet-task-project-')));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const created = store.createProject(directory, name);
    projects.push(created);
    return created;
  };
  const services: TaskService[] = [];
  const service = (use: { taskProviders(): OwnedTaskProvider[] } = providers!) => {
    const created = new TaskService({
      stateDir, db: store.db, project: id => store.getProject(id), providers: use,
      environment: () => process.env, pollMs: 20, killGraceMs: 300, actionsTtlMs: 0,
    });
    services.push(created);
    return created;
  };
  cleanups.push(async () => {
    for (const created of services) created.close();
    // Whatever a test left running.
    for (const stored of new TaskStore(store.db).open()) if (stored.process) signalGroup(stored.process.pgid, 'SIGKILL');
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  return { stateDir, store, project, service };
}

const owned = (value: TaskProvider): OwnedTaskProvider => ({ owner: 'acme.demo', version: '1.2.3', projectType: 'demo', provider: value });
const request = (project: Project, requestId: string, actionId = 'go', params?: TaskParams) => ({ requestId, projectId: project.id, providerId: 'acme.demo/run', actionId, ...(params ? { params } : {}) });

describe('task identity and idempotency', () => {
  it('runs one process for one request id and refuses the same id for a different request', async () => {
    const counter = join(await mkdtemp(join(tmpdir(), 'riffet-count-')), 'count');
    const { project, service } = await harness({ taskProviders: () => [owned(provider({ go: () => sh('echo run >> "$COUNT"; sleep 0.2', { env: { COUNT: counter } }) }))] });
    const tasks = service();
    const p = await project('one');
    const [a, b] = await Promise.all([tasks.start(request(p, 'req-1')), tasks.start(request(p, 'req-1'))]);
    expect(b.id).toBe(a.id);
    expect(a).toMatchObject({ state: 'running', providerVersion: '1.2.3', pluginId: 'acme.demo', title: { en: 'go' } });
    await expect(tasks.start(request(p, 'req-1', 'go', { mode: 'x' }))).rejects.toMatchObject({ code: 'TASK_REQUEST_CONFLICT', statusCode: 409 });
    await until(() => tasks.get(a.id), task => task.state === 'succeeded');
    expect((await tasks.start(request(p, 'req-1'))).id).toBe(a.id);
    expect(await lines(counter)).toBe(1);
  });
});

describe('task lock', () => {
  it('refuses a second task holding the lock in the project and leaves other projects alone', async () => {
    const { project, service } = await harness({ taskProviders: () => [owned(provider({ go: () => sh('sleep 30', { lock: 'gradle' }) }))] });
    const tasks = service();
    const [first, other] = [await project('a'), await project('b')];
    const running = await tasks.start(request(first, 'req-a1'));
    await expect(tasks.start(request(first, 'req-a2'))).rejects.toMatchObject({ code: 'TASK_BUSY', statusCode: 409, details: { taskId: running.id } });
    expect((await tasks.start(request(other, 'req-b1'))).state).toBe('running');
    await tasks.cancel(running.id);
    await until(() => tasks.get(running.id), task => task.state === 'cancelled');
    expect((await tasks.start(request(first, 'req-a3'))).state).toBe('running');
  });
});

describe('task cancellation', () => {
  it('is cancelling until the process is seen to exit, escalating to SIGKILL when SIGTERM is ignored', async () => {
    const ready = join(await mkdtemp(join(tmpdir(), 'riffet-ready-')), 'ready');
    // Cancelled only once the command is running: a signal in the instant between fork and exec is lost, which is what the SIGKILL is for.
    const { project, service } = await harness({ taskProviders: () => [owned(provider({
      stubborn: () => sh('trap "" TERM; echo up >> "$READY"; sleep 30', { env: { READY: ready } }),
      polite: () => sh('echo up >> "$READY"; sleep 30', { env: { READY: ready } }),
    }))] });
    const tasks = service();
    const p = await project('c');
    const stubborn = await tasks.start(request(p, 'req-stubborn', 'stubborn'));
    await until(() => lines(ready), n => n === 1);
    await new Promise(resolve => setTimeout(resolve, 50));
    const pid = (new TaskStore(tasksDb(tasks)).get(stubborn.id)!.process!).pid;
    const asked = await tasks.cancel(stubborn.id);
    expect(asked.state).toBe('cancelling');
    expect(asked.cancelRequestedAt).toBeDefined();
    expect(isAlive(pid)).toBe(true);
    expect((await tasks.get(stubborn.id)).state).toBe('cancelling');
    const ended = await until(() => tasks.get(stubborn.id), task => task.state === 'cancelled');
    expect(isAlive(pid)).toBe(false);
    expect(ended.endedAt).toBeDefined();
    // A finished task is returned as it is.
    expect(await tasks.cancel(stubborn.id)).toMatchObject({ state: 'cancelled', endedAt: ended.endedAt });

    const polite = await tasks.start(request(p, 'req-polite', 'polite'));
    await until(() => lines(ready), n => n === 2);
    await new Promise(resolve => setTimeout(resolve, 50));
    await tasks.cancel(polite.id);
    // 143 when SIGTERM ended it; 137 on a loaded machine where the signal fell in the fork-to-exec gap and the escalation ended it.
    const politeEnd = await until(() => tasks.get(polite.id), task => task.state === 'cancelled');
    expect([143, 137]).toContain(politeEnd.exitCode);
  });
});

/** The database a service was built over, for tests that read what it stored. */
function tasksDb(tasks: TaskService): import('node:sqlite').DatabaseSync { return (tasks as unknown as { options: { db: import('node:sqlite').DatabaseSync } }).options.db; }

describe('task recovery after a restart', () => {
  it('finishes what ended while down, follows what still runs, marks the rest unknown and never reruns', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'riffet-count-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const count = (name: string) => join(dir, name);
    const counted = (name: string, script: string) => sh(`echo run >> "$COUNT"; ${script}`, { env: { COUNT: count(name) } });
    const use = { taskProviders: () => [owned(provider({
      finished: () => counted('finished', 'sleep 0.3; exit 4'),
      alive: () => counted('alive', 'sleep 2.5'),
      killed: () => counted('killed', 'sleep 30'),
      swapped: () => counted('swapped', 'sleep 30'),
    }))] };
    const { project, service, store } = await harness(use);
    const before = service();
    const p = await project('r');
    const ids = Object.fromEntries(await Promise.all(['finished', 'alive', 'killed', 'swapped'].map(async name => [name, (await before.start(request(p, `req-${name}`, name))).id] as const)));
    const raw = new TaskStore(store.db);
    // Each command has started once before the server goes away; the processes do not.
    for (const name of Object.keys(ids)) await until(() => lines(count(name)), n => n === 1);
    before.close();
    const killed = raw.get(ids.killed!)!.process!;
    signalGroup(killed.pgid, 'SIGKILL');
    await until(() => isAlive(killed.pid), alive => !alive);
    const swapped = raw.get(ids.swapped!)!;
    swapped.process!.start = 'Mon Jan  1 00:00:00 2001';
    raw.save(swapped);
    await until(() => readFile(join(tasksPathOf(before), ids.finished!, 'exit'), 'utf8').catch(() => ''), text => text.trim() === '4');

    const after = service();
    await after.recover();
    expect(await after.get(ids.finished!)).toMatchObject({ state: 'failed', exitCode: 4 });
    expect(await after.get(ids.alive!)).toMatchObject({ state: 'running' });
    expect(await after.get(ids.killed!)).toMatchObject({ state: 'unknown', unknownReason: expect.stringContaining('exit code') });
    // A live process that cannot be shown to be the task's is left alone.
    const other = await after.get(ids.swapped!);
    expect(other).toMatchObject({ state: 'unknown' });
    expect(isAlive(swapped.process!.pid)).toBe(true);
    await until(() => after.get(ids.alive!), task => task.state === 'succeeded');
    for (const name of ['finished', 'alive', 'killed', 'swapped']) expect(await lines(count(name))).toBe(1);
  });
});
function tasksPathOf(tasks: TaskService): string { return join((tasks as unknown as { options: { stateDir: string } }).options.stateDir, 'tasks'); }

describe('task confinement', () => {
  it('keeps the working directory, the command and artifact globs inside the project', async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'riffet-outside-')));
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    await writeFile(join(outside, 'secret.bin'), 'secret');
    await mkdir(join(outside, 'dir'));
    await writeFile(join(outside, 'dir', 'x.bin'), 'x');
    const bad: Record<string, TaskPlan> = {
      parent: sh('true', { cwd: '..' }),
      absolute: sh('true', { cwd: outside }),
      linked: sh('true', { cwd: 'escape' }),
      command: { file: '/bin/sh', args: ['-c', 'true'] },
      climbing: { file: './../sh', args: [] },
      glob: sh('true', { artifacts: ['../*.bin'] }),
    };
    const { project, service } = await harness({ taskProviders: () => [owned(provider({
      ...Object.fromEntries(Object.entries(bad).map(([name, plan]) => [name, () => plan])),
      build: () => sh('mkdir -p out && printf apk > out/a.bin', { artifacts: ['out/*.bin', '**/*.bin'] }),
    }))] });
    const tasks = service();
    const p = await project('confined');
    await symlink(outside, join(p.cwd, 'escape'));
    await mkdir(join(p.cwd, 'out'));
    await symlink(join(outside, 'secret.bin'), join(p.cwd, 'out', 'leak.bin'));
    for (const name of Object.keys(bad)) await expect(tasks.start(request(p, `req-${name}`, name))).rejects.toMatchObject({ code: 'TASK_PLAN_INVALID' });
    expect(await tasks.list(p.id, 10)).toEqual([]);

    const task = await until(async () => tasks.get((await tasks.start(request(p, 'req-build', 'build'))).id), value => value.state === 'succeeded');
    // The link out of the project is never registered, nor is anything found through the linked directory.
    expect(task.artifacts).toEqual([{ id: expect.any(String), name: 'a.bin', path: 'out/a.bin', size: 3, sha256: createHash('sha256').update('apk').digest('hex') }]);
    const file = await tasks.artifact(task.id, task.artifacts![0]!.id);
    expect(await readFile(file.file, 'utf8')).toBe('apk');
    await writeFile(join(p.cwd, 'out', 'a.bin'), 'rebuilt later');
    await expect(tasks.artifact(task.id, task.artifacts![0]!.id)).rejects.toMatchObject({ code: 'TASK_ARTIFACT_CHANGED' });
  });

  it('gives a provider only project-relative reads', async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'riffet-outside-')));
    const root = await realpath(await mkdtemp(join(tmpdir(), 'riffet-root-')));
    cleanups.push(() => rm(outside, { recursive: true, force: true }), () => rm(root, { recursive: true, force: true }));
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await writeFile(join(root, 'a.txt'), 'hello');
    await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'));
    await symlink(outside, join(root, 'escape'));
    const context = projectContext({ id: 'p', name: 'p' }, root, join(root, '.state'));
    expect(await context.readText('a.txt', 3)).toBe('hel');
    expect(await context.exists('missing')).toBe(false);
    expect(await context.list('')).toContain('a.txt');
    for (const attempt of [() => context.readText('../x', 10), () => context.readText('link.txt', 10), () => context.exists('escape/secret.txt'), () => context.list('escape')]) await expect(attempt()).rejects.toMatchObject({ code: expect.stringMatching(/^(?:PATH_OUTSIDE_PROJECT|INVALID_PATH)$/) });
  });
});

describe('turning a plugin off', () => {
  const setup = async (diagnostics: () => Array<{ severity: 'error'; message: string }>) => {
    const demo = provider({ go: () => sh('sleep 0.5; echo done') }, { diagnostics });
    const plugin = (id: `${string}.${string}`, declared: string, provided: string): Plugin => ({
      manifest: { id, vendor: 'Acme', name: id, apiVersion: 1, version: '1.2.3', defaultEnabled: true, contributes: { tasks: [{ id: declared, title: { en: 'Run' } }] } },
      activate: () => ({ taskProviders: [{ ...demo, id: provided }] }),
    });
    const stateDir = await mkdtemp(join(tmpdir(), 'riffet-registry-'));
    cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
    let counting: TaskService | undefined;
    const registry = new PluginRegistry({
      stateDir, runningTasks: id => counting?.runningCount(id) ?? 0,
      plugins: [plugin('acme.demo', 'acme.demo/run', 'acme.demo/run'), plugin('acme.stray', 'acme.stray/run', 'acme.stray/other')], developmentPackages: [],
    });
    cleanups.push(() => registry.close());
    await registry.refresh();
    // A provider the manifest does not declare keeps its plugin off.
    expect((await registry.descriptors()).find(item => item.id === 'acme.stray')).toMatchObject({ enabled: false });
    const { project, service } = await harness(registry);
    const tasks = service();
    counting = tasks;
    tasks.subscribe(event => { if (event.state !== 'running' && event.state !== 'cancelling') registry.tasksChanged(); });
    return { registry, tasks, p: await project('toggle') };
  };

  it('waits for the running task, refuses new ones, then turns off with the task read by the provider that started it', async () => {
    const diagnostics = vi.fn(() => [{ severity: 'error' as const, message: 'boom' }]);
    const { registry, tasks, p } = await setup(diagnostics);
    const running = await tasks.start(request(p, 'req-toggle'));
    const waiting = await registry.update('acme.demo', { enablement: 'off' });
    expect(waiting).toMatchObject({ enabled: true, stopping: { running: 1 } });
    expect((await tasks.actions(p.id)).actions).toEqual([]);
    await expect(tasks.start(request(p, 'req-after-off'))).rejects.toMatchObject({ code: 'TASK_PROVIDER_STOPPING', statusCode: 409 });
    const done = await until(() => tasks.get(running.id), task => task.state !== 'running');
    expect(done).toMatchObject({ state: 'succeeded', diagnostics: [{ message: 'boom' }] });
    await until(async () => (await registry.descriptors()).find(item => item.id === 'acme.demo')!, item => !item.enabled);
    await expect(tasks.start(request(p, 'req-after-done'))).rejects.toMatchObject({ code: 'TASK_PROVIDER_UNAVAILABLE', statusCode: 409 });
  });

  it('goes ahead at once when forced, and the task that ends after that has no diagnostics and says why', async () => {
    const diagnostics = vi.fn(() => [{ severity: 'error' as const, message: 'boom' }]);
    const { registry, tasks, p } = await setup(diagnostics);
    const running = await tasks.start(request(p, 'req-forced'));
    expect(await registry.update('acme.demo', { enablement: 'off', force: true })).toMatchObject({ enabled: false });
    await expect(tasks.start(request(p, 'req-after-force'))).rejects.toMatchObject({ code: 'TASK_PROVIDER_UNAVAILABLE' });
    const done = await until(() => tasks.get(running.id), task => task.state !== 'running');
    expect(done).toMatchObject({ state: 'succeeded', diagnosticsNote: expect.stringContaining('1.2.3') });
    expect(done.diagnostics).toBeUndefined();
    expect(diagnostics).not.toHaveBeenCalled();
  });
});

describe('plans of installed packages', () => {
  const installed = (plans: Record<string, () => TaskPlan>, version = '1.2.3'): { taskProviders(): OwnedTaskProvider[] } => ({ taskProviders: () => [{ ...owned(provider(plans)), version, source: 'installed' }] });

  it('refuses an environment that could change how a program or the wrapper shell starts, a long value, and text that would not read as it is', async () => {
    const bad: Array<Record<string, string>> = [{ NODE_OPTIONS: '--require x' }, { LD_PRELOAD: 'x' }, { DYLD_INSERT_LIBRARIES: 'x' }, { PATH: '/tmp' }, { GIT_SSH_COMMAND: 'x' }, { RIFFET_TOKEN: 'x' }, { lower: 'x' }, { _JAVA_OPTIONS: 'x' }, { BIG: 'x'.repeat(4097) }, { SHELLOPTS: 'xtrace', PS4: '$(id)' }, { MODE: 'a\nb' }, { MODE: 'a\u202eb' }];
    const { project, service } = await harness({ taskProviders: () => [] });
    const tasks = service(installed(Object.fromEntries(bad.map((env, index) => [`go${index}`, () => sh('true', { env })]))));
    const p = await project('env');
    for (const [index] of bad.entries()) await expect(tasks.start(request(p, `req-env-${index}`, `go${index}`))).rejects.toMatchObject({ code: 'TASK_PLAN_INVALID', statusCode: 502 });
    // A built-in provider is not held to it.
    const builtin = service({ taskProviders: () => [owned(provider({ go: () => sh('true', { env: { NODE_OPTIONS: '--no-warnings' } }) }))] });
    expect((await builtin.start(request(p, 'req-builtin'))).state).toMatch(/running|succeeded/);
  });

  it('asks before a plan first runs, remembers the approval in its project, and asks again for a changed plan, project or version', async () => {
    let args = 'one';
    let version = '1.2.3';
    const { project, service } = await harness({ taskProviders: () => [] });
    const tasks = service({ taskProviders: () => [{ ...owned(provider({ go: () => sh(`echo ${args}`, { env: { MODE: 'a' } }) })), version, source: 'installed' }] });
    const p = await project('confirm');
    const asked = await tasks.start(request(p, 'req-1')).then(() => undefined, (error: unknown) => error as { code: string; statusCode: number; details: { fingerprint: string; plan: unknown } });
    expect(asked).toMatchObject({ code: 'TASK_CONFIRM_REQUIRED', statusCode: 409, details: { plan: { file: 'sh', args: ['-c', 'echo one'], cwd: '.', env: { MODE: 'a' } } } });
    // Not the plan that was shown: still asks.
    await expect(tasks.start({ ...request(p, 'req-1'), confirm: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'TASK_CONFIRM_REQUIRED' });
    expect((await tasks.start({ ...request(p, 'req-1'), confirm: asked!.details.fingerprint })).state).toMatch(/running|succeeded/);
    // The same plan under a new request runs without asking; in another project it is another project's file, so it asks.
    expect((await tasks.start(request(p, 'req-2'))).requestId).toBe('req-2');
    await expect(tasks.start(request(await project('confirm-elsewhere'), 'req-2b'))).rejects.toMatchObject({ code: 'TASK_CONFIRM_REQUIRED' });
    // A changed plan, or a new version of the plugin, asks again.
    args = 'two';
    await expect(tasks.start(request(p, 'req-3'))).rejects.toMatchObject({ code: 'TASK_CONFIRM_REQUIRED' });
    args = 'one';
    version = '1.2.4';
    await expect(tasks.start(request(p, 'req-4'))).rejects.toMatchObject({ code: 'TASK_CONFIRM_REQUIRED' });
  });
});

describe('task routes', () => {
  it('serves actions, tasks, log windows and artifacts, and answers a replay with the same task', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'riffet-app-'));
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'riffet-project-')));
    const demo = provider({ go: () => sh('printf "构建完成\\nline two\\n"; mkdir -p out; printf apk > out/app.bin', { artifacts: ['out/*.bin'] }) });
    const plugin: Plugin = {
      manifest: { id: 'acme.demo', vendor: 'Acme', name: 'demo', apiVersion: 1, defaultEnabled: true, contributes: { tasks: [{ id: 'acme.demo/run', title: { en: 'Run' }, projectType: 'demo' }] } },
      activate: () => ({ taskProviders: [demo] }),
    };
    const { app, store } = await createApp({ stateDir, auth: false, cliPath: '/nonexistent/cursor-agent', plugins: [plugin] });
    cleanups.push(async () => { await app.close(); await rm(stateDir, { recursive: true, force: true }); await rm(directory, { recursive: true, force: true }); });
    const status = await app.inject({ method: 'GET', url: '/api/auth/status', headers: { host: '127.0.0.1:4317' } });
    const cookie = String(status.headers['set-cookie']).split(';')[0]!;
    const csrf = (status.json() as { csrfToken: string }).csrfToken;
    const call = (method: 'GET' | 'POST', url: string, payload?: object) => app.inject({ method, url, headers: { host: '127.0.0.1:4317', cookie, 'x-csrf-token': csrf }, ...(payload ? { payload } : {}) });
    const p = store.createProject(directory, 'routes');

    expect((await call('GET', `/api/projects/${p.id}/task-actions`)).json()).toMatchObject({ projectTypes: ['demo'], actions: [{ providerId: 'acme.demo/run', pluginId: 'acme.demo', id: 'go' }] });
    const body = request(p, 'req-route');
    const created = (await call('POST', '/api/tasks', body)).json() as Task;
    expect(created).toMatchObject({ state: 'running', projectId: p.id });
    expect(((await call('POST', '/api/tasks', body)).json() as Task).id).toBe(created.id);
    const conflict = await call('POST', '/api/tasks', { ...body, actionId: 'other' });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: 'TASK_REQUEST_CONFLICT' } });

    const done = await until(async () => (await call('GET', `/api/tasks/${created.id}`)).json() as Task, task => task.state === 'succeeded');
    expect(((await call('GET', `/api/tasks?projectId=${p.id}`)).json() as { tasks: Task[] }).tasks.map(task => task.id)).toEqual([created.id]);

    // Windows of a few bytes, as a client following the log would ask for them, rebuild the text.
    let text = '';
    let at = 0;
    for (;;) {
      const chunk = (await call('GET', `/api/tasks/${created.id}/log?from=${at}&limit=5`)).json() as { from: number; to: number; text: string; eof: boolean };
      expect(chunk.from).toBe(at);
      text += chunk.text;
      at = chunk.to;
      if (chunk.eof) break;
      expect(chunk.to).toBeGreaterThan(chunk.from);
    }
    expect(text).toBe('构建完成\nline two\n');
    expect(at).toBe(done.logSize);

    const download = await call('GET', `/api/tasks/${created.id}/artifacts/${done.artifacts![0]!.id}`);
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe('apk');
    expect(String(download.headers['content-disposition'])).toContain('attachment');
    expect((await call('POST', `/api/tasks/${created.id}/cancel`)).json()).toMatchObject({ state: 'succeeded' });
    expect((await call('GET', '/api/tasks/unknown-task')).statusCode).toBe(404);
  });
});
