import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLIENT_FEATURES_HEADER, MODEL_CHAT_BUDGET, type ModelChatTreeSnapshot, type ModelChatWireRecord } from '../../../../../packages/contracts/src/index.js';
import { createApp } from '../../app.js';
import { streamChat, type WirePreparedSnapshot } from '../../auxiliary/gateway.js';
import { appendRecord } from './history.js';

const sseResponse = (chunks: string[]) => new Response(new ReadableStream({
  start(controller) {
    for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
    controller.close();
  },
}), { status: 200, headers: { 'content-type': 'text/event-stream' } });

describe('gateway Model Chat extensions', () => {
  it('maps effort, sampling mutual exclusion, prompt caching, responseFormat, usage cache & stopReason across all three protocols', async () => {
    const sent: Array<{ url: string; body: Record<string, unknown> }> = [];

    // 1. Anthropic with thinking enabled: omits temperature/top_p, applies prompt caching on system & 3rd-to-last message, reads cache tokens & stopReason.
    const anthropicEnabled = await streamChat({
      protocol: 'anthropic',
      baseUrl: 'https://anth.example/v1',
      apiKey: 'sk-ant-secret',
      model: 'claude-sonnet',
      system: 'sys prompt',
      messages: [
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u2' },
        { role: 'assistant', content: 'a2' },
        { role: 'user', content: 'u3' },
      ],
      maxOutputTokens: 1000,
      idleTimeoutMs: 2000,
      effort: 'medium',
      thinkingBudget: 4096,
      temperature: 0.7,
      topP: 0.9,
      stop: ['END'],
      promptCaching: true,
      onDelta: () => {},
      fetchImpl: (async (url, init) => {
        sent.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return sseResponse([
          'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet","usage":{"input_tokens":100,"cache_read_input_tokens":80,"cache_creation_input_tokens":20}}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ]);
      }) as typeof fetch,
    });
    expect(sent[0]!.body).toMatchObject({
      thinking: { type: 'enabled', budget_tokens: 4096 },
      max_tokens: 5096,
      stop_sequences: ['END'],
      system: [{ type: 'text', text: 'sys prompt', cache_control: { type: 'ephemeral' } }],
    });
    expect(sent[0]!.body).not.toHaveProperty('temperature');
    expect(sent[0]!.body).not.toHaveProperty('top_p');
    const anthMessages = sent[0]!.body.messages as Array<{ content: unknown }>;
    expect(anthMessages[2]!.content).toEqual([{ type: 'text', text: 'u2', cache_control: { type: 'ephemeral' } }]);
    expect(anthropicEnabled.cacheReadTokens).toBe(80);
    expect(anthropicEnabled.cacheWriteTokens).toBe(20);
    expect(anthropicEnabled.stopReason).toBe('end_turn');

    // 2. Anthropic with effort='off': sends disabled thinking and keeps temperature & top_p.
    await streamChat({
      protocol: 'anthropic',
      baseUrl: 'https://anth.example/v1',
      model: 'claude-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 1000,
      idleTimeoutMs: 2000,
      effort: 'off',
      temperature: 0.4,
      topP: 0.85,
      onDelta: () => {},
      fetchImpl: (async (url, init) => {
        sent.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return sseResponse(['event: message_stop\ndata: {"type":"message_stop"}\n\n']);
      }) as typeof fetch,
    });
    expect(sent[1]!.body).toMatchObject({ thinking: { type: 'disabled' }, temperature: 0.4, top_p: 0.85 });

    // 3. OpenAI Responses with effort='adaptive' & json_schema: maps effort->high, omits temperature/top_p, parses cached_tokens & stopReason.
    const responsesRes = await streamChat({
      protocol: 'responses',
      baseUrl: 'https://resp.example/v1',
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 500,
      idleTimeoutMs: 2000,
      effort: 'adaptive',
      temperature: 0.5,
      topP: 0.9,
      responseFormat: { type: 'json_schema', name: 'out', schema: { type: 'object', properties: { ok: { type: 'boolean' } } } },
      onDelta: () => {},
      fetchImpl: (async (url, init) => {
        sent.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return sseResponse([
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"{\\"ok\\":true}"}\n\n',
          'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","model":"gpt-5","usage":{"input_tokens":50,"output_tokens":4,"input_tokens_details":{"cached_tokens":30}}}}\n\n',
        ]);
      }) as typeof fetch,
    });
    expect(sent[2]!.body).toMatchObject({
      reasoning: { effort: 'high' },
      text: { format: { type: 'json_schema', name: 'out', strict: true } },
    });
    expect(sent[2]!.body).not.toHaveProperty('temperature');
    expect(sent[2]!.body).not.toHaveProperty('top_p');
    expect(responsesRes.cacheReadTokens).toBe(30);
    expect(responsesRes.stopReason).toBe('completed');

    // 4. OpenAI Chat with effort='off', seed, stop, json_object & cached tokens.
    const chatRes = await streamChat({
      protocol: 'chat',
      baseUrl: 'https://chat.example/v1',
      model: 'deepseek-v3',
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 500,
      idleTimeoutMs: 2000,
      effort: 'off',
      temperature: 0.3,
      topP: 0.8,
      seed: 42,
      stop: ['STOP'],
      responseFormat: { type: 'json_object' },
      onDelta: () => {},
      fetchImpl: (async (url, init) => {
        sent.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return sseResponse([
          'data: {"model":"deepseek-v3","choices":[{"delta":{"content":"{}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":20,"completion_tokens":2,"prompt_cache_hit_tokens":12}}\n\n',
          'data: [DONE]\n\n',
        ]);
      }) as typeof fetch,
    });
    expect(sent[3]!.body).toMatchObject({
      thinking: { type: 'disabled' },
      temperature: 0.3,
      top_p: 0.8,
      seed: 42,
      stop: ['STOP'],
      response_format: { type: 'json_object' },
    });
    expect(sent[3]!.body).not.toHaveProperty('reasoning_effort');
    expect(chatRes.cacheReadTokens).toBe(12);
    expect(chatRes.stopReason).toBe('stop');

    // 5. effort='default' omits thinking / reasoning / reasoning_effort across all three protocols.
    const defaultBodies: Record<string, Record<string, unknown>> = {};
    for (const protocol of ['anthropic', 'responses', 'chat'] as const) {
      await streamChat({
        protocol,
        baseUrl: 'https://default.example/v1',
        model: 'plain-model',
        messages: [{ role: 'user', content: 'hi' }],
        maxOutputTokens: 200,
        idleTimeoutMs: 2000,
        effort: 'default',
        temperature: 0.6,
        onDelta: () => {},
        fetchImpl: (async (_url, init) => {
          defaultBodies[protocol] = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return sseResponse([
            protocol === 'anthropic' ? 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
              : protocol === 'responses' ? 'event: response.completed\ndata: {"type":"response.completed","response":{}}\n\n'
              : 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          ]);
        }) as typeof fetch,
      });
    }
    expect(defaultBodies.anthropic).not.toHaveProperty('thinking');
    expect(defaultBodies.anthropic).not.toHaveProperty('output_config');
    expect(defaultBodies.anthropic).toMatchObject({ temperature: 0.6 });
    expect(defaultBodies.responses).not.toHaveProperty('reasoning');
    expect(defaultBodies.responses).toMatchObject({ temperature: 0.6 });
    expect(defaultBodies.chat).not.toHaveProperty('thinking');
    expect(defaultBodies.chat).not.toHaveProperty('reasoning_effort');
    expect(defaultBodies.chat).toMatchObject({ temperature: 0.6 });
  });

  it('strictly redacts sensitive headers, strips query credentials and binary blobs, and truncates oversized Wire snapshots', async () => {
    const wires: WirePreparedSnapshot[] = [];
    const hugeBase64 = 'A'.repeat(2048);
    await streamChat({
      protocol: 'anthropic',
      baseUrl: 'https://gw.example/v1?api_key=leaked-query',
      apiKey: 'sk-live-secret-12345',
      headers: {
        'X-API-Key': 'raw-key',
        'X-Auth': 'custom-auth-val',
        'X-Access-Key': 'custom-access-key',
        'x-session-token': 'tok-999',
        Cookie: 'sid=secret',
        'X-Custom-Secret': 'shh',
        'x-safe-header': 'visible',
        'x-note': 'using Bearer inline-tok-777 and sk-inline-99999',
      },
      model: 'claude-x',
      messages: [{
        role: 'user',
        content: 'look',
        parts: [{ type: 'image', mimeType: 'image/png', data: hugeBase64 }],
      }],
      maxOutputTokens: 100,
      idleTimeoutMs: 1000,
      onWirePrepared: wire => wires.push(wire),
      onDelta: () => {},
      fetchImpl: (async () => sseResponse(['event: message_stop\ndata: {"type":"message_stop"}\n\n'])) as typeof fetch,
    });
    expect(wires).toHaveLength(1);
    const wire = wires[0]!;
    expect(wire.endpoint).toBe('https://gw.example/v1/messages');
    expect(wire.headers.authorization).toBe('[REDACTED]');
    expect(wire.headers['X-API-Key']).toBe('[REDACTED]');
    expect(wire.headers['X-Auth']).toBe('[REDACTED]');
    expect(wire.headers['X-Access-Key']).toBe('[REDACTED]');
    expect(wire.headers['x-session-token']).toBe('[REDACTED]');
    expect(wire.headers.Cookie).toBe('[REDACTED]');
    expect(wire.headers['X-Custom-Secret']).toBe('[REDACTED]');
    expect(wire.headers['x-safe-header']).toBe('visible');
    expect(wire.headers['x-note']).toBe('using Bearer [REDACTED] and [REDACTED]');
    const serialized = JSON.stringify(wire);
    expect(serialized).not.toContain('sk-live-secret');
    expect(serialized).not.toContain('leaked-query');
    expect(serialized).not.toContain('raw-key');
    expect(serialized).not.toContain('custom-auth-val');
    expect(serialized).not.toContain('custom-access-key');
    expect(serialized).not.toContain('inline-tok-777');
    expect(serialized).not.toContain('sk-inline-99999');
    expect(serialized).toContain('[binary data omitted]');

    // Oversized multi-byte UTF-8 body triggers strict UTF-8 byte budget truncation on the whole Wire JSON.
    const bigWires: WirePreparedSnapshot[] = [];
    const manyChineseMessages = Array.from({ length: 8_000 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `中文内容测试_${i}_汉字表情🚀`,
    }));
    await streamChat({
      protocol: 'chat',
      baseUrl: 'https://gw.example/v1',
      model: 'm',
      messages: manyChineseMessages,
      maxOutputTokens: 100,
      idleTimeoutMs: 1000,
      onWirePrepared: wire => bigWires.push(wire),
      onDelta: () => {},
      fetchImpl: (async () => sseResponse(['data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'])) as typeof fetch,
    });
    expect(bigWires[0]!.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(bigWires[0]!), 'utf8')).toBeLessThanOrEqual(MODEL_CHAT_BUDGET.maxWireBytes);
  });
});

describe('Model Chat routes and tree engine', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function bootServer() {
    const dir = mkdtempSync(join(tmpdir(), 'riffet-model-chat-'));
    tempDirs.push(dir);
    const stateDir = join(dir, 'state');
    const appCtx = await createApp({ stateDir, auth: false, cliPath: '/nonexistent/cursor-agent' });
    const status = await appCtx.app.inject({ method: 'GET', url: '/api/auth/status', headers: { host: '127.0.0.1:4317' } });
    const cookie = String(status.headers['set-cookie']).split(';')[0]!;
    const csrf = (status.json() as { csrfToken: string }).csrfToken;
    const baseHeaders = { host: '127.0.0.1:4317', cookie, 'x-csrf-token': csrf };
    const headers = { ...baseHeaders, [CLIENT_FEATURES_HEADER]: 'quick-chat' };
    const req = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
      appCtx.app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { ...appCtx, req, baseHeaders, stateDir };
  }

  it('supports config patches, multi-model parallel compare with isolated failure, Wire inspection, branch switching, turn flags and assistant editing', async () => {
    const { app, req, baseHeaders, store } = await bootServer();
    try {
      // Configure two gateway profiles (DSH chat + Claude anthropic).
      expect((await req('POST', '/api/backends/dsh/profiles', {
        id: 'd1', name: 'DSH', apiEndpoint: 'https://dsh.example/v1', apiKey: 'dsh-secret-key', enabledModels: ['m1', 'm2'],
      })).statusCode).toBe(200);
      expect((await req('POST', '/api/backends/claude/profiles', {
        id: 'c1', name: 'Claude', apiEndpoint: 'https://anth.example/v1', apiKey: 'ant-secret-key', enabledModels: ['sonnet'],
      })).statusCode).toBe(200);

      const projects = (await req('GET', '/api/projects')).json() as Array<{ id: string; system?: string; name: string }>;
      const chatProject = projects.find(p => p.system === 'quick-chat')!;
      expect(chatProject.name).toBe('模型对话');

      const created = await req('POST', '/api/sessions', { projectId: chatProject.id, kind: 'native', backendId: 'chat', model: 'dsh:d1:m1' });
      expect([200, 201]).toContain(created.statusCode);
      const sessionId = (created.json() as { id: string }).id;

      // Rejects missing quick-chat feature header.
      const noFeature = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/chat/tree`, headers: baseHeaders });
      expect(noFeature.statusCode).toBe(409);

      // Update config + pinnedDocs + summary; enforces budget caps.
      const tooManyDocs = Array.from({ length: MODEL_CHAT_BUDGET.maxPinnedDocs + 1 }, (_, i) => ({ id: `d${i}`, name: `f${i}.md`, text: 'x', tokens: 1, pinned: true }));
      expect((await req('PATCH', `/api/sessions/${sessionId}/chat/config`, { pinnedDocs: tooManyDocs })).statusCode).toBe(400);
      expect((await req('PATCH', `/api/sessions/${sessionId}/chat/config`, { summary: 's'.repeat(MODEL_CHAT_BUDGET.maxSummaryChars + 1) })).statusCode).toBe(400);

      const patched = await req('PATCH', `/api/sessions/${sessionId}/chat/config`, {
        systemPrompt: 'Be concise.',
        effort: 'off',
        temperature: 0.2,
        pinnedDocs: [{ id: 'doc1', name: 'notes.md', text: 'Key fact: 42', tokens: 5, pinned: true }],
      });
      expect(patched.statusCode).toBe(200);
      expect((patched.json() as ModelChatTreeSnapshot).config).toMatchObject({ systemPrompt: 'Be concise.', effort: 'off', temperature: 0.2 });

      // Rejects > maxCompareModels.
      const tooManyModels = await req('POST', `/api/sessions/${sessionId}/chat/send`, {
        text: 'hello',
        models: ['dsh:d1:m1', 'dsh:d1:m2', 'claude:c1:sonnet', 'dsh:d1:m1'],
      });
      expect(tooManyModels.statusCode).toBe(400);

      // Parallel compare: model 1 succeeds, model 2 fails with HTTP 500 independently.
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        const href = String(url);
        const body = JSON.parse(String(init?.body)) as { model: string };
        if (href.includes('anth.example')) {
          return sseResponse([
            'event: message_start\ndata: {"type":"message_start","message":{"model":"sonnet","usage":{"input_tokens":15}}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Claude answer"}}\n\n',
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n\n',
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ]);
        }
        if (body.model === 'm2') {
          return new Response(JSON.stringify({ error: { message: 'upstream overloaded' } }), { status: 500 });
        }
        return sseResponse([
          'data: {"model":"m1","choices":[{"delta":{"content":"DSH answer"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":3}}\n\n',
          'data: [DONE]\n\n',
        ]);
      });

      try {
        const sendRes = await req('POST', `/api/sessions/${sessionId}/chat/send`, {
          text: 'Compare two models',
          models: ['claude:c1:sonnet', 'dsh:d1:m2'],
        });
        expect(sendRes.statusCode).toBe(200);
        const { assistantIds } = sendRes.json() as { snapshot: ModelChatTreeSnapshot; assistantIds: string[] };
        expect(assistantIds).toHaveLength(2);

        // Wait for both parallel streams to settle.
        let tree!: ModelChatTreeSnapshot;
        await vi.waitFor(async () => {
          tree = (await req('GET', `/api/sessions/${sessionId}/chat/tree`)).json() as ModelChatTreeSnapshot;
          expect(tree.liveStreams).toHaveLength(0);
          expect(tree.nodes.filter(n => n.kind === 'assistant')).toHaveLength(2);
        }, { timeout: 5_000 });

        const aClaude = tree.nodes.find(n => n.id === assistantIds[0])!;
        const aFail = tree.nodes.find(n => n.id === assistantIds[1])!;
        expect(aClaude).toMatchObject({ kind: 'assistant', text: 'Claude answer', status: 'completed', hasWire: true });
        expect(aFail).toMatchObject({ kind: 'assistant', status: 'failed' });
        expect(aClaude.kind === 'assistant' && aFail.kind === 'assistant' && aClaude.compareGroupId && aClaude.compareGroupId === aFail.compareGroupId).toBe(true);

        // Inspect Wire: strictly redacted (no secret keys leaked).
        const wireRes = await req('GET', `/api/sessions/${sessionId}/chat/wire/${assistantIds[0]}`);
        expect(wireRes.statusCode).toBe(200);
        const wire = wireRes.json() as ModelChatWireRecord;
        expect(wire.protocol).toBe('anthropic');
        expect(wire.headers.authorization).toBe('[REDACTED]');
        expect(JSON.stringify(wire)).not.toContain('ant-secret-key');
        expect(wire.metrics?.inputTokens).toBe(15);

        // Rerun same user turn with dsh:d1:m1 to create a 3rd sibling answer.
        const userNode = tree.nodes.find(n => n.kind === 'user')!;
        const rerunRes = await req('POST', `/api/sessions/${sessionId}/chat/send`, {
          text: '',
          rerunUserId: userNode.id,
          models: ['dsh:d1:m1'],
        });
        expect(rerunRes.statusCode).toBe(200);
        const rerunAssistantId = (rerunRes.json() as { assistantIds: string[] }).assistantIds[0]!;
        await vi.waitFor(async () => {
          tree = (await req('GET', `/api/sessions/${sessionId}/chat/tree`)).json() as ModelChatTreeSnapshot;
          expect(tree.liveStreams).toHaveLength(0);
          expect(tree.nodes.some(n => n.id === rerunAssistantId)).toBe(true);
        }, { timeout: 5_000 });
        expect(tree.activeLeafId).toBe(rerunAssistantId);

        // Switch branch back to Claude answer and verify Journal projection updates.
        const branchRes = await req('POST', `/api/sessions/${sessionId}/chat/branch`, { leafId: assistantIds[0] });
        expect(branchRes.statusCode).toBe(200);
        expect((branchRes.json() as ModelChatTreeSnapshot).activeLeafId).toBe(assistantIds[0]);

        // Edit assistant message and verify tree & journal reflect it.
        const editRes = await req('PATCH', `/api/sessions/${sessionId}/chat/messages/${assistantIds[0]}`, { text: 'Edited Claude answer' });
        expect(editRes.statusCode).toBe(200);
        const editedNode = (editRes.json() as ModelChatTreeSnapshot).nodes.find(n => n.id === assistantIds[0]);
        expect(editedNode).toMatchObject({ kind: 'assistant', text: 'Edited Claude answer', edited: true });

        // Pin & mute user turn.
        const flagRes = await req('PATCH', `/api/sessions/${sessionId}/chat/turns/${userNode.id}`, { pinned: true, muted: true });
        expect(flagRes.statusCode).toBe(200);
        const flaggedTree = flagRes.json() as ModelChatTreeSnapshot;
        expect(flaggedTree.nodes.find(n => n.id === userNode.id)).toMatchObject({ pinned: true, muted: true });
        expect(flaggedTree.tokenBreakdown.droppedTurnIds).toContain(userNode.id);

        // Check timeline projection reflects the active branch + assistant edit.
        const timelineRes = await req('GET', `/api/v3/sessions/${sessionId}/timeline?lane=main&before=999999999`);
        expect(timelineRes.statusCode).toBe(200);
        expect(JSON.stringify(timelineRes.json())).toContain('Edited Claude answer');

        // Verify a non-chat session is rejected with 409.
        const normalProject = store.createProject(join(tmpdir(), 'riffet-non-chat-proj'), 'Normal');
        const normalSession = store.createSession({ projectId: normalProject.id, kind: 'native', backendId: 'claude', title: 'Normal' });
        expect((await req('GET', `/api/sessions/${normalSession.id}/chat/tree`)).statusCode).toBe(409);
      } finally {
        fetchSpy.mockRestore();
      }
    } finally {
      await app.close();
    }
  });

  it('stops a single streaming model in a parallel compare without interrupting the other model', async () => {
    const { app, req } = await bootServer();
    try {
      expect((await req('POST', '/api/backends/dsh/profiles', {
        id: 'd1', name: 'DSH', apiEndpoint: 'https://dsh.example/v1', apiKey: 'k', enabledModels: ['slow', 'fast'],
      })).statusCode).toBe(200);
      const chatProject = ((await req('GET', '/api/projects')).json() as Array<{ id: string; system?: string }>).find(p => p.system === 'quick-chat')!;
      const sessionId = ((await req('POST', '/api/sessions', { projectId: chatProject.id, kind: 'native', backendId: 'chat', model: 'dsh:d1:slow' })).json() as { id: string }).id;

      let releaseFast!: () => void;
      const fastGate = new Promise<void>(resolve => { releaseFast = resolve; });
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { model: string };
        const signal = init?.signal as AbortSignal | undefined;
        if (body.model === 'slow') {
          return new Response(new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('data: {"model":"slow","choices":[{"delta":{"content":"partial"}}]}\n\n'));
              signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
            },
          }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
        }
        await fastGate;
        return sseResponse([
          'data: {"model":"fast","choices":[{"delta":{"content":"fast done"},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ]);
      });

      try {
        const sent = await req('POST', `/api/sessions/${sessionId}/chat/send`, {
          text: 'race',
          models: ['dsh:d1:slow', 'dsh:d1:fast'],
        });
        const { assistantIds } = sent.json() as { assistantIds: string[] };
        const [slowId, fastId] = assistantIds as [string, string];

        // Stop ONLY the slow model.
        const stopRes = await req('POST', `/api/sessions/${sessionId}/chat/stop`, { assistantId: slowId });
        expect(stopRes.statusCode).toBe(200);
        const afterStop = (stopRes.json() as { snapshot: ModelChatTreeSnapshot }).snapshot;
        expect(afterStop.nodes.find(n => n.id === slowId)).toMatchObject({ status: 'cancelled' });
        expect(afterStop.liveStreams.some(s => s.assistantId === fastId)).toBe(true);

        // Now let the fast model complete.
        releaseFast();
        await vi.waitFor(async () => {
          const tree = (await req('GET', `/api/sessions/${sessionId}/chat/tree`)).json() as ModelChatTreeSnapshot;
          expect(tree.liveStreams).toHaveLength(0);
          expect(tree.nodes.find(n => n.id === fastId)).toMatchObject({ status: 'completed', text: 'fast done' });
        }, { timeout: 5_000 });
      } finally {
        fetchSpy.mockRestore();
      }
    } finally {
      await app.close();
    }
  });

  it('validates chatConfig atomically on POST /api/sessions and applies it on the first turn (with and without initialMessage)', async () => {
    const { app, req, store } = await bootServer();
    try {
      expect((await req('POST', '/api/backends/dsh/profiles', {
        id: 'd1', name: 'DSH', apiEndpoint: 'https://dsh.example/v1', apiKey: 'k', enabledModels: ['m1', 'm2'],
      })).statusCode).toBe(200);
      const chatProject = ((await req('GET', '/api/projects')).json() as Array<{ id: string; system?: string }>).find(p => p.system === 'quick-chat')!;

      // Invalid chatConfig with initialMessage -> 400 and no dirty session left behind.
      const badInit = await req('POST', '/api/sessions', {
        projectId: chatProject.id,
        kind: 'native',
        backendId: 'chat',
        model: 'dsh:d1:m1',
        clientSessionId: 'bad-chat-sess-1',
        chatConfig: { temperature: 99 },
        initialMessage: { commandId: 'cmd-bad-1', text: 'hello' },
      });
      expect(badInit.statusCode).toBe(400);
      expect(store.findSession('bad-chat-sess-1')).toBeUndefined();

      // Invalid chatConfig without initialMessage -> 400 and no dirty session created.
      const beforeCount = store.listSessions().length;
      const badNoInit = await req('POST', '/api/sessions', {
        projectId: chatProject.id,
        kind: 'native',
        backendId: 'chat',
        model: 'dsh:d1:m1',
        chatConfig: { contextStrategy: 'invalid' as never },
      });
      expect(badNoInit.statusCode).toBe(400);
      expect(store.listSessions().length).toBe(beforeCount);

      // Valid chatConfig without initialMessage -> immediately persisted on the tree.
      const okNoInit = await req('POST', '/api/sessions', {
        projectId: chatProject.id,
        kind: 'native',
        backendId: 'chat',
        model: 'dsh:d1:m1',
        chatConfig: { bareMode: true, temperature: 0.35 },
      });
      expect([200, 201]).toContain(okNoInit.statusCode);
      const noInitId = (okNoInit.json() as { id: string }).id;
      const noInitTree = (await req('GET', `/api/sessions/${noInitId}/chat/tree`)).json() as ModelChatTreeSnapshot;
      expect(noInitTree.config).toMatchObject({ bareMode: true, temperature: 0.35, effort: 'default' });

      // Valid chatConfig with initialMessage -> takes effect on the very first turn (bareMode + temperature + compareModels).
      const bodies: Array<Record<string, unknown>> = [];
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const parsed = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push(parsed);
        return sseResponse([
          `data: {"model":${JSON.stringify(parsed.model)},"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n`,
          'data: [DONE]\n\n',
        ]);
      });
      try {
        const okInit = await req('POST', '/api/sessions', {
          projectId: chatProject.id,
          kind: 'native',
          backendId: 'chat',
          model: 'dsh:d1:m1',
          clientSessionId: 'good-chat-sess-1',
          chatConfig: { bareMode: true, temperature: 0.25, compareModels: ['dsh:d1:m2'] },
          initialMessage: { commandId: 'cmd-good-1', text: 'first turn' },
        });
        expect(okInit.statusCode).toBe(202);

        await vi.waitFor(async () => {
          const tree = (await req('GET', '/api/sessions/good-chat-sess-1/chat/tree')).json() as ModelChatTreeSnapshot;
          expect(tree.liveStreams).toHaveLength(0);
          expect(tree.nodes.filter(n => n.kind === 'assistant')).toHaveLength(2);
        }, { timeout: 5_000 });

        expect(bodies).toHaveLength(2);
        expect(bodies.map(b => b.model).sort()).toEqual(['m1', 'm2']);
        for (const body of bodies) {
          expect(body.temperature).toBe(0.25);
          // bareMode omits system message completely; effort='default' omits thinking/reasoning_effort.
          expect((body.messages as Array<{ role: string }>).some(m => m.role === 'system')).toBe(false);
          expect(body).not.toHaveProperty('thinking');
          expect(body).not.toHaveProperty('reasoning_effort');
        }
      } finally {
        fetchSpy.mockRestore();
      }
    } finally {
      await app.close();
    }
  });

  it('rejects /chat/* writes on archived sessions while preserving Wire snapshots, cleans Wire on deletion, and rejects council sessions', async () => {
    const { app, req, store, stateDir } = await bootServer();
    try {
      expect((await req('POST', '/api/backends/dsh/profiles', {
        id: 'd1', name: 'DSH', apiEndpoint: 'https://dsh.example/v1', apiKey: 'k', enabledModels: ['m1'],
      })).statusCode).toBe(200);
      const chatProject = ((await req('GET', '/api/projects')).json() as Array<{ id: string; system?: string }>).find(p => p.system === 'quick-chat')!;
      const sessionId = ((await req('POST', '/api/sessions', { projectId: chatProject.id, kind: 'native', backendId: 'chat', model: 'dsh:d1:m1' })).json() as { id: string }).id;

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => sseResponse([
        'data: {"model":"m1","choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]));
      let assistantId = '';
      let userId = '';
      try {
        const sent = await req('POST', `/api/sessions/${sessionId}/chat/send`, { text: 'keep wire' });
        expect(sent.statusCode).toBe(200);
        assistantId = (sent.json() as { assistantIds: string[] }).assistantIds[0]!;
        await vi.waitFor(async () => {
          const tree = (await req('GET', `/api/sessions/${sessionId}/chat/tree`)).json() as ModelChatTreeSnapshot;
          expect(tree.liveStreams).toHaveLength(0);
          userId = tree.nodes.find(n => n.kind === 'user')!.id;
          expect(tree.nodes.find(n => n.id === assistantId)).toMatchObject({ status: 'completed', hasWire: true });
        }, { timeout: 5_000 });
      } finally {
        fetchSpy.mockRestore();
      }

      const wireDir = join(stateDir, 'chat', 'wire', encodeURIComponent(sessionId));
      expect(existsSync(wireDir)).toBe(true);

      // Archive the session: calls dispose(), which must NOT delete Wire snapshots.
      expect((await req('PATCH', `/api/sessions/${sessionId}`, { archived: true })).statusCode).toBe(200);
      expect(existsSync(wireDir)).toBe(true);
      expect((await req('GET', `/api/sessions/${sessionId}/chat/wire/${assistantId}`)).statusCode).toBe(200);

      // All /chat/* write routes must reject archived sessions with 409 SESSION_ARCHIVED.
      for (const res of [
        await req('PATCH', `/api/sessions/${sessionId}/chat/config`, { bareMode: true }),
        await req('POST', `/api/sessions/${sessionId}/chat/send`, { text: 'blocked' }),
        await req('POST', `/api/sessions/${sessionId}/chat/branch`, { leafId: assistantId }),
        await req('PATCH', `/api/sessions/${sessionId}/chat/turns/${userId}`, { pinned: true }),
        await req('PATCH', `/api/sessions/${sessionId}/chat/messages/${assistantId}`, { text: 'blocked' }),
      ]) {
        expect(res.statusCode).toBe(409);
        expect((res.json() as { error: { code: string } }).error.code).toBe('SESSION_ARCHIVED');
      }

      // Deleting the session cleans up chat/wire/<id>.
      const del = await req('DELETE', `/api/sessions/${sessionId}`, { sessionIds: [sessionId] });
      expect(del.statusCode).toBe(200);
      expect(existsSync(wireDir)).toBe(false);

      // Council seat session with backendId: 'chat' must be rejected from /chat/* routes.
      const councilSession = store.createSession({
        projectId: chatProject.id,
        kind: 'native',
        backendId: 'chat',
        title: 'Council Seat',
        origin: { kind: 'council', groupId: 'disc-1' },
      });
      const councilRes = await req('GET', `/api/sessions/${councilSession.id}/chat/tree`);
      expect(councilRes.statusCode).toBe(409);
      expect((councilRes.json() as { error: { code: string } }).error.code).toBe('NOT_MODEL_CHAT');
    } finally {
      await app.close();
    }
  });

  it('preserves prior history when editing a legacy JSONL turn and isolates explicit root forks (parentId: "")', async () => {
    const { app, req, stateDir } = await bootServer();
    try {
      expect((await req('POST', '/api/backends/dsh/profiles', {
        id: 'd1', name: 'DSH', apiEndpoint: 'https://dsh.example/v1', apiKey: 'k', enabledModels: ['m1'],
      })).statusCode).toBe(200);
      const chatProject = ((await req('GET', '/api/projects')).json() as Array<{ id: string; system?: string }>).find(p => p.system === 'quick-chat')!;
      const sessionId = ((await req('POST', '/api/sessions', { projectId: chatProject.id, kind: 'native', backendId: 'chat', model: 'dsh:d1:m1' })).json() as { id: string }).id;

      // Seed a legacy JSONL with NO parentId on any turn.
      const file = join(stateDir, 'chat', `${encodeURIComponent(sessionId)}.jsonl`);
      const ts = '2026-10-31T00:00:00.000Z';
      appendRecord(file, { kind: 'user', id: 'legacy-u1', turnId: 'lt1', at: ts, text: 'turn one question', commandId: 'lc1' });
      appendRecord(file, { kind: 'assistant', id: 'legacy-a1', turnId: 'lt1', at: ts, text: 'turn one answer', status: 'completed' });
      appendRecord(file, { kind: 'user', id: 'legacy-u2', turnId: 'lt2', at: ts, text: 'turn two question', commandId: 'lc2' });
      appendRecord(file, { kind: 'assistant', id: 'legacy-a2', turnId: 'lt2', at: ts, text: 'turn two answer', status: 'completed' });

      const sentMessages: Array<Array<{ role: string; content: string }>> = [];
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
        sentMessages.push(body.messages);
        return sseResponse([
          'data: {"model":"m1","choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ]);
      });

      try {
        // Edit legacy-u2: must keep legacy-u1 + legacy-a1 as prior history.
        const editRes = await req('POST', `/api/sessions/${sessionId}/chat/send`, {
          text: 'turn two edited',
          editedFrom: 'legacy-u2',
        });
        expect(editRes.statusCode).toBe(200);
        await vi.waitFor(async () => {
          const tree = (await req('GET', `/api/sessions/${sessionId}/chat/tree`)).json() as ModelChatTreeSnapshot;
          expect(tree.liveStreams).toHaveLength(0);
        }, { timeout: 5_000 });
        expect(sentMessages[0]!.filter(m => m.role !== 'system').map(m => m.content)).toEqual([
          'turn one question',
          'turn one answer',
          'turn two edited',
        ]);

        // Explicit root fork (parentId: ''): must NOT include any legacy turns in history or active path.
        const rootRes = await req('POST', `/api/sessions/${sessionId}/chat/send`, {
          text: 'fresh root question',
          parentId: '',
        });
        expect(rootRes.statusCode).toBe(200);
        const rootAssistantId = (rootRes.json() as { assistantIds: string[] }).assistantIds[0]!;
        await vi.waitFor(async () => {
          const tree = (await req('GET', `/api/sessions/${sessionId}/chat/tree`)).json() as ModelChatTreeSnapshot;
          expect(tree.liveStreams).toHaveLength(0);
          expect(tree.nodes.find(n => n.id === rootAssistantId)).toMatchObject({ status: 'completed' });
        }, { timeout: 5_000 });
        expect(sentMessages[1]!.filter(m => m.role !== 'system').map(m => m.content)).toEqual([
          'fresh root question',
        ]);
      } finally {
        fetchSpy.mockRestore();
      }
    } finally {
      await app.close();
    }
  });
});
