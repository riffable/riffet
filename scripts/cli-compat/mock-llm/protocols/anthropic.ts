import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  asString,
  chunkText,
  computeUsage,
  createResponseAbortController,
  estimateInputTokens,
  extractLastUserText,
  flushAndDestroyResponse,
  isAbortError,
  isRecord,
  resolveEffectiveStopReason,
  resolveThinkingSignature,
  retryAfterHeaders,
  safeJsonParse,
  serializeToolArguments,
  sleep,
  startSse,
  writeJson,
  writeSseData,
  type MockErrorSpec,
  type MockModelInfo,
  type MockReplySpec,
  type NormalizedMessage,
  type NormalizedRequest,
  type NormalizedToolCall,
  type NormalizedToolResult,
  type ProtocolRuntimeContext,
} from '../types.js';

export function isAnthropicModelsRequest(req: IncomingMessage): boolean {
  return Boolean(req.headers['anthropic-version'] || req.headers['anthropic-beta']);
}

export function writeAnthropicModels(res: ServerResponse, models: MockModelInfo[]): void {
  const data = models.map((m) => ({
    id: m.id,
    type: 'model',
    display_name: m.displayName ?? m.id,
    created_at: '2026-01-01T00:00:00Z',
  }));
  writeJson(res, 200, {
    data,
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
  });
}

function statusToAnthropicErrorType(status: number): string {
  switch (status) {
    case 400:
      return 'invalid_request_error';
    case 401:
      return 'authentication_error';
    case 403:
      return 'permission_error';
    case 404:
      return 'not_found_error';
    case 417:
      return 'mock_route_mismatch';
    case 429:
      return 'rate_limit_error';
    case 529:
      return 'overloaded_error';
    default:
      return status >= 500 ? 'api_error' : 'invalid_request_error';
  }
}

export function writeAnthropicError(res: ServerResponse, err: MockErrorSpec): void {
  writeJson(
    res,
    err.status,
    {
      type: 'error',
      error: {
        type: err.type ?? statusToAnthropicErrorType(err.status),
        message: err.message,
      },
    },
    retryAfterHeaders(err),
  );
}

function extractSystemText(rawSystem: unknown): string {
  if (typeof rawSystem === 'string') return rawSystem;
  if (Array.isArray(rawSystem)) {
    const parts: string[] = [];
    for (const block of rawSystem) {
      if (typeof block === 'string') {
        parts.push(block);
      } else if (isRecord(block) && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
    return parts.join('\n');
  }
  return '';
}

function extractToolResultContent(content: unknown): { text: string; hasImage: boolean } {
  if (typeof content === 'string') return { text: content, hasImage: false };
  if (!Array.isArray(content)) {
    return { text: content === undefined || content === null ? '' : JSON.stringify(content), hasImage: false };
  }
  const texts: string[] = [];
  let hasImage = false;
  for (const item of content) {
    if (typeof item === 'string') {
      texts.push(item);
    } else if (isRecord(item)) {
      if (item.type === 'text' && typeof item.text === 'string') {
        texts.push(item.text);
      } else if (item.type === 'image') {
        hasImage = true;
      }
    }
  }
  return { text: texts.join('\n'), hasImage };
}

export function normalizeAnthropicRequest(
  id: number,
  method: string,
  path: string,
  headers: Record<string, string | string[] | undefined>,
  raw: unknown,
): NormalizedRequest {
  const body = isRecord(raw) ? raw : {};
  const system = extractSystemText(body.system);
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const rawTools = Array.isArray(body.tools) ? body.tools : [];

  const toolNames: string[] = [];
  for (const tool of rawTools) {
    if (isRecord(tool) && typeof tool.name === 'string') {
      toolNames.push(tool.name);
    }
  }

  const toolNameById = new Map<string, string>();
  const messages: NormalizedMessage[] = [];
  const allToolResults: NormalizedToolResult[] = [];
  let hasImage = false;
  let assistantTurns = 0;

  for (const item of rawMessages) {
    if (!isRecord(item)) continue;
    const role = asString(item.role) || 'user';
    if (role === 'assistant') assistantTurns++;

    const content = item.content;
    const textParts: string[] = [];
    const toolCalls: NormalizedToolCall[] = [];
    const toolResults: NormalizedToolResult[] = [];
    let msgHasImage = false;

    if (typeof content === 'string') {
      textParts.push(content);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (!isRecord(block)) continue;
        const type = asString(block.type);
        if (type === 'text' && typeof block.text === 'string') {
          textParts.push(block.text);
        } else if (type === 'image') {
          msgHasImage = true;
        } else if (type === 'document' && isRecord(block.source) && asString(block.source.media_type).startsWith('image/')) {
          msgHasImage = true;
        } else if (type === 'tool_use') {
          const callId = asString(block.id);
          const name = asString(block.name);
          if (callId && name) toolNameById.set(callId, name);
          toolCalls.push({
            id: callId,
            name,
            arguments: block.input ?? {},
          });
        } else if (type === 'tool_result') {
          const toolCallId = asString(block.tool_use_id);
          const extracted = extractToolResultContent(block.content);
          if (extracted.hasImage) msgHasImage = true;
          const result: NormalizedToolResult = {
            toolCallId,
            toolName: toolNameById.get(toolCallId),
            content: extracted.text,
            isError: block.is_error === true,
          };
          toolResults.push(result);
          allToolResults.push(result);
        }
      }
    }

    if (msgHasImage) hasImage = true;

    const normalizedMsg: NormalizedMessage = {
      role,
      text: textParts.join('\n'),
      hasImage: msgHasImage,
    };
    if (toolCalls.length > 0) normalizedMsg.toolCalls = toolCalls;
    if (toolResults.length > 0) normalizedMsg.toolResults = toolResults;
    messages.push(normalizedMsg);
  }

  return {
    id,
    receivedAt: Date.now(),
    protocol: 'anthropic-messages',
    method,
    path,
    model: asString(body.model),
    stream: body.stream === true,
    system,
    messages,
    lastUserText: extractLastUserText(messages),
    toolNames,
    toolResults: allToolResults,
    hasImage,
    assistantTurns,
    headers,
    raw,
  };
}

function mapStopReason(reply: MockReplySpec): string {
  switch (resolveEffectiveStopReason(reply)) {
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'end_turn';
  }
}

export function handleAnthropicCountTokens(
  res: ServerResponse,
  raw: unknown,
): void {
  const normalized = normalizeAnthropicRequest(0, 'POST', '/v1/messages/count_tokens', {}, raw);
  writeJson(res, 200, { input_tokens: estimateInputTokens(normalized) });
}

async function triggerStreamFault(res: ServerResponse, reply: MockReplySpec): Promise<void> {
  const fault = reply.streamFault;
  if (!fault) return;
  if (fault.mode === 'tcp-disconnect') {
    await flushAndDestroyResponse(res);
    return;
  }
  if (fault.mode === 'sse-error') {
    writeSseData(
      res,
      JSON.stringify({
        type: 'error',
        error: {
          type: 'api_error',
          message: fault.message ?? 'Simulated Anthropic stream error',
        },
      }),
      'error',
    );
    res.end();
    return;
  }
  if (fault.mode === 'malformed-sse') {
    if (!res.writableEnded && !res.destroyed) {
      res.write('event: content_block_delta\ndata: {"type":"content_block_delta","broken":\n\n');
      res.end();
    }
  }
}

export async function handleAnthropicMessages(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  raw: unknown,
  ctx: ProtocolRuntimeContext,
): Promise<void> {
  const normalized = normalizeAnthropicRequest(
    ctx.nextRequestId(),
    req.method ?? 'POST',
    path,
    req.headers,
    raw,
  );

  const { signal, cleanup } = createResponseAbortController(req, res);

  try {
    const reply = await ctx.dispatch(normalized);

    if (reply.delayMs && reply.delayMs > 0) {
      await sleep(reply.delayMs, signal);
    }

    if (reply.error) {
      writeAnthropicError(res, reply.error);
      return;
    }

    const usage = computeUsage(normalized, reply);
    const stopReason = mapStopReason(reply);
    const msgId = `msg_mock_${normalized.id}`;
    const model = normalized.model || 'claude-mock-4';

    if (!normalized.stream) {
      if (reply.gates?.beforeFirstToken) {
        await ctx.arriveGate(reply.gates.beforeFirstToken, signal);
      }
      if (reply.toolCalls && reply.toolCalls.length > 0 && reply.gates?.beforeToolUse) {
        await ctx.arriveGate(reply.gates.beforeToolUse, signal);
      }

      const content: unknown[] = [];
      if (reply.thinking) {
        content.push({
          type: 'thinking',
          thinking: reply.thinking.text,
          signature: resolveThinkingSignature(reply.thinking),
        });
      }
      if (reply.text !== undefined && reply.text.length > 0) {
        content.push({ type: 'text', text: reply.text });
      }
      if (reply.toolCalls) {
        for (let i = 0; i < reply.toolCalls.length; i++) {
          const tc = reply.toolCalls[i];
          const rawArgs = serializeToolArguments(tc);
          const parsed = safeJsonParse(rawArgs);
          content.push({
            type: 'tool_use',
            id: tc.id ?? `toolu_mock_${normalized.id}_${i + 1}`,
            name: tc.name,
            input: parsed.ok && isRecord(parsed.value) ? parsed.value : { __malformedJson: rawArgs },
          });
        }
      }

      writeJson(res, 200, {
        id: msgId,
        type: 'message',
        role: 'assistant',
        model,
        content,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: {
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          cache_read_input_tokens: usage.cacheReadTokens,
          cache_creation_input_tokens: usage.cacheCreationTokens,
        },
      });

      if (reply.gates?.afterComplete) {
        await ctx.arriveGate(reply.gates.afterComplete, signal).catch(() => {});
      }
      return;
    }

    // Streaming SSE response
    startSse(res);

    writeSseData(
      res,
      JSON.stringify({
        type: 'message_start',
        message: {
          id: msgId,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: usage.inputTokens,
            output_tokens: 0,
            cache_read_input_tokens: usage.cacheReadTokens,
            cache_creation_input_tokens: usage.cacheCreationTokens,
          },
        },
      }),
      'message_start',
    );

    if (reply.gates?.beforeFirstToken) {
      await ctx.arriveGate(reply.gates.beforeFirstToken, signal);
    }

    if (reply.streamFault && reply.streamFault.afterChunks === 0) {
      await triggerStreamFault(res, reply);
      return;
    }

    let blockIndex = 0;
    let emittedChunks = 0;

    const afterChunkEmit = async (): Promise<boolean> => {
      emittedChunks++;
      if (reply.streamFault && emittedChunks === reply.streamFault.afterChunks) {
        await triggerStreamFault(res, reply);
        return false;
      }
      if (reply.gates?.afterChunk && emittedChunks === reply.gates.afterChunk.index) {
        await ctx.arriveGate(reply.gates.afterChunk.gate, signal);
      }
      if (reply.chunkDelayMs && reply.chunkDelayMs > 0) {
        await sleep(reply.chunkDelayMs, signal);
      }
      return !signal.aborted && !res.destroyed;
    };

    if (reply.gates?.afterChunk && reply.gates.afterChunk.index === 0) {
      await ctx.arriveGate(reply.gates.afterChunk.gate, signal);
    }

    // 1. Thinking block
    if (reply.thinking) {
      const idx = blockIndex++;
      writeSseData(
        res,
        JSON.stringify({
          type: 'content_block_start',
          index: idx,
          content_block: { type: 'thinking', thinking: '' },
        }),
        'content_block_start',
      );

      for (const piece of chunkText(reply.thinking.text, reply.chunkSize)) {
        if (!writeSseData(
          res,
          JSON.stringify({
            type: 'content_block_delta',
            index: idx,
            delta: { type: 'thinking_delta', thinking: piece },
          }),
          'content_block_delta',
        )) {
          return;
        }
        if (!(await afterChunkEmit())) return;
      }

      const signature = resolveThinkingSignature(reply.thinking);
      writeSseData(
        res,
        JSON.stringify({
          type: 'content_block_delta',
          index: idx,
          delta: { type: 'signature_delta', signature },
        }),
        'content_block_delta',
      );

      writeSseData(
        res,
        JSON.stringify({ type: 'content_block_stop', index: idx }),
        'content_block_stop',
      );
    }

    // 2. Text block
    if (reply.text !== undefined && reply.text.length > 0) {
      const idx = blockIndex++;
      writeSseData(
        res,
        JSON.stringify({
          type: 'content_block_start',
          index: idx,
          content_block: { type: 'text', text: '' },
        }),
        'content_block_start',
      );

      for (const piece of chunkText(reply.text, reply.chunkSize)) {
        if (!writeSseData(
          res,
          JSON.stringify({
            type: 'content_block_delta',
            index: idx,
            delta: { type: 'text_delta', text: piece },
          }),
          'content_block_delta',
        )) {
          return;
        }
        if (!(await afterChunkEmit())) return;
      }

      writeSseData(
        res,
        JSON.stringify({ type: 'content_block_stop', index: idx }),
        'content_block_stop',
      );
    }

    // 3. Tool use blocks
    if (reply.toolCalls && reply.toolCalls.length > 0) {
      if (reply.gates?.beforeToolUse) {
        await ctx.arriveGate(reply.gates.beforeToolUse, signal);
      }

      for (let i = 0; i < reply.toolCalls.length; i++) {
        const tc = reply.toolCalls[i];
        const idx = blockIndex++;
        const callId = tc.id ?? `toolu_mock_${normalized.id}_${i + 1}`;
        const rawArgs = serializeToolArguments(tc);

        writeSseData(
          res,
          JSON.stringify({
            type: 'content_block_start',
            index: idx,
            content_block: { type: 'tool_use', id: callId, name: tc.name, input: {} },
          }),
          'content_block_start',
        );

        const argChunks = chunkText(rawArgs, reply.chunkSize ?? 32);
        for (const piece of argChunks) {
          if (!writeSseData(
            res,
            JSON.stringify({
              type: 'content_block_delta',
              index: idx,
              delta: { type: 'input_json_delta', partial_json: piece },
            }),
            'content_block_delta',
          )) {
            return;
          }
          if (reply.chunkDelayMs && reply.chunkDelayMs > 0) {
            await sleep(reply.chunkDelayMs, signal);
          }
        }

        writeSseData(
          res,
          JSON.stringify({ type: 'content_block_stop', index: idx }),
          'content_block_stop',
        );
      }
    }

    // 4. Completion events
    writeSseData(
      res,
      JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: usage.outputTokens },
      }),
      'message_delta',
    );

    writeSseData(res, JSON.stringify({ type: 'message_stop' }), 'message_stop');

    if (reply.gates?.afterComplete) {
      try {
        await ctx.arriveGate(reply.gates.afterComplete, signal);
      } catch (err) {
        if (!isAbortError(err)) throw err;
      }
    }

    if (!res.writableEnded && !res.destroyed) {
      res.end();
    }
  } catch (err) {
    if (isAbortError(err) || res.destroyed) return;
    if (!res.headersSent) {
      writeAnthropicError(res, {
        status: 500,
        message: err instanceof Error ? err.message : String(err),
      });
    } else {
      res.socket?.destroy();
    }
  } finally {
    cleanup();
  }
}
