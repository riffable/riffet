import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchGatewayModels, gatewayModelsUrl } from './gateway-models.js';
import { piProviderExtension, piProviderModels } from '../pi/provider.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.unstubAllEnvs(); });

function respond(body: unknown): void {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
}

describe('gatewayModelsUrl', () => {
  it('appends the version segment when the endpoint omits it', () => {
    expect(gatewayModelsUrl('https://gw.example.com').toString()).toBe('https://gw.example.com/v1/models');
    expect(gatewayModelsUrl('https://gw.example.com/api/').toString()).toBe('https://gw.example.com/api/v1/models');
  });

  it('reuses an existing version segment instead of doubling it', () => {
    expect(gatewayModelsUrl('https://gw.example.com/v1').toString()).toBe('https://gw.example.com/v1/models');
    expect(gatewayModelsUrl('https://gw.example.com/openai/v2/').toString()).toBe('https://gw.example.com/openai/v2/models');
  });
});

describe('fetchGatewayModels', () => {
  it('follows a same-origin catalog redirect but never sends a Google key to another origin', async () => {
    let receivedAtOtherOrigin = 0;
    const sourceKeys: Array<string | string[] | undefined> = [];
    const target = createServer((_request, response) => {
      receivedAtOtherOrigin++;
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"models":[]}');
    });
    await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
    const destination = `http://127.0.0.1:${(target.address() as import('node:net').AddressInfo).port}/models`;
    const source = createServer((request, response) => {
      sourceKeys.push(request.headers['x-goog-api-key']);
      response.writeHead(302, { location: request.url === '/canonical/models' ? destination : '/canonical/models' }).end();
    });
    await new Promise<void>(resolve => source.listen(0, '127.0.0.1', resolve));
    try {
      const endpoint = `http://127.0.0.1:${(source.address() as import('node:net').AddressInfo).port}`;
      await expect(piProviderModels({ id: 'redirect', backendId: 'pi', name: 'Google', config: { apiEndpoint: endpoint, apiProtocol: 'google-generative-ai', apiKey: 'isolated-test-key' } })).rejects.toThrow('different origin');
      expect(sourceKeys).toEqual(['isolated-test-key', 'isolated-test-key']);
      expect(receivedAtOtherOrigin).toBe(0);
    } finally {
      source.closeAllConnections(); target.closeAllConnections();
      await Promise.all([new Promise<void>(resolve => source.close(() => resolve())), new Promise<void>(resolve => target.close(() => resolve()))]);
    }
  });

  it('passes a declared Google output limit to pi without changing the public model catalog', async () => {
    respond({ models: [{ name: 'models/small-output', displayName: 'Small Output', inputTokenLimit: 32768, outputTokenLimit: 1024, supportedGenerationMethods: ['generateContent'] }] });
    const profile = { id: 'google-limit', backendId: 'pi' as const, name: 'Google', isDefault: false, config: { apiEndpoint: 'https://google.example', apiProtocol: 'google-generative-ai' } };
    const directory = await mkdtemp(join(tmpdir(), 'riffet-pi-output-limit-'));
    try {
      const extension = await piProviderExtension(profile, directory);
      const source = await readFile(extension!.path, 'utf8');
      const module = await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
      const registerProvider = vi.fn();
      module.default({ registerProvider });
      expect(registerProvider).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
        api: 'google-generative-ai',
        models: [expect.objectContaining({ id: 'small-output', contextWindow: 32768, maxTokens: 1024 })],
      }));
      expect(await piProviderModels(profile)).toEqual([{ value: 'small-output', name: 'Small Output', configOptions: [], contextWindow: 32768 }]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('reads the shared envelope and prefers a display name', async () => {
    respond({ data: [{ id: 'gpt-x' }, { id: 'claude-y', display_name: 'Claude Y' }] });
    expect(await fetchGatewayModels({ baseUrl: 'https://gw.example.com' })).toEqual([
      { value: 'gpt-x', name: 'gpt-x', configOptions: [] },
      { value: 'claude-y', name: 'Claude Y', configOptions: [] },
    ]);
  });

  it('drops duplicate and unusable entries', async () => {
    respond({ data: [{ id: 'a' }, { id: 'a' }, { id: '' }, null, 'b'] });
    expect((await fetchGatewayModels({ baseUrl: 'https://gw.example.com' })).map(model => model.value)).toEqual(['a', 'b']);
  });

  it('preserves declared token limits and rejects invalid or guessed context windows', async () => {
    respond({ data: [
      { id: 'opensource/deepseek_v4_1_flash', display_name: 'DeepSeek V4.1 Flash', context_length: 1048576 },
      { id: 'runtime', runtime: { max_input_tokens: 32768 }, max_input_tokens: 65536, context_window: 131072, context_length: 262144 },
      { id: 'input', max_input_tokens: 65536, context_window: 131072 },
      { id: 'window', context_window: 131072 },
      { id: 'nested', metadata: { context_limit: 1048000 } },
      { id: 'fallback', runtime: { max_input_tokens: -1 }, max_input_tokens: 1.5, context_window: 65536 },
      ...[0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1048576'].map((context_length, index) => ({ id: `invalid-${index}`, context_length })),
      { id: 'unknown-1m' },
    ] });
    const models = await fetchGatewayModels({ baseUrl: 'https://gw.example.com' });
    expect(models.slice(0, 6).map(model => model.contextWindow)).toEqual([1048576, 32768, 65536, 131072, 1048000, 65536]);
    expect(models[0]).toMatchObject({ value: 'opensource/deepseek_v4_1_flash', name: 'DeepSeek V4.1 Flash' });
    expect(models.slice(6).every(model => model.contextWindow === undefined)).toBe(true);
    expect(models.every(model => model.configOptions.length === 0)).toBe(true);
  });

  it('sends a bearer header by default and Anthropic headers on request', async () => {
    const seen: Array<Record<string, string>> = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string>);
      return new Response('{"data":[]}', { status: 200 });
    }) as typeof fetch;
    await fetchGatewayModels({ baseUrl: 'https://gw.example.com', apiKey: 'secret' });
    await fetchGatewayModels({ baseUrl: 'https://gw.example.com', apiKey: 'secret', auth: 'anthropic' });
    expect(seen[0]?.authorization).toBe('Bearer secret');
    expect(seen[1]?.['x-api-key']).toBe('secret');
    expect(seen[1]?.authorization).toBeUndefined();
  });

  it('reports a rejecting gateway rather than pretending it has no models', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 401 })) as typeof fetch;
    await expect(fetchGatewayModels({ baseUrl: 'https://gw.example.com' })).rejects.toThrow(/401/);
  });

  it('lists an Anthropic pi gateway with Bearer and still accepts a native x-api-key directory', async () => {
    const seen: Array<Record<string, string>> = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      seen.push({ ...headers });
      const native = String(url).includes('native.example');
      const accepted = native ? headers['x-api-key'] === 'secret' : headers.authorization === 'Bearer secret';
      return new Response(JSON.stringify(accepted ? { data: [{ id: 'claude-test' }] } : { error: 'missing_api_key' }), { status: accepted ? 200 : 401 });
    }) as typeof fetch;
    for (const apiEndpoint of ['https://gateway.example', 'https://native.example']) {
      expect(await piProviderModels({ id: 'custom', backendId: 'pi', name: 'custom', config: {
        apiEndpoint, apiProtocol: 'anthropic-messages', apiKey: 'secret',
      } })).toMatchObject([{ value: 'claude-test' }]);
    }
    expect(seen).toHaveLength(3);
    expect(seen[0]?.authorization).toBe('Bearer secret');
    expect(seen[1]?.authorization).toBe('Bearer secret');
    expect(seen[2]?.authorization).toBeUndefined();
    expect(seen[2]?.['x-api-key']).toBe('secret');
  });

  it('limits the alternate auth scheme to one retry after a 401', async () => {
    const request = vi.fn(async () => new Response('denied', { status: 401 }));
    globalThis.fetch = request as typeof fetch;
    await expect(fetchGatewayModels({ baseUrl: 'https://gateway.example', apiKey: 'secret', fallbackAuth: 'anthropic' })).rejects.toThrow(/401/);
    expect(request).toHaveBeenCalledTimes(2);
    request.mockClear();
    request.mockImplementation(async () => new Response('forbidden', { status: 403 }));
    await expect(fetchGatewayModels({ baseUrl: 'https://gateway.example', apiKey: 'secret', fallbackAuth: 'anthropic' })).rejects.toThrow(/403/);
    expect(request).toHaveBeenCalledTimes(1);
    request.mockClear();
    request.mockImplementation(async () => {
      const response = new Response('denied', { status: 401 });
      Object.defineProperties(response, { redirected: { value: true }, url: { value: 'https://other.example/models' } });
      return response;
    });
    await expect(fetchGatewayModels({ baseUrl: 'https://gateway.example', apiKey: 'secret', fallbackAuth: 'anthropic' })).rejects.toThrow(/401/);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('fills the verified pi model effort gap while keeping declared ladders authoritative', async () => {
    const profile = { id: 'custom', backendId: 'pi' as const, name: 'custom', config: {
      apiEndpoint: 'https://gateway.example', apiProtocol: 'anthropic-messages', apiKey: 'secret',
    } };
    respond({ data: [{ id: 'deepseek-v4.1-flash' }, { id: 'unknown-model' }] });
    const models = await piProviderModels(profile);
    expect(models[0]?.configOptions[0]).toMatchObject({ id: 'effort', currentValue: 'off', options: [
      { value: 'off' }, { value: 'low' }, { value: 'medium' }, { value: 'high' },
    ] });
    expect(models[1]?.configOptions).toEqual([]);
    respond({ data: [{ id: 'deepseek-v4.1-flash', supported_reasoning_levels: ['low', 'high'], default_reasoning_level: 'high' }] });
    expect((await piProviderModels(profile))[0]?.configOptions[0]).toMatchObject({ currentValue: 'high', options: [{ value: 'low' }, { value: 'high' }] });
  });
});

describe('fetchGatewayModels reasoning levels', () => {
  it('maps the gateway ladder to an effort select when the caller opts in', async () => {
    respond({ data: [{ id: 'deepseek-x', context_length: 1048576, supported_reasoning_levels: ['low', 'high', 'max'], default_reasoning_level: 'high' }] });
    expect(await fetchGatewayModels({ baseUrl: 'https://gw.example.com', reasoningLevels: true })).toEqual([{
      value: 'deepseek-x',
      name: 'deepseek-x',
      contextWindow: 1048576,
      configOptions: [{
        id: 'effort', name: 'Reasoning effort', category: 'thought_level', type: 'select',
        currentValue: 'high',
        options: [{ value: 'low', name: 'low' }, { value: 'high', name: 'high' }, { value: 'max', name: 'max' }],
      }],
    }]);
  });

  it('keeps the ladder out of catalogs that did not ask for it', async () => {
    respond({ data: [{ id: 'claude-y', supported_reasoning_levels: ['low', 'high', 'max'] }] });
    expect(await fetchGatewayModels({ baseUrl: 'https://gw.example.com' })).toEqual([
      { value: 'claude-y', name: 'claude-y', configOptions: [] },
    ]);
  });

  it('invents no ladder when the gateway declares none', async () => {
    respond({ data: [{ id: 'plain', display_name: 'Plain' }] });
    expect(await fetchGatewayModels({ baseUrl: 'https://gw.example.com', reasoningLevels: true })).toEqual([
      { value: 'plain', name: 'Plain', configOptions: [] },
    ]);
  });

  it('falls back to the first level when the declared default is not offered', async () => {
    respond({ data: [{ id: 'odd', supported_reasoning_levels: ['medium'], default_reasoning_level: 'high' }] });
    const [model] = await fetchGatewayModels({ baseUrl: 'https://gw.example.com', reasoningLevels: true });
    expect(model?.configOptions[0]?.currentValue).toBe('medium');
  });
});
import { createServer } from 'node:http';
