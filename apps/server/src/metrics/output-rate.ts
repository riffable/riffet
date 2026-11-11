import type { MetricsTokenSource, MetricsWindow, OutputRate, StepMetrics } from '../../../../packages/contracts/src/index.js';

/** Look back three minutes for output samples, without counting quiet time as generation. */
const WINDOW_MS = 180_000;
const STALE_MS = 300_000;
const CLOCK_SKEW_MS = 5_000;
// Tool execution can pause an unfinished response much longer than the output window.
const LIVE_BASELINE_TTL_MS = 24 * 60 * 60_000;
const MAX_STEPS = 1_024;

interface Segment { start: number; end: number; tokens: number; durationMs: number }
interface StepSample {
  total: number;
  end: number;
  source: MetricsTokenSource;
  durationMs: number;
  window: MetricsWindow;
  settled: boolean;
  segments: Segment[];
}

/**
 * One session's recent output, independent of Riffet run ids (a turn can start in the CLI).
 *
 * Cumulative message counts become deltas and intervals are clipped proportionally to the
 * rolling window. The denominator is the corresponding share of measured response time.
 * Absolute provider timestamps keep history replay out of the present. Unlike an append-only
 * counter, a final provider total can also correct a provisional text estimate downwards.
 */
export class OutputRateTracker {
  private readonly steps = new Map<string, StepSample>();
  private lastSignal?: number;

  update(step: StepMetrics, now = Date.now()): void {
    this.prune(now);
    const { startedAt: start, endedAt: end, outputTokens: total } = step;
    if (start === undefined || end === undefined || !Number.isFinite(start) || !Number.isFinite(end)
      || end < start || end > now + CLOCK_SKEW_MS || !Number.isFinite(total) || total < 0
      || !Number.isFinite(step.durationMs) || step.durationMs <= 0 || end <= now - STALE_MS) return;
    const previous = this.steps.get(step.stepId);
    // A delayed live event must never undo a settled/provider measurement or move time backwards.
    if (previous && (end < previous.end || (previous.settled && step.live)
      || (previous.source === 'provider' && ((previous.settled && step.tokens === 'estimated') || total < previous.total)))) return;

    if (!previous) {
      // A long-running stream first observed mid-flight has no usable delta baseline. Its next
      // update will measure new output; attributing its entire count to the present would spike.
      const baselineOnly = step.live && total > 0 && start < now - WINDOW_MS;
      this.steps.set(step.stepId, {
        total, end, source: step.tokens, durationMs: step.durationMs, window: step.window, settled: !step.live,
        segments: baselineOnly || total === 0 ? [] : [{ start, end, tokens: total, durationMs: step.durationMs }],
      });
      if (!baselineOnly) this.lastSignal = Math.max(this.lastSignal ?? -Infinity, Math.min(end, now));
      return;
    }

    const correction = (previous.source === 'estimated' && step.tokens === 'provider') || total < previous.total;
    if (correction && previous.total > 0) {
      // Preserve when the output happened: a usage notice arriving after a tool call is not a
      // new burst of tokens. Scaling retained intervals also corrects only their remaining share
      // when part of the response has already left the window.
      const factor = total / previous.total;
      for (const segment of previous.segments) segment.tokens *= factor;
    } else if (total > previous.total) {
      // Live deltas have their own observed timestamp. Do not spread a newly received chunk
      // backwards over a silent tool call. Transcript-only cumulative updates have no chunk
      // boundary, so their delta retains the interval between the two records, as in Kaboo.
      const deltaStart = step.live || !previous.settled ? end : previous.end;
      const addedDuration = previous.total === 0 ? step.durationMs : Math.max(0, step.durationMs - previous.durationMs);
      previous.segments.push({ start: deltaStart, end, tokens: total - previous.total,
        durationMs: addedDuration > 0 ? addedDuration : Math.max(0, end - previous.end) });
    }
    // A finalized window can replace a wider provisional one. Correct its retained share without
    // moving any sample in time or assigning time from an expired baseline to a new delta.
    if (step.durationMs !== previous.durationMs && ((correction && previous.total > 0)
      || step.durationMs < previous.durationMs || (!step.live && total <= previous.total))) {
      const factor = step.durationMs / previous.durationMs;
      for (const segment of previous.segments) segment.durationMs *= factor;
    }
    if (total !== previous.total || correction || !step.live || step.durationMs < previous.durationMs) {
      previous.durationMs = step.durationMs;
    }
    previous.total = total;
    previous.end = end;
    previous.source = step.tokens;
    previous.window = step.window;
    previous.settled = !step.live;
    this.lastSignal = Math.max(this.lastSignal ?? -Infinity, Math.min(end, now));
  }

  sample(now = Date.now()): OutputRate {
    this.prune(now);
    let count = 0;
    let durationMs = 0;
    let source: OutputRate['tokens'];
    let window: MetricsWindow | undefined;
    const cutoff = now - WINDOW_MS;
    for (const step of this.steps.values()) {
      let contribution = 0;
      let measuredMs = 0;
      for (const segment of step.segments) {
        if (segment.end === segment.start) {
          if (segment.end > cutoff && segment.end <= now) {
            contribution += segment.tokens;
            measuredMs += segment.durationMs;
          }
          continue;
        }
        const overlap = Math.max(0, Math.min(now, segment.end) - Math.max(cutoff, segment.start));
        const fraction = overlap / (segment.end - segment.start);
        contribution += segment.tokens * fraction;
        measuredMs += segment.durationMs * fraction;
      }
      if (contribution <= 0) continue;
      count += contribution;
      durationMs += measuredMs;
      source = source === undefined ? step.source : source === step.source ? source : 'mixed';
      window = window === 'observed' || step.window === 'observed' ? 'observed'
        : window === 'transcript' || step.window === 'transcript' ? 'transcript' : 'stream';
    }
    const outputTokens = Math.max(0, Math.round(count));
    const state = this.lastSignal === undefined ? 'no_data'
      : now - this.lastSignal >= STALE_MS ? 'stale'
        : count > 0 ? durationMs > 0 ? 'live' : 'no_data' : 'zero';
    return {
      state, windowSeconds: WINDOW_MS / 1_000, outputTokens,
      tokensPerSecond: durationMs > 0 ? count / durationMs * 1_000 : 0,
      durationMs,
      ...(window ? { window } : {}),
      ...(source ? { tokens: source } : {}),
    };
  }

  private prune(now: number): void {
    for (const [id, step] of this.steps) {
      if (step.end <= now - (step.settled ? STALE_MS : LIVE_BASELINE_TTL_MS)) this.steps.delete(id);
      else step.segments = step.segments.filter(segment => segment.end > now - WINDOW_MS);
    }
    while (this.steps.size > MAX_STEPS) this.steps.delete(this.steps.keys().next().value!);
  }
}
