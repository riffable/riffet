import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../errors.js';
import { BackendCatalog } from '../backends/catalog.js';
import { ClaudeBackendAdapter } from '../backends/claude/index.js';
import { CodexBackendAdapter } from '../backends/codex/index.js';
import { codexFlavor } from '../backends/codex/flavors.js';
import { DshBackendAdapter } from '../backends/dsh/index.js';
import { provideModelSources } from '../backends/shared/model-source.js';
import type { CodexAppServerClient, CodexAppServerOptions } from '../backends/shared/codex-app-server.js';
import { complete, GatewayHttpError, streamChat } from './gateway.js';
import { clearAuxiliaryAuthCache, completeForPlugin, listAuxiliaryModels, profileModelEndpoint, resolveAuxiliaryModel } from './models.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  clearAuxiliaryAuthCache();
  provideModelSources(() => []);
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const chat = { backendId: 'claude' as const, profileId: 'p', model: 'chat-model' };
const chosen = { backendId: 'claude' as const, profileId: 'p', model: 'translation-model' };
const profiles = () => [{ id: 'p', name: 'Gateway', config: { apiEndpoint: 'https://gateway.example', apiKey: 'k' } }] as never;
const uses = [{ id: 'acme.tr/translation', title: { en: 'Translation' }, fallback: 'chat' as const }, { id: 'acme.tr/strict', title: { en: 'Strict' } }];
const error = (code: string, message: string, status: number, details?: unknown) => new AppError(code, message, status, details);

describe('host.models.complete', () => {
  it('runs a declared use on its own choice, else its fallback, and refuses a use the plugin does not declare', async () => {
    const complete = vi.fn(async (request: { model: string }) => request.model);
    const run = (use: string | undefined, choices: { chat?: typeof chat; use?: typeof chosen }) => completeForPlugin(
      { ...(use ? { use } : {}), system: 's', content: 'c', maxOutputTokens: 100 }, uses,
      { chat: () => choices.chat, use: () => choices.use }, profiles, { complete: complete as never, error });
    await expect(run('acme.tr/translation', { chat, use: chosen })).resolves.toContain('translation-model');
    await expect(run('acme.tr/translation', { chat })).resolves.toContain('chat-model');
    await expect(run(undefined, { chat, use: chosen })).resolves.toContain('chat-model');
    await expect(run('acme.tr/strict', { chat })).rejects.toMatchObject({ code: 'PLUGIN_MODEL_NOT_CHOSEN', statusCode: 409, details: { use: 'acme.tr/strict' } });
    await expect(run('other.plugin/translation', { chat, use: chosen })).rejects.toMatchObject({ code: 'PLUGIN_MODEL_USE_FOREIGN', statusCode: 403 });
    expect(complete).toHaveBeenCalledTimes(3);
  });

  it('decouples default fallback from chat and resolves auxiliary purposes via auxiliaryModels.default', async () => {
    const def = { backendId: 'claude' as const, profileId: 'p', model: 'fast-default' };
    const defaultUses = [{ id: 'acme.tr/translation', title: { en: 'Translation' }, fallback: 'default' as const }];
    const complete = vi.fn(async (request: { model: string }) => request.model);
    await expect(completeForPlugin(
      { use: 'acme.tr/translation', system: 's', content: 'c', maxOutputTokens: 100 },
      defaultUses,
      { default: () => undefined, chat: () => chat, use: () => undefined },
      profiles,
      { complete: complete as never, error },
    )).rejects.toMatchObject({ code: 'PLUGIN_MODEL_NOT_CHOSEN', statusCode: 409 });
    await expect(completeForPlugin(
      { use: 'acme.tr/translation', system: 's', content: 'c', maxOutputTokens: 100 },
      defaultUses,
      { default: () => def, chat: () => chat, use: () => undefined },
      profiles,
      { complete: complete as never, error },
    )).resolves.toBe('fast-default');
    expect(resolveAuxiliaryModel({ auxiliaryModels: { default: def, chat } }, 'title')).toEqual(def);
    expect(resolveAuxiliaryModel({ auxiliaryModels: { default: def, title: chosen } }, 'title')).toEqual(chosen);
  });

  it('caches command credentials for repeated completions and refreshes once on 401', async () => {
    let minted = 0;
    const cmdProfiles = () => [{
      id: 'p', name: 'Gateway',
      config: { apiEndpoint: 'https://gateway.example', gatewayCredentialCommand: 'echo tok' },
    }] as never;
    // Use static mock via complete rejecting 401 once
    let attempts = 0;
    const runComplete = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new GatewayHttpError(401, 'model returned HTTP 401');
      return 'ok';
    });
    const result = await completeForPlugin(
      { system: 's', content: 'c', maxOutputTokens: 100 },
      uses,
      { chat: () => ({ backendId: 'claude', profileId: 'p', model: 'm' }), use: () => undefined },
      () => { minted += 1; return [{ id: 'p', name: 'Gateway', config: { apiEndpoint: 'https://gateway.example', apiKey: `k-${minted}` } }] as never; },
      { complete: runComplete as never, error },
    );
    expect(result).toBe('ok');
    expect(runComplete).toHaveBeenCalledTimes(2);
    expect(cmdProfiles).toBeTypeOf('function');
  });
});

describe('CLI default provider auxiliary models', () => {
  it('resolves Claude default profile from settings.json, sends anthropic-version on api.anthropic.com, and runs apiKeyHelper', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'riffet-claude-aux-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    vi.stubEnv('CLAUDE_CONFIG_DIR', dir);
    await writeFile(join(dir, 'settings.json'), JSON.stringify({
      model: 'claude-sonnet-4-6',
      env: { ANTHROPIC_API_KEY: 'sk-ant-owner' },
    }));

    const driver = new ClaudeBackendAdapter();
    const catalog = new BackendCatalog({ require: (id: string) => { if (id === 'claude') return driver; throw new Error(`unexpected ${id}`); } } as never, {} as never, {}, () => ({}) as never);
    const profiles = catalog.gatewayProfiles('claude');
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.id).toBe('local');
    expect(profiles[0]?.config.apiEndpoint).toBe('https://api.anthropic.com');

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: 'claude-sonnet-4-6' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const listed = await listAuxiliaryModels(id => id === 'claude' ? catalog.gatewayProfiles(id) : []);
    expect(listed).toEqual([{ backendId: 'claude', profileId: 'local', profileName: 'Claude Code CLI', model: 'claude-sonnet-4-6', transport: 'http' }]);
    expect(fetchSpy.mock.calls[0]?.[1]?.headers).toMatchObject({
      'x-api-key': 'sk-ant-owner',
      'anthropic-version': '2023-06-01',
    });

    // Multi-vendor relays with an explicit ANTHROPIC_MODEL use that configured model instead of dumping the full catalog.
    await writeFile(join(dir, 'settings.json'), JSON.stringify({
      model: 'fable',
      env: { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api', ANTHROPIC_AUTH_TOKEN: 'or-token', ANTHROPIC_MODEL: 'anthropic/claude-sonnet-5' },
    }));
    expect(await listAuxiliaryModels(id => id === 'claude' ? catalog.gatewayProfiles(id) : [])).toEqual([
      { backendId: 'claude', profileId: 'local', profileName: 'Claude Code CLI', model: 'anthropic/claude-sonnet-5', transport: 'http' },
    ]);
    const aliasEndpoint = await profileModelEndpoint({ backendId: 'claude', profileId: 'local', model: 'sonnet' }, catalog.gatewayProfiles('claude')[0]!);
    expect(aliasEndpoint.model).toBe('anthropic/claude-sonnet-5');

    // Without ANTHROPIC_MODEL on a multi-vendor relay, only Claude models are kept from /v1/models.
    await writeFile(join(dir, 'settings.json'), JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api', ANTHROPIC_AUTH_TOKEN: 'or-token' },
    }));
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      data: [{ id: 'openai/gpt-6.2-astra' }, { id: 'anthropic/claude-opus-4-6' }, { id: 'tencent/hy4-flash' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    expect(await listAuxiliaryModels(id => id === 'claude' ? catalog.gatewayProfiles(id) : [])).toEqual([
      { backendId: 'claude', profileId: 'local', profileName: 'Claude Code CLI', model: 'anthropic/claude-opus-4-6', transport: 'http' },
    ]);

    await writeFile(join(dir, 'settings.json'), JSON.stringify({
      apiKeyHelper: `printf '%s' 'helper-secret'`,
      env: { ANTHROPIC_BASE_URL: 'https://relay.example/anthropic', ANTHROPIC_MODEL: 'sonnet' },
    }));
    const helperEndpoint = await profileModelEndpoint({ backendId: 'claude', profileId: 'local', model: 'claude-sonnet-4-6' }, catalog.gatewayProfiles('claude')[0]!);
    expect(helperEndpoint).toMatchObject({ protocol: 'anthropic', baseUrl: 'https://relay.example/anthropic', apiKey: 'helper-secret' });
    // Bare CLI aliases are not listed when the gateway's /v1/models fails.
    fetchSpy.mockResolvedValueOnce(new Response('not found', { status: 404 }));
    expect(await listAuxiliaryModels(id => id === 'claude' ? catalog.gatewayProfiles(id) : [])).toEqual([]);
  });

  it('resolves Codex default profile from config.toml and auth.json, and DSH with DEEPSEEK_API_KEY', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'riffet-codex-aux-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    vi.stubEnv('CODEX_HOME', dir);
    await writeFile(join(dir, 'config.toml'), [
      'model = "gpt-5.4"',
      'model_provider = "custom"',
      '',
      '[model_providers.custom]',
      'base_url = "https://codex-gw.example/v1"',
      'wire_api = "responses"',
      'env_key = "CUSTOM_CODEX_KEY"',
      '',
      '[model_providers.custom.http_headers]',
      'X-Client = "codex-cli"',
    ].join('\n'));
    await writeFile(join(dir, 'auth.json'), JSON.stringify({ CUSTOM_CODEX_KEY: 'codex-key' }));

    const codex = new CodexBackendAdapter(undefined, codexFlavor);
    const dsh = new DshBackendAdapter();
    vi.stubEnv('DEEPSEEK_API_KEY', 'ds-key');
    const catalog = new BackendCatalog({
      require: (id: string) => {
        if (id === 'codex') return codex;
        if (id === 'dsh') return dsh;
        throw new Error(`unexpected ${id}`);
      },
    } as never, {} as never, {}, () => ({}) as never);

    const codexProfiles = catalog.gatewayProfiles('codex');
    expect(codexProfiles).toHaveLength(1);
    const endpoint = await profileModelEndpoint({ backendId: 'codex', profileId: 'local', model: 'gpt-5.4' }, codexProfiles[0]!);
    expect(endpoint).toMatchObject({ protocol: 'responses', baseUrl: 'https://codex-gw.example/v1', apiKey: 'codex-key', headers: { 'X-Client': 'codex-cli' } });
    // Falls back to config.toml's model when /v1/models fails.
    expect(await listAuxiliaryModels(id => id === 'codex' ? catalog.gatewayProfiles(id) : [], { listModels: async () => { throw new Error('no catalog'); } })).toEqual([
      { backendId: 'codex', profileId: 'local', profileName: 'Codex CLI', model: 'gpt-5.4', transport: 'http' },
    ]);

    const dshProfiles = catalog.gatewayProfiles('dsh');
    expect(dshProfiles).toHaveLength(1);
    expect(dshProfiles[0]?.config.apiEndpoint).toBe('https://api.deepseek.com');
  });

  it('keeps adapter profiles eligible even when their credential lives in the adapter plugin', () => {
    const dsh = new DshBackendAdapter();
    provideModelSources(() => [{
      id: 'litellm', role: 'adapter', label: 'LiteLLM', protocols: ['openai-chat'],
      resolve: () => ({ endpoints: { 'openai-chat': { baseUrl: 'https://litellm.example/v1' } }, credential: { kind: 'static', key: 'plugin-secret' } }),
      catalog: async () => [],
    }], undefined, () => 'adapter');
    const catalog = new BackendCatalog({ require: () => dsh } as never, {} as never, {
      profiles: {
        get: () => ({ profiles: [{ id: 'local', backendId: 'dsh', name: 'LiteLLM', modelSource: 'litellm' }] }),
        getConfig: () => ({ modelSource: 'litellm' }),
      } as never,
    }, () => ({}) as never);
    expect(catalog.gatewayProfiles('dsh').map(item => item.id)).toEqual(['local']);
  });

  it('lists and executes Codex CLI via ephemeral app-server when logged in with ChatGPT OAuth', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'riffet-codex-oauth-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    vi.stubEnv('CODEX_HOME', dir);
    await writeFile(join(dir, 'auth.json'), JSON.stringify({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: { access_token: 'chatgpt-access', refresh_token: 'chatgpt-refresh' },
    }));

    const requests: Array<{ method: string; params: unknown }> = [];
    const startServer = async (options: CodexAppServerOptions): Promise<CodexAppServerClient> => ({
      remoteAddress: 'unix:///mock',
      isOnline: true,
      request: async <T>(method: string, params?: unknown) => {
        requests.push({ method, params });
        if (method === 'model/list') return { data: [{ model: 'gpt-6.1-sol' }, { model: 'gpt-6-astra' }] } as T;
        if (method === 'config/read') return { config: {} } as T;
        if (method === 'thread/start') return { thread: { id: 'ephemeral-thread' } } as T;
        if (method === 'turn/start') {
          queueMicrotask(() => {
            options.onNotification('item/agentMessage/delta', { threadId: 'ephemeral-thread', delta: 'Hello ' });
            options.onNotification('item/agentMessage/delta', { threadId: 'ephemeral-thread', delta: 'world' });
            options.onNotification('turn/completed', { threadId: 'ephemeral-thread', turn: { id: 'ephemeral-turn', status: 'completed' } });
          });
          return { turn: { id: 'ephemeral-turn' } } as T;
        }
        return {} as T;
      },
      notify: () => undefined,
      respond: () => undefined,
      dispose: async () => undefined,
    });

    const codex = new CodexBackendAdapter(startServer, codexFlavor);
    const catalog = new BackendCatalog({ require: () => codex } as never, {} as never, {}, () => ({}) as never);
    const profiles = (id: Parameters<typeof catalog.gatewayProfiles>[0]) => id === 'codex' ? catalog.gatewayProfiles(id) : [];

    expect(await listAuxiliaryModels(profiles)).toEqual([
      { backendId: 'codex', profileId: 'local', profileName: 'Codex CLI', model: 'gpt-6.1-sol', transport: 'cli-process' },
      { backendId: 'codex', profileId: 'local', profileName: 'Codex CLI', model: 'gpt-6-astra', transport: 'cli-process' },
    ]);

    const endpoint = await profileModelEndpoint({ backendId: 'codex', profileId: 'local', model: 'gpt-6.1-sol' }, profiles('codex')[0]!);
    expect(await complete({ ...endpoint, system: 'Sys', content: 'Hi', maxOutputTokens: 100, timeoutMs: 5_000 })).toBe('Hello world');

    const deltas: string[] = [];
    const streamed = await streamChat({
      ...endpoint,
      system: 'Sys',
      messages: [{ role: 'user', content: 'Hi' }],
      maxOutputTokens: 100,
      idleTimeoutMs: 5_000,
      onDelta: (kind, delta) => deltas.push(`${kind}:${delta}`),
    });
    expect(streamed.text).toBe('Hello world');
    expect(deltas).toEqual(['text:Hello ', 'text:world']);
    expect(requests.find(item => item.method === 'thread/start')?.params).toMatchObject({
      ephemeral: true,
      approvalPolicy: 'never',
      sandbox: 'read-only',
    });
  });
});
