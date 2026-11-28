import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  asString,
  chunkText,
  computeUsage,
  createResponseAbortController,
  extractLastUserText,
  flushAndDestroyResponse,
  isAbortError,
  isRecord,
  resolveEffectiveStopReason,
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

export function writeOpenAiModels(res: ServerResponse, models: MockModelInfo[]): void {
  writeJson(res, 200, {
    object: 'list',
    data: models.map((m) => ({
      id: m.id,
      object: 'model',
      created: 1767225600,
      owned_by: m.ownedBy ?? 'mock-llm',
    })),
  });
}

function statusToChatErrorType(status: number): string {
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
    default:
      return status >= 500 ? 'server_error' : 'invalid_request_error';
  }
}

export function writeOpenAiChatError(res: ServerResponse, err: MockErrorSpec): void {
  writeJson(
    res,
    err.status,
    {
      error: {
        message: err.message,
        type: err.type ?? statusToChatErrorType(err.status),
        code: err.code ?? (err.status === 417 ? 'mock_route_mismatch' : null),
      },
    },
    retryAfterHeaders(err),
  );
}

export function normalizeOpenAiChatRequest(
  id: number,
  method: string,
  path: string,
  headers: Record<string, string | string[] | undefined>,
  raw: unknown,
): NormalizedRequest {
  const body = isRecord(raw) ? raw : {};
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const rawTools = Array.isArray(body.tools) ? body.tools : [];

  const toolNames: string[] = [];
  for (const t of rawTools) {
    if (!isRecord(t)) continue;
    const name = (isRecord(t.function) ? asString(t.function.name) : '') || asString(t.name);
    if (name) toolNames.push(name);
  }

  const systemParts: string[] = [];
  const messages: NormalizedMessage[] = [];
  const allToolResults: NormalizedToolResult[] = [];
  const toolNameById = new Map<string, string>();
  let hasImage = false;
  let assistantTurns = 0;

  for (const item of rawMessages) {
    if (!isRecord(item)) continue;
    const role = asString(item.role) || 'user';
    const content = item.content;
    const textParts: string[] = [];
    let msgHasImage = false;

    if (typeof content === 'string') {
      textParts.push(content);
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === 'string') {
          textParts.push(part);
        } else if (isRecord(part)) {
          const type = asString(part.type);
          if (type === 'text' && typeof part.text === 'string') {
            textParts.push(part.text);
          } else if (type === 'image_url' || type === 'input_image' || type === 'image') {
            msgHasImage = true;
          }
        }
      }
    }

    const text = textParts.join('\n');
    if (role === 'system' || role === 'developer') {
      if (text) systemParts.push(text);
      continue;
    }

    if (role === 'tool') {
      if (msgHasImage) hasImage = true;
      const toolCallId = asString(item.tool_call_id);
      const toolName = asString(item.name) || toolNameById.get(toolCallId);
      const result: NormalizedToolResult = {
        toolCallId,
        toolName,
        content: text,
        isError: item.is_error === true,
      };
      allToolResults.push(result);
      messages.push({ role: 'tool', text, hasImage: msgHasImage, toolResults: [result] });
      continue;
    }

    const toolCalls: NormalizedToolCall[] = [];
    if (role === 'assistant') {
      assistantTurns++;
      const rawCalls = Array.isArray(item.tool_calls) ? item.tool_calls : [];
      for (const call of rawCalls) {
        if (!isRecord(call)) continue;
        const callId = asString(call.id);
        const fn = isRecord(call.function) ? call.function : {};
        const name = asString(fn.name);
        const rawArgs = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {});
        if (callId && name) toolNameById.set(callId, name);
        const parsed = safeJsonParse(rawArgs);
        toolCalls.push({
          id: callId,
          name,
          arguments: parsed.ok ? parsed.value : {},
          rawArguments: rawArgs,
          ...(parsed.ok ? {} : { malformedJson: rawArgs }),
        });
      }
    }

    if (msgHasImage) hasImage = true;
    const msg: NormalizedMessage = { role, text, hasImage: msgHasImage };
    if (toolCalls.length > 0) msg.toolCalls = toolCalls;
    messages.push(msg);
  }

  return {
    id,
    receivedAt: Date.now(),
    protocol: 'openai-chat',
    method,
    path,
    model: asString(body.model),
    stream: body.stream === true,
    system: systemParts.join('\n'),
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

async function triggerChatStreamFault(res: ServerResponse, reply: MockReplySpec): Promise<void> {
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
        error: {
          message: fault.message ?? 'Simulated OpenAI Chat stream error',
          type: 'server_error',
          code: 'stream_error',
        },
      }),
    );
    res.end();
    return;
  }
  if (fault.mode === 'malformed-sse') {
    if (!res.writableEnded && !res.destroyed) {
      res.write('data: {"id":"chatcmpl_broken","choices":[\n\n');
      res.end();
    }
  }
}

export async function handleOpenAiChatCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  raw: unknown,
  ctx: ProtocolRuntimeContext,
): Promise<void> {
  const normalized = normalizeOpenAiChatRequest(
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
      writeOpenAiChatError(res, reply.error);
      return;
    }

    const usage = computeUsage(normalized, reply);
    const finishReason = resolveEffectiveStopReason(reply);
    const completionId = `chatcmpl_mock_${normalized.id}`;
    const created = Math.floor(Date.now() / 1000);
    const model = normalized.model || 'gpt-4o-mock';
    const usagePayload = {
      prompt_tokens: usage.inputTokens,
      completion_tokens: usage.outputTokens,
      total_tokens: usage.inputTokens + usage.outputTokens,
      prompt_tokens_details: { cached_tokens: usage.cacheReadTokens },
      completion_tokens_details: { reasoning_tokens: usage.reasoningTokens },
    };

    if (!normalized.stream) {
      if (reply.gates?.beforeFirstToken) {
        await ctx.arriveGate(reply.gates.beforeFirstToken, signal);
      }
      if (reply.toolCalls && reply.toolCalls.length > 0 && reply.gates?.beforeToolUse) {
        await ctx.arriveGate(reply.gates.beforeToolUse, signal);
      }

      const message: Record<string, unknown> = {
        role: 'assistant',
        content: reply.text ?? null,
      };
      if (reply.thinking) {
        message.reasoning_content = reply.thinking.text;
      }
      if (reply.toolCalls && reply.toolCalls.length > 0) {
        message.tool_calls = reply.toolCalls.map((tc, i) => ({
          id: tc.id ?? `call_mock_${normalized.id}_${i + 1}`,
          type: 'function',
          function: {
            name: tc.name,
            arguments: serializeToolArguments(tc),
          },
        }));
      }

      writeJson(res, 200, {
        id: completionId,
        object: 'chat.completion',
        created,
        model,
        choices: [{ index: 0, message, finish_reason: finishReason }],
        usage: usagePayload,
      });

      if (reply.gates?.afterComplete) {
        await ctx.arriveGate(reply.gates.afterComplete, signal).catch(() => {});
      }
      return;
    }

    // Streaming SSE
    startSse(res);

    const writeChunk = (delta: Record<string, unknown>, chunkFinishReason: string | null = null): boolean => {
      return writeSseData(
        res,
        JSON.stringify({
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta, finish_reason: chunkFinishReason }],
        }),
      );
    };

    // Initial role chunk
    writeChunk({ role: 'assistant' });

    if (reply.gates?.beforeFirstToken) {
      await ctx.arriveGate(reply.gates.beforeFirstToken, signal);
    }

    if (reply.streamFault && reply.streamFault.afterChunks === 0) {
      await triggerChatStreamFault(res, reply);
      return;
    }

    let emittedChunks = 0;
    const afterChunkEmit = async (): Promise<boolean> => {
      emittedChunks++;
      if (reply.streamFault && emittedChunks === reply.streamFault.afterChunks) {
        await triggerChatStreamFault(res, reply);
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

    // 1. DeepSeek / OpenAI compatible reasoning_content
    if (reply.thinking) {
      for (const piece of chunkText(reply.thinking.text, reply.chunkSize)) {
        if (!writeChunk({ reasoning_content: piece })) return;
        if (!(await afterChunkEmit())) return;
      }
    }

    // 2. Content text
    if (reply.text !== undefined && reply.text.length > 0) {
      for (const piece of chunkText(reply.text, reply.chunkSize)) {
        if (!writeChunk({ content: piece })) return;
        if (!(await afterChunkEmit())) return;
      }
    }

    // 3. Tool calls
    if (reply.toolCalls && reply.toolCalls.length > 0) {
      if (reply.gates?.beforeToolUse) {
        await ctx.arriveGate(reply.gates.beforeToolUse, signal);
      }

      for (let i = 0; i < reply.toolCalls.length; i++) {
        const tc = reply.toolCalls[i];
        const callId = tc.id ?? `call_mock_${normalized.id}_${i + 1}`;
        const rawArgs = serializeToolArguments(tc);

        if (!writeChunk({
          tool_calls: [{
            index: i,
            id: callId,
            type: 'function',
            function: { name: tc.name, arguments: '' },
          }],
        })) {
          return;
        }

        for (const piece of chunkText(rawArgs, reply.chunkSize ?? 32)) {
          if (!writeChunk({
            tool_calls: [{
              index: i,
              function: { arguments: piece },
            }],
          })) {
            return;
          }
          if (reply.chunkDelayMs && reply.chunkDelayMs > 0) {
            await sleep(reply.chunkDelayMs, signal);
          }
        }
      }
    }

    // 4. Finish reason + usage chunk + [DONE]
    writeChunk({}, finishReason);
    writeSseData(
      res,
      JSON.stringify({
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [],
        usage: usagePayload,
      }),
    );
    writeSseData(res, '[DONE]');

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
      writeOpenAiChatError(res, {
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
