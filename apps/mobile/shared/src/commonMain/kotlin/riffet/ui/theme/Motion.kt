package riffet.ui.theme

import androidx.compose.animation.ContentTransform
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.SpringSpec
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.staticCompositionLocalOf
import riffet.shared.PageAnimation
import riffet.ui.design.DefaultMotionTokens
import androidx.compose.ui.Alignment
import androidx.compose.ui.unit.IntSize

/**
 * The app's motion vocabulary, resolved from preset defaults and theme overrides.
 *
 * Three kinds of motion, each with its own spec:
 *  - **settle**: something the finger let go of (a page, drawer or sheet) finishes where it was
 *    flung. A critically damped spring that takes the release velocity, never a fixed tween.
 *  - **spatial**: a size or position change the app starts (expand, collapse, a row moving).
 *  - **effects**: alpha and colour, which must not overshoot.
 *
 * Reduced motion needs nothing here: the animation runtime scales every spec by the platform's
 * duration scale and snaps to the end at 0 (see `riffet.ui.timeline.rememberReducedMotion`).
 */
@Immutable
internal class RiffetMotion(
    private val tokens: Map<String, Double> = DefaultMotionTokens,
    private val standardEasing: CubicBezierEasing = CubicBezierEasing(0.2f, 0f, 0f, 1f),
) {
    private fun number(key: String, min: Float = 0f, max: Float = 1f): Float =
        (tokens[key]?.takeIf { it.isFinite() } ?: DefaultMotionTokens.getValue(key)).toFloat().coerceIn(min, max)
    private fun duration(key: String): Int = number(key, 0f, 2000f).toInt()
    val pageEnter = duration("pageEnter")
    val pageExit = duration("pageExit")
    val coveredPageShift = number("coveredPageShift")
    val coveredPageDim = number("coveredPageDim")
    val pressOpacity = number("pressOpacity", min = 0.1f)
    val disabledOpacity = number("disabledOpacity")
    val floatingShadowOpacity = number("floatingShadowOpacity")
    val popScale = number("popScale")
    val sharedAxisFraction = number("sharedAxisFraction")

    /** A colour, an icon swap, a fade of something small. */
    val SHORT = duration("short")

    /** A component changing shape: expand, collapse, a sheet's page. */
    val MEDIUM = duration("medium")

    /** A full-screen surface arriving. */
    val LONG = duration("long")

    /** A full-screen surface leaving on a tap: exits are quicker than entrances. */
    val EXIT = duration("exit")

    /** Material's standard curve: most in-place changes. */
    val Standard = standardEasing

    /** Arrives fast and lands softly: anything entering the screen. */
    val EmphasizedDecelerate = CubicBezierEasing(0.05f, 0.7f, 0.1f, 1f)

    /** Leaves with growing speed: anything exiting the screen for good. */
    val EmphasizedAccelerate = CubicBezierEasing(0.3f, 0f, 0.8f, 0.15f)

    /** A released page, drawer or sheet. Pass the fling velocity as the animation's initial one. */
    fun <T> settle(): SpringSpec<T> = spring(dampingRatio = number("settleDamping", 0.5f, 2f), stiffness = number("settleStiffness", 50f, 5000f))

    /** Size and position changes the app starts. A hint of give, no visible bounce. */
    fun <T> spatial(): SpringSpec<T> = spring(dampingRatio = number("spatialDamping", 0.5f, 2f), stiffness = number("spatialStiffness", 50f, 5000f))

    /** Alpha and colour. */
    fun <T> effects(): SpringSpec<T> = spring(dampingRatio = Spring.DampingRatioNoBouncy, stiffness = number("effectsStiffness", 50f, 5000f))

    fun <T> short(): FiniteAnimationSpec<T> = tween(SHORT, easing = Standard)
    fun <T> medium(): FiniteAnimationSpec<T> = tween(MEDIUM, easing = Standard)
    fun <T> enter(): FiniteAnimationSpec<T> = tween(LONG, easing = EmphasizedDecelerate)
    fun <T> exit(): FiniteAnimationSpec<T> = tween(EXIT, easing = EmphasizedAccelerate)

    /** A block opening in place (a disclosure, a banner, a footer row): grows from its top edge. */
    fun expandIn(): EnterTransition =
        fadeIn(tween(MEDIUM, delayMillis = MEDIUM / 5, easing = Standard)) +
            expandVertically(spatial<IntSize>(), expandFrom = Alignment.Top)

    fun collapseOut(): ExitTransition =
        fadeOut(tween(SHORT, easing = Standard)) +
            shrinkVertically(spatial<IntSize>(), shrinkTowards = Alignment.Top)

    /** A small floating control (jump-to-latest, a badge) appearing at its own spot. */
    fun popIn(): EnterTransition = fadeIn(tween(SHORT, easing = Standard)) + scaleIn(spatial(), initialScale = popScale)

    fun popOut(): ExitTransition = fadeOut(tween(SHORT, easing = Standard)) + scaleOut(tween(SHORT, easing = Standard), targetScale = popScale)
}

internal val LocalRiffetMotion = staticCompositionLocalOf { RiffetMotion() }

/** One device-wide policy for navigation, tabs, picker pages and deferred page bodies. */
@Immutable
internal class RiffetPageMotion(
    val animation: PageAnimation = PageAnimation.DEFAULT,
    val motion: RiffetMotion = RiffetMotion(),
) {
    val enabled: Boolean get() = animation != PageAnimation.NONE

    fun enter(forward: Boolean = true): EnterTransition = when (animation) {
        PageAnimation.SLIDE -> slideInHorizontally(tween(motion.pageEnter, easing = motion.EmphasizedDecelerate)) {
            if (forward) it else -it
        }
        PageAnimation.FADE -> fadeIn(tween(motion.pageEnter, easing = motion.EmphasizedDecelerate))
        PageAnimation.SCALE -> fadeIn(tween(motion.pageEnter, easing = motion.EmphasizedDecelerate)) +
            scaleIn(tween(motion.pageEnter, easing = motion.EmphasizedDecelerate), initialScale = PAGE_SCALE)
        PageAnimation.NONE -> EnterTransition.None
    }

    fun exit(forward: Boolean = true): ExitTransition = when (animation) {
        PageAnimation.SLIDE -> slideOutHorizontally(tween(motion.pageExit, easing = motion.Standard)) {
            if (forward) -it else it
        }
        PageAnimation.FADE -> fadeOut(tween(motion.pageExit, easing = motion.Standard))
        PageAnimation.SCALE -> fadeOut(tween(motion.pageExit, easing = motion.Standard)) +
            scaleOut(tween(motion.pageExit, easing = motion.Standard), targetScale = PAGE_SCALE)
        PageAnimation.NONE -> ExitTransition.None
    }

    fun transition(forward: Boolean = true): ContentTransform = ContentTransform(enter(forward), exit(forward), sizeTransform = null)

    /** Deferred bodies reveal once after the page settles, without repeating its spatial motion. */
    fun reveal(): EnterTransition = if (enabled) fadeIn(motion.short()) else EnterTransition.None
    fun conceal(): ExitTransition = if (enabled) fadeOut(motion.short()) else ExitTransition.None
    fun revealTransition(): ContentTransform = ContentTransform(reveal(), conceal(), sizeTransform = null)
    fun revealAlpha(progress: Float): Float = if (enabled) 1f - progress.coerceIn(0f, 1f) else 1f

    // The retained page host and PageBody animate a single progress value in the drawing phase.
    fun translation(progress: Float, width: Float): Float = if (animation == PageAnimation.SLIDE) width * progress else 0f
    fun alpha(progress: Float): Float = when (animation) {
        PageAnimation.FADE, PageAnimation.SCALE -> 1f - progress.coerceIn(0f, 1f)
        else -> 1f
    }
    fun scale(progress: Float): Float = if (animation == PageAnimation.SCALE) 1f - (1f - PAGE_SCALE) * progress.coerceIn(0f, 1f) else 1f

    private companion object { const val PAGE_SCALE = 0.96f }
}

internal val LocalRiffetPageMotion = compositionLocalOf { RiffetPageMotion() }
