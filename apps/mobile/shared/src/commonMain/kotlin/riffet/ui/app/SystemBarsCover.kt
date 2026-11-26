package riffet.ui.app

import riffet.ui.theme.appearancePageBackground

import riffet.ui.theme.LocalRiffetColors
import androidx.compose.material3.MaterialTheme
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.union
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.unit.Constraints

/*
 * The app is edge to edge, and `RiffetApp` pads every page away from the status and navigation
 * bars. These helpers are for what has to reach under the bars anyway: a page's own colour, and the
 * overlays (drawers, sheets) whose scrim and surface run the full height of the screen.
 *
 * The bars' raw sizes are read rather than the remaining insets, because the page has consumed them.
 */

/**
 * Grows this layer over the system bars around it: the status bar above, the navigation bar below
 * and, in landscape, the navigation bar at a side — what the Scaffold's `systemBars` padding took.
 * An animated layer can restore the same [bars] inside it to keep content in the safe area.
 */
@Composable
internal fun Modifier.coverSystemBars(bars: PaddingValues = systemBarsPadding(includeDisplayCutout = false)): Modifier {
    val density = LocalDensity.current
    val direction = LocalLayoutDirection.current
    val top = with(density) { bars.calculateTopPadding().roundToPx() }
    val bottom = with(density) { bars.calculateBottomPadding().roundToPx() }
    val left = with(density) { bars.calculateLeftPadding(direction).roundToPx() }
    val right = with(density) { bars.calculateRightPadding(direction).roundToPx() }
    return layout { measurable, constraints ->
        // During a parent size transition an axis may be unbounded (Int.MAX_VALUE). Adding bar
        // insets to that sentinel overflows to a negative size, which crashes Constraints.fixed.
        if (!constraints.hasBoundedWidth || !constraints.hasBoundedHeight) {
            val placeable = measurable.measure(constraints)
            layout(placeable.width, placeable.height) { placeable.place(0, 0) }
        } else {
            val width = (constraints.maxWidth.toLong() + left + right).coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
            val height = (constraints.maxHeight.toLong() + top + bottom).coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
            val placeable = measurable.measure(Constraints.fixed(width, height))
            layout(constraints.maxWidth, constraints.maxHeight) { placeable.place(-left, -top) }
        }
    }
}

/**
 * What content laid out inside [coverSystemBars] keeps clear of: the status bar above, the
 * navigation bar below and, at the sides, a landscape navigation bar or the display cutout.
 * Absolute, because a drawer pads only the side it touches.
 * Background expansion excludes the cutout: a pane may sit beside a navigation rail rather than
 * at the physical screen edge. Its content still keeps the usual cutout padding.
 */
@Composable
internal fun systemBarsPadding(includeDisplayCutout: Boolean = true): PaddingValues {
    val density = LocalDensity.current
    val direction = LocalLayoutDirection.current
    val sides = if (includeDisplayCutout) WindowInsets.navigationBars.union(WindowInsets.displayCutout)
        else WindowInsets.systemBars
    return with(density) {
        PaddingValues.Absolute(
            left = sides.getLeft(density, direction).toDp(),
            top = WindowInsets.statusBars.getTop(density).toDp(),
            right = sides.getRight(density, direction).toDp(),
            bottom = WindowInsets.navigationBars.getBottom(density).toDp(),
        )
    }
}

/** Every page's background, the tabs' and the pushed pages' alike. */
@Composable
internal fun pageColor(): Color = LocalRiffetColors.current.bg

/**
 * The app's one card treatment on [pageColor]: the surfaces' card, one step from the page under it. A settings
 * group, a statistics or Git card, a download row and a notice banner all use it.
 */
@Composable
internal fun cardColor(): Color = riffet.ui.design.LocalRiffetSurfaces.current.card

/** The root backdrop owns the system insets, so page transitions never expose a solid inset fill. */
@Composable
internal fun Modifier.pageBackground(color: Color): Modifier = appearancePageBackground(color)
