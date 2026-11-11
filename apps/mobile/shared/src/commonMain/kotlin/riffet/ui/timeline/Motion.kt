package riffet.ui.timeline

import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.MotionDurationScale

/*
 * ============================================================================================
 * Reduced motion on Compose Multiplatform 1.7.3
 * ============================================================================================
 *
 * The README's rule is that `prefers-reduced-motion` collapses structural durations to ~0. What is
 * actually available on this stack, checked against the resolved artifacts rather than assumed:
 *
 *  1. `androidx.compose.ui.MotionDurationScale` is a **common** `CoroutineContext.Element` with a
 *     single `scaleFactor` (`ui-desktop-1.7.3.jar` contains it, so it is not an Android type).
 *     `androidx.compose.animation.core` reads it out of the animation's own coroutine context
 *     (`SuspendAnimationKt` does `coroutineContext[MotionDurationScale.Key].scaleFactor`) and
 *     multiplies every duration by it. So `tween`, `spring`, `AnimatedVisibility`, `animate*AsState`
 *     and `Modifier.animateItem` already honour the platform setting *wherever a platform installs
 *     one*.
 *  2. On Android, `WindowRecomposer.android.kt` installs a private `MotionDurationScaleImpl` into
 *     the recomposer's context and drives it from `Settings.Global.ANIMATOR_DURATION_SCALE` with a
 *     `ContentObserver`. Accessibility "Remove animations" writes 0 there, i.e. reduced motion.
 *  3. There is **no** public `LocalMotionDurationScale` CompositionLocal in CMP 1.7.3. A decompile
 *     of `ui-android` and `ui-desktop` 1.7.3 finds only the coroutine-context interface
 *     (`androidx.compose.ui.MotionDurationScale`) and the internal Android impl
 *     (`androidx.compose.ui.platform.MotionDurationScaleImpl`); nothing exposes it to common code.
 *  4. Desktop and iOS install nothing into the context, so the key is simply absent there and there
 *     is no common way to read the OS preference in 1.7.3. A platform seam would be needed for a
 *     true iOS "Reduce Motion"; none is added here because iOS cannot be compiled or verified on
 *     this machine (`SKIPPED` is not a pass).
 *
 * The common way to *read* the setting is therefore the composition's own coroutine context: every
 * effect and animation created by a composable runs in the recomposer's context, which is exactly
 * where the scale lives. [rememberReducedMotion] reads it, so our own explicit durations can be
 * collapsed to 0 and, on Android, composition re-reads it when the user toggles the setting
 * (`MotionDurationScaleImpl.scaleFactor` is backed by snapshot state).
 *
 * Duration handling deliberately reads the scale as a *boolean*, not as a multiplier. The animation
 * runtime already multiplies by `scaleFactor`, so scaling our `tween` durations by the same factor
 * would double-count it whenever the developer option is left at 0.5x or 2x. "Reduced" means only
 * "collapse to zero"; everything else is left to the runtime.
 */

/**
 * Whether the platform asks for reduced motion in this composition.
 *
 * `false` when no scale is installed (desktop/iOS 1.7.3): full motion, stated rather than hidden,
 * instead of inventing a preference that does not exist.
 */
@Composable
internal fun rememberReducedMotion(): Boolean {
    val scale = rememberCoroutineScope().coroutineContext[MotionDurationScale]?.scaleFactor
    return scale != null && scale <= 0f
}

/** [millis] of motion, or 0 when the reader asked for none: the end state is applied instantly. */
internal fun motionDuration(reduced: Boolean, millis: Int): Int = if (reduced) 0 else millis
