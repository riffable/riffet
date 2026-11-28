import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  DEFAULT_CLAUDE_TOOLS,
  DEFAULT_CODEX_TOOLS,
  MockLlmHub,
  registerTckScripts,
  replyDisconnect,
  replyText,
  replyToolCall,
  routeByTag,
} from '../scripts/cli-compat/mock-llm/index.js';
import {
  currentTurnToolResults,
  hasToolResultForCurrentTurn,
} from '../scripts/cli-compat/mock-llm/scripts.js';

interface ParsedSseEvent {
  event?: string;
  data: string;
}

function parseSseFrames(raw: string): ParsedSseEvent[] {
  const frames: ParsedSseEvent[] = [];
  const blocks = raw.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length > 0) {
      frames.push({ event, data: dataLines.join('\n') });
    }
  }
  return frames;
}

const activeHubs: MockLlmHub[] = [];

async function startHub(options?: ConstructorParameters<typeof MockLlmHub>[0]): Promise<MockLlmHub> {
  const hub = new MockLlmHub(options);
  activeHubs.push(hub);
  await hub.start();
  return hub;
}

afterEach(async () => {
  while (activeHubs.length > 0) {
    const hub = activeHubs.pop()!;
    await hub.close();
  }
});

describe('MockLlmHub core protocols and primitives', () => {
  it('serves Anthropic Messages SSE (thinking + narration signature + text + tool_use), models and count_tokens', async () => {
    const hub = await startHub();
    hub.addRoute(
      routeByTag('[ANTHROPIC]', () => ({
        thinking: { text: 'Inspecting project files.', narration: true },
        text: 'Hello from Anthropic mock',
        toolCalls: [{ id: 'toolu_1', name: 'Read', arguments: { file_path: 'README.md' } }],
        chunkSize: 10,
        usage: { inputTokens: 111, outputTokens: 22, cacheReadTokens: 5 },
      })),
    );

    const modelsRes = await fetch(`${hub.url}/v1/models`, {
      headers: { 'anthropic-version': '2023-06-01' },
    });
    expect(modelsRes.status).toBe(200);
    const modelsJson = (await modelsRes.json()) as { data: Array<{ id: string; type: string }>; has_more: boolean };
    expect(modelsJson.has_more).toBe(false);
    expect(modelsJson.data.some((m) => m.id === 'claude-mock-4' && m.type === 'model')).toBe(true);

    const countRes = await fetch(`${hub.url}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-mock-4',
        system: [{ type: 'text', text: 'System rules' }],
        messages: [{ role: 'user', content: 'Count these tokens please' }],
      }),
    });
    expect(countRes.status).toBe(200);
    const countJson = (await countRes.json()) as { input_tokens: number };
    expect(countJson.input_tokens).toBeGreaterThan(0);

    const sseRes = await fetch(`${hub.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-mock-4',
        stream: true,
        system: [{ type: 'text', text: 'You are helpful.' }],
        tools: [{ name: 'Read', input_schema: { type: 'object' } }],
        messages: [{ role: 'user', content: '[ANTHROPIC] test stream' }],
      }),
    });
    expect(sseRes.status).toBe(200);
    const frames = parseSseFrames(await sseRes.text());
    const events = frames.map((f) => JSON.parse(f.data) as Record<string, unknown>);

    expect(events[0]?.type).toBe('message_start');
    expect(events[events.length - 1]?.type).toBe('message_stop');

    const sigDelta = events.find(
      (e) => e.type === 'content_block_delta' && (e.delta as Record<string, unknown>)?.type === 'signature_delta',
    );
    const signature = ((sigDelta?.delta as Record<string, unknown>)?.signature ?? '') as string;
    expect(Buffer.from(signature.slice(0, 64), 'base64').includes('narration')).toBe(true);

    const textOut = events
      .filter((e) => e.type === 'content_block_delta' && (e.delta as Record<string, unknown>)?.type === 'text_delta')
      .map((e) => (e.delta as Record<string, unknown>).text as string)
      .join('');
    expect(textOut).toBe('Hello from Anthropic mock');

    const toolArgs = events
      .filter((e) => e.type === 'content_block_delta' && (e.delta as Record<string, unknown>)?.type === 'input_json_delta')
      .map((e) => (e.delta as Record<string, unknown>).partial_json as string)
      .join('');
    expect(JSON.parse(toolArgs)).toEqual({ file_path: 'README.md' });

    const msgDelta = events.find((e) => e.type === 'message_delta');
    expect((msgDelta?.delta as Record<string, unknown>)?.stop_reason).toBe('tool_use');
  });

  it('serves OpenAI Responses HTTP SSE with reasoning, text and function_call events', async () => {
    const hub = await startHub();
    hub.addRoute(
      routeByTag('[RESP-HTTP]', () => ({
        thinking: { text: 'Thinking about shell command' },
        text: 'Running tool now.',
        toolCalls: [{ id: 'call_resp_1', name: 'exec_command', arguments: { cmd: 'echo hi' } }],
        chunkSize: 8,
        usage: { inputTokens: 80, outputTokens: 30, reasoningTokens: 12 },
      })),
    );

    const res = await fetch(`${hub.url}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5-mock',
        stream: true,
        instructions: 'Be concise.',
        tools: [{ type: 'function', name: 'exec_command' }],
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '[RESP-HTTP] go' }] }],
      }),
    });
    expect(res.status).toBe(200);
    const frames = parseSseFrames(await res.text());
    const events = frames.map((f) => JSON.parse(f.data) as Record<string, unknown>);
    const types = events.map((e) => e.type);

    expect(types[0]).toBe('response.created');
    expect(types).toContain('response.in_progress');
    expect(types).toContain('response.output_item.added');
    expect(types).toContain('response.reasoning_summary_part.added');
    expect(types).toContain('response.reasoning_summary_text.delta');
    expect(types).toContain('response.reasoning_summary_text.done');
    expect(types).toContain('response.reasoning_summary_part.done');
    expect(types).toContain('response.output_text.delta');
    expect(types).toContain('response.function_call_arguments.delta');
    expect(types).toContain('response.output_item.done');
    expect(types[types.length - 1]).toBe('response.completed');

    const assembledText = events
      .filter((e) => e.type === 'response.output_text.delta')
      .map((e) => e.delta as string)
      .join('');
    expect(assembledText).toBe('Running tool now.');

    const assembledArgs = events
      .filter((e) => e.type === 'response.function_call_arguments.delta')
      .map((e) => e.delta as string)
      .join('');
    expect(JSON.parse(assembledArgs)).toEqual({ cmd: 'echo hi' });
  });

  it('serves OpenAI Responses WebSocket multi-turn tool loop with previous_response_id', async () => {
    const hub = await startHub();
    hub.addRoute(
      routeByTag('[RESP-WS]', (req) => {
        if (req.toolResults.length > 0) {
          return replyText(`WS_DONE:${req.toolResults[0].toolName}=${req.toolResults[0].content}`);
        }
        return replyToolCall({
          id: 'call_ws_1',
          name: 'read_file',
          arguments: { path: 'package.json' },
        });
      }),
    );

    const ws = new WebSocket(`${hub.wsUrl}/v1/responses`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });

    const receiveTurn = (): Promise<Array<Record<string, unknown>>> =>
      new Promise((resolve, reject) => {
        const collected: Array<Record<string, unknown>> = [];
        const onMsg = (buf: Buffer) => {
          const evt = JSON.parse(buf.toString('utf8')) as Record<string, unknown>;
          collected.push(evt);
          if (evt.type === 'response.completed' || evt.type === 'error') {
            ws.off('message', onMsg);
            resolve(collected);
          }
        };
        ws.on('message', onMsg);
        ws.once('error', reject);
      });

    // Turn 1: trigger tool call
    const turn1Promise = receiveTurn();
    ws.send(JSON.stringify({
      type: 'response.create',
      model: 'gpt-5-mock',
      tools: [{ type: 'function', name: 'read_file' }],
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '[RESP-WS] inspect' }] }],
    }));
    const turn1 = await turn1Promise;
    const completed1 = turn1.find((e) => e.type === 'response.completed') as Record<string, unknown>;
    const respId1 = ((completed1.response as Record<string, unknown>).id) as string;
    const fcArgs = turn1
      .filter((e) => e.type === 'response.function_call_arguments.delta')
      .map((e) => e.delta as string)
      .join('');
    expect(JSON.parse(fcArgs)).toEqual({ path: 'package.json' });

    // Turn 2: return function_call_output referencing previous_response_id
    const turn2Promise = receiveTurn();
    ws.send(JSON.stringify({
      type: 'response.create',
      model: 'gpt-5-mock',
      previous_response_id: respId1,
      input: [{ type: 'function_call_output', call_id: 'call_ws_1', output: 'name=riffet' }],
    }));
    const turn2 = await turn2Promise;
    const finalText = turn2
      .filter((e) => e.type === 'response.output_text.delta')
      .map((e) => e.delta as string)
      .join('');
    expect(finalText).toBe('WS_DONE:read_file=name=riffet');

    ws.close();
  });

  it('serves OpenAI Chat Completions SSE with reasoning_content, tool_calls, usage and [DONE]', async () => {
    const hub = await startHub();
    hub.addRoute(
      routeByTag('[CHAT]', () => ({
        thinking: { text: 'Deep reasoning' },
        text: 'Chat reply text',
        toolCalls: [{ id: 'call_chat_1', name: 'run_shell', arguments: { command: 'pwd' } }],
        chunkSize: 6,
      })),
    );

    const modelsRes = await fetch(`${hub.url}/v1/models`);
    expect(modelsRes.status).toBe(200);
    const modelsJson = (await modelsRes.json()) as { object: string; data: Array<{ id: string }> };
    expect(modelsJson.object).toBe('list');
    expect(modelsJson.data.some((m) => m.id === 'gpt-4o-mock')).toBe(true);

    const res = await fetch(`${hub.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mock',
        stream: true,
        tools: [{ type: 'function', function: { name: 'run_shell' } }],
        messages: [
          { role: 'system', content: 'Chat system' },
          { role: 'user', content: '[CHAT] hello' },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const frames = parseSseFrames(await res.text());
    expect(frames[frames.length - 1]?.data).toBe('[DONE]');

    const chunks = frames.slice(0, -1).map((f) => JSON.parse(f.data) as Record<string, unknown>);
    let reasoning = '';
    let content = '';
    let toolArgs = '';
    let sawUsage = false;

    for (const c of chunks) {
      if (c.usage) sawUsage = true;
      const choices = (c.choices ?? []) as Array<{ delta?: Record<string, unknown> }>;
      const delta = choices[0]?.delta;
      if (!delta) continue;
      if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
      if (typeof delta.content === 'string') content += delta.content;
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls as Array<{ function?: { arguments?: string } }>) {
          if (typeof tc.function?.arguments === 'string') toolArgs += tc.function.arguments;
        }
      }
    }

    expect(reasoning).toBe('Deep reasoning');
    expect(content).toBe('Chat reply text');
    expect(JSON.parse(toolArgs)).toEqual({ command: 'pwd' });
    expect(sawUsage).toBe(true);
  });

  it('serves Google Gemini SSE (?alt=sse), thought parts, functionCall, usageMetadata and models list', async () => {
    const hub = await startHub();
    hub.addRoute(
      routeByTag('[GEMINI]', () => ({
        thinking: { text: 'Gemini internal thought' },
        text: 'Gemini answer',
        toolCalls: [{ id: 'gem_1', name: 'search_files', arguments: { query: 'mock' } }],
        chunkSize: 7,
      })),
    );

    const modelsRes = await fetch(`${hub.url}/v1beta/models`);
    expect(modelsRes.status).toBe(200);
    const modelsJson = (await modelsRes.json()) as { models: Array<{ name: string }> };
    expect(modelsJson.models.some((m) => m.name === 'models/gemini-2.5-mock')).toBe(true);

    const res = await fetch(`${hub.url}/v1beta/models/gemini-2.5-mock:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: 'Gemini system' }] },
        tools: [{ functionDeclarations: [{ name: 'search_files' }] }],
        contents: [{ role: 'user', parts: [{ text: '[GEMINI] run' }] }],
      }),
    });
    expect(res.status).toBe(200);
    const frames = parseSseFrames(await res.text());
    const payloads = frames.map((f) => JSON.parse(f.data) as Record<string, unknown>);

    let thought = '';
    let text = '';
    let fnCall: Record<string, unknown> | undefined;
    let sawUsage = false;

    for (const p of payloads) {
      if (p.usageMetadata) sawUsage = true;
      const candidates = (p.candidates ?? []) as Array<{ content?: { parts?: Array<Record<string, unknown>> } }>;
      for (const part of candidates[0]?.content?.parts ?? []) {
        if (part.thought === true && typeof part.text === 'string') thought += part.text;
        else if (typeof part.text === 'string') text += part.text;
        if (part.functionCall) fnCall = part.functionCall as Record<string, unknown>;
      }
    }

    expect(thought).toBe('Gemini internal thought');
    expect(text).toBe('Gemini answer');
    expect(fnCall?.name).toBe('search_files');
    expect(fnCall?.args).toEqual({ query: 'mock' });
    expect(sawUsage).toBe(true);
  });

  it('synchronizes deterministically with Barrier/Gate checkpoints (afterChunk & beforeFirstToken)', async () => {
    const hub = await startHub();
    hub.addRoute(
      routeByTag('[GATE-MID]', () => replyText('CHUNK_ONE_CHUNK_TWO', {
        chunkSize: 10,
        gates: {
          beforeFirstToken: 'gate:start',
          afterChunk: { index: 1, gate: 'gate:mid' },
        },
      })),
    );

    const responsePromise = fetch(`${hub.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-mock-4',
        stream: true,
        messages: [{ role: 'user', content: '[GATE-MID] pause test' }],
      }),
    });

    // Server stops at beforeFirstToken before emitting any text_delta
    await hub.gates.waitUntilReached('gate:start', 5_000);
    const res = await responsePromise;
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    let accumulated = '';
    const readLoop = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        accumulated += decoder.decode(value, { stream: true });
      }
    })();

    // Give a short window to verify no text_delta is emitted while gated at beforeFirstToken
    await new Promise((r) => setTimeout(r, 40));
    expect(accumulated).not.toContain('CHUNK_ONE_');

    // Release beforeFirstToken -> server emits chunk 1 then blocks at gate:mid
    hub.gates.release('gate:start');
    await hub.gates.waitUntilReached('gate:mid', 5_000);
    await new Promise((r) => setTimeout(r, 40));
    expect(accumulated).toContain('CHUNK_ONE_');
    expect(accumulated).not.toContain('CHUNK_TWO');

    // Release gate:mid -> server emits chunk 2 and completes stream
    hub.gates.release('gate:mid');
    await readLoop;
    expect(accumulated).toContain('CHUNK_TWO');
    expect(accumulated).toContain('message_stop');
  });

  it('isolates concurrent main turn, subagent worker and auxiliary title generation without cross-talk', async () => {
    const hub = await startHub();
    registerTckScripts(hub);

    // Main turn blocks at interrupt-mid-stream gate
    const mainFetch = fetch(`${hub.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-mock-4',
        stream: true,
        messages: [{ role: 'user', content: '[TCK:interrupt-mid-stream] hold main' }],
      }),
    });
    await hub.gates.waitUntilReached('interrupt-mid-stream', 5_000);

    // While main turn is paused, fire subagent worker + title generation concurrently
    const [subRes, titleRes] = await Promise.all([
      fetch(`${hub.url}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-mock-4',
          stream: false,
          messages: [{ role: 'user', content: '[TCK:subagent-worker] parallel job' }],
        }),
      }),
      fetch(`${hub.url}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-mock-4',
          stream: false,
          system: 'Generate a concise title for this conversation.',
          messages: [{ role: 'user', content: '[TCK:interrupt-mid-stream] hold main' }],
        }),
      }),
    ]);

    const subJson = (await subRes.json()) as { content: Array<{ text: string }> };
    const titleJson = (await titleRes.json()) as { content: Array<{ text: string }> };
    expect(subJson.content[0].text).toContain('TCK_SUBAGENT_WORKER_RESULT');
    expect(titleJson.content[0].text).toBe('Mock Session Title');

    // Now release main turn and verify its response is intact
    hub.gates.release('interrupt-mid-stream');
    const mainRes = await mainFetch;
    const mainFrames = parseSseFrames(await mainRes.text());
    const mainOutput = mainFrames
      .map((f) => JSON.parse(f.data) as Record<string, unknown>)
      .filter((e) => e.type === 'content_block_delta' && (e.delta as Record<string, unknown>)?.type === 'text_delta')
      .map((e) => (e.delta as Record<string, unknown>).text as string)
      .join('');
    expect(mainOutput).toBe('TCK_MID_CHUNK_ONE TCK_MID_CHUNK_TWO TCK_MID_CHUNK_THREE');
  });

  it('returns protocol-native HTTP 417 mismatch errors on unmatched requests across all 5 transports', async () => {
    const hub = await startHub({ strict: true });

    // 1. Anthropic
    const anth = await fetch(`${hub.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-mock-4',
        tools: [{ name: 'Bash' }],
        messages: [{ role: 'user', content: 'unexpected anthropic prompt' }],
      }),
    });
    expect(anth.status).toBe(417);
    const anthBody = (await anth.json()) as { type: string; error: { type: string; message: string } };
    expect(anthBody.type).toBe('error');
    expect(anthBody.error.message).toContain('anthropic-messages');
    expect(anthBody.error.message).toContain('Bash');

    // 2. OpenAI Responses HTTP
    const respHttp = await fetch(`${hub.url}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5-mock', input: 'unexpected responses prompt' }),
    });
    expect(respHttp.status).toBe(417);
    const respHttpBody = (await respHttp.json()) as { error: { code: string; message: string } };
    expect(respHttpBody.error.code).toBe('mock_route_mismatch');
    expect(respHttpBody.error.message).toContain('openai-responses');

    // 3. OpenAI Responses WS
    const ws = new WebSocket(`${hub.wsUrl}/v1/responses`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const wsErr = await new Promise<Record<string, unknown>>((resolve) => {
      ws.once('message', (buf) => resolve(JSON.parse(buf.toString('utf8')) as Record<string, unknown>));
      ws.send(JSON.stringify({ type: 'response.create', model: 'gpt-5-mock', input: 'unexpected ws prompt' }));
    });
    expect(wsErr.type).toBe('error');
    expect((wsErr.error as Record<string, unknown>).status).toBe(417);
    expect((wsErr.error as Record<string, unknown>).message).toContain('openai-responses-ws');
    ws.close();

    // 4. OpenAI Chat
    const chat = await fetch(`${hub.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mock', messages: [{ role: 'user', content: 'unexpected chat prompt' }] }),
    });
    expect(chat.status).toBe(417);
    const chatBody = (await chat.json()) as { error: { message: string } };
    expect(chatBody.error.message).toContain('openai-chat');

    // 5. Gemini
    const gem = await fetch(`${hub.url}/v1beta/models/gemini-2.5-mock:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'unexpected gemini prompt' }] }] }),
    });
    expect(gem.status).toBe(417);
    const gemBody = (await gem.json()) as { error: { code: number; status: string; message: string } };
    expect(gemBody.error.code).toBe(417);
    expect(gemBody.error.message).toContain('google-generative-ai');
  });

  it('supports malformed tool JSON injection and tool_result awareness in TCK scripts', async () => {
    const hub = await startHub();
    registerTckScripts(hub);

    // Turn 1: malformed tool JSON emitted verbatim via input_json_delta
    const r1 = await fetch(`${hub.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-mock-4',
        stream: true,
        tools: [{ name: 'Read' }],
        messages: [{ role: 'user', content: '[TCK:tool-malformed-recovery] trigger bad json' }],
      }),
    });
    const frames1 = parseSseFrames(await r1.text());
    const partialJson = frames1
      .map((f) => JSON.parse(f.data) as Record<string, unknown>)
      .filter((e) => e.type === 'content_block_delta' && (e.delta as Record<string, unknown>)?.type === 'input_json_delta')
      .map((e) => (e.delta as Record<string, unknown>).partial_json as string)
      .join('');
    expect(partialJson).toBe('{"file_path": "unterminated-json');
    expect(() => JSON.parse(partialJson)).toThrow();

    // Turn 2: return tool_result error -> script detects tool_result and recovers
    const r2 = await fetch(`${hub.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-mock-4',
        stream: false,
        tools: [{ name: 'Read' }],
        messages: [
          { role: 'user', content: '[TCK:tool-malformed-recovery] trigger bad json' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'tck_malformed_1', name: 'Read', input: {} }] },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tck_malformed_1', is_error: true, content: 'Invalid JSON arguments' }],
          },
        ],
      }),
    });
    const body2 = (await r2.json()) as { content: Array<{ text: string }> };
    expect(body2.content[0].text).toContain('TCK_MALFORMED_RECOVERED');
    expect(body2.content[0].text).toContain('Read(error):Invalid JSON arguments');

    // Approval deny awareness
    const rDeny = await fetch(`${hub.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-mock-4',
        stream: false,
        tools: [{ name: 'Write' }],
        messages: [
          { role: 'user', content: '[TCK:approval-deny] write file' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'tck_w_1', name: 'Write', input: { file_path: 'a.txt' } }] },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tck_w_1', is_error: true, content: 'User denied permission' }],
          },
        ],
      }),
    });
    const denyBody = (await rDeny.json()) as { content: Array<{ text: string }> };
    expect(denyBody.content[0].text).toContain('status=denied');
    expect(denyBody.content[0].text).toContain('User denied permission');
  });

  it('triggers real TCP disconnect mid-stream and audits hasImage & toolNames across protocols', async () => {
    const hub = await startHub();
    hub.addRoute(
      routeByTag('[DROP]', () => replyDisconnect('PART_ONE_PART_TWO_PART_THREE', 1, { chunkSize: 9 })),
    );
    hub.addRoute(
      routeByTag('[IMG]', (req) => replyText(`hasImage=${req.hasImage} tools=${req.toolNames.join(',')}`)),
    );

    // 1. Verify true TCP socket.destroy() aborts chunked HTTP SSE stream prematurely
    const disconnectResult = await new Promise<{ partial: string; aborted: boolean }>((resolve) => {
      const req = http.request(
        `${hub.url}/v1/messages`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        },
        (res) => {
          let partial = '';
          let aborted = false;
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            partial += chunk;
          });
          res.on('aborted', () => {
            aborted = true;
          });
          res.on('error', () => {
            aborted = true;
          });
          res.on('close', () => {
            resolve({ partial, aborted: aborted || !res.complete });
          });
        },
      );
      req.on('error', () => {
        resolve({ partial: '', aborted: true });
      });
      req.end(JSON.stringify({
        model: 'claude-mock-4',
        stream: true,
        messages: [{ role: 'user', content: '[DROP] cut mid stream' }],
      }));
    });
    expect(disconnectResult.partial).toContain('PART_ONE_');
    expect(disconnectResult.partial).not.toContain('message_stop');
    expect(disconnectResult.aborted).toBe(true);

    // 2. Verify request journal audits hasImage & toolNames across protocols
    hub.clearRequests();
    const waitGemini = hub.waitForRequest((r) => r.protocol === 'google-generative-ai' && r.hasImage);

    await Promise.all([
      fetch(`${hub.url}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-mock-4',
          tools: [{ name: 'Read' }, { name: 'Bash' }],
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: '[IMG] anthropic' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
            ],
          }],
        }),
      }),
      fetch(`${hub.url}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5-mock',
          tools: [{ type: 'function', name: 'exec_command' }],
          input: [{
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: '[IMG] responses' },
              { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=' },
            ],
          }],
        }),
      }),
      fetch(`${hub.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mock',
          tools: [{ type: 'function', function: { name: 'run_shell' } }],
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: '[IMG] chat' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
            ],
          }],
        }),
      }),
      fetch(`${hub.url}/v1beta/models/gemini-2.5-mock:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tools: [{ functionDeclarations: [{ name: 'inspect_image' }] }],
          contents: [{
            role: 'user',
            parts: [
              { text: '[IMG] gemini' },
              { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } },
            ],
          }],
        }),
      }),
    ]);

    const geminiAudit = await waitGemini;
    expect(geminiAudit.hasImage).toBe(true);
    expect(geminiAudit.toolNames).toEqual(['inspect_image']);

    const all = hub.requests();
    expect(all).toHaveLength(4);
    expect(all.every((r) => r.hasImage)).toBe(true);
    expect(all.find((r) => r.protocol === 'anthropic-messages')?.toolNames).toEqual(['Read', 'Bash']);
    expect(all.find((r) => r.protocol === 'openai-responses')?.toolNames).toEqual(['exec_command']);
    expect(all.find((r) => r.protocol === 'openai-chat')?.toolNames).toEqual(['run_shell']);
  });

  it('scopes hasToolResultForCurrentTurn and currentTurnToolResults strictly to the current user turn', async () => {
    const hub = await startHub();
    registerTckScripts(hub, { tools: DEFAULT_CLAUDE_TOOLS });

    // Turn 1 had a tool_use + error tool_result; Turn 2 starts a brand new user prompt.
    const turn2Start = await fetch(`${hub.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-mock-4',
        stream: false,
        tools: [{ name: 'Read' }, { name: 'Write' }],
        messages: [
          { role: 'user', content: '[TCK:tool-read-bash] turn 1' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'old_read_1', name: 'Read', input: { file_path: 'README.md' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old_read_1', is_error: true, content: 'old error from turn 1' }] },
          { role: 'assistant', content: 'Turn 1 done.' },
          { role: 'user', content: '[TCK:approval-allow] file=fresh.txt' },
        ],
      }),
    });
    expect(turn2Start.status).toBe(200);
    const turn2Body = (await turn2Start.json()) as {
      stop_reason: string;
      content: Array<{ type: string; name?: string; input?: Record<string, unknown> }>;
    };
    // Must emit a new tool_use instead of falsely reusing Turn 1's tool_result
    expect(turn2Body.stop_reason).toBe('tool_use');
    expect(turn2Body.content[0]?.type).toBe('tool_use');
    expect(turn2Body.content[0]?.name).toBe('Write');
    expect(turn2Body.content[0]?.input).toEqual({ file_path: 'fresh.txt', content: 'hi\n' });

    const reqAfterTurn2Start = hub.requests()[0];
    expect(hasToolResultForCurrentTurn(reqAfterTurn2Start)).toBe(false);
    expect(currentTurnToolResults(reqAfterTurn2Start)).toEqual([]);

    // Turn 2b: now Turn 2's own tool_result arrives; status must be 'allowed' and must NOT echo Turn 1's error
    const turn2Done = await fetch(`${hub.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-mock-4',
        stream: false,
        tools: [{ name: 'Read' }, { name: 'Write' }],
        messages: [
          { role: 'user', content: '[TCK:tool-read-bash] turn 1' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'old_read_1', name: 'Read', input: { file_path: 'README.md' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old_read_1', is_error: true, content: 'old error from turn 1' }] },
          { role: 'assistant', content: 'Turn 1 done.' },
          { role: 'user', content: '[TCK:approval-allow] file=fresh.txt' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'new_write_2', name: 'Write', input: { file_path: 'fresh.txt', content: 'hi\n' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'new_write_2', is_error: false, content: 'wrote fresh.txt' }] },
        ],
      }),
    });
    const turn2DoneBody = (await turn2Done.json()) as { content: Array<{ text: string }> };
    expect(turn2DoneBody.content[0]?.text).toContain('status=allowed');
    expect(turn2DoneBody.content[0]?.text).toContain('Write(ok):wrote fresh.txt');
    expect(turn2DoneBody.content[0]?.text).not.toContain('old error from turn 1');

    const reqAfterTurn2Done = hub.requests()[1];
    expect(hasToolResultForCurrentTurn(reqAfterTurn2Done)).toBe(true);
    expect(currentTurnToolResults(reqAfterTurn2Done)).toHaveLength(1);
    expect(currentTurnToolResults(reqAfterTurn2Done)[0]?.toolCallId).toBe('new_write_2');
  });

  it('adapts TCK tool arguments per ToolArgProfile, formats Codex narration, and resets attempt counters', async () => {
    const codexHub = await startHub();
    const codexHandle = registerTckScripts(codexHub, { tools: DEFAULT_CODEX_TOOLS });

    // Codex read + bash + write all use exec_command with strict { cmd }
    const codexReadBash = await fetch(`${codexHub.url}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5-mock',
        stream: false,
        tools: [{ type: 'function', name: 'exec_command' }],
        input: '[TCK:tool-read-bash] file=README.md',
      }),
    });
    const codexReadBashJson = (await codexReadBash.json()) as {
      output: Array<{ type: string; name?: string; arguments?: string }>;
    };
    const calls = codexReadBashJson.output.filter((o) => o.type === 'function_call');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.name).toBe('exec_command');
    expect(JSON.parse(calls[0]!.arguments!)).toEqual({ cmd: 'cat README.md' });
    expect(calls[1]?.name).toBe('exec_command');
    expect(Object.keys(JSON.parse(calls[1]!.arguments!))).toEqual(['cmd']);

    const codexWrite = await fetch(`${codexHub.url}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5-mock',
        stream: false,
        tools: [{ type: 'function', name: 'exec_command' }],
        input: '[TCK:approval-allow] file=out.txt',
      }),
    });
    const codexWriteJson = (await codexWrite.json()) as {
      output: Array<{ type: string; name?: string; arguments?: string }>;
    };
    const writeCall = codexWriteJson.output.find((o) => o.type === 'function_call');
    expect(writeCall?.name).toBe('exec_command');
    expect(JSON.parse(writeCall!.arguments!)).toEqual({
      cmd: "printf 'hi\\n' > out.txt",
      sandbox_permissions: 'require_escalated',
      justification: 'May I create out.txt in this isolated test workspace?',
    });

    // Rich stream narration begins with **Progress**\n for Codex reasoningChannel compatibility
    const richRes = await fetch(`${codexHub.url}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5-mock',
        stream: false,
        input: '[TCK:rich-stream] narration=true',
      }),
    });
    const richJson = (await richRes.json()) as {
      output: Array<{ type: string; summary?: Array<{ text: string }> }>;
    };
    const reasoningItem = richJson.output.find((o) => o.type === 'reasoning');
    expect(reasoningItem?.summary?.[0]?.text.startsWith('**Progress**\n')).toBe(true);

    // resetCounters restores attempt 1 failure for http-error-recovery
    const err1 = await fetch(`${codexHub.url}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5-mock', stream: false, input: '[TCK:http-error-recovery]' }),
    });
    expect(err1.status).toBe(429);
    const ok2 = await fetch(`${codexHub.url}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5-mock', stream: false, input: '[TCK:http-error-recovery]' }),
    });
    expect(ok2.status).toBe(200);
    codexHandle.resetCounters();
    const errAgain = await fetch(`${codexHub.url}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5-mock', stream: false, input: '[TCK:http-error-recovery]' }),
    });
    expect(errAgain.status).toBe(429);

    // Pi profile emits strictly { path } for read and { command } for bash
    const piHub = await startHub();
    registerTckScripts(piHub, {
      tools: { read: 'read', write: 'write', bash: 'bash', argProfile: 'pi' },
    });
    const piRes = await fetch(`${piHub.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mock',
        stream: false,
        tools: [
          { type: 'function', function: { name: 'read' } },
          { type: 'function', function: { name: 'bash' } },
        ],
        messages: [{ role: 'user', content: '[TCK:tool-read-bash] file=README.md' }],
      }),
    });
    const piJson = (await piRes.json()) as {
      choices: Array<{ message: { tool_calls: Array<{ function: { name: string; arguments: string } }> } }>;
    };
    const piCalls = piJson.choices[0].message.tool_calls;
    expect(piCalls[0].function.name).toBe('read');
    expect(JSON.parse(piCalls[0].function.arguments)).toEqual({ path: 'README.md' });
    expect(piCalls[1].function.name).toBe('bash');
    expect(Object.keys(JSON.parse(piCalls[1].function.arguments))).toEqual(['command']);
  });

  it('handles Responses incomplete, response.failed, HTTP previous_response_id, tool image, and clean WS fault history', async () => {
    const hub = await startHub();
    hub.addRoute(
      routeByTag('[RESP-INCOMPLETE]', () => replyText('cut off reply', { stopReason: 'length', chunkSize: 8 })),
    );
    hub.addRoute(
      routeByTag('[RESP-FAIL]', () => ({
        text: 'partial text before failure',
        chunkSize: 8,
        streamFault: { afterChunks: 1, mode: 'sse-error', message: 'upstream crashed' },
      })),
    );
    hub.addRoute(
      routeByTag('[RESP-CHAIN]', (req) => {
        if (req.toolResults.length > 0) {
          return replyText(`HTTP_CHAIN:${req.toolResults[0].toolName}:hasImage=${req.hasImage}`);
        }
        return replyToolCall({ id: 'call_http_1', name: 'take_screenshot', arguments: {} });
      }),
    );
    hub.addRoute(
      routeByTag('[WS-CLEAN]', (req) => replyText(`WS_TURNS=${req.assistantTurns}:msgs=${req.messages.length}`)),
    );

    // 1. stopReason: 'length' -> event: response.incomplete
    const incRes = await fetch(`${hub.url}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5-mock', stream: true, input: '[RESP-INCOMPLETE]' }),
    });
    const incFrames = parseSseFrames(await incRes.text());
    const lastIncFrame = incFrames[incFrames.length - 1];
    expect(lastIncFrame?.event).toBe('response.incomplete');
    const lastIncData = JSON.parse(lastIncFrame!.data) as {
      type: string;
      response: { status: string; incomplete_details?: { reason: string } };
    };
    expect(lastIncData.type).toBe('response.incomplete');
    expect(lastIncData.response.status).toBe('incomplete');
    expect(lastIncData.response.incomplete_details?.reason).toBe('max_output_tokens');
    expect(incFrames.some((f) => f.event === 'response.completed')).toBe(false);

    // 2. streamFault sse-error -> event: response.failed with standard payload
    const failRes = await fetch(`${hub.url}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5-mock', stream: true, input: '[RESP-FAIL]' }),
    });
    const failFrames = parseSseFrames(await failRes.text());
    const failedFrame = failFrames[failFrames.length - 1];
    expect(failedFrame?.event).toBe('response.failed');
    const failedData = JSON.parse(failedFrame!.data) as {
      type: string;
      response: { id: string; status: string; error: { code: string; message: string } };
    };
    expect(failedData.type).toBe('response.failed');
    expect(failedData.response.id).toMatch(/^resp_mock_/);
    expect(failedData.response.status).toBe('failed');
    expect(failedData.response.error).toEqual({ code: 'server_error', message: 'upstream crashed' });

    // 3. HTTP POST /v1/responses previous_response_id + function_call_output array with input_image
    const chain1 = await fetch(`${hub.url}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5-mock', stream: false, input: '[RESP-CHAIN] snap' }),
    });
    const chain1Json = (await chain1.json()) as { id: string };
    const chain2 = await fetch(`${hub.url}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5-mock',
        stream: false,
        previous_response_id: chain1Json.id,
        input: [{
          type: 'function_call_output',
          call_id: 'call_http_1',
          output: [
            { type: 'input_text', text: 'captured screen' },
            { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=' },
          ],
        }],
      }),
    });
    const chain2Json = (await chain2.json()) as { output_text: string };
    expect(chain2Json.output_text).toBe('HTTP_CHAIN:take_screenshot:hasImage=true');

    // 4. WS streamFault must emit response.failed and must NOT save empty assistant turn into historyByResponseId
    const ws = new WebSocket(`${hub.wsUrl}/v1/responses`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });

    const receiveUntilTerminal = (): Promise<Array<Record<string, unknown>>> =>
      new Promise((resolve, reject) => {
        const events: Array<Record<string, unknown>> = [];
        const onMsg = (buf: Buffer) => {
          const evt = JSON.parse(buf.toString('utf8')) as Record<string, unknown>;
          events.push(evt);
          if (
            evt.type === 'response.completed'
            || evt.type === 'response.incomplete'
            || evt.type === 'response.failed'
            || evt.type === 'error'
          ) {
            ws.off('message', onMsg);
            resolve(events);
          }
        };
        ws.on('message', onMsg);
        ws.once('error', reject);
      });

    const faultTurnPromise = receiveUntilTerminal();
    ws.send(JSON.stringify({ type: 'response.create', model: 'gpt-5-mock', input: '[RESP-FAIL]' }));
    const faultEvents = await faultTurnPromise;
    const wsFailed = faultEvents.find((e) => e.type === 'response.failed') as {
      response: { id: string; status: string; error: { code: string; message: string } };
    };
    expect(wsFailed).toBeDefined();
    expect(wsFailed.response.status).toBe('failed');
    expect(wsFailed.response.error.message).toBe('upstream crashed');

    // Referencing the faulted response_id must NOT inherit a polluted empty assistant turn
    const followUpPromise = receiveUntilTerminal();
    ws.send(JSON.stringify({
      type: 'response.create',
      model: 'gpt-5-mock',
      previous_response_id: wsFailed.response.id,
      input: '[WS-CLEAN] check',
    }));
    const followUpEvents = await followUpPromise;
    const followUpText = followUpEvents
      .filter((e) => e.type === 'response.output_text.delta')
      .map((e) => e.delta as string)
      .join('');
    expect(followUpText).toBe('WS_TURNS=0:msgs=1');
    ws.close();
  });

  it('propagates hasImage from OpenAI Chat role=tool messages and avoids empty Gemini stream parts', async () => {
    const hub = await startHub();
    hub.addRoute(
      routeByTag('[CHAT-TOOL-IMG]', (req) => replyText(`chatToolHasImage=${req.hasImage}`)),
    );
    hub.addRoute(
      routeByTag('[GEMINI-NO-EMPTY]', () => replyText('Hello Gemini stream', { chunkSize: 6 })),
    );

    // 1. OpenAI Chat role: 'tool' with image_url -> hasImage === true
    const chatRes = await fetch(`${hub.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mock',
        stream: false,
        messages: [
          { role: 'user', content: '[CHAT-TOOL-IMG] inspect' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'tc_img_1', type: 'function', function: { name: 'screenshot', arguments: '{}' } }],
          },
          {
            role: 'tool',
            tool_call_id: 'tc_img_1',
            content: [
              { type: 'text', text: 'image captured' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
            ],
          },
        ],
      }),
    });
    const chatJson = (await chatRes.json()) as { choices: Array<{ message: { content: string } }> };
    expect(chatJson.choices[0].message.content).toBe('chatToolHasImage=true');

    // 2. Gemini SSE stream never emits an empty parts: [] frame
    const gemRes = await fetch(`${hub.url}/v1beta/models/gemini-2.5-mock:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: '[GEMINI-NO-EMPTY] go' }] }],
      }),
    });
    expect(gemRes.status).toBe(200);
    const gemPayloads = parseSseFrames(await gemRes.text()).map((f) => JSON.parse(f.data) as {
      candidates?: Array<{ content?: { parts?: unknown[] }; finishReason?: string }>;
      usageMetadata?: Record<string, unknown>;
    });
    expect(gemPayloads.length).toBeGreaterThan(0);
    for (const payload of gemPayloads) {
      const parts = payload.candidates?.[0]?.content?.parts;
      if (parts !== undefined) {
        expect(parts.length).toBeGreaterThan(0);
      }
    }
    const lastPayload = gemPayloads[gemPayloads.length - 1];
    expect(lastPayload.candidates?.[0]?.finishReason).toBe('STOP');
    expect(lastPayload.usageMetadata).toBeDefined();

    // 3. GET /v1/models recognizes Gemini via x-goog-api-key header or ?key= query param
    const gemModelsHeader = await fetch(`${hub.url}/v1/models`, {
      headers: { 'x-goog-api-key': 'test-gemini-key' },
    });
    expect(gemModelsHeader.status).toBe(200);
    const gemModelsHeaderJson = (await gemModelsHeader.json()) as { models?: Array<{ name: string }> };
    expect(gemModelsHeaderJson.models?.some((m) => m.name === 'models/gemini-2.5-mock')).toBe(true);

    const gemModelsQuery = await fetch(`${hub.url}/v1/models?key=test-gemini-key`);
    expect(gemModelsQuery.status).toBe(200);
    const gemModelsQueryJson = (await gemModelsQuery.json()) as { models?: Array<{ name: string }> };
    expect(gemModelsQueryJson.models?.some((m) => m.name === 'models/gemini-2.5-mock')).toBe(true);
  });
});
