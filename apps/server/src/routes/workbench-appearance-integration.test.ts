import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import { defineRead } from '../assistant-capability.js';
import { CapabilityCatalog } from '../riffet-mcp/capability-catalog.js';
import { createApp } from '../app.js';
import { ASSISTANT_QUERY_BUDGET } from '../../../../packages/contracts/src/budgets.js';
import { THEME_ANSI_KEYS, THEME_ROLES, WEB_BUILTIN_THEMES, type ThemePalette } from '../../../../packages/contracts/src/theme.js';
import type { Run } from '../../../../packages/contracts/src/run.js';

it('routes assistant appearance changes from an accepted Web turn through MCP to its originating workbench', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'riffet-workbench-appearance-integration-'));
  const webRoot = join(temporary, 'web');
  await mkdir(webRoot);
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><html><head><title>Riffet</title></head><body></body></html>');
  const token = 'workbench-appearance-test-access-token';
  const { app, store, dispatch, nativeBackends, riffetMcp, settings, themes, plugins } = await createApp({
    stateDir: join(temporary, 'state'), webRoot, token, cliPath: '/nonexistent/cursor-agent', plugins: [],
  });
  const kick = vi.spyOn(dispatch, 'kick').mockImplementation(() => undefined);
  const status = vi.spyOn(nativeBackends, 'status');
  let socket: Awaited<ReturnType<typeof app.injectWS>> | undefined;
  const host = { host: 'localhost', origin: 'https://localhost' };
  const navigation = { ...host, 'x-forwarded-proto': 'https', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
  const nativeSessionId = 'native-session';
  const next = async (connection: NonNullable<typeof socket>) => {
    const [frame] = await once(connection, 'message');
    return JSON.parse(frame.toString());
  };
  const running = (run: Run) => {
    const turnId = `native-${run.id}`;
    store.transitionNativeRun(run.id, ['queued'], { delivery: 'observed', nativeSessionId, nativeTurnId: turnId }, { state: 'running' });
    status.mockReturnValue({ phase: 'busy', activeTurn: { nativeSessionId, turnId, ownerRunId: run.id } });
  };
  try {
    await app.ready();
    const signIn = await app.inject({ method: 'POST', url: '/api/auth/login', headers: host, payload: { token } });
    expect(signIn.statusCode).toBe(200);
    const headers = { ...host, cookie: String(signIn.headers['set-cookie']).split(';')[0], 'x-csrf-token': signIn.json().csrfToken as string };
    const document = await app.inject({ url: '/', headers: { ...headers, ...navigation } });
    expect(document.statusCode).toBe(200);
    expect(document.headers['cross-origin-opener-policy']).toBe('same-origin');
    const documentProof = document.body.match(/name="riffet-workbench-proof" content="([^"]+)"/)?.[1];
    expect(documentProof).toBeTruthy();
    const fetched = await app.inject({ url: '/', headers: { ...headers, 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' } });
    expect(fetched.body).not.toContain('riffet-workbench-proof');

    socket = await app.injectWS('/api/workbench/appearance', { headers });
    const ready = next(socket);
    socket.send(JSON.stringify({ documentProof }));
    const { connectionId } = await ready;
    const web = { ...headers, 'x-riffet-workbench': connectionId as string };
    let received = 0;
    socket.on('message', () => { received++; });
    const project = store.listProjects().find(project => project.system === 'assistant')!;
    const warm = riffetMcp.provisional(project.id)!;
    warm.revoke();
    const created = await app.inject({
      method: 'POST', url: '/api/sessions', headers: web, payload: {
        kind: 'native', projectId: project.id, backendId: 'codex', clientSessionId: 'assistant-main',
        initialMessage: { commandId: 'first', text: '把 Riffet 工作台换成 Solarized' },
      },
    });
    expect(created.statusCode, created.body).toBe(202);
    const first = created.json().run as Run;
    expect(riffetMcp.signature(first.sessionId)).toBe(warm.signature);
    const mcp = async (sessionId: string) => {
      const credentialPath = riffetMcp.server(sessionId)!.args.at(-1)!;
      const { credential } = JSON.parse(await readFile(credentialPath, 'utf8')) as { credential: string };
      return async (name: string, args: Record<string, unknown>) => (await app.inject({
        method: 'POST', url: '/api/riffet-mcp', headers: { host: host.host, authorization: `Bearer ${credential}` },
        payload: { method: 'tools/call', params: { name, arguments: args } },
      })).json().result;
    };
    const rpc = await mcp(first.sessionId);
    const projectSession = store.createSession({ kind: 'native', projectId: store.createProject(temporary, 'Project').id, backendId: 'codex' });
    const projectRpc = await mcp(projectSession.id);
    const unavailable = { isError: true, content: [{ type: 'text', text: expect.stringContaining('WORKBENCH_UNAVAILABLE') }] };
    expect(await rpc('workbench_appearance_set', { themeId: 'solarized' })).toMatchObject(unavailable);
    running(first);
    expect(await projectRpc('workbench_appearance_set', { themeId: 'solarized' })).toMatchObject({
      isError: true, content: [{ type: 'text', text: expect.stringContaining('TOOL_NOT_AVAILABLE') }],
    });
    // Discovery does not grant ordinary callers access, and an ID discovered as a read cannot name a mutation.
    expect(await projectRpc('capability_find', {})).toMatchObject({isError:true});
    expect(await projectRpc('capability_read', {id:'workbench.identity'})).toMatchObject({isError:true});
    expect(await rpc('capability_find', {domain:'workbench'})).toMatchObject({structuredContent:{capabilities:expect.arrayContaining([expect.objectContaining({id:'workbench.attention'})])}});
    expect(await rpc('capability_read', {id:'setting_set',arguments:{}})).toMatchObject({isError:true});
    expect(await rpc('setting_set', {setting:'allowOutsideRead',value:true,expectedValue:false})).toMatchObject({isError:true});
    expect(await rpc('setting_set', {setting:'composerSendLater',value:true,expectedValue:false})).toMatchObject({structuredContent:{scope:'instance',changed:true,value:true}});
    expect(await rpc('setting_set', {setting:'composerSendLater',value:true,expectedValue:false})).toMatchObject({structuredContent:{changed:false}});
    expect(await rpc('capability_read', {id:'settings.catalog',arguments:{section:'interaction'}})).toMatchObject({structuredContent:{settings:expect.arrayContaining([expect.objectContaining({id:'composerSendLater',value:true})])}});
    expect(await rpc('task_continue', {text:'unrelated'})).toMatchObject({isError:true});
    const provider = nativeBackends.catalog.validateProfile('codex');
    const capabilities = await nativeBackends.catalog.capabilitiesFor('codex', provider.id);
    const model = 'model-for-confirmation-test';
    const nextModel = 'another-model-for-confirmation-test';
    const profile = { id: provider.id, backendId: provider.backendId, name: provider.name, isDefault: true };
    const entry = { backendId: 'codex' as const, label: 'Codex', available: true, profiles: [profile], capabilities,
      models: [{ value: model, name: 'Test model', configOptions: [] }, { value: nextModel, name: 'Another model', configOptions: [] }] };
    vi.spyOn(nativeBackends.catalog, 'entry').mockResolvedValue(entry);
    vi.spyOn(nativeBackends.catalog, 'listBackends').mockResolvedValue([entry]);
    settings.setSettings({ nativeBackendDefaults: { codex: { approval: 'read-only' } } });
    const defaults = () => settings.getSettings().nativeBackendDefaults?.codex;
    expect(await rpc('capability_find', { query: '默认模型' })).toMatchObject({ structuredContent: { capabilities: expect.arrayContaining([expect.objectContaining({ id: 'settings.agent_defaults' })]) } });
    expect(await rpc('capability_read', { id: 'settings.agent_defaults', arguments: { backendId: 'codex' } })).toMatchObject({
      structuredContent: { models: { items: expect.arrayContaining([{ id: model, name: 'Test model' }]) } },
    });
    expect(await projectRpc('agent_defaults_set', { action: 'propose', backendId: 'codex', model })).toMatchObject({ isError: true });
    const propose = async (selected = model) => {
      const result = await rpc('agent_defaults_set', { action: 'propose', backendId: 'codex', model: selected, makeDefaultAgent: true });
      expect(result).toMatchObject({ structuredContent: { status: 'confirmation_required', after: { configuredModel: selected, defaultAgentId: 'codex' } } });
      return result.structuredContent.confirmation.text as string;
    };
    const confirmation = await propose();
    expect(defaults()?.model).toBeUndefined();
    expect(await rpc('agent_defaults_set', { action: 'apply', confirm: true })).toMatchObject({ isError: true });
    expect(await rpc('agent_defaults_set', { action: 'apply' })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('SETTING_CONFIRMATION_REQUIRED') }] });
    const exchange = async (name: string, change: Record<string, unknown>, result: { mode: string; themeId: string; activePaletteId?: string }) => {
      const command = next(socket!);
      const reply = rpc(name, { ...change });
      const frame = await Promise.race([command, reply.then(response => { throw new Error(JSON.stringify(response)); })]);
      expect(frame.change).toEqual(change);
      const receipt = { ...result, themes: [{ id: 'solarized', name: 'Solarized' }] };
      socket!.send(JSON.stringify({ callId: frame.callId, result: receipt }));
      expect(await reply).toMatchObject({ structuredContent: receipt });
    };
    await exchange('workbench_appearance_get', {}, { themeId: 'riffet', mode: 'system', activePaletteId: 'plugin-edb0a342ef980623' });
    await exchange('workbench_appearance_set', { themeId: 'solarized' }, { themeId: 'solarized', mode: 'system' });
    store.updateRun(first.id, { state: 'completed' });
    expect(await rpc('workbench_appearance_set', { mode: 'dark' })).toMatchObject(unavailable);

    const send = async (commandId: string, target: typeof headers, text = '把 Riffet 工作台设为深色') => {
      const response = await app.inject({
        method: 'POST', url: `/api/sessions/${first.sessionId}/native/send`, headers: target,
        payload: { commandId, text },
      });
      expect(response.statusCode, response.body).toBe(202);
      const returned = response.json() as Run;
      expect(returned.sessionId).toBe(first.sessionId);
      return returned;
    };
    const unbound = await send('second', headers, confirmation);
    expect((await send('second', web, confirmation)).id).toBe(unbound.id);
    running(unbound);
    const sharedTheme = { id: 'custom-theme-for-test', name: 'Library palette' };
    const palette = (color: string) => Object.fromEntries(THEME_ROLES.map(role => [role, color])) as ThemePalette;
    const customTheme = {
      ...sharedTheme, palette: { light: palette('#ffffff'), dark: palette('#101010') },
      ansi: { light: THEME_ANSI_KEYS.map(() => '#ffffff'), dark: THEME_ANSI_KEYS.map(() => '#101010') },
    };
    await themes.replaceLibrary({
      expectedRevision: themes.getLibrary().revision,
      themes: [customTheme],
    });
    const assets = join(temporary, 'assets');
    await mkdir(assets);
    await writeFile(join(assets, 'palette.json'), JSON.stringify(customTheme));
    const pluginPalette = { id: 'example.palette/ink', name: '插件墨色' };
    vi.spyOn(plugins, 'appearanceSources').mockReturnValue([
      { id: 'example.palette', root: temporary, appearance: { palettes: [
        { id: pluginPalette.id, title: { 'zh-Hans': pluginPalette.name, en: 'Plugin Ink' }, asset: 'assets/palette.json' },
        { id: 'example.palette/missing', title: { en: 'Missing' }, asset: 'assets/missing.json' },
      ] } },
    ]);
    const webThemes = 'settings.web_themes';
    expect(await rpc('capability_find', { query: '可选主题' })).toMatchObject({
      structuredContent: { capabilities: expect.arrayContaining([expect.objectContaining({ id: webThemes })]) },
    });
    const catalog = await rpc('capability_read', { id: webThemes, arguments: { locale: 'zh-Hans' } });
    expect(catalog.structuredContent).toEqual({
      scope: 'riffet-web', builtinThemes: WEB_BUILTIN_THEMES, sharedThemes: [sharedTheme], pluginPalettes: [pluginPalette],
    });
    expect(await rpc('capability_read', { id: webThemes, arguments: { locale: 'en-GB' } })).toMatchObject({
      structuredContent: { pluginPalettes: [{ id: pluginPalette.id, name: 'Plugin Ink' }] },
    });
    expect(await projectRpc('capability_read', { id: webThemes })).toMatchObject({ isError: true });
    expect(await rpc('workbench_appearance_get', {})).toMatchObject(unavailable);
    expect(await rpc('agent_defaults_set', { action: 'apply' })).toMatchObject(unavailable);
    expect(await rpc('workbench_appearance_set', { mode: 'dark' })).toMatchObject(unavailable);

    const followup = await send('third', web);
    expect(await rpc('workbench_appearance_set', { mode: 'dark' })).toMatchObject(unavailable);
    store.updateRun(unbound.id, { state: 'completed' });
    running(followup);
    await exchange('workbench_appearance_set', { mode: 'dark' }, { themeId: 'solarized', mode: 'dark' });
    expect(received).toBe(3);

    const confirmed = await send('fourth', web, await propose());
    store.updateRun(followup.id, { state: 'completed' });
    running(confirmed);
    const apply = () => rpc('agent_defaults_set', { action: 'apply' });
    expect(await apply()).toMatchObject({ structuredContent: { status: 'applied', changed: true } });
    expect(await apply()).toMatchObject({ structuredContent: { status: 'applied', changed: false } });
    expect(defaults()).toMatchObject({ model, approval: 'read-only' });
    expect(settings.getSettings().defaultBackendId).toBe('codex');
    const conflicting = await send('fifth', web, await propose(nextModel));
    store.updateRun(confirmed.id, { state: 'completed' });
    running(conflicting);
    settings.setSettings({ nativeBackendDefaults: { codex: { ...defaults(), model: 'owner-concurrent-edit' } } });
    const stale = () => rpc('agent_defaults_set', { action: 'apply' });
    expect(await stale()).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('SETTINGS_CONFLICT') }] });
    const later = Date.now() + ASSISTANT_QUERY_BUDGET.settingConfirmationMs + 1;
    const time = vi.spyOn(Date, 'now').mockReturnValue(later);
    try {
      expect(await stale()).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('SETTING_CONFIRMATION_EXPIRED') }] });
    } finally { time.mockRestore(); }
    expect(defaults()?.model).toBe('owner-concurrent-edit');
    // Simulate a catalog-only upgrade. A warm process keeps the exact same MCP tools and
    // signature, but its original credential can discover and read a newly registered query.
    riffetMcp.registerCapabilities(new CapabilityCatalog([]));
    const previousSignature = riffetMcp.signature(first.sessionId);
    const extra = defineRead('example.read','Example query',['example'],z.strictObject({}),id=>({sessionId:id}));
    riffetMcp.registerCapabilities(new CapabilityCatalog([extra]));
    expect(riffetMcp.signature(first.sessionId)).toBe(previousSignature);
    expect(await rpc('capability_read',{id:'example.read'})).toMatchObject({structuredContent:{sessionId:first.sessionId}});
  } finally {
    socket?.terminate();
    status.mockRestore();
    kick.mockRestore();
    await app.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
