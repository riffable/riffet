package riffet.ui.focus

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.AwaitPointerEventScope
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.PointerInputChange
import androidx.compose.ui.input.pointer.PointerInputScope
import androidx.compose.ui.input.pointer.SuspendingPointerInputModifierNode
import androidx.compose.ui.input.pointer.changedToDownIgnoreConsumed
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.node.CompositionLocalConsumerModifierNode
import androidx.compose.ui.node.DelegatingNode
import androidx.compose.ui.node.GlobalPositionAwareModifierNode
import androidx.compose.ui.node.ModifierNodeElement
import androidx.compose.ui.node.currentValueOf
import androidx.compose.ui.node.requireLayoutCoordinates
import androidx.compose.ui.platform.LocalFocusManager

/*
 * ============================================================================================
 * A tap ends focus — and nothing else does
 * ============================================================================================
 *
 * The press is watched in the **Initial** pass, which runs from the outermost node inwards: on a
 * transcript almost every press is consumed by a child (a tool row expands, a fold header collapses,
 * a copy button fires), and a handler that waited for an unconsumed press never saw the taps a
 * reader makes on the conversation. Nothing here consumes anything, so the rows below behave as if
 * this node were not there.
 *
 * Seeing every press means judging every gesture, and the judgement has to cover the whole gesture:
 * once a press has run past the long-press timeout, moved past the touch slop or met a second finger,
 * it is not a tap, and it stays that way until every finger is up. A finger held still on glass still
 * reports moves; restarting the judgement on one of those made the release of a long press look
 * like a fresh tap, which cleared focus and the new selection and its Copy menu with it.
 *
 * The node is stateless towards composition (one shared element, no lambda key), so a screen
 * recomposing on every streamed chunk never restarts the detector in the middle of a press.
 */

/**
 * Clears focus when a press inside this node ends as a tap, unless it landed on a
 * [keepsFocusOnTap] control. While a finger is down, [FocusCoordinator.pressing] is true.
 */
internal fun Modifier.blurOnTap(): Modifier = this then BlurOnTapElement

/** Taps on this control are its own: a [blurOnTap] area around it leaves focus alone. */
internal fun Modifier.keepsFocusOnTap(): Modifier = this then KeepsFocusElement

private data object BlurOnTapElement : ModifierNodeElement<BlurOnTapNode>() {
    override fun create() = BlurOnTapNode()
    override fun update(node: BlurOnTapNode) = Unit
}

private class BlurOnTapNode : DelegatingNode(), CompositionLocalConsumerModifierNode {
    init {
        delegate(SuspendingPointerInputModifierNode { watchGestures() })
    }

    private suspend fun PointerInputScope.watchGestures() = awaitEachGesture {
        val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
        val coordinator = currentValueOf(LocalFocusCoordinator)
        coordinator.pressing = true
        try {
            val tap = awaitTap(down)
            if (tap && !coordinator.isKept(requireLayoutCoordinates().localToWindow(down.position))) {
                currentValueOf(LocalFocusManager).clearFocus()
            }
            awaitAllUp()
        } finally {
            coordinator.pressing = false
        }
    }
}

/** Follows [down] to its end; true only if it was a single short press that stayed in place. */
private suspend fun AwaitPointerEventScope.awaitTap(down: PointerInputChange): Boolean {
    while (true) {
        val event = awaitPointerEvent(PointerEventPass.Initial)
        if (event.changes.any { it.id != down.id && it.changedToDownIgnoreConsumed() }) return false
        val change = event.changes.firstOrNull { it.id == down.id } ?: return false
        if (change.uptimeMillis - down.uptimeMillis >= viewConfiguration.longPressTimeoutMillis) return false
        if ((change.position - down.position).getDistance() > viewConfiguration.touchSlop) return false
        if (!change.pressed) return true
    }
}

private suspend fun AwaitPointerEventScope.awaitAllUp() {
    while (currentEvent.changes.any { it.pressed }) awaitPointerEvent(PointerEventPass.Initial)
}

private data object KeepsFocusElement : ModifierNodeElement<KeepsFocusNode>() {
    override fun create() = KeepsFocusNode()
    override fun update(node: KeepsFocusNode) = Unit
}

private class KeepsFocusNode :
    Modifier.Node(),
    GlobalPositionAwareModifierNode,
    CompositionLocalConsumerModifierNode,
    FocusKeeper {
    private var coordinates: LayoutCoordinates? = null
    private var coordinator: FocusCoordinator? = null

    override fun onAttach() {
        coordinator = currentValueOf(LocalFocusCoordinator).also { it.register(this) }
    }

    override fun onDetach() {
        coordinator?.unregister(this)
        coordinator = null
        coordinates = null
    }

    override fun onGloballyPositioned(coordinates: LayoutCoordinates) {
        this.coordinates = coordinates
    }

    override fun contains(positionInWindow: Offset): Boolean {
        val bounds = coordinates?.takeIf { it.isAttached }?.boundsInWindow() ?: return false
        return bounds.contains(positionInWindow)
    }
}
