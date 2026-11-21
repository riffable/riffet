import type { MetricsTokenSource, MetricsWindow, NativeStreamMessage, RunMetrics, StepMetrics } from '@riffet/contracts';
import { estimateTokens } from './tokens.js';

/** One assistant response as the measuring backend sees it. */
export interface StepMeasurement {
  /** Backend-scoped identity of one provider request. Re-using it replaces an earlier measurement. */
  stepId: string;
  /** Provider-reported tokens, when the provider reports them. Wins over `text`. */
  outputTokens?: number;
  /** Visible model output, used only when `outputTokens` is absent. */
  text?: string;
  /** Provider-reported reasoning tokens, when the provider separates them. */
  reasoningTokens?: number;
  /** Start of the measured window. Absent for a step whose start the backend cannot observe. */
  startedAt?: number;
  /** End of the measured window, or "now" while the step is still streaming. */
  endedAt?: number;
  /** Sum of measured response windows when the absolute interval also contains tool pauses. */
  durationMs?: number;
  /** Explicit token precision when `outputTokens` combines provider usage with a live estimate. */
  tokens?: MetricsTokenSource;
  window: MetricsWindow;
  /** False once the response has settled. A live step keeps being replaced. */
  live: boolean;
}

/**
 * Ordering used to aggregate a turn: a turn containing one bracketed step is only as precise as
 * that step, so the aggregate reports the weakest window it contains rather than the best one.
 */
const WINDOW_RANK: Record<MetricsWindow, number> = { stream: 0, transcript: 1, observed: 2 };

function mergeWindow(left: MetricsWindow, right: MetricsWindow): MetricsWindow {
  return WINDOW_RANK[left] >= WINDOW_RANK[right] ? left : right;
}

function mergeSource(left: MetricsTokenSource | 'mixed', right: MetricsTokenSource): MetricsTokenSource | 'mixed' {
  return left === right ? left : 'mixed';
}

/**
 * Collects the assistant steps of one turn and reports the turn-to-date aggregate.
 *
 * Every backend funnels into this, so the arithmetic, the rounding and the "which window is this
 * turn really measured over" decision live in one place instead of drifting between four drivers.
 * Live updates are throttled because a streamed response produces a chunk every few milliseconds
 * and each one would otherwise become its own server-sent event.
 */
export class RunMetricsTracker {
  private readonly steps = new Map<string, StepMetrics>();
  /** Last estimated text per step, so a growing live stream is only re-estimated from its tail. */
  private readonly estimated = new Map<string, { text: string; tokens: number }>();
  private lastEmitAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly report: (step: StepMetrics, run: RunMetrics) => void,
    private readonly options: { throttleMs?: number; now?: () => number } = {},
  ) {}

  /** Add or replace one step's measurement, publishing the aggregate when the throttle allows. */
  update(measurement: StepMeasurement, force = false): void {
    const step = this.measure(measurement);
    if (!step) return;
    this.steps.set(step.stepId, step);
    if (force || !step.live) this.publish(step);
    else this.publishThrottled(step);
  }

  /** The turn so far, or undefined when no step produced a measurable number. */
  aggregate(): RunMetrics | undefined {
    if (!this.steps.size) return undefined;
    let outputTokens = 0;
    let durationMs = 0;
    let tokens: MetricsTokenSource | 'mixed' | undefined;
    let window: MetricsWindow = 'stream';
    for (const step of this.steps.values()) {
      outputTokens += step.outputTokens;
      durationMs += step.durationMs;
      tokens = tokens === undefined ? step.tokens : mergeSource(tokens, step.tokens);
      window = mergeWindow(window, step.window);
    }
    return { outputTokens, durationMs, tokens: tokens!, window, steps: this.steps.size };
  }

  /**
   * Turn a raw measurement into printable numbers. Returns undefined when nothing measurable
   * happened: a step with neither a provider count nor visible output would otherwise contribute
   * duration and no tokens, which reads as a slow model rather than as an unmeasured one.
   */
  private measure(measurement: StepMeasurement): StepMetrics | undefined {
    const text = measurement.text ?? '';
    const hasProviderCount = typeof measurement.outputTokens === 'number' && Number.isFinite(measurement.outputTokens) && measurement.outputTokens >= 0;
    const tokens = hasProviderCount ? measurement.outputTokens! : this.estimateStep(measurement.stepId, text);
    const outputTokens = Math.max(0, Math.round(tokens));
    if (!hasProviderCount && (!text.trim() || outputTokens <= 0)) return undefined;
    const startedAt = measurement.startedAt;
    const endedAt = measurement.endedAt ?? this.now();
    const durationMs = measurement.durationMs ?? (startedAt === undefined ? 0 : Math.max(0, endedAt - startedAt));
    // A window with no measurable duration cannot support a rate. Keep the tokens so a later
    // measurement of the same step can still use them, but do not publish a divide-by-zero.
    if (!Number.isFinite(durationMs) || durationMs <= 0) return undefined;
    // A settled step never needs its text again; only the count is reused. Dropping it here keeps
    // a long session from retaining every answer it ever measured, twice.
    if (!measurement.live) this.estimated.delete(measurement.stepId);
    return {
      stepId: measurement.stepId,
      outputTokens,
      tokens: measurement.tokens ?? (hasProviderCount ? 'provider' : 'estimated'),
      durationMs,
      startedAt,
      endedAt,
      window: measurement.window,
      live: measurement.live,
      ...(hasProviderCount && typeof measurement.reasoningTokens === 'number' ? { reasoningTokens: Math.round(measurement.reasoningTokens) } : {}),
    };
  }

  /**
   * Estimate a step's tokens, reusing the previous count when the text only grew. A live stream
   * re-measures on every chunk, so re-scanning the whole response each time would make one long
   * answer quadratic in its own length for no extra accuracy.
   */
  private estimateStep(stepId: string, text: string): number {
    const previous = this.estimated.get(stepId);
    if (previous && text.startsWith(previous.text)) {
      const tokens = previous.tokens + estimateTokens(text.slice(previous.text.length));
      this.estimated.set(stepId, { text, tokens });
      return tokens;
    }
    const tokens = estimateTokens(text);
    this.estimated.set(stepId, { text, tokens });
    return tokens;
  }

  private publish(step: StepMetrics): void {
    const run = this.aggregate();
    if (!run) return;
    this.lastEmitAt = this.now();
    this.report(step, run);
  }

  private publishThrottled(step: StepMetrics): void {
    if (this.now() - this.lastEmitAt < (this.options.throttleMs ?? 500)) return;
    this.publish(step);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

/** Upper bound on plausible single-step generation rate; higher readings indicate batched or unstreamed bursts. */
export const MAX_PLAUSIBLE_TOKENS_PER_SECOND = 1_000;

export function isPlausibleSpeed(outputTokens: number, durationMs: number): boolean {
  return Number.isFinite(outputTokens) && Number.isFinite(durationMs)
    && outputTokens > 0 && durationMs > 0
    && (outputTokens / durationMs) * 1_000 <= MAX_PLAUSIBLE_TOKENS_PER_SECOND;
}

/**
 * What a step's milliseconds actually bracket.
 *
 * A real span between the first and last streamed chunk is the honest measurement, and it is the
 * only one that excludes the provider's time-to-first-token. An answer delivered as a single chunk
 * has no span at all, a batched burst whose span implies an impossible decode rate does not bracket
 * the real generation time, and a provider that streams nothing has none either; all fall back to
 * the step's own start and are reported over the wider `observed` window rather than not at all.
 * Returning undefined — and so reporting nothing — is reserved for a step with no start to use.
 */
export function measuredWindow(options: {
  streamStart?: number;
  streamEnd?: number;
  fallbackStart?: number;
  now?: number;
  outputTokens?: number;
  minSpanMs?: number;
}): { startedAt: number; endedAt: number; window: MetricsWindow } | undefined {
  const { streamStart, streamEnd, fallbackStart, outputTokens, minSpanMs } = options;
  const end = options.now ?? Date.now();
  if (streamStart !== undefined && streamEnd !== undefined && streamEnd > streamStart) {
    const spanMs = streamEnd - streamStart;
    const tooShort = minSpanMs !== undefined && spanMs < minSpanMs;
    const implausible = outputTokens !== undefined && outputTokens > 0 && !isPlausibleSpeed(outputTokens, spanMs);
    if ((!tooShort && !implausible) || fallbackStart === undefined) {
      return { startedAt: streamStart, endedAt: streamEnd, window: 'stream' };
    }
    return { startedAt: fallbackStart, endedAt: Math.max(end, streamEnd), window: 'observed' };
  }
  if (fallbackStart === undefined) return undefined;
  return { startedAt: fallbackStart, endedAt: end, window: 'observed' };
}

/**
 * How many finished turns a long-lived session keeps speed trackers for. Old entries are dropped
 * oldest-first: a turn that scrolled off the transcript will never be re-measured, and its final
 * numbers already live on the run.
 */
const TRACKER_LIMIT = 64;

export function rememberTracker<K, V>(map: Map<K, V>, key: K, value: V): V {
  map.set(key, value);
  while (map.size > TRACKER_LIMIT) map.delete(map.keys().next().value!);
  return value;
}

/**
 * The speed tracker kept in `trackers` under `key`, created on first use. Each update reaches the
 * stream as a `metrics` message for `runId`, naming the user message `nativeMessageId()` gives at
 * that moment, and a known run also stores it so a reload finds the number already there.
 */
export function runTracker(
  trackers: Map<string, RunMetricsTracker>,
  key: string,
  target: { runId?: string; nativeMessageId?: () => string | undefined },
  sink: { emit(message: Extract<NativeStreamMessage, { type: 'metrics' }>): void; save(runId: string, metrics: RunMetrics): void },
): RunMetricsTracker {
  const existing = trackers.get(key);
  if (existing) return existing;
  const { runId } = target;
  const tracker = new RunMetricsTracker((step, run) => {
    const nativeMessageId = target.nativeMessageId?.();
    sink.emit({ type: 'metrics', metrics: step, run, ...(runId ? { runId } : {}), ...(nativeMessageId ? { nativeMessageId } : {}) });
    if (runId) sink.save(runId, run);
  });
  return rememberTracker(trackers, key, tracker);
}
