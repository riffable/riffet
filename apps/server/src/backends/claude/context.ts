/**
 * The context-window facts a Claude Code status line carries.
 *
 * Claude Code never writes the window down: the model table, the `[1m]` opt-in, account
 * entitlements, `CLAUDE_CODE_MAX_CONTEXT_TOKENS` and the auto-compact window are folded inside the
 * CLI, and the transcript keeps only what the API answered (prompt and output tokens). The single
 * machine-readable statement of the result is the JSON the CLI hands to the command configured as
 * its status line, which `statusline-cli.mjs` forwards over the hook bridge.
 *
 * `total_input_tokens` is the prompt side of the newest response
 * (`input_tokens + cache_creation_input_tokens + cache_read_input_tokens`, the sum `used_percentage`
 * divides by the window) and is what the next request has to resend, so it is a measurement rather
 * than an estimate — the same figure Cursor, Codex and DSH publish. Output tokens are excluded on
 * purpose: they are not re-sent.
 */
import type { NativeContext } from '../../../../../packages/contracts/src/index.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * The meter for one status line payload, or undefined when the CLI states no usable window.
 *
 * Claude Code sends `context_window_size` from the first frame of a session, including when it
 * resumes one, while `current_usage`, `used_percentage` and `total_input_tokens` stay null until the
 * first response and again right after `/compact`. A frame without a positive window is dropped
 * rather than guessed.
 *
 * `used` is the measurement: the prompt side of the newest response, which is what the next request
 * resends. The breakdown is the same response's own accounting (`current_usage`: uncached input,
 * cache reads, cache writes, output), which is not a composition of the window — it is the shape the
 * status line itself publishes and what the third-party context bars draw — so it is labelled
 * estimated and never added to `used`.
 */
export function claudeNativeContext(payload: unknown): NativeContext | undefined {
  const window = record(record(payload)?.context_window);
  if (!window) return undefined;
  const size = finite(window.context_window_size);
  const used = finite(window.total_input_tokens);
  if (size === undefined || size <= 0 || used === undefined || used < 0) return undefined;
  const breakdown = claudeUsageBreakdown(record(window.current_usage));
  return { used: Math.round(used), size: Math.round(size), breakdown, ...(breakdown.length ? { breakdownEstimated: true } : {}) };
}

/** The last response's token buckets, in the order a reader spends them. */
function claudeUsageBreakdown(usage: Record<string, unknown> | undefined): NativeContext['breakdown'] {
  if (!usage) return [];
  const parts: Array<[string, string, unknown]> = [
    ['cacheRead', '缓存读取', usage.cache_read_input_tokens],
    ['cacheWrite', '缓存写入', usage.cache_creation_input_tokens],
    ['input', '未缓存输入', usage.input_tokens],
    ['output', '输出', usage.output_tokens],
  ];
  return parts.flatMap(([id, label, value]) => {
    const tokens = finite(value);
    return tokens !== undefined && tokens > 0 ? [{ id, label, tokens: Math.round(tokens) }] : [];
  });
}
