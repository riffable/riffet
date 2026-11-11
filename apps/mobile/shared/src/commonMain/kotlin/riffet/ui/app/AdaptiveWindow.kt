package riffet.ui.app

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.Constraints
import kotlin.math.roundToInt
import androidx.compose.ui.window.DialogProperties

/** Physical features are window-relative pixels, independent of density and navigation insets. */
@Immutable
data class RiffetWindowFold(
    val bounds: Rect,
    val vertical: Boolean,
    val separating: Boolean,
    val occluding: Boolean,
    val halfOpened: Boolean,
)

@Immutable
data class RiffetWindowInfo(
    val folds: List<RiffetWindowFold> = emptyList(),
    val inMultiWindow: Boolean = false,
)

val LocalRiffetWindowInfo = staticCompositionLocalOf { RiffetWindowInfo() }

internal expect fun adaptiveDialogProperties(properties: DialogProperties): DialogProperties

/** Captured in the originating page; an independent modal cannot use its own position as anchor. */
private val LocalAdaptiveModalTarget = compositionLocalOf<Rect?> { null }

@Immutable
internal data class AdaptiveWorkbenchLayout(val rail: Boolean, val twoPane: Boolean)

/**
 * Width belongs to the current window, not the physical display. A resized Pad therefore follows
 * the same rules as a phone. Only an actual separating/occluding feature creates physical panes.
 */
@Composable
internal fun AdaptiveWorkbench(tasks: Boolean, content: @Composable (AdaptiveWorkbenchLayout) -> Unit) {
    var origin by remember { mutableStateOf(Offset.Zero) }
    val density = LocalDensity.current
    val window = LocalRiffetWindowInfo.current
    BoxWithConstraints(Modifier.fillMaxSize().trackForFolds(window) { origin = it.positionInWindow() }) {
        val fold = separatingFold(window, origin, constraints.maxWidth.toFloat(), constraints.maxHeight.toFloat())
        val canSplit = fold?.let {
            if (it.vertical) with(density) {
                maxHeight >= 480.dp && it.bounds.left.toDp() >= 416.dp && (constraints.maxWidth - it.bounds.right).toDp() >= 360.dp
            } else with(density) {
                maxWidth >= RailMinWidth && it.bounds.top.toDp() >= 320.dp &&
                    (constraints.maxHeight - it.bounds.bottom).toDp() >= 320.dp
            }
        } ?: false
        val twoPane = tasks && if (fold != null) canSplit else maxWidth >= TwoPaneMinWidth && maxHeight >= 480.dp
        // A single page uses one physical screen segment. Centering it across the hinge would put
        // titles, fields and floating windows in an inaccessible area. Prefer the larger segment.
        val safe = if (fold == null || twoPane) Rect(0f, 0f, constraints.maxWidth.toFloat(), constraints.maxHeight.toFloat())
            else largestSegment(fold, constraints.maxWidth.toFloat(), constraints.maxHeight.toFloat())
        val width = with(density) { safe.width.toDp() }
        val height = with(density) { safe.height.toDp() }
        val rail = width >= RailMinWidth && height >= 400.dp
        Box(Modifier.offset(with(density) { safe.left.toDp() }, with(density) { safe.top.toDp() })
            .width(width).height(height)) {
            CompositionLocalProvider(LocalAdaptiveModalTarget provides safe.translate(origin)) {
                content(AdaptiveWorkbenchLayout(rail, twoPane))
            }
        }
    }
}

/** The master/detail seam follows a physical hinge; otherwise the master pane scales on Pad. */
@Composable
internal fun AdaptiveSessionPanes(list: @Composable () -> Unit, detail: @Composable () -> Unit) {
    var origin by remember { mutableStateOf(Offset.Zero) }
    val density = LocalDensity.current
    val window = LocalRiffetWindowInfo.current
    BoxWithConstraints(Modifier.fillMaxSize().trackForFolds(window) { origin = it.positionInWindow() }) {
        val fold = separatingFold(window, origin, constraints.maxWidth.toFloat(), constraints.maxHeight.toFloat())
        if (fold != null && !fold.vertical) {
            val topHeight = with(density) { fold.bounds.top.toDp() }.coerceIn(0.dp, maxHeight)
            val gap = with(density) { fold.bounds.height.toDp() }.coerceAtLeast(0.dp)
            if (maxHeight - topHeight - gap < 240.dp) {
                // IME can consume the bottom half after the outer window selected tabletop mode.
                // Keep the active conversation in a usable segment rather than a tiny lower pane.
                val safe = largestSegment(fold, constraints.maxWidth.toFloat(), constraints.maxHeight.toFloat())
                AdaptivePaneContent(Modifier.offset(y = with(density) { safe.top.toDp() })
                    .fillMaxWidth().height(with(density) { safe.height.toDp() }), detail)
            } else {
                Column(Modifier.fillMaxSize()) {
                    AdaptivePaneContent(Modifier.fillMaxWidth().height(topHeight), list)
                    Spacer(Modifier.height(gap))
                    AdaptivePaneContent(Modifier.weight(1f).fillMaxSize(), detail)
                }
            }
        } else if (fold == null && maxWidth < 681.dp) {
            // This is the content width after the rail, not the outer 840dp workbench breakpoint.
            // Retain list/detail as long as their 320dp/360dp minimums and divider still fit.
            AdaptivePaneContent(Modifier.fillMaxSize(), detail)
        } else {
            val listWidth = if (fold != null) with(density) { fold.bounds.left.toDp() }.coerceIn(0.dp, maxWidth)
                else (maxWidth * 0.32f).coerceIn(320.dp, 420.dp)
            Row(Modifier.fillMaxSize()) {
                AdaptivePaneContent(Modifier.width(listWidth).fillMaxHeight(), list)
                if (fold != null) Spacer(Modifier.width(with(density) { fold.bounds.width.toDp() }.coerceAtLeast(0.dp)))
                else VerticalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                AdaptivePaneContent(Modifier.weight(1f).fillMaxHeight(), detail)
            }
        }
    }
}

@Composable
private fun AdaptivePaneContent(modifier: Modifier, content: @Composable () -> Unit) {
    var bounds by remember { mutableStateOf<Rect?>(null) }
    val window = LocalRiffetWindowInfo.current
    Box(modifier.trackForFolds(window) { bounds = it.boundsInWindow() }) {
        CompositionLocalProvider(LocalAdaptiveModalTarget provides (bounds ?: LocalAdaptiveModalTarget.current), content = content)
    }
}

/** Full-window Popup/Dialog uses zero origin; an embedded viewport measures its page origin. */
@Composable
internal fun AdaptiveModalViewport(
    modifier: Modifier = Modifier,
    fullWindowCoordinates: Boolean = false,
    alignment: Alignment = Alignment.Center,
    content: @Composable BoxScope.() -> Unit,
) {
    var origin by remember { mutableStateOf(Offset.Zero) }
    val window = LocalRiffetWindowInfo.current
    val target = LocalAdaptiveModalTarget.current
    val density = LocalDensity.current
    BoxWithConstraints(modifier.fillMaxSize().trackForFolds(window) { origin = it.positionInWindow() }) {
        val safe = modalSafeBounds(window, if (fullWindowCoordinates) Offset.Zero else origin,
            constraints.maxWidth.toFloat(), constraints.maxHeight.toFloat(), target)
        Box(Modifier.offset(with(density) { safe.left.toDp() }, with(density) { safe.top.toDp() })
            .width(with(density) { safe.width.toDp() }).height(with(density) { safe.height.toDp() })
            .clipToBounds(), contentAlignment = alignment, content = content)
    }
}

/** Constrain the native sheet before its own anchor modifier measures the available height. */
@Composable
internal fun Modifier.adaptiveModalViewport(): Modifier {
    val window = LocalRiffetWindowInfo.current
    // Preserve the native sheet's wrap height and anchor measurement on ordinary phones/Pad.
    // A full-window outer layout is only needed to place a physically separated viewport.
    if (window.folds.none { it.separating || it.occluding }) return this
    val target = LocalAdaptiveModalTarget.current
    val clipping = remember(window, target) { arrayOfNulls<Rect>(1) }
    return this.drawWithContent {
        val safe = clipping[0]
        if (safe == null) drawContent()
        else clipRect(safe.left, safe.top, safe.right, safe.bottom) { this@drawWithContent.drawContent() }
    }.layout { measurable, constraints ->
        if (separatingFold(window, Offset.Zero, constraints.maxWidth.toFloat(), constraints.maxHeight.toFloat()) == null) {
            clipping[0] = null
            val child = measurable.measure(constraints)
            return@layout layout(child.width, child.height) { child.place(0, 0) }
        }
        val safe = modalSafeBounds(window, Offset.Zero, constraints.maxWidth.toFloat(), constraints.maxHeight.toFloat(), target)
        clipping[0] = safe
        val child = measurable.measure(Constraints(minWidth = 0, minHeight = 0,
            maxWidth = safe.width.roundToInt().coerceAtLeast(0), maxHeight = safe.height.roundToInt().coerceAtLeast(0)))
        layout(constraints.maxWidth, constraints.maxHeight) {
            child.place(safe.left.roundToInt() + (safe.width.roundToInt() - child.width) / 2, safe.top.roundToInt())
        }
    }
}

private fun modalSafeBounds(window: RiffetWindowInfo, origin: Offset, width: Float, height: Float, target: Rect?): Rect {
    val fold = separatingFold(window, origin, width, height) ?: return Rect(0f, 0f, width, height)
    val point = target?.center?.minus(origin)
    return if (fold.vertical && point != null && point.x < fold.bounds.left) Rect(0f, 0f, fold.bounds.left, height)
        else if (fold.vertical && point != null && point.x > fold.bounds.right) Rect(fold.bounds.right, 0f, width, height)
        else if (!fold.vertical && point != null && point.y < fold.bounds.top) Rect(0f, 0f, width, fold.bounds.top)
        else if (!fold.vertical && point != null && point.y > fold.bounds.bottom) Rect(0f, fold.bounds.bottom, width, height)
        else largestSegment(fold, width, height)
}

internal val RiffetWindowInfo.hasSeparatingFold: Boolean get() = folds.any { it.separating || it.occluding }

/**
 * A layout's window position only matters against a separating fold, so it is tracked only then,
 * and only while its page is active: a covered page slides under the one above it, which would
 * move it every frame and recompose everything inside. It reports once more on becoming active.
 */
@Composable
internal fun Modifier.trackForFolds(window: RiffetWindowInfo, onPositioned: (LayoutCoordinates) -> Unit): Modifier {
    val active = LocalPageActive.current
    val reporting by rememberUpdatedState(active)
    val report by rememberUpdatedState(onPositioned)
    val last = remember { arrayOfNulls<LayoutCoordinates>(1) }
    LaunchedEffect(active) { if (active) last[0]?.takeIf { it.isAttached }?.let(report) }
    return if (window.hasSeparatingFold) onGloballyPositioned { last[0] = it; if (reporting) report(it) } else this
}

internal fun separatingFold(window: RiffetWindowInfo, origin: Offset, width: Float, height: Float): RiffetWindowFold? =
    window.folds.firstNotNullOfOrNull { fold ->
        if (!fold.separating && !fold.occluding) return@firstNotNullOfOrNull null
        val bounds = fold.bounds.translate(-origin)
        // A feature outside this child/window, or lying on its edge, must not create an empty pane.
        val intersects = if (fold.vertical) bounds.left > 0f && bounds.right < width && bounds.bottom > 0f && bounds.top < height
            else bounds.top > 0f && bounds.bottom < height && bounds.right > 0f && bounds.left < width
        if (intersects) fold.copy(bounds = bounds) else null
    }

internal fun largestSegment(fold: RiffetWindowFold, width: Float, height: Float): Rect =
    if (fold.vertical) {
        if (fold.bounds.left >= width - fold.bounds.right) Rect(0f, 0f, fold.bounds.left, height)
        else Rect(fold.bounds.right, 0f, width, height)
    } else {
        if (fold.bounds.top >= height - fold.bounds.bottom) Rect(0f, 0f, width, fold.bounds.top)
        else Rect(0f, fold.bounds.bottom, width, height)
    }
