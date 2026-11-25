import { expect, it, vi } from 'vitest';
import type { CodexAppServerClient, CodexAppServerFactory } from '../shared/codex-app-server.js';
import { streamTraeDiscussion } from './traex-discussion.js';

it.each(['One answer.', 'Replacement'])('checks the /btw final answer %s and closes only the side subscriber', async final => {
  const dispose = vi.fn(), detach = vi.fn(async () => {});
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const start: CodexAppServerFactory = async options => {
    expect(options.remoteAddress).toBe('unix:///route.sock');
    return { dispose, detach, request: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      switch (method) {
        case 'model/list': return { data: [] };
        case 'config/read': return { config: { mcp_servers: { workspace: { command: 'tool' } } } };
        case 'thread/start': return { thread: { id: 'ephemeral' } };
        case 'turn/btw': {
          const ids = { threadId: 'ephemeral', turnId: params.turnId };
          options.onNotification('turn/btw/delta', { ...ids, threadId: 'main', delta: 'wrong thread' });
          options.onNotification('turn/btw/delta', { ...ids, delta: 'One' });
          options.onNotification('turn/btw/completed', { ...ids, answer: final });
          return { turnId: params.turnId };
        }
        case 'thread/unsubscribe': return {};
        default: throw new Error('Unexpected RPC ' + method);
      }
    } } as unknown as CodexAppServerClient;
  };
  const text: string[] = [];
  const turn = streamTraeDiscussion(start, { id: 'local', backendId: 'traex', name: 'Local', config: {} }, {
    model: 'model[context=max,effort=high]', system: 'Frozen snapshot',
    messages: [{ role: 'user', content: 'Question?' }], signal: new AbortController().signal,
    idleTimeoutMs: 1000, maxOutputTokens: 100, onDelta: value => text.push(value),
  }, 'unix:///route.sock');
  if (final === 'Replacement') await expect(turn).rejects.toThrow('inconsistent side chat output');
  else await turn;
  expect(calls).toContainEqual({ method: 'thread/start', params: expect.objectContaining({
    model: 'model', threadSource: 'side', ephemeral: true, baseInstructions: 'Frozen snapshot', environments: [],
    config: expect.objectContaining({ model_backend_variant: 'max', model_reasoning_effort: 'high', 'features.hooks': false, 'mcp_servers.workspace.enabled': false }),
  }) });
  expect(calls).toContainEqual({ method: 'turn/btw', params: expect.objectContaining({ model: 'model', effort: 'high', question: 'Question?', threadId: 'ephemeral' }) });
  expect(calls.at(-1)).toEqual({ method: 'thread/unsubscribe', params: { threadId: 'ephemeral' } });
  expect(text.join('')).toBe(final === 'Replacement' ? 'One' : final);
  expect(detach).toHaveBeenCalledOnce();
  expect(dispose).not.toHaveBeenCalled();
});
