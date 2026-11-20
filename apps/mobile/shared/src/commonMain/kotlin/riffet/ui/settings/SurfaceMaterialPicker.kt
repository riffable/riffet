package riffet.ui.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import org.jetbrains.compose.resources.stringResource
import riffet.shared.DisplaySettings
import riffet.shared.SurfaceMaterial
import riffet.ui.design.GroupRow
import riffet.ui.design.GroupRows
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.SelectionMark
import riffet.ui.design.RiffetSlider
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet_mobile.shared.generated.resources.*
import kotlin.math.roundToInt

@Composable
internal fun surfaceMaterialLabel(material: SurfaceMaterial): String = stringResource(when (material) {
    SurfaceMaterial.SOLID -> Res.string.settings_material_solid
    SurfaceMaterial.FROSTED -> Res.string.settings_material_frosted
    SurfaceMaterial.GLASS -> Res.string.settings_material_glass
    SurfaceMaterial.LIQUID -> Res.string.settings_material_liquid
})

@Composable
internal fun SurfaceMaterialPicker() {
    val display = DisplaySettings.shared
    val metrics = LocalInterfaceStyle.current.metrics
    val type = LocalRiffetTypography.current
    val colors = LocalRiffetColors.current
    SettingsGroup(stringResource(Res.string.settings_surface_material)) {
        GroupRows(Modifier.selectableGroup()) {
            SurfaceMaterial.entries.forEach { material ->
                val selected = material == display.surfaceMaterial
                GroupRow(
                    title = surfaceMaterialLabel(material),
                    trailing = { SelectionMark(selected) },
                    modifier = Modifier.selectable(selected, role = Role.RadioButton) { display.changeSurfaceMaterial(material) },
                )
            }
        }
        if (display.surfaceMaterial != SurfaceMaterial.SOLID) {
            val strengthLabel = stringResource(Res.string.settings_material_strength)
            val controlLabel = surfaceMaterialLabel(display.surfaceMaterial) + " " + strengthLabel
            Column(Modifier.fillMaxWidth().padding(horizontal = metrics.rowPadding, vertical = metrics.controlInset / 2)) {
                Row {
                    Text(strengthLabel, style = type.body, color = colors.fg, modifier = Modifier.weight(1f))
                    Text((display.materialStrength * 100).roundToInt().toString() + "%", style = type.bodySmall, color = colors.fg3)
                }
                RiffetSlider(value = display.materialStrength, onValueChange = display::changeMaterialStrength,
                    modifier = Modifier.semantics { contentDescription = controlLabel })
            }
        }
    }
    SettingsFootnote(stringResource(Res.string.settings_style_footnote))
}
