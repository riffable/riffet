package riffet.ui.haptics

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.hapticfeedback.HapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback

/*
 * ============================================================================================
 * Read-only text that does not buzz on every selection change
 * ============================================================================================
 *
 * Compose's own selection machinery ticks on *every* selection change, not once per long press:
 * `androidx.compose.foundation.text.selection.SelectionManager` (the one behind `SelectionContainer`)
 * calls `HapticFeedback.performHapticFeedback(HapticFeedbackType.TextHandleMove)` in three places -
 * when the long press creates a selection, when a handle moves, and when a tap elsewhere clears it.
 * On a phone that reads as a buzz when the reader selects a line and a second buzz when they dismiss
 * the floating toolbar, which is not a signal about anything: the selection is already visible.
 *
 * `LocalHapticFeedback` is the one seam that can change this - `SelectionContainer` reads it for its
 * haptics (`SelectionContainerKt` -> `getLocalHapticFeedback`). The filter here drops that single
 * event type and forwards every other one, so dropping the selection ticks cannot silently take
 * `LongPress` (a `combinedClickable` row, say) with it.
 *
 * Deliberately *not* installed app-wide: the composer's text field uses the same type for cursor and
 * handle movement while editing, and that is a different interaction from reading a transcript.
 */

/** Drops Compose's `TextHandleMove` haptic inside [content], forwarding every other type. */
@Composable
internal fun WithoutSelectionHaptics(content: @Composable () -> Unit) {
    val system = LocalHapticFeedback.current
    val quiet = remember(system) {
        object : HapticFeedback {
            override fun performHapticFeedback(hapticFeedbackType: HapticFeedbackType) {
                if (hapticFeedbackType == HapticFeedbackType.TextHandleMove) return
                system.performHapticFeedback(hapticFeedbackType)
            }
        }
    }
    CompositionLocalProvider(LocalHapticFeedback provides quiet, content = content)
}
