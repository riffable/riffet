import { describe, expect, it } from 'vitest';
import { claudeNativeContext } from './context.js';

const frame = (window: unknown) => ({ session_id: 'session', context_window: window });

describe('Claude status line context', () => {
  it('publishes the window the CLI states beside the prompt side of its newest response', () => {
    expect(claudeNativeContext(frame({ context_window_size: 1_000_000, total_input_tokens: 274_244, used_percentage: 27 })))
      .toEqual({ used: 274_244, size: 1_000_000, breakdown: [] });
  });

  it('describes the newest response as an estimated breakdown, never as the measured usage', () => {
    const context = claudeNativeContext(frame({
      context_window_size: 1_000_000, total_input_tokens: 274_244,
      current_usage: { input_tokens: 4_244, cache_creation_input_tokens: 20_000, cache_read_input_tokens: 250_000, output_tokens: 1_500 },
    }));
    expect(context).toEqual({
      used: 274_244, size: 1_000_000, breakdownEstimated: true,
      breakdown: [
        { id: 'cacheRead', label: '缓存读取', tokens: 250_000 },
        { id: 'cacheWrite', label: '缓存写入', tokens: 20_000 },
        { id: 'input', label: '未缓存输入', tokens: 4_244 },
        { id: 'output', label: '输出', tokens: 1_500 },
      ],
    });
    // Zero buckets are left out, and an all-zero response keeps the meter measured-only.
    expect(claudeNativeContext(frame({ context_window_size: 200_000, total_input_tokens: 12, current_usage: { input_tokens: 12, output_tokens: 0 } })))
      .toEqual({ used: 12, size: 200_000, breakdown: [{ id: 'input', label: '未缓存输入', tokens: 12 }], breakdownEstimated: true });
    expect(claudeNativeContext(frame({ context_window_size: 200_000, total_input_tokens: 12, current_usage: {} })))
      .toEqual({ used: 12, size: 200_000, breakdown: [] });
  });

  it('clears the meter when the CLI reports an empty window again', () => {
    // A session's first frame and the one right after `/compact` both read zero with a null
    // `current_usage`; publishing it is what keeps a compacted conversation from showing the
    // occupancy it no longer has.
    expect(claudeNativeContext(frame({ context_window_size: 200_000, total_input_tokens: 0, current_usage: null })))
      .toEqual({ used: 0, size: 200_000, breakdown: [] });
  });

  it('drops a frame that states no usable window instead of guessing one', () => {
    for (const window of [
      undefined, null, {}, { total_input_tokens: 10 }, { context_window_size: 0, total_input_tokens: 10 },
      { context_window_size: 200_000 }, { context_window_size: 200_000, total_input_tokens: -1 },
      { context_window_size: '200000', total_input_tokens: 10 }, { context_window_size: 1_000_000, total_input_tokens: Number.NaN },
    ]) {
      expect(claudeNativeContext(frame(window))).toBeUndefined();
    }
    expect(claudeNativeContext({})).toBeUndefined();
    expect(claudeNativeContext(undefined)).toBeUndefined();
  });
});
