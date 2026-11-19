import { describe, expect, it } from 'vitest';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { requestTitle } from '../titles/request.js';
import { complete, gatewayModelId, streamChat, streamComplete, type GatewayProtocol } from './gateway.js';

function fakeFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: URL | string, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { impl, calls };
}

async function ask(protocol: GatewayProtocol, body: unknown, baseUrl = 'https://gw.example') {
  const fake = fakeFetch(body);
  const title = await requestTitle({ protocol, baseUrl, apiKey: 'k', model: 'm', message: '帮我看一下统计页面', reply: '好的', fetchImpl: fake.impl });
  return { title, call: fake.calls[0]!, sent: JSON.parse(String(fake.calls[0]!.init.body)) as Record<string, unknown> };
}

it('keeps provider headers and prompts on the configured origin through completion, streaming and fallback redirects', async () => {
  const received: Array<{ path: string; headers: IncomingHttpHeaders; body: string }> = [];
  const sink = createServer((_, response) => { response.end('Unexpected cross-origin request'); });
  let leaked = 0;
  sink.on('request', () => { leaked += 1; });
  await new Promise<void>(resolve => sink.listen(0, '127.0.0.1', resolve));
  const sinkUrl = `http://127.0.0.1:${(sink.address() as AddressInfo).port}`;
  const source = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    received.push({ path: request.url!, headers: request.headers, body });
    const streaming = JSON.parse(body).stream;
    if (request.url!.startsWith('/fallback') && streaming) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Search requires non-streaming requests' } }));
    } else if (request.url === '/final') {
      response.end(streaming ? 'event: message_stop\ndata: {"type":"message_stop"}\n\n' : JSON.stringify({ content: [{ type: 'text', text: 'OK' }] }));
    } else {
      response.writeHead(request.url!.startsWith('/same') ? 308 : 307, { location: request.url!.startsWith('/same') ? '/final' : sinkUrl });
      response.end();
    }
  });
  try {
    await new Promise<void>(resolve => source.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(source.address() as AddressInfo).port}`;
    const headers = { 'x-api-key': 'dummy-key', 'x-provider-auth': 'dummy-provider-key' };
    const completion = (path: string) => complete({ protocol: 'anthropic', baseUrl: `${origin}/${path}`, headers, model: 'm', system: 'S', content: 'private question', maxOutputTokens: 10, timeoutMs: 1000 });
    const stream = (path: string) => streamChat({ protocol: 'anthropic', baseUrl: `${origin}/${path}`, headers, model: 'm', messages: [{ role: 'user', content: 'private question' }], search: path === 'fallback', maxOutputTokens: 10, idleTimeoutMs: 1000, onDelta: () => {} });
    await expect(completion('cross')).rejects.toThrow('different origin');
    await expect(stream('cross')).rejects.toThrow('different origin');
    await expect(stream('fallback')).rejects.toThrow('different origin');
    expect(leaked).toBe(0);
    expect(await completion('same')).toBe('OK');
    await expect(stream('same')).resolves.toMatchObject({ text: '', cutOff: false });
    const redirected = received.filter(request => request.path === '/final');
    expect(redirected).toHaveLength(2);
    expect(redirected.every(request => request.headers['x-api-key'] === 'dummy-key' && request.headers['x-provider-auth'] === 'dummy-provider-key' && request.body.includes('private question'))).toBe(true);
  } finally {
    await Promise.all([source, sink].map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
  }
});

describe('requestTitle', () => {
  it('speaks the Anthropic messages format to a Claude gateway, with thinking off', async () => {
    const { title, call, sent } = await ask('anthropic', { content: [{ type: 'thinking', thinking: '…' }, { type: 'text', text: '优化统计页面样式' }] });
    expect(title).toBe('优化统计页面样式');
    expect(call.url).toBe('https://gw.example/v1/messages');
    expect(call.init.headers).toMatchObject({ authorization: 'Bearer k', 'anthropic-version': '2023-06-01' });
    expect(sent).toMatchObject({ model: 'm', thinking: { type: 'disabled' } });
    expect(JSON.stringify(sent.messages)).toContain('<agent_reply>');
  });

  it('speaks chat completions to a DSH gateway and Responses to a Codex gateway, reusing a /v1 base', async () => {
    const chat = await ask('chat', { choices: [{ message: { content: '「优化统计页面样式」。' } }] }, 'https://gw.example/v1/');
    expect(chat.title).toBe('优化统计页面样式');
    expect(chat.call.url).toBe('https://gw.example/v1/chat/completions');
    const responses = await ask('responses', { output: [{ type: 'message', content: [{ type: 'output_text', text: 'Fix login redirect' }] }] });
    expect(responses.title).toBe('Fix login redirect');
    expect(responses.call.url).toBe('https://gw.example/v1/responses');
  });

  it('sends any purpose\'s system prompt and output budget in each protocol\'s own fields', async () => {
    const request = { baseUrl: 'https://gw.example', model: 'm', system: 'S', content: 'C', maxOutputTokens: 8_192, timeoutMs: 1_000 };
    const anthropic = fakeFetch({ content: [{ type: 'text', text: 'A' }] });
    expect(await complete({ ...request, protocol: 'anthropic', fetchImpl: anthropic.impl })).toBe('A');
    expect(JSON.parse(String(anthropic.calls[0]!.init.body))).toMatchObject({ system: 'S', max_tokens: 8_192, messages: [{ role: 'user', content: 'C' }] });
    const chat = fakeFetch({ choices: [{ message: { content: 'B' } }] });
    expect(await complete({ ...request, protocol: 'chat', fetchImpl: chat.impl })).toBe('B');
    expect(JSON.parse(String(chat.calls[0]!.init.body))).toMatchObject({ max_tokens: 8_192, messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'C' }] });
    const responses = fakeFetch({ output_text: 'D' });
    expect(await complete({ ...request, protocol: 'responses', fetchImpl: responses.impl })).toBe('D');
    expect(JSON.parse(String(responses.calls[0]!.init.body))).toMatchObject({ instructions: 'S', input: 'C', max_output_tokens: 8_192 });
  });

  it('refuses an answer the output budget cut off, and names the gateway\'s reason for an error', async () => {
    const request = { baseUrl: 'https://gw.example', model: 'm', system: 'S', content: 'C', maxOutputTokens: 10, timeoutMs: 1_000 };
    await expect(complete({ ...request, protocol: 'anthropic', fetchImpl: fakeFetch({ stop_reason: 'max_tokens', content: [{ type: 'text', text: 'half' }] }).impl })).rejects.toThrow('cut off');
    await expect(complete({ ...request, protocol: 'chat', fetchImpl: fakeFetch({ choices: [{ finish_reason: 'length', message: { content: 'half' } }] }).impl })).rejects.toThrow('cut off');
    await expect(complete({ ...request, protocol: 'responses', fetchImpl: fakeFetch({ status: 'incomplete', output_text: 'half' }).impl })).rejects.toThrow('cut off');
    await expect(complete({ ...request, protocol: 'chat', fetchImpl: fakeFetch({ error: { message: 'maximum context length exceeded' } }, 400).impl })).rejects.toThrow('HTTP 400: maximum context length exceeded');
  });

  it('fails on an HTTP error or an empty answer', async () => {
    await expect(requestTitle({ protocol: 'chat', baseUrl: 'https://gw.example', model: 'm', message: 'x', fetchImpl: fakeFetch({}, 401).impl })).rejects.toThrow('HTTP 401');
    await expect(requestTitle({ protocol: 'chat', baseUrl: 'https://gw.example', model: 'm', message: 'x', fetchImpl: fakeFetch({ choices: [{ message: { content: '  ' } }] }).impl })).rejects.toThrow('no title');
  });
});

describe('streamChat', () => {
  it('preserves inherited Anthropic effort as a named adaptive setting', async () => {
    const calls: RequestInit[] = [];
    await streamChat({ protocol: 'anthropic', baseUrl: 'https://source.example', model: 'claude-x', messages: [{ role: 'user', content: 'hi' }],
      effort: 'xhigh', adaptiveThinking: true, maxOutputTokens: 100, idleTimeoutMs: 1000, onDelta: () => {},
      fetchImpl: (async (_url, init) => { calls.push(init!); return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n'); }) as typeof fetch });
    expect(JSON.parse(String(calls[0]!.body))).toMatchObject({ thinking: { type: 'adaptive' }, output_config: { effort: 'xhigh' } });
  });

  const stream = (blocks: string[]) => (async () => new Response(new ReadableStream({
    start(controller) { for (const block of blocks) controller.enqueue(new TextEncoder().encode(block)); controller.close(); },
  }), { status: 200 })) as unknown as typeof fetch;
  const ask = (protocol: GatewayProtocol, blocks: string[]) => {
    const deltas: string[] = [];
    return streamChat({ protocol, baseUrl: 'https://gw.example', model: 'm', messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 100, idleTimeoutMs: 1_000, onDelta: (kind, text) => deltas.push(`${kind}:${text}`), fetchImpl: stream(blocks) })
      .then(result => ({ result, deltas }));
  };

  it('reads each protocol\'s stream, split anywhere, into text, reasoning, usage and a cut-off', async () => {
    const anthropic = await ask('anthropic', [
      'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-x","usage":{"input_tokens":7}}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hm"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"He"}}\n\nevent: content_bl',
      'ock_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"llo"}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":3}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]);
    expect(anthropic.result).toEqual({ text: 'Hello', reasoning: 'hm', cutOff: true, model: 'claude-x', inputTokens: 7, outputTokens: 3 });
    expect(anthropic.deltas).toEqual(['reasoning:hm', 'text:He', 'text:llo']);
    const responses = await ask('responses', [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hi"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"model":"gpt-x","usage":{"input_tokens":2,"output_tokens":1}}}\n\n',
    ]);
    expect(responses.result).toEqual({ text: 'Hi', reasoning: '', cutOff: false, model: 'gpt-x', inputTokens: 2, outputTokens: 1 });
    await expect(ask('chat', ['data: {"error":{"message":"quota exceeded"}}\n\n'])).rejects.toThrow('quota exceeded');
  });

  it('rejects a stream that closes after partial text without a completion event', async () => {
    for (const [protocol, event] of [
      ['anthropic', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } }],
      ['chat', { choices: [{ delta: { content: 'partial' } }] }],
      ['responses', { type: 'response.output_text.delta', delta: 'partial' }],
    ] as const) {
      await expect(ask(protocol, [`data: ${JSON.stringify(event)}\n\n`])).rejects.toThrow('model stream ended before the answer completed');
    }
  });

  it('keeps the model refusal as the answer text', async () => {
    const refusal = 'I cannot help with that.';
    const responses = await ask('responses', [
      `data: ${JSON.stringify({ type: 'response.refusal.delta', delta: refusal })}\n\n`,
      'data: {"type":"response.completed","response":{}}\n\n',
    ]);
    expect(responses.result.text).toBe(refusal);
    expect(responses.deltas).toEqual([`text:${refusal}`]);
    const chat = await ask('chat', [
      `data: ${JSON.stringify({ choices: [{ delta: { content: '', refusal }, finish_reason: 'stop' }] })}\n\n`,
    ]);
    expect(chat.result.text).toBe(refusal);
  });

  it('sends a turn\'s pictures and documents in each protocol\'s own shape', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return new Response('data: [DONE]\n\n', { status: 200 }); }) as unknown as typeof fetch;
    const message = { role: 'user' as const, content: 'what is this', parts: [{ type: 'image' as const, mimeType: 'image/png', data: 'AA==' }, { type: 'pdf' as const, name: 'a.pdf', data: 'BB==' }] };
    for (const protocol of ['anthropic', 'chat', 'responses'] as const) {
      await streamChat({ protocol, baseUrl: 'https://gw.example', model: 'm', messages: [message], maxOutputTokens: 10, idleTimeoutMs: 1_000, onDelta: () => undefined, fetchImpl });
    }
    const types = (body: Record<string, unknown>, key: string) => ((body[key] as Array<{ content: Array<{ type: string }> }>).at(-1)!.content).map(part => part.type);
    expect(types(bodies[0]!, 'messages')).toEqual(['image', 'document', 'text']);
    // A chat-completions gateway has no document part; the driver refuses a PDF for it before sending.
    expect(types(bodies[1]!, 'messages')).toEqual(['image_url', 'text']);
    expect(types(bodies[2]!, 'input')).toEqual(['input_image', 'input_file', 'input_text']);
  });

  it('asks the gateway to search only where its protocol has a search tool', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return new Response('data: [DONE]\n\n', { status: 200 }); }) as unknown as typeof fetch;
    for (const protocol of ['anthropic', 'responses'] as const) {
      await streamChat({ protocol, baseUrl: 'https://gw.example', model: 'm', messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 10, idleTimeoutMs: 1_000, search: true, onDelta: () => undefined, fetchImpl });
    }
    expect(bodies.map(body => (body.tools as Array<{ type: string }>)[0]!.type)).toEqual(['web_search_20250305', 'web_search']);
  });

  it('asks once more for the whole answer when the gateway searches only without streaming', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (body.stream) return new Response(JSON.stringify({ error: { message: 'DeepSeek native web search supports only non-streaming requests; set stream to false' } }), { status: 400 });
      return Response.json({ model: 'deepseek-v4', content: [{ type: 'server_tool_use' }, { type: 'text', text: 'Found it.' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 3 } });
    }) as unknown as typeof fetch;
    const deltas: string[] = [];
    const result = await streamChat({ protocol: 'anthropic', baseUrl: 'https://gw.example', model: 'm', messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 10, idleTimeoutMs: 1_000, search: true, onDelta: (kind, text) => deltas.push(`${kind}:${text}`), fetchImpl });
    expect(bodies.map(body => body.stream)).toEqual([true, false]);
    expect(result).toMatchObject({ text: 'Found it.', model: 'deepseek-v4', cutOff: false, outputTokens: 3 });
    expect(deltas).toEqual(['text:Found it.']);
  });
});

describe('gatewayModelId', () => {
  it('strips the picker decoration a gateway does not know', () => {
    expect(gatewayModelId('dsh', 'dsh:deepseek-official:deepseek-v4.1-flash[effort=max]')).toBe('deepseek-v4.1-flash');
    expect(gatewayModelId('claude', 'glm-5.3')).toBe('glm-5.3');
    expect(gatewayModelId('codex', 'gpt-5.5[effort=high]')).toBe('gpt-5.5');
  });
});

describe('fast zero-thinking mode and streamComplete', () => {
  it('disables reasoning on responses with adaptive fallback and remembers the supported level', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      sent.push(body);
      const effort = (body.reasoning as { effort?: string } | undefined)?.effort;
      if (effort === 'none') {
        return new Response(JSON.stringify({ error: { message: "Unsupported value: 'none' for reasoning.effort" } }), { status: 400 });
      }
      return Response.json({ output_text: 'Fast OK' });
    }) as unknown as typeof fetch;

    const base = { protocol: 'responses' as const, baseUrl: 'https://resp-fallback.example/v1', model: 'gpt-reasoning', system: 'S', content: 'C', maxOutputTokens: 100, timeoutMs: 1_000, fetchImpl };
    expect(await complete(base)).toBe('Fast OK');
    expect(sent.map(b => (b.reasoning as { effort?: string } | undefined)?.effort)).toEqual(['none', 'minimal']);

    // Subsequent call reuses the cached 'minimal' level without hitting 400 again.
    expect(await complete(base)).toBe('Fast OK');
    expect(sent).toHaveLength(3);
    expect((sent[2]!.reasoning as { effort?: string } | undefined)?.effort).toBe('minimal');
  });

  it('streams only answer text deltas in streamComplete and ignores reasoning deltas', async () => {
    const chunks = [
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"secret"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"译"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"文"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    const deltas: string[] = [];
    const fetchImpl = (async () => new Response(new ReadableStream({
      start(controller) { for (const c of chunks) controller.enqueue(new TextEncoder().encode(c)); controller.close(); },
    }), { status: 200 })) as unknown as typeof fetch;

    const full = await streamComplete({
      protocol: 'anthropic', baseUrl: 'https://gw.example', model: 'm', system: 'S', content: 'C',
      maxOutputTokens: 100, timeoutMs: 1_000, onDelta: delta => deltas.push(delta), fetchImpl,
    });
    expect(full).toBe('译文');
    expect(deltas).toEqual(['译', '文']);
  });
});
