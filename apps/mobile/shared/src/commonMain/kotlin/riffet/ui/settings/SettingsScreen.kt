package riffet.ui.settings

import riffet.ui.design.LocalInterfaceStyle
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import riffet.ui.design.groupDividerInset
import riffet.ui.design.AlertDialog
import riffet.ui.design.GroupRow
import riffet.ui.design.SelectionMark
import riffet.ui.icons.Icon
import riffet.ui.design.RiffetIconButton
import riffet.ui.design.RiffetSlider
import androidx.compose.material3.Text
import riffet.ui.design.RiffetTextButton
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import org.jetbrains.compose.resources.getString
import org.jetbrains.compose.resources.rememberResourceEnvironment
import org.jetbrains.compose.resources.stringResource
import riffet_mobile.shared.generated.resources.*
import kotlin.math.roundToInt
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import riffet.contracts.AGENT_PROCESS_BUDGET_IDLE_MINUTES
import riffet.contracts.AGENT_PROCESS_BUDGET_MEMORY_BYTES
import riffet.contracts.AppSettingsUpdate
import riffet.contracts.NativeBackendId
import riffet.contracts.QuickChatPreset
import riffet.i18n.L10n
import riffet.shared.*
import riffet.ui.app.PageLeaveGuard
import riffet.ui.app.title
import riffet.ui.app.PageBackHandler
import riffet.ui.app.PageHost
import riffet.ui.app.PageStack
import riffet.ui.app.LocalRiffetSnackbar
import riffet.ui.app.SnackbarNotice
import riffet.ui.icons.BrandMark
import riffet.ui.icons.RiffetIcons
import riffet.ui.pickers.RiffetDropdownMenu
import riffet.ui.pickers.RiffetMenuItem
import riffet.ui.pickers.RiffetMenuText
import riffet.ui.platform.ApprovalVerification
import riffet.ui.platform.KeepAliveNotice
import riffet.ui.platform.KeepAlivePage
import riffet.ui.platform.KeepAliveVendor
import riffet.ui.platform.VerificationAvailability
import riffet.ui.platform.approvalVerificationAvailability
import riffet.ui.platform.openKeepAlivePage
import riffet.ui.platform.redactLog
import riffet.ui.platform.rememberKeepAliveStatus
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.ThemeEntry
import riffet.ui.theme.ThemeSwatch
import riffet.ui.theme.LocalRiffetTypography
import riffet.ui.theme.LocalRiffetMotion
import riffet.ui.timeline.Spinner
import riffet.ui.terminal.TerminalBenchScreen
import riffet.ui.settings.appearance.AppearancePage
import riffet.ui.settings.diagnostics.DiagnosticsPage
import riffet.ui.design.ConfirmDialog

private sealed interface SettingsPageRoute {
    data object Home : SettingsPageRoute
    data class Section(val section: SettingsSection, val searchTargetId: String? = null) : SettingsPageRoute
    data class Profile(val backend: NativeBackendId, val id: String, val launchOnly: Boolean = false) : SettingsPageRoute
    data class Add(val backend: NativeBackendId) : SettingsPageRoute
    data object Owner : SettingsPageRoute
    data object QuickChatPresets : SettingsPageRoute
    data object TerminalBench : SettingsPageRoute
    data object PairDevice : SettingsPageRoute
}

/** Local preferences remain usable when server settings fail to load. Each visit retains its state. */
@Composable
internal fun SettingsScreen(
    api: RiffetApi,
    /** Shared with the drawer's header; refreshed by the app. */
    owner: OwnerController,
    /** Set while the drawer asked for the owner page; cleared once pushed. */
    ownerRequested: Boolean,
    onOwnerRequestHandled: () -> Unit,
    projectId: String?,
    themeMode: ThemeMode,
    onThemeModeChange: (ThemeMode) -> Unit,
    iconPacks: riffet.ui.icons.IconPackState,
    themes: List<ThemeEntry>,
    themeId: String,
    onThemeIdChange: (String) -> Unit,
    onBack: () -> Unit,
    connection: RiffetConnection,
    onPaired: (RiffetApi) -> Unit,
    onRepair: (String?) -> Unit,
    onDisconnected: () -> Unit,
    operationScope: CoroutineScope? = null,
    connectionOperation: MutableState<String?> = remember { mutableStateOf<String?>(null) },
    modifier: Modifier = Modifier,
    onSettingsSaved: (riffet.contracts.AppSettings) -> Unit = {},
    onProfilesChanged: () -> Unit = {},
) {
    val scope = rememberCoroutineScope()
    PageBackHandler(enabled = connectionOperation.value != null) { }
    PageLeaveGuard { connectionOperation.value == null }
    val settingsSaved by rememberUpdatedState(onSettingsSaved)
    val profilesChanged by rememberUpdatedState(onProfilesChanged)
    val controller = remember(api, projectId) { SettingsController(api, scope, projectId, { settingsSaved(it) }, { profilesChanged() }) }
    val state by controller.state.collectAsState()
    val pages = remember { PageStack<SettingsPageRoute>(SettingsPageRoute.Home) }
    LaunchedEffect(ownerRequested) {
        if (!ownerRequested) return@LaunchedEffect
        if (pages.current != SettingsPageRoute.Owner) {
            pages.popToRoot()
            pages.push(SettingsPageRoute.Owner)
        }
        onOwnerRequestHandled()
    }
    var searchQuery by rememberSaveable { mutableStateOf("") }
    val focusManager = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    PageHost(pages, modifier) { route, back ->
        when (route) {
            SettingsPageRoute.Home -> SettingsPage(stringResource(Res.string.settings_title), onBack, large = true,
                search = riffet.ui.app.PageSearch(searchQuery, { searchQuery = it }, stringResource(Res.string.settings_search), drawer = true)) {
                SettingsSearchResults(searchQuery) { entry ->
                    focusManager.clearFocus()
                    keyboard?.hide()
                    pages.push(SettingsPageRoute.Section(entry.section, entry.id))
                }
                if (searchQuery.isBlank()) OwnerHeaderRow(owner) { pages.push(SettingsPageRoute.Owner) }
                if (searchQuery.isBlank()) SectionList(themeMode, themes, themeId, api.baseUrl, iconPacks) { pages.push(SettingsPageRoute.Section(it)) }
            }
            // A section with pages of its own beneath it owns its whole page, top bar included.
            is SettingsPageRoute.Section -> if (route.section == SettingsSection.EXTENSIONS) ExtensionsPage(api, projectId, route.section.label, back)
            else if (route.section == SettingsSection.PROVIDERS || route.section == SettingsSection.BACKENDS) BackendSettingsPage(controller, back, agentSettings = route.section == SettingsSection.BACKENDS,
                onEdit = { backend, id -> pages.push(SettingsPageRoute.Profile(backend, id, launchOnly = route.section == SettingsSection.BACKENDS)) },
                onAdd = { backend -> pages.push(SettingsPageRoute.Add(backend)) },
            ) else if (route.section == SettingsSection.APPEARANCE) AppearancePage(
                route.section.label, back, sectionSearchTarget(route.searchTargetId),
                themeMode, onThemeModeChange, themes, themeId, onThemeIdChange,
            ) else if (route.section == SettingsSection.DIAGNOSTICS) DiagnosticsPage(
                api, controller, route.section.label, back, sectionSearchTarget(route.searchTargetId),
                onOpenBenchmark = { pages.push(SettingsPageRoute.TerminalBench) },
            ) else if (route.section == SettingsSection.SERVICE) ServiceStatusPage(
                api, controller, route.section.label, back, sectionSearchTarget(route.searchTargetId),
            ) else {
                val section = route.section
                val auxiliaryOptions = if (section == SettingsSection.AUXILIARY || section == SettingsSection.QUICK_CHAT) {
                    rememberAuxiliaryModelOptions(api)
                } else null to null
                LaunchedEffect(controller, section) {
                    // The service page reads settings too, for its reclaim group, without gating on them.
                    if ((section.serverSettings || section == SettingsSection.SERVICE || section == SettingsSection.DEVICES) && controller.state.value.settings == null) controller.load()
                }
                SettingsPage(section.label, back, searchTarget = sectionSearchTarget(route.searchTargetId)) {
                    if (section.serverSettings) ControllerMessages(controller)
                    if (section.serverSettings && state.settings == null) {
                        ServerSettingsLoad(controller)
                    } else when (section) {
                        SettingsSection.LANGUAGE -> LanguageSection()
                        SettingsSection.LAUNCH_TAB -> LaunchTabSection()
                        SettingsSection.STYLE -> InterfaceStylePicker()
                        SettingsSection.MOTION -> MotionSection()
                        SettingsSection.GESTURES -> GesturesSection()
                        SettingsSection.APPEARANCE -> Unit
                        SettingsSection.TYPOGRAPHY -> TypographySection()
                        SettingsSection.ICONS -> {
                            if (appIconSupported) {
                                SettingsGroup(stringResource(Res.string.settings_app_icon)) { AppIconPicker() }
                                SettingsFootnote(stringResource(Res.string.settings_app_icon_footnote))
                            }
                            IconPackPicker(iconPacks)
                        }
                        SettingsSection.AUXILIARY -> AuxiliaryModelsSection(controller, auxiliaryOptions.first, auxiliaryOptions.second)
                        SettingsSection.NOTIFICATIONS -> NotificationsSection()
                        SettingsSection.INTERACTION -> InteractionSection(controller)
                        SettingsSection.QUICK_CHAT -> QuickChatSection(controller, auxiliaryOptions.first, auxiliaryOptions.second) { pages.push(SettingsPageRoute.QuickChatPresets) }
                        SettingsSection.ASSISTANT -> AssistantSettingsSection(api, controller)
                        SettingsSection.TASK_BOARD -> TaskBoardSettingsSection(api, controller)
                        SettingsSection.BACKENDS -> Unit
                        SettingsSection.PROVIDERS -> Unit
                        SettingsSection.FILES -> FilesSettingsSection(controller)
                        SettingsSection.EXTENSIONS -> Unit
                        SettingsSection.DEVICES -> DevicesSection(api)
                        SettingsSection.CONNECTION -> {
                            SettingsGroup("") {
                                SettingsNavigationRow(stringResource(Res.string.settings_pair_device), "", RiffetIcons.Plus) { pages.push(SettingsPageRoute.PairDevice) }
                            }
                            PairedServersSection(connection, onPaired, onRepair, onDisconnected, operationScope, connectionOperation)
                        }
                        SettingsSection.SERVICE -> Unit
                        SettingsSection.DIAGNOSTICS -> Unit
                        SettingsSection.ABOUT -> AppAboutSection()
                    }
                }
            }
            is SettingsPageRoute.Profile -> BackendProfilePage(controller, route.backend, route.id, back, onDeleted = { pages.pop() }, launchOnly = route.launchOnly)
            is SettingsPageRoute.Add -> AddProfilePage(controller, route.backend, back, onCreated = { pages.pop() })
            SettingsPageRoute.Owner -> OwnerProfilePages(owner, back)
            SettingsPageRoute.QuickChatPresets -> QuickChatPresetsPage(controller, back)
            SettingsPageRoute.PairDevice -> SettingsPage(stringResource(Res.string.settings_pair_device), back) { PairDeviceSection(api) }
            SettingsPageRoute.TerminalBench -> TerminalBenchScreen(onBack = back)
        }
    }
}

@Composable
private fun sectionSearchTarget(id: String?): SettingsSearchTarget? {
    val entry = settingsSearchCatalogue.firstOrNull { it.id == id } ?: return null
    return entry.anchor?.let { SettingsSearchTarget(entry.id, stringResource(entry.title), it) }
}

/** Material supporting labels or Cupertino trailing values, with the same destination. */
@Composable
internal fun SettingsNavigationRow(title: String, summary: String, icon: ImageVector? = null, onClick: () -> Unit) {
    val style = LocalInterfaceStyle.current
    val metrics = style.metrics
    val colors = LocalRiffetColors.current
    val leading: (@Composable () -> Unit)? = icon?.let { glyph -> {
        if (style.variants.settingsIcons == riffet.ui.design.SettingsIconPresentation.TONAL) riffet.ui.design.IconTile(glyph, colors.accent)
        else Icon(glyph, null, Modifier.size(metrics.iconSize), colors.fg2)
    } }
    if (style.components.lists.grouped) {
        val textStyle = LocalRiffetTypography.current.body
        val measurer = androidx.compose.ui.text.rememberTextMeasurer()
        val density = androidx.compose.ui.platform.LocalDensity.current
        val leadingInset = metrics.pageInset + if (icon != null) metrics.iconSlot + metrics.controlInset else 0.dp
        androidx.compose.foundation.layout.BoxWithConstraints(Modifier.fillMaxWidth().groupDividerInset(leadingInset)) {
            val needed = with(density) {
                (measurer.measure(title, textStyle, maxLines = 1).size.width +
                    measurer.measure(summary, textStyle, maxLines = 1).size.width).toDp()
            }
            val below = summary.isNotEmpty() && needed > maxWidth - leadingInset - metrics.pageInset - metrics.controlHeight
            riffet.ui.design.GroupRow(
                title = title, subtitle = summary.takeIf { below },
                value = summary.takeIf { it.isNotEmpty() && !below },
                leading = leading, chevron = true, onClick = onClick, modifier = Modifier.settingsSearchAnchor(title),
            )
        }
        return
    }
    SettingsLinkRow(title = title, subtitle = summary.takeIf { it.isNotEmpty() }, leading = leading, onClick = onClick)
}

/**
 * Settings share the same scrollable chrome and style scope as the rest of the app. Search, add and
 * the page's tools go in the bar ([search], [actions]; see mobile.md §4), not above the content.
 */
@Composable
internal fun SettingsPage(
    title: String, onBack: () -> Unit, large: Boolean = false,
    searchTarget: SettingsSearchTarget? = null,
    navigation: riffet.ui.app.PageNavigation = riffet.ui.app.PageNavigation.BACK,
    search: riffet.ui.app.PageSearch? = null,
    refreshing: Boolean = false,
    onRefresh: (() -> Unit)? = null,
    actions: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit = {},
    content: @Composable ColumnScope.() -> Unit,
) {
    val typography = LocalRiffetTypography.current
    CompositionLocalProvider(
        LocalRiffetTypography provides typography.copy(subhead = typography.bodySmall, caption = typography.bodySmall),
        LocalSettingsSearchTarget provides searchTarget,
    ) {
        riffet.ui.app.ScrollablePage(title, onBack, large, compactTitle = true, navigation = navigation, search = search,
            refreshing = refreshing, onRefresh = onRefresh, actions = actions, content = content)
    }
}

/**
 * An edit or new page (mobile.md §2.3): cancel at the start of the bar, [saveLabel] at the end,
 * enabled only with a change that can be saved. Leaving with unsaved changes, by cancel or by
 * either back, asks first. [onSave] is the caller's: it pops the page when the save succeeds and
 * keeps the page (and shows why) when it fails.
 */
@Composable
internal fun EditPage(
    title: String,
    onBack: () -> Unit,
    dirty: Boolean,
    busy: Boolean,
    onSave: () -> Unit,
    canSave: Boolean = dirty,
    saveLabel: String = stringResource(Res.string.settings_save),
    /** Off when the page sits at the root of a stack inside the page that owns the guard. */
    guard: Boolean = true,
    content: @Composable ColumnScope.() -> Unit,
) {
    if (guard) UnsavedSettingsGuard(dirty = dirty, busy = busy)
    SettingsPage(title, onBack, navigation = riffet.ui.app.PageNavigation.CLOSE, actions = {
        if (busy) riffet.ui.app.PageBarProgress()
        else riffet.ui.design.RiffetTextButton(onClick = onSave, enabled = canSave) { Text(saveLabel) }
    }, content = content)
}

@Composable
internal fun ControllerMessages(controller: SettingsController) {
    val state by controller.state.collectAsState()
    SnackbarNotice(state.notice, controller::consumeNotice)
    state.error?.let { PageBanner(it, SettingsNoticeKind.ERROR); Spacer(Modifier.height(12.dp)) }
    if (LocalRiffetSnackbar.current == null) {
        state.notice?.let { PageBanner(it, SettingsNoticeKind.SUCCESS); Spacer(Modifier.height(12.dp)) }
    }
}

@Composable
internal fun ServerSettingsLoad(controller: SettingsController) {
    val state by controller.state.collectAsState()
    if (state.loading) {
        Box(Modifier.fillMaxWidth().padding(vertical = 40.dp), contentAlignment = Alignment.Center) { Spinner(size = 20.dp) }
    } else {
        PageBanner(stringResource(Res.string.settings_load_failed_title), SettingsNoticeKind.ERROR)
        SettingsGroup(stringResource(Res.string.settings_server_settings)) {
            SettingsActionRow(stringResource(Res.string.settings_retry), controller::load)
        }
        SettingsFootnote(stringResource(Res.string.settings_load_failed_desc))
    }
}

/**
 * Enum labels are Compose resources rather than properties on the shared enums: the stored value
 * stays an id, and the displayed copy follows the app language with everything else in this screen.
 */
@Composable
internal fun textSizeLabel(value: TextSize): String = stringResource(
    when (value) {
        TextSize.SMALL -> Res.string.settings_text_size_small
        TextSize.DEFAULT -> Res.string.settings_text_size_default
        TextSize.LARGE -> Res.string.settings_text_size_large
        TextSize.LARGER -> Res.string.settings_text_size_larger
    },
)

@Composable
internal fun spacingLabel(value: Spacing): String = stringResource(
    when (value) {
        Spacing.COMPACT -> Res.string.settings_spacing_compact
        Spacing.DEFAULT -> Res.string.settings_spacing_default
        Spacing.RELAXED -> Res.string.settings_spacing_relaxed
    },
)

@Composable
internal fun pageAnimationLabel(value: PageAnimation): String = stringResource(
    when (value) {
        PageAnimation.SLIDE -> Res.string.settings_page_animation_slide
        PageAnimation.FADE -> Res.string.settings_page_animation_fade
        PageAnimation.SCALE -> Res.string.settings_page_animation_scale
        PageAnimation.NONE -> Res.string.settings_page_animation_none
    },
)

@Composable
private fun appIconLabel(value: AppIcon): String = stringResource(
    when (value) {
        AppIcon.BLUE -> Res.string.settings_app_icon_blue
        AppIcon.PURPLE -> Res.string.settings_app_icon_purple
        AppIcon.MAGENTA -> Res.string.settings_app_icon_magenta
        AppIcon.PINK -> Res.string.settings_app_icon_pink
        AppIcon.RED -> Res.string.settings_app_icon_red
        AppIcon.ORANGE -> Res.string.settings_app_icon_orange
        AppIcon.YELLOW -> Res.string.settings_app_icon_yellow
        AppIcon.LIME -> Res.string.settings_app_icon_lime
        AppIcon.GREEN -> Res.string.settings_app_icon_green
        AppIcon.CYAN -> Res.string.settings_app_icon_cyan
        AppIcon.GRAPHITE -> Res.string.settings_app_icon_graphite
        AppIcon.WHITE -> Res.string.settings_app_icon_white
    },
)

@Composable
private fun LanguageSection() {
    val current = AppLanguages.current
    SettingsGroup(stringResource(Res.string.settings_language)) {
        Column(Modifier.fillMaxWidth().selectableGroup()) {
            AppLanguage.entries.forEach { language ->
                val label = appLanguageLabel(language)
                val selected = language == current
                GroupRow(
                    title = label,
                    trailing = { SelectionMark(selected) },
                    modifier = Modifier.settingsSearchAnchor(label)
                        .selectable(selected, role = Role.RadioButton) { AppLanguages.change(language) },
                )
            }
        }
    }
    SettingsFootnote(stringResource(Res.string.settings_language_footnote))
}

@Composable
private fun TypographySection() {
    val metrics = LocalInterfaceStyle.current.metrics
    val display = DisplaySettings.shared
    SettingsGroup(title = stringResource(Res.string.settings_preview)) {
        Column(Modifier.padding(metrics.controlInset * display.spacing.scale)) {
            Text(stringResource(Res.string.settings_preview_title), style = LocalRiffetTypography.current.title, color = LocalRiffetColors.current.fg)
            Spacer(Modifier.height(metrics.controlInset * display.spacing.scale / 2))
            Text(stringResource(Res.string.settings_preview_body), style = LocalRiffetTypography.current.body, color = LocalRiffetColors.current.fg2)
        }
    }
    SettingsGroup(title = stringResource(Res.string.settings_typography)) {
        TextSizeRow(display.textSize, display::changeTextSize)
        ChoiceRow(
            title = stringResource(Res.string.settings_session_spacing),
            options = Spacing.entries.map { it.name to spacingLabel(it) },
            value = display.spacing.name,
            onSelect = { name -> Spacing.entries.firstOrNull { it.name == name }?.let(display::changeSpacing) },
        )
    }
    SettingsFootnote(stringResource(Res.string.settings_local_only_footnote))
}

/** 文字大小 as a stepped slider, the way Android's own font-size setting reads. */
@Composable
private fun TextSizeRow(value: TextSize, onChange: (TextSize) -> Unit) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val sizes = TextSize.entries
    Column(modifier = Modifier.fillMaxWidth().settingsSearchAnchor(stringResource(Res.string.settings_text_size)).padding(start = 16.dp, end = 16.dp, top = 14.dp, bottom = 4.dp)) {
        Row {
            Text(stringResource(Res.string.settings_text_size), style = typography.body, color = colors.fg, modifier = Modifier.weight(1f))
            Text(textSizeLabel(value), style = typography.label, color = colors.fg2)
        }
        RiffetSlider(
            value = sizes.indexOf(value).toFloat(),
            onValueChange = { position -> sizes.getOrNull(position.roundToInt())?.takeIf { it != value }?.let(onChange) },
            valueRange = 0f..sizes.lastIndex.toFloat(),
            steps = sizes.size - 2,
        )
    }
}

private val AppIconTileColor = Color(0xFF15171A)

/** One launcher icon drawn like the icon itself: the dark tile and the mark in its accent. */
@Composable
private fun AppIconTile(icon: AppIcon, size: Dp) {
    Box(
        modifier = Modifier.size(size).clip(RoundedCornerShape(size * 0.225f)).background(AppIconTileColor),
        contentAlignment = Alignment.Center,
    ) {
        // The favicon's proportions: the 24-unit mark scaled to 0.87 of the tile.
        BrandMark(fg = Color.White, accent = icon.accent, modifier = Modifier.fillMaxSize(0.87f))
    }
}

/**
 * The current launcher icon, opening a menu of all of them. Twelve tiles in one row of a phone-wide
 * card left each too small to tell apart, so the choice is a list with the colour named beside it.
 */
@Composable
private fun AppIconPicker() {
    var current by remember { mutableStateOf(currentAppIcon()) }
    var open by remember { mutableStateOf(false) }
    Box {
        riffet.ui.design.GroupRow(
            title = appIconLabel(current),
            leading = { AppIconTile(current, 32.dp) },
            trailing = { Icon(RiffetIcons.ChevronDown, null, Modifier.size(20.dp)) },
            role = Role.DropdownList,
            onClick = { open = true },
        )
        RiffetDropdownMenu(expanded = open, onDismissRequest = { open = false }, modifier = Modifier.widthIn(min = 224.dp)) {
            AppIcon.entries.forEach { icon ->
                RiffetMenuItem(
                    onClick = {
                        open = false
                        if (icon != current) {
                            setAppIcon(icon)
                            current = icon
                        }
                    },
                    selected = icon == current,
                    showCheck = true,
                    leading = { AppIconTile(icon, 24.dp) },
                ) { Text(appIconLabel(icon)) }
            }
        }
    }
}

@Composable
private fun ChoiceRow(
    title: String,
    options: List<Pair<String, String>>,
    value: String,
    description: String? = null,
    enabled: Boolean = true,
    onSelect: (String) -> Unit,
) = SettingsChoiceRow(title, options, value, subtitle = description, enabled = enabled, onSelect = onSelect)

@Composable
private fun FeatureSwitch(feature: NativeFeature, title: String, description: String? = null) {
    if (!feature.supported) return
    val features = LocalNativeFeatures.current
    SettingsSwitchRow(title, description, checked = features.isOn(feature), onCheckedChange = { features.set(feature, it) })
}

@Composable
private fun NotificationsSection() {
    val access = rememberNotificationAccess()
    SettingsGroup(stringResource(Res.string.settings_notifications)) {
        FeatureSwitch(NativeFeature.ALERTS, stringResource(Res.string.settings_session_alerts), stringResource(Res.string.settings_session_alerts_desc))
        if (access != NotificationAccess.ALLOWED) SettingsActionRow(
            stringResource(Res.string.setp_notification_allow),
            onClick = ::openNotificationSettings,
            subtitle = stringResource(Res.string.setp_notification_blocked_desc),
        )
    }
    SettingsGroup(stringResource(Res.string.settings_background)) {
        FeatureSwitch(NativeFeature.BACKGROUND_WATCH, stringResource(Res.string.settings_background_sessions), stringResource(Res.string.settings_background_sessions_desc))
        KeepAliveRows()
    }
    if (KeepAliveNotice.cutOffAt != null) SettingsFootnote(stringResource(Res.string.settings_keepalive_cutoff))
    LocalPreferenceNote()
}

/**
 * The system and maker switches that decide whether the keep-alive service actually stays online
 * in the background (docs/MOBILE.md「通知」). Each opens the system's own page; state is read back
 * when the app regains focus.
 */
@Composable
private fun KeepAliveRows() {
    val status = rememberKeepAliveStatus() ?: return
    fun open(page: KeepAlivePage) {
        KeepAliveNotice.dismiss()
        openKeepAlivePage(page)
    }
    if (status.batteryExempt == false) SettingsActionRow(
        stringResource(Res.string.setp_keepalive_battery_allow),
        onClick = { open(KeepAlivePage.BATTERY) },
    )
    val hint = when (status.vendor) {
        KeepAliveVendor.OPPO -> Res.string.settings_keepalive_hint_oppo
        KeepAliveVendor.XIAOMI -> Res.string.settings_keepalive_hint_xiaomi
        KeepAliveVendor.VIVO -> Res.string.settings_keepalive_hint_vivo
        KeepAliveVendor.HUAWEI, KeepAliveVendor.HONOR -> Res.string.settings_keepalive_hint_huawei
        KeepAliveVendor.SAMSUNG, null -> Res.string.settings_keepalive_hint_default
    }
    SettingsActionRow(stringResource(Res.string.settings_keepalive_background), onClick = { open(KeepAlivePage.BACKGROUND) }, subtitle = stringResource(hint))
    if (status.autostart) SettingsActionRow(stringResource(Res.string.setp_keepalive_autostart_allow), onClick = { open(KeepAlivePage.AUTOSTART) })
}

/** 确认操作前验证本人, as on iPhone: turning it on needs one successful verification. */
@Composable
private fun ApprovalVerificationGroup() {
    val availability = remember { approvalVerificationAvailability() }
    if (availability == VerificationAvailability.UNSUPPORTED) return
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<String?>(null) }
    val on = ApprovalVerification.required
    SettingsGroup(stringResource(Res.string.settings_verify_group)) {
        SettingsSwitchRow(
            stringResource(Res.string.settings_verify_approvals),
            failure ?: when {
                availability == VerificationAvailability.NOT_ENROLLED && !on -> stringResource(Res.string.settings_verify_unavailable)
                else -> stringResource(Res.string.settings_verify_approvals_desc)
            },
            checked = on,
            enabled = !busy && (on || availability == VerificationAvailability.AVAILABLE),
            onCheckedChange = { enable ->
                failure = null
                if (!enable) {
                    ApprovalVerification.setRequired(false)
                    return@SettingsSwitchRow
                }
                busy = true
                scope.launch {
                    try {
                        val passed = ApprovalVerification.authenticate(getString(Res.string.settings_verify_enable_reason))
                        if (passed) ApprovalVerification.setRequired(true)
                        else failure = getString(Res.string.settings_verify_enable_failed)
                    } finally {
                        busy = false
                    }
                }
            },
        )
    }
}

@Composable
private fun InteractionSection(controller: SettingsController) {
    val state by controller.state.collectAsState()
    val settings = state.settings ?: return
    SettingsGroup(stringResource(Res.string.settings_input)) {
        ChoiceRow(
            title = stringResource(Res.string.settings_task_output_to),
            options = listOf("queue" to stringResource(Res.string.settings_queue), "steer" to stringResource(Res.string.settings_steer)),
            value = if (settings.composerRunningBehavior == "steer") "steer" else "queue",
            onSelect = { controller.saveSettings(AppSettingsUpdate(composerRunningBehavior = it)) },
        )
    }
    ApprovalVerificationGroup()
}

/** Which tab a launch opens; this device's choice, like the rest of what is stored locally. */
@Composable
private fun LaunchTabSection() {
    val display = DisplaySettings.shared
    val title = stringResource(Res.string.settings_launch_tab)
    SettingsGroup("") {
        Column(Modifier.fillMaxWidth().selectableGroup().settingsSearchAnchor(title)) {
            riffet.ui.app.HomeTab.entries.forEach { tab ->
                val selected = tab.key == riffet.ui.app.homeTabKey(display.launchTab)
                GroupRow(
                    title = stringResource(tab.title()),
                    trailing = { SelectionMark(selected) },
                    modifier = Modifier.selectable(selected, role = Role.RadioButton) { display.changeLaunchTab(tab.key) },
                )
            }
        }
    }
    LocalPreferenceNote()
}

@Composable
private fun MotionSection() {
    val display = DisplaySettings.shared
    val title = stringResource(Res.string.settings_page_animation)
    SettingsGroup(title) {
        Column(Modifier.fillMaxWidth().selectableGroup().settingsSearchAnchor(title)) {
            PageAnimation.entries.forEach { animation ->
                val selected = animation == display.pageAnimation
                GroupRow(
                    title = pageAnimationLabel(animation),
                    trailing = { SelectionMark(selected) },
                    modifier = Modifier.selectable(selected, role = Role.RadioButton) { display.changePageAnimation(animation) },
                )
            }
        }
    }
    SettingsFootnote(stringResource(Res.string.settings_page_animation_desc))
    SettingsGroup("") {
        FeatureSwitch(NativeFeature.FADE_IN, stringResource(Res.string.settings_fade_in), stringResource(Res.string.settings_fade_in_desc))
    }
    LocalPreferenceNote()
}

@Composable
private fun GesturesSection() {
    SettingsGroup(stringResource(Res.string.settings_gestures)) {
        FeatureSwitch(NativeFeature.SWIPE_BACK, stringResource(Res.string.settings_swipe_back))
        FeatureSwitch(NativeFeature.PREDICTIVE_BACK, stringResource(Res.string.settings_predictive_back))
        FeatureSwitch(NativeFeature.HAPTICS, stringResource(Res.string.settings_haptics))
    }
    LocalPreferenceNote()
}

private val IDLE_RECLAIM_PRESETS = listOf(0, 60, 360, 1440)
private val MEMORY_LIMIT_PRESETS_MB = listOf(0, 2048, 4096, 8192, 16384)

/** The presets, plus a value set elsewhere (another client, the API) so the control still shows it. */
private fun withCurrent(presets: List<Int>, current: Int) = if (current in presets) presets else (presets + current).sorted()

@Composable
private fun idleLabel(minutes: Int) = when {
    minutes == 0 -> stringResource(Res.string.settings_extra_idle_off)
    minutes % 60 == 0 -> stringResource(Res.string.settings_extra_idle_hours, minutes / 60)
    else -> stringResource(Res.string.settings_extra_idle_minutes, minutes)
}

@Composable
private fun memoryLabel(mb: Int) = when {
    mb == 0 -> stringResource(Res.string.settings_reclaim_unlimited)
    mb % 1024 == 0 -> stringResource(Res.string.settings_reclaim_limit_gb, mb / 1024)
    else -> "$mb MB"
}

/** When the server stops the CLIs of conversations nobody uses; the next message resumes them. */
@Composable
internal fun ReclaimSection(controller: SettingsController) {
    val state by controller.state.collectAsState()
    ControllerMessages(controller)
    val settings = state.settings ?: return
    val idle = settings.idleReclaimMinutes ?: AGENT_PROCESS_BUDGET_IDLE_MINUTES
    val memoryMb = settings.maxAgentMemoryMb ?: (AGENT_PROCESS_BUDGET_MEMORY_BYTES / (1024 * 1024)).toInt()
    val reclaimSaveFailed = stringResource(Res.string.settings_reclaim_save_failed)
    fun save(patch: AppSettingsUpdate) = controller.saveSettings(patch, failureMessage = reclaimSaveFailed)
    SettingsGroup(stringResource(Res.string.settings_reclaim)) {
        ChoiceRow(
            title = stringResource(Res.string.settings_reclaim_idle),
            description = stringResource(Res.string.settings_reclaim_idle_desc),
            options = withCurrent(IDLE_RECLAIM_PRESETS, idle).map { it.toString() to idleLabel(it) },
            value = idle.toString(),
            enabled = !state.saving,
            onSelect = { if (it.toInt() != idle) save(AppSettingsUpdate(idleReclaimMinutes = it.toInt())) },
        )
        ChoiceRow(
            title = stringResource(Res.string.settings_reclaim_memory),
            options = withCurrent(MEMORY_LIMIT_PRESETS_MB, memoryMb).map { it.toString() to memoryLabel(it) },
            value = memoryMb.toString(),
            enabled = !state.saving,
            onSelect = { if (it.toInt() != memoryMb) save(AppSettingsUpdate(maxAgentMemoryMb = it.toInt())) },
        )
    }
}

/**
 * Quick chat's default model and retention. The model list is the gateway catalog, read on its own
 * because a quick chat has no backend configuration page; retention is the server's archive timer.
 */
@Composable
private fun QuickChatSection(controller: SettingsController, options: List<riffet.contracts.AuxiliaryModelOption>?, loadError: String?, onEditPresets: () -> Unit) {
    val state by controller.state.collectAsState()
    ControllerMessages(controller)
    val settings = state.settings ?: return
    val busy = state.saving
    SettingsGroup(stringResource(Res.string.settings_quick_chat)) {
        AuxiliaryModelRow(controller, "chat", stringResource(Res.string.settings_quick_chat_default_model), stringResource(Res.string.settings_quick_chat_none), options, loadError)
        ChoiceRow(
            title = stringResource(Res.string.settings_quick_chat_open_mode),
            options = listOf(
                "sheet" to stringResource(Res.string.settings_quick_chat_open_sheet),
                "page" to stringResource(Res.string.settings_quick_chat_open_page),
            ),
            value = settings.quickChat?.openMode ?: "sheet",
            enabled = !busy,
            onSelect = { mode -> controller.saveQuickChat(openMode = mode) },
        )
        SettingsNavigationRow(
            stringResource(Res.string.settings_quick_chat_presets),
            settings.quickChat?.presets?.size?.toString().orEmpty(),
            onClick = onEditPresets,
        )
        val days = settings.quickChat?.retentionDays ?: 7
        val never = stringResource(Res.string.settings_quick_chat_never)
        SettingsChoiceRow(
            title = stringResource(Res.string.settings_quick_chat_archive),
            options = listOf(1, 3, 7, 14, 30, 0).map { it.toString() to if (it == 0) never else stringResource(Res.string.settings_quick_chat_days, it) },
            value = days.toString(),
            enabled = !busy,
            onSelect = { controller.saveQuickChat(retentionDays = it.toInt()) },
        )
    }
    SettingsFootnote(stringResource(Res.string.settings_quick_chat_hint))
}

private const val MAX_QUICK_CHAT_PRESETS = 12
private const val MAX_PRESET_NAME = 20
private const val MAX_PRESET_PROMPT = 4000

/** A preset id the server accepts (`[a-z0-9-]{1,32}`), chosen away from the ones already in use. */
private fun nextPresetId(existing: Collection<String>): String {
    val used = existing.toHashSet()
    var index = 1
    while ("custom-$index" in used) index++
    return "custom-$index"
}

private sealed interface PresetRoute {
    data object List : PresetRoute
    data class Edit(val preset: QuickChatPreset) : PresetRoute
}

/**
 * The preset directory, and beneath it one preset's edit page. Every write sends the whole list,
 * which is what the PATCH route replaces.
 */
@Composable
private fun QuickChatPresetsPage(controller: SettingsController, onBack: () -> Unit) {
    val state by controller.state.collectAsState()
    val pages = remember { PageStack<PresetRoute>(PresetRoute.List) }
    PageHost(pages) { route, back ->
        when (route) {
            PresetRoute.List -> {
                val presets = state.settings?.quickChat?.presets.orEmpty()
                QuickChatPresetList(controller, presets, state.saving, onBack, onOpen = { pages.push(PresetRoute.Edit(it)) })
            }
            is PresetRoute.Edit -> QuickChatPresetEditPage(controller, route.preset, state.settings?.quickChat?.presets.orEmpty(), state.saving, back)
        }
    }
}

@Composable
private fun QuickChatPresetList(
    controller: SettingsController,
    presets: List<QuickChatPreset>,
    busy: Boolean,
    onBack: () -> Unit,
    onOpen: (QuickChatPreset) -> Unit,
) {
    var confirmRestore by remember { mutableStateOf(false) }
    SettingsPage(
        stringResource(Res.string.settings_quick_chat_presets),
        onBack,
        actions = {
            riffet.ui.app.PageBarAction(
                icon = RiffetIcons.Plus,
                description = stringResource(Res.string.settings_quick_chat_add),
                enabled = !busy && presets.size < MAX_QUICK_CHAT_PRESETS,
                onClick = { onOpen(QuickChatPreset(id = "", name = "", prompt = "")) },
            )
        },
    ) {
        ControllerMessages(controller)
        if (presets.isNotEmpty()) SettingsGroup(title = "") {
            presets.forEach { preset ->
                GroupRow(title = preset.name, subtitle = preset.prompt.replace('\n', ' '), chevron = true, enabled = !busy, onClick = { onOpen(preset) })
            }
        }
        SettingsFootnote(stringResource(Res.string.settings_quick_chat_presets_limit))
        SettingsGroup(title = "") {
            SettingsActionRow(stringResource(Res.string.settings_quick_chat_restore_defaults), onClick = { confirmRestore = true }, enabled = !busy)
        }
    }
    if (confirmRestore) {
        ConfirmDialog(
            title = stringResource(Res.string.settings_quick_chat_restore_title),
            message = stringResource(Res.string.setp_restore_presets_message),
            confirmLabel = stringResource(Res.string.settings_quick_chat_restore),
            danger = true,
            onDismiss = { confirmRestore = false },
            onConfirm = {
                confirmRestore = false
                controller.saveQuickChat(resetPresets = true)
            },
        )
    }
}

@Composable
private fun QuickChatPresetEditPage(
    controller: SettingsController,
    initial: QuickChatPreset,
    presets: List<QuickChatPreset>,
    busy: Boolean,
    back: () -> Unit,
) {
    val isNew = initial.id.isEmpty()
    var name by remember(initial.id) { mutableStateOf(initial.name) }
    var prompt by remember(initial.id) { mutableStateOf(initial.prompt) }
    var confirmDelete by remember { mutableStateOf(false) }
    val pageBack = riffet.ui.app.LocalPageBack.current
    // The saved list resets the draft; leaving here skips the guard that still sees the old one.
    val leave: () -> Unit = { pageBack?.leaveConfirmed() ?: back() }
    val id = initial.id.ifEmpty { nextPresetId(presets.map { it.id }) }
    val dirty = name != initial.name || prompt != initial.prompt
    LaunchedEffect(controller) { controller.clearMessages() }
    EditPage(
        title = stringResource(if (isNew) Res.string.settings_quick_chat_new_preset else Res.string.settings_quick_chat_edit_preset),
        onBack = back,
        dirty = dirty,
        busy = busy,
        canSave = dirty && name.isNotBlank() && prompt.isNotBlank(),
        onSave = {
            val saved = QuickChatPreset(id, name.trim(), prompt.trim())
            val next = if (isNew) presets + saved else presets.map { if (it.id == initial.id) saved else it }
            controller.saveQuickChat(presets = next, onSaved = leave)
        },
    ) {
        ControllerMessages(controller)
        SettingsGroup(title = "") {
            riffet.ui.design.GroupField(
                value = name,
                onValueChange = { name = it.take(MAX_PRESET_NAME) },
                placeholder = stringResource(Res.string.settings_quick_chat_preset_name),
            )
            riffet.ui.design.GroupField(
                value = prompt,
                onValueChange = { prompt = it.take(MAX_PRESET_PROMPT) },
                placeholder = stringResource(Res.string.settings_quick_chat_preset_prompt),
                singleLine = false,
                minLines = 4,
                maxLines = 8,
            )
        }
        if (!isNew) SettingsGroup(title = "") {
            SettingsActionRow(stringResource(Res.string.settings_quick_chat_delete), onClick = { confirmDelete = true }, danger = true, enabled = !busy)
        }
    }
    if (confirmDelete) {
        ConfirmDialog(
            title = stringResource(Res.string.setp_delete_preset_title, initial.name),
            confirmLabel = stringResource(Res.string.settings_quick_chat_delete),
            danger = true,
            onDismiss = { confirmDelete = false },
            onConfirm = {
                confirmDelete = false
                controller.saveQuickChat(presets = presets.filterNot { it.id == initial.id }, onSaved = leave)
            },
        )
    }
}

@Composable
private fun LocalPreferenceNote() {
    SettingsFootnote(stringResource(Res.string.settings_local_effect_note))
}

@Composable
private fun FilesSettingsSection(controller: SettingsController) {
    val metrics = LocalInterfaceStyle.current.metrics
    val state by controller.state.collectAsState()
    val settings = state.settings ?: return
    // Only the corresponding saved field changes the baseline, not an unrelated switch update.
    var editor by remember { mutableStateOf(settings.editorCommand.orEmpty()) }
    var baseline by remember { mutableStateOf(settings.editorCommand.orEmpty()) }
    val dirty = editor != baseline
    val busy = state.saving
    val savedMessage = stringResource(Res.string.settings_saved)
    fun save(after: () -> Unit = {}) {
        controller.saveSettings(AppSettingsUpdate(editorCommand = editor), savedMessage) {
            baseline = controller.state.value.settings?.editorCommand.orEmpty()
            editor = baseline
            after()
        }
    }
    UnsavedSettingsGuard(dirty, busy)
    SettingsGroup(stringResource(Res.string.settings_file_access)) {
        SettingsSwitchRow(
            stringResource(Res.string.settings_allow_outside_read),
            stringResource(Res.string.settings_allow_outside_read_desc),
            checked = settings.allowOutsideRead != false,
            enabled = !busy,
            onCheckedChange = { controller.saveSettings(AppSettingsUpdate(allowOutsideRead = it), savedMessage) },
        )
    }
    SettingsFootnote(stringResource(Res.string.settings_server_effect_note))
    SettingsGroup(stringResource(Res.string.settings_editor), action = {
        SettingsButton(if (busy) stringResource(Res.string.settings_saving) else stringResource(Res.string.settings_save), enabled = dirty && !busy, primary = true, onClick = { save() })
    }) {
        Column(Modifier.padding(metrics.pageInset)) {
            Text(stringResource(Res.string.settings_editor_command), style = LocalRiffetTypography.current.body, color = LocalRiffetColors.current.fg)
            Text(stringResource(Res.string.settings_editor_command_desc), style = LocalRiffetTypography.current.caption, color = LocalRiffetColors.current.fg3)
            Spacer(Modifier.height(8.dp))
            SettingsField(editor, onValueChange = { editor = it }, placeholder = "cursor", enabled = !busy, mono = true)
        }
    }
}

@Composable
private fun AppAboutSection() {
    val info = remember { appBuildInfo() }
    SettingsGroup("Riffet") {
        SettingsValueRow(stringResource(Res.string.settings_app_version), info.version)
        SettingsValueRow(stringResource(Res.string.settings_build_number), info.build)
        SettingsValueRow(stringResource(Res.string.settings_platform), info.platform)
    }
}
