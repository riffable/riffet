package riffet.ui.design

import riffet.ui.theme.LocalRiffetMotion
import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.border
import androidx.compose.foundation.background
import androidx.compose.foundation.indication
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import riffet.ui.icons.Icon
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.semantics.Role
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.layout
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.util.lerp
import kotlin.math.roundToInt
import riffet.ui.theme.LocalRiffetColors

/** One destination of a [RiffetTabBar]. */
internal class TabBarItem(val icon: ImageVector, val selectedIcon: ImageVector, val label: String, val badge: Int = 0)

/** The bar's visible height, and its gap to the page's bottom edge. */
internal val DesignMetrics.tabBarPanelHeight: Dp get() = maxOf(56.dp, controlHeight)
internal val DesignMetrics.tabBarGap: Dp get() = maxOf(10.dp, tabBarBottomInset)

/** The folded bar: a disc as tall as the resting composer it sits beside. */
internal val DesignMetrics.tabDockSize: Dp get() = inputMinHeight

/** The room a docked composer leaves at its start for the folded bar. */
internal val DesignMetrics.tabDockInset: Dp get() = tabDockSize + controlInset * 2 / 3

/**
 * The first stretch of the keyboard's rise, over which a docked composer opens its tools and widens
 * past the folded bar: both are done by the time it has cleared the disc by its own height.
 */
internal val DesignMetrics.keyboardUnfoldSpan: Dp get() = tabDockInset * 9 / 5

/** A session composer's own gap to the page's bottom edge. */
internal val DesignMetrics.composerBottomGap: Dp get() = maxOf(12.dp, tabBarBottomInset)

/** What a page keeps under a docked composer, so the resting composer and the bar share one centre line. */
internal val DesignMetrics.tabDockBottomPadding: Dp
    get() = (tabBarGap + (tabBarPanelHeight - tabDockSize) / 2 - composerBottomGap).coerceAtLeast(0.dp)

/** The whole bar's width, measured by the bar and read by its row in the same pass. */
private class BarGeometry { var full = 0 }

/**
 * Destination hit regions fill the bar; selected faces stay at icon scale.
 *
 * Beside a docked composer the bar folds to its current destination: one disc at the page's start
 * edge, on the composer's line. [fold] runs from 0 (whole) to 1 (folded) and is read while laying
 * out and drawing only; [folded] is where it is heading. Tapping the folded disc calls [onUnfold].
 */
@Composable
internal fun RiffetTabBar(
    items: List<TabBarItem>,
    selected: Int,
    onSelect: (Int) -> Unit,
    modifier: Modifier = Modifier,
    onReselect: () -> Unit = {},
    folded: Boolean = false,
    fold: () -> Float = { 0f },
    onUnfold: () -> Unit = {},
) {
    val style = LocalInterfaceStyle.current
    val recipe = style.components.navigation
    val metrics = style.metrics
    val motion = LocalRiffetMotion.current
    val s = surfaces
    val colors = LocalRiffetColors.current
    // The island's geometry is the same under every material; SOLID only swaps blur for a plain fill.
    val panelShape = RoundedCornerShape(50)
    val geometry = remember { BarGeometry() }
    val pill = animateFloatAsState(selected.toFloat(), motion.spatial(), label = "tabPill")
    // Folded, the disc itself says where you are; the face would only repeat its outline.
    val face by animateColorAsState(s.selected.copy(alpha = if (folded) 0f else 0.32f), motion.effects(), label = "tabFace")
    // What the folded disc hides: the other destinations' counts.
    val elsewhere = items.sumOf { it.badge } - (items.getOrNull(selected)?.badge ?: 0)
    Layout(
        content = {
            Box(Modifier
                .floatingShadow(panelShape).clip(panelShape)
                .riffetMaterial(MaterialRole.NAVIGATION, panelShape, if (recipe.cardSurface) s.card else s.navigation)
                // One face for the whole bar: it travels to the chosen destination on the spatial spring.
                .drawBehind {
                    val full = geometry.full.toFloat()
                    if (full <= 0f || items.isEmpty()) return@drawBehind
                    val slot = full / items.size
                    val inset = 4.dp.toPx()
                    val leading = slot * selected + slot / 2f
                    val centre = if (layoutDirection == LayoutDirection.Rtl) full - leading else leading
                    val shift = (centre - size.width / 2f) * fold()
                    val start = slot * pill.value
                    val x = (if (layoutDirection == LayoutDirection.Rtl) full - start - slot else start) - shift
                    drawRoundRect(face, topLeft = Offset(x + inset, inset), size = Size(slot - inset * 2, size.height - inset * 2),
                        cornerRadius = CornerRadius(size.height / 2f))
                }) {
                // The row keeps the whole bar's width while the panel narrows around it, and slides
                // so the current destination ends up in the disc's centre.
                Row(Modifier.selectableGroup().layout { measurable, constraints ->
                    val full = geometry.full
                    val placeable = measurable.measure(Constraints.fixed(full, constraints.maxHeight))
                    val slot = full / items.size.coerceAtLeast(1)
                    val leading = slot * selected + slot / 2f
                    val centre = if (layoutDirection == LayoutDirection.Rtl) full - leading else leading
                    val shift = ((centre - constraints.maxWidth / 2f) * fold()).roundToInt()
                    layout(constraints.maxWidth, constraints.maxHeight) { placeable.place(-shift, 0) }
                }) {
                    RiffetMaterialContent {
                        items.forEachIndexed { index, item ->
                            val on = selected == index
                            val source = remember { MutableInteractionSource() }
                            val focused by source.collectIsFocusedAsState()
                            val faceShape = RoundedCornerShape(50)
                            // The chosen icon settles to full size on the same spring the face arrives on.
                            val settle = animateFloatAsState(if (on) 1f else 0.9f, motion.spatial(), label = "tabSettle")
                            val tint by animateColorAsState(
                                if (on && !folded && recipe.accentSelection) s.focus else if (on && !folded) s.selectedContent else colors.fg,
                                motion.effects(), label = "tabInk",
                            )
                            Box(Modifier.weight(1f).fillMaxHeight()
                                .graphicsLayer { alpha = if (on) 1f else 1f - fold() }
                                // Folded, the current destination's slot is the whole disc. A disabled slot still takes
                                // its touches, so the others cannot be reached through the disc's edge.
                                .selectable(on, enabled = on || !folded, role = Role.Tab, interactionSource = source, indication = null,
                                    onClick = { if (folded) onUnfold() else if (on) onReselect() else onSelect(index) }), contentAlignment = Alignment.Center) {
                                // Equal slot insets keep each end face concentric with the outer capsule.
                                Box(Modifier.fillMaxSize().padding(4.dp)
                                    .clip(faceShape)
                                    .then(if (focused) Modifier.border(metrics.focusWidth, s.focus, faceShape) else Modifier)
                                    .indication(source, androidx.compose.foundation.LocalIndication.current), contentAlignment = Alignment.Center) {
                                    BadgedBox(badge = { if (item.badge > 0) Badge { Text(if (item.badge > 99) "99+" else item.badge.toString()) } }) {
                                        Icon(if (on) item.selectedIcon else item.icon, item.label,
                                            Modifier.size(metrics.iconSize).graphicsLayer { scaleX = settle.value; scaleY = settle.value }, tint)
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Box(Modifier.graphicsLayer { alpha = fold() }) {
                if (elsewhere > 0) Badge { Text(if (elsewhere > 99) "99+" else elsewhere.toString()) }
            }
        },
        modifier = modifier.fillMaxWidth().padding(bottom = metrics.tabBarGap),
    ) { measurables, constraints ->
        val t = fold()
        val side = maxOf(24.dp, metrics.tabBarInset).roundToPx()
        val full = minOf(400.dp.roundToPx(), ((constraints.maxWidth - 2 * side) * 0.86f).roundToInt()).coerceAtLeast(0)
        geometry.full = full
        val height = metrics.tabBarPanelHeight.roundToPx()
        val disc = metrics.tabDockSize.roundToPx()
        val width = lerp(full, disc, t)
        val panelHeight = lerp(height, disc, t)
        val panel = measurables[0].measure(Constraints.fixed(width, panelHeight))
        val badge = measurables[1].measure(Constraints())
        layout(constraints.maxWidth, height) {
            val inset = metrics.pageInset.roundToPx()
            val docked = if (layoutDirection == LayoutDirection.Rtl) constraints.maxWidth - inset - disc else inset
            val x = lerp((constraints.maxWidth - full) / 2, docked, t)
            val y = (height - panelHeight) / 2
            panel.place(x, y)
            badge.place(x + width - badge.width * 3 / 4, y - badge.height / 4)
        }
    }
}
