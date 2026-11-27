import { MODEL_CHAT_BUDGET, type ModelChatResponseFormat, type NativeBackendId } from '../../../../packages/contracts/src/index.js';

/**
 * Backends whose profile gateway the workbench can call itself, and the wire format each one
 * already speaks: Claude Code is pointed at an Anthropic-compatible endpoint, DSH at a
 * DeepSeek/OpenAI chat endpoint, and Codex at an OpenAI Responses endpoint. A backend whose endpoint
 * speaks the CLI's own protocol is not listed: its models cannot serve as auxiliary models.
 */
export const AUXILIARY_MODEL_BACKENDS: readonly NativeBackendId[] = ['claude', 'dsh', 'codex'];
export type GatewayProtocol = 'anthropic' | 'chat' | 'responses';
const PROTOCOLS: Partial<Record<NativeBackendId, GatewayProtocol>> = { claude: 'anthropic', dsh: 'chat', codex: 'responses' };

export function gatewayProtocol(backendId: NativeBackendId): GatewayProtocol | undefined {
  return PROTOCOLS[backendId];
}

/**
 * The id the gateway itself serves. Pickers store selections with a backend's own decoration —
 * DSH spells `dsh:<provider>:<model>[effort=…]`, and any backend may carry a `[…]` parameter
 * suffix — none of which a gateway has heard of.
 */
export function gatewayModelId(backendId: NativeBackendId, value: string): string {
  let id = value.replace(/\[[^\]]*\]$/u, '');
  if (backendId === 'dsh' && id.startsWith('dsh:')) {
    const model = id.split(':').slice(2).join(':');
    try { id = decodeURIComponent(model); } catch { id = model; }
  }
  return id;
}

/** `/v1/<path>` under a base URL configured with or without its version segment. */
export function endpoint(baseUrl: string, path: string): URL {
  const url = new URL(baseUrl);
  const base = url.pathname.replace(/\/+$/, '');
  url.pathname = /\/v\d+$/.test(base) ? `${base}/${path}` : `${base}/v1/${path}`;
  return url;
}

/** Custom provider credentials and conversation bodies must stay on the configured origin. */
export async function modelRequest(url: URL, init: RequestInit, fetchImpl: typeof fetch = fetch): Promise<Response> {
  let target = url;
  for (let redirects = 0; ; redirects++) {
    const response = await fetchImpl(target, { ...init, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    await response.body?.cancel();
    const destination = new URL(location, target);
    if (destination.origin !== url.origin) throw new Error('Model endpoint redirected to a different origin');
    // Model requests are POSTs. A redirect that rewrites them as GET cannot produce a completion.
    if (response.status !== 307 && response.status !== 308) throw new Error('Model endpoint redirect must preserve the request method');
    if (redirects >= 5) throw new Error('Model endpoint exceeded the redirect limit');
    target = destination;
  }
}

function textOf(protocol: GatewayProtocol, body: unknown): string | undefined {
  const value = body as Record<string, unknown> | undefined;
  if (protocol === 'anthropic') {
    const blocks = Array.isArray(value?.content) ? value.content as Array<Record<string, unknown>> : [];
    return blocks.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text as string).join('');
  }
  if (protocol === 'chat') {
    const message = (Array.isArray(value?.choices) ? value.choices[0] as Record<string, unknown> : undefined)?.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map(part => typeof part?.text === 'string' ? part.text : '').join('');
    return undefined;
  }
  if (typeof value?.output_text === 'string') return value.output_text;
  const output = Array.isArray(value?.output) ? value.output as Array<Record<string, unknown>> : [];
  return output.flatMap(item => Array.isArray(item.content) ? item.content as Array<Record<string, unknown>> : [])
    .filter(part => part.type === 'output_text' && typeof part.text === 'string').map(part => part.text as string).join('');
}

/** Where one auxiliary model is served, resolved from a backend profile. */
export interface GatewayEndpoint {
  protocol: GatewayProtocol;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  /** The id the gateway serves, see `gatewayModelId`. */
  model: string;
  /** Non-HTTP executor when a CLI profile serves auxiliary jobs directly without a standalone gateway key. */
  executeComplete?: (request: CompletionRequest) => Promise<string>;
  executeStreamChat?: (request: ChatStreamRequest) => Promise<ChatStreamResult>;
}

export interface CompletionMetrics {
  ok: boolean;
  ttftMs: number | null;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  reasoningChars: number;
  thinkingDetected: boolean;
  streaming: boolean;
  outputTokensPerSecond: number | null;
  errorCode?: string;
}

export interface CompletionRequest extends GatewayEndpoint {
  system: string;
  content: string;
  maxOutputTokens: number;
  timeoutMs: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  onMetrics?: (metrics: CompletionMetrics) => void;
}

export interface StreamCompletionRequest extends CompletionRequest {
  onDelta: (text: string) => void;
}

export class GatewayHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'GatewayHttpError';
  }
}

type FastThinkingMode = 'default' | 'thinking-only' | 'effort-none' | 'effort-minimal' | 'effort-low' | 'omit';

const FAST_MODES: Record<GatewayProtocol, readonly FastThinkingMode[]> = {
  anthropic: ['default', 'omit'],
  chat: ['default', 'thinking-only', 'effort-none', 'effort-minimal', 'effort-low', 'omit'],
  responses: ['effort-none', 'effort-minimal', 'effort-low', 'omit'],
};
const MAX_FAST_MODE_CACHE = 128;
// perf-rules: allow bounded by MAX_FAST_MODE_CACHE, FIFO eviction in rememberFastMode
const fastModeCache = new Map<string, FastThinkingMode>();

function fastModeKey(protocol: GatewayProtocol, baseUrl: string, model: string): string {
  return `${protocol}\0${baseUrl}\0${model}`;
}

function rememberFastMode(key: string, mode: FastThinkingMode): void {
  fastModeCache.delete(key);
  fastModeCache.set(key, mode);
  while (fastModeCache.size > MAX_FAST_MODE_CACHE) {
    const oldest = fastModeCache.keys().next().value;
    if (oldest === undefined) break;
    fastModeCache.delete(oldest);
  }
}

function isUnsupportedThinkingError(status: number, reason: string | undefined): boolean {
  if (status !== 400 || !reason) return false;
  return /\b(thinking|reasoning(?:_effort)?|effort)\b|unknown parameter|unrecognized request argument|unsupported (?:value|parameter)/i.test(reason);
}

function buildFastRequest(
  request: Pick<CompletionRequest, 'protocol' | 'baseUrl' | 'apiKey' | 'headers' | 'model' | 'system' | 'content' | 'maxOutputTokens'>,
  mode: FastThinkingMode,
  stream: boolean,
): { url: URL; headers: Record<string, string>; body: Record<string, unknown> } {
  const { protocol, baseUrl, apiKey, model, system, content, maxOutputTokens } = request;
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(stream ? { accept: 'text/event-stream' } : {}) };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  Object.assign(headers, request.headers);
  let url: URL, body: Record<string, unknown>;
  if (protocol === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01';
    url = endpoint(baseUrl, 'messages');
    body = {
      model, max_tokens: maxOutputTokens, system,
      ...(mode !== 'omit' ? { thinking: { type: 'disabled' } } : {}),
      messages: [{ role: 'user', content }],
      ...(stream ? { stream: true } : {}),
    };
  } else if (protocol === 'chat') {
    url = endpoint(baseUrl, 'chat/completions');
    const includeThinking = mode === 'default' || mode === 'thinking-only';
    const effort = mode === 'default' || mode === 'effort-none' ? 'none'
      : mode === 'effort-minimal' ? 'minimal'
      : mode === 'effort-low' ? 'low' : undefined;
    body = {
      model, max_tokens: maxOutputTokens,
      ...(includeThinking ? { thinking: { type: 'disabled' } } : {}),
      ...(effort ? { reasoning_effort: effort } : {}),
      messages: [{ role: 'system', content: system }, { role: 'user', content }],
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    };
  } else {
    url = endpoint(baseUrl, 'responses');
    const effort = mode === 'effort-none' ? 'none'
      : mode === 'effort-minimal' ? 'minimal'
      : mode === 'effort-low' ? 'low' : undefined;
    body = {
      model, max_output_tokens: maxOutputTokens, instructions: system, input: content,
      ...(effort ? { reasoning: { effort } } : {}),
      ...(stream ? { stream: true } : {}),
    };
  }
  return { url, headers, body };
}

function extractCompletionUsage(protocol: GatewayProtocol, body: unknown): {
  inputTokens?: number; outputTokens?: number; reasoningTokens?: number; reasoningChars: number;
} {
  const value = record(body);
  const usage = record(value?.usage);
  if (protocol === 'anthropic') {
    const blocks = Array.isArray(value?.content) ? value.content as Array<Record<string, unknown>> : [];
    const reasoningChars = blocks
      .filter(block => block.type === 'thinking' && typeof block.thinking === 'string')
      .reduce((sum, block) => sum + String(block.thinking).length, 0);
    return {
      ...(count(usage?.input_tokens) !== undefined ? { inputTokens: count(usage?.input_tokens)! } : {}),
      ...(count(usage?.output_tokens) !== undefined ? { outputTokens: count(usage?.output_tokens)! } : {}),
      reasoningChars,
    };
  }
  if (protocol === 'chat') {
    const message = record((Array.isArray(value?.choices) ? value.choices[0] : undefined))?.message;
    const msg = record(message);
    const reasoning = typeof msg?.reasoning_content === 'string' ? msg.reasoning_content : typeof msg?.reasoning === 'string' ? msg.reasoning : '';
    const details = record(usage?.completion_tokens_details);
    const reasoningTokens = count(details?.reasoning_tokens);
    return {
      ...(count(usage?.prompt_tokens) !== undefined ? { inputTokens: count(usage?.prompt_tokens)! } : {}),
      ...(count(usage?.completion_tokens) !== undefined ? { outputTokens: count(usage?.completion_tokens)! } : {}),
      ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
      reasoningChars: reasoning.length,
    };
  }
  const output = Array.isArray(value?.output) ? value.output as Array<Record<string, unknown>> : [];
  let reasoningChars = 0;
  for (const item of output) {
    if (item?.type !== 'reasoning') continue;
    const summary = Array.isArray(item.summary) ? item.summary : [];
    for (const part of summary) {
      const text = record(part)?.text;
      if (typeof text === 'string') reasoningChars += text.length;
    }
  }
  const details = record(usage?.output_tokens_details);
  const reasoningTokens = count(details?.reasoning_tokens);
  return {
    ...(count(usage?.input_tokens) !== undefined ? { inputTokens: count(usage?.input_tokens)! } : {}),
    ...(count(usage?.output_tokens) !== undefined ? { outputTokens: count(usage?.output_tokens)! } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    reasoningChars,
  };
}

function decodeSpeed(outputTokens: number | undefined, text: string, firstTextAt: number | undefined, endedAt: number): number | null {
  if (firstTextAt === undefined) return null;
  const genMs = endedAt - firstTextAt;
  if (genMs < 300) return null;
  const tokens = outputTokens ?? Math.round(text.length / 4);
  if (tokens < 8) return null;
  const speed = tokens / (genMs / 1000);
  return speed > 0 && speed <= 1_000 ? speed : null;
}

function errorCodeOf(error: unknown): string {
  if (error instanceof GatewayHttpError) return `HTTP_${error.status}`;
  if (error instanceof Error && error.name === 'TimeoutError') return 'TIMEOUT';
  return 'ERROR';
}

/**
 * One single-turn completion: a system prompt, one user message, the text back. Thinking is
 * switched off or minimized where the protocol allows, since these are bounded writing jobs and a
 * reasoning model left to think can spend the whole budget before answering. Throws with the gateway's reason.
 */
export async function complete(request: CompletionRequest): Promise<string> {
  const startedAt = Date.now();
  if (request.executeComplete) {
    try {
      const text = await request.executeComplete(request);
      request.onMetrics?.({
        ok: true, ttftMs: null, durationMs: Math.max(0, Date.now() - startedAt),
        reasoningChars: 0, thinkingDetected: false, streaming: false, outputTokensPerSecond: null,
      });
      return text;
    } catch (error) {
      request.onMetrics?.({
        ok: false, ttftMs: null, durationMs: Math.max(0, Date.now() - startedAt),
        reasoningChars: 0, thinkingDetected: false, streaming: false, outputTokensPerSecond: null,
        errorCode: errorCodeOf(error),
      });
      throw error;
    }
  }
  const modes = FAST_MODES[request.protocol];
  const key = fastModeKey(request.protocol, request.baseUrl, request.model);
  const start = fastModeCache.get(key);
  const startIndex = start ? Math.max(0, modes.indexOf(start)) : 0;
  const timeout = AbortSignal.timeout(request.timeoutMs);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;

  try {
    for (let index = startIndex; index < modes.length; index += 1) {
      const mode = modes[index]!;
      const { url, headers, body } = buildFastRequest(request, mode, false);
      const response = await modelRequest(url, { method: 'POST', headers, body: JSON.stringify(body), signal }, request.fetchImpl);
      if (!response.ok) {
        const reason = errorOf(await response.text().catch(() => ''));
        if (index + 1 < modes.length && isUnsupportedThinkingError(response.status, reason)) continue;
        throw new GatewayHttpError(response.status, `model returned HTTP ${response.status}${reason ? `: ${reason}` : ''}`);
      }
      if (mode !== modes[0] || start !== undefined) rememberFastMode(key, mode);
      const answer = await response.json() as unknown;
      const usage = extractCompletionUsage(request.protocol, answer);
      const thinkingDetected = (usage.reasoningTokens ?? 0) > 0 || usage.reasoningChars > 0;
      const durationMs = Math.max(0, Date.now() - startedAt);
      if (cutOff(request.protocol, answer)) {
        request.onMetrics?.({
          ok: false, ttftMs: null, durationMs, ...usage, thinkingDetected, streaming: false, outputTokensPerSecond: null, errorCode: 'CUT_OFF',
        });
        throw new Error('model output was cut off at the token limit');
      }
      request.onMetrics?.({
        ok: true, ttftMs: null, durationMs, ...usage, thinkingDetected, streaming: false, outputTokensPerSecond: null,
      });
      return textOf(request.protocol, answer) ?? '';
    }
    throw new Error('model request failed');
  } catch (error) {
    if (!(error instanceof Error && error.message === 'model output was cut off at the token limit')) {
      request.onMetrics?.({
        ok: false, ttftMs: null, durationMs: Math.max(0, Date.now() - startedAt),
        reasoningChars: 0, thinkingDetected: false, streaming: false, outputTokensPerSecond: null,
        errorCode: errorCodeOf(error),
      });
    }
    throw error;
  }
}

/**
 * Streaming single-turn completion with thinking disabled/minimized. Calls `onDelta` only for answer
 * text (reasoning tokens are ignored) and rejects if cut off at `maxOutputTokens`.
 */
export async function streamComplete(request: StreamCompletionRequest): Promise<string> {
  const startedAt = Date.now();
  let firstTextAt: number | undefined;
  if (request.executeStreamChat) {
    try {
      const result = await request.executeStreamChat({
        ...request,
        messages: [{ role: 'user', content: request.content }],
        idleTimeoutMs: request.timeoutMs,
        effort: 'low',
        onDelta: (kind, text) => {
          if (kind === 'text') {
            if (firstTextAt === undefined && text) firstTextAt = Date.now();
            request.onDelta(text);
          }
        },
      });
      const endedAt = Date.now();
      const thinkingDetected = (result.reasoningTokens ?? 0) > 0 || result.reasoning.length > 0;
      const ttftMs = firstTextAt !== undefined ? Math.max(0, firstTextAt - startedAt) : null;
      const durationMs = Math.max(0, endedAt - startedAt);
      const outputTokensPerSecond = decodeSpeed(result.outputTokens, result.text, firstTextAt, endedAt);
      if (result.cutOff) {
        request.onMetrics?.({
          ok: false, ttftMs, durationMs,
          ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
          ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
          ...(result.reasoningTokens !== undefined ? { reasoningTokens: result.reasoningTokens } : {}),
          reasoningChars: result.reasoning.length, thinkingDetected, streaming: true, outputTokensPerSecond, errorCode: 'CUT_OFF',
        });
        throw new Error('model output was cut off at the token limit');
      }
      request.onMetrics?.({
        ok: true, ttftMs, durationMs,
        ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
        ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
        ...(result.reasoningTokens !== undefined ? { reasoningTokens: result.reasoningTokens } : {}),
        reasoningChars: result.reasoning.length, thinkingDetected, streaming: true, outputTokensPerSecond,
      });
      return result.text;
    } catch (error) {
      if (!(error instanceof Error && error.message === 'model output was cut off at the token limit')) {
        request.onMetrics?.({
          ok: false, ttftMs: firstTextAt !== undefined ? Math.max(0, firstTextAt - startedAt) : null,
          durationMs: Math.max(0, Date.now() - startedAt),
          reasoningChars: 0, thinkingDetected: false, streaming: true, outputTokensPerSecond: null, errorCode: errorCodeOf(error),
        });
      }
      throw error;
    }
  }
  if (request.executeComplete) {
    try {
      const text = await request.executeComplete(request);
      if (text) { firstTextAt = Date.now(); request.onDelta(text); }
      request.onMetrics?.({
        ok: true, ttftMs: firstTextAt !== undefined ? Math.max(0, firstTextAt - startedAt) : null,
        durationMs: Math.max(0, Date.now() - startedAt),
        reasoningChars: 0, thinkingDetected: false, streaming: false, outputTokensPerSecond: null,
      });
      return text;
    } catch (error) {
      request.onMetrics?.({
        ok: false, ttftMs: null, durationMs: Math.max(0, Date.now() - startedAt),
        reasoningChars: 0, thinkingDetected: false, streaming: false, outputTokensPerSecond: null, errorCode: errorCodeOf(error),
      });
      throw error;
    }
  }
  const modes = FAST_MODES[request.protocol];
  const key = fastModeKey(request.protocol, request.baseUrl, request.model);
  const start = fastModeCache.get(key);
  const startIndex = start ? Math.max(0, modes.indexOf(start)) : 0;
  const timeout = AbortSignal.timeout(request.timeoutMs);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;

  try {
    for (let index = startIndex; index < modes.length; index += 1) {
      const mode = modes[index]!;
      const { url, headers, body } = buildFastRequest(request, mode, true);
      const response = await modelRequest(url, { method: 'POST', headers, body: JSON.stringify(body), signal }, request.fetchImpl);
      if (!response.ok) {
        const reason = errorOf(await response.text().catch(() => ''));
        if (index + 1 < modes.length && isUnsupportedThinkingError(response.status, reason)) continue;
        throw new GatewayHttpError(response.status, `model returned HTTP ${response.status}${reason ? `: ${reason}` : ''}`);
      }
      if (mode !== modes[0] || start !== undefined) rememberFastMode(key, mode);
      if (!response.body) throw new Error('model returned no stream');
      const result: ChatStreamResult = { text: '', reasoning: '', cutOff: false };
      const delta: Delta = (kind, text) => {
        if (typeof text !== 'string' || !text) return;
        if (kind === 'text') {
          if (firstTextAt === undefined) firstTextAt = Date.now();
          result.text += text;
          request.onDelta(text);
        } else {
          result.reasoning += text;
        }
      };
      let finished = false;
      try {
        for await (const { event, data } of serverSentEvents(response.body, () => undefined)) {
          if (data === '[DONE]') { finished = true; break; }
          let value: Record<string, unknown>;
          try { value = JSON.parse(data) as Record<string, unknown>; } catch { continue; }
          const type = typeof value.type === 'string' ? value.type : event;
          if (type === 'error' || value.error) throw new Error(errorOf(data) ?? 'model stream failed');
          if (request.protocol === 'anthropic') readAnthropic(type, value, result, delta);
          else if (request.protocol === 'chat') readChat(value, result, delta);
          else readResponses(type, value, result, delta);
          if (request.protocol === 'anthropic' && type === 'message_stop'
            || request.protocol === 'responses' && (type === 'response.completed' || type === 'response.incomplete')) {
            finished = true;
            break;
          }
          if (request.protocol === 'chat') {
            const choice = record(Array.isArray(value.choices) ? value.choices[0] : undefined);
            if (typeof choice?.finish_reason === 'string') finished = true;
          }
        }
      } catch (error) {
        if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('model request was stopped');
        throw error;
      }
      const endedAt = Date.now();
      const ttftMs = firstTextAt !== undefined ? Math.max(0, firstTextAt - startedAt) : null;
      const durationMs = Math.max(0, endedAt - startedAt);
      const thinkingDetected = (result.reasoningTokens ?? 0) > 0 || result.reasoning.length > 0;
      const outputTokensPerSecond = decodeSpeed(result.outputTokens, result.text, firstTextAt, endedAt);
      if (!finished) throw new Error('model stream ended before the answer completed');
      if (result.cutOff) {
        request.onMetrics?.({
          ok: false, ttftMs, durationMs,
          ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
          ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
          ...(result.reasoningTokens !== undefined ? { reasoningTokens: result.reasoningTokens } : {}),
          reasoningChars: result.reasoning.length, thinkingDetected, streaming: true, outputTokensPerSecond, errorCode: 'CUT_OFF',
        });
        throw new Error('model output was cut off at the token limit');
      }
      request.onMetrics?.({
        ok: true, ttftMs, durationMs,
        ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
        ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
        ...(result.reasoningTokens !== undefined ? { reasoningTokens: result.reasoningTokens } : {}),
        reasoningChars: result.reasoning.length, thinkingDetected, streaming: true, outputTokensPerSecond,
      });
      return result.text;
    }
    throw new Error('model request failed');
  } catch (error) {
    if (!(error instanceof Error && error.message === 'model output was cut off at the token limit')) {
      request.onMetrics?.({
        ok: false, ttftMs: firstTextAt !== undefined ? Math.max(0, firstTextAt - startedAt) : null,
        durationMs: Math.max(0, Date.now() - startedAt),
        reasoningChars: 0, thinkingDetected: false, streaming: true, outputTokensPerSecond: null, errorCode: errorCodeOf(error),
      });
    }
    throw error;
  }
}

/** One piece of a user's turn beyond its text: a picture, or a document the gateway reads itself. */
export type ChatPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string }
  | { type: 'pdf'; name: string; data: string };
export interface ChatMessage { role: 'user' | 'assistant'; content: string; parts?: ChatPart[] }

/** Which non-text parts a protocol accepts: every gateway takes images, only Anthropic and Responses take a PDF. */
export function acceptsPart(protocol: GatewayProtocol, type: ChatPart['type']): boolean {
  return type !== 'pdf' || protocol !== 'chat';
}

/** A message in the protocol's own shape; one without parts stays a plain string. */
function wireMessage(protocol: GatewayProtocol, message: ChatMessage): Record<string, unknown> {
  if (!message.parts?.length) return { role: message.role, content: message.content };
  const parts = [...message.parts, ...(message.content ? [{ type: 'text', text: message.content } as const] : [])];
  if (protocol === 'anthropic') {
    return { role: message.role, content: parts.map(part => part.type === 'text' ? { type: 'text', text: part.text }
      : part.type === 'image' ? { type: 'image', source: { type: 'base64', media_type: part.mimeType, data: part.data } }
      : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: part.data }, title: part.name }) };
  }
  if (protocol === 'chat') {
    return { role: message.role, content: parts.flatMap((part): Array<Record<string, unknown>> => part.type === 'text' ? [{ type: 'text', text: part.text }]
      : part.type === 'image' ? [{ type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.data}` } }] : []) };
  }
  return { role: message.role, content: parts.map(part => part.type === 'text' ? { type: 'input_text', text: part.text }
    : part.type === 'image' ? { type: 'input_image', image_url: `data:${part.mimeType};base64,${part.data}` }
    : { type: 'input_file', filename: part.name, file_data: `data:application/pdf;base64,${part.data}` }) };
}

export interface WirePreparedSnapshot {
  protocol: GatewayProtocol;
  endpoint: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  truncated?: boolean;
}

export interface ChatStreamRequest extends GatewayEndpoint {
  system?: string;
  /** Oldest first, alternating, ending with the user's turn. */
  messages: ChatMessage[];
  maxOutputTokens: number;
  /** The stream fails when the gateway sends nothing for this long. */
  idleTimeoutMs: number;
  signal?: AbortSignal;
  /** Let the gateway search the web itself (Anthropic's `web_search` tool, Responses' `web_search`); other protocols ignore it. */
  search?: boolean;
  /** How hard the model thinks before answering; absent leaves the model's own default. */
  effort?: ChatEffort;
  /** Optional explicit Anthropic thinking token budget when using fixed effort. */
  thinkingBudget?: number;
  /** Native side chats inherit named effort; older quick chats retain budget-based thinking. */
  adaptiveThinking?: boolean;
  /** Sampling temperature (omitted when protocol locks sampling under thinking/reasoning). */
  temperature?: number;
  /** Nucleus sampling (omitted when protocol locks sampling under thinking/reasoning). */
  topP?: number;
  /** Deterministic seed where supported. */
  seed?: number | null;
  /** Stop sequences where supported. */
  stop?: string[];
  /** Plain text, JSON object, or strict JSON Schema output format. */
  responseFormat?: ModelChatResponseFormat;
  /** Explicit prompt caching breakpoints (e.g. Anthropic ephemeral cache_control). */
  promptCaching?: boolean;
  /** OpenAI's priority tier; only the Responses protocol has one. */
  fast?: boolean;
  /** Called right before the HTTP request is sent with a strictly redacted Wire snapshot. */
  onWirePrepared?: (wire: WirePreparedSnapshot) => void;
  /** Called for every piece of answer text or reasoning, as it arrives. */
  onDelta(kind: 'text' | 'reasoning', text: string): void;
  fetchImpl?: typeof fetch;
}

export type ChatEffort = 'default' | 'off' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'adaptive';
export function gatewayEfforts(protocol: GatewayProtocol): readonly ChatEffort[] {
  return protocol === 'anthropic' ? ['low', 'medium', 'high', 'xhigh', 'max']
    : protocol === 'responses' ? ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] : ['low', 'medium', 'high'];
}
/** Anthropic thinks in a token budget rather than a named effort. */
const THINKING_BUDGETS: Partial<Record<ChatEffort, number>> = { minimal: 1_024, low: 2_048, medium: 8_192, high: 16_384 };

export interface ChatStreamResult {
  text: string;
  reasoning: string;
  /** The output budget ended the answer. */
  cutOff: boolean;
  /** The model that served the request, when the gateway says. */
  model?: string;
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  stopReason?: string;
}

const SENSITIVE_HEADER_RE = /auth|key|token|cookie|secret|pass|cred|sig|bearer|jwt|session/i;
const BINARY_VALUE_KEYS = new Set(['data', 'file_data', 'image_url']);
const BINARY_STRING_LIMIT = 1_024;
/** Allowance reserved inside Wire snapshots for envelope metadata (`assistantId`, `at`, `metrics`) added at persistence. */
const WIRE_ENVELOPE_RESERVE_BYTES = 1_024;

/** Strips credentials, tokens, keys, and URL secrets from header values or persisted error text. */
export function redactSensitiveText(text: string): string {
  return text
    .replace(/(https?:\/\/)([^:@\s/]+):([^@\s/]+)@/gi, '$1[REDACTED]@')
    .replace(/([?&](?:api[-_]?key|access[-_]?token|auth[-_]?token|token|key|secret|password|passwd|sig|signature|jwt)=)[^&\s#'"]+/gi, '$1[REDACTED]')
    .replace(/\b(Bearer)\s+[^\s,;'"`]+/gi, '$1 [REDACTED]')
    .replace(/\b(Basic)\s+[A-Za-z0-9+/=]{8,}/gi, '$1 [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{4,}/gi, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g, '[REDACTED]');
}

function redactWireHeaders(headers: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    redacted[key] = SENSITIVE_HEADER_RE.test(key) ? '[REDACTED]' : redactSensitiveText(value);
  }
  return redacted;
}

function sanitizeWireValue(value: unknown, key?: string, stringCap?: number): { value: unknown; truncated: boolean } {
  if (typeof value === 'string') {
    if (value.length > BINARY_STRING_LIMIT && ((key && BINARY_VALUE_KEYS.has(key)) || (key === 'url' && value.startsWith('data:')))) {
      return { value: '[binary data omitted]', truncated: false };
    }
    if (stringCap !== undefined && value.length > stringCap) {
      return { value: `${value.slice(0, stringCap)}… [truncated]`, truncated: true };
    }
    return { value, truncated: false };
  }
  if (Array.isArray(value)) {
    let truncated = false;
    const out = value.map(item => {
      const next = sanitizeWireValue(item, undefined, stringCap);
      if (next.truncated) truncated = true;
      return next.value;
    });
    return { value: out, truncated };
  }
  if (value && typeof value === 'object') {
    let truncated = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const next = sanitizeWireValue(v, k, stringCap);
      if (next.truncated) truncated = true;
      out[k] = next.value;
    }
    return { value: out, truncated };
  }
  return { value, truncated: false };
}

function prepareWireSnapshot(protocol: GatewayProtocol, url: URL, headers: Record<string, string>, body: Record<string, unknown>): WirePreparedSnapshot {
  const cleanEndpoint = `${url.origin}${url.pathname}`;
  const redactedHeaders = redactWireHeaders(headers);
  const maxBytes = Math.max(512, MODEL_CHAT_BUDGET.maxWireBytes - WIRE_ENVELOPE_RESERVE_BYTES);
  const build = (nextBody: Record<string, unknown>, isTruncated: boolean): WirePreparedSnapshot => ({
    protocol,
    endpoint: cleanEndpoint,
    headers: redactedHeaders,
    body: nextBody,
    ...(isTruncated ? { truncated: true } : {}),
  });
  const byteSize = (wire: WirePreparedSnapshot) => Buffer.byteLength(JSON.stringify(wire), 'utf8');

  const initial = sanitizeWireValue(body);
  let sanitized = initial.value as Record<string, unknown>;
  let truncated = false;
  for (const cap of [8_192, 2_048, 512, 128, 32]) {
    if (byteSize(build(sanitized, truncated)) <= maxBytes) break;
    const shrunk = sanitizeWireValue(sanitized, undefined, cap);
    sanitized = shrunk.value as Record<string, unknown>;
    truncated = true;
  }
  if (byteSize(build(sanitized, true)) > maxBytes) {
    truncated = true;
    const serialized = JSON.stringify(sanitized);
    const baseBody: Record<string, unknown> = {
      ...(typeof body.model === 'string' ? { model: body.model } : {}),
      truncated: true,
    };
    let lo = 0;
    let hi = serialized.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (byteSize(build({ ...baseBody, preview: serialized.slice(0, mid) }, true)) <= maxBytes) lo = mid;
      else hi = mid - 1;
    }
    if (lo > 0 && lo < serialized.length) {
      const code = serialized.charCodeAt(lo - 1);
      if (code >= 0xd800 && code <= 0xdbff) lo -= 1;
    }
    sanitized = { ...baseBody, preview: serialized.slice(0, lo) };
    if (byteSize(build(sanitized, true)) > maxBytes) {
      return {
        protocol,
        endpoint: cleanEndpoint.slice(0, 1_024),
        headers: {},
        body: { truncated: true },
        truncated: true,
      };
    }
  }
  return build(sanitized, truncated);
}

function setStopReason(result: ChatStreamResult, reason: string): void {
  Object.defineProperty(result, 'stopReason', {
    value: reason,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

/**
 * One streamed, multi-turn completion: the conversation so far, the answer back as it is written.
 * Unlike {@link complete}, thinking is left to the model, since a reader waits on each answer. Throws
 * with the gateway's reason; an abort throws the signal's reason.
 */
export async function streamChat(request: ChatStreamRequest): Promise<ChatStreamResult> {
  if (request.executeStreamChat) return await request.executeStreamChat(request);
  const { protocol, baseUrl, apiKey, model, system, messages, maxOutputTokens } = request;
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'text/event-stream' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  Object.assign(headers, request.headers);
  let url: URL, body: Record<string, unknown>;
  const requestedEffort = request.effort === 'default' ? undefined : request.effort;
  if (protocol === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01';
    url = endpoint(baseUrl, 'messages');
    let thinking: Record<string, unknown> | undefined;
    let outputConfig: Record<string, unknown> | undefined;
    let budget: number | undefined;
    let thinkingEnabled = false;
    if (requestedEffort === 'off') {
      thinking = { type: 'disabled' };
    } else if (requestedEffort === 'adaptive') {
      thinking = { type: 'adaptive' };
      thinkingEnabled = true;
    } else if (requestedEffort && (request.adaptiveThinking || requestedEffort === 'xhigh' || requestedEffort === 'max')) {
      thinking = { type: 'adaptive' };
      if (requestedEffort !== 'none') outputConfig = { effort: requestedEffort };
      thinkingEnabled = true;
    } else if (requestedEffort && requestedEffort !== 'none') {
      // The thinking budget is spent out of `max_tokens`, so it is added on top of the answer's own.
      const customBudget = typeof request.thinkingBudget === 'number' && Number.isFinite(request.thinkingBudget) && request.thinkingBudget >= 1_024
        ? Math.floor(request.thinkingBudget)
        : undefined;
      budget = customBudget ?? THINKING_BUDGETS[requestedEffort];
      if (budget && budget >= 1_024) {
        thinking = { type: 'enabled', budget_tokens: budget };
        thinkingEnabled = true;
      }
    }
    const wireMessages = messages.map(message => wireMessage(protocol, message));
    if (request.promptCaching === true && wireMessages.length >= 3) {
      const target = wireMessages[wireMessages.length - 3]!;
      if (typeof target.content === 'string') {
        target.content = [{ type: 'text', text: target.content, cache_control: { type: 'ephemeral' } }];
      } else if (Array.isArray(target.content) && target.content.length > 0) {
        const blocks = [...target.content];
        const last = blocks[blocks.length - 1];
        if (last && typeof last === 'object') {
          blocks[blocks.length - 1] = { ...(last as Record<string, unknown>), cache_control: { type: 'ephemeral' } };
          target.content = blocks;
        }
      }
    }
    const systemValue = system
      ? (request.promptCaching === true ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : system)
      : undefined;
    body = {
      model,
      max_tokens: maxOutputTokens + (budget ?? 0),
      ...(systemValue !== undefined ? { system: systemValue } : {}),
      messages: wireMessages,
      stream: true,
      ...(thinking ? { thinking } : {}),
      ...(outputConfig ? { output_config: outputConfig } : {}),
      ...(!thinkingEnabled && typeof request.temperature === 'number' ? { temperature: request.temperature } : {}),
      ...(!thinkingEnabled && typeof request.topP === 'number' ? { top_p: request.topP } : {}),
      ...(request.stop?.length ? { stop_sequences: request.stop } : {}),
      ...(request.search ? { tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }] } : {}),
    };
  } else if (protocol === 'chat') {
    url = endpoint(baseUrl, 'chat/completions');
    const responseFormat = request.responseFormat?.type === 'json_object'
      ? { type: 'json_object' }
      : request.responseFormat?.type === 'json_schema'
        ? { type: 'json_schema', json_schema: { name: request.responseFormat.name, schema: request.responseFormat.schema, strict: request.responseFormat.strict ?? true } }
        : undefined;
    body = {
      model,
      max_tokens: maxOutputTokens,
      messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages.map(message => wireMessage(protocol, message))],
      stream: true,
      stream_options: { include_usage: true },
      ...(requestedEffort === 'off' ? { thinking: { type: 'disabled' } }
        : requestedEffort === 'adaptive' ? { reasoning_effort: 'high' }
        : requestedEffort ? { reasoning_effort: requestedEffort } : {}),
      ...(typeof request.temperature === 'number' ? { temperature: request.temperature } : {}),
      ...(typeof request.topP === 'number' ? { top_p: request.topP } : {}),
      ...(typeof request.seed === 'number' ? { seed: request.seed } : {}),
      ...(request.stop?.length ? { stop: request.stop } : {}),
      ...(responseFormat ? { response_format: responseFormat } : {}),
    };
  } else {
    url = endpoint(baseUrl, 'responses');
    const effort = requestedEffort === 'off' ? 'none'
      : requestedEffort === 'adaptive' ? 'high'
      : requestedEffort;
    const reasoningActive = Boolean(effort && effort !== 'none');
    const textFormat = request.responseFormat?.type === 'json_object'
      ? { format: { type: 'json_object' } }
      : request.responseFormat?.type === 'json_schema'
        ? { format: { type: 'json_schema', name: request.responseFormat.name, schema: request.responseFormat.schema, strict: request.responseFormat.strict ?? true } }
        : undefined;
    body = {
      model,
      max_output_tokens: maxOutputTokens,
      ...(system ? { instructions: system } : {}),
      input: messages.map(message => wireMessage(protocol, message)),
      stream: true,
      ...(effort ? { reasoning: { effort } } : {}),
      ...(!reasoningActive && typeof request.temperature === 'number' ? { temperature: request.temperature } : {}),
      ...(!reasoningActive && typeof request.topP === 'number' ? { top_p: request.topP } : {}),
      ...(textFormat ? { text: textFormat } : {}),
      ...(request.fast ? { service_tier: 'priority' } : {}),
      ...(request.search ? { tools: [{ type: 'web_search' }] } : {}),
    };
  }
  request.onWirePrepared?.(prepareWireSnapshot(protocol, url, headers, body));
  const idle = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => idle.abort(new Error(`model sent nothing for ${Math.round(request.idleTimeoutMs / 1000)} s`)), request.idleTimeoutMs);
    timer.unref?.();
  };
  const signal = request.signal ? AbortSignal.any([request.signal, idle.signal]) : idle.signal;
  touch();
  try {
    const response = await modelRequest(url, { method: 'POST', headers, body: JSON.stringify(body), signal }, request.fetchImpl);
    const result: ChatStreamResult = { text: '', reasoning: '', cutOff: false };
    const delta = (kind: 'text' | 'reasoning', text: unknown) => {
      if (typeof text !== 'string' || !text) return;
      if (kind === 'text') result.text += text; else result.reasoning += text;
      request.onDelta(kind, text);
    };
    if (!response.ok) {
      const reason = errorOf(await response.text().catch(() => ''));
      // Some gateways run their search tool only on a whole reply (DeepSeek's Anthropic endpoint
      // says so in a 400). The answer then arrives at once instead of being written as it goes.
      if (response.status === 400 && request.search && protocol !== 'chat' && reason && /stream/i.test(reason)) {
        // Nothing arrives until the whole answer, searches included, is written; the idle limit is
        // for a silent stream, so only the reader's stop ends this wait.
        clearTimeout(timer);
        return await wholeAnswer(request, url, headers, { ...body, stream: false }, request.signal ?? new AbortController().signal, result, delta);
      }
      throw new Error(`model returned HTTP ${response.status}${reason ? `: ${reason}` : ''}`);
    }
    if (!response.body) throw new Error('model returned no stream');
    let finished = false;
    for await (const { event, data } of serverSentEvents(response.body, touch)) {
      if (data === '[DONE]') { finished = true; break; }
      let value: Record<string, unknown>;
      try { value = JSON.parse(data) as Record<string, unknown>; } catch { continue; }
      const type = typeof value.type === 'string' ? value.type : event;
      if (type === 'error' || value.error) throw new Error(errorOf(data) ?? 'model stream failed');
      if (protocol === 'anthropic') readAnthropic(type, value, result, delta);
      else if (protocol === 'chat') readChat(value, result, delta);
      else readResponses(type, value, result, delta);
      if (protocol === 'anthropic' && type === 'message_stop'
        || protocol === 'responses' && (type === 'response.completed' || type === 'response.incomplete')) {
        finished = true;
        break;
      }
      if (protocol === 'chat') {
        const choice = record(Array.isArray(value.choices) ? value.choices[0] : undefined);
        if (typeof choice?.finish_reason === 'string') finished = true;
      }
    }
    if (!finished) throw new Error('model stream ended before the answer completed');
    return result;
  } catch (error) {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('model request was stopped');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

type Delta = (kind: 'text' | 'reasoning', text: unknown) => void;

/** The non-streaming form of a chat request, read into the same result a stream fills. */
async function wholeAnswer(request: ChatStreamRequest, url: URL, headers: Record<string, string>, body: Record<string, unknown>, signal: AbortSignal, result: ChatStreamResult, delta: Delta): Promise<ChatStreamResult> {
  const response = await modelRequest(url, { method: 'POST', headers: { ...headers, accept: 'application/json' }, body: JSON.stringify(body), signal }, request.fetchImpl);
  if (!response.ok) {
    const reason = errorOf(await response.text().catch(() => ''));
    throw new Error(`model returned HTTP ${response.status}${reason ? `: ${reason}` : ''}`);
  }
  const answer = record(await response.json() as unknown);
  if (typeof answer?.model === 'string') result.model = answer.model;
  const usage = record(answer?.usage);
  result.inputTokens = count(usage?.input_tokens);
  result.outputTokens = count(usage?.output_tokens);
  const cacheRead = count(usage?.cache_read_input_tokens) ?? count(record(usage?.input_tokens_details)?.cached_tokens);
  if (cacheRead !== undefined) result.cacheReadTokens = cacheRead;
  const cacheWrite = count(usage?.cache_creation_input_tokens);
  if (cacheWrite !== undefined) result.cacheWriteTokens = cacheWrite;
  if (request.protocol === 'anthropic') {
    if (typeof answer?.stop_reason === 'string' && answer.stop_reason) setStopReason(result, answer.stop_reason);
    for (const block of Array.isArray(answer?.content) ? answer.content : []) {
      const part = record(block);
      if (part?.type === 'thinking') delta('reasoning', part.thinking);
      else if (part?.type === 'text') {
        // An answer that searched is several text blocks, between the tool's own blocks.
        if (result.text && !result.text.endsWith('\n')) delta('text', '\n\n');
        delta('text', part.text);
      }
    }
  } else {
    if (typeof answer?.status === 'string' && answer.status) setStopReason(result, answer.status);
    for (const item of Array.isArray(answer?.output) ? answer.output : []) {
      const entry = record(item);
      if (entry?.type === 'reasoning') for (const part of Array.isArray(entry.summary) ? entry.summary : []) delta('reasoning', record(part)?.text);
      if (entry?.type === 'message') for (const part of Array.isArray(entry.content) ? entry.content : []) delta('text', record(part)?.text);
    }
  }
  result.cutOff = cutOff(request.protocol, answer);
  return result;
}
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;

function readAnthropic(type: string | undefined, value: Record<string, unknown>, result: ChatStreamResult, delta: Delta): void {
  if (type === 'message_start') {
    const message = record(value.message);
    if (typeof message?.model === 'string') result.model = message.model;
    const usage = record(message?.usage);
    result.inputTokens = count(usage?.input_tokens) ?? result.inputTokens;
    const cacheRead = count(usage?.cache_read_input_tokens);
    if (cacheRead !== undefined) result.cacheReadTokens = cacheRead;
    const cacheWrite = count(usage?.cache_creation_input_tokens);
    if (cacheWrite !== undefined) result.cacheWriteTokens = cacheWrite;
  } else if (type === 'content_block_start') {
    // An answer that searched arrives as several text blocks, between the tool's own blocks.
    if (record(value.content_block)?.type === 'text' && result.text && !result.text.endsWith('\n')) delta('text', '\n\n');
  } else if (type === 'content_block_delta') {
    const part = record(value.delta);
    if (part?.type === 'text_delta') delta('text', part.text);
    else if (part?.type === 'thinking_delta') delta('reasoning', part.thinking);
  } else if (type === 'message_delta') {
    const stopReason = record(value.delta)?.stop_reason;
    if (stopReason === 'max_tokens') result.cutOff = true;
    if (typeof stopReason === 'string' && stopReason) setStopReason(result, stopReason);
    const usage = record(value.usage);
    result.outputTokens = count(usage?.output_tokens) ?? result.outputTokens;
    const cacheRead = count(usage?.cache_read_input_tokens);
    if (cacheRead !== undefined) result.cacheReadTokens = cacheRead;
    const cacheWrite = count(usage?.cache_creation_input_tokens);
    if (cacheWrite !== undefined) result.cacheWriteTokens = cacheWrite;
  }
}

function readChat(value: Record<string, unknown>, result: ChatStreamResult, delta: Delta): void {
  if (typeof value.model === 'string') result.model = value.model;
  const usage = record(value.usage);
  if (usage) {
    result.inputTokens = count(usage.prompt_tokens) ?? result.inputTokens;
    result.outputTokens = count(usage.completion_tokens) ?? result.outputTokens;
    result.reasoningTokens = count(record(usage.completion_tokens_details)?.reasoning_tokens) ?? result.reasoningTokens;
    const cacheRead = count(record(usage.prompt_tokens_details)?.cached_tokens) ?? count(usage.prompt_cache_hit_tokens);
    if (cacheRead !== undefined) result.cacheReadTokens = cacheRead;
  }
  const choice = record(Array.isArray(value.choices) ? value.choices[0] : undefined);
  const part = record(choice?.delta);
  // DeepSeek and the gateways copying it stream reasoning beside the answer.
  delta('reasoning', part?.reasoning_content ?? part?.reasoning);
  delta('text', part?.content);
  delta('text', part?.refusal);
  if (typeof choice?.finish_reason === 'string' && choice.finish_reason) {
    setStopReason(result, choice.finish_reason);
    if (choice.finish_reason === 'length') result.cutOff = true;
  }
}

function readResponses(type: string | undefined, value: Record<string, unknown>, result: ChatStreamResult, delta: Delta): void {
  if (type === 'response.output_text.delta' || type === 'response.refusal.delta') delta('text', value.delta);
  else if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') delta('reasoning', value.delta);
  else if (type === 'response.completed' || type === 'response.incomplete') {
    const response = record(value.response);
    if (typeof response?.model === 'string') result.model = response.model;
    const usage = record(response?.usage);
    result.inputTokens = count(usage?.input_tokens) ?? result.inputTokens;
    result.outputTokens = count(usage?.output_tokens) ?? result.outputTokens;
    result.reasoningTokens = count(record(usage?.output_tokens_details)?.reasoning_tokens) ?? result.reasoningTokens;
    const cacheRead = count(record(usage?.input_tokens_details)?.cached_tokens);
    if (cacheRead !== undefined) result.cacheReadTokens = cacheRead;
    const stopReason = typeof response?.status === 'string' && response.status
      ? response.status
      : (type === 'response.incomplete' ? 'incomplete' : 'completed');
    setStopReason(result, stopReason);
    if (type === 'response.incomplete') result.cutOff = true;
  } else if (type === 'response.failed') {
    const message = record(record(value.response)?.error)?.message;
    throw new Error(typeof message === 'string' && message ? message.slice(0, 200) : 'model stream failed');
  }
}

/** The events of a `text/event-stream` body; `touch` is called whenever bytes arrive. */
async function* serverSentEvents(body: ReadableStream<Uint8Array>, touch: () => void): AsyncGenerator<{ event?: string; data: string }> {
  const decoder = new TextDecoder();
  let buffer = '';
  const parse = (block: string) => {
    let event: string | undefined;
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    return data.length ? { ...(event ? { event } : {}), data: data.join('\n') } : undefined;
  };
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      touch();
      buffer += decoder.decode(value, { stream: true });
      let end: RegExpExecArray | null;
      while ((end = /\r?\n\r?\n/.exec(buffer))) {
        const parsed = parse(buffer.slice(0, end.index));
        buffer = buffer.slice(end.index + end[0].length);
        if (parsed) yield parsed;
      }
    }
    const rest = parse(buffer + decoder.decode());
    if (rest) yield rest;
  } finally {
    // A reader that stops early (`[DONE]`, an error event) still lets the connection go.
    await reader.cancel().catch(() => undefined);
  }
}

/** The gateway's own words for a refusal, such as a context length exceeded, kept short. */
function errorOf(text: string): string | undefined {
  try {
    const body = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
    const message = typeof body.error === 'string' ? body.error : body.error?.message ?? body.message;
    return typeof message === 'string' && message.trim() ? message.trim().slice(0, 200) : undefined;
  } catch { return undefined; }
}

function cutOff(protocol: GatewayProtocol, body: unknown): boolean {
  const value = body as Record<string, unknown> | undefined;
  if (protocol === 'anthropic') return value?.stop_reason === 'max_tokens';
  if (protocol === 'chat') return (Array.isArray(value?.choices) ? value.choices[0] as Record<string, unknown> | undefined : undefined)?.finish_reason === 'length';
  return value?.status === 'incomplete';
}
