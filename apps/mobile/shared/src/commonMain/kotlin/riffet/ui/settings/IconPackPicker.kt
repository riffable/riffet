package riffet.ui.settings

import riffet.ui.design.LocalInterfaceStyle
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material3.Text
import riffet.ui.design.RiffetTextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.intl.Locale
import androidx.compose.ui.unit.dp
import org.jetbrains.compose.resources.stringResource
import riffet_mobile.shared.generated.resources.*
import riffet.ui.icons.*
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography

@Composable
internal fun IconPackPicker(state: IconPackState) {
    val metrics = LocalInterfaceStyle.current.metrics
    LaunchedEffect(state) { state.refresh() }
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    SettingsGroup(title = stringResource(Res.string.settings_icon_pack)) {
        Column(Modifier.selectableGroup()) {
            state.choices.forEach { choice ->
                val selected = choice.id == state.selected
                Row(
                    Modifier.fillMaxWidth().selectable(selected, role = Role.RadioButton) { state.select(choice.id) }
                        .padding(horizontal = 16.dp, vertical = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(metrics.sectionGap / 2),
                ) {
                    val title = choice.title[Locale.current.toLanguageTag()] ?: choice.title[Locale.current.language]
                        ?: (if (Locale.current.language == "zh") choice.title["zh-Hans"] else null)
                        ?: choice.title["en"] ?: choice.title.values.firstOrNull().orEmpty()
                    Text(title, style = typography.body, color = colors.fg, modifier = Modifier.weight(1f))
                    val preview = BuiltinIconPacks.forId(choice.id) ?: if (selected) state.vectors else null
                    if (preview != null) CompositionLocalProvider(LocalIconVectors provides preview) {
                        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            listOf(RiffetIcons.Message, RiffetIcons.Folder, RiffetIcons.Settings).forEach {
                                Icon(it, null, Modifier.size(22.dp), colors.fg2)
                            }
                        }
                    } else Icon(RiffetIcons.Puzzle, null, Modifier.size(22.dp), colors.fg3)
                    riffet.ui.design.SelectionMark(selected)
                }
            }
        }
    }
    SettingsFootnote(stringResource(Res.string.settings_icon_pack_footnote))
    if (state.loading) SettingsFootnote(stringResource(Res.string.settings_icon_pack_loading))
    if (state.unavailable) {
        SettingsFootnote(stringResource(Res.string.settings_icon_pack_unavailable))
        RiffetTextButton(onClick = state::refresh) { Text(stringResource(Res.string.settings_retry)) }
    }
}
