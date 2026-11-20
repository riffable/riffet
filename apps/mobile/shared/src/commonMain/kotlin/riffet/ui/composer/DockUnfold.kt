package riffet.ui.composer

import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import kotlin.math.roundToInt
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.keyboardUnfoldSpan
import riffet.ui.theme.LocalRiffetMotion

/**
 * How long a focused dock waits for a soft keyboard before it opens on its own (a hardware or floating
 * keyboard). Longer once this process has seen one: a keyboard that is slow to start is then the
 * likelier reason for the wait.
 */
private const val KEYBOARD_WAIT_MS = 250L
private const val KNOWN_KEYBOARD_WAIT_MS = 600L
private var softKeyboardSeen = false

/**
 * How far a session dock's tools are open, 0 to 1, for the layout phase.
 *
 * Tapping the field starts the keyboard, and the dock has one motion to make with it: the tools open
 * over the first stretch of the keyboard's rise (`keyboardUnfoldSpan`, where the card also widens
 * past the folded tab bar), and from there the card only travels. Putting the keyboard away folds an
 * empty dock on the same stretch on the way down. On a clock of its own the opening was a second
 * curve under the keyboard's, and each of its frames laid the page out again.
 *
 * With no keyboard to follow, the dock moves on its own spring: a draft that keeps the tools open
 * while nothing is focused, a hardware keyboard, a floating one that takes no room.
 *
 * @param foldable nothing but focus keeps the tools open: an empty draft in a dock that may fold.
 */
@Composable
internal fun rememberDockUnfold(foldable: Boolean, focused: Boolean): () -> Float {
    val motion = LocalRiffetMotion.current
    val density = LocalDensity.current
    val ime = WindowInsets.ime
    val bars = WindowInsets.navigationBars
    val span = with(density) { LocalInterfaceStyle.current.metrics.keyboardUnfoldSpan.toPx() }
    val own = remember { Animatable(if (foldable) 0f else 1f) }
    // The keyboard on screen came up for this field, so its position is the dock's.
    var following by remember { mutableStateOf(false) }
    LaunchedEffect(ime, density) {
        snapshotFlow { ime.getBottom(density) > 0 }.collect { open -> if (open) softKeyboardSeen = true else following = false }
    }
    LaunchedEffect(foldable, focused) {
        val up = ime.getBottom(density) > 0
        when {
            !foldable -> own.animateTo(1f, motion.spatial())
            !focused -> {
                // Left with the keyboard still up, the fold goes down with it; with none, on the spring.
                if (!up) following = false
                own.animateTo(0f, motion.spatial())
            }
            // Emptied while typing: the keyboard holds the tools open from here.
            up && following -> own.snapTo(0f)
            // Focus came from another field with the keyboard already up: nothing to ride.
            up -> {
                own.animateTo(1f, motion.spatial())
                following = true
                own.snapTo(0f)
            }
            else -> {
                following = true
                val wait = if (softKeyboardSeen) KNOWN_KEYBOARD_WAIT_MS else KEYBOARD_WAIT_MS
                val arrived = withTimeoutOrNull(wait) { snapshotFlow { ime.getBottom(density) }.first { it > 0 } }
                if (arrived == null) {
                    own.animateTo(1f, motion.spatial())
                    // A keyboard that turns up after all takes the dock over once it holds the tools open by itself.
                    snapshotFlow { ime.getBottom(density) - bars.getBottom(density) >= span }.first { it }
                    own.snapTo(0f)
                }
            }
        }
    }
    return remember(own, ime, bars, density, span) {
        {
            val rise = if (following && span > 0f) (ime.getBottom(density) - bars.getBottom(density)) / span else 0f
            maxOf(own.value, rise).coerceIn(0f, 1f)
        }
    }
}

/**
 * Shows the top [fraction] of the content, which is composed and measured at its full size
 * underneath, so opening it composes nothing. [fraction] is read while laying out only. Folded, the
 * content is not placed: not drawn, not hit, not read out.
 */
internal fun Modifier.unfolded(fraction: () -> Float): Modifier = clipToBounds().layout { measurable, constraints ->
    val placeable = measurable.measure(constraints)
    val shown = fraction().coerceIn(0f, 1f)
    layout(placeable.width, (placeable.height * shown).roundToInt()) {
        // The tools arrive once there is room for them, not squeezed through the first sliver.
        if (shown > 0f) placeable.placeWithLayer(0, 0) { alpha = ((shown - 0.3f) / 0.7f).coerceIn(0f, 1f) }
    }
}
