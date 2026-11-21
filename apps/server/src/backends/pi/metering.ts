import type { NativeBackendHost, NativeControlMessage } from '../types.js';
import { estimateTokens } from '../../metrics/tokens.js';
import { measuredWindow, runTracker, type RunMetricsTracker } from '../../metrics/turn-metrics.js';
import { piEntryUsage, type PiEntry } from './history.js';
import { isPiPrompt } from './projection.js';

interface PiStepTiming {
  readonly step: number;
  turnId?: string;
  runId?: string;
  requestStartAt: number;
  firstDeltaAt?: number;
  lastDeltaAt?: number;
  text: string;
  messageTimestamp?: number;
  hasUnstreamed?: boolean;
}

export interface PiSettledTiming {
  startedAt: number;
  endedAt: number;
  window: 'stream' | 'observed';
}

const SETTLED_TIMING_LIMIT = 64;
const RECORDED_ENTRY_LIMIT = 2_048;

/** Tracks live and settled step durations for one Pi conversation. */
export class PiStepMetering {
  private readonly trackers = new Map<string, RunMetricsTracker>();
  private readonly open = new Map<number, PiStepTiming>();
  private readonly settled = new Map<number, PiSettledTiming>();
  /** Entry ids already recorded during this process, keyed to whether live timing was used. */
  private readonly recorded = new Map<string, 'live' | 'backfill'>();

  constructor(
    private readonly host: Pick<NativeBackendHost, 'saveRunMetrics' | 'stats'>,
    private readonly emit: (message: NativeControlMessage) => void,
  ) {}

  start(step: number, turnId: string | undefined, runId: string | undefined): void {
    this.open.set(step, { step, turnId, runId, requestStartAt: Date.now(), text: '' });
  }

  update(step: number, kind: string, delta: string | undefined, messageTimestamp: number | undefined, turnId: string | undefined, runId: string | undefined): void {
    const timing = this.open.get(step);
    if (!timing) return;
    if (messageTimestamp !== undefined) timing.messageTimestamp = messageTimestamp;
    if (kind.endsWith('_delta')) {
      if (!delta) return;
      const now = Date.now();
      timing.firstDeltaAt ??= now;
      timing.lastDeltaAt = now;
      timing.text += delta;
      this.publish(timing, turnId, runId, true, undefined, now);
    } else if (kind.startsWith('toolcall')) {
      timing.hasUnstreamed = true;
    }
  }

  finish(step: number, message: Record<string, unknown>, turnId: string | undefined, runId: string | undefined): void {
    const timing = this.open.get(step);
    if (!timing) return;
    this.open.delete(step);
    const now = Date.now();
    if (typeof message.timestamp === 'number') timing.messageTimestamp = message.timestamp;
    if (Array.isArray(message.content) && message.content.some(block => block && typeof block === 'object' && (block as Record<string, unknown>).type === 'toolCall')) {
      timing.hasUnstreamed = true;
    }
    const usage = message.usage && typeof message.usage === 'object' ? message.usage as Record<string, unknown> : undefined;
    const outputTokens = typeof usage?.output === 'number' && Number.isFinite(usage.output) && usage.output >= 0 ? usage.output : undefined;
    const range = this.windowOf(timing, outputTokens, now);
    if (range && timing.messageTimestamp !== undefined) {
      this.settled.set(timing.messageTimestamp, range);
      while (this.settled.size > SETTLED_TIMING_LIMIT) this.settled.delete(this.settled.keys().next().value!);
    }
    this.publish(timing, turnId, runId, false, outputTokens, now);
  }

  recordEntry(
    workbenchSessionId: string,
    entry: PiEntry,
    message: Record<string, unknown>,
    messageTimestamp: number,
    byId: ReadonlyMap<string, PiEntry>,
    turns: ReadonlyMap<string, { runId?: string }>,
  ): void {
    const usage = piEntryUsage(entry);
    if (!usage) return;
    const ingest: 'live' | 'backfill' = this.settled.has(messageTimestamp) ? 'live' : 'backfill';
    const prior = this.recorded.get(entry.id);
    if (prior === 'live' || (prior === 'backfill' && ingest === 'backfill')) return;
    let ancestor: PiEntry | undefined = entry;
    const seen = new Set<string>();
    while (ancestor && !isPiPrompt(ancestor) && !seen.has(ancestor.id)) {
      seen.add(ancestor.id);
      ancestor = ancestor.parentId ? byId.get(ancestor.parentId) : undefined;
    }
    const runId = ancestor ? turns.get(ancestor.id)?.runId : undefined;
    const provider = typeof message.provider === 'string' && message.provider ? message.provider : undefined;
    const model = typeof message.model === 'string' && message.model ? message.model : undefined;
    const rawUsage = message.usage && typeof message.usage === 'object' ? message.usage as Record<string, unknown> : undefined;
    const timing = this.resolveRecordTiming(entry, messageTimestamp, byId);
    this.host.stats.recordUsage(workbenchSessionId, runId, {
      stepId: `pi:${entry.id}`,
      nativeMessageId: `msg:${entry.id}`,
      ...(model ? { model: provider ? `${provider}/${model}` : model } : {}),
      ...(timing.startedAt !== undefined ? { startedAt: timing.startedAt } : {}),
      ...(timing.endedAt !== undefined ? { endedAt: timing.endedAt } : {}),
      ...(timing.durationMs !== undefined ? { durationMs: timing.durationMs } : {}),
      ...(timing.window ? { window: timing.window } : {}),
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite,
      ...(typeof rawUsage?.reasoning === 'number' ? { reasoningTokens: rawUsage.reasoning } : {}),
      tokenSource: 'provider',
    }, ingest);
    this.recorded.set(entry.id, ingest);
    while (this.recorded.size > RECORDED_ENTRY_LIMIT) this.recorded.delete(this.recorded.keys().next().value!);
  }

  resolveRecordTiming(entry: PiEntry, messageTimestamp: number, byId: ReadonlyMap<string, PiEntry>): {
    startedAt?: number;
    endedAt?: number;
    durationMs?: number;
    window?: 'stream' | 'transcript' | 'observed';
  } {
    const settled = this.settled.get(messageTimestamp);
    const entryAt = Date.parse(entry.timestamp);
    let startedAt = settled?.startedAt;
    const endedAt = settled?.endedAt ?? (Number.isFinite(entryAt) ? entryAt : undefined);
    let window: 'stream' | 'transcript' | 'observed' | undefined = settled?.window;
    if (startedAt === undefined && endedAt !== undefined) {
      const parent = entry.parentId ? byId.get(entry.parentId) : undefined;
      const parentAt = parent ? Date.parse(parent.timestamp) : Number.NaN;
      if (Number.isFinite(parentAt) && parentAt <= endedAt) {
        startedAt = parentAt;
        window = 'transcript';
      }
    }
    const durationMs = startedAt !== undefined && endedAt !== undefined && endedAt > startedAt ? endedAt - startedAt : undefined;
    return { startedAt, endedAt, durationMs, window };
  }

  clearOpen(): void {
    this.open.clear();
  }

  private windowOf(timing: PiStepTiming, outputTokens?: number, now = Date.now()): PiSettledTiming | undefined {
    if (timing.hasUnstreamed) {
      return { startedAt: timing.requestStartAt, endedAt: Math.max(now, timing.lastDeltaAt ?? now), window: 'observed' };
    }
    const tokens = outputTokens ?? (timing.text ? Math.max(1, Math.round(estimateTokens(timing.text))) : undefined);
    const range = measuredWindow({
      streamStart: timing.firstDeltaAt,
      streamEnd: timing.lastDeltaAt,
      fallbackStart: timing.requestStartAt,
      outputTokens: tokens,
      now,
    });
    return range ? { startedAt: range.startedAt, endedAt: range.endedAt, window: range.window === 'stream' ? 'stream' : 'observed' } : undefined;
  }

  private publish(timing: PiStepTiming, turnId: string | undefined, runId: string | undefined, live: boolean, outputTokens?: number, now = Date.now()): void {
    const range = this.windowOf(timing, outputTokens, now);
    if (!range) return;
    const resolvedRunId = timing.runId ?? runId;
    const turnKey = timing.turnId ?? turnId ?? `step:${timing.step}`;
    runTracker(this.trackers, resolvedRunId ?? `turn:${turnKey}`, { runId: resolvedRunId }, {
      emit: this.emit,
      save: (id, run) => this.host.saveRunMetrics(id, run),
    }).update({
      stepId: `pi:step:${timing.step}`,
      text: timing.text,
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...range,
      live,
    }, !live);
  }
}
