package riffet.ui.settings

import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.graphics.vector.ImageVector
import org.jetbrains.compose.resources.StringResource
import org.jetbrains.compose.resources.stringResource
import riffet.shared.AppLanguage
import riffet.shared.AppLanguages
import riffet.shared.DeviceControl
import riffet.shared.DisplaySettings
import riffet.shared.NativeFeature
import riffet.shared.appLanguageSupported
import riffet.shared.supported
import riffet.ui.icons.IconPackState
import riffet.ui.icons.RiffetIcons
import riffet.shared.ThemeMode
import riffet.ui.theme.ThemeEntry
import riffet_mobile.shared.generated.resources.*

/** Settings groups describe broad areas; each listed page has one concrete responsibility. */
internal enum class SettingsSection(
    val title: StringResource,
    val group: StringResource?,
    val icon: ImageVector,
    val serverSettings: Boolean = false,
) {
    LANGUAGE(Res.string.settings_language, Res.string.settings_general, RiffetIcons.Globe),
    EXTENSIONS(Res.string.settings_extra_section_extensions, Res.string.settings_general, RiffetIcons.Puzzle),
    DEVICES(Res.string.settings_extra_section_devices, Res.string.settings_general, RiffetIcons.Shield),
    STYLE(Res.string.settings_interface_style, Res.string.settings_appearance, RiffetIcons.Layers),
    APPEARANCE(Res.string.settings_theme, Res.string.settings_appearance, RiffetIcons.Palette),
    TYPOGRAPHY(Res.string.settings_typography, Res.string.settings_appearance, RiffetIcons.FileText),
    ICONS(Res.string.settings_icons, Res.string.settings_appearance, RiffetIcons.Image),
    MOTION(Res.string.settings_motion, Res.string.settings_appearance, RiffetIcons.Sliders),
    GESTURES(Res.string.settings_gestures, Res.string.settings_group_behavior, RiffetIcons.Pointer),
    INTERACTION(Res.string.settings_input, Res.string.settings_group_behavior, RiffetIcons.Reply, true),
    NOTIFICATIONS(Res.string.settings_notifications, Res.string.settings_group_behavior, RiffetIcons.Bell),
    FILES(Res.string.settings_extra_section_files, Res.string.settings_group_behavior, RiffetIcons.FilePenLine, true),
    BACKENDS(Res.string.settings_model_settings, Res.string.settings_group_models, RiffetIcons.Bot, true),
    AUXILIARY(Res.string.settings_auxiliary_models, Res.string.settings_group_models, RiffetIcons.Brain, true),
    QUICK_CHAT(Res.string.settings_extra_section_quick_chat, Res.string.settings_group_models, RiffetIcons.Message, true),
    CONNECTION(Res.string.settings_connection_access, Res.string.settings_group_connection, RiffetIcons.Monitor),
    SERVICE(Res.string.settings_extra_section_service, Res.string.settings_group_connection, RiffetIcons.Chart),
    DIAGNOSTICS(Res.string.settings_extra_section_diagnostics, Res.string.settings_extra_group_support, RiffetIcons.Bug),
    ABOUT(Res.string.settings_extra_section_about, Res.string.settings_extra_group_support, RiffetIcons.Info);

    val label: String @Composable get() = stringResource(title)

    val available: Boolean get() = when (this) {
        LANGUAGE -> appLanguageSupported
        NOTIFICATIONS -> NativeFeature.ALERTS.supported || NativeFeature.BACKGROUND_WATCH.supported
        else -> true
    }
}

@Composable
internal fun appLanguageLabel(language: AppLanguage): String = stringResource(when (language) {
    AppLanguage.SYSTEM -> Res.string.settings_language_system
    AppLanguage.CHINESE -> Res.string.settings_language_chinese
    AppLanguage.ENGLISH -> Res.string.settings_language_english
})

@Composable
internal fun SectionList(
    themeMode: ThemeMode, themes: List<ThemeEntry>, themeId: String, server: String,
    iconPacks: IconPackState, onSelect: (SettingsSection) -> Unit,
) {
    val display = DisplaySettings.shared
    val mode = stringResource(when (themeMode) {
        ThemeMode.SYSTEM -> Res.string.settings_theme_mode_system
        ThemeMode.LIGHT -> Res.string.settings_theme_mode_light
        ThemeMode.DARK -> Res.string.settings_theme_mode_dark
    })
    val appearance = riffet.ui.theme.LocalAppearanceResources.current
    val theme = appearance?.effective?.palette?.title?.let { riffet.ui.theme.localizedAppearanceTitle(it) }
        ?: themes.firstOrNull { it.id == themeId }?.name ?: themes.first().name
    val deviceAllowed by DeviceControl.allowed.collectAsState()
    val entries = SettingsSection.entries.filter { it.available }
    entries.groupBy { it.group }.forEach { (group, sections) ->
        SettingsGroup(group?.let { stringResource(it) }.orEmpty()) {
            sections.forEach { section ->
                val summary = when (section) {
                    SettingsSection.LANGUAGE -> appLanguageLabel(AppLanguages.current)
                    SettingsSection.STYLE -> interfaceStyleLabel(display.interfaceStyle) + " · " + surfaceMaterialLabel(display.surfaceMaterial)
                    SettingsSection.APPEARANCE -> stringResource(Res.string.settings_theme_summary, theme, mode)
                    SettingsSection.TYPOGRAPHY -> textSizeLabel(display.textSize) + " · " + spacingLabel(display.spacing)
                    SettingsSection.ICONS -> iconPacks.choices.firstOrNull { it.id == iconPacks.selected }?.title
                        ?.let { riffet.ui.theme.localizedAppearanceTitle(it) }.orEmpty()
                    SettingsSection.MOTION -> pageAnimationLabel(display.pageAnimation)
                    SettingsSection.CONNECTION -> server
                    SettingsSection.DEVICES -> if (DeviceControl.platform != null && deviceAllowed) stringResource(Res.string.settings_allowed) else ""
                    else -> ""
                }
                SettingsNavigationRow(section.label, summary, section.icon) { onSelect(section) }
            }
        }
    }
}
