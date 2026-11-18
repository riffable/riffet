package riffet.ui.settings

import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import kotlinx.coroutines.CoroutineScope
import org.jetbrains.compose.resources.stringResource
import riffet.shared.RiffetApi
import riffet.shared.RiffetConnection
import riffet.shared.ThemeMode
import riffet.shared.appIconSupported
import riffet.ui.app.PageHost
import riffet.ui.app.PageStack
import riffet.ui.icons.IconPackState
import riffet.ui.onboarding.LocalSetupActions
import riffet.ui.onboarding.NeedsServerState
import riffet.ui.settings.appearance.AppearancePage
import riffet.ui.terminal.TerminalBenchScreen
import riffet.ui.theme.ThemeEntry
import riffet_mobile.shared.generated.resources.Res
import riffet_mobile.shared.generated.resources.settings_advanced_diagnostics
import riffet_mobile.shared.generated.resources.settings_app_icon
import riffet_mobile.shared.generated.resources.settings_app_icon_footnote
import riffet_mobile.shared.generated.resources.settings_render_benchmark
import riffet_mobile.shared.generated.resources.settings_terminal_render_test_desc
import riffet_mobile.shared.generated.resources.settings_title

private sealed interface LocalSettingsRoute {
    data object Home : LocalSettingsRoute
    data class Section(val section: SettingsSection) : LocalSettingsRoute
    data object TerminalBench : LocalSettingsRoute
}

/**
 * 设置 with no server: every section that lives on the device works as it does when connected, and a
 * row that needs the server says 未连接 and opens the shared empty state.
 */
@Composable
internal fun LocalSettingsScreen(
    themeMode: ThemeMode,
    onThemeModeChange: (ThemeMode) -> Unit,
    iconPacks: IconPackState,
    themes: List<ThemeEntry>,
    themeId: String,
    onThemeIdChange: (String) -> Unit,
    onBack: () -> Unit,
    connection: RiffetConnection,
    onPaired: (RiffetApi) -> Unit,
    onRepair: (String?) -> Unit,
    onDisconnected: () -> Unit,
    operationScope: CoroutineScope?,
    connectionOperation: MutableState<String?>,
    modifier: Modifier = Modifier,
) {
    val pages = remember { PageStack<LocalSettingsRoute>(LocalSettingsRoute.Home) }
    val setup = LocalSetupActions.current
    PageHost(pages, modifier) { route, back ->
        when (route) {
            LocalSettingsRoute.Home -> SettingsPage(stringResource(Res.string.settings_title), onBack, large = true) {
                SectionList(themeMode, themes, themeId, "", iconPacks, connected = false) { pages.push(LocalSettingsRoute.Section(it)) }
            }
            is LocalSettingsRoute.Section -> {
                val section = route.section
                if (section == SettingsSection.APPEARANCE) AppearancePage(
                    section.label, back, null, themeMode, onThemeModeChange, themes, themeId, onThemeIdChange,
                ) else SettingsPage(section.label, back) {
                    when {
                        section.needsServer -> NeedsServerState(onConnect = { setup?.showSetup?.invoke() }, fill = false)
                        section == SettingsSection.LANGUAGE -> LanguageSection()
                        section == SettingsSection.LAUNCH_TAB -> LaunchTabSection()
                        section == SettingsSection.STYLE -> InterfaceStylePicker()
                        section == SettingsSection.MOTION -> MotionSection()
                        section == SettingsSection.GESTURES -> GesturesSection()
                        section == SettingsSection.TYPOGRAPHY -> TypographySection()
                        section == SettingsSection.ICONS -> {
                            if (appIconSupported) {
                                SettingsGroup(stringResource(Res.string.settings_app_icon)) { AppIconPicker() }
                                SettingsFootnote(stringResource(Res.string.settings_app_icon_footnote))
                            }
                            IconPackPicker(iconPacks)
                        }
                        section == SettingsSection.NOTIFICATIONS -> NotificationsSection()
                        section == SettingsSection.CONNECTION -> PairedServersSection(connection, onPaired, onRepair, onDisconnected, operationScope, connectionOperation)
                        section == SettingsSection.DIAGNOSTICS -> SettingsGroup(stringResource(Res.string.settings_advanced_diagnostics)) {
                            SettingsNavigationRow(
                                stringResource(Res.string.settings_render_benchmark), stringResource(Res.string.settings_terminal_render_test_desc),
                                onClick = { pages.push(LocalSettingsRoute.TerminalBench) },
                            )
                        }
                        section == SettingsSection.ABOUT -> AppAboutSection()
                    }
                }
            }
            LocalSettingsRoute.TerminalBench -> TerminalBenchScreen(onBack = back)
        }
    }
}
