import type { NativeStreamMessage } from '../../../../../packages/contracts/src/index.js';
import { estimateTokens } from '../../metrics/tokens.js';
import { measuredWindow, runTracker, type RunMetricsTracker } from '../../metrics/turn-metrics.js';
import type { NativeBackendHost } from '../types.js';
import type { CodexTurnMeter, RpcItem } from './types.js';
import { asArray, finiteToken, str } from './util.js';

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
      text: '', durationMs: 0, activeWaits: new Set(), streamedItems: new Set(), completedItems: new Set(),
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
  noteCompletedOutput(turnId: string, item: RpcItem): void {
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
      // since `requestStartAt` rather than only during a short trailing AgentMessage delta.
      if (item.type === 'reasoning' && !meter.requestAccounted) {
        const start = meter.requestStartAt ?? at;
        const request = meter.request ??= { start };
        request.unstreamedStartAt ??= request.start ?? start;
        request.completedAt = at;
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
    // A tool/approval can finish a request that generated only tool-call arguments. It has no text
    // deltas, but its provider tokens must still have an observed generation interval.
    if (observeRequest && !meter.request && !meter.requestAccounted && !meter.pendingUsageInterval
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
    const addedUnstreamed = !textAdvanced
      ? Math.max(0, outputTokens - previousOutputTokens)
      : (!streamedReasoning && reasoningTokens !== undefined && reasoningTokens > previousReasoningTokens
        ? reasoningTokens - previousReasoningTokens
        : 0);
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
      if (!meter.request && !meter.waiting && outputTokens > 0) {
        meter.request = { start: meter.requestStartAt ?? Date.now(), completedAt: Date.now() };
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
