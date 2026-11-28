import type { IncomingMessage, ServerResponse } from 'node:http';
import { WebSocket } from 'ws';
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
  type MockProtocol,
  type MockReplySpec,
  type NormalizedMessage,
  type NormalizedRequest,
  type NormalizedToolCall,
  type NormalizedToolResult,
  type ProtocolRuntimeContext,
} from '../types.js';

function statusToOpenAiErrorType(status: number): string {
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

export function writeOpenAiResponsesError(res: ServerResponse, err: MockErrorSpec): void {
  writeJson(
    res,
    err.status,
    {
      error: {
        message: err.message,
        type: err.type ?? statusToOpenAiErrorType(err.status),
        code: err.code ?? (err.status === 417 ? 'mock_route_mismatch' : null),
      },
    },
    retryAfterHeaders(err),
  );
}

interface ParsedInput {
  systemParts: string[];
  messages: NormalizedMessage[];
  toolResults: NormalizedToolResult[];
  hasImage: boolean;
  assistantTurns: number;
}

function extractResponsesToolOutput(rawOut: unknown): { text: string; hasImage: boolean } {
  if (typeof rawOut === 'string') return { text: rawOut, hasImage: false };
  if (Array.isArray(rawOut)) {
    const textParts: string[] = [];
    let hasImage = false;
    for (const part of rawOut) {
      if (typeof part === 'string') {
        textParts.push(part);
        continue;
      }
      if (!isRecord(part)) continue;
      const partType = asString(part.type);
      if ((partType === 'input_text' || partType === 'output_text' || partType === 'text') && typeof part.text === 'string') {
        textParts.push(part.text);
      } else if (partType === 'input_image' || partType === 'image_url' || partType === 'image') {
        hasImage = true;
      }
    }
    const text = textParts.length > 0 ? textParts.join('\n') : JSON.stringify(rawOut);
    return { text, hasImage };
  }
  return { text: rawOut === undefined || rawOut === null ? '' : JSON.stringify(rawOut), hasImage: false };
}

function parseResponsesInput(
  rawInput: unknown,
  inheritedToolNames?: Map<string, string>,
): ParsedInput {
  const systemParts: string[] = [];
  const messages: NormalizedMessage[] = [];
  const allToolResults: NormalizedToolResult[] = [];
  const toolNameById = new Map<string, string>(inheritedToolNames);
  let hasImage = false;
  let assistantTurns = 0;

  if (typeof rawInput === 'string') {
    messages.push({ role: 'user', text: rawInput, hasImage: false });
    return { systemParts, messages, toolResults: allToolResults, hasImage, assistantTurns };
  }

  if (!Array.isArray(rawInput)) {
    return { systemParts, messages, toolResults: allToolResults, hasImage, assistantTurns };
  }

  for (const item of rawInput) {
    if (!isRecord(item)) continue;
    const itemType = asString(item.type);

    if (itemType === 'function_call') {
      const callId = asString(item.call_id) || asString(item.id);
      const name = asString(item.name);
      const rawArgs = typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {});
      if (callId && name) toolNameById.set(callId, name);
      const parsed = safeJsonParse(rawArgs);
      const tc: NormalizedToolCall = {
        id: callId,
        name,
        arguments: parsed.ok ? parsed.value : {},
        rawArguments: rawArgs,
        ...(parsed.ok ? {} : { malformedJson: rawArgs }),
      };
      assistantTurns++;
      messages.push({ role: 'assistant', text: '', hasImage: false, toolCalls: [tc] });
      continue;
    }

    if (itemType === 'function_call_output') {
      const callId = asString(item.call_id) || asString(item.id);
      const extracted = extractResponsesToolOutput(item.output);
      if (extracted.hasImage) hasImage = true;
      const tr: NormalizedToolResult = {
        toolCallId: callId,
        toolName: toolNameById.get(callId),
        content: extracted.text,
        isError: item.is_error === true || item.status === 'failed',
      };
      allToolResults.push(tr);
      messages.push({ role: 'tool', text: extracted.text, hasImage: extracted.hasImage, toolResults: [tr] });
      continue;
    }

    // Message item (`type === 'message'` or role-based object)
    const role = asString(item.role) || (itemType === 'message' ? 'user' : '');
    if (!role) continue;

    const textParts: string[] = [];
    let msgHasImage = false;
    const content = item.content;

    if (typeof content === 'string') {
      textParts.push(content);
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === 'string') {
          textParts.push(part);
          continue;
        }
        if (!isRecord(part)) continue;
        const partType = asString(part.type);
        if ((partType === 'input_text' || partType === 'output_text' || partType === 'text') && typeof part.text === 'string') {
          textParts.push(part.text);
        } else if (partType === 'input_image' || partType === 'image_url' || partType === 'image') {
          msgHasImage = true;
        }
      }
    }

    const joined = textParts.join('\n');
    if (role === 'system' || role === 'developer') {
      if (joined) systemParts.push(joined);
      continue;
    }

    if (role === 'assistant') assistantTurns++;
    if (msgHasImage) hasImage = true;
    messages.push({ role, text: joined, hasImage: msgHasImage });
  }

  return { systemParts, messages, toolResults: allToolResults, hasImage, assistantTurns };
}

interface PreviousTurnSnapshot {
  messages: NormalizedMessage[];
  toolNamesById: Map<string, string>;
  hasImage: boolean;
  assistantTurns: number;
}

const MAX_RESPONSES_HISTORY = 512;
const responsesHistoryByCtx = new WeakMap<ProtocolRuntimeContext, Map<string, PreviousTurnSnapshot>>();

function getResponsesHistory(ctx: ProtocolRuntimeContext): Map<string, PreviousTurnSnapshot> {
  let map = responsesHistoryByCtx.get(ctx);
  if (!map) {
    map = new Map<string, PreviousTurnSnapshot>();
    responsesHistoryByCtx.set(ctx, map);
  }
  return map;
}

function recordResponsesHistory(
  history: Map<string, PreviousTurnSnapshot>,
  responseId: string,
  normalized: NormalizedRequest,
  previous: PreviousTurnSnapshot | undefined,
  assistantMessage: NormalizedMessage,
  toolNamesById: Map<string, string>,
): void {
  const mergedToolNames = new Map<string, string>(previous?.toolNamesById);
  for (const [k, v] of toolNamesById) mergedToolNames.set(k, v);
  history.delete(responseId);
  history.set(responseId, {
    messages: [...normalized.messages, assistantMessage],
    toolNamesById: mergedToolNames,
    hasImage: normalized.hasImage,
    assistantTurns: normalized.assistantTurns + 1,
  });
  while (history.size > MAX_RESPONSES_HISTORY) {
    const oldest = history.keys().next().value;
    if (oldest === undefined) break;
    history.delete(oldest);
  }
}

export function normalizeResponsesRequest(
  id: number,
  protocol: Extract<MockProtocol, 'openai-responses' | 'openai-responses-ws'>,
  method: string,
  path: string,
  headers: Record<string, string | string[] | undefined>,
  raw: unknown,
  previous?: PreviousTurnSnapshot,
): NormalizedRequest {
  const body = isRecord(raw) ? raw : {};
  const instructions = asString(body.instructions);
  const parsed = parseResponsesInput(body.input, previous?.toolNamesById);

  const systemParts = [...(instructions ? [instructions] : []), ...parsed.systemParts];
  const rawTools = Array.isArray(body.tools) ? body.tools : [];
  const toolNames: string[] = [];
  for (const t of rawTools) {
    if (!isRecord(t)) continue;
    const name = asString(t.name) || (isRecord(t.function) ? asString(t.function.name) : '');
    if (name) toolNames.push(name);
  }

  const combinedMessages = previous ? [...previous.messages, ...parsed.messages] : parsed.messages;
  const combinedHasImage = Boolean(previous?.hasImage) || parsed.hasImage;
  const combinedAssistantTurns = (previous?.assistantTurns ?? 0) + parsed.assistantTurns;

  return {
    id,
    receivedAt: Date.now(),
    protocol,
    method,
    path,
    model: asString(body.model),
    stream: protocol === 'openai-responses-ws' ? true : body.stream === true,
    system: systemParts.join('\n'),
    messages: combinedMessages,
    lastUserText: extractLastUserText(combinedMessages),
    toolNames,
    toolResults: parsed.toolResults,
    hasImage: combinedHasImage,
    assistantTurns: combinedAssistantTurns,
    headers,
    raw,
  };
}

function mapResponseStatus(reply: MockReplySpec): 'completed' | 'incomplete' {
  const reason = resolveEffectiveStopReason(reply);
  return reason === 'length' || reason === 'content_filter' ? 'incomplete' : 'completed';
}

interface StreamSink {
  sendEvent: (event: Record<string, unknown>) => boolean;
  sendRawFault: (
    mode: 'tcp-disconnect' | 'sse-error' | 'malformed-sse',
    message: string,
    responseId: string,
  ) => Promise<void> | void;
  isClosed: () => boolean;
}

async function emitResponsesStream(
  normalized: NormalizedRequest,
  reply: MockReplySpec,
  ctx: ProtocolRuntimeContext,
  sink: StreamSink,
  signal: AbortSignal,
): Promise<{
  responseId: string;
  completed: boolean;
  assistantMessage: NormalizedMessage;
  toolNamesById: Map<string, string>;
}> {
  const responseId = `resp_mock_${normalized.id}`;
  const model = normalized.model || 'gpt-5-mock';
  const usage = computeUsage(normalized, reply);
  const effectiveStopReason = resolveEffectiveStopReason(reply);
  const status = mapResponseStatus(reply);
  const toolNamesById = new Map<string, string>();
  const recordedToolCalls: NormalizedToolCall[] = [];
  const abortedResult = () => ({
    responseId,
    completed: false,
    assistantMessage: { role: 'assistant', text: '', hasImage: false } as NormalizedMessage,
    toolNamesById,
  });

  let seq = 0;
  const emit = (payload: Record<string, unknown>): boolean => {
    return sink.sendEvent({ ...payload, sequence_number: seq++ });
  };

  emit({
    type: 'response.created',
    response: { id: responseId, object: 'response', status: 'in_progress', model, output: [] },
  });
  emit({
    type: 'response.in_progress',
    response: { id: responseId, object: 'response', status: 'in_progress', model, output: [] },
  });

  if (reply.gates?.beforeFirstToken) {
    await ctx.arriveGate(reply.gates.beforeFirstToken, signal);
  }

  if (reply.streamFault && reply.streamFault.afterChunks === 0) {
    await sink.sendRawFault(
      reply.streamFault.mode,
      reply.streamFault.message ?? 'Simulated Responses stream fault',
      responseId,
    );
    return abortedResult();
  }

  let emittedChunks = 0;
  let outputIndex = 0;
  const finalOutput: unknown[] = [];

  const afterChunkEmit = async (): Promise<boolean> => {
    emittedChunks++;
    if (reply.streamFault && emittedChunks === reply.streamFault.afterChunks) {
      await sink.sendRawFault(
        reply.streamFault.mode,
        reply.streamFault.message ?? 'Simulated Responses stream fault',
        responseId,
      );
      return false;
    }
    if (reply.gates?.afterChunk && emittedChunks === reply.gates.afterChunk.index) {
      await ctx.arriveGate(reply.gates.afterChunk.gate, signal);
    }
    if (reply.chunkDelayMs && reply.chunkDelayMs > 0) {
      await sleep(reply.chunkDelayMs, signal);
    }
    return !signal.aborted && !sink.isClosed();
  };

  if (reply.gates?.afterChunk && reply.gates.afterChunk.index === 0) {
    await ctx.arriveGate(reply.gates.afterChunk.gate, signal);
  }

  // 1. Reasoning item
  if (reply.thinking) {
    const idx = outputIndex++;
    const rsId = `rs_mock_${normalized.id}_${idx}`;
    emit({
      type: 'response.output_item.added',
      output_index: idx,
      item: { id: rsId, type: 'reasoning', status: 'in_progress', summary: [] },
    });
    emit({
      type: 'response.reasoning_summary_part.added',
      item_id: rsId,
      output_index: idx,
      summary_index: 0,
      part: { type: 'summary_text', text: '' },
    });

    for (const piece of chunkText(reply.thinking.text, reply.chunkSize)) {
      if (!emit({
        type: 'response.reasoning_summary_text.delta',
        item_id: rsId,
        output_index: idx,
        summary_index: 0,
        delta: piece,
      })) {
        return abortedResult();
      }
      if (!(await afterChunkEmit())) {
        return abortedResult();
      }
    }

    emit({
      type: 'response.reasoning_summary_text.done',
      item_id: rsId,
      output_index: idx,
      summary_index: 0,
      text: reply.thinking.text,
    });
    emit({
      type: 'response.reasoning_summary_part.done',
      item_id: rsId,
      output_index: idx,
      summary_index: 0,
      part: { type: 'summary_text', text: reply.thinking.text },
    });

    const completedReasoning = {
      id: rsId,
      type: 'reasoning',
      status: 'completed',
      summary: [{ type: 'summary_text', text: reply.thinking.text }],
    };
    finalOutput.push(completedReasoning);
    emit({
      type: 'response.output_item.done',
      output_index: idx,
      item: completedReasoning,
    });
  }

  // 2. Assistant text message item
  if (reply.text !== undefined && reply.text.length > 0) {
    const idx = outputIndex++;
    const msgId = `msg_mock_${normalized.id}_${idx}`;
    emit({
      type: 'response.output_item.added',
      output_index: idx,
      item: { id: msgId, type: 'message', role: 'assistant', status: 'in_progress', content: [] },
    });
    emit({
      type: 'response.content_part.added',
      item_id: msgId,
      output_index: idx,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });

    for (const piece of chunkText(reply.text, reply.chunkSize)) {
      if (!emit({
        type: 'response.output_text.delta',
        item_id: msgId,
        output_index: idx,
        content_index: 0,
        delta: piece,
      })) {
        return abortedResult();
      }
      if (!(await afterChunkEmit())) {
        return abortedResult();
      }
    }

    emit({
      type: 'response.output_text.done',
      item_id: msgId,
      output_index: idx,
      content_index: 0,
      text: reply.text,
    });
    emit({
      type: 'response.content_part.done',
      item_id: msgId,
      output_index: idx,
      content_index: 0,
      part: { type: 'output_text', text: reply.text, annotations: [] },
    });

    const completedMessage = {
      id: msgId,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: reply.text, annotations: [] }],
    };
    finalOutput.push(completedMessage);
    emit({
      type: 'response.output_item.done',
      output_index: idx,
      item: completedMessage,
    });
  }

  // 3. Function call items
  if (reply.toolCalls && reply.toolCalls.length > 0) {
    if (reply.gates?.beforeToolUse) {
      await ctx.arriveGate(reply.gates.beforeToolUse, signal);
    }

    for (let i = 0; i < reply.toolCalls.length; i++) {
      const tc = reply.toolCalls[i];
      const idx = outputIndex++;
      const callId = tc.id ?? `call_mock_${normalized.id}_${i + 1}`;
      const fcItemId = `fc_mock_${normalized.id}_${i + 1}`;
      const rawArgs = serializeToolArguments(tc);
      toolNamesById.set(callId, tc.name);
      const parsed = safeJsonParse(rawArgs);
      recordedToolCalls.push({
        id: callId,
        name: tc.name,
        arguments: parsed.ok ? parsed.value : {},
        rawArguments: rawArgs,
        ...(parsed.ok ? {} : { malformedJson: rawArgs }),
      });

      emit({
        type: 'response.output_item.added',
        output_index: idx,
        item: {
          id: fcItemId,
          type: 'function_call',
          call_id: callId,
          name: tc.name,
          arguments: '',
          status: 'in_progress',
        },
      });

      for (const piece of chunkText(rawArgs, reply.chunkSize ?? 32)) {
        if (!emit({
          type: 'response.function_call_arguments.delta',
          item_id: fcItemId,
          output_index: idx,
          call_id: callId,
          delta: piece,
        })) {
          return abortedResult();
        }
        if (reply.chunkDelayMs && reply.chunkDelayMs > 0) {
          await sleep(reply.chunkDelayMs, signal);
        }
      }

      emit({
        type: 'response.function_call_arguments.done',
        item_id: fcItemId,
        output_index: idx,
        call_id: callId,
        name: tc.name,
        arguments: rawArgs,
      });

      const completedFc = {
        id: fcItemId,
        type: 'function_call',
        call_id: callId,
        name: tc.name,
        arguments: rawArgs,
        status: 'completed',
      };
      finalOutput.push(completedFc);
      emit({
        type: 'response.output_item.done',
        output_index: idx,
        item: completedFc,
      });
    }
  }

  const terminalEventType = status === 'incomplete' ? 'response.incomplete' : 'response.completed';
  const incompleteDetails = status === 'incomplete'
    ? { reason: effectiveStopReason === 'content_filter' ? 'content_filter' : 'max_output_tokens' }
    : undefined;

  if (!emit({
    type: terminalEventType,
    response: {
      id: responseId,
      object: 'response',
      status,
      ...(incompleteDetails ? { incomplete_details: incompleteDetails } : {}),
      model,
      output: finalOutput,
      usage: {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        total_tokens: usage.inputTokens + usage.outputTokens,
        input_tokens_details: { cached_tokens: usage.cacheReadTokens },
        output_tokens_details: { reasoning_tokens: usage.reasoningTokens },
      },
    },
  })) {
    return abortedResult();
  }

  if (reply.gates?.afterComplete) {
    try {
      await ctx.arriveGate(reply.gates.afterComplete, signal);
    } catch (err) {
      if (!isAbortError(err)) throw err;
    }
  }

  const assistantMessage: NormalizedMessage = {
    role: 'assistant',
    text: reply.text ?? '',
    hasImage: false,
    ...(recordedToolCalls.length > 0 ? { toolCalls: recordedToolCalls } : {}),
  };

  return { responseId, completed: true, assistantMessage, toolNamesById };
}

export async function handleOpenAiResponsesHttp(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  raw: unknown,
  ctx: ProtocolRuntimeContext,
): Promise<void> {
  const historyByResponseId = getResponsesHistory(ctx);
  const previousId = isRecord(raw) ? asString(raw.previous_response_id) : '';
  const previous = previousId ? historyByResponseId.get(previousId) : undefined;

  const normalized = normalizeResponsesRequest(
    ctx.nextRequestId(),
    'openai-responses',
    req.method ?? 'POST',
    path,
    req.headers,
    raw,
    previous,
  );
  const { signal, cleanup } = createResponseAbortController(req, res);

  try {
    const reply = await ctx.dispatch(normalized);

    if (reply.delayMs && reply.delayMs > 0) {
      await sleep(reply.delayMs, signal);
    }

    if (reply.error) {
      writeOpenAiResponsesError(res, reply.error);
      return;
    }

    if (!normalized.stream) {
      if (reply.gates?.beforeFirstToken) {
        await ctx.arriveGate(reply.gates.beforeFirstToken, signal);
      }
      if (reply.toolCalls && reply.toolCalls.length > 0 && reply.gates?.beforeToolUse) {
        await ctx.arriveGate(reply.gates.beforeToolUse, signal);
      }

      const usage = computeUsage(normalized, reply);
      const effectiveStopReason = resolveEffectiveStopReason(reply);
      const status = mapResponseStatus(reply);
      const incompleteDetails = status === 'incomplete'
        ? { reason: effectiveStopReason === 'content_filter' ? 'content_filter' : 'max_output_tokens' }
        : undefined;
      const responseId = `resp_mock_${normalized.id}`;
      const output: unknown[] = [];
      const toolNamesById = new Map<string, string>();
      const recordedToolCalls: NormalizedToolCall[] = [];

      if (reply.thinking) {
        output.push({
          id: `rs_mock_${normalized.id}`,
          type: 'reasoning',
          status: 'completed',
          summary: [{ type: 'summary_text', text: reply.thinking.text }],
        });
      }
      if (reply.text !== undefined && reply.text.length > 0) {
        output.push({
          id: `msg_mock_${normalized.id}`,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: reply.text, annotations: [] }],
        });
      }
      if (reply.toolCalls) {
        for (let i = 0; i < reply.toolCalls.length; i++) {
          const tc = reply.toolCalls[i];
          const callId = tc.id ?? `call_mock_${normalized.id}_${i + 1}`;
          const rawArgs = serializeToolArguments(tc);
          toolNamesById.set(callId, tc.name);
          const parsed = safeJsonParse(rawArgs);
          recordedToolCalls.push({
            id: callId,
            name: tc.name,
            arguments: parsed.ok ? parsed.value : {},
            rawArguments: rawArgs,
            ...(parsed.ok ? {} : { malformedJson: rawArgs }),
          });
          output.push({
            id: `fc_mock_${normalized.id}_${i + 1}`,
            type: 'function_call',
            call_id: callId,
            name: tc.name,
            arguments: rawArgs,
            status: 'completed',
          });
        }
      }

      recordResponsesHistory(
        historyByResponseId,
        responseId,
        normalized,
        previous,
        {
          role: 'assistant',
          text: reply.text ?? '',
          hasImage: false,
          ...(recordedToolCalls.length > 0 ? { toolCalls: recordedToolCalls } : {}),
        },
        toolNamesById,
      );

      writeJson(res, 200, {
        id: responseId,
        object: 'response',
        status,
        ...(incompleteDetails ? { incomplete_details: incompleteDetails } : {}),
        model: normalized.model || 'gpt-5-mock',
        output,
        output_text: reply.text ?? '',
        usage: {
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          total_tokens: usage.inputTokens + usage.outputTokens,
          input_tokens_details: { cached_tokens: usage.cacheReadTokens },
          output_tokens_details: { reasoning_tokens: usage.reasoningTokens },
        },
      });

      if (reply.gates?.afterComplete) {
        await ctx.arriveGate(reply.gates.afterComplete, signal).catch(() => {});
      }
      return;
    }

    startSse(res);

    const sink: StreamSink = {
      sendEvent: (event) => writeSseData(res, JSON.stringify(event), asString(event.type)),
      sendRawFault: async (mode, message, responseId) => {
        if (mode === 'tcp-disconnect') {
          await flushAndDestroyResponse(res);
        } else if (mode === 'sse-error') {
          writeSseData(
            res,
            JSON.stringify({
              type: 'response.failed',
              response: {
                id: responseId,
                status: 'failed',
                error: { code: 'server_error', message },
              },
            }),
            'response.failed',
          );
          res.end();
        } else {
          if (!res.writableEnded && !res.destroyed) {
            res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","broken":\n\n');
            res.end();
          }
        }
      },
      isClosed: () => res.writableEnded || res.destroyed,
    };

    const result = await emitResponsesStream(normalized, reply, ctx, sink, signal);
    if (result.completed) {
      recordResponsesHistory(
        historyByResponseId,
        result.responseId,
        normalized,
        previous,
        result.assistantMessage,
        result.toolNamesById,
      );
    }
    if (!res.writableEnded && !res.destroyed) {
      res.end();
    }
  } catch (err) {
    if (isAbortError(err) || res.destroyed) return;
    if (!res.headersSent) {
      writeOpenAiResponsesError(res, {
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

export function attachOpenAiResponsesWebSocket(
  ws: WebSocket,
  req: IncomingMessage,
  path: string,
  ctx: ProtocolRuntimeContext,
): void {
  const controllers = new Set<AbortController>();
  const historyByResponseId = getResponsesHistory(ctx);

  const sendJson = (payload: unknown): boolean => {
    if (ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(payload));
    return true;
  };

  ws.on('close', () => {
    for (const c of controllers) c.abort();
    controllers.clear();
  });

  ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
    const rawStr = Array.isArray(data)
      ? Buffer.concat(data).toString('utf8')
      : Buffer.isBuffer(data)
        ? data.toString('utf8')
        : Buffer.from(data).toString('utf8');

    const parsed = safeJsonParse(rawStr);
    if (!parsed.ok || !isRecord(parsed.value)) {
      sendJson({
        type: 'error',
        error: { status: 400, type: 'invalid_request_error', message: 'Invalid JSON frame on Responses WebSocket' },
      });
      return;
    }

    const frame = parsed.value;
    const frameType = asString(frame.type);
    if (frameType !== 'response.create') {
      sendJson({
        type: 'error',
        error: { status: 400, type: 'invalid_request_error', message: `Unsupported WS event type: ${frameType || 'empty'}` },
      });
      return;
    }

    // OpenAI Responses WS accepts fields either at top level or nested under `response`.
    const payload = isRecord(frame.response) ? { ...frame, ...frame.response } : frame;
    const previousId = asString(payload.previous_response_id);
    const previous = previousId ? historyByResponseId.get(previousId) : undefined;

    const normalized = normalizeResponsesRequest(
      ctx.nextRequestId(),
      'openai-responses-ws',
      'WS',
      path,
      req.headers,
      payload,
      previous,
    );

    const controller = new AbortController();
    controllers.add(controller);

    void (async () => {
      try {
        const reply = await ctx.dispatch(normalized);

        if (reply.delayMs && reply.delayMs > 0) {
          await sleep(reply.delayMs, controller.signal);
        }

        if (reply.error) {
          sendJson({
            type: 'error',
            status: reply.error.status,
            error: {
              status: reply.error.status,
              message: reply.error.message,
              type: reply.error.type ?? statusToOpenAiErrorType(reply.error.status),
              code: reply.error.code ?? (reply.error.status === 417 ? 'mock_route_mismatch' : null),
            },
          });
          return;
        }

        const sink: StreamSink = {
          sendEvent: (event) => sendJson(event),
          sendRawFault: async (mode, message, responseId) => {
            if (mode === 'tcp-disconnect') {
              await sleep(15);
              ws.terminate();
            } else if (mode === 'sse-error') {
              sendJson({
                type: 'response.failed',
                response: {
                  id: responseId,
                  status: 'failed',
                  error: { code: 'server_error', message },
                },
              });
            } else {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send('{"type":"response.output_text.delta","broken":');
              }
            }
          },
          isClosed: () => ws.readyState !== WebSocket.OPEN,
        };

        const result = await emitResponsesStream(normalized, reply, ctx, sink, controller.signal);
        if (result.completed) {
          recordResponsesHistory(
            historyByResponseId,
            result.responseId,
            normalized,
            previous,
            result.assistantMessage,
            result.toolNamesById,
          );
        }
      } catch (err) {
        if (isAbortError(err) || ws.readyState !== WebSocket.OPEN) return;
        sendJson({
          type: 'error',
          error: { status: 500, type: 'server_error', message: err instanceof Error ? err.message : String(err) },
        });
      } finally {
        controllers.delete(controller);
      }
    })();
  });
}
