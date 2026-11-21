package riffet.ui.focus

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.exclude
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.onConsumedWindowInsetsChanged
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.unit.constrainHeight
import androidx.compose.ui.unit.offset
import kotlin.math.roundToInt
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull
import riffet.ui.timeline.motionDuration
import riffet.ui.theme.LocalRiffetMotion
import riffet.ui.timeline.rememberReducedMotion

private const val KEYBOARD_REPORT_MS = 300L
private const val KEYBOARD_HANDOFF_MS = 1000L
private val NoInsets = WindowInsets(0, 0, 0, 0)

/**
 * Whether a window opening now over this page (a panel, a dialog) must keep from taking focus for now.
 *
 * A window that takes focus takes the keyboard over: Android puts the keyboard away on that window's
 * behalf, and the page only hears that it is gone, with no motion. The composer and the transcript then
 * drop by the keyboard's height in one frame, uncovering for that frame whatever lies behind the page.
 * So the page puts its keyboard away itself, everything that follows the keyboard here follows it down as
 * on any other close, and the window takes focus once the keyboard has gone (or after a second, for a
 * keyboard that does not go).
 *
 * Call it in the page's composition, not the new window's: only the page's window is sure to know the
 * keyboard is up.
 */
@Composable
internal fun rememberKeyboardHandoff(): State<Boolean> {
    val ime = WindowInsets.ime
    val density = LocalDensity.current
    val keyboard = LocalSoftwareKeyboardController.current
    val handingOff = remember { mutableStateOf(Snapshot.withoutReadObservation { ime.getBottom(density) > 0 }) }
    LaunchedEffect(Unit) {
        if (handingOff.value) {
            keyboard?.hide()
            withTimeoutOrNull(KEYBOARD_HANDOFF_MS) { snapshotFlow { ime.getBottom(density) }.first { it == 0 } }
            handingOff.value = false
        }
    }
    return handingOff
}

/**
 * Whether the page's keyboard was up when [open] last turned true. A popup that leaves the keyboard
 * where it is (a menu) stays unfocusable for that opening: taking focus would put the keyboard away on
 * the popup's behalf, and the page would drop by its height in one frame.
 */
@Composable
internal fun rememberKeyboardUpWhen(open: Boolean): Boolean {
    val ime = WindowInsets.ime
    val density = LocalDensity.current
    return remember(open) { open && Snapshot.withoutReadObservation { ime.getBottom(density) > 0 } }
}

/**
 * `imePadding()`, except that the keyboard's space does not shrink while a finger is down on a
 * [blurOnTap] area ([FocusCoordinator.pressing]); it eases out once the finger lifts.
 *
 * A long press that starts a selection moves focus off the composer, which closes the keyboard
 * while the finger is still on the glass. With the space released at once, a transcript scrolled to
 * its end grows under that finger by the keyboard's height, and the selection being dragged out
 * follows the text instead of the finger. Holding the space until the release keeps the text still;
 * the selection then moves with its row, handles and menu included.
 *
 * @param keyboardLeaving a panel opening over a page whose keyboard is up. That keyboard is on its
 * way out, put away by the page ([rememberKeyboardHandoff]): the panel sits at the bottom edge from its
 * first frame and the keyboard uncovers it, rather than arriving on top of the keyboard and following
 * it down. The keyboard counts again once it has gone, or once something in the panel takes focus;
 * until then it is not consumed either, so the panel's bottom safe area applies from its first frame.
 */
@OptIn(ExperimentalLayoutApi::class)
internal fun Modifier.keyboardPadding(keyboardLeaving: Boolean = false): Modifier = composed {
    val coordinator = LocalFocusCoordinator.current
    val density = LocalDensity.current
    val ime = WindowInsets.ime
    var consumed by remember { mutableStateOf(WindowInsets(0, 0, 0, 0)) }
    var leaving by remember { mutableStateOf(keyboardLeaving) }
    LaunchedEffect(ime, density) {
        if (leaving) {
            // A panel's own window hears of the keyboard a moment after it opens, if the keyboard is still there by then.
            withTimeoutOrNull(KEYBOARD_REPORT_MS) { snapshotFlow { ime.getBottom(density) }.first { it > 0 } }
            snapshotFlow { ime.getBottom(density) }.first { it == 0 }
            leaving = false
        }
    }
    // The least the bottom padding may be: the keyboard's height when the press began, then zero.
    val floor = remember { Animatable(0f) }
    val motion = LocalRiffetMotion.current
    val releaseMillis = motionDuration(rememberReducedMotion(), motion.EXIT)
    LaunchedEffect(coordinator, releaseMillis, motion) {
        snapshotFlow { coordinator.pressing }.collectLatest { pressing ->
            if (pressing) {
                floor.snapTo(ime.exclude(consumed).getBottom(density).toFloat())
            } else {
                floor.animateTo(0f, tween(releaseMillis, easing = motion.Standard))
            }
        }
    }
    onConsumedWindowInsetsChanged { consumed = it }
        .onFocusChanged { if (it.hasFocus) leaving = false }
        .layout { measurable, constraints ->
            val bottom = if (leaving) 0 else maxOf(ime.exclude(consumed).getBottom(this), floor.value.roundToInt())
            val placeable = measurable.measure(constraints.offset(vertical = -bottom))
            layout(placeable.width, constraints.constrainHeight(placeable.height + bottom)) {
                placeable.place(0, 0)
            }
        }
        .consumeWindowInsets(if (leaving) NoInsets else ime)
}
