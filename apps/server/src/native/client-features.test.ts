import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { CLIENT_FEATURES_HEADER, TERMINAL_APPEARANCE_HEADER } from '../../../../packages/contracts/src/index.js';
import type { NativeBackendService } from '../backends/service.js';
import { registerBackendRoutes } from '../routes/backends.js';
import type { RouteDeps } from '../routes/deps.js';
import { registerAuthRoutes } from '../routes/auth.js';
import { registerOrchestrationRoutes } from '../routes/orchestration.js';
import { registerSessionRoutes } from '../routes/sessions.js';
import { registerSettingsRoutes } from '../routes/settings.js';
import { registerWorkspaceRoutes } from '../routes/workspace.js';
import { SettingsService } from '../settings/index.js';
import { Store } from '../store.js';
import { effectiveSettingsForClient, registerProjectVisibilityHook, registerSessionVisibilityHook } from './client-features.js';
import { resolveNativeSessionInput } from './session-input.js';
import { AppError } from '../errors.js';
import { WorkspaceService } from '../workspace/index.js';
import { SessionCommands } from '../orchestration/session-commands.js';
import { SessionReferenceService } from '../context-references/service.js';
import { WorkItemService } from '../work-items/index.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

const profile = { id: 'default', name: 'Default', isDefault: true, config: {} };
const capabilities = {
  supportsModelSelection: true,
  supportsModeSelection: true,
  modes: [{ id: 'agent' }],
  supportsPermissionSelection: false,
  permissions: [],
};

/** Real routes with only the provider layer mocked, so compatibility runs through HTTP while pi has no adapter yet. */
async function boot(savedSettings?: Record<string, unknown>) {
  const stateDir = await mkdtemp(join(tmpdir(), 'riffet-pi-compat-'));
  const projectDir = await mkdtemp(join(tmpdir(), 'riffet-pi-project-'));
  if (savedSettings) await writeFile(join(stateDir, 'settings.json'), JSON.stringify(savedSettings), { mode: 0o600 });
  const store = new Store(join(stateDir, 'workbench.db'));
  const settings = new SettingsService({ stateDir, cliPath: '/nonexistent/cursor-agent' });
  const nativeBackends = {
    offeredBackendIds: () => ['cursor', 'pi', 'antigravity', 'chat'],
    catalog: {
      listBackends: async () => ['cursor', 'pi', 'antigravity', 'chat'].map(backendId => ({ backendId, label: backendId, available: true, profiles: [profile], capabilities, models: [] })),
      validateProfile: (_backendId: string, profileId?: string) => profileId && profileId !== 'default' ? undefined : profile,
      capabilitiesFor: async (backendId: string) => backendId === 'pi' ? { ...capabilities, supportsPermissionSelection: true, permissions: [{ id: 'read-only' }] } : capabilities,
      validateNativeSessionId: () => undefined,
      normalizeModel: (_backendId: string, _profileId: string, model: string) => model,
      profileSettings: () => ({ profiles: [profile] }),
      gatewayProfiles: () => [],
      entry: async (_id: string, project: unknown) => ({ models: [{value: project ? 'project-model' : 'global-model'}] }),
      usage: async (_id: string, project: unknown) => ({ models: {}, scope: project ? 'project' : 'global' }),
      slashCatalog: async (_id: string, project: unknown) => ({ items: [{name: project ? 'project-skill' : 'global-skill',kind:'skill'}] }),
    },
    readOnlyTranscriptBackendIds: () => ['cursor', 'pi'],
    indexableTranscript: async () => [],
  } as unknown as NativeBackendService;

  const stamps = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
  const base = { prompt: 'Do the task', triggers: [], delivery: 'new' as const, catchUp: 'latest' as const, enabled: true, ...stamps };
  const runs: Array<unknown> = [];
  const automations: Array<Record<string, unknown>> = [
    { id: 'plain', name: 'Plain', ...base },
    { id: 'pi-template', name: 'Pi', backendId: 'pi', ...base },
    { id: 'scheduled', name: 'Scheduled', ...base, projectId: 'pending', enabled: false, lastSessionId: 'pending' },
  ];
  const orchestration = {
    automations: () => automations,
    automation: (id: string) => automations.find(item => item.id === id)!,
    saveAutomation: (_id: string | undefined, body: Record<string, unknown>) => ({ ...automations[2]!, ...body }),
    fire: async (id: string, options: { target?: unknown }) => { runs.push(options.target); return { id: 'run', automationId: id, cause: 'manual', at: stamps.createdAt, result: 'started', sessionId: automations[2]!.lastSessionId }; },
    compareAttempts: async (): Promise<unknown> => ({
      group: { id: 'group', projectId: 'pending', prompt: 'p', base: 'b', createdAt: 'c', attempts: [] },
      attempts: [],
    }),
  };
  const effectiveSettings = (headers?: import('node:http').IncomingHttpHeaders) => ({ ...effectiveSettingsForClient(headers, settings.getSettings(), nativeBackends.offeredBackendIds()), allowOutsideRead: true });
  const deps = {
    stateDir, store, settings, nativeBackends, orchestration, effectiveSettings, workItems: new WorkItemService(store),
    titles: { backfill: async () => undefined },
    auth: { authenticate: () => ({ kind: 'device' }), csrf: () => '', onRevoke: () => () => undefined },
    terminal: { listSnapshot: () => [] },
    dispatch: { kick: () => undefined },
    streams: new Set(),
    sessionCommands: new SessionCommands(),
    contextReferences: new SessionReferenceService(store, stateDir),
    renameNative: () => undefined,
    readNativeInput: async (body: { text: string }) => ({ text: body.text, attachmentIds: [], context: [] }),
    nativeRuns: () => [],
    git: {},
    workspace: new WorkspaceService({stateDir}),
    plugins: {},
    themes: {},
    owner: { get: () => ({ revision: 0 }) },
    monitor: { snapshot: async () => ({ processes: [{ pid: 2, kind: 'agent', sessionId: 'plugin-session', sessionTitle: 'Plugin conversation', backendId: 'acme.agent' }, { pid: 3, kind: 'agent', backendId: 'codex' }] }) },
  } as unknown as RouteDeps;
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    const typed = error as { statusCode?: number; code?: string; message: string };
    const status = typed.statusCode ?? 500;
    reply.code(status).send({ error: { code: typed.code ?? 'INTERNAL_ERROR', message: typed.message } });
  });
  registerProjectVisibilityHook(app, store);
  registerSessionVisibilityHook(app, id => store.getSession(id));
  registerAuthRoutes(app, deps);
  registerSessionRoutes(app, deps);
  registerSettingsRoutes(app, deps);
  registerBackendRoutes(app, deps);
  registerWorkspaceRoutes(app, deps);
  registerOrchestrationRoutes(app, deps);
  await app.ready();
  cleanups.push(async () => { await app.close(); store.close(); await rm(stateDir, { recursive: true, force: true }); await rm(projectDir, { recursive: true, force: true }); });

  const ask = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown, features?: string) => app.inject({
    method, url,
    headers: features ? { [CLIENT_FEATURES_HEADER]: features } : {},
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return { app, ask, store, settings, nativeBackends, projectDir, stateDir, orchestration, runs, automations };
}

describe('pi client compatibility', () => {
  it('accepts explicit EventSource features only on authenticated GET streams', async () => {
    const app = Fastify();
    cleanups.push(() => app.close());
    app.setErrorHandler<{ code?: string; statusCode?: number }>((error, _request, reply) => reply.code(error.statusCode ?? 500).send({ error: { code: error.code } }));
    app.addHook('onRequest', async request => {
      if (request.headers.cookie !== 'paired') throw new AppError('UNAUTHENTICATED', 'Sign in', 401);
    });
    registerSessionVisibilityHook(app, () => ({ backendId: 'pi' }));
    for (const url of ['/api/v3/sessions/:id/sync', '/api/sessions/:id/stream', '/api/sessions/:id/runs']) {
      app.get(url, request => ({ features: request.headers[CLIENT_FEATURES_HEADER] }));
    }
    app.post('/api/sessions/:id/native/send', () => ({ accepted: true }));
    for (const url of ['/api/v3/sessions/pi/sync', '/api/sessions/pi/stream']) {
      expect((await app.inject({ url, headers: { cookie: 'paired' } })).statusCode).toBe(404);
      expect((await app.inject({ url: `${url}?features=pi-agent`, headers: { cookie: 'paired' } })).json()).toEqual({ features: 'pi-agent' });
      expect((await app.inject({ url: `${url}?features=pi-agent`, headers: { cookie: 'paired', [CLIENT_FEATURES_HEADER]: 'quick-chat' } })).statusCode).toBe(404);
      expect((await app.inject({ url: `${url}?features=pi-agent` })).statusCode).toBe(401);
    }
    expect((await app.inject({ url: '/api/sessions/pi/runs?features=pi-agent', headers: { cookie: 'paired' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/sessions/pi/native/send?features=pi-agent', headers: { cookie: 'paired' } })).statusCode).toBe(404);
  });

  it('negotiates Antigravity separately from pi and preserves hidden settings on old-client saves', async () => {
    const { ask, store, settings, projectDir } = await boot({
      defaultBackendId: 'antigravity', nativeBackendDefaults: { antigravity: { model: 'gemini-model' } },
    });
    const project = store.createProject(projectDir, 'antigravity-compat');
    const session = store.createSession({ projectId: project.id, kind: 'native', backendId: 'antigravity', title: 'Antigravity conversation' });
    for (const features of [undefined, 'pi-agent', 'plugin-agents']) {
      expect((await ask('GET', '/api/backends', undefined, features)).json().some((item: { backendId: string }) => item.backendId === 'antigravity')).toBe(false);
      expect((await ask('GET', '/api/bootstrap', undefined, features)).json().sessions.map((item: { id: string }) => item.id)).not.toContain(session.id);
      expect((await ask('GET', `/api/sessions/${session.id}/events`, undefined, features)).statusCode).toBe(404);
      expect((await ask('GET', '/api/settings', undefined, features)).json()).toMatchObject({ defaultBackendId: 'cursor' });
    }
    expect((await ask('GET', '/api/backends', undefined, 'antigravity-agent')).json().some((item: { backendId: string }) => item.backendId === 'antigravity')).toBe(true);
    expect((await ask('GET', '/api/bootstrap', undefined, 'antigravity-agent')).json().sessions.map((item: { id: string }) => item.id)).toContain(session.id);
    expect((await ask('GET', `/api/sessions/${session.id}/events`, undefined, 'antigravity-agent')).statusCode).toBe(200);
    expect((await ask('GET', '/api/settings', undefined, 'antigravity-agent')).json()).toMatchObject({ defaultBackendId: 'antigravity', nativeBackendDefaults: { antigravity: { model: 'gemini-model' } } });
    expect((await ask('PATCH', '/api/settings', { defaultBackendId: 'cursor', nativeBackendDefaults: { cursor: { model: 'next' } } }, 'pi-agent')).statusCode).toBe(200);
    expect(settings.getSettings()).toMatchObject({ defaultBackendId: 'antigravity', nativeBackendDefaults: { antigravity: { model: 'gemini-model' }, cursor: { model: 'next' } } });
    expect((await ask('POST', '/api/sessions', { projectId: project.id, kind: 'native', backendId: 'antigravity' }, 'pi-agent')).statusCode).toBe(400);
  });

  it('hides pi from old HTTP reads and lets a negotiated client see it', async () => {
    const { ask, store, projectDir } = await boot({ defaultBackendId: 'pi', nativeBackendDefaults: { pi: { model: 'pi-model' } } });
    const project = store.createProject(projectDir, 'pi-compat');
    const session = store.createSession({ projectId: project.id, kind: 'native', backendId: 'pi', title: 'Pi conversation' });

    expect((await ask('GET', '/api/sessions')).json().map((item: { id: string }) => item.id)).not.toContain(session.id);
    const bootstrap = (await ask('GET', '/api/bootstrap')).json();
    expect(bootstrap.sessions.map((item: { id: string }) => item.id)).not.toContain(session.id);
    expect(bootstrap.settings).toMatchObject({ defaultBackendId: 'cursor' });
    expect(bootstrap.settings).not.toHaveProperty('nativeBackendDefaults');
    expect((await ask('GET', '/api/backends')).json().some((item: { backendId: string }) => item.backendId === 'pi')).toBe(false);
    expect((await ask('GET', '/api/settings')).json()).toMatchObject({ defaultBackendId: 'cursor' });
    expect((await ask('GET', '/api/settings')).json()).not.toHaveProperty('nativeBackendDefaults');
    expect((await ask('GET', `/api/sessions/${session.id}/events`)).statusCode).toBe(404);

    expect((await ask('GET', '/api/sessions', undefined, 'pi-agent')).json().map((item: { id: string }) => item.id)).toContain(session.id);
    expect((await ask('GET', '/api/bootstrap', undefined, 'pi-agent')).json().sessions.map((item: { id: string }) => item.id)).toContain(session.id);
    expect((await ask('GET', '/api/backends', undefined, 'pi-agent')).json().some((item: { backendId: string }) => item.backendId === 'pi')).toBe(true);
    expect((await ask('GET', '/api/settings', undefined, 'pi-agent')).json()).toMatchObject({ defaultBackendId: 'pi', nativeBackendDefaults: { pi: { model: 'pi-model' } } });
    expect((await ask('GET', `/api/sessions/${session.id}/events`, undefined, 'pi-agent')).statusCode).toBe(200);
  });

  it('negotiates a plugin Agent id as plugin-agents and starts on an offered backend when the saved default is not', async () => {
    const { ask, store, nativeBackends, projectDir } = await boot({ defaultBackendId: 'acme.agent', nativeBackendDefaults: { 'acme.agent': { model: 'm' } } });
    const offered = nativeBackends as unknown as { offeredBackendIds: () => string[] };
    offered.offeredBackendIds = () => ['acme.agent', 'cursor', 'chat'];
    const project = store.createProject(projectDir, 'plugin-agent');
    const session = store.createSession({ projectId: project.id, kind: 'native', backendId: 'acme.agent', title: 'Plugin conversation' });
    store.acceptNativeRun(session.id, 'needle-run', { text: 'pluginneedle', attachmentIds: [], context: [] }, { mode: 'agent' });
    const ids = async (features?: string) => (await ask('GET', '/api/sessions', undefined, features)).json().map((item: { id: string }) => item.id);
    const hits = async (features?: string) => (await ask('GET', '/api/search/messages?q=pluginneedle', undefined, features)).json().hits.length;

    expect(await ids()).not.toContain(session.id);
    expect(await ids('pi-agent')).not.toContain(session.id);
    expect(await ids('plugin-agents')).toContain(session.id);
    expect([await hits(), await hits('plugin-agents')]).toEqual([0, 1]);
    expect((await ask('GET', `/api/sessions/${session.id}/events`)).statusCode).toBe(404);
    expect((await ask('GET', `/api/sessions/${session.id}/events`, undefined, 'plugin-agents')).statusCode).toBe(200);
    expect((await ask('GET', '/api/settings')).json()).toMatchObject({ defaultBackendId: 'cursor' });
    expect((await ask('GET', '/api/settings')).json()).not.toHaveProperty('nativeBackendDefaults');
    expect((await ask('GET', '/api/settings', undefined, 'plugin-agents')).json()).toMatchObject({ defaultBackendId: 'acme.agent', nativeBackendDefaults: { 'acme.agent': { model: 'm' } } });
    expect((await ask('PATCH', '/api/settings', { defaultBackendId: 'acme.agent' })).json().error.code).toBe('INVALID_BACKEND');
    // The service monitor names a pane's conversation and Agent only to a client that can decode it.
    expect((await ask('GET', '/api/system/monitor')).json().processes).toEqual([{ pid: 2, kind: 'agent' }, { pid: 3, kind: 'agent', backendId: 'codex' }]);
    expect((await ask('GET', '/api/system/monitor', undefined, 'plugin-agents')).json().processes[0]).toMatchObject({ sessionId: 'plugin-session', backendId: 'acme.agent' });

    // The plugin is off: the saved default stays as it was, and a new conversation starts on an offered backend.
    offered.offeredBackendIds = () => ['pi', 'cursor', 'chat'];
    expect((await ask('GET', '/api/settings', undefined, 'plugin-agents')).json().defaultBackendId).toBe('cursor');
    offered.offeredBackendIds = () => ['pi', 'chat'];
    expect((await ask('GET', '/api/settings', undefined, 'plugin-agents,pi-agent')).json().defaultBackendId).toBe('pi');
  });

  it('creates old conversations on the compatible default and rejects an explicit pi request', async () => {
    const { ask, store, projectDir } = await boot({ defaultBackendId: 'pi' });
    const projectId = store.createProject(projectDir, 'pi-default').id;
    const input = { projectId, kind: 'native' as const };

    const created = await ask('POST', '/api/sessions', input);
    expect(created.statusCode).toBe(200);
    expect(created.json().backendId).toBe('cursor');
    const rejected = await ask('POST', '/api/sessions', { ...input, backendId: 'pi' });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.code).toBe('INVALID_BACKEND');

    const negotiated = await ask('POST', '/api/sessions', input, 'pi-agent');
    expect(negotiated.statusCode).toBe(200);
    expect(negotiated.json().backendId).toBe('pi');
    const explicit = await ask('POST', '/api/sessions', { ...input, backendId: 'pi' }, 'pi-agent');
    expect(explicit.statusCode).toBe(200);
    expect(explicit.json().backendId).toBe('pi');
  });

  it('trusts internal session creation without headers while an explicit empty header set falls back', async () => {
    const { store, settings, nativeBackends, projectDir } = await boot({ defaultBackendId: 'pi' });
    const project = store.createProject(projectDir, 'pi-internal');
    const deps = { store, settings, nativeBackends };

    expect((await resolveNativeSessionInput(deps, { projectId: project.id })).backendId).toBe('pi');
    expect((await resolveNativeSessionInput(deps, { projectId: project.id }, {})).backendId).toBe('cursor');
    await expect(resolveNativeSessionInput(deps, { projectId: project.id, backendId: 'pi' }, {})).rejects.toMatchObject({ code: 'INVALID_BACKEND' });
  });

  it('validates and stores terminal appearance independently of an accepted creation receipt', async () => {
    const { app, store, projectDir } = await boot();
    const project = store.createProject(projectDir, 'appearance');
    const payload = { projectId: project.id, kind: 'native', clientSessionId: 'appearance-receipt', initialMessage: { commandId: 'appearance-command', text: 'hello' } };
    const post = (appearance?: string, rejectedCase?: number) => app.inject({ method: 'POST', url: '/api/sessions',
      payload: rejectedCase === undefined ? payload : { ...payload, clientSessionId: `appearance-rejected-${rejectedCase}`, initialMessage: { ...payload.initialMessage, commandId: `rejected-command-${rejectedCase}` } },
      headers: appearance === undefined ? {} : { [TERMINAL_APPEARANCE_HEADER]: appearance } });
    const invalidAppearances = ['#fff;#000000', '#ffffff;#000000;#111111', '#GGGGGG;#000000', ' #ffffff;#000000', '#ffffff;#000000,fg=red'];
    for (const [index, invalid] of invalidAppearances.entries()) {
      const rejected = await post(invalid, index);
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json().error.code).toBe('INVALID_TERMINAL_APPEARANCE');
    }
    const first = await post('#AABBCC;#FDFDFD');
    expect(first.statusCode).toBe(202);
    expect(first.json().session.terminalAppearance).toEqual({ foreground: '#aabbcc', background: '#fdfdfd' });
    const retry = await post('#d2d4d7;#141416');
    expect(retry.statusCode).toBe(202);
    expect(retry.json().session.terminalAppearance).toEqual(first.json().session.terminalAppearance);
    const legacy = await app.inject({ method: 'POST', url: '/api/sessions', payload: { projectId: project.id, kind: 'native' } });
    // An unknown appearance is not guessed; the pane keeps tmux's defaults for each viewer's theme.
    expect(legacy.json().terminalAppearance).toBeUndefined();
  });

  it('preserves hidden pi settings when an old client saves visible ones', async () => {
    const { ask, settings } = await boot({ defaultBackendId: 'pi', nativeBackendDefaults: { pi: { model: 'pi-model', approval: 'read-only' }, cursor: { model: 'cursor-model' } } });
    const savedDefault = await ask('PATCH', '/api/settings', { defaultBackendId: 'cursor' });
    expect(savedDefault.statusCode).toBe(200);
    expect(savedDefault.json().defaultBackendId).toBe('cursor');
    expect(settings.getSettings().defaultBackendId).toBe('pi');

    const savedDefaults = await ask('PATCH', '/api/settings', { nativeBackendDefaults: { cursor: { model: 'cursor-next' } } });
    expect(savedDefaults.statusCode).toBe(200);
    expect(savedDefaults.json().nativeBackendDefaults).toEqual({ cursor: { model: 'cursor-next' } });
    expect(settings.getSettings().nativeBackendDefaults).toEqual({ pi: { model: 'pi-model', approval: 'read-only' }, cursor: { model: 'cursor-next' } });

    const explicitDefault = await ask('PATCH', '/api/settings', { defaultBackendId: 'pi' });
    expect(explicitDefault.statusCode).toBe(400);
    expect(explicitDefault.json().error.code).toBe('INVALID_BACKEND');
    const explicitDefaults = await ask('PATCH', '/api/settings', { nativeBackendDefaults: { pi: { model: 'new-model' } } });
    expect(explicitDefaults.statusCode).toBe(400);
    expect(explicitDefaults.json().error.code).toBe('INVALID_BACKEND');
    const cleared = await ask('PATCH', '/api/settings', { nativeBackendDefaults: null });
    expect(cleared.statusCode).toBe(400);
    expect(cleared.json().error.code).toBe('INVALID_SETTINGS');
    const auxiliary = await ask('PATCH', '/api/settings', { auxiliaryModels: { title: { backendId: 'pi', profileId: 'default', model: 'pi-model' } } });
    expect(auxiliary.statusCode).toBe(400);
    expect(auxiliary.json().error.code).toBe('INVALID_BACKEND');
  });

  it('falls back before running an unset automation target and filters hidden orchestration members', async () => {
    const { ask, store, projectDir, orchestration, runs, automations } = await boot({ defaultBackendId: 'pi' });
    const project = store.createProject(projectDir, 'template-compat');
    const piSession = store.createSession({ projectId: project.id, kind: 'native', backendId: 'pi', title: 'Pi attempt' });
    const cursorSession = store.createSession({ projectId: project.id, kind: 'native', backendId: 'cursor', title: 'Cursor attempt' });
    automations[2]!.projectId = project.id;
    automations[2]!.lastSessionId = piSession.id;
    const piAttempt = { sessionId: piSession.id, projectId: project.id, branch: 'pi', target: { backendId: 'pi' } };
    const cursorAttempt = { sessionId: cursorSession.id, projectId: project.id, branch: 'cursor', target: { backendId: 'cursor' } };
    orchestration.compareAttempts = async () => ({
      group: { id: 'group', projectId: project.id, prompt: 'p', base: 'b', createdAt: 'c', attempts: [piAttempt, cursorAttempt] },
      attempts: [{ ...piAttempt, state: 'idle' }, { ...cursorAttempt, state: 'idle' }],
    });

    const body = { projectId: project.id, clientSessionId: 'client', commandId: 'command' };
    expect((await ask('POST', '/api/automations/plain/run', body)).statusCode).toBe(202);
    expect(runs.at(-1)).toEqual({ backendId: 'cursor' });
    expect((await ask('POST', '/api/automations/plain/run', { ...body, clientSessionId: 'negotiated', commandId: 'negotiated' }, 'pi-agent')).statusCode).toBe(202);
    expect(runs.at(-1)).toEqual({ backendId: 'pi' });
    expect((await ask('POST', '/api/automations/pi-template/run', body)).json().error.code).toBe('INVALID_BACKEND');

    expect((await ask('POST', '/api/automations', { name: 'Hidden target', prompt: 'x', projectId: project.id, target: { backendId: 'pi' } })).json().error.code).toBe('INVALID_BACKEND');
    const patched = await ask('PATCH', '/api/automations/scheduled', { enabled: false });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).not.toHaveProperty('lastSessionId');
    const listed = await ask('GET', '/api/automations');
    expect(listed.json().map((item: { id: string }) => item.id)).toEqual(['plain', 'scheduled']);
    expect(listed.json()[1]).not.toHaveProperty('lastSessionId');
    // A project deleted since does not fail the whole list.
    automations[2]!.projectId = 'deleted-project';
    expect((await ask('GET', '/api/automations')).json()).toHaveLength(2);
    const fired = await ask('POST', '/api/automations/scheduled/run');
    expect(fired.statusCode).toBe(202);
    expect(fired.json()).not.toHaveProperty('sessionId');
    expect(runs.at(-1)).toEqual({ backendId: 'cursor' });

    const compared = await ask('GET', '/api/attempts/group');
    expect(compared.statusCode).toBe(200);
    expect(compared.json().attempts.map((item: { sessionId: string }) => item.sessionId)).toEqual([cursorSession.id]);
    expect(compared.json().group.attempts.map((item: { sessionId: string }) => item.sessionId)).toEqual([cursorSession.id]);
    expect(compared.body).not.toContain('"backendId":"pi"');
    expect((await ask('GET', '/api/attempts/group', undefined, 'pi-agent')).json().attempts).toHaveLength(2);
  });
});


describe('projectless client compatibility', () => {
  it('filters managed tasks before search limits and denies direct project and conversation references', async () => {
    const {ask, store, projectDir} = await boot();
    const ordinary = store.createProject(projectDir, 'ordinary');
    const managed = store.updateProject(store.createProject(join(projectDir,'task'), 'task').id, {system:'task-workspace'});
    const ordinarySession = store.createSession({projectId:ordinary.id,kind:'native',backendId:'cursor'});
    const task = store.createSession({projectId:managed.id,kind:'native',backendId:'cursor'});
    store.acceptNativeRun(ordinarySession.id,'visible',{text:'projectlessneedle ordinary',attachmentIds:[],context:[]},{mode:'agent'});
    store.acceptNativeRun(task.id,'hidden',{text:'projectlessneedle task',attachmentIds:[],context:[]},{mode:'agent'});
    const bootstrap=(await ask('GET','/api/bootstrap')).json();
    expect(bootstrap.projects.map((item:{id:string})=>item.id)).toEqual([ordinary.id]);
    expect(bootstrap.sessions.map((item:{id:string})=>item.id)).toEqual([ordinarySession.id]);
    expect((await ask('GET','/api/search/messages?q=projectlessneedle&limit=1')).json().hits.map((hit:{sessionId:string})=>hit.sessionId)).toEqual([ordinarySession.id]);
    expect((await ask('GET',`/api/projects/${managed.id}/files`)).statusCode).toBe(404);
    expect((await ask('GET',`/api/sessions/${task.id}/events`)).statusCode).toBe(404);
    expect((await ask('GET',`/api/backends/cursor/catalog?projectId=${managed.id}`)).statusCode).toBe(404);
    expect((await ask('POST','/api/automations/plain/run',{projectId:managed.id,clientSessionId:'new-task',commandId:'new-command'})).statusCode).toBe(404);
    expect((await ask('GET',`/api/sessions/${task.id}/events?features=projectless-tasks`)).statusCode).toBe(200);
    const negotiated=(await ask('GET','/api/bootstrap',undefined,'projectless-tasks')).json();
    expect(negotiated.projects).toHaveLength(2);
    expect(negotiated.sessions.map((item:{id:string})=>item.id)).toEqual(expect.arrayContaining([ordinarySession.id,task.id]));
    expect((await ask('GET','/api/sessions',undefined,'projectless-tasks')).json().map((item:{id:string})=>item.id)).toEqual(expect.arrayContaining([ordinarySession.id,task.id]));
    store.promoteTaskWorkspace(managed.id,'saved');
    expect((await ask('GET',`/api/sessions/${task.id}/events`)).statusCode).toBe(200);
  });

  it('queries global capabilities and uploads attachments without registering a project', async () => {
    const {ask,store}=await boot();
    const features='projectless-tasks';
    const catalog=await ask('GET','/api/backends/cursor/catalog?scope=global',undefined,features);
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json().models).toEqual([{value:'global-model'}]);
    expect((await ask('GET','/api/backends/cursor/usage?scope=global',undefined,features)).json().scope).toBe('global');
    expect((await ask('GET','/api/backends/cursor/slash?scope=global',undefined,features)).json().items[0].name).toBe('global-skill');
    expect((await ask('GET','/api/backends/cursor/catalog?scope=global&projectId=missing',undefined,features)).statusCode).toBeGreaterThanOrEqual(400);
    expect((await ask('GET','/api/backends/cursor/catalog?scope=global')).statusCode).toBe(409);
    const upload=await ask('POST','/api/attachments',{name:'input.txt',mimeType:'text/plain',dataBase64:Buffer.from('shared draft').toString('base64')},features);
    expect(upload.statusCode).toBe(200);
    expect((await ask('GET',`/api/attachments/${upload.json().id}`)).body).toBe('shared draft');
    expect(store.listProjects()).toEqual([]);
    expect(store.listSessions()).toEqual([]);
  });
});
