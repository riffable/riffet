package riffet.ui.design

import riffet.ui.theme.LocalRiffetMotion
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.Dp
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography

/**
 * A tab root's large title and the bar above it, driven by one scroll position: as the page moves
 * up, the large title shrinks toward the bar's title and fades, the bar's title fades in, and a
 * hairline appears under the bar once content passes beneath it. Everything is read in the draw
 * phase, so scrolling recomposes nothing.
 */
@Stable
internal class LargeTitleState(private val offset: () -> Int, private val past: () -> Boolean, private val distance: Float) {
    /** 0 while the large title is in full view, 1 once the bar has taken over. */
    val collapse: Float get() = if (past()) 1f else (offset() / distance).coerceIn(0f, 1f)
    /** Pixels scrolled within the first item; the large title rides slower than the page. */
    val scrolled: Float get() = if (past()) distance else offset().toFloat()
    val scrolledAny: Boolean get() = past() || offset() > 0
}

/** For a page whose large title is its list's first item. */
@Composable
internal fun rememberLargeTitleState(list: LazyListState): LargeTitleState {
    val metrics = LocalInterfaceStyle.current.metrics
    val distance = with(LocalDensity.current) { (metrics.controlHeight - metrics.hairlineWidth * 2).toPx() }
    return remember(list, distance) { LargeTitleState({ list.firstVisibleItemScrollOffset }, { list.firstVisibleItemIndex > 0 }, distance) }
}

/** For a page whose large title leads a scrolling column. */
@Composable
internal fun rememberLargeTitleState(scroll: ScrollState): LargeTitleState {
    val metrics = LocalInterfaceStyle.current.metrics
    val distance = with(LocalDensity.current) { (metrics.controlHeight - metrics.hairlineWidth * 2).toPx() }
    return remember(scroll, distance) { LargeTitleState({ scroll.value }, { false }, distance) }
}

/** The large title itself, placed as the page's first block. */
@Composable
internal fun LargeTitle(
    text: String,
    state: LargeTitleState,
    modifier: Modifier = Modifier,
    horizontalInset: Dp = LocalInterfaceStyle.current.metrics.pageInset,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val motion = LocalRiffetMotion.current
    Text(
        text,
        style = LocalRiffetTypography.current.largeTitle,
        color = LocalRiffetColors.current.fg,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
        modifier = modifier
            .fillMaxWidth()
            .padding(start = horizontalInset, end = horizontalInset, top = metrics.hairlineWidth * 2, bottom = metrics.pageTitleGap)
            .graphicsLayer {
                val p = state.collapse
                transformOrigin = TransformOrigin(0f, 0.6f)
                translationY = state.scrolled * motion.sharedAxisFraction
                scaleX = 1f - (1f - motion.popScale) * p
                scaleY = scaleX
                alpha = (1f - p * 1.7f).coerceAtLeast(0f)
            },
    )
}

/**
 * The bar over a tab root: a leading control, the title that takes over from [LargeTitle], then
 * the page's actions. [background] is the page's own colour, so the bar and page read as one sheet
 * until the hairline separates them.
 */
@Composable
internal fun LargeTitleBar(
    title: String,
    state: LargeTitleState,
    background: Color,
    modifier: Modifier = Modifier,
    navigation: @Composable () -> Unit = {},
    actions: @Composable RowScope.() -> Unit = {},
) {
    StyleTopBar(
        title = {
            Text(title, style = LocalRiffetTypography.current.barTitle, maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.graphicsLayer { alpha = ((state.collapse - 0.45f) / 0.55f).coerceIn(0f, 1f) })
        },
        navigation = navigation, actions = actions, background = background, modifier = modifier,
    )
}
