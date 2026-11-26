package riffet.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import org.jetbrains.compose.resources.stringResource
import riffet.shared.DisplaySettings
import riffet.shared.InterfaceStyle
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.LocalRiffetSurfaces
import riffet.ui.design.resolveDesign
import riffet.ui.icons.Icon
import riffet.ui.icons.RiffetIcons
import riffet.ui.design.riffetSurfaces
import riffet.ui.design.NavigationPresentation
import riffet.ui.design.NavigationIndicator
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.width
import androidx.compose.ui.unit.dp
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet_mobile.shared.generated.resources.*

@Composable
internal fun interfaceStyleLabel(style: InterfaceStyle): String = stringResource(when (style) {
    InterfaceStyle.RIFFET -> Res.string.settings_style_riffet
    InterfaceStyle.MATERIAL3 -> Res.string.settings_style_material
})

/** Each style as a thumbnail of a row, a button and the tab bar in its own shapes, two to a line. */
@Composable
internal fun InterfaceStylePicker() {
    val display = DisplaySettings.shared
    val metrics = LocalInterfaceStyle.current.metrics
    // The page's title already names the grid; an untitled group keeps the page's top spacing.
    SettingsGroup("", card = false) {}
    run {
        Column(Modifier.fillMaxWidth().selectableGroup(), verticalArrangement = Arrangement.spacedBy(metrics.sectionGap / 2)) {
            InterfaceStyle.entries.chunked(2).forEach { pair ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(metrics.sectionGap / 2)) {
                    pair.forEach { style ->
                        StyleCard(style, style == display.interfaceStyle, { display.changeInterfaceStyle(style) }, Modifier.weight(1f))
                    }
                    if (pair.size == 1) Box(Modifier.weight(1f))
                }
            }
        }
    }
    SurfaceMaterialPicker()
}

@Composable
private fun StyleCard(style: InterfaceStyle, selected: Boolean, onSelect: () -> Unit, modifier: Modifier) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    // The ring sits a gap outside the preview with a concentric corner (as the theme gallery's cards).
    val gap = metrics.focusWidth * 1.5f
    val ring = metrics.focusWidth
    val radius = metrics.controlRadius
    val outer = RoundedCornerShape(radius + gap + ring)
    Column(
        modifier = modifier.selectable(selected = selected, role = Role.RadioButton, onClick = onSelect),
        verticalArrangement = Arrangement.spacedBy(metrics.controlInset / 2),
    ) {
        Box(
            Modifier.fillMaxWidth().clip(outer)
                .border(ring, if (selected) colors.accent else Color.Transparent, outer)
                .padding(ring + gap),
        ) {
            StylePreview(style, RoundedCornerShape(radius), Modifier.fillMaxWidth().height(metrics.controlHeight * 2.6f))
            if (selected) Box(
                Modifier.align(Alignment.TopEnd).padding(metrics.controlInset / 2).size(metrics.smallIconSize * 1.25f)
                    .border(metrics.focusWidth, colors.bg, CircleShape).padding(metrics.focusWidth)
                    .clip(CircleShape).background(colors.accent),
                contentAlignment = Alignment.Center,
            ) { Icon(RiffetIcons.Check, contentDescription = null, tint = colors.accentFg, modifier = Modifier.size(metrics.smallIconSize * 0.8f)) }
        }
        Text(
            interfaceStyleLabel(style),
            style = LocalRiffetTypography.current.subhead,
            color = colors.fg,
            fontWeight = if (selected) FontWeight.SemiBold else null,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(horizontal = ring + gap),
        )
    }
}

/**
 * A page of the style, drawn from its own recipes at half size: a card with a row, the primary
 * action, and the tab bar (flat or floating, with the style's selection mark), on the style's page.
 */
@Composable
private fun StylePreview(style: InterfaceStyle, shape: RoundedCornerShape, modifier: Modifier) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val dark = LocalRiffetSurfaces.current.dark
    val design = remember(style) { resolveDesign(style, null, false) }
    val target = design.metrics
    val recipe = design.preset.components
    val look = remember(style, colors, dark) { riffetSurfaces(colors, dark, recipe.surfaces) }
    val scale = 0.5f
    val inset = metrics.controlInset * 2 / 3
    val line = metrics.hairlineWidth * 3
    val floating = design.variants.navigation == NavigationPresentation.FLOATING
    val cardShape = RoundedCornerShape(target.groupRadius * scale)
    Column(modifier.clip(shape).background(look.page).border(metrics.hairlineWidth, colors.line, shape)) {
        Column(Modifier.weight(1f).padding(inset), verticalArrangement = Arrangement.spacedBy(inset)) {
            Row(
                Modifier.fillMaxWidth().height(metrics.controlHeight * 0.6f).clip(cardShape).background(look.card).padding(horizontal = inset),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(line)) {
                    Box(Modifier.fillMaxWidth(0.55f).height(line).clip(CircleShape).background(colors.fg2))
                    Box(Modifier.fillMaxWidth(0.35f).height(line).clip(CircleShape).background(colors.fg4))
                }
                Box(Modifier.size(line * 2).clip(CircleShape).background(colors.fg4))
            }
            Box(Modifier.fillMaxWidth(0.45f).height(metrics.controlHeight * 0.4f).clip(RoundedCornerShape(target.controlRadius * scale)).background(look.primaryAction))
        }
        val barShape = if (floating) CircleShape else RoundedCornerShape(0.dp)
        Box(Modifier.fillMaxWidth().padding(horizontal = if (floating) inset * 2 else 0.dp).padding(bottom = if (floating) inset else 0.dp)) {
            Row(
                Modifier.fillMaxWidth().height(metrics.controlHeight * 0.5f).clip(barShape).background(look.card)
                    .then(if (recipe.navigation.divider || !floating) Modifier.border(metrics.hairlineWidth, look.hairline, barShape) else Modifier),
                horizontalArrangement = Arrangement.SpaceEvenly,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                repeat(3) { index ->
                    val on = index == 0
                    val ink = if (!on) colors.fg4 else if (recipe.navigation.accentSelection) colors.primary else colors.fg
                    val mark = recipe.navigation.indicator
                    Box(Modifier.fillMaxHeight().width(line * 9), contentAlignment = Alignment.Center) {
                        if (on && mark == NavigationIndicator.FILL) Box(Modifier.fillMaxHeight(0.72f).fillMaxWidth().clip(CircleShape).background(look.selected))
                        if (on && mark == NavigationIndicator.TOP_LINE) Box(Modifier.align(Alignment.TopCenter).fillMaxWidth(0.6f).height(line * 0.6f).background(ink))
                        if (on && mark == NavigationIndicator.BOTTOM_DOT) Box(Modifier.align(Alignment.BottomCenter).padding(bottom = line * 0.6f).size(line).clip(CircleShape).background(ink))
                        Box(Modifier.size(line * 2.6f).clip(RoundedCornerShape(target.selectionRadius * scale)).background(ink))
                    }
                }
            }
        }
    }
}
