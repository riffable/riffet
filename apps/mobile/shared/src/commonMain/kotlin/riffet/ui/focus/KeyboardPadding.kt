package riffet.ui.focus

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.exclude
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.onConsumedWindowInsetsChanged
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.constrainHeight
import androidx.compose.ui.unit.offset
import kotlin.math.roundToInt
import kotlinx.coroutines.flow.collectLatest
import riffet.ui.timeline.motionDuration
import riffet.ui.theme.LocalRiffetMotion
import riffet.ui.timeline.rememberReducedMotion

/**
 * `imePadding()`, except that the keyboard's space does not shrink while a finger is down on a
 * [blurOnTap] area ([FocusCoordinator.pressing]); it eases out once the finger lifts.
 *
 * A long press that starts a selection moves focus off the composer, which closes the keyboard
 * while the finger is still on the glass. With the space released at once, a transcript scrolled to
 * its end grows under that finger by the keyboard's height, and the selection being dragged out
 * follows the text instead of the finger. Holding the space until the release keeps the text still;
 * the selection then moves with its row, handles and menu included.
 */
@OptIn(ExperimentalLayoutApi::class)
internal fun Modifier.keyboardPadding(): Modifier = composed {
    val coordinator = LocalFocusCoordinator.current
    val density = LocalDensity.current
    val ime = WindowInsets.ime
    var consumed by remember { mutableStateOf(WindowInsets(0, 0, 0, 0)) }
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
        .layout { measurable, constraints ->
            val bottom = maxOf(ime.exclude(consumed).getBottom(this), floor.value.roundToInt())
            val placeable = measurable.measure(constraints.offset(vertical = -bottom))
            layout(placeable.width, constraints.constrainHeight(placeable.height + bottom)) {
                placeable.place(0, 0)
            }
        }
        .consumeWindowInsets(ime)
}
