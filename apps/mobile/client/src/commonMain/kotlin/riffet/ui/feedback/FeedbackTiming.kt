package riffet.ui.feedback

/** Minimum reading time, excluding the host's entrance and exit animations. */
fun feedbackMinimumVisibleMillis(): Double = 1500.0

/**
 * A reading budget driven by the host's monotonic clock and actual visibility. No source state is
 * delayed: hosts retain only presentation data and always derive actions from the live state.
 */
class FeedbackTiming(val minimumVisibleMillis: Double = feedbackMinimumVisibleMillis()) {
    var remainingMillis: Double = minimumVisibleMillis.coerceAtLeast(feedbackMinimumVisibleMillis())
        private set
    val complete: Boolean get() = remainingMillis <= 0.0
    private var previousMillis: Double? = null
    private var wasVisible = false

    /** Accounts for the interval before this update, then installs the next visibility state. */
    fun update(nowMillis: Double, visible: Boolean): Double {
        if (nowMillis.isFinite()) {
            previousMillis?.let { previous ->
                if (wasVisible) remainingMillis = (remainingMillis - (nowMillis - previous).coerceAtLeast(0.0)).coerceAtLeast(0.0)
            }
            previousMillis = nowMillis
        }
        wasVisible = visible
        return remainingMillis
    }

    /** A new explicit operation or a relapse receives a fresh reading budget. */
    fun restart(nowMillis: Double) {
        remainingMillis = minimumVisibleMillis.coerceAtLeast(feedbackMinimumVisibleMillis())
        previousMillis = nowMillis.takeIf { it.isFinite() }
    }
}
