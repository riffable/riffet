package riffet.core

import riffet.contracts.MetricsWindow
import riffet.contracts.OutputRate
import riffet.contracts.OutputRateState
import riffet.contracts.RunMetrics
import riffet.contracts.RunMetricsTokenSource

/**
 * ============================================================================================
 * SECOND IMPLEMENTATION OF THE WEB SPEED MODEL
 * ============================================================================================
 *
 * Ported from apps/web/src/app/session/speed.ts. Change both together (docs/MOBILE.md,
 * "时间线的第二实现").
 *
 * Missing and stale measurements have no speed. A rolling window with known observations but
 * no output shows zero; completed turns keep their own average over generation time.
 */

private const val MAX_PLAUSIBLE_TOKENS_PER_SECOND = 1_000.0

/**
 * `tok/s` for a measured turn, or null when there is nothing honest to divide.
 *
 * A turn that produced no output tokens, or one whose window is too short to time, has no rate.
 */
fun tokensPerSecond(metrics: RunMetrics?): Double? {
    if (metrics == null || !(metrics.durationMs > 0) || !(metrics.outputTokens > 0)) return null
    val rate = (metrics.outputTokens.toDouble() / metrics.durationMs.toDouble()) * 1000.0
    return rate.takeIf { it.isFinite() && it <= MAX_PLAUSIBLE_TOKENS_PER_SECOND }
}

/** Rates below ten keep a decimal, because 0 and 0.4 are very different answers. */
fun formatTokensPerSecond(rate: Double): String =
    if (rate >= 10) kotlin.math.round(rate).toLong().toString() else decimalOne(rate)

private fun decimalOne(value: Double): String {
    val scaled = kotlin.math.round(value * 10.0).toLong()
    val whole = scaled / 10
    val fraction = kotlin.math.abs(scaled % 10)
    return "$whole.$fraction"
}

/**
 * What the number actually covers, so nobody reads an estimate as a measurement or a bracketed
 * response time as pure decode speed.
 */
fun speedDescription(metrics: RunMetrics): String {
    val tokens = when (metrics.tokens) {
        RunMetricsTokenSource.PROVIDER -> UiText.text("core.speed.tokens.provider")
        RunMetricsTokenSource.ESTIMATED -> UiText.text("core.speed.tokens.estimated")
        RunMetricsTokenSource.MIXED, RunMetricsTokenSource.UNKNOWN -> UiText.text("core.speed.tokens.mixed")
    }
    val window = when (metrics.window) {
        MetricsWindow.STREAM -> UiText.text("core.speed.window.stream")
        MetricsWindow.TRANSCRIPT -> UiText.text("core.speed.window.transcript")
        MetricsWindow.OBSERVED, MetricsWindow.UNKNOWN -> UiText.text("core.speed.window.observed")
    }
    val steps = if (metrics.steps == 1L) {
        UiText.text("core.speed.steps.one")
    } else {
        UiText.text("core.speed.steps.other", metrics.steps)
    }
    return UiText.text("core.speed.description", tokens, window, steps)
}

/** A known quiet window is zero; unavailable or old measurements have no live speed. */
fun outputTokensPerSecond(sample: OutputRate?): Double? {
    if (sample == null || (sample.state != OutputRateState.LIVE && sample.state != OutputRateState.ZERO)) return null
    return sample.tokensPerSecond.takeIf { it.isFinite() && it >= 0 && it <= MAX_PLAUSIBLE_TOKENS_PER_SECOND }
}

fun outputRateDescription(sample: OutputRate): String {
    val tokens = when (sample.tokens) {
        RunMetricsTokenSource.PROVIDER -> UiText.text("core.speed.tokens.provider")
        RunMetricsTokenSource.ESTIMATED -> UiText.text("core.speed.tokens.estimated")
        RunMetricsTokenSource.MIXED -> UiText.text("core.speed.tokens.mixed")
        RunMetricsTokenSource.UNKNOWN, null -> UiText.text("core.speed.tokens.output")
    }
    val seconds = if (sample.windowSeconds % 1.0 == 0.0) sample.windowSeconds.toLong().toString() else sample.windowSeconds.toString()
    if (sample.durationMs != null) {
        val window = when (sample.window) {
            MetricsWindow.STREAM -> UiText.text("core.speed.generation.stream")
            MetricsWindow.TRANSCRIPT -> UiText.text("core.speed.generation.transcript")
            else -> UiText.text("core.speed.generation.observed")
        }
        return UiText.text("core.speed.modelDescription", seconds, tokens, window)
    }
    return UiText.text("core.speed.recentDescription", seconds, tokens)
}
