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

const GEMINI_ACTION_RE = /^\/v1(?:beta)?\/models\/([^/:]+):(streamGenerateContent|generateContent)$/;

export function matchGeminiActionPath(pathname: string): {
  model: string;
  action: 'streamGenerateContent' | 'generateContent';
} | null {
  const match = GEMINI_ACTION_RE.exec(pathname);
  if (!match) return null;
  return {
    model: decodeURIComponent(match[1]),
    action: match[2] as 'streamGenerateContent' | 'generateContent',
  };
}

export function isGeminiModelsRequest(req: IncomingMessage, searchParams: URLSearchParams): boolean {
  return Boolean(req.headers['x-goog-api-key'] || searchParams.has('key'));
}

export function writeGeminiModels(res: ServerResponse, models: MockModelInfo[]): void {
  writeJson(res, 200, {
    models: models.map((m) => ({
      name: m.id.startsWith('models/') ? m.id : `models/${m.id}`,
      displayName: m.displayName ?? m.id,
      supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
    })),
  });
}

function statusToGeminiStatus(status: number): string {
  switch (status) {
    case 400:
      return 'INVALID_ARGUMENT';
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'PERMISSION_DENIED';
    case 404:
      return 'NOT_FOUND';
    case 417:
      return 'FAILED_PRECONDITION';
    case 429:
      return 'RESOURCE_EXHAUSTED';
    case 503:
      return 'UNAVAILABLE';
    default:
      return status >= 500 ? 'INTERNAL' : 'INVALID_ARGUMENT';
  }
}

export function writeGeminiError(res: ServerResponse, err: MockErrorSpec): void {
  writeJson(
    res,
    err.status,
    {
      error: {
        code: err.status,
        message: err.message,
        status: err.code ?? statusToGeminiStatus(err.status),
      },
    },
    retryAfterHeaders(err),
  );
}

function extractGeminiSystem(rawSystem: unknown): string {
  if (typeof rawSystem === 'string') return rawSystem;
  if (!isRecord(rawSystem)) return '';
  if (typeof rawSystem.text === 'string') return rawSystem.text;
  if (Array.isArray(rawSystem.parts)) {
    const parts: string[] = [];
    for (const p of rawSystem.parts) {
      if (isRecord(p) && typeof p.text === 'string') parts.push(p.text);
    }
    return parts.join('\n');
  }
  return '';
}

export function normalizeGeminiRequest(
  id: number,
  method: string,
  path: string,
  model: string,
  stream: boolean,
  headers: Record<string, string | string[] | undefined>,
  raw: unknown,
): NormalizedRequest {
  const body = isRecord(raw) ? raw : {};
  const system = extractGeminiSystem(body.systemInstruction ?? body.system_instruction);
  const rawTools = Array.isArray(body.tools) ? body.tools : [];
  const toolNames: string[] = [];

  for (const toolGroup of rawTools) {
    if (!isRecord(toolGroup)) continue;
    const decls = toolGroup.functionDeclarations ?? toolGroup.function_declarations;
    if (!Array.isArray(decls)) continue;
    for (const d of decls) {
      if (isRecord(d) && typeof d.name === 'string') {
        toolNames.push(d.name);
      }
    }
  }

  const rawContents = Array.isArray(body.contents) ? body.contents : [];
  const messages: NormalizedMessage[] = [];
  const allToolResults: NormalizedToolResult[] = [];
  let hasImage = false;
  let assistantTurns = 0;

  for (const item of rawContents) {
    if (!isRecord(item)) continue;
    const rawRole = asString(item.role) || 'user';
    const role = rawRole === 'model' ? 'assistant' : rawRole;
    if (role === 'assistant') assistantTurns++;

    const parts = Array.isArray(item.parts) ? item.parts : [];
    const textParts: string[] = [];
    const toolCalls: NormalizedToolCall[] = [];
    const toolResults: NormalizedToolResult[] = [];
    let msgHasImage = false;

    for (const part of parts) {
      if (!isRecord(part)) continue;
      if (typeof part.text === 'string') {
        textParts.push(part.text);
      }
      const inlineData = part.inlineData ?? part.inline_data;
      if (isRecord(inlineData)) {
        const mime = asString(inlineData.mimeType ?? inlineData.mime_type);
        if (!mime || mime.startsWith('image/')) {
          msgHasImage = true;
        }
      }
      const fileData = part.fileData ?? part.file_data;
      if (isRecord(fileData)) {
        const mime = asString(fileData.mimeType ?? fileData.mime_type);
        if (mime.startsWith('image/')) {
          msgHasImage = true;
        }
      }
      if (isRecord(part.functionCall)) {
        const fc = part.functionCall;
        toolCalls.push({
          id: asString(fc.id) || `gemini_call_${toolCalls.length + 1}`,
          name: asString(fc.name),
          arguments: fc.args ?? {},
        });
      }
      if (isRecord(part.functionResponse)) {
        const fr = part.functionResponse;
        const name = asString(fr.name);
        const responseObj = fr.response;
        const content = typeof responseObj === 'string'
          ? responseObj
          : JSON.stringify(responseObj ?? {});
        const isErr = isRecord(responseObj) && (responseObj.isError === true || typeof responseObj.error === 'string');
        const tr: NormalizedToolResult = {
          toolCallId: asString(fr.id) || name,
          toolName: name || undefined,
          content,
          isError: isErr,
        };
        toolResults.push(tr);
        allToolResults.push(tr);
      }
    }

    if (msgHasImage) hasImage = true;
    const msg: NormalizedMessage = {
      role,
      text: textParts.join('\n'),
      hasImage: msgHasImage,
    };
    if (toolCalls.length > 0) msg.toolCalls = toolCalls;
    if (toolResults.length > 0) msg.toolResults = toolResults;
    messages.push(msg);
  }

  return {
    id,
    receivedAt: Date.now(),
    protocol: 'google-generative-ai',
    method,
    path,
    model,
    stream,
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

function mapGeminiFinishReason(reply: MockReplySpec): string {
  switch (resolveEffectiveStopReason(reply)) {
    case 'length':
      return 'MAX_TOKENS';
    case 'content_filter':
      return 'SAFETY';
    default:
      return 'STOP';
  }
}

function buildToolCallPart(tc: NonNullable<MockReplySpec['toolCalls']>[number], callId: string): Record<string, unknown> {
  const rawArgs = serializeToolArguments(tc);
  const parsed = safeJsonParse(rawArgs);
  return {
    functionCall: {
      id: callId,
      name: tc.name,
      args: parsed.ok && isRecord(parsed.value) ? parsed.value : { __malformedJson: rawArgs },
    },
  };
}

export async function handleGeminiGenerateContent(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  searchParams: URLSearchParams,
  model: string,
  action: 'streamGenerateContent' | 'generateContent',
  raw: unknown,
  ctx: ProtocolRuntimeContext,
): Promise<void> {
  const isStream = action === 'streamGenerateContent';
  const isSse = isStream && searchParams.get('alt') === 'sse';
  const normalized = normalizeGeminiRequest(
    ctx.nextRequestId(),
    req.method ?? 'POST',
    pathname,
    model,
    isStream,
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
      writeGeminiError(res, reply.error);
      return;
    }

    const usage = computeUsage(normalized, reply);
    const finishReason = mapGeminiFinishReason(reply);
    const usageMetadata = {
      promptTokenCount: usage.inputTokens,
      candidatesTokenCount: usage.outputTokens,
      totalTokenCount: usage.inputTokens + usage.outputTokens,
      cachedContentTokenCount: usage.cacheReadTokens,
      thoughtsTokenCount: usage.reasoningTokens,
    };

    if (!isStream) {
      if (reply.gates?.beforeFirstToken) {
        await ctx.arriveGate(reply.gates.beforeFirstToken, signal);
      }
      if (reply.toolCalls && reply.toolCalls.length > 0 && reply.gates?.beforeToolUse) {
        await ctx.arriveGate(reply.gates.beforeToolUse, signal);
      }

      const parts: unknown[] = [];
      if (reply.thinking) {
        parts.push({ text: reply.thinking.text, thought: true });
      }
      if (reply.text !== undefined && reply.text.length > 0) {
        parts.push({ text: reply.text });
      }
      if (reply.toolCalls) {
        for (let i = 0; i < reply.toolCalls.length; i++) {
          const tc = reply.toolCalls[i];
          parts.push(buildToolCallPart(tc, tc.id ?? `gemini_call_${normalized.id}_${i + 1}`));
        }
      }

      writeJson(res, 200, {
        candidates: [
          {
            content: { role: 'model', parts },
            finishReason,
            index: 0,
          },
        ],
        usageMetadata,
        modelVersion: model,
      });

      if (reply.gates?.afterComplete) {
        await ctx.arriveGate(reply.gates.afterComplete, signal).catch(() => {});
      }
      return;
    }

    // Streaming: either ?alt=sse (SSE) or JSON array stream
    let wroteFirstJsonItem = false;
    if (isSse) {
      startSse(res);
    } else {
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-cache',
      });
      res.flushHeaders?.();
      res.write('[');
    }

    const writeFrame = (payload: Record<string, unknown>): boolean => {
      if (res.writableEnded || res.destroyed) return false;
      if (isSse) {
        return writeSseData(res, JSON.stringify(payload));
      }
      if (wroteFirstJsonItem) {
        res.write(',\n');
      }
      wroteFirstJsonItem = true;
      res.write(JSON.stringify(payload));
      return true;
    };

    const triggerFault = async (): Promise<void> => {
      const fault = reply.streamFault;
      if (!fault) return;
      if (fault.mode === 'tcp-disconnect') {
        await flushAndDestroyResponse(res);
        return;
      }
      if (fault.mode === 'sse-error') {
        const errPayload = {
          error: {
            code: 500,
            message: fault.message ?? 'Simulated Gemini stream error',
            status: 'INTERNAL',
          },
        };
        if (isSse) {
          writeSseData(res, JSON.stringify(errPayload));
        } else {
          writeFrame(errPayload);
          res.write(']');
        }
        res.end();
        return;
      }
      if (fault.mode === 'malformed-sse') {
        if (!res.writableEnded && !res.destroyed) {
          res.write(isSse ? 'data: {"candidates":[{"broken":\n\n' : '{"candidates":[{"broken":');
          res.end();
        }
      }
    };

    if (reply.gates?.beforeFirstToken) {
      await ctx.arriveGate(reply.gates.beforeFirstToken, signal);
    }

    if (reply.streamFault && reply.streamFault.afterChunks === 0) {
      await triggerFault();
      return;
    }

    let emittedChunks = 0;
    const afterChunkEmit = async (): Promise<boolean> => {
      emittedChunks++;
      if (reply.streamFault && emittedChunks === reply.streamFault.afterChunks) {
        await triggerFault();
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

    const thinkingChunks = reply.thinking ? chunkText(reply.thinking.text, reply.chunkSize) : [];
    const textChunks = reply.text !== undefined && reply.text.length > 0 ? chunkText(reply.text, reply.chunkSize) : [];
    const hasToolCalls = Boolean(reply.toolCalls && reply.toolCalls.length > 0);
    const totalContentChunks = thinkingChunks.length + textChunks.length;
    const faultOnLastContentChunk = Boolean(
      reply.streamFault && reply.streamFault.afterChunks === totalContentChunks,
    );
    let emittedFinalMetadata = false;

    // 1. Thought chunks
    for (let i = 0; i < thinkingChunks.length; i++) {
      const piece = thinkingChunks[i];
      const isFinalFrame = !hasToolCalls
        && textChunks.length === 0
        && i === thinkingChunks.length - 1
        && !faultOnLastContentChunk;
      if (!writeFrame({
        candidates: [{
          content: { role: 'model', parts: [{ text: piece, thought: true }] },
          ...(isFinalFrame ? { finishReason } : {}),
          index: 0,
        }],
        ...(isFinalFrame ? { usageMetadata } : {}),
        modelVersion: model,
      })) {
        return;
      }
      if (isFinalFrame) emittedFinalMetadata = true;
      if (!(await afterChunkEmit())) return;
    }

    // 2. Text chunks
    for (let i = 0; i < textChunks.length; i++) {
      const piece = textChunks[i];
      const isFinalFrame = !hasToolCalls
        && i === textChunks.length - 1
        && !faultOnLastContentChunk;
      if (!writeFrame({
        candidates: [{
          content: { role: 'model', parts: [{ text: piece }] },
          ...(isFinalFrame ? { finishReason } : {}),
          index: 0,
        }],
        ...(isFinalFrame ? { usageMetadata } : {}),
        modelVersion: model,
      })) {
        return;
      }
      if (isFinalFrame) emittedFinalMetadata = true;
      if (!(await afterChunkEmit())) return;
    }

    // 3. Tool calls
    if (reply.toolCalls && reply.toolCalls.length > 0) {
      if (reply.gates?.beforeToolUse) {
        await ctx.arriveGate(reply.gates.beforeToolUse, signal);
      }
      const fcParts = reply.toolCalls.map((tc, i) =>
        buildToolCallPart(tc, tc.id ?? `gemini_call_${normalized.id}_${i + 1}`),
      );
      if (!writeFrame({
        candidates: [{ content: { role: 'model', parts: fcParts }, finishReason, index: 0 }],
        usageMetadata,
        modelVersion: model,
      })) {
        return;
      }
      emittedFinalMetadata = true;
    }

    // 4. Empty-reply fallback: emit finishReason + usageMetadata without empty `content.parts: []`
    if (!emittedFinalMetadata) {
      writeFrame({
        candidates: [{ finishReason, index: 0 }],
        usageMetadata,
        modelVersion: model,
      });
    }

    if (!isSse && !res.writableEnded && !res.destroyed) {
      res.write(']');
    }

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
      writeGeminiError(res, {
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
