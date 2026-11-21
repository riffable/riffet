import { describe, expect, it } from 'vitest';
import type { StepMetrics } from '../../../../packages/contracts/src/index.js';
import { OutputRateTracker } from './output-rate.js';

function step(overrides: Partial<StepMetrics> = {}): StepMetrics {
  const sample: StepMetrics = { stepId: 'response', outputTokens: 1_800, tokens: 'provider', startedAt: 1_000,
    endedAt: 61_000, durationMs: 60_000, window: 'stream', live: false, ...overrides };
  if (overrides.durationMs === undefined) sample.durationMs = (sample.endedAt ?? 61_000) - (sample.startedAt ?? 1_000);
  return sample;
}

describe('OutputRateTracker', () => {
  it('uses measured response time and preserves the rate while output leaves the lookback window', () => {
    const tracker = new OutputRateTracker();
    tracker.update(step(), 61_000);
    expect(tracker.sample(61_000)).toEqual({ state: 'live', windowSeconds: 180, outputTokens: 1_800, tokensPerSecond: 30,
      durationMs: 60_000, tokens: 'provider', window: 'stream' });
    // Waiting neither fabricates output nor slows the measured model response.
    expect(tracker.sample(121_000).tokensPerSecond).toBe(30);
    expect(tracker.sample(211_000)).toMatchObject({ tokensPerSecond: 30, durationMs: 30_000 });
    expect(tracker.sample(241_000)).toMatchObject({ state: 'zero', outputTokens: 0, tokensPerSecond: 0 });
    expect(tracker.sample(361_000).state).toBe('stale');
  });

  it('reports a short response immediately instead of dividing its tokens by three minutes', () => {
    const tracker = new OutputRateTracker();
    tracker.update(step({ outputTokens: 90, endedAt: 3_000 }), 3_000);
    expect(tracker.sample(3_000)).toMatchObject({ outputTokens: 90, durationMs: 2_000, tokensPerSecond: 45 });
  });

  it('keeps a fractional token live until its measured interval expires', () => {
    const tracker = new OutputRateTracker();
    tracker.update(step({ outputTokens: 100, endedAt: 3_000 }), 3_000);
    expect(tracker.sample(182_999)).toMatchObject({ state: 'live', outputTokens: 0, tokensPerSecond: 50 });
    expect(tracker.sample(183_000)).toMatchObject({ state: 'zero', tokensPerSecond: 0 });
  });

  it('uses independent response duration while keeping absolute timestamps across a tool pause', () => {
    const tracker = new OutputRateTracker();
    tracker.update(step({ outputTokens: 50, endedAt: 2_000, durationMs: 1_000, live: true }), 2_000);
    tracker.update(step({ outputTokens: 100, endedAt: 123_000, durationMs: 2_000, live: true }), 123_000);
    tracker.update(step({ outputTokens: 100, endedAt: 123_000, durationMs: 2_000 }), 123_000);
    expect(tracker.sample(123_000)).toMatchObject({ outputTokens: 100, durationMs: 2_000, tokensPerSecond: 50 });
    expect(tracker.sample(182_000)).toMatchObject({ outputTokens: 50, durationMs: 1_000, tokensPerSecond: 50 });
  });

  it('distinguishes an absent measurement from observed zero and rejects untimed/old/future/invalid data', () => {
    const tracker = new OutputRateTracker();
    tracker.update(step({ startedAt: undefined, endedAt: undefined }), 1_000_000);
    tracker.update(step(), 1_000_000);
    tracker.update(step({ startedAt: 2_000_000, endedAt: 2_001_000 }), 1_000_000);
    tracker.update(step({ outputTokens: NaN }), 61_000);
    expect(tracker.sample(1_000_000).state).toBe('no_data');
    tracker.update(step({ startedAt: 999_000, endedAt: 1_000_000, outputTokens: 0 }), 1_000_000);
    expect(tracker.sample(1_000_000)).toMatchObject({ state: 'zero', tokensPerSecond: 0 });
  });

  it('counts growing cumulative snapshots and duplicate final/replay events only once', () => {
    const tracker = new OutputRateTracker();
    tracker.update(step({ outputTokens: 900, endedAt: 31_000, live: true }), 31_000);
    tracker.update(step({ live: true }), 61_000);
    tracker.update(step(), 61_000);
    tracker.update(step(), 62_000);
    tracker.update(step({ outputTokens: 900 }), 62_000);
    tracker.update(step({ live: true, outputTokens: 900, endedAt: 31_000 }), 62_000);
    expect(tracker.sample(62_000).outputTokens).toBe(1_800);
    expect(tracker.sample(211_000).outputTokens).toBe(900);
  });

  it('keeps incremental bursts at their own times instead of spreading an entire long response uniformly', () => {
    const tracker = new OutputRateTracker();
    tracker.update(step({ outputTokens: 900, endedAt: 31_000, live: true }), 31_000);
    tracker.update(step({ outputTokens: 900, endedAt: 181_000, live: true }), 181_000);
    tracker.update(step({ endedAt: 211_000 }), 211_000);
    expect(tracker.sample(211_000).outputTokens).toBe(900);
    expect(tracker.sample(376_000).outputTokens).toBe(900);
    expect(tracker.sample(391_000).outputTokens).toBe(0);
  });

  it.each([900, 3_600, 0])('corrects a provisional estimate to provider total %i without adding another burst', total => {
    const tracker = new OutputRateTracker();
    tracker.update(step({ tokens: 'estimated', live: true }), 61_000);
    tracker.update(step({ outputTokens: total }), 90_000);
    tracker.update(step({ tokens: 'estimated', live: true }), 91_000);
    expect(tracker.sample(91_000).outputTokens).toBe(total);
    expect(tracker.sample(211_000).outputTokens).toBe(total / 2);
    if (total) expect(tracker.sample(211_000).tokens).toBe('provider');
  });

  it('applies delayed correction only to the surviving share of the output', () => {
    const tracker = new OutputRateTracker();
    tracker.update(step({ outputTokens: 900, tokens: 'estimated', endedAt: 31_000, live: true }), 31_000);
    tracker.update(step({ tokens: 'estimated', live: true }), 61_000);
    expect(tracker.sample(211_000).outputTokens).toBe(900);
    tracker.update(step({ outputTokens: 900 }), 211_000);
    expect(tracker.sample(211_000)).toMatchObject({ outputTokens: 450, tokens: 'provider' });
  });

  it('corrects a provisional duration as well as the provider token total', () => {
    const tracker = new OutputRateTracker();
    tracker.update(step({ outputTokens: 100, tokens: 'estimated', endedAt: 2_000, live: true }), 2_000);
    tracker.update(step({ outputTokens: 200, endedAt: 3_000 }), 3_000);
    expect(tracker.sample(3_000)).toMatchObject({ outputTokens: 200, durationMs: 2_000, tokensPerSecond: 100, tokens: 'provider' });
  });

  it('combines concurrent response identities and reports mixed precision', () => {
    const tracker = new OutputRateTracker();
    tracker.update(step(), 61_000);
    tracker.update(step({ stepId: 'other', tokens: 'estimated', outputTokens: 900 }), 61_000);
    expect(tracker.sample(61_000)).toMatchObject({ outputTokens: 2_700, tokensPerSecond: 22.5, tokens: 'mixed' });
  });

  it('uses a baseline when first observing a long live response, then counts its new output', () => {
    const tracker = new OutputRateTracker();
    tracker.update(step({ endedAt: 500_000, live: true }), 500_000);
    expect(tracker.sample(500_000)).toMatchObject({ state: 'no_data', outputTokens: 0 });
    tracker.update(step({ outputTokens: 1_980, endedAt: 501_000, live: true }), 501_000);
    expect(tracker.sample(501_000)).toMatchObject({ outputTokens: 180, tokensPerSecond: 180, durationMs: 1_000 });
  });

  it('retains the live baseline across a long tool call without backdating the resumed output', () => {
    const tracker = new OutputRateTracker();
    tracker.update(step({ outputTokens: 900, endedAt: 31_000, live: true }), 31_000);
    expect(tracker.sample(400_000).state).toBe('stale');
    tracker.update(step({ outputTokens: 1_080, endedAt: 400_000, durationMs: 31_000, live: true }), 400_000);
    expect(tracker.sample(400_000)).toMatchObject({ state: 'live', outputTokens: 180, tokensPerSecond: 180, durationMs: 1_000 });
    expect(tracker.sample(579_000).outputTokens).toBe(180);
    expect(tracker.sample(580_000).outputTokens).toBe(0);
  });

  it('recognizes an explicit zero total even when a live response started before the window', () => {
    const tracker = new OutputRateTracker();
    tracker.update(step({ outputTokens: 0, endedAt: 500_000, live: true }), 500_000);
    expect(tracker.sample(500_000).state).toBe('zero');
  });

  it('handles a one-instant delta and expires it at the window boundary', () => {
    const tracker = new OutputRateTracker();
    tracker.update(step({ startedAt: 61_000, endedAt: 61_000, durationMs: 1_000 }), 61_000);
    expect(tracker.sample(61_000).outputTokens).toBe(1_800);
    expect(tracker.sample(241_000).state).toBe('zero');
  });

  it('does not swallow accumulated live duration before its token delta arrives', () => {
    const tracker = new OutputRateTracker();
    tracker.update(step({ outputTokens: 500, startedAt: 1_000, endedAt: 11_000, durationMs: 10_000, live: true }), 11_000);
    // Duration advances while tokens have not yet been reported for the second request.
    tracker.update(step({ outputTokens: 500, startedAt: 1_000, endedAt: 61_000, durationMs: 60_000, live: true }), 61_000);
    // Token count for the 50s second request arrives afterwards.
    tracker.update(step({ outputTokens: 3_000, startedAt: 1_000, endedAt: 63_000, durationMs: 60_000, live: true }), 63_000);
    expect(tracker.sample(63_000)).toMatchObject({ outputTokens: 3_000, durationMs: 60_000, tokensPerSecond: 50 });
  });

  it('does not pull tool-pause wall time into durationMs when a late token delta keeps duration unchanged', () => {
    const tracker = new OutputRateTracker();
    tracker.update(step({ outputTokens: 500, startedAt: 1_000, endedAt: 11_000, durationMs: 10_000, live: true }), 11_000);
    tracker.update(step({ outputTokens: 600, startedAt: 1_000, endedAt: 131_000, durationMs: 10_000, live: true }), 131_000);
    expect(tracker.sample(131_000)).toMatchObject({ outputTokens: 600, durationMs: 10_000, tokensPerSecond: 60 });
  });

  it('records newly measured provider output after a mid-flight estimated baseline and drops sub-50ms corrupt bursts', () => {
    const tracker = new OutputRateTracker();
    tracker.update(step({ tokens: 'estimated', outputTokens: 1_000, startedAt: 1_000, endedAt: 500_000, durationMs: 20_000, live: true }), 500_000);
    tracker.update(step({ tokens: 'provider', outputTokens: 1_200, startedAt: 1_000, endedAt: 504_000, durationMs: 24_000, live: false }), 504_000);
    expect(tracker.sample(504_000)).toMatchObject({ state: 'live', outputTokens: 200, durationMs: 4_000, tokensPerSecond: 50, tokens: 'provider' });

    tracker.update(step({ stepId: 'burst', outputTokens: 500, startedAt: 504_000, endedAt: 504_002, durationMs: 2, live: false }), 504_002);
    expect(tracker.sample(504_002)).toMatchObject({ outputTokens: 200, tokensPerSecond: 50 });
  });
});
