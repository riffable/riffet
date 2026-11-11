package riffet.ui.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import org.jetbrains.compose.resources.stringResource
import riffet.shared.DisplaySettings
import riffet.shared.InterfaceStyle
import riffet.ui.design.GroupRow
import riffet.ui.design.SelectionMark
import riffet_mobile.shared.generated.resources.*

@Composable
internal fun interfaceStyleLabel(style: InterfaceStyle): String = stringResource(when (style) {
    InterfaceStyle.MATERIAL3 -> Res.string.settings_style_material
    InterfaceStyle.EXPRESSIVE -> Res.string.settings_style_expressive
    InterfaceStyle.MIUIX -> Res.string.settings_style_miuix
    InterfaceStyle.FLUENT -> Res.string.settings_style_fluent
    InterfaceStyle.IOS -> Res.string.settings_style_ios
})

@Composable
internal fun InterfaceStylePicker() {
    val display = DisplaySettings.shared
    SettingsGroup(stringResource(Res.string.settings_interface_style)) {
        Column(Modifier.selectableGroup()) {
            InterfaceStyle.entries.forEach { style ->
                val selected = style == display.interfaceStyle
                GroupRow(
                    title = interfaceStyleLabel(style),
                    trailing = { SelectionMark(selected) },
                    modifier = Modifier.selectable(selected, role = Role.RadioButton) { display.changeInterfaceStyle(style) },
                )
            }
        }
    }
    SurfaceMaterialPicker()
}
