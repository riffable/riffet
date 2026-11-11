package riffet.ui.composer

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.foundation.layout.Box
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.boundsInWindow
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay
import riffet.ui.theme.visualWorkActive
import riffet.ui.feedback.FeedbackTiming
import kotlin.math.ceil
import kotlin.time.TimeSource

internal data class FeedbackValue<T>(val key: String, val value: T)
internal data class VisibleFeedback<T>(val key: String, val value: T, val current: Boolean, val onPresented: (Boolean) -> Unit)

private val feedbackEpoch = TimeSource.Monotonic.markNow()
internal fun feedbackNowMillis(): Double = feedbackEpoch.elapsedNow().inWholeNanoseconds / 1_000_000.0

private class FeedbackEntry<T>(val key: String, var value: T) {
    val clock = FeedbackTiming()
    var current = true
    var presented = false
}

/** Only presentation data is retained; callers derive actions from the live value. */
@Composable
internal fun <T> rememberFeedback(
    scope: Any?,
    values: List<FeedbackValue<T>>,
    visible: Boolean = true,
): List<VisibleFeedback<T>> {
    val active = visualWorkActive(visible)
    val entries = remember(scope) { mutableListOf<FeedbackEntry<T>>() }
    var shown by remember(scope) { mutableStateOf(emptyList<VisibleFeedback<T>>()) }
    var presentationVersion by remember(scope) { mutableStateOf(0) }
    LaunchedEffect(scope, values, active, presentationVersion) {
        val now = feedbackNowMillis()
        val source = values.associateBy { it.key }
        entries.forEach { entry ->
            entry.clock.update(now, false)
            val live = source[entry.key]
            if (live != null) {
                if (!entry.current) entry.clock.restart(now)
                entry.value = live.value
            }
            entry.current = live != null
        }
        values.forEach { value ->
            if (entries.none { it.key == value.key }) entries += FeedbackEntry(value.key, value.value)
        }
        fun publish() {
            entries.removeAll { !it.current && it.clock.complete }
            shown = entries.map { entry ->
                VisibleFeedback(entry.key, entry.value, entry.current) { presented ->
                    if (entry.presented != presented) {
                        entry.clock.update(feedbackNowMillis(), active && presented)
                        entry.presented = presented
                        presentationVersion += 1
                    }
                }
            }
        }
        publish()
        if (!active) return@LaunchedEffect
        try {
            while (true) {
                val tick = feedbackNowMillis()
                entries.forEach { it.clock.update(tick, it.presented) }
                publish()
                val next = entries.filter { !it.current && it.presented }.minOfOrNull { it.clock.remainingMillis }
                if (next == null) awaitCancellation()
                delay(ceil(next).toLong().coerceAtLeast(1L))
            }
        } finally {
            val stopped = feedbackNowMillis()
            entries.forEach { it.clock.update(stopped, false) }
        }
    }
    // Source removals disable operations in the same composition, before the effect reconciles.
    val live = values.mapTo(mutableSetOf()) { it.key }
    return shown.map { it.copy(current = it.key in live) }
}

/** Read time begins only after the region has entered and this complete item is laid out. */
@Composable
internal fun <T> FeedbackVisible(entry: VisibleFeedback<T>, entered: Boolean, content: @Composable () -> Unit) {
    var laidOut by remember(entry.key) { mutableStateOf(false) }
    SideEffect { entry.onPresented(entered && laidOut) }
    DisposableEffect(entry.key) { onDispose { entry.onPresented(false) } }
    Box(Modifier.onGloballyPositioned { coordinates ->
        val bounds = coordinates.boundsInWindow()
        laidOut = coordinates.isAttached && coordinates.size.height > 0 && coordinates.size.width > 0 &&
            bounds.height + 1f >= coordinates.size.height && bounds.width + 1f >= coordinates.size.width
    }) { content() }
}
