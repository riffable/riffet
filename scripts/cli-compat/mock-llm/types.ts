import type { IncomingMessage, ServerResponse } from 'node:http';

export type MockProtocol =
  | 'anthropic-messages'
  | 'openai-responses'
  | 'openai-responses-ws'
  | 'openai-chat'
  | 'google-generative-ai';

export interface NormalizedToolCall {
  id: string;
  name: string;
  arguments: unknown;
  rawArguments?: string;
  malformedJson?: string;
}

export interface NormalizedToolResult {
  toolCallId: string;
  toolName?: string;
  content: string;
  isError?: boolean;
}

export interface NormalizedMessage {
  role: string;
  text: string;
  hasImage: boolean;
  toolCalls?: NormalizedToolCall[];
  toolResults?: NormalizedToolResult[];
}

export interface NormalizedRequest {
  id: number;
  receivedAt: number;
  protocol: MockProtocol;
  method: string;
  path: string;
  model: string;
  stream: boolean;
  system: string;
  messages: NormalizedMessage[];
  lastUserText: string;
  toolNames: string[];
  toolResults: NormalizedToolResult[];
  hasImage: boolean;
  assistantTurns: number;
  headers: Record<string, string | string[] | undefined>;
  raw: unknown;
}

/**
 * Bidirectional synchronization hooks paused via `GateRegistry`.
 * - `beforeFirstToken`: pauses after headers/initial metadata, before emitting the first content token.
 * - `afterChunk`: pauses after emitting the Nth content chunk (`index` is 1-based; 1 = after 1st chunk).
 * - `beforeToolUse`: pauses before emitting the first tool call block/event.
 * - `afterComplete`: pauses after emitting the final completion event, before closing the response.
 */
export interface MockGateHook {
  beforeFirstToken?: string;
  afterChunk?: { index: number; gate: string };
  beforeToolUse?: string;
  afterComplete?: string;
}

export interface MockThinkingSpec {
  text: string;
  /** When true, generates an Anthropic signature whose base64 header carries `narration`. */
  narration?: boolean;
  signature?: string;
}

export interface MockToolCallSpec {
  id?: string;
  name: string;
  arguments?: unknown;
  /** Raw JSON string sent verbatim over the wire (allows injecting malformed JSON). */
  rawArguments?: string;
}

export interface MockUsageSpec {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  reasoningTokens?: number;
}

export interface MockErrorSpec {
  status: number;
  message: string;
  type?: string;
  code?: string;
  retryAfterMs?: number;
}

export interface MockStreamFaultSpec {
  /** Number of emitted content chunks before injecting the fault (0 = before first chunk). */
  afterChunks: number;
  mode: 'tcp-disconnect' | 'sse-error' | 'malformed-sse';
  message?: string;
}

export interface MockReplySpec {
  text?: string;
  thinking?: MockThinkingSpec;
  toolCalls?: MockToolCallSpec[];
  usage?: MockUsageSpec;
  stopReason?: 'stop' | 'tool_calls' | 'length' | 'content_filter';
  chunkSize?: number;
  chunkDelayMs?: number;
  delayMs?: number;
  gates?: MockGateHook;
  error?: MockErrorSpec;
  streamFault?: MockStreamFaultSpec;
}

export interface MockRoute {
  id: string;
  priority?: number;
  match: (req: NormalizedRequest) => boolean;
  handle: (req: NormalizedRequest) => MockReplySpec | Promise<MockReplySpec>;
}

export interface MockModelInfo {
  id: string;
  displayName?: string;
  ownedBy?: string;
}

export interface ProtocolRuntimeContext {
  nextRequestId: () => number;
  getModels: () => MockModelInfo[];
  dispatch: (req: NormalizedRequest) => Promise<MockReplySpec>;
  arriveGate: (name: string, signal?: AbortSignal) => Promise<void>;
}

export const DEFAULT_NARRATION_SIGNATURE = Buffer.from('narration:mock-llm-sig-v1').toString('base64');
export const DEFAULT_THINKING_SIGNATURE = Buffer.from('reasoning:mock-llm-sig-v1').toString('base64');

export function resolveThinkingSignature(thinking: MockThinkingSpec): string {
  if (thinking.signature !== undefined) return thinking.signature;
  return thinking.narration ? DEFAULT_NARRATION_SIGNATURE : DEFAULT_THINKING_SIGNATURE;
}

export function resolveEffectiveStopReason(reply: MockReplySpec): NonNullable<MockReplySpec['stopReason']> {
  if (reply.stopReason) return reply.stopReason;
  if (reply.toolCalls && reply.toolCalls.length > 0) return 'tool_calls';
  return 'stop';
}

export function serializeToolArguments(call: MockToolCallSpec): string {
  if (call.rawArguments !== undefined) return call.rawArguments;
  return JSON.stringify(call.arguments ?? {});
}

export function safeJsonParse(raw: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

export function chunkText(text: string, chunkSize = 16): string[] {
  if (!text) return [];
  const size = Math.max(1, Math.floor(chunkSize));
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    out.push(text.slice(i, i + size));
  }
  return out;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) {
    return Promise.reject(createAbortError('Operation aborted'));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError('Operation aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function createAbortError(message: string): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

export function extractLastUserText(messages: NormalizedMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'user' && msg.text.trim().length > 0 && (!msg.toolResults || msg.toolResults.length === 0)) {
      return msg.text;
    }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'user' && msg.text.trim().length > 0) {
      return msg.text;
    }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'user') return msg.text;
  }
  return '';
}

export function formatMismatchMessage(req: NormalizedRequest): string {
  const preview = req.lastUserText.replace(/\s+/g, ' ').trim().slice(0, 140);
  const tools = req.toolNames.length > 0 ? req.toolNames.join(',') : 'none';
  return `MockLlmHub 417 route mismatch: protocol=${req.protocol} model=${req.model || 'unknown'} path=${req.path} tools=[${tools}] toolResults=${req.toolResults.length} lastUserText=${JSON.stringify(preview)}`;
}

export function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): void {
  if (res.writableEnded || res.destroyed) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
    ...extraHeaders,
  });
  res.end(payload);
}

export function startSse(res: ServerResponse): void {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.flushHeaders?.();
}

export function writeSseData(res: ServerResponse, data: string, event?: string): boolean {
  if (res.writableEnded || res.destroyed) return false;
  if (event) {
    res.write(`event: ${event}\ndata: ${data}\n\n`);
  } else {
    res.write(`data: ${data}\n\n`);
  }
  return true;
}

/**
 * Flushes buffered bytes to the socket and then forcefully destroys the TCP connection
 * so clients observe the already-emitted chunks before hitting a premature close / reset.
 */
export async function flushAndDestroyResponse(res: ServerResponse, delayMs = 15): Promise<void> {
  if (res.destroyed) return;
  await new Promise<void>((resolve) => {
    if (res.writableEnded || res.destroyed) {
      resolve();
      return;
    }
    res.write('', () => {
      setTimeout(resolve, delayMs);
    });
  });
  res.socket?.destroy();
}

export function createResponseAbortController(req: IncomingMessage, res: ServerResponse): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) {
      controller.abort();
    }
  };
  req.on('aborted', onClose);
  res.on('close', onClose);
  return {
    signal: controller.signal,
    cleanup: () => {
      req.off('aborted', onClose);
      res.off('close', onClose);
    },
  };
}

export function retryAfterHeaders(err: MockErrorSpec): Record<string, string> | undefined {
  if (err.retryAfterMs === undefined || err.retryAfterMs < 0) return undefined;
  const seconds = Math.max(1, Math.ceil(err.retryAfterMs / 1000));
  return {
    'retry-after': String(seconds),
    'retry-after-ms': String(err.retryAfterMs),
  };
}

export function estimateInputTokens(req: NormalizedRequest): number {
  let chars = req.system.length;
  for (const m of req.messages) {
    chars += m.text.length;
    if (m.toolCalls) {
      for (const tc of m.toolCalls) chars += tc.name.length + (tc.rawArguments?.length ?? 20);
    }
    if (m.toolResults) {
      for (const tr of m.toolResults) chars += tr.content.length;
    }
  }
  return Math.max(1, Math.ceil(chars / 4));
}

export function computeUsage(req: NormalizedRequest, reply: MockReplySpec): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
} {
  const textLen = (reply.text?.length ?? 0) + (reply.thinking?.text.length ?? 0);
  const toolLen = (reply.toolCalls ?? []).reduce((sum, tc) => sum + tc.name.length + serializeToolArguments(tc).length, 0);
  const defaultOut = Math.max(1, Math.ceil((textLen + toolLen) / 4));
  const defaultReasoning = reply.thinking ? Math.max(1, Math.ceil(reply.thinking.text.length / 4)) : 0;
  return {
    inputTokens: reply.usage?.inputTokens ?? estimateInputTokens(req),
    outputTokens: reply.usage?.outputTokens ?? defaultOut,
    cacheReadTokens: reply.usage?.cacheReadTokens ?? 0,
    cacheCreationTokens: reply.usage?.cacheCreationTokens ?? 0,
    reasoningTokens: reply.usage?.reasoningTokens ?? defaultReasoning,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
