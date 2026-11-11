import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext, Plugin } from '@riffet/plugin-api';
import type { CommandDeclaration } from '../../../../packages/contracts/src/index.js';
import { createApp } from '../app.js';
import { Store } from '../store.js';
import { CommandService } from './commands.js';
import { PluginRegistry } from './registry.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const title = { en: 'Do' };
const declared: CommandDeclaration[] = [
  { id: 'acme.cmd/global', title, scope: 'global' },
  { id: 'acme.cmd/build', title, scope: 'project', when: { hasProject: true, projectType: 'android' }, params: [
    { key: 'variant', label: { en: 'Variant' }, kind: 'choice', options: ['debug', 'release'], default: 'debug' },
    { key: 'clean', label: { en: 'Clean' }, kind: 'boolean' },
  ] },
  { id: 'acme.cmd/talk', title, scope: 'session' },
  { id: 'acme.cmd/nohandler', title, scope: 'global' },
  { id: 'acme.cmd/task', title, scope: 'global' },
];

async function harness(projectTypes: string[] = ['android']) {
  const run = vi.fn(async (_context: CommandContext) => ({ kind: 'done' as const, message: { en: 'ok' } }));
  const plugin: Plugin = {
    manifest: { id: 'acme.cmd', vendor: 'Acme', name: 'cmd', apiVersion: 1, defaultEnabled: true, contributes: { commands: declared } },
    activate: () => ({ commands: {
      'acme.cmd/global': { run }, 'acme.cmd/build': { run }, 'acme.cmd/talk': { run }, 'acme.cmd/task': { run: async () => ({ kind: 'task' as const, taskId: 'someone-elses' }) },
    } }),
  };
  const stateDir = await mkdtemp(join(tmpdir(), 'riffet-commands-'));
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'riffet-command-project-')));
  const store = new Store(':memory:');
  const registry = new PluginRegistry({ stateDir, plugins: [plugin], developmentPackages: [] });
  cleanups.push(async () => { await registry.close(); store.close(); await rm(stateDir, { recursive: true, force: true }); await rm(directory, { recursive: true, force: true }); });
  await registry.refresh();
  const second = await realpath(await mkdtemp(join(tmpdir(), 'riffet-command-project-')));
  cleanups.push(() => rm(second, { recursive: true, force: true }));
  const project = store.createProject(directory, 'p');
  const other = store.createProject(second, 'q');
  const session = store.createSession({ projectId: project.id, kind: 'native' });
  const service = new CommandService({
    registry, project: id => store.getProject(id), session: id => store.getSession(id),
    projectTypes: async () => projectTypes, task: async () => ({ pluginId: 'acme.other' }),
  });
  const call = (name: string, body: Record<string, unknown>) => service.run('acme.cmd', name, { requestId: 'req-1', ...body }, undefined);
  return { run, registry, project, other, session, call };
}

describe('plugin commands', () => {
  it('runs the handler once for one request id and refuses the same id for a different request', async () => {
    const { run, project, other, call } = await harness();
    const body = { projectId: project.id, args: { variant: 'release' } };
    const [first, again] = await Promise.all([call('build', body), call('build', body)]);
    expect(first).toEqual({ kind: 'done', message: { en: 'ok' } });
    expect(again).toEqual(first);
    expect(await call('build', body)).toEqual(first);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0]).toMatchObject({ projectId: project.id, args: { variant: 'release' } });
    await expect(call('build', { projectId: other.id, args: { variant: 'release' } })).rejects.toMatchObject({ code: 'COMMAND_REQUEST_CONFLICT', statusCode: 409 });
    await expect(call('build', { ...body, args: { variant: 'debug' } })).rejects.toMatchObject({ code: 'COMMAND_REQUEST_CONFLICT' });
    // Another request id is another run.
    await call('build', { requestId: 'req-2', ...body });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('checks the scope, the project and session, and `when` again on the server', async () => {
    const { run, project, other, session, call } = await harness(['gradle']);
    await expect(call('global', {})).resolves.toMatchObject({ kind: 'done' });
    await expect(call('build', {})).rejects.toMatchObject({ code: 'COMMAND_UNAVAILABLE', statusCode: 409 });
    // The project is not of the type `when` asks for.
    await expect(call('build', { projectId: project.id })).rejects.toMatchObject({ code: 'COMMAND_UNAVAILABLE' });
    await expect(call('talk', { projectId: project.id })).rejects.toMatchObject({ code: 'COMMAND_UNAVAILABLE' });
    await expect(call('talk', { sessionId: session.id, projectId: other.id })).rejects.toMatchObject({ statusCode: 404 });
    await expect(call('talk', { sessionId: 'nope' })).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND', statusCode: 404 });
    await expect(call('global', { projectId: 'nope' })).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    await expect(call('talk', { sessionId: session.id, requestId: 'req-talk' })).resolves.toMatchObject({ kind: 'done' });
    expect(run.mock.calls.at(-1)![0]).toMatchObject({ sessionId: session.id, projectId: project.id });
    // Declared without a handler, or not declared at all.
    await expect(call('nohandler', {})).rejects.toMatchObject({ code: 'COMMAND_NOT_FOUND', statusCode: 404 });
    await expect(call('missing', {})).rejects.toMatchObject({ code: 'COMMAND_NOT_FOUND' });
  });

  it('validates the arguments against the declared parameters and fills in defaults', async () => {
    const { run, project, call } = await harness();
    for (const [index, args] of [{ variant: 'beta' }, { clean: 'yes' }, { other: 1 }, [1], 'text'].entries()) {
      await expect(call('build', { projectId: project.id, requestId: `bad-${index}`, args })).rejects.toMatchObject({ code: 'COMMAND_ARGS_INVALID', statusCode: 400 });
    }
    expect(run).not.toHaveBeenCalled();
    await call('build', { projectId: project.id, requestId: 'good', args: { clean: true } });
    expect(run.mock.calls[0]![0].args).toEqual({ variant: 'debug', clean: true });
  });

  it('answers 409 for a plugin that is off, and reports a failing handler or a result it should not pass on', async () => {
    const { registry, project, call } = await harness();
    await expect(call('task', { requestId: 'bad-task' })).rejects.toMatchObject({ code: 'COMMAND_FAILED', statusCode: 502 });
    await registry.update('acme.cmd', { enablement: 'off' });
    await expect(call('global', { requestId: 'off', projectId: project.id })).rejects.toMatchObject({ code: 'COMMAND_UNAVAILABLE', statusCode: 409 });
    await expect(registry.update('acme.cmd', { enablement: 'on' })).resolves.toMatchObject({ enabled: true });
    await expect(call('global', { requestId: 'on-again' })).resolves.toMatchObject({ kind: 'done' });
  });
});

describe('the command route', () => {
  it('runs a command for a project the caller can see, and answers an unknown or unavailable one with the error shape', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'riffet-command-app-'));
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'riffet-command-app-project-')));
    const plugin: Plugin = {
      manifest: { id: 'acme.cmd', vendor: 'Acme', name: 'cmd', apiVersion: 1, defaultEnabled: true, contributes: { commands: [{ id: 'acme.cmd/hello', title, scope: 'project' }] } },
      activate: () => ({ commands: { 'acme.cmd/hello': { run: async () => ({ kind: 'open', path: 'x' }) } } }),
    };
    const { app, store } = await createApp({ stateDir, auth: false, cliPath: '/nonexistent/cursor-agent', plugins: [plugin] });
    cleanups.push(async () => { await app.close(); await rm(stateDir, { recursive: true, force: true }); await rm(directory, { recursive: true, force: true }); });
    const status = await app.inject({ method: 'GET', url: '/api/auth/status', headers: { host: '127.0.0.1:4317' } });
    const cookie = String(status.headers['set-cookie']).split(';')[0]!;
    const csrf = (status.json() as { csrfToken: string }).csrfToken;
    const post = (name: string, payload: object) => app.inject({ method: 'POST', url: `/api/integrations/acme.cmd/commands/${name}`, headers: { host: '127.0.0.1:4317', cookie, 'x-csrf-token': csrf }, payload });
    const project = store.createProject(directory, 'routes');
    const ok = await post('hello', { requestId: 'r1', projectId: project.id });
    expect([ok.statusCode, ok.json()]).toEqual([200, { kind: 'open', path: 'x' }]);
    expect((await post('hello', { requestId: 'r2' })).json()).toMatchObject({ error: { code: 'COMMAND_UNAVAILABLE' } });
    const missing = await post('nope', { requestId: 'r3' });
    expect([missing.statusCode, missing.json()]).toEqual([404, expect.objectContaining({ error: expect.objectContaining({ code: 'COMMAND_NOT_FOUND' }) })]);
  });
});
