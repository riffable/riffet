package riffet.ui.design

import androidx.compose.animation.core.DecayAnimationSpec
import androidx.compose.animation.core.SpringSpec
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.calculateTargetValue
import androidx.compose.animation.core.spring
import androidx.compose.animation.rememberSplineBasedDecay
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.layout.layout
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.Velocity
import kotlin.math.abs
import kotlin.math.roundToInt
import kotlin.math.sign
import kotlin.math.sqrt
import riffet.ui.theme.LocalRiffetMotion

/**
 * A search field folded away above its list, as iPhone's `.searchable` in a navigation bar drawer
 * (`displayMode: .automatic`). It behaves as part of the list's scroll:
 *
 * - Pulling down at the top unfolds it against a rubber band, as a scroll view past its edge: at about
 *   two-thirds of the finger's travel at first and less near the end, about two field heights of
 *   finger for all of it. So a flick opens it part-way and the release finishes the motion, rather
 *   than the field arriving with the finger and stopping dead. Pull-to-refresh takes over past it; pushing up while it is
 *   part-way out folds it first, one to one. Once open it scrolls away with the list.
 * - On release part-way, the resting point the fling would reach decides open or shut (a flick
 *   opens it, a slow release goes to the nearer end), and it settles there on the release spring
 *   carrying the field's speed, without overshooting either end.
 * - While [pinned] (text in it, focus) it stays open; once out of sight it folds again.
 *
 * Attach [connection] to the scrolling container (inside any pull-to-refresh), and put the field in
 * a [SearchReveal] as the container's first child. [visible] is how much of the field shows on
 * screen, for the bar's search icon to hand over to it ([RiffetSearchField]'s `reveal`).
 */
@Stable
internal class SearchRevealState(open: Boolean, private val decay: DecayAnimationSpec<Float>, settle: SpringSpec<Float>) {
    /** How far the field is unfolded: 0–1, up to 1 + [OPEN_OVERSHOOT] while a release runs past open. Read in layout and drawing only. */
    internal var fraction by mutableFloatStateOf(if (open) 1f else 0f)
        private set

    /** The field's full height in px, from the last layout. */
    internal var height = 0f
    internal var pinned = false
    internal var atTop: () -> Boolean = { true }
    internal var scrolledInto: () -> Float = { 0f }

    // Critically damped at least: a spring that may ring would cross an end and stick there.
    private val stiffness = settle.stiffness
    private val spring = spring<Float>(dampingRatio = maxOf(1f, settle.dampingRatio), stiffness = stiffness)

    /** How much of the field shows on screen, 0–1. */
    fun visible(): Float = if (height <= 0f) fraction else ((height * fraction - scrolledInto()) / height).coerceIn(0f, 1f)

    suspend fun reveal() = settleTo(1f, 0f)

    /** Folds without animating: only once the field is out of sight. Returns the px it gave up. */
    internal fun foldAway(): Float {
        if (pinned || fraction == 0f) return 0f
        val shown = height * fraction
        fraction = 0f
        return shown
    }

    /**
     * [velocity] in fractions per second. A critically damped spring passes its target by about
     * (v − ω·d) / (ω·e), so the speed is capped for at most [OPEN_OVERSHOOT] past open (the list
     * runs on a little and comes back, as a scroll view's bounce) and none past shut.
     */
    private suspend fun settleTo(target: Float, velocity: Float) {
        val distance = target - fraction
        val toward = if (distance != 0f && sign(velocity) == sign(distance)) velocity else 0f
        val omega = sqrt(stiffness)
        val past = if (target >= 1f) OPEN_OVERSHOOT else 0f
        val start = sign(toward) * minOf(abs(toward), omega * abs(distance) + omega * E * past)
        try {
            animate(fraction, target, start, spring) { value, _ -> fraction = value.coerceIn(0f, 1f + OPEN_OVERSHOOT) }
        } finally {
            // A touch that stops the bounce leaves it open, not with the run-on gap below it.
            if (fraction > 1f) fraction = 1f
        }
    }

    /** The field moves this much per px of finger when [fraction] is unfolded, as a scroll view's band (≈ 0.55): 0.65 → 0.4. */
    private fun give(fraction: Float) = 0.65f - 0.25f * fraction.coerceIn(0f, 1f)

    /** Folds by a push up, one to one. */
    private fun fold(dy: Float): Offset {
        val before = fraction
        fraction = (fraction + dy / height).coerceIn(0f, 1f)
        return Offset(0f, (fraction - before) * height)
    }

    /** Unfolds by a pull down against the band; consumes the finger it used, so the rest goes on to refresh. */
    private fun pull(dy: Float): Offset {
        val k = give(fraction)
        val needed = (1f - fraction) * height / k
        val used = minOf(dy, needed)
        fraction = if (used >= needed) 1f else (fraction + used * k / height).coerceIn(0f, 1f)
        return Offset(0f, used)
    }

    val connection = object : NestedScrollConnection {
        override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
            // A drag or a fling pushing up folds a part-way field before the list moves.
            if (available.y >= 0f || pinned || height <= 0f) return Offset.Zero
            if (fraction <= 0f || fraction >= 1f || !atTop()) return Offset.Zero
            return fold(available.y)
        }

        override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
            // A drag past the top unfolds it; a fling arriving at the top does not.
            if (available.y <= 0f || source != NestedScrollSource.UserInput || height <= 0f || fraction >= 1f) return Offset.Zero
            return pull(available.y)
        }

        override suspend fun onPreFling(available: Velocity): Velocity {
            if (fraction <= 0f || fraction >= 1f || height <= 0f) return Velocity.Zero
            // The field's own speed: a downward flick moves it at the band's give.
            val speed = if (available.y > 0f) available.y * give(fraction) else available.y
            val rest = decay.calculateTargetValue(height * fraction, speed)
            val open = pinned || rest >= height / 2
            // An upward flick that folds it is the list's: its first frames fold the field (above).
            if (!open && available.y < 0f) return Velocity.Zero
            settleTo(if (open) 1f else 0f, speed / height)
            return available
        }

        override suspend fun onPostFling(consumed: Velocity, available: Velocity): Velocity {
            // A flick too slow to finish the fold leaves it part-way; take it to the nearer end.
            if (fraction <= 0f || fraction >= 1f) return Velocity.Zero
            settleTo(if (pinned || fraction >= 0.5f) 1f else 0f, 0f)
            return Velocity.Zero
        }
    }
}

/** How far past open a released flick may carry the list, in field heights. */
private const val OPEN_OVERSHOOT = 0.2f
private const val E = 2.7182817f

@Composable
private fun rememberSearchRevealState(pinned: Boolean): SearchRevealState {
    val settle = LocalRiffetMotion.current.settle<Float>()
    val decay = rememberSplineBasedDecay<Float>()
    val state = remember(decay) { SearchRevealState(open = pinned, decay = decay, settle = settle) }
    SideEffect { state.pinned = pinned }
    LaunchedEffect(state, pinned) { if (pinned) state.reveal() }
    return state
}

/** For a lazy list whose first item is the [SearchReveal]. */
@Composable
internal fun rememberSearchRevealState(list: LazyListState, pinned: Boolean): SearchRevealState {
    val state = rememberSearchRevealState(pinned)
    SideEffect {
        state.atTop = { list.firstVisibleItemIndex == 0 && list.firstVisibleItemScrollOffset == 0 }
        state.scrolledInto = { if (list.firstVisibleItemIndex == 0) list.firstVisibleItemScrollOffset.toFloat() else Float.MAX_VALUE }
    }
    LaunchedEffect(list, state) {
        // Items above the first visible one can change height without moving what shows.
        snapshotFlow { list.firstVisibleItemIndex > 0 }.collect { away -> if (away) state.foldAway() }
    }
    return state
}

/** For a scrolling column whose first child is the [SearchReveal]. */
@Composable
internal fun rememberSearchRevealState(scroll: ScrollState, pinned: Boolean): SearchRevealState {
    val state = rememberSearchRevealState(pinned)
    SideEffect {
        state.atTop = { scroll.value == 0 }
        state.scrolledInto = { scroll.value.toFloat() }
    }
    LaunchedEffect(scroll, state) {
        snapshotFlow { state.fraction > 0f && state.visible() <= 0f && scroll.value > 0 }
            .collect { away ->
                if (!away) return@collect
                // The column shortens above what shows; scroll back by as much so nothing moves.
                val shown = state.foldAway()
                if (shown > 0f) scroll.scrollBy(-shown)
            }
    }
    return state
}

/**
 * The folding slot: as tall as the field is unfolded, the field centred in it so it grows from its
 * middle (the field itself shortens and fades, see [RiffetSearchField]'s `reveal`); past open, the
 * field stays at the top and the extra opens below it. It keeps one pixel while folded so a lazy
 * list still counts it as the first visible item.
 */
@Composable
internal fun SearchReveal(state: SearchRevealState, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Box(
        modifier.clipToBounds().layout { measurable, constraints ->
            val placeable = measurable.measure(constraints.copy(minHeight = 0, maxHeight = Constraints.Infinity))
            state.height = placeable.height.toFloat()
            val shown = (placeable.height * state.fraction).roundToInt().coerceAtLeast(1)
            layout(placeable.width, shown) { placeable.place(0, minOf(0, (shown - placeable.height) / 2)) }
        },
    ) { content() }
}

/** A pill [fraction] of its full height, about its middle: the field part-way unfolded. */
internal class RevealPillShape(private val fraction: Float, private val radius: Float) : Shape {
    override fun createOutline(size: Size, layoutDirection: LayoutDirection, density: Density): Outline {
        val shown = size.height * fraction.coerceIn(0f, 1f)
        val top = (size.height - shown) / 2
        val corner = minOf(radius, shown / 2)
        return Outline.Rounded(RoundRect(0f, top, size.width, top + shown, CornerRadius(corner, corner)))
    }
}

/** 0 below [from], 1 above [to], eased in between. */
internal fun revealRamp(fraction: Float, from: Float, to: Float): Float {
    val t = ((fraction - from) / (to - from)).coerceIn(0f, 1f)
    return t * t * (3 - 2 * t)
}
