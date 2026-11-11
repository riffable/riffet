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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
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
import androidx.compose.ui.unit.dp
import riffet.ui.theme.LocalRiffetColors

/** One destination of a [RiffetTabBar]. */
internal class TabBarItem(val icon: ImageVector, val selectedIcon: ImageVector, val label: String, val badge: Int = 0)

/** Destination hit regions fill the bar; selected faces stay at icon scale. */
@Composable
internal fun RiffetTabBar(
    items: List<TabBarItem>,
    selected: Int,
    onSelect: (Int) -> Unit,
    modifier: Modifier = Modifier,
    onReselect: () -> Unit = {},
) {
    val style = LocalInterfaceStyle.current
    val recipe = style.components.navigation
    val metrics = style.metrics
    val motion = LocalRiffetMotion.current
    val s = surfaces
    val colors = LocalRiffetColors.current
    // The island's geometry is the same under every material; SOLID only swaps blur for a plain fill.
    val panelShape = RoundedCornerShape(50)
    Box(modifier.fillMaxWidth()
        .padding(horizontal = maxOf(24.dp, metrics.tabBarInset))
        .padding(bottom = maxOf(10.dp, metrics.tabBarBottomInset)),
        contentAlignment = Alignment.Center) {
        val panel = Modifier
            .widthIn(max = 400.dp)
            .fillMaxWidth(0.86f)
            .height(maxOf(56.dp, metrics.controlHeight))
            .floatingShadow(panelShape).clip(panelShape)
            .riffetMaterial(MaterialRole.NAVIGATION, panelShape, if (recipe.cardSurface) s.card else s.navigation)
        Row(panel.selectableGroup()) {
            RiffetMaterialContent {
                items.forEachIndexed { index, item ->
                    val on = selected == index
                    val source = remember { MutableInteractionSource() }
                    val focused by source.collectIsFocusedAsState()
                    val faceShape = RoundedCornerShape(50)
                    val faceColor by animateColorAsState(
                        if (on) s.selected.copy(alpha = 0.32f) else s.selected.copy(alpha = 0f), motion.effects(), label = "tabFace",
                    )
                    val tint by animateColorAsState(
                        if (on && recipe.accentSelection) s.focus else if (on) s.selectedContent else colors.fg,
                        motion.effects(), label = "tabInk",
                    )
                    Box(Modifier.weight(1f).fillMaxHeight()
                        .selectable(on, role = Role.Tab, interactionSource = source, indication = null,
                            onClick = { if (on) onReselect() else onSelect(index) }), contentAlignment = Alignment.Center) {
                        // Equal slot insets keep each end face concentric with the outer capsule.
                        Box(Modifier.fillMaxSize().padding(4.dp)
                            .clip(faceShape).riffetMaterial(MaterialRole.CONTROL, faceShape, faceColor, source)
                            .then(if (focused) Modifier.border(metrics.focusWidth, s.focus, faceShape) else Modifier)
                            .indication(source, androidx.compose.foundation.LocalIndication.current), contentAlignment = Alignment.Center) {
                            BadgedBox(badge = { if (item.badge > 0) Badge { Text(if (item.badge > 99) "99+" else item.badge.toString()) } }) {
                                Icon(if (on) item.selectedIcon else item.icon, item.label, Modifier.size(metrics.iconSize), tint)
                            }
                        }
                    }
                }
            }
        }
    }
}
