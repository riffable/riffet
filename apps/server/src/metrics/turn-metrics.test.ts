import { describe, expect, it, vi } from 'vitest';
import type { RunMetrics, StepMetrics } from '../../../../packages/contracts/src/index.js';
import { measuredWindow, rememberTracker, RunMetricsTracker } from './turn-metrics.js';

function recorder() {
  const steps: StepMetrics[] = [];
  const runs: RunMetrics[] = [];
  return { steps, runs, report: (step: StepMetrics, run: RunMetrics) => { steps.push(step); runs.push(run); } };
}

describe('RunMetricsTracker', () => {
  it('prefers a provider count over the text estimate and labels the source', () => {
    const { steps, report } = recorder();
    const tracker = new RunMetricsTracker(report);
    tracker.update({ stepId: 'a', outputTokens: 500, text: '短', startedAt: 0, endedAt: 2_000, window: 'stream', live: false });
    expect(steps.at(-1)).toMatchObject({ outputTokens: 500, tokens: 'provider', durationMs: 2_000, startedAt: 0, endedAt: 2_000, window: 'stream' });
  });

  it('estimates from text when the provider reports nothing', () => {
    const { steps, report } = recorder();
    const tracker = new RunMetricsTracker(report);
    tracker.update({ stepId: 'a', text: 'a'.repeat(400), startedAt: 0, endedAt: 2_000, window: 'observed', live: false });
    expect(steps.at(-1)).toMatchObject({ tokens: 'estimated', durationMs: 2_000, window: 'observed' });
    expect(steps.at(-1)!.outputTokens).toBeGreaterThan(0);
  });

  it('refuses to publish a step with no measurable output', () => {
    const { steps, report } = recorder();
    const tracker = new RunMetricsTracker(report);
    tracker.update({ stepId: 'a', text: '   ', startedAt: 0, endedAt: 2_000, window: 'observed', live: false });
    expect(steps).toHaveLength(0);
    expect(tracker.aggregate()).toBeUndefined();
  });

  it('refuses to publish a step whose window has no duration', () => {
    const { steps, report } = recorder();
    const tracker = new RunMetricsTracker(report);
    tracker.update({ stepId: 'a', outputTokens: 100, startedAt: 1_000, endedAt: 1_000, window: 'observed', live: false });
    tracker.update({ stepId: 'b', outputTokens: 100, window: 'observed', live: false });
    expect(steps).toHaveLength(0);
  });

  it('sums the turn across steps instead of reporting the newest one', () => {
    const { runs, report } = recorder();
    const tracker = new RunMetricsTracker(report);
    tracker.update({ stepId: 'a', outputTokens: 100, startedAt: 0, endedAt: 1_000, window: 'stream', live: false });
    tracker.update({ stepId: 'b', outputTokens: 300, startedAt: 1_000, endedAt: 3_000, window: 'stream', live: false });
    expect(runs.at(-1)).toEqual({ outputTokens: 400, durationMs: 3_000, tokens: 'provider', window: 'stream', steps: 2 });
  });

  it('replaces a live step rather than adding it twice', () => {
    const { runs, report } = recorder();
    const tracker = new RunMetricsTracker(report, { throttleMs: 0 });
    tracker.update({ stepId: 'a', text: 'hello', startedAt: 0, endedAt: 500, window: 'stream', live: true });
    tracker.update({ stepId: 'a', text: 'hello world', startedAt: 0, endedAt: 900, window: 'stream', live: true });
    expect(runs.at(-1)).toMatchObject({ steps: 1, durationMs: 900 });
  });

  it('reports the weakest window in the turn, not the best one', () => {
    const { runs, report } = recorder();
    const tracker = new RunMetricsTracker(report);
    tracker.update({ stepId: 'a', outputTokens: 10, startedAt: 0, endedAt: 1_000, window: 'stream', live: false });
    tracker.update({ stepId: 'b', outputTokens: 10, startedAt: 1_000, endedAt: 2_000, window: 'observed', live: false });
    expect(runs.at(-1)?.window).toBe('observed');
  });

  it('marks a turn that mixes exact and estimated counts as mixed', () => {
    const { runs, report } = recorder();
    const tracker = new RunMetricsTracker(report);
    tracker.update({ stepId: 'a', outputTokens: 10, startedAt: 0, endedAt: 1_000, window: 'stream', live: false });
    tracker.update({ stepId: 'b', text: 'estimated output here', startedAt: 1_000, endedAt: 2_000, window: 'stream', live: false });
    expect(runs.at(-1)?.tokens).toBe('mixed');
  });

  it('keeps an entirely estimated turn labelled estimated', () => {
    const { runs, report } = recorder();
    const tracker = new RunMetricsTracker(report);
    for (const stepId of ['a', 'b']) tracker.update({ stepId, text: 'estimated output', startedAt: 0, endedAt: 1_000, window: 'observed', live: false });
    expect(runs.at(-1)?.tokens).toBe('estimated');
  });

  it('retains absolute boundaries while using the sum of response windows', () => {
    const { steps, report } = recorder();
    const tracker = new RunMetricsTracker(report);
    tracker.update({ stepId: 'a', outputTokens: 100, startedAt: 0, endedAt: 122_000, durationMs: 2_000, window: 'stream', live: false });
    expect(steps.at(-1)).toMatchObject({ durationMs: 2_000, startedAt: 0, endedAt: 122_000 });
  });

  it('throttles live updates but always publishes a settled one', () => {
    let now = 0;
    const { steps, report } = recorder();
    const tracker = new RunMetricsTracker(report, { throttleMs: 500, now: () => now });
    tracker.update({ stepId: 'a', text: 'one', startedAt: 0, endedAt: 100, window: 'stream', live: true });
    expect(steps).toHaveLength(1);
    now = 100;
    tracker.update({ stepId: 'a', text: 'one two', startedAt: 0, endedAt: 200, window: 'stream', live: true });
    expect(steps).toHaveLength(1);
    tracker.update({ stepId: 'a', text: 'one two three', startedAt: 0, endedAt: 300, window: 'stream', live: false }, true);
    expect(steps).toHaveLength(2);
  });

  it('counts a growing live stream without rescanning it from the start', () => {
    const { report } = recorder();
    const tracker = new RunMetricsTracker(report, { throttleMs: 0 });
    const seen: number[] = [];
    tracker.update({ stepId: 'a', text: 'a'.repeat(1_000), startedAt: 0, endedAt: 1, window: 'stream', live: true });
    seen.push(tracker.aggregate()!.outputTokens);
    tracker.update({ stepId: 'a', text: 'a'.repeat(2_000), startedAt: 0, endedAt: 2, window: 'stream', live: true });
    seen.push(tracker.aggregate()!.outputTokens);
    // Doubling the text must roughly double the tokens; a tail-only update that lost the prefix
    // would leave the second reading far below this.
    expect(seen[1]!).toBeGreaterThan(seen[0]! * 1.8);
    expect(seen[1]!).toBeLessThan(seen[0]! * 2.2);
  });

  it('drops the memoised text once a step settles', () => {
    const { report } = recorder();
    const tracker = new RunMetricsTracker(report);
    const internals = tracker as unknown as { estimated: Map<string, unknown> };
    tracker.update({ stepId: 'a', text: 'settled output', startedAt: 0, endedAt: 500, window: 'stream', live: true });
    expect(internals.estimated.size).toBe(1);
    tracker.update({ stepId: 'a', text: 'settled output', startedAt: 0, endedAt: 500, window: 'stream', live: false }, true);
    expect(internals.estimated.size).toBe(0);
  });
});

describe('measuredWindow', () => {
  it('measures the stream itself when there is a real span', () => {
    expect(measuredWindow({ streamStart: 1_000, streamEnd: 4_500, fallbackStart: 0 })).toEqual({
      startedAt: 1_000, endedAt: 4_500, window: 'stream',
    });
  });

  it('falls back to the step start when a single chunk leaves no span', () => {
    expect(measuredWindow({ streamStart: 1_000, streamEnd: 1_000, fallbackStart: 400, now: 9_000 })).toEqual({
      startedAt: 400, endedAt: 9_000, window: 'observed',
    });
  });

  it('falls back when the provider streamed nothing at all', () => {
    expect(measuredWindow({ fallbackStart: 400, now: 9_000 })).toMatchObject({ window: 'observed' });
  });

  it('reports nothing when there is no start to measure from', () => {
    expect(measuredWindow({})).toBeUndefined();
    expect(measuredWindow({ streamStart: 1_000, streamEnd: 2_000 })).toMatchObject({ window: 'stream' });
    expect(measuredWindow({ streamStart: 1_000, streamEnd: 2_000, fallbackStart: 500 })).toMatchObject({ startedAt: 1_000 });
  });
});

describe('rememberTracker', () => {
  it('drops the oldest entries so a long session is bounded', () => {
    const map = new Map<number, number>();
    for (let index = 0; index < 100; index += 1) rememberTracker(map, index, index);
    expect(map.size).toBe(64);
    expect(map.has(99)).toBe(true);
    expect(map.has(0)).toBe(false);
  });

  it('returns the value it stored', () => {
    const map = new Map<string, number>();
    expect(rememberTracker(map, 'a', 1)).toBe(1);
  });
});

describe('timers', () => {
  it('does not schedule work of its own', () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const tracker = new RunMetricsTracker(() => undefined);
    tracker.update({ stepId: 'a', outputTokens: 1, startedAt: 0, endedAt: 1, window: 'stream', live: false });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
