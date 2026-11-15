package riffet.ui.settings

import riffet.ui.design.LocalInterfaceStyle
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import riffet.ui.design.GroupRow
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

@Composable
internal fun IconPackPicker(state: IconPackState) {
    val metrics = LocalInterfaceStyle.current.metrics
    LaunchedEffect(state) { state.refresh() }
    val colors = LocalRiffetColors.current
    SettingsGroup(title = stringResource(Res.string.settings_icon_pack)) {
        Column(Modifier.selectableGroup()) {
            state.choices.forEach { choice ->
                val selected = choice.id == state.selected
                val title = choice.title[Locale.current.toLanguageTag()] ?: choice.title[Locale.current.language]
                    ?: (if (Locale.current.language == "zh") choice.title["zh-Hans"] else null)
                    ?: choice.title["en"] ?: choice.title.values.firstOrNull().orEmpty()
                val preview = BuiltinIconPacks.forId(choice.id) ?: if (selected) state.vectors else null
                GroupRow(
                    title = title,
                    leading = {
                        // The pack's own glyphs, drawn from it before it is chosen.
                        if (preview != null) CompositionLocalProvider(LocalIconVectors provides preview) {
                            Row(horizontalArrangement = Arrangement.spacedBy(metrics.controlInset)) {
                                listOf(RiffetIcons.Message, RiffetIcons.Folder, RiffetIcons.Settings).forEach {
                                    Icon(it, null, Modifier.size(metrics.iconSize), colors.fg2)
                                }
                            }
                        } else Icon(RiffetIcons.Puzzle, null, Modifier.size(metrics.iconSize), colors.fg3)
                    },
                    trailing = { riffet.ui.design.SelectionMark(selected) },
                    modifier = Modifier.selectable(selected, role = Role.RadioButton) { state.select(choice.id) },
                )
            }
        }
    }
    SettingsFootnote(stringResource(Res.string.settings_icon_pack_footnote))
    if (state.loading) SettingsFootnote(stringResource(Res.string.settings_icon_pack_loading))
    if (state.unavailable) {
        SettingsFootnote(stringResource(Res.string.settings_icon_pack_unavailable))
        SettingsGroup("") { SettingsActionRow(stringResource(Res.string.settings_retry), onClick = state::refresh) }
    }
}
