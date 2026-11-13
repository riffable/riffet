import { msg } from '@lingui/core/macro';
import { i18n } from '@lingui/core';
import type { OutputRate, RunMetrics } from '@contracts';

/**
 * `tok/s` for a measured turn, or undefined when there is nothing honest to divide.
 *
 * A turn that produced no output tokens, or one whose window is too short to time, has no rate.
 * Returning undefined rather than 0 keeps "we could not measure this" visually distinct from
 * "the model produced nothing", which is the same rule the context meter follows.
 */
export function tokensPerSecond(metrics: RunMetrics | undefined): number | undefined {
  if (!metrics || !Number.isFinite(metrics.durationMs) || !Number.isFinite(metrics.outputTokens)
    || !(metrics.durationMs > 0) || !(metrics.outputTokens > 0)) return undefined;
  return (metrics.outputTokens / metrics.durationMs) * 1000;
}

/** Rates below ten keep a decimal, because 0 and 0.4 are very different answers. */
export function formatTokensPerSecond(rate: number): string {
  return rate >= 10 ? String(Math.round(rate)) : rate.toFixed(1);
}

/** A known quiet window is zero; unavailable or old measurements have no live speed. */
export function outputTokensPerSecond(sample: OutputRate | undefined, connected = true): number | undefined {
  if (!connected || !sample || (sample.state !== 'live' && sample.state !== 'zero')) return undefined;
  return Number.isFinite(sample.tokensPerSecond) && sample.tokensPerSecond >= 0 ? sample.tokensPerSecond : undefined;
}

export function outputRateDescription(sample: OutputRate): string {
  const tokens = sample.tokens === 'provider' ? i18n._(msg`精确 token 数`)
    : sample.tokens === 'estimated' ? i18n._(msg`估算 token 数`)
      : sample.tokens === 'mixed' ? i18n._(msg`部分估算的 token 数`) : i18n._(msg`输出 token 数`);
  if (sample.durationMs !== undefined) {
    const window = sample.window === 'stream' ? i18n._(msg`实际生成时间，不含工具执行和等待`)
      : sample.window === 'transcript' ? i18n._(msg`模型响应时间（含首字延迟）`)
        : i18n._(msg`观测到的模型响应时间（含首字延迟）`);
    return i18n._(msg`模型输出速度 · 最近 ${sample.windowSeconds} 秒内${tokens} ÷ ${window}`);
  }
  return i18n._(msg`近期输出速度 · 最近 ${sample.windowSeconds} 秒${tokens} ÷ ${sample.windowSeconds} 秒 · 包含工具执行和等待时间`);
}
