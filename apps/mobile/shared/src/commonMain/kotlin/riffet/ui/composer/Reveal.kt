package riffet.ui.composer

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.clearAndSetSemantics
import riffet.ui.theme.LocalRiffetMotion

/**
 * A block that opens in place while [value] is non-null and closes when it goes null, instead of
 * mounting and unmounting in one frame. The last non-null value is kept for the closing animation,
 * so the block shrinks with its content rather than emptying first. While it closes it is inert:
 * it swallows touches and is hidden from accessibility, since its values and callbacks are stale.
 */
@Composable
internal fun <T : Any> Reveal(value: T?, modifier: Modifier = Modifier, onEnteredChanged: ((Boolean) -> Unit)? = null, content: @Composable (T) -> Unit) {
    val motion = LocalRiffetMotion.current
    val last = remember { arrayOfNulls<Any>(1) }
    if (value != null) last[0] = value
    val closing = value == null
    val transition = remember { MutableTransitionState(!closing) }
    transition.targetState = !closing
    val notifyEntered by rememberUpdatedState(onEnteredChanged)
    val entered = transition.isIdle && transition.currentState && !closing
    LaunchedEffect(entered) { notifyEntered?.invoke(entered) }
    AnimatedVisibility(visibleState = transition, modifier = modifier, enter = motion.expandIn(), exit = motion.collapseOut()) {
        val inert = if (closing) {
            Modifier
                .pointerInput(Unit) {
                    awaitPointerEventScope {
                        while (true) awaitPointerEvent(PointerEventPass.Initial).changes.forEach { it.consume() }
                    }
                }
                .clearAndSetSemantics {}
        } else {
            Modifier
        }
        Box(inert) {
            @Suppress("UNCHECKED_CAST")
            (last[0] as T?)?.let { content(it) }
        }
    }
}
