package riffet.ui.pager

import androidx.compose.animation.core.AnimationSpec
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.gestures.TargetedFlingBehavior
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.PagerDefaults
import androidx.compose.foundation.pager.PagerState
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.unit.LayoutDirection
import riffet.shared.PageAnimation
import riffet.ui.theme.LocalRiffetPageMotion
import riffet.ui.timeline.rememberReducedMotion
import kotlin.math.abs

/*
 * The swipe container behind the app's single-page tab surfaces (today: the Git panel's
 * 改动 / 检查点 / Worktree).
 *
 * The tab strip stays the caller's own segmented control: this file only owns the page area, so a
 * panel keeps its header, its banners and its "there is a diff open, the tabs are gone" state
 * exactly as before, and only the `when (tab)` that swapped three bodies for one becomes a pager.
 *
 * Both directions are wired, and neither is allowed to fight the other:
 *
 *  - a swipe that settles on a page reports that page as the selection, *on settle* — dragging past
 *    a tab and releasing back must not fire a load for a page that was never shown;
 *  - a selection made elsewhere (a tap on the strip) scrolls the pager to that page; a page two or
 *    more away is switched to at once. The animation is also skipped when page motion is disabled
 *    or the reader asked for reduced motion. Released
 *    swipes also snap immediately there, while the drag keeps following the finger.
 *
 * A page that is swiped away leaves composition, so its scroll position and its remembered fields
 * are dropped — the same thing the old `when (tab)` did, so this is not a regression the pager adds.
 * `beyondViewportPageCount` is left at 0 for the same reason: a neighbouring tab is composed only
 * while it is being dragged into view, so its `LaunchedEffect`s (a checkpoint or worktree fetch
 * behind an explicit tab switch) do not run before the reader asks for it.
 */

/**
 * A horizontal pager an external tab strip drives, and that drives the strip back.
 *
 * @param selected the current page, owned by the caller's tab state.
 * @param onSelect called once a swipe has settled on another page.
 * @param pageCount how many pages the strip has. Changing it re-creates the pager's state (the
 *   page count is `rememberPagerState`'s key), which is what a panel wants when its tab set changes.
 * @param pagerState optional shared state for a tab indicator that follows the swipe position.
 * @param userScrollEnabled false pins the pager: a nested horizontal gesture (a diff's own
 *   horizontal scroll, a page that is not a page yet) then keeps the drag instead of losing it.
 *   The caller may still drive [pagerState] itself (the bottom tabs do, see `TabSwipe`).
 * @param beyondViewportPageCount pages kept composed on each side of the visible one. 0 composes a
 *   neighbour only while it is dragged into view (a panel whose tabs load on demand); the bottom
 *   tabs keep theirs, so a swipe does not compose a whole page in its first frame.
 * @param followFinger the pages always slide with the drag. Off, a fade or scale page motion keeps
 *   the pages in place and cross-fades them instead.
 */
@Composable
internal fun RiffetTabPager(
    selected: Int,
    onSelect: (Int) -> Unit,
    pageCount: Int,
    modifier: Modifier = Modifier,
    userScrollEnabled: Boolean = true,
    pagerState: PagerState? = null,
    followFinger: Boolean = false,
    beyondViewportPageCount: Int = 0,
    content: @Composable (Int) -> Unit,
) {
    val defaultState = rememberPagerState(initialPage = selected.coerceIn(0, (pageCount - 1).coerceAtLeast(0))) { pageCount }
    val state = pagerState ?: defaultState
    val pageMotion = LocalRiffetPageMotion.current
    val reduced = rememberReducedMotion()
    val layoutDirection = LocalLayoutDirection.current
    val pageDirection = if (layoutDirection == LayoutDirection.Rtl) -1f else 1f
    val fling = rememberTabPagerFling(state)
    // The effects below are keyed on the pager state, so they must not capture a stale selection:
    // the strip can be tapped while a previous settle is still being collected.
    val latestSelected by rememberUpdatedState(selected)
    val latestOnSelect by rememberUpdatedState(onSelect)

    LaunchedEffect(state) {
        snapshotFlow { state.settledPage }.collect { page ->
            if (page != latestSelected) latestOnSelect(page)
        }
    }

    LaunchedEffect(state, selected, pageMotion, reduced) {
        if (state.currentPage != selected || state.currentPageOffsetFraction != 0f) {
            // A far tap switches at once: sliding past the pages between would compose (and load) them.
            if (!pageMotion.enabled || reduced || abs(selected - state.currentPage - state.currentPageOffsetFraction) > 1f) {
                state.scrollToPage(selected)
            } else {
                state.animateScrollToPage(
                    selected,
                    animationSpec = tween(pageMotion.motion.pageEnter, easing = pageMotion.motion.EmphasizedDecelerate),
                )
            }
        }
    }

    HorizontalPager(
        state = state,
        modifier = modifier.fillMaxSize(),
        userScrollEnabled = userScrollEnabled,
        flingBehavior = fling,
        // 0 by default: a neighbouring tab must not be composed (and so must not run its own load)
        // until the reader drags it into view.
        beyondViewportPageCount = beyondViewportPageCount,
        // Named, not trailing: `pageContent` is the parameter this version of the pager names, and a
        // trailing lambda would silently bind to the last parameter if that ever changes.
        pageContent = { page ->
            Box(Modifier.fillMaxSize().graphicsLayer {
                if (!followFinger && (pageMotion.animation == PageAnimation.FADE || pageMotion.animation == PageAnimation.SCALE)) {
                    val signedOffset = page - state.currentPage - state.currentPageOffsetFraction
                    val progress = abs(signedOffset)
                    translationX = -signedOffset * size.width * pageDirection
                    alpha = pageMotion.alpha(progress)
                    scaleX = pageMotion.scale(progress)
                    scaleY = scaleX
                } else {
                    translationX = 0f
                    alpha = 1f
                    scaleX = 1f
                    scaleY = 1f
                }
            }) { content(page) }
        },
    )
}

/** The settle after a release: null when page motion is off or reduced (the pages jump), else the theme's settle. */
@Composable
internal fun rememberTabSettle(): AnimationSpec<Float>? {
    val pageMotion = LocalRiffetPageMotion.current
    val reduced = rememberReducedMotion()
    return if (!pageMotion.enabled || reduced) null else pageMotion.motion.settle()
}

@Composable
private fun rememberTabPagerFling(state: PagerState): TargetedFlingBehavior =
    PagerDefaults.flingBehavior(state, snapAnimationSpec = rememberTabSettle() ?: snap())
