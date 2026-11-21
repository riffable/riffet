package riffet.ui.gesture

import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.gestures.ScrollableState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.PointerEvent
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.PointerId
import androidx.compose.ui.input.pointer.changedToDownIgnoreConsumed
import androidx.compose.ui.input.pointer.positionChangeIgnoreConsumed
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.input.pointer.util.addPointerInputChange
import androidx.compose.ui.node.CompositionLocalConsumerModifierNode
import androidx.compose.ui.node.ModifierNodeElement
import androidx.compose.ui.node.PointerInputModifierNode
import androidx.compose.ui.node.TraversableNode
import androidx.compose.ui.node.currentValueOf
import androidx.compose.ui.node.findNearestAncestor
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.LocalViewConfiguration
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import kotlin.math.abs
import kotlin.math.sign

/*
 * Horizontal swipes, decided in one place per window (docs/MOBILE.md「手势调度」).
 *
 * Every surface that can take a sideways drag (a pushed page's swipe back, the bottom tabs, the side
 * drawers, a horizontally scrolling child) and every layer that must stop them (a leaving bar, a page
 * mid-transition) puts a [swipeSurface] on itself. On a finger's down each surface under it enlists
 * with the window's [horizontalSwipeArbiter], outermost first, so the list is exactly the hit path.
 *
 * The arbiter watches the Initial pass, before any child: the first axis past the touch slop wins.
 * Vertical, a long press, or a second finger leaves the gesture to the children untouched. Horizontal
 * asks the path innermost first ([routeSwipe]) and, if someone takes it, consumes the pointer from then
 * on, so a vertical list that caught the down (stopping its fling or a stretch) lets go instead of
 * swallowing the swipe. The surface that took the drag hears [SwipeDrag.release] or [SwipeDrag.cancel]
 * exactly once, whatever ends the gesture.
 *
 * Who may take a swipe is declared by the surfaces themselves, never inferred from the back stack: a
 * guard that only blocks system back, or a flag left over from a closed layer, cannot switch the
 * tabs off.
 */

/** The way the finger travels, in screen terms. */
internal enum class SwipeDirection { LEFT, RIGHT }

/** A locked swipe as one surface sees it: [position] is the down in its own coordinates, [size] its bounds. */
internal class SwipeStart(
    val direction: SwipeDirection,
    val position: Offset,
    val size: IntSize,
    val layoutDirection: LayoutDirection,
) {
    /** True when the finger drags content toward its layout start (rightward in left-to-right). */
    val revealsStart: Boolean get() = (direction == SwipeDirection.RIGHT) != (layoutDirection == LayoutDirection.Rtl)
}

/** One drag handed to a surface. Exactly one of [release] or [cancel] ends it. */
internal interface SwipeDrag {
    /** The finger moved by [delta] px; positive is rightward. The first call carries the travel past the slop. */
    fun drag(delta: Float)
    /** The finger lifted at [velocity] px/s; positive is rightward. */
    fun release(velocity: Float)
    /** The gesture ended without a release (cancelled input, a removed surface): go back to rest. */
    fun cancel()
}

internal sealed interface SwipeVerdict {
    /** Not this surface's swipe: the next one out decides. */
    data object Pass : SwipeVerdict
    /** This surface covers what is outside it and does nothing with the swipe: nobody outside takes it. */
    data object Refuse : SwipeVerdict
    /** A child control scrolls or drags this way: it keeps the gesture unless an edge swipe takes it. */
    data object Child : SwipeVerdict
    /** A layer that takes no swipe and lets none through while it is up, wherever it is on the path. */
    data object Block : SwipeVerdict
    /** This surface takes it. [overChildren] takes it from a child control too (a page's edge swipe). */
    class Take(val overChildren: Boolean = false, val begin: () -> SwipeDrag) : SwipeVerdict
}

/** Decides a locked swipe for one surface. Called on the pointer path, outside composition. */
internal fun interface SwipeSurface {
    fun decide(start: SwipeStart): SwipeVerdict
}

/** Where a locked sideways swipe goes. */
internal sealed interface SwipeRoute {
    /** A surface follows it. */
    class Surface(val take: SwipeVerdict.Take) : SwipeRoute
    /** A child control keeps it; the arbiter stays out of the way. */
    data object Child : SwipeRoute
    /** Nobody: the gesture is swallowed, so a sideways swipe over a row never lands as a tap on it. */
    data object Nobody : SwipeRoute
    /** A blocking layer is up: it handles the touches itself. */
    data object Blocked : SwipeRoute
}

/**
 * Routes a locked swipe, given each surface's verdict from the innermost out. Kept pure so the rules
 * read (and test) as one table.
 */
internal fun routeSwipe(innermostFirst: List<SwipeVerdict>): SwipeRoute {
    if (innermostFirst.any { it === SwipeVerdict.Block }) return SwipeRoute.Blocked
    var child = false
    for (verdict in innermostFirst) {
        when (verdict) {
            SwipeVerdict.Pass -> Unit
            SwipeVerdict.Child -> child = true
            SwipeVerdict.Refuse, SwipeVerdict.Block -> return if (child) SwipeRoute.Child else SwipeRoute.Nobody
            is SwipeVerdict.Take -> return if (child && !verdict.overChildren) SwipeRoute.Child else SwipeRoute.Surface(verdict)
        }
    }
    return if (child) SwipeRoute.Child else SwipeRoute.Nobody
}

/** Puts the window's arbiter here: once per window root (the app, a sheet's popup), outside every [swipeSurface]. */
internal fun Modifier.horizontalSwipeArbiter(): Modifier = this then SwipeArbiterElement

/** Enlists [surface] for every gesture that starts on this node. */
internal fun Modifier.swipeSurface(surface: SwipeSurface): Modifier = this then SwipeSurfaceElement(surface)

/**
 * A control with its own sideways gesture (a scroller, a slider, a single-line field): it keeps the
 * swipes [canTake] accepts, by whether the drag reveals its layout start. The rest go on outward, so
 * a scroller at its start hands a rightward swipe to the page's swipe back.
 */
internal fun Modifier.horizontalSwipeChild(canTake: (revealsStart: Boolean) -> Boolean = { true }): Modifier =
    swipeSurface { start -> if (canTake(start.revealsStart)) SwipeVerdict.Child else SwipeVerdict.Pass }

/** A scrollable child of [state]: keeps the swipes it can still scroll by. */
internal fun Modifier.horizontalSwipeChild(state: ScrollableState): Modifier =
    horizontalSwipeChild { revealsStart -> if (revealsStart) state.canScrollBackward else state.canScrollForward }

/** `horizontalScroll` that keeps only the swipes it can scroll by; the rest reach the page, tabs and drawers. */
internal fun Modifier.riffetHorizontalScroll(state: ScrollState, enabled: Boolean = true, reverseScrolling: Boolean = false): Modifier =
    horizontalSwipeChild { revealsStart -> enabled && if (revealsStart != reverseScrolling) state.canScrollBackward else state.canScrollForward }
        .horizontalScroll(state, enabled = enabled, reverseScrolling = reverseScrolling)

/** While [blocking], no swipe starting on this node is taken by anyone. */
internal fun Modifier.blockSwipes(blocking: () -> Boolean): Modifier =
    swipeSurface { if (blocking()) SwipeVerdict.Block else SwipeVerdict.Pass }

/**
 * While [active], this node and everything under it take no touch at all: consumed in the Initial
 * pass, and no swipe starting here is taken. For a layer on its way out or mid-transition.
 */
internal fun Modifier.swallowTouches(active: () -> Boolean): Modifier = blockSwipes(active) then SwallowTouchesElement(active)

private object SwipeArbiterKey

private object SwipeArbiterElement : ModifierNodeElement<SwipeArbiterNode>() {
    override fun create() = SwipeArbiterNode()
    override fun update(node: SwipeArbiterNode) = Unit
    override fun equals(other: Any?) = other === this
    override fun hashCode() = SwipeArbiterKey.hashCode()
}

private class SwipeSurfaceElement(val surface: SwipeSurface) : ModifierNodeElement<SwipeSurfaceNode>() {
    override fun create() = SwipeSurfaceNode(surface)
    override fun update(node: SwipeSurfaceNode) { node.surface = surface }
    override fun equals(other: Any?) = other is SwipeSurfaceElement && other.surface === surface
    override fun hashCode() = surface.hashCode()
}

private class SwallowTouchesElement(val active: () -> Boolean) : ModifierNodeElement<SwallowTouchesNode>() {
    override fun create() = SwallowTouchesNode(active)
    override fun update(node: SwallowTouchesNode) { node.active = active }
    override fun equals(other: Any?) = other is SwallowTouchesElement && other.active === active
    override fun hashCode() = active.hashCode()
}

/** One surface on the current gesture's path, with the down in its own coordinates. */
private class Enlisted(val node: SwipeSurfaceNode, val position: Offset, val size: IntSize)

private class SwipeSurfaceNode(var surface: SwipeSurface) :
    Modifier.Node(), PointerInputModifierNode, CompositionLocalConsumerModifierNode {

    val layoutDirection: LayoutDirection get() = currentValueOf(LocalLayoutDirection)

    override fun onPointerEvent(pointerEvent: PointerEvent, pass: PointerEventPass, bounds: IntSize) {
        if (pass != PointerEventPass.Initial) return
        for (change in pointerEvent.changes) {
            if (change.changedToDownIgnoreConsumed()) {
                (findNearestAncestor(SwipeArbiterKey) as? SwipeArbiterNode)?.enlist(change.id, Enlisted(this, change.position, bounds))
            }
        }
    }

    override fun onCancelPointerInput() = Unit
}

private class SwallowTouchesNode(var active: () -> Boolean) : Modifier.Node(), PointerInputModifierNode {
    override fun onPointerEvent(pointerEvent: PointerEvent, pass: PointerEventPass, bounds: IntSize) {
        if (pass == PointerEventPass.Initial && active()) pointerEvent.changes.forEach { it.consume() }
    }

    override fun onCancelPointerInput() = Unit
}

private class SwipeArbiterNode : Modifier.Node(), PointerInputModifierNode, TraversableNode, CompositionLocalConsumerModifierNode {
    override val traverseKey: Any get() = SwipeArbiterKey

    private enum class Phase { IDLE, WATCHING, IGNORED, OWNED, SWALLOWED }

    private var phase = Phase.IDLE
    private var pointer: PointerId? = null
    private var downPosition = Offset.Zero
    private var downTime = 0L
    private val path = ArrayList<Enlisted>()
    private var drag: SwipeDrag? = null
    private val tracker = VelocityTracker()

    fun enlist(id: PointerId, surface: Enlisted) {
        if (phase == Phase.WATCHING && id == pointer) path += surface
    }

    override fun onPointerEvent(pointerEvent: PointerEvent, pass: PointerEventPass, bounds: IntSize) {
        if (pass != PointerEventPass.Initial) return
        val changes = pointerEvent.changes
        when (phase) {
            Phase.IDLE -> {
                val down = changes.firstOrNull { it.changedToDownIgnoreConsumed() } ?: return
                if (changes.count { it.pressed } > 1) { phase = Phase.IGNORED; return }
                phase = Phase.WATCHING
                pointer = down.id
                downPosition = down.position
                downTime = down.uptimeMillis
                path.clear()
                tracker.resetTracking()
                tracker.addPointerInputChange(down)
            }
            Phase.WATCHING -> watch(pointerEvent)
            Phase.OWNED -> follow(pointerEvent)
            Phase.IGNORED -> if (changes.none { it.pressed }) reset()
            Phase.SWALLOWED -> {
                changes.firstOrNull { it.id == pointer }?.consume()
                if (changes.none { it.pressed }) reset()
            }
        }
    }

    private fun watch(event: PointerEvent) {
        val changes = event.changes
        if (changes.any { it.id != pointer && it.changedToDownIgnoreConsumed() }) { ignore(event); return }
        val change = changes.firstOrNull { it.id == pointer } ?: run { reset(); return }
        if (change.pressed) tracker.addPointerInputChange(change)
        val config = currentValueOf(LocalViewConfiguration)
        // A finger that rested past a long press is selecting, dragging an item or holding to talk.
        if (change.uptimeMillis - downTime > config.longPressTimeoutMillis) { ignore(event); return }
        val total = change.position - downPosition
        val slop = config.touchSlop
        val dx = abs(total.x)
        val dy = abs(total.y)
        if (dy >= slop && dy >= dx) { ignore(event); return }
        // A lift short of the slop is a tap: the children have it, and the next down starts afresh.
        if (dx < slop || dx <= dy) { if (!change.pressed) reset(); return }
        val direction = if (total.x > 0f) SwipeDirection.RIGHT else SwipeDirection.LEFT
        val verdicts = path.asReversed().map { surface ->
            if (!surface.node.isAttached) SwipeVerdict.Pass
            else surface.node.surface.decide(SwipeStart(direction, surface.position, surface.size, surface.node.layoutDirection))
        }
        path.clear()
        val take = when (val route = routeSwipe(verdicts)) {
            is SwipeRoute.Surface -> route.take
            SwipeRoute.Nobody -> { change.consume(); if (change.pressed) phase = Phase.SWALLOWED else reset(); return }
            SwipeRoute.Child, SwipeRoute.Blocked -> { ignore(event); return }
        }
        val handle = take.begin()
        drag = handle
        phase = Phase.OWNED
        change.consume()
        handle.drag(total.x - sign(total.x) * slop)
        // A quick flick can cross the slop and lift in one event.
        if (!change.pressed) end(release = true)
    }

    private fun follow(event: PointerEvent) {
        val change = event.changes.firstOrNull { it.id == pointer } ?: run { end(release = false); return }
        // Sampled while pressed, as Compose's own drags do: the lift is not a sample of the motion.
        if (change.pressed) tracker.addPointerInputChange(change)
        change.consume()
        // The lift carries the finger's last stretch of travel: the drag ends where the finger left.
        val delta = change.positionChangeIgnoreConsumed().x
        if (delta != 0f) drag?.drag(delta)
        if (!change.pressed) end(release = true)
    }

    private fun ignore(event: PointerEvent) {
        path.clear()
        phase = if (event.changes.any { it.pressed }) Phase.IGNORED else Phase.IDLE
        if (phase == Phase.IDLE) pointer = null
    }

    private fun end(release: Boolean) {
        val handle = drag
        val velocity = if (release) tracker.calculateVelocity().x else 0f
        reset()
        if (handle != null) { if (release) handle.release(velocity) else handle.cancel() }
    }

    private fun reset() {
        phase = Phase.IDLE
        pointer = null
        drag = null
        path.clear()
    }

    override fun onCancelPointerInput() = end(release = false)

    override fun onDetach() = end(release = false)
}
