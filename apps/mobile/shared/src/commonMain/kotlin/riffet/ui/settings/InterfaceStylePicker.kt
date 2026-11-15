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
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet_mobile.shared.generated.resources.*

@Composable
internal fun interfaceStyleLabel(style: InterfaceStyle): String = stringResource(when (style) {
    InterfaceStyle.MATERIAL3 -> Res.string.settings_style_material
    InterfaceStyle.EXPRESSIVE -> Res.string.settings_style_expressive
    InterfaceStyle.MIUIX -> Res.string.settings_style_miuix
    InterfaceStyle.FLUENT -> Res.string.settings_style_fluent
    InterfaceStyle.IOS -> Res.string.settings_style_ios
})

/** Each style as a thumbnail of a row, a button and the tab bar in its own shapes, two to a line. */
@Composable
internal fun InterfaceStylePicker() {
    val display = DisplaySettings.shared
    val metrics = LocalInterfaceStyle.current.metrics
    // A titled group without a card draws only its title; the grid follows it.
    SettingsGroup(stringResource(Res.string.settings_interface_style), card = false) {}
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

/** A page of the style: one list row, one button and the tab bar, with the style's own corner radii at half size. */
@Composable
private fun StylePreview(style: InterfaceStyle, shape: RoundedCornerShape, modifier: Modifier) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val surfaces = LocalRiffetSurfaces.current
    val target = remember(style) { resolveDesign(style, null, false).metrics }
    val scale = 0.5f
    val inset = metrics.controlInset * 2 / 3
    val line = metrics.hairlineWidth * 3
    // A tinted page with a hairline, so the white row and tab bar read as cards on it.
    Column(
        modifier.clip(shape).background(colors.bgSubtle).border(metrics.hairlineWidth, colors.line, shape).padding(inset),
        verticalArrangement = Arrangement.spacedBy(inset),
    ) {
        Row(
            Modifier.fillMaxWidth().height(metrics.controlHeight * 0.6f)
                .clip(RoundedCornerShape(target.groupRadius * scale)).background(colors.bgElevated).padding(horizontal = inset),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(line)) {
                Box(Modifier.fillMaxWidth(0.55f).height(line).clip(CircleShape).background(colors.fg2))
                Box(Modifier.fillMaxWidth(0.35f).height(line).clip(CircleShape).background(colors.fg4))
            }
            Box(Modifier.size(line * 2).clip(CircleShape).background(colors.fg4))
        }
        Box(Modifier.fillMaxWidth(0.45f).height(metrics.controlHeight * 0.4f).clip(RoundedCornerShape(target.controlRadius * scale)).background(colors.accent))
        Spacer(Modifier.weight(1f))
        Row(
            Modifier.fillMaxWidth().height(metrics.controlHeight * 0.55f)
                .clip(RoundedCornerShape(target.composerRadius * scale)).background(colors.bgElevated),
            horizontalArrangement = Arrangement.SpaceEvenly,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            repeat(3) { index ->
                Box(Modifier.size(line * 3).clip(RoundedCornerShape(target.selectionRadius * scale)).background(if (index == 0) colors.accent else colors.fg4))
            }
        }
    }
}
