import type { NativeContext, NativeStreamMessage } from '../../../../../packages/contracts/src/index.js';
import { estimateTokens } from '../../metrics/tokens.js';
import { isPlausibleSpeed, measuredWindow, runTracker, type RunMetricsTracker } from '../../metrics/turn-metrics.js';
import type { NativeBackendHost, NativeControlMessage } from '../types.js';
import type { CodexTurnMeter, RpcItem } from './types.js';
import { isCodexToolItem, codexNativeContext } from './transcript.js';
import { parseRolloutContext } from './rollout-usage.js';
import { CONTEXT_TAIL_BYTES, CONTEXT_WINDOW_RETRY_MS } from './runtime-limits.js';
import type { CodexAppServerClient } from '../shared/codex-app-server.js';
import { asArray, asRecord, finiteToken, readFileTail, str, titleCase } from './util.js';

/** What the metering reads from the runtime it measures. */
export interface CodexMeteringContext {
  readonly sessionId: string;
  readonly host: Pick<NativeBackendHost, 'saveRunMetrics' | 'findRunIdByNativeMessage' | 'stats'>;
  /** The run a turn was submitted for, and when, once known. */
  turnRun(turnId: string): { runId?: string; createdAt?: string } | undefined;
  /** The provider id of the turn's user message, when the transcript already shows it. */
  userMessageId(turnId: string): string | undefined;
  /** The model the thread currently reports. */
  model(): string | undefined;
  emit(message: NativeStreamMessage): void;
}

/**
 * Output speed and settled usage of a Codex thread's turns. Each turn is observed from its stream
 * (deltas, completed items, tool and approval waits, usage notices) until it settles, when its final
 * numbers are published once and recorded for statistics.
 */
export class CodexTurnMetering {
  /** One speed tracker per run, plus the per-turn stream observation it is fed from. */
  private readonly trackers = new Map<string, RunMetricsTracker>();
  private readonly meters = new Map<string, CodexTurnMeter>();
  private readonly settled = new Set<string>();

  constructor(private readonly context: CodexMeteringContext) {}

  /** The turn's meter while it is being measured. */
  active(turnId: string): CodexTurnMeter | undefined { return this.meters.get(turnId); }

  /** Whether the turn's final numbers were already published. */
  isSettled(turnId: string): boolean { return this.settled.has(turnId); }

  /** The speed tracker for a turn's run, created on first use. */
  private metricsFor(turnId: string, runId: string | undefined): RunMetricsTracker {
    return runTracker(this.trackers, runId ?? `turn:${turnId}`, { runId, nativeMessageId: () => this.meters.get(turnId)?.nativeMessageId }, {
      emit: message => this.context.emit(message), save: (id, run) => this.context.host.saveRunMetrics(id, run),
    });
  }

  meterFor(turnId: string): CodexTurnMeter {
    const existing = this.meters.get(turnId);
    if (existing) return existing;
    const nativeMessageId = this.context.userMessageId(turnId);
    const runId = this.context.turnRun(turnId)?.runId
      ?? (nativeMessageId ? this.context.host.findRunIdByNativeMessage?.(this.context.sessionId, nativeMessageId) : undefined);
    const model = this.context.model();
    const meter: CodexTurnMeter = {
      text: '', durationMs: 0, activeWaits: new Set(), knownWaits: new Set(), streamedItems: new Set(), completedItems: new Set(),
      requestStartAt: this.turnMeterStart(turnId),
      nativeMessageId,
      ...(runId ? { runId } : {}),
      ...(model ? { model } : {}),
    };
    this.meters.set(turnId, meter);
    return meter;
  }

  /**
   * Fold one streamed delta into the turn's estimate. Raw reasoning and its summary describe the
   * same tokens, so whichever channel a turn uses first wins and the other is ignored; counting
   * both would roughly double a reasoning-heavy turn's rate.
   */
  noteStreamDelta(turnId: string | undefined, delta: unknown, method: string, itemId?: string): void {
    if (!turnId || this.settled.has(turnId) || typeof delta !== 'string' || !delta) return;
    const meter = this.meterFor(turnId);
    const reasoning = method !== 'item/agentMessage/delta';
    if (reasoning) {
      const channel = method === 'item/reasoning/summaryTextDelta' ? 'summary' : 'raw';
      if (meter.reasoningChannel && meter.reasoningChannel !== channel) return;
      meter.reasoningChannel = channel;
    }
    const itemType = reasoning ? 'reasoning' : 'agentMessage';
    meter.streamedItems.add(itemId ?? itemType);
    const at = Date.now();
    const request = meter.request ??= { start: meter.requestStartAt ?? at };
    (request.streamedTypes ??= new Set()).add(itemType);
    meter.activeWaits.clear();
    meter.waiting = false;
    meter.requestAccounted = false;
    meter.pendingUsageInterval = false;
    meter.text += delta;
    request.firstDeltaAt ??= at;
    request.lastDeltaAt = at;
    this.publishTurnMetrics(turnId, meter, true);
  }

  /** A provider can deliver a completed item without sending any text delta. */
  noteCompletedOutput(turnId: string, item: RpcItem, timing?: { startedAtMs?: number; completedAtMs?: number }): void {
    if (this.settled.has(turnId) || (item.type !== 'agentMessage' && item.type !== 'reasoning')) return;
    const meter = this.meterFor(turnId);
    const key = item.id ?? item.type;
    if (meter.streamedItems.has(key) || meter.request?.streamedTypes?.has(item.type) || meter.completedItems.has(key)) return;
    meter.completedItems.add(key);
    let text = item.type === 'agentMessage' ? str(item.text) ?? '' : '';
    if (item.type === 'reasoning') {
      const summary = asArray<unknown>(item.summary).map(value => str(value) ?? '').filter(Boolean).join('\n\n');
      const raw = asArray<unknown>(item.content).map(value => str(value) ?? '').filter(Boolean).join('\n\n');
      const channel = meter.reasoningChannel ?? (summary ? 'summary' : 'raw');
      meter.reasoningChannel = channel;
      text = channel === 'summary' ? summary : raw;
    }
    const at = Date.now();
    if (!text) {
      // Encrypted reasoning items carry no text, but still prove the request has been generating
      // since `requestStartAt` (or the item's own timestamps) rather than only during a short trailing delta.
      if (item.type === 'reasoning' && !meter.requestAccounted) {
        const hasSpan = timing?.startedAtMs !== undefined && timing?.completedAtMs !== undefined && timing.completedAtMs > timing.startedAtMs;
        const spanEnd = hasSpan ? timing!.completedAtMs! : at;
        const start = hasSpan ? timing!.startedAtMs! : (meter.requestStartAt ?? spanEnd);
        const request = meter.request ??= { start };
        const unstreamedStart = hasSpan ? timing!.startedAtMs! : (request.start ?? start);
        request.unstreamedStartAt = request.unstreamedStartAt !== undefined
          ? Math.min(request.unstreamedStartAt, unstreamedStart)
          : unstreamedStart;
        request.completedAt = Math.max(request.completedAt ?? spanEnd, spanEnd);
        meter.pendingUsageInterval = false;
      }
      return;
    }
    meter.text += text;
    if (!meter.requestAccounted) {
      const request = meter.request ??= { start: meter.requestStartAt ?? at };
      meter.pendingUsageInterval = false;
      request.completedAt = at;
    }
    this.publishTurnMetrics(turnId, meter, true, true);
  }

  private meterRequestWindow(meter: CodexTurnMeter, at = Date.now(), closing = false) {
    const request = meter.request;
    if (!request) return undefined;
    if (request.completedAt !== undefined) {
      // Some items stream reasoning but deliver the answer only when complete, or generate
      // encrypted reasoning before streaming a brief answer. Both span observed output time.
      const startedAt = request.unstreamedStartAt !== undefined
        ? Math.min(request.unstreamedStartAt, request.firstDeltaAt ?? request.unstreamedStartAt)
        : (request.firstDeltaAt ?? request.start);
      if (startedAt === undefined) return undefined;
      return { startedAt, endedAt: Math.max(request.completedAt, request.lastDeltaAt ?? request.completedAt), window: 'observed' as const };
    }
    if (!closing && request.firstDeltaAt !== undefined && request.lastDeltaAt === request.firstDeltaAt) {
      return undefined;
    }
    const end = request.completedAt ?? request.lastDeltaAt;
    return measuredWindow({
      streamStart: request.firstDeltaAt, streamEnd: request.lastDeltaAt,
      fallbackStart: request.start,
      now: end !== undefined && request.start !== undefined && end > request.start ? end : at,
    });
  }

  /** Only protocol boundaries split a response; a long pause between chunks may be a slow model. */
  closeMeterRequest(meter: CodexTurnMeter, observeRequest = false, at = Date.now()): void {
    // A tool/approval can finish a request that generated tool-call arguments after a brief text
    // or reasoning delta, or generated only tool-call arguments with no deltas at all.
    if (observeRequest && meter.request) {
      const knownEnd = Math.max(meter.request.lastDeltaAt ?? -Infinity, meter.request.completedAt ?? -Infinity);
      if (at > knownEnd) {
        meter.request.unstreamedStartAt ??= meter.request.start;
        meter.request.completedAt = at;
      }
    } else if (observeRequest && !meter.request && !meter.requestAccounted && !meter.pendingUsageInterval
      && meter.requestStartAt !== undefined && at > meter.requestStartAt) {
      meter.request = { start: meter.requestStartAt, completedAt: at };
    }
    const range = this.meterRequestWindow(meter, at, true);
    if (range) {
      meter.durationMs += Math.max(0, range.endedAt - range.startedAt);
      meter.startedAt = Math.min(meter.startedAt ?? range.startedAt, range.startedAt);
      meter.endedAt = Math.max(meter.endedAt ?? range.endedAt, range.endedAt);
      meter.observed ||= range.window === 'observed';
      if (observeRequest) meter.pendingUsageInterval = true;
    }
    meter.request = undefined;
    meter.requestStartAt = meter.waiting ? undefined : Date.now();
  }

  noteTurnUsage(turnId: string | undefined, usage: Record<string, unknown>): void {
    if (!turnId || this.settled.has(turnId)) return;
    const outputTokens = finiteToken(usage.outputTokens);
    if (outputTokens === undefined) return;
    const reasoningTokens = finiteToken(usage.reasoningOutputTokens);
    // Codex counts cached input inside `inputTokens`. The ledger's input is the miss, so the
    // cached portion is subtracted here and kept on its own as a cache read. No cache-write field
    // exists on this notice, and a missing one stays missing rather than becoming zero.
    const rawInput = finiteToken(usage.inputTokens);
    const cached = finiteToken(usage.cachedInputTokens);
    // TRAE CLI reports cache writes separately from `inputTokens`; Codex never sends the field.
    const cacheWrite = finiteToken(usage.cacheCreationInputTokens);
    const meter = this.meterFor(turnId);
    const previousOutputTokens = meter.usage?.outputTokens ?? 0;
    const previousReasoningTokens = meter.usage?.reasoningTokens ?? 0;
    const advanced = !meter.usage || outputTokens > previousOutputTokens;
    const textAdvanced = meter.text.length > (meter.accountedTextLength ?? 0);
    const streamedReasoning = meter.request?.streamedTypes?.has('reasoning') === true;
    const stepOutput = Math.max(0, outputTokens - previousOutputTokens);
    const addedReasoning = reasoningTokens !== undefined ? Math.max(0, reasoningTokens - previousReasoningTokens) : 0;
    const addedTextTokens = textAdvanced ? Math.max(0, Math.round(estimateTokens(meter.text.slice(meter.accountedTextLength ?? 0)))) : 0;
    const addedUnstreamed = !textAdvanced
      ? stepOutput
      : Math.max(!streamedReasoning ? addedReasoning : 0, stepOutput - addedTextTokens);
    if (addedUnstreamed > 0) {
      meter.unstreamedTokens = (meter.unstreamedTokens ?? 0) + addedUnstreamed;
    }
    const reportedModel = typeof usage.model === 'string' ? usage.model.trim() : '';
    if (reportedModel) meter.model = reportedModel;
    meter.usage = {
      outputTokens,
      ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
      ...(rawInput === undefined ? {} : { inputTokens: Math.max(0, rawInput - (cached ?? 0)) }),
      ...(cached === undefined ? {} : { cacheReadTokens: cached }),
      ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
    };
    if (!advanced) return;
    const hadPendingInterval = meter.pendingUsageInterval === true && !meter.request;
    meter.pendingUsageInterval = false;
    // This notification accounts for a completed provider request, not for an entire turn.
    // With no deltas it is still a measurable, explicitly observed request interval.
    if (!hadPendingInterval) {
      const now = Date.now();
      if (meter.request) {
        const streamSpan = meter.request.firstDeltaAt !== undefined && meter.request.lastDeltaAt !== undefined
          ? meter.request.lastDeltaAt - meter.request.firstDeltaAt
          : 0;
        const hasUnstreamedReasoning = !streamedReasoning && addedReasoning > 0;
        const implausibleStream = streamSpan > 0 && stepOutput > 0 && !isPlausibleSpeed(stepOutput, streamSpan);
        if ((hasUnstreamedReasoning || implausibleStream) && meter.request.start !== undefined) {
          meter.request.unstreamedStartAt ??= meter.request.start;
          meter.request.completedAt = Math.max(meter.request.completedAt ?? now, now);
        }
      } else if (!meter.waiting && outputTokens > 0) {
        meter.request = { start: meter.requestStartAt ?? now, completedAt: now };
      }
      this.closeMeterRequest(meter);
    } else {
      meter.requestStartAt = meter.waiting ? undefined : Date.now();
    }
    meter.requestAccounted = true;
    meter.accountedTextLength = meter.text.length;
    this.publishTurnMetrics(turnId, meter, true, true);
  }

  private publishTurnMetrics(turnId: string, meter: CodexTurnMeter, live: boolean, force = !live): void {
    const runId = meter.runId ?? this.context.turnRun(turnId)?.runId;
    meter.runId = runId;
    const current = this.meterRequestWindow(meter);
    const startedAt = Math.min(meter.startedAt ?? current?.startedAt ?? Infinity, current?.startedAt ?? Infinity);
    const endedAt = Math.max(meter.endedAt ?? current?.endedAt ?? -Infinity, current?.endedAt ?? -Infinity);
    if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return;
    // Wall-clock endpoints remain real for rolling-window clipping; only the denominator omits
    // completed tool/approval pauses between the provider requests.
    const range = { startedAt, endedAt,
      window: meter.observed || current?.window === 'observed' ? 'observed' as const : 'stream' as const,
      durationMs: meter.durationMs + (current ? Math.max(0, current.endedAt - current.startedAt) : 0),
    };
    // Mid-turn the provider has counted only the requests that finished, while the window already
    // reaches the text still streaming, so its count would read low until the turn settles; only
    // requests that produced no text at all (encrypted reasoning or tool calls) use their count live.
    const usage = live ? undefined : meter.usage;
    const unstreamed = live && (meter.unstreamedTokens ?? 0) > 0 && meter.durationMs > 0
      ? meter.unstreamedTokens! + Math.max(0, Math.round(estimateTokens(meter.text)))
      : undefined;
    this.metricsFor(turnId, runId).update({
      stepId: `turn:${turnId}`,
      text: meter.text,
      ...(usage
        ? { outputTokens: usage.outputTokens }
        : unstreamed !== undefined
          ? { outputTokens: unstreamed, tokens: 'estimated' as const }
          : {}),
      ...(usage?.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
      ...range,
      live,
    }, force);
    if (!live) this.recordSettledTurn(turnId, meter, runId, range);
  }

  /**
   * One settled Codex turn. `stepId` is `turn:<turn id>`, the app-server turn id carried by
   * `turn/started`, `thread/tokenUsage/updated`, and each turn in a rollout, so a later disk
   * backfill can rebuild the same id without this process.
   */
  private recordSettledTurn(turnId: string, meter: CodexTurnMeter, runId: string | undefined, range: { startedAt: number; endedAt: number; durationMs: number; window: 'stream' | 'transcript' | 'observed' }): void {
    const provider = meter.usage !== undefined;
    const outputTokens = provider ? meter.usage!.outputTokens : Math.max(0, Math.round(estimateTokens(meter.text)));
    if (!provider && !meter.text.trim()) return;
    const model = meter.model ?? this.context.model();
    try {
      this.context.host.stats?.recordUsage(this.context.sessionId, runId, {
        stepId: `turn:${turnId}`,
        ...(model ? { model } : {}),
        startedAt: range.startedAt,
        endedAt: range.endedAt,
        durationMs: range.durationMs,
        ...(meter.nativeMessageId ? { nativeMessageId: meter.nativeMessageId } : {}),
        window: range.window,
        tokenSource: provider ? 'provider' : 'estimated',
        outputTokens,
        ...(meter.usage?.inputTokens === undefined ? {} : { inputTokens: meter.usage.inputTokens }),
        ...(meter.usage?.cacheReadTokens === undefined ? {} : { cacheReadTokens: meter.usage.cacheReadTokens }),
        ...(meter.usage?.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: meter.usage.cacheWriteTokens }),
        ...(meter.usage?.reasoningTokens === undefined ? {} : { reasoningTokens: meter.usage.reasoningTokens }),
      });
    } catch { /* statistics must never affect the stream */ }
  }

  private turnMeterStart(turnId: string): number | undefined {
    const createdAt = this.context.turnRun(turnId)?.createdAt;
    const at = createdAt ? Date.parse(createdAt) : Number.NaN;
    return Number.isFinite(at) ? at : undefined;
  }


  /** Publish a turn's final speed once, then stop tracking it. */
  settleTurnMetrics(turnId: string): void {
    const meter = this.meters.get(turnId);
    if (!meter) return;
    this.closeMeterRequest(meter);
    this.publishTurnMetrics(turnId, meter, false);
    this.meters.delete(turnId);
    this.settled.add(turnId);
    if (this.settled.size > 64) this.settled.delete(this.settled.values().next().value!);
  }
}

export const CONTEXT_KIND_LABELS: Record<string, string> = {
  systemPrompt: 'System prompt', toolDefinitions: 'Tools', developerMessages: 'Instructions',
  userMessages: 'Your messages', assistantMessages: 'Replies', toolResponses: 'Tool results', otherMessages: 'Other',
};
/** The counters of a `thread/tokenUsage/updated` breakdown. */
export const USAGE_FIELDS = ['inputTokens', 'cachedInputTokens', 'cacheCreationInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'];

/**
 * One turn's usage in the shape of Codex's own breakdown. `last` is a single model request and
 * `total` the thread's running sum, so a turn of several requests is how far `total` has moved
 * since just before its first request. `usageBaselines` remembers that starting point per turn.
 */
export function turnUsageOf(
  usageBaselines: Map<string, Record<string, number>>,
  turnId: string | undefined,
  tokenUsage: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const last = asRecord(tokenUsage?.last);
  const total = asRecord(tokenUsage?.total);
  if (!turnId || !total) return last;
  const count = (record: Record<string, unknown> | undefined, field: string) => typeof record?.[field] === 'number' && Number.isFinite(record[field]) ? record[field] as number : 0;
  let baseline = usageBaselines.get(turnId);
  if (!baseline) {
    baseline = Object.fromEntries(USAGE_FIELDS.map(field => [field, count(total, field) - count(last, field)]));
    usageBaselines.set(turnId, baseline);
    if (usageBaselines.size > 64) usageBaselines.delete(usageBaselines.keys().next().value!);
  }
  const turn: Record<string, unknown> = { ...total };
  for (const field of USAGE_FIELDS) if (typeof total[field] === 'number') turn[field] = count(total, field) - baseline[field]!;
  return turn;
}

/** The meter's numbers with the provider's breakdown laid over them. */
export function contextWithBreakdown(next: NativeContext, contextBreakdown: NativeContext['breakdown'] | undefined): NativeContext {
  return contextBreakdown?.length
    ? { ...next, breakdown: contextBreakdown }
    : next;
}

/** Whether a new meter reading says nothing the shown one does not. */
export function sameContext(current: NativeContext | undefined, merged: NativeContext): boolean {
  return Boolean(current && current.used === merged.used && current.size === merged.size
    && Boolean(current.breakdownEstimated) === Boolean(merged.breakdownEstimated)
    && JSON.stringify(current.breakdown) === JSON.stringify(merged.breakdown));
}

/** The categories of a `thread/contextUsage` response, labelled for the meter's popover. */
export function contextBreakdownOf(response: { contextWindowUsage?: unknown }): NonNullable<NativeContext['breakdown']> {
  return asArray<Record<string, unknown>>(asRecord(response.contextWindowUsage)?.categories).flatMap(category => {
    const id = str(category.kind);
    const tokens = finiteToken(category.tokens);
    return id && tokens !== undefined && tokens > 0 ? [{ id, label: CONTEXT_KIND_LABELS[id] ?? titleCase(id), tokens }] : [];
  });
}

/** Tool calls and all subagent activities pause parent generation even when only `started` projects as a timeline row. */
function isCodexWaitItem(item: RpcItem): boolean {
  return isCodexToolItem(item) || item.type === 'subAgentActivity';
}

/** What an item's start or completion does to its turn's wait accounting. */
export function noteItemMeter(
  metering: CodexTurnMetering,
  method: string,
  item: RpcItem,
  turnId: string,
  timing?: { startedAtMs?: number; completedAtMs?: number },
): void {
  if (isCodexWaitItem(item) && !metering.isSettled(turnId)) {
    const meter = metering.meterFor(turnId);
    const waitKey = `tool:${item.id ?? item.type}`;
    if (method === 'item/started') {
      meter.activeWaits.add(waitKey);
      meter.knownWaits.add(waitKey);
      meter.waiting = true;
      metering.closeMeterRequest(meter, true, timing?.startedAtMs ?? Date.now());
      meter.requestStartAt = undefined;
    } else {
      const hadWait = meter.activeWaits.delete(waitKey);
      const wasKnown = meter.knownWaits.delete(waitKey);
      const now = Date.now();
      if (!hadWait && !wasKnown && !meter.waiting) {
        if (item.type === 'subAgentActivity') {
          // A subagent notification can arrive minutes after the parent request that spawned it,
          // without an earlier `item/started`. Close any already-captured request at its own end
          // rather than attributing the entire subagent wait to parent generation.
          const hadOpenRequest = Boolean(meter.request) || !meter.requestAccounted;
          if (meter.request) metering.closeMeterRequest(meter, false, now);
          if (hadOpenRequest) meter.pendingUsageInterval = true;
        } else {
          const toolDuration = typeof item.durationMs === 'number' && Number.isFinite(item.durationMs) && item.durationMs > 0 ? item.durationMs : 0;
          const itemStart = timing?.startedAtMs !== undefined && timing?.completedAtMs !== undefined && timing.completedAtMs > timing.startedAtMs
            ? timing.startedAtMs
            : (toolDuration > 0 ? now - toolDuration : now);
          metering.closeMeterRequest(meter, true, Math.max(meter.requestStartAt ?? 0, itemStart));
        }
      }
      meter.waiting = meter.activeWaits.size > 0;
      if (!meter.waiting) {
        meter.requestStartAt = now;
        meter.requestAccounted = false;
      }
    }
  } else if ((item.type === 'reasoning' || item.type === 'agentMessage') && !metering.isSettled(turnId)) {
    const meter = metering.meterFor(turnId);
    meter.activeWaits.clear();
    meter.waiting = false;
    meter.requestStartAt ??= Date.now();
    meter.requestAccounted = false;
    meter.pendingUsageInterval = false;
  }
}

/** A server request opens a wait on its turn's meter. */
export function noteRequestWaitStart(metering: CodexTurnMetering, turnId: string, requestId: string): void {
  const meter = metering.meterFor(turnId);
  meter.activeWaits.add(`req:${requestId}`);
  meter.waiting = true;
  metering.closeMeterRequest(meter, true);
  meter.requestStartAt = undefined;
}

/** A settled server request closes its wait; the turn's clock restarts once nothing else is awaited. */
export function noteRequestWaitEnd(meter: CodexTurnMeter, requestId: string): void {
  meter.activeWaits.delete(`req:${requestId}`);
  meter.waiting = meter.activeWaits.size > 0;
  if (!meter.waiting) {
    meter.requestStartAt = Date.now();
    meter.requestAccounted = false;
  }
}

/** What the context meter reads from the runtime it measures. */
export interface CodexContextMeterContext {
  /** Whether the provider can state its own per-category split of the window. */
  readonly contextUsage: boolean;
  /** Tell whoever is watching. */
  emit(message: NativeControlMessage): void;
  threadId(): string | undefined;
  transport(): CodexAppServerClient | undefined;
  bindingScopeMismatch(): boolean;
  rolloutFile(threadId: string): Promise<string | undefined>;
  /** The meter's occupancy moved. */
  contextUsed(used: number): void;
}

/** The context-window meter of one Codex thread and each turn's usage baseline. */
export class CodexContextMeter {
  /** Each turn's running totals from just before its first model request. */
  private readonly usageBaselines = new Map<string, Record<string, number>>();
  /**
   * Context-window occupancy the meter draws, or undefined while the provider has reported none.
   * `contextWindow` is the model's window, from a live frame or the rollout; `contextWindowLookupAt`
   * throttles the rollout lookup a provider that never states a window would otherwise repeat.
   */
  context: NativeContext | undefined;
  /** The provider's last per-category split of the window, kept while occupancy matches. */
  contextBreakdown: NativeContext['breakdown'] | undefined;
  /** Occupancy when `contextBreakdown` was captured; a live move invalidates the settled split. */
  private contextBreakdownForUsed: number | undefined;
  private contextWindow: number | undefined;
  private contextWindowLookupAt = 0;

  constructor(private readonly host: CodexContextMeterContext) {}

  /** A different thread is a different window: the old numbers must not be repainted under it. */
  reset(): void {
    this.context = undefined;
    this.contextBreakdown = undefined;
    this.contextBreakdownForUsed = undefined;
    this.contextWindow = undefined;
    this.contextWindowLookupAt = 0;
  }

  /**
   * One turn's usage in the shape of Codex's own breakdown. `last` is a single model request and
   * `total` the thread's running sum, so a turn of several requests is how far `total` has moved
   * since just before its first request.
   */
  turnUsage(turnId: string | undefined, tokenUsage: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    return turnUsageOf(this.usageBaselines, turnId, tokenUsage);
  }

  /**
   * Remember the meter's numbers and tell whoever is watching, but only when they moved: the
   * provider sends this frame per model request, and a repaint per request on an unchanged window
   * is churn the browser does not need.
   */
  noteContext(next: NativeContext | undefined): void {
    if (!next) return;
    if (this.contextBreakdown && this.contextBreakdownForUsed === undefined) {
      this.contextBreakdownForUsed = next.used;
    }
    const merged = contextWithBreakdown(next, this.contextBreakdown);
    const current = this.context;
    if (sameContext(current, merged)) return;
    this.context = merged;
    this.host.contextUsed(merged.used);
    this.host.emit({ type: 'context', context: merged });
  }

  /**
   * Learn the model's window from the thread's rollout, once, and keep it.
   *
   * The app-server's `ThreadTokenUsage` is `{ total, last, modelContextWindow }`, but
   * `modelContextWindow` is optional and is null for a provider whose model catalog does not say —
   * and a resumed thread reports no usage at all until its next turn. The rollout has both the
   * window and the last request's occupancy, so it is read for whichever of the two the live frames
   * cannot supply. Only the tail is read, and the lookup is throttled: a provider that never states
   * a window must not turn every snapshot into a megabyte of file reads.
   */
  async seedContextWindow(): Promise<void> {
    if (this.contextWindow !== undefined || this.host.bindingScopeMismatch()) return;
    const now = Date.now();
    if (now - this.contextWindowLookupAt < CONTEXT_WINDOW_RETRY_MS) return;
    this.contextWindowLookupAt = now;
    const threadId = this.host.threadId();
    if (!threadId) return;
    try {
      const file = await this.host.rolloutFile(threadId);
      if (!file) return;
      const parsed = parseRolloutContext(await readFileTail(file, CONTEXT_TAIL_BYTES));
      if (!parsed) return;
      this.contextWindow = parsed.size;
      this.noteContext({ used: parsed.used, size: parsed.size, breakdown: parsed.breakdown ?? [] });
    } catch {
      // A rollout that vanished, shrank, or is half-written is not an error: the meter stays absent
      // (the browser already renders a composer without it) and a later turn tries again.
    }
  }

  /**
   * The meter's numbers for one `thread/tokenUsage/updated` frame.
   *
   * The frame leads: it is per model request, so its `last` is the freshest occupancy there is. The
   * window is taken from the frame when the provider states one and from the rollout otherwise, and
   * the rollout is consulted exactly when the frame could not supply it.
   */
  async applyUsageFrame(tokenUsage: Record<string, unknown> | undefined, params: Record<string, unknown>): Promise<void> {
    const immediate = codexNativeContext(tokenUsage, params, this.contextWindow);
    if (immediate) {
      this.invalidateStaleBreakdown(immediate.used);
      this.noteContext(immediate);
      return;
    }
    await this.seedContextWindow();
    const merged = codexNativeContext(tokenUsage, params, this.contextWindow);
    if (merged) {
      this.invalidateStaleBreakdown(merged.used);
      this.noteContext(merged);
    }
  }

  private invalidateStaleBreakdown(used: number): void {
    if (this.contextBreakdown && this.contextBreakdownForUsed !== undefined && used !== this.contextBreakdownForUsed) {
      this.contextBreakdown = undefined;
      this.contextBreakdownForUsed = undefined;
    }
  }

  /** The provider's own context breakdown, for the meter's popover. Only read when a turn settles. */
  async refreshContextBreakdown(): Promise<void> {
    if (!this.host.contextUsage || !this.host.threadId() || !this.host.transport()?.isOnline) return;
    try {
      const response = await this.host.transport()!.request<{ contextWindowUsage?: unknown }>('thread/contextUsage', { threadId: this.host.threadId() }, 10_000);
      const breakdown = contextBreakdownOf(response);
      if (!breakdown.length) return;
      this.contextBreakdown = breakdown;
      this.contextBreakdownForUsed = this.context?.used;
      if (this.context) this.noteContext({ ...this.context, breakdown });
    } catch { /* the meter keeps its single bar */ }
  }
}
