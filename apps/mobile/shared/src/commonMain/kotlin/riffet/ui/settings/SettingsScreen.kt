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
import riffet.contracts.AppSettingsUpdate
import riffet.contracts.NativeBackendId
import riffet.contracts.QuickChatPreset
import riffet.i18n.L10n
import riffet.shared.*
import riffet.ui.app.PageLeaveGuard
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

private sealed interface SettingsPageRoute {
    data object Home : SettingsPageRoute
    data class Section(val section: SettingsSection, val searchTargetId: String? = null) : SettingsPageRoute
    data class Backend(val id: NativeBackendId) : SettingsPageRoute
    data class Profile(val backend: NativeBackendId, val id: String) : SettingsPageRoute
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
    val motion = LocalRiffetMotion.current
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
            SettingsPageRoute.Home -> SettingsPage(stringResource(Res.string.settings_title), onBack, large = true) {
                SettingsSearch(searchQuery, { searchQuery = it }) { entry ->
                    focusManager.clearFocus()
                    keyboard?.hide()
                    pages.push(SettingsPageRoute.Section(entry.section, entry.id))
                }
                if (searchQuery.isBlank()) OwnerHeaderRow(owner) { pages.push(SettingsPageRoute.Owner) }
                if (searchQuery.isBlank()) SectionList(themeMode, themes, themeId, api.baseUrl, iconPacks) { pages.push(SettingsPageRoute.Section(it)) }
            }
            is SettingsPageRoute.Section -> {
                val section = route.section
                val auxiliaryOptions = if (section == SettingsSection.AUXILIARY || section == SettingsSection.QUICK_CHAT) {
                    rememberAuxiliaryModelOptions(api)
                } else null to null
                LaunchedEffect(controller, section) {
                    // The service page reads settings too, for its reclaim group, without gating on them.
                    if ((section.serverSettings || section == SettingsSection.SERVICE || section == SettingsSection.DEVICES) && controller.state.value.settings == null) controller.load()
                    if (section == SettingsSection.DIAGNOSTICS && controller.state.value.capabilities == null) controller.loadDiagnostics()
                }
                val searchEntry = settingsSearchCatalogue.firstOrNull { it.id == route.searchTargetId }
                val searchTarget = searchEntry?.anchor?.let { anchor ->
                    SettingsSearchTarget(searchEntry.id, stringResource(searchEntry.title), anchor)
                }
                SettingsPage(section.label, back, searchTarget = searchTarget) {
                    if (section.serverSettings) ControllerMessages(controller)
                    if (section.serverSettings && state.settings == null) {
                        ServerSettingsLoad(controller)
                    } else when (section) {
                        SettingsSection.LANGUAGE -> LanguageSection()
                        SettingsSection.STYLE -> InterfaceStylePicker()
                        SettingsSection.MOTION -> MotionSection()
                        SettingsSection.GESTURES -> GesturesSection()
                        SettingsSection.APPEARANCE -> ThemeSection(themeMode, onThemeModeChange, themes, themeId, onThemeIdChange)
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
                        SettingsSection.BACKENDS -> BackendsSection(controller) { pages.push(SettingsPageRoute.Backend(it)) }
                        SettingsSection.FILES -> FilesSettingsSection(controller)
                        SettingsSection.EXTENSIONS -> ExtensionsSection(api, projectId)
                        SettingsSection.DEVICES -> DevicesSection(api)
                        SettingsSection.CONNECTION -> {
                            SettingsGroup("") {
                                SettingsNavigationRow(stringResource(Res.string.settings_pair_device), "", RiffetIcons.Plus) { pages.push(SettingsPageRoute.PairDevice) }
                            }
                            PairedServersSection(connection, onPaired, onRepair, onDisconnected, operationScope, connectionOperation)
                        }
                        SettingsSection.SERVICE -> {
                            ReclaimSection(controller)
                            ServiceStatusSection(api)
                        }
                        SettingsSection.DIAGNOSTICS -> {
                            SettingsGroup(stringResource(Res.string.settings_diagnostics_logs)) { LogUploadRow(api); LogExportRow() }
                            state.diagnosticsError?.let { Spacer(Modifier.height(16.dp)); PageBanner(it, SettingsNoticeKind.ERROR) }
                            EnvironmentSection(controller)
                            var advanced by remember { mutableStateOf(false) }
                            SettingsGroup(stringResource(Res.string.settings_advanced_diagnostics)) {
                                SettingsRow(stringResource(Res.string.settings_terminal_render_test), stringResource(Res.string.settings_terminal_render_test_desc)) {
                                    SettingsButton(if (advanced) stringResource(Res.string.settings_collapse) else stringResource(Res.string.settings_expand), onClick = { advanced = !advanced })
                                }
                                AnimatedVisibility(advanced, enter = motion.expandIn(), exit = motion.collapseOut()) {
                                    SettingsRow(stringResource(Res.string.settings_render_benchmark)) {
                                        SettingsButton(stringResource(Res.string.settings_open), onClick = { pages.push(SettingsPageRoute.TerminalBench) })
                                    }
                                }
                            }
                        }
                        SettingsSection.ABOUT -> AppAboutSection()
                    }
                }
            }
            is SettingsPageRoute.Backend -> {
                LaunchedEffect(controller, route.id) { controller.loadProfiles(route.id) }
                SettingsPage(backendLabel(route.id), back) {
                    ControllerMessages(controller)
                    BackendProfilesSection(
                        controller, route.id,
                        onEdit = { pages.push(SettingsPageRoute.Profile(route.id, it)) },
                        onAdd = { pages.push(SettingsPageRoute.Add(route.id)) },
                    )
                }
            }
            is SettingsPageRoute.Profile -> {
                val profile = state.profileLists[route.backend]?.firstOrNull { it.id == route.id }
                SettingsPage(profile?.name ?: stringResource(Res.string.settings_provider), back) {
                    ControllerMessages(controller)
                    if (profile != null) BackendProfileEditor(
                        backendId = route.backend, profile = profile, controller = controller,
                        isDefault = defaultProfileId(state, route.backend) == profile.id,
                        onDeleted = { pages.pop() },
                    ) else PageBanner(stringResource(Res.string.settings_provider_missing), SettingsNoticeKind.ERROR)
                }
            }
            is SettingsPageRoute.Add -> SettingsPage(stringResource(Res.string.settings_add_provider_title, backendLabel(route.backend)), back) {
                ControllerMessages(controller)
                AddProfileForm(route.backend, controller, onCancel = back, onCreated = { pages.pop() })
            }
            SettingsPageRoute.Owner -> {
                rememberResourceEnvironment()
                SettingsPage(L10n.uiText("owner.title"), back) { OwnerProfilePage(owner) }
            }
            SettingsPageRoute.QuickChatPresets -> SettingsPage(stringResource(Res.string.settings_quick_chat_presets), back) {
                ControllerMessages(controller)
                QuickChatPresetsEditor(controller)
            }
            SettingsPageRoute.PairDevice -> SettingsPage(stringResource(Res.string.settings_pair_device), back) { PairDeviceSection(api) }
            SettingsPageRoute.TerminalBench -> TerminalBenchScreen(onBack = back)
        }
    }
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

/** Settings share the same scrollable chrome and style scope as the rest of the app. */
@Composable
internal fun SettingsPage(
    title: String, onBack: () -> Unit, large: Boolean = false,
    searchTarget: SettingsSearchTarget? = null, content: @Composable ColumnScope.() -> Unit,
) {
    val typography = LocalRiffetTypography.current
    CompositionLocalProvider(
        LocalRiffetTypography provides typography.copy(subhead = typography.bodySmall, caption = typography.bodySmall),
        LocalSettingsSearchTarget provides searchTarget,
    ) {
        riffet.ui.app.ScrollablePage(title, onBack, large, compactTitle = true, content = content)
    }
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
    } else SettingsGroup(stringResource(Res.string.settings_server_settings)) {
        SettingsRow(stringResource(Res.string.settings_load_failed_title), stringResource(Res.string.settings_load_failed_desc)) {
            SettingsButton(stringResource(Res.string.settings_retry), onClick = controller::load)
        }
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

/** A built-in palette's description comes from resources; a shared custom theme keeps the server's. */
@Composable
private fun themeSummary(entry: ThemeEntry): String = when (entry.id) {
    ThemeId.RIFFET.id -> stringResource(Res.string.settings_theme_summary_riffet)
    ThemeId.SOLARIZED.id -> stringResource(Res.string.settings_theme_summary_solarized)
    ThemeId.CATPPUCCIN.id -> stringResource(Res.string.settings_theme_summary_catppuccin)
    ThemeId.ROSE_PINE.id -> stringResource(Res.string.settings_theme_summary_rose_pine)
    ThemeId.KILN.id -> stringResource(Res.string.settings_theme_summary_kiln)
    ThemeId.EVERFOREST.id -> stringResource(Res.string.settings_theme_summary_everforest)
    ThemeId.INK.id -> stringResource(Res.string.settings_theme_summary_ink)
    ThemeId.SEPIA.id -> stringResource(Res.string.settings_theme_summary_sepia)
    ThemeId.MOSS.id -> stringResource(Res.string.settings_theme_summary_moss)
    ThemeId.SLATE.id -> stringResource(Res.string.settings_theme_summary_slate)
    ThemeId.PENCIL.id -> stringResource(Res.string.settings_theme_summary_pencil)
    ThemeId.CELADON.id -> stringResource(Res.string.settings_theme_summary_celadon)
    else -> entry.summary
}

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
private fun ThemeSection(
    themeMode: ThemeMode,
    onThemeModeChange: (ThemeMode) -> Unit,
    themes: List<ThemeEntry>,
    themeId: String,
    onThemeIdChange: (String) -> Unit,
) {
    val display = DisplaySettings.shared
    SettingsGroup(title = stringResource(Res.string.settings_appearance)) {
        AppearanceRow(themeMode, onThemeModeChange)
        SettingsSwitchRow(title = stringResource(Res.string.settings_amoled),
            description = stringResource(Res.string.settings_amoled_desc),
            checked = display.amoled, onCheckedChange = display::changeAmoled)
    }
    riffet.ui.theme.AppearanceResourcesPicker()
    val activePaletteId = riffet.ui.theme.LocalAppearanceResources.current?.palette?.id ?: themeId
    SettingsGroup(title = stringResource(Res.string.settings_theme)) { ThemeGallery(themes, activePaletteId, onThemeIdChange) }
    SettingsFootnote(stringResource(Res.string.settings_theme_footnote))
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

/**
 * The palette picker.
 *
 * A column rather than the segmented control the other rows use: the options have Latin names that
 * do not fit across a phone, and a swatch says more about a palette than a name does. It renders
 * whatever catalogue the caller holds — built-ins plus the themes shared through this server — so a
 * theme created on the web or the Mac appears here with nothing to restate.
 */
@Composable
private fun ThemeGallery(themes: List<ThemeEntry>, selected: String, onSelect: (String) -> Unit) {
    themes.forEach { entry -> ThemeGalleryRow(entry, entry.id == selected, onSelect) }
}

@Composable
private fun ThemeGalleryRow(entry: ThemeEntry, selected: Boolean, onSelect: (String) -> Unit) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .selectable(selected = selected, role = Role.RadioButton) { onSelect(entry.id) }
            .padding(horizontal = metrics.pageInset, vertical = metrics.rowPadding),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(metrics.sectionGap / 2),
    ) {
        ThemeSwatch(entry)
        Column(Modifier.weight(1f)) {
            Text(entry.name, style = typography.body, color = colors.fg)
            val summary = themeSummary(entry)
            if (summary.isNotEmpty()) {
                Spacer(Modifier.height(2.dp))
                Text(
                    summary,
                    style = typography.caption,
                    color = colors.fg3,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        riffet.ui.design.SelectionMark(selected)
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
private fun AppearanceRow(themeMode: ThemeMode, onThemeModeChange: (ThemeMode) -> Unit) {
    val title = stringResource(Res.string.settings_color_mode)
    Column(modifier = Modifier.fillMaxWidth().settingsSearchAnchor(title).padding(horizontal = 16.dp, vertical = 14.dp)) {
        Text(stringResource(Res.string.settings_color_mode), style = LocalRiffetTypography.current.body, color = LocalRiffetColors.current.fg)
        Spacer(Modifier.height(10.dp))
        SettingsSegmented(
            options = listOf(
                ThemeMode.SYSTEM.name to stringResource(Res.string.settings_theme_mode_system),
                ThemeMode.LIGHT.name to stringResource(Res.string.settings_theme_mode_light),
                ThemeMode.DARK.name to stringResource(Res.string.settings_theme_mode_dark),
            ),
            value = themeMode.name,
            onSelect = { ThemeMode.entries.firstOrNull { mode -> mode.name == it }?.let(onThemeModeChange) },
        )
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
) {
    Column(modifier = Modifier.fillMaxWidth().settingsSearchAnchor(title).padding(horizontal = 16.dp, vertical = 14.dp)) {
        Text(title, style = LocalRiffetTypography.current.body, color = LocalRiffetColors.current.fg)
        if (description != null) {
            Spacer(Modifier.height(2.dp))
            Text(description, style = LocalRiffetTypography.current.caption, color = LocalRiffetColors.current.fg3)
        }
        Spacer(Modifier.height(10.dp))
        SettingsSegmented(options = options, value = value, enabled = enabled, onSelect = onSelect)
    }
}

/** Sends the log to the server, which keeps it on its own machine, so nobody has to forward a file. */
@Composable
private fun LogUploadRow(api: RiffetApi) {
    val typography = LocalRiffetTypography.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf<String?>(null) }
    SettingsActionRow(
        title = stringResource(Res.string.settings_upload_logs),
        description = result ?: stringResource(Res.string.settings_upload_logs_desc),
    ) {
        RiffetTextButton(enabled = !busy, onClick = {
            busy = true
            scope.launch {
                result = try {
                    AppLog.log("app", "upload requested")
                    val saved = api.uploadClientLog(AppLog.exportName(), redactLog(AppLog.export()))
                    getString(Res.string.settings_upload_success, saved.path, saved.bytes / 1024)
                } catch (cancellation: CancellationException) {
                    throw cancellation
                } catch (error: Throwable) {
                    getString(Res.string.settings_upload_failed, (error.message ?: error::class.simpleName).toString())
                } finally {
                    busy = false
                }
            }
        }) { Text(if (busy) stringResource(Res.string.settings_uploading) else stringResource(Res.string.settings_upload), style = typography.button) }
    }
}

/**
 * 导出日志: the device's [AppLog] saved into 下载/Riffet and handed to the share sheet, so it can be
 * sent straight to whoever is chasing a problem. Where nothing can be saved only 清空 is offered.
 */
@Composable
private fun LogExportRow() {
    val typography = LocalRiffetTypography.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf<String?>(null) }
    SettingsActionRow(
        title = if (downloadsSupported) stringResource(Res.string.settings_export_logs) else stringResource(Res.string.settings_clear_logs),
        description = result ?: if (downloadsSupported) {
            stringResource(Res.string.settings_export_logs_desc)
        } else {
            stringResource(Res.string.settings_export_unavailable_desc)
        },
    ) {
        RiffetTextButton(enabled = !busy, onClick = {
            scope.launch {
                AppLog.clear()
                result = getString(Res.string.settings_logs_cleared)
            }
        }) { Text(stringResource(Res.string.settings_clear), style = typography.button) }
        if (downloadsSupported) RiffetTextButton(enabled = !busy, onClick = {
            busy = true
            scope.launch {
                result = try {
                    AppLog.log("app", "export requested")
                    val bytes = redactLog(AppLog.export()).encodeToByteArray()
                    val saved = saveDownload(AppLog.exportName(), "text/plain", bytes)
                    shareSavedFile(saved, getString(Res.string.settings_share_logs))
                    getString(Res.string.settings_export_success, saved.location, bytes.size / 1024)
                } catch (cancellation: CancellationException) {
                    throw cancellation
                } catch (error: Throwable) {
                    getString(Res.string.settings_export_failed, (error.message ?: error::class.simpleName).toString())
                } finally {
                    busy = false
                }
            }
        }) { Text(if (busy) stringResource(Res.string.settings_exporting) else stringResource(Res.string.settings_export), style = typography.button) }
    }
}


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
        SettingsRow(stringResource(Res.string.settings_notification_permission), if (access == NotificationAccess.ALLOWED) stringResource(Res.string.settings_allowed) else stringResource(Res.string.settings_not_allowed)) {
            SettingsButton(stringResource(Res.string.settings_system_settings), onClick = ::openNotificationSettings)
        }
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
    status.batteryExempt?.let { exempt ->
        SettingsRow(
            stringResource(Res.string.settings_keepalive_battery),
            if (exempt) stringResource(Res.string.settings_allowed) else stringResource(Res.string.settings_not_allowed),
        ) {
            if (!exempt) SettingsButton(stringResource(Res.string.settings_keepalive_allow), primary = true, onClick = { open(KeepAlivePage.BATTERY) })
        }
    }
    val hint = when (status.vendor) {
        KeepAliveVendor.OPPO -> Res.string.settings_keepalive_hint_oppo
        KeepAliveVendor.XIAOMI -> Res.string.settings_keepalive_hint_xiaomi
        KeepAliveVendor.VIVO -> Res.string.settings_keepalive_hint_vivo
        KeepAliveVendor.HUAWEI, KeepAliveVendor.HONOR -> Res.string.settings_keepalive_hint_huawei
        KeepAliveVendor.SAMSUNG, null -> Res.string.settings_keepalive_hint_default
    }
    SettingsRow(stringResource(Res.string.settings_keepalive_background), stringResource(hint)) {
        SettingsButton(stringResource(Res.string.settings_system_settings), onClick = { open(KeepAlivePage.BACKGROUND) })
    }
    if (status.autostart) {
        SettingsRow(stringResource(Res.string.settings_keepalive_autostart)) {
            SettingsButton(stringResource(Res.string.settings_system_settings), onClick = { open(KeepAlivePage.AUTOSTART) })
        }
    }
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
private val MAX_LIVE_PRESETS = listOf(0, 12, 24, 48)

/** The presets, plus a value set elsewhere (another client, the API) so the control still shows it. */
private fun withCurrent(presets: List<Int>, current: Int) = if (current in presets) presets else (presets + current).sorted()

@Composable
private fun idleLabel(minutes: Int) = when {
    minutes == 0 -> stringResource(Res.string.settings_extra_idle_off)
    minutes % 60 == 0 -> stringResource(Res.string.settings_extra_idle_hours, minutes / 60)
    else -> stringResource(Res.string.settings_extra_idle_minutes, minutes)
}

/** When the server stops the CLIs of conversations nobody uses; the next message resumes them. */
@Composable
private fun ReclaimSection(controller: SettingsController) {
    val state by controller.state.collectAsState()
    ControllerMessages(controller)
    val settings = state.settings ?: return
    val idle = settings.idleReclaimMinutes ?: 360
    val maxLive = settings.maxLiveAgents ?: 24
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
            title = stringResource(Res.string.settings_reclaim_max_live),
            description = stringResource(Res.string.settings_reclaim_max_live_desc),
            options = withCurrent(MAX_LIVE_PRESETS, maxLive).map { it.toString() to if (it == 0) stringResource(Res.string.settings_reclaim_unlimited) else stringResource(Res.string.settings_reclaim_limit_count, it) },
            value = maxLive.toString(),
            enabled = !state.saving,
            onSelect = { if (it.toInt() != maxLive) save(AppSettingsUpdate(maxLiveAgents = it.toInt())) },
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
        SettingsRow(stringResource(Res.string.settings_quick_chat_presets)) {
            SettingsButton(stringResource(Res.string.settings_quick_chat_edit), enabled = !busy, onClick = onEditPresets)
        }
        val days = settings.quickChat?.retentionDays ?: 7
        var archiveOpen by remember { mutableStateOf(false) }
        SettingsRow(stringResource(Res.string.settings_quick_chat_archive)) {
            Box {
                SettingsButton(
                    if (days == 0) stringResource(Res.string.settings_quick_chat_never) else stringResource(Res.string.settings_quick_chat_days, days),
                    enabled = !busy,
                    onClick = { archiveOpen = true },
                )
                RiffetDropdownMenu(expanded = archiveOpen, onDismissRequest = { archiveOpen = false }, modifier = Modifier.widthIn(min = 160.dp)) {
                    listOf(1, 3, 7, 14, 30, 0).forEach { choice ->
                        RiffetMenuItem(
                            onClick = {
                                archiveOpen = false
                                if (days != choice) controller.saveQuickChat(retentionDays = choice)
                            },
                            selected = days == choice,
                            showCheck = true,
                        ) {
                            Text(
                                if (choice == 0) stringResource(Res.string.settings_quick_chat_never) else stringResource(Res.string.settings_quick_chat_days, choice),
                                style = RiffetMenuText,
                                color = LocalRiffetColors.current.fg,
                            )
                        }
                    }
                }
            }
        }
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

/**
 * The preset list editor: tap a row to change its name or prompt, add, delete, or restore the
 * server's defaults. Every action writes the whole list, which is what the PATCH route replaces.
 */
@Composable
private fun QuickChatPresetsEditor(controller: SettingsController) {
    val state by controller.state.collectAsState()
    val settings = state.settings ?: return
    val presets = settings.quickChat?.presets.orEmpty()
    val busy = state.saving
    var editing by remember { mutableStateOf<QuickChatPreset?>(null) }
    var deleting by remember { mutableStateOf<QuickChatPreset?>(null) }
    var confirmRestore by remember { mutableStateOf(false) }

    SettingsGroup(
        title = "",
        card = presets.isNotEmpty(),
        action = {
            SettingsButton(
                text = stringResource(Res.string.settings_quick_chat_add),
                enabled = !busy && presets.size < MAX_QUICK_CHAT_PRESETS,
                onClick = { editing = QuickChatPreset(id = "", name = "", prompt = "") },
            )
        },
    ) {
        presets.forEach { preset ->
            PresetRow(
                preset = preset,
                enabled = !busy,
                onEdit = { editing = preset },
                onDelete = { deleting = preset },
            )
        }
    }
    SettingsFootnote(stringResource(Res.string.settings_quick_chat_presets_limit))
    SettingsGroup(title = "") {
        SettingsRow(stringResource(Res.string.settings_quick_chat_restore_defaults)) {
            SettingsButton(stringResource(Res.string.settings_quick_chat_restore), enabled = !busy, onClick = { confirmRestore = true })
        }
    }

    editing?.let { preset ->
        QuickChatPresetDialog(
            initial = preset,
            existingIds = presets.map { it.id },
            onDismiss = { editing = null },
            onSave = { saved ->
                val next = if (preset.id.isEmpty()) presets + saved else presets.map { if (it.id == preset.id) saved else it }
                editing = null
                controller.saveQuickChat(presets = next)
            },
        )
    }
    deleting?.let { preset ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text(stringResource(Res.string.settings_quick_chat_delete_title)) },
            confirmButton = {
                RiffetTextButton(danger = true, onClick = {
                    deleting = null
                    controller.saveQuickChat(presets = presets.filterNot { it.id == preset.id })
                }) { Text(stringResource(Res.string.settings_quick_chat_delete)) }
            },
            dismissButton = {
                RiffetTextButton(onClick = { deleting = null }) { Text(stringResource(Res.string.settings_cancel)) }
            },
        )
    }
    if (confirmRestore) {
        AlertDialog(
            onDismissRequest = { confirmRestore = false },
            title = { Text(stringResource(Res.string.settings_quick_chat_restore_title)) },
            confirmButton = {
                RiffetTextButton(danger = true, onClick = {
                    confirmRestore = false
                    controller.saveQuickChat(resetPresets = true)
                }) { Text(stringResource(Res.string.settings_quick_chat_restore)) }
            },
            dismissButton = {
                RiffetTextButton(onClick = { confirmRestore = false }) { Text(stringResource(Res.string.settings_cancel)) }
            },
        )
    }
}

@Composable
private fun PresetRow(preset: QuickChatPreset, enabled: Boolean, onEdit: () -> Unit, onDelete: () -> Unit) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    Row(
        modifier = Modifier.fillMaxWidth().clickable(enabled = enabled, role = Role.Button, onClick = onEdit).padding(start = 16.dp, end = 8.dp, top = 14.dp, bottom = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(preset.name, style = typography.body, color = colors.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Spacer(Modifier.height(2.dp))
            Text(preset.prompt, style = typography.caption, color = colors.fg3, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        Spacer(Modifier.width(8.dp))
        RiffetIconButton(onClick = onDelete, enabled = enabled) {
            Icon(
                RiffetIcons.Trash,
                contentDescription = stringResource(Res.string.settings_quick_chat_delete),
                tint = if (enabled) colors.fg3 else colors.fg4,
                modifier = Modifier.size(20.dp),
            )
        }
    }
}

@Composable
private fun QuickChatPresetDialog(
    initial: QuickChatPreset,
    existingIds: List<String>,
    onDismiss: () -> Unit,
    onSave: (QuickChatPreset) -> Unit,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    var name by remember(initial.id) { mutableStateOf(initial.name) }
    var prompt by remember(initial.id) { mutableStateOf(initial.prompt) }
    val id = initial.id.ifEmpty { nextPresetId(existingIds) }
    AlertDialog(
        wideContent = true,
        onDismissRequest = onDismiss,
        title = {
            Text(stringResource(if (initial.id.isEmpty()) Res.string.settings_quick_chat_new_preset else Res.string.settings_quick_chat_edit_preset))
        },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(metrics.sectionGap / 2)) {
                SettingsField(
                    value = name,
                    onValueChange = { name = it.take(MAX_PRESET_NAME) },
                    placeholder = stringResource(Res.string.settings_quick_chat_preset_name),
                )
                SettingsField(
                    value = prompt,
                    onValueChange = { prompt = it.take(MAX_PRESET_PROMPT) },
                    placeholder = stringResource(Res.string.settings_quick_chat_preset_prompt),
                    singleLine = false,
                    minLines = 4,
                    maxLines = 8,
                )
            }
        },
        confirmButton = {
            RiffetTextButton(
                onClick = { onSave(QuickChatPreset(id, name.trim(), prompt.trim())) },
                enabled = name.isNotBlank() && prompt.isNotBlank(),
            ) { Text(stringResource(Res.string.session_save)) }
        },
        dismissButton = {
            RiffetTextButton(onClick = onDismiss) { Text(stringResource(Res.string.session_cancel)) }
        },
    )
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
    UnsavedSettingsGuard(dirty, busy, onSave = ::save)
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

@Composable
private fun EnvironmentSection(controller: SettingsController) {
    val metrics = LocalInterfaceStyle.current.metrics
    val state by controller.state.collectAsState()
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val capabilities = state.capabilities

    SettingsGroup(
        title = stringResource(Res.string.settings_runtime_environment),
        action = {
            SettingsButton(
                text = if (state.diagnosticsLoading) stringResource(Res.string.settings_checking) else stringResource(Res.string.settings_recheck),
                enabled = !state.diagnosticsLoading,
                onClick = { controller.loadDiagnostics() },
            )
        },
    ) {
        if (capabilities == null) {
            Text(
                text = stringResource(Res.string.settings_no_cli_capabilities),
                style = typography.caption,
                color = colors.fg3,
                modifier = Modifier.padding(horizontal = metrics.pageInset, vertical = metrics.rowPadding),
            )
        } else {
            SettingsValueRow(stringResource(Res.string.settings_version), capabilities.cliVersion ?: stringResource(Res.string.settings_unknown))
            SettingsValueRow(stringResource(Res.string.settings_path), capabilities.cliPath)
            SettingsValueRow(
                if (capabilities.authMessage?.startsWith("Custom Cursor provider") == true) stringResource(Res.string.settings_custom_service) else stringResource(Res.string.settings_account),
                if (capabilities.authenticated) {
                    if (capabilities.authMessage?.startsWith("Custom Cursor provider") == true) stringResource(Res.string.settings_connected) else stringResource(Res.string.settings_signed_in)
                } else {
                    stringResource(Res.string.settings_signed_out)
                },
            )
            SettingsValueRow("tmux", if (capabilities.tmux) stringResource(Res.string.settings_available) else stringResource(Res.string.settings_not_installed))
            SettingsValueRow(stringResource(Res.string.settings_persistence), capabilities.nativePersistence)
            SettingsValueRow("Tailscale", if (capabilities.tailscale.present) capabilities.tailscale.message else stringResource(Res.string.settings_not_detected))
            SettingsValueRow(stringResource(Res.string.settings_checked_at), capabilities.checkedAt)
        }
    }

    if (capabilities != null && capabilities.warnings.isNotEmpty()) {
        Spacer(Modifier.height(16.dp))
        Column(verticalArrangement = Arrangement.spacedBy(metrics.controlInset / 2)) {
            capabilities.warnings.forEach { warning -> PageBanner(warning, SettingsNoticeKind.WARNING) }
        }
    }

    if (capabilities != null && capabilities.models.isNotEmpty()) {
        SettingsGroup(title = stringResource(Res.string.settings_available_models, capabilities.models.size)) {
            Text(
                text = capabilities.models.joinToString("  "),
                style = typography.monoSmall,
                color = colors.fg2,
                modifier = Modifier.padding(horizontal = metrics.pageInset, vertical = metrics.rowPadding),
            )
        }
    }
}
