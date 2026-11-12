// The resolution boundary: a saved profile in, the facts a driver puts on the wire out.
//
// Profiles saved before sources moved into plugins name them by id alone, so the built-in
// providers must resolve those ids exactly as the core did — same base URLs, same credential
// mechanism, same headers. These run against the built-in list through the registry, skipped in a
// build that leaves those plugins out.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { codexFlavor } from '../codex/flavors.js';
import type { ModelSourceProvider } from '@riffet/plugin-api';
import { modelSourceOf, provideModelSources, resolveSource, sourceCatalog, sourceUsage } from './model-source.js';
import { profileChatModels, profileModelEndpoint } from '../../auxiliary/models.js';
import { streamChat } from '../../auxiliary/gateway.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.unstubAllEnvs(); provideModelSources(() => []); });

describe('without integrations', () => {
  it('activates before reading source quota and passes only the selected profile overrides', async () => {
    const usage = vi.fn(async () => ({ models: {}, fetchedAt: '2026-11-12T00:00:00Z' }));
    let provider: ModelSourceProvider = { id: 'fixture-source', label: 'Fixture', resolve: () => ({}), catalog: async () => [] };
    const activate = vi.fn(async () => { provider = { ...provider, usage }; });
    provideModelSources(() => [provider], activate);
    expect(await sourceUsage('fixture-source', { apiEndpoint: ' https://gateway.example/prefix/v1 ', apiKey: ' selected-key ', ignored: 'private' }))
      .toEqual({ models: {}, fetchedAt: '2026-11-12T00:00:00Z' });
    expect(activate).toHaveBeenCalledWith('fixture-source');
    expect(usage).toHaveBeenCalledExactlyOnceWith({ apiEndpoint: 'https://gateway.example/prefix/v1', apiKey: 'selected-key' });
    provideModelSources(() => [{ ...provider, usage: undefined }]);
    expect(await sourceUsage('fixture-source', {})).toBeUndefined();
    provideModelSources(() => []);
    await expect(sourceUsage('fixture-source', {})).rejects.toThrow('当前不可用');
  });

  it('uses a side chat source endpoint, fresh command credential and headers on the model request', async () => {
    const ref = { backendId: 'codex' as const, profileId: 'source-profile', model: 'source-model' };
    let token = 'first-token';
    provideModelSources(() => [{ id: 'fixture-source', label: 'Fixture', backends: ['codex'],
      resolve: () => ({ codexBaseUrl: 'https://source.example/v2', credential: { kind: 'command', command: process.execPath, args: ['-e', `process.stdout.write(${JSON.stringify(token)})`] }, headers: { codex: { 'X-Source-Client': 'codex' } } }),
      catalog: async () => [{ value: 'source-model', name: 'Source model', configOptions: [{ id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'xhigh', options: [{ value: 'low', name: 'low' }, { value: 'xhigh', name: 'xhigh' }] }] }],
    }]);
    const profile = { id: ref.profileId, backendId: ref.backendId, name: 'Source', config: { modelSource: 'fixture-source' } };
    const first = await profileModelEndpoint(ref, profile);
    token = 'next-token';
    const next = await profileModelEndpoint(ref, profile);
    expect(first.apiKey).toBe('first-token');
    expect(next.apiKey).toBe('next-token');
    expect((await profileChatModels(ref, profile, { effort: 'xhigh' }))[0]).toMatchObject({ value: 'codex:source-profile:source-model', configOptions: [{ currentValue: 'xhigh' }] });
    const unlisted = { ...ref, model: 'unlisted-model' };
    const picker = await profileChatModels(unlisted, profile, { effort: 'xhigh' });
    expect(picker[0]).toMatchObject({ value: 'codex:source-profile:unlisted-model', configOptions: [{ currentValue: 'xhigh', options: [{ value: 'default', name: 'Default' }, { value: 'xhigh', name: 'xhigh' }] }] });
    expect((await profileChatModels(unlisted, profile)).map(model => model.value)).toEqual(['codex:source-profile:source-model']);
    const fetchImpl = vi.fn(async () => new Response('data: {"type":"response.completed","response":{"status":"completed"}}\n\n', { headers: { 'content-type': 'text/event-stream' } }));
    await streamChat({ ...next, effort: 'xhigh', messages: [{ role: 'user', content: 'Question' }], maxOutputTokens: 100, idleTimeoutMs: 1000, onDelta: () => {}, fetchImpl: fetchImpl as typeof fetch });
    expect(fetchImpl.mock.calls[0]).toMatchObject([expect.any(URL), { headers: { authorization: 'Bearer next-token', 'X-Source-Client': 'codex' }, body: expect.stringContaining('"effort":"xhigh"') }]);
    provideModelSources(() => []);
    await expect(profileModelEndpoint(ref, profile)).rejects.toThrow('unavailable');
  });

  it('keeps a profile that names an unprovided source, resolving it to a reason instead of throwing', async () => {
    const config = { modelSource: 'gateway', apiKey: 'stale-test-key' };
    expect(modelSourceOf(config)).toBe('gateway');
    expect(resolveSource('gateway', config)).toEqual({ reason: '模型源「gateway」当前不可用：提供它的集成未开启' });
    await expect(sourceCatalog('gateway', ['openai-responses'], config)).rejects.toThrow('当前不可用');
    // Nothing is launched against a guess: no endpoint, and the stale key is not exported either.
    expect(codexFlavor.args(config)).toEqual([]);
    expect(codexFlavor.env(config)).toEqual({});
  });
});
