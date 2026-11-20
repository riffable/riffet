package riffet.ui.app

import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.derivedStateOf
import kotlinx.coroutines.delay

import riffet.ui.design.riffetMaterialSource

import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Text
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.hideFromAccessibility
import androidx.compose.ui.semantics.semantics
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.jetbrains.compose.resources.getString
import org.jetbrains.compose.resources.stringResource
import riffet_mobile.shared.generated.resources.*
import riffet.cache.ThemeLibraryCache
import riffet.cache.createLocalFiles
import riffet.contracts.NativeBackendId
import riffet.contracts.Project
import riffet.contracts.Session
import riffet.shared.AppPreferences
import riffet.shared.DisplaySettings
import riffet.shared.rememberAssistant
import riffet.shared.reportAssistantTimeZone
import riffet.ui.assistant.AssistantEntries
import riffet.ui.assistant.AssistantSetup
import riffet.ui.assistant.AssistantSheet
import riffet.ui.assistant.AssistantSheets
import riffet.shared.assistantMain
import riffet.shared.assistantProject
import riffet.ui.home.AssistantHome
import riffet.ui.settings.ExtensionsPage
import riffet_mobile.shared.generated.resources.assistant_abilities
import riffet.shared.LocalNativeFeatures
import riffet.shared.NativeFeatures
import riffet.shared.PreferenceKeys
import riffet.shared.SessionUpdate
import riffet.shared.ThemeId
import riffet.shared.ThemeMode
import riffet.shared.RiffetApi
import riffet.shared.RiffetConnection
import riffet.shared.createAppPreferences
import riffet.shared.isAssistant
import riffet.ui.downloads.DownloadFeedback
import riffet.ui.downloads.DownloadsScreen
import riffet.ui.files.FilesPanel
import riffet.ui.focus.FocusCoordinator
import riffet.ui.focus.LocalFocusCoordinator
import riffet.ui.focus.keyboardPadding
import riffet.ui.git.GitPanel
import riffet.ui.home.HOME_DRAFT_ID
import riffet.ui.home.ProjectHome
import riffet.ui.home.rememberHomeConfigs
import riffet.ui.pairing.PairingScreen
import riffet.ui.session.RenameSessionDialog
import riffet.ui.session.SessionDetailController
import riffet.ui.timeline.prepareTranscriptMarkdown
import riffet.ui.timeline.TimelinePresenter
import riffet.ui.session.SessionDeletionDialog
import riffet.ui.session.SessionDetailsPane
import riffet.ui.session.rememberSessionDeletion
import riffet.ui.session.SessionScreen
import riffet.ui.interaction.InteractionDrafts
import riffet.ui.interaction.LocalInteractionDrafts
import riffet.ui.interaction.LocalTerminalOpen
import riffet.ui.session.SubagentScreen
import riffet.ui.session.SubagentTarget
import riffet.ui.sessionlist.ExternalSessionPickerSheet
import riffet.ui.sessionlist.SessionAction
import riffet.ui.sessionlist.SessionList
import riffet.ui.sessionlist.waitingCount
import riffet.ui.sessionlist.visibleGroups
import riffet.ui.settings.OwnerController
import riffet.ui.settings.SettingsScreen
import riffet.ui.settings.LocalSettingsScreen
import riffet.ui.onboarding.LocalSetupActions
import riffet.ui.onboarding.OnboardingFlow
import riffet.ui.onboarding.OnboardingPage
import riffet.ui.onboarding.SetupActions
import riffet.shared.NotificationAccess
import riffet.shared.rememberNotificationAccess
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.mutableIntStateOf
import riffet.ui.composer.ComposerDrafts
import riffet.ui.composer.LocalComposerDrafts
import riffet.ui.stats.StatsScreen
import riffet.ui.state.SessionStore
import riffet.ui.state.SessionMarks
import androidx.compose.ui.graphics.toArgb
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.ThemeEntry
import riffet.ui.theme.RiffetTheme
import riffet.ui.theme.WorkbenchAppearance
import riffet.ui.theme.applyWorkbenchAppearance
import riffet.ui.theme.themeCatalog
import riffet.ui.timeline.TimelineFocusTarget
import riffet.ui.timeline.RiffetImageAuth
import riffet.ui.timeline.ImageViewerHost
import riffet.ui.timeline.platformNowMillis
import riffet.ui.terminal.TerminalScreen
import riffet.shared.themes
import riffet.shared.serverOrigin

/** The workbench plus the actual history of pages opened over it. */
@Stable
class RiffetNavigation {
    internal val pages = PageStack<RiffetPage>(RiffetPage.Workbench)
    internal val backDispatcher = PageBackDispatcher()
    var session: Session? by mutableStateOf(null)
        private set
    /** 新建任务's project; null lets it pick the last-used one. */
    var projectId: String? by mutableStateOf(null)
        internal set
    /** The drawer's project scope over 任务 (a sidebar group id); null is every project. */
    var scope: String? by mutableStateOf(null)
        internal set
    /** The bottom bar's destination under any open session; restored from the device on first composition. */
    var tab: HomeTab by mutableStateOf(HomeTab.TASKS)
        internal set
    internal var tabRestored = false
    var drawerOpen: Boolean by mutableStateOf(false)
        internal set
    /** The drawer's owner header asked for the 设置 tab's owner page; the tab clears it once pushed. */
    internal var ownerPageRequested: Boolean by mutableStateOf(false)
    var detailsOpen: Boolean by mutableStateOf(false)
        internal set

    var statsOpen: Boolean
        get() = pages.contains { it == RiffetPage.Stats }
        internal set(value) = setPage(RiffetPage.Stats, value)
    var downloadsOpen: Boolean
        get() = pages.contains { it == RiffetPage.Downloads }
        internal set(value) = setPage(RiffetPage.Downloads, value)
    /** The assistant's 能力: the extensions page scoped to it. */
    var abilitiesOpen: Boolean
        get() = pages.contains { it == RiffetPage.Abilities }
        internal set(value) = setPage(RiffetPage.Abilities, value)
    var pairingRequested: Boolean
        get() = pages.contains { it == RiffetPage.Pairing }
        internal set(value) = setPage(RiffetPage.Pairing, value)
    internal var panel: ProjectPanel?
        get() = pages.entries.mapNotNull { (it.route as? RiffetPage.Panel)?.panel }.lastOrNull()
        set(value) {
            if (value == null) pages.removeFrom { it is RiffetPage.Panel }
            else if (pages.current !is RiffetPage.Panel || panel != value) {
                pages.push(RiffetPage.Panel(value, fileTarget))
            }
        }
    internal var subagent: SubagentTarget?
        get() = pages.entries.mapNotNull { (it.route as? RiffetPage.Subagent)?.target }.lastOrNull()
        set(value) {
            if (value == null) pages.removeFrom { it is RiffetPage.Subagent }
            else if ((pages.current as? RiffetPage.Subagent)?.target != value) pages.push(RiffetPage.Subagent(value))
        }
    internal var terminal: TerminalTarget?
        get() = pages.entries.mapNotNull { (it.route as? RiffetPage.Terminal)?.target }.lastOrNull()
        set(value) {
            if (value == null) pages.removeFrom { it is RiffetPage.Terminal }
            else if ((pages.current as? RiffetPage.Terminal)?.target != value) pages.push(RiffetPage.Terminal(value))
        }
    internal var pairingAddress: String? by mutableStateOf(null)
    /** The pairing page opens on the scanner. */
    internal var pairingScan: Boolean by mutableStateOf(false)
    internal val connectionOperation = mutableStateOf<String?>(null)

    fun resetForServer(skipRestore: Boolean = false) {
        close()
        pages.reset()
        ownerPageRequested = false
        projectId = null
        scope = null
        fileTarget = null
        pairingAddress = null
        pairingScan = false
        restored = skipRestore
        requested = null
        startRequest = null
        focus = null
    }

    internal var fileTarget: FileTarget? by mutableStateOf(null)
    internal var restored = false
    internal var requested: SessionRequest? by mutableStateOf(null)

    /** A one-shot entry into 新建任务 with text in the composer (`riffet://new?prompt=`). */
    internal var startRequest: StartRequest? by mutableStateOf(null)
    internal var focus: TimelineFocus? by mutableStateOf(null)
    var backSwipe: BackSwipe? by mutableStateOf(null)
        private set
    private var fallbackBack: (() -> Unit)? = null

    val canGoBack: Boolean get() = backDispatcher.canGoBack || pages.canPop || detailsOpen || drawerOpen || session != null

    /** Opens the pairing page, with [address] filled in or straight on the scanner. */
    internal fun requestPairing(address: String? = null, scan: Boolean = false) {
        pairingAddress = address
        pairingScan = scan
        pairingRequested = true
    }

    fun request(sessionId: String, sequence: Long? = null) { requested = SessionRequest(sessionId, sequence) }

    /** Opens 新建任务 with [text] in the composer. */
    fun requestStart(text: String?) {
        startRequest = StartRequest(text)
    }

    /** Opens the 新会话 tab on 新建任务 in [projectId], or the last-used project. */
    fun openStart(projectId: String? = null) {
        close()
        tab = HomeTab.NEW_SESSION
        if (projectId != null) this.projectId = projectId
    }

    fun open(target: Session) {
        cancelBackGesture()
        pages.popToRoot()
        drawerOpen = false
        detailsOpen = false
        projectId = target.projectId
        session = target
    }

    /** Leaves the UI visit; the selected session's stream remains open in the store. */
    fun close() {
        cancelBackGesture()
        pages.popToRoot()
        drawerOpen = false
        detailsOpen = false
        session = null
    }

    private fun setPage(page: RiffetPage, open: Boolean) {
        if (open && !pages.contains { it == page }) pages.push(page)
        if (!open) pages.removeFrom { it == page }
    }

    fun beginBackGesture() {
        fallbackBack = null
        if (!backDispatcher.canGoBack) {
            val visit = pages.entries.last().id
            val sessionId = session?.id
            val drawers = drawerOpen to detailsOpen
            fallbackBack = {
                if (!backDispatcher.canGoBack && pages.entries.last().id == visit && session?.id == sessionId && drawers == (drawerOpen to detailsOpen)) {
                    if (!backFromOverlay()) close()
                }
            }
        }
        backDispatcher.begin()
    }
    fun updateBackGesture(progress: Float, fromLeft: Boolean) {
        backSwipe = BackSwipe(progress, fromLeft)
        backDispatcher.progress(progress, fromLeft)
    }
    /** Covered drawers and other transient layers cannot preview another target's gesture. */
    internal fun backSwipeFor(target: PageBackTarget): BackSwipe? =
        backSwipe?.takeIf { backDispatcher.isGestureTarget(target) }
    fun cancelBackGesture() { backDispatcher.cancel(); fallbackBack = null; backSwipe = null }
    fun finishBackGesture() {
        backDispatcher.finish()
        val fallback = fallbackBack
        fallbackBack = null
        fallback?.invoke()
        backSwipe = null
    }
    fun backFromOverlay(): Boolean = when {
        pages.canPop -> pages.pop()
        detailsOpen -> { detailsOpen = false; true }
        drawerOpen -> { drawerOpen = false; true }
        else -> false
    }
}

/**
 * The root composable.
 *
 * `store == null` means no working connection exists yet: the first launch shows the full-screen
 * onboarding, and otherwise the tabs run with the server-backed pages replaced by the setup island and the
 * empty state ([UnconnectedWorkbench]). Otherwise
 * the workbench is always composed — the 新会话 / 任务 / 设置 tabs, with the open session over them —
 * and re-pairing, statistics, downloads and the project panels are drawn over it. Keeping the workbench mounted
 * under them is what lets "back" from Git land on the same scroll position and the same draft.
 */
@Composable
fun RiffetApp(
    store: SessionStore?,
    connection: RiffetConnection,
    onPaired: (RiffetApi) -> Unit,
    navigation: RiffetNavigation,
    modifier: Modifier = Modifier,
    writeScope: CoroutineScope? = null,
    onDisconnected: () -> Unit = {},
    drafts: ComposerDrafts? = null,
    /** Saved replies (收藏); the Android host makes one, other hosts may leave it null. */
    marks: SessionMarks? = null,
    /** Asks the system for notifications and calls back once it answered; null where there is nothing to ask. */
    requestNotifications: ((() -> Unit) -> Unit)? = null,
    /** Whether any server was ever paired on this device, read before the first frame; true keeps the first-launch onboarding away. */
    hasSavedPairing: Boolean = true,
    deviceAppearance: WorkbenchAppearance? = null,
) {
    val preferences = remember { createAppPreferences() }
    var themeMode by remember { mutableStateOf(preferences.themeMode()) }
    // The palette is its own preference, not a fourth `ThemeMode`: "follow the system" picks the mode
    // only, so a reader on a Solarized phone still gets Solarized after dark.
    //
    // The stored value is a plain string, not a [ThemeId]: the picker also lists themes from the
    // server's shared library, which this build cannot enumerate. An id that does not resolve paints
    // the default and is left in storage until a *successful* fetch proves it is gone.
    var themeId by remember { mutableStateOf(ThemeId.stored(preferences.string(PreferenceKeys.THEME_ID))) }
    val api = connection.apiOrNull()
    DisposableEffect(connection) {
        val uninstall = RiffetImageAuth.install { connection.apiOrNull() }
        onDispose { uninstall() }
    }
    val iconPacks = riffet.ui.icons.rememberIconPacks(api, preferences)
    val appearanceResources = riffet.ui.theme.rememberAppearanceResources(api)
    val origin = api?.baseUrl?.let(::serverOrigin)
    val serverPreferences = remember(preferences, origin) { serverPreferences(preferences, origin) }
    val composerDraftsRoot = drafts ?: remember(preferences) { ComposerDrafts(preferences) }
    val composerDrafts = remember(composerDraftsRoot, origin) { composerDraftsRoot.forServer(origin) }
    val disconnected: () -> Unit = {
        navigation.resetForServer()
        onDisconnected()
    }
    // First launch: only a device that never finished or skipped it and has no saved pairing sees it.
    var onboardingStage by rememberSaveable {
        mutableIntStateOf(if (store != null || hasSavedPairing || preferences.string(ONBOARDING_KEY) != null) ONBOARDING_OFF else OnboardingPage.WELCOME.ordinal)
    }
    val notificationsOpen = rememberNotificationAccess() != NotificationAccess.ALLOWED
    // Decided once at the start: granting it on the page must not drop the page from under the reader.
    val onboardingNotify = rememberSaveable { requestNotifications != null && notificationsOpen }
    val finishOnboarding: () -> Unit = {
        preferences.setString(ONBOARDING_KEY, "1")
        onboardingStage = ONBOARDING_OFF
        navigation.tabRestored = true
        navigation.tab = HomeTab.NEW_SESSION
    }
    LaunchedEffect(Unit) {
        // An existing pairing (an upgrade) never sees it.
        if ((store != null || hasSavedPairing) && preferences.string(ONBOARDING_KEY) == null) preferences.setString(ONBOARDING_KEY, "1")
    }
    val paired: (RiffetApi) -> Unit = { next ->
        navigation.resetForServer()
        navigation.restored = true
        // A pairing that succeeds on the connect page moves straight on, without drawing it again.
        if (onboardingStage == OnboardingPage.CONNECT.ordinal) {
            if (onboardingNotify) onboardingStage = OnboardingPage.NOTIFY.ordinal else finishOnboarding()
        }
        onPaired(next)
    }
    val setupActions = remember(connection, navigation) {
        SetupActions(
            connection = connection,
            busy = navigation.connectionOperation,
            scan = { navigation.requestPairing(scan = true) },
            connectTo = { address -> navigation.requestPairing(address) },
            enterAddress = { navigation.requestPairing() },
            showSetup = { navigation.tab = HomeTab.NEW_SESSION },
        )
    }
    // The library cache is per server: the same id can mean a different palette on another host.
    // Read synchronously so a stored custom theme is painted in the first frame.
    val themeCache = remember(api?.baseUrl) { api?.baseUrl?.let { ThemeLibraryCache(createLocalFiles(), it) } }
    var themeLibrary by remember(themeCache) { mutableStateOf(themeCache?.load()) }
    val themes = remember(themeLibrary) { themeCatalog(themeLibrary) }
    val currentTheme = themes.firstOrNull { it.id == themeId } ?: themes.first()
    // One writer, held here rather than in the settings screen, so the persisted value and the
    // painted theme can never disagree.
    val onThemeMode: (ThemeMode) -> Unit = { mode ->
        preferences.setThemeMode(mode)
        themeMode = mode
    }
    val onThemeId: (String) -> Unit = { id ->
        if (themes.any { it.id == id }) {
            appearanceResources?.select(riffet.ui.theme.AppearanceSlot.PALETTE, "default")
            preferences.setString(PreferenceKeys.THEME_ID, id)
            themeId = id
        }
    }
    val applyAppearance by rememberUpdatedState { arguments: kotlinx.serialization.json.JsonObject ->
        applyWorkbenchAppearance(arguments, preferences, themes, appearanceResources, onThemeId, onThemeMode)
    }
    DisposableEffect(deviceAppearance, api, appearanceResources) {
        val detach = if (deviceAppearance != null && api != null && appearanceResources != null) {
            deviceAppearance.bind(api) { arguments -> applyAppearance(arguments) }
        } else null
        onDispose { detach?.invoke() }
    }
    val darkTheme = when (themeMode) {
        ThemeMode.SYSTEM -> isSystemInDarkTheme()
        ThemeMode.LIGHT -> false
        ThemeMode.DARK -> true
    }

    androidx.compose.runtime.SideEffect {
        val activeTheme = appearanceResources?.palette ?: currentTheme
        val colors = if (darkTheme) activeTheme.dark else activeTheme.light
        api?.terminalAppearance = riffet.contracts.TerminalAppearance.fromArgb(colors.fg.toArgb(),
            if (darkTheme && DisplaySettings.shared.amoled) androidx.compose.ui.graphics.Color.Black.toArgb() else colors.bg.toArgb())
    }

    // The selection can change while this fetch is in flight; read it at completion rather than
    // capturing the value the effect started with.
    val latestThemeId by rememberUpdatedState(themeId)
    LaunchedEffect(api, themeCache) {
        val api = api ?: return@LaunchedEffect
        val cache = themeCache ?: return@LaunchedEffect
        val library = try {
            api.themes()
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (_: Throwable) {
            // An unreachable server is not evidence of a deletion: keep the cache and the choice.
            return@LaunchedEffect
        }
        if (library.version != 1) return@LaunchedEffect
        themeLibrary = library
        if (latestThemeId.startsWith("custom-") && themeCatalog(library).none { it.id == latestThemeId }) {
            themeId = ThemeId.DEFAULT.id
            preferences.setString(PreferenceKeys.THEME_ID, ThemeId.DEFAULT.id)
        }
        withContext(Dispatchers.Default) { runCatching { cache.save(library) } }
    }

    val display = DisplaySettings.shared
    RiffetTheme(darkTheme = darkTheme, entry = appearanceResources?.palette ?: currentTheme, interfaceStyle = display.interfaceStyle, amoled = display.amoled,
        surfaceMaterial = display.surfaceMaterial, materialStrength = display.materialStrength,
        pageAnimation = display.pageAnimation,
        uiFont = appearanceResources?.uiFont, monoFont = appearanceResources?.monoFont,
        codeThemeId = display.codeTheme,
        customCodeThemes = themes.filter { it.syntax != null }) {
        val density = LocalDensity.current
        val focusCoordinator = remember(store) { FocusCoordinator() }
        // Keep confirmation drafts across page navigation and session switches, scoped to the server.
        val serverInteractionDrafts = remember { mutableMapOf<String?, InteractionDrafts>() }
        val interactionDrafts = remember(origin) { serverInteractionDrafts.getOrPut(origin) { InteractionDrafts() } }
        val snackbarScope = rememberCoroutineScope()
        val snackbar = remember(store, snackbarScope) { RiffetSnackbar(snackbarScope) }
        DisposableEffect(snackbar) { onDispose { snackbar.clear() } }
        key(store) {
            CompositionLocalProvider(
                riffet.ui.icons.LocalIconVectors provides iconPacks.vectors,
                riffet.ui.theme.LocalAppearanceResources provides appearanceResources,
                LocalComposerDrafts provides composerDrafts,
                LocalRiffetSnackbar provides snackbar,
                LocalNativeFeatures provides NativeFeatures.shared,
                LocalSetupActions provides setupActions,
                LocalFocusCoordinator provides focusCoordinator,
                LocalInteractionDrafts provides interactionDrafts,
                LocalPageBackDispatcher provides navigation.backDispatcher,
                // 文字大小 rides on the system's own font scale, so every `sp` in the app follows it.
                LocalDensity provides Density(density.density, density.fontScale * display.textSize.scale),
            ) {
                val colors = LocalRiffetColors.current
                // Outlives the row or sheet that started a write, so leaving it mid-request cannot cancel it.
                // A host's [writeScope] also outlives the Activity, which a rotation recreates.
                val composedScope = rememberCoroutineScope()
                val scope = writeScope ?: composedScope
                // One per server, shared by the drawer's header and the settings pages.
                val owner = remember(api, scope) { api?.let { OwnerController(it, scope) } }
                val hostResumed = riffet.ui.theme.rememberVisualHostResumed()
                LaunchedEffect(owner, hostResumed) { if (hostResumed) owner?.refresh() }

                ImageViewerHost(owner = navigation.session?.id to navigation.pages.entries.last()) {
                Scaffold(
                    modifier = modifier.fillMaxSize(),
                    containerColor = colors.bg,
                    contentColor = colors.fg,
                    snackbarHost = {
                        SnackbarHost(snackbar.hostState,
                            modifier = Modifier.keyboardPadding().padding(bottom = snackbar.bottomPadding), snackbar = { StyleSnackbar(it) })
                    },
                ) { insets ->
                    // The keyboard shrinks each page instead of pushing the window up, so the header
                    // stays on screen and the composer sits right above the keyboard. It is applied per
                    // page, not here: the tabs let the keyboard cover their bottom bar (`HomeShell`).
                    Box(modifier = Modifier.fillMaxSize().padding(insets).consumeWindowInsets(insets)) {
                        // Keep a stable backdrop under the system bars while page alpha layers clip
                        // their overflow during transitions. This source is a sibling of all surfaces.
                        Box(Modifier.matchParentSize().coverSystemBars().riffetMaterialSource(key = origin)) {
                            riffet.ui.theme.AppearanceBackdrop(Modifier.matchParentSize())
                        }
                        if (onboardingStage >= 0) Box(Modifier.fillMaxSize().keyboardPadding()) {
                            if (navigation.pairingRequested) {
                                PairingScreen(connection = connection, onPaired = paired, initialAddress = navigation.pairingAddress.orEmpty(), startWithScan = navigation.pairingScan, operationScope = scope, connectionOperation = navigation.connectionOperation, onCancel = { navigation.pairingRequested = false })
                            } else OnboardingFlow(
                                page = OnboardingPage.entries[onboardingStage],
                                pages = if (onboardingNotify) OnboardingPage.entries else OnboardingPage.entries.filter { it != OnboardingPage.NOTIFY },
                                onPage = { onboardingStage = it.ordinal },
                                onFinish = finishOnboarding,
                                actions = setupActions,
                                requestNotifications = requestNotifications,
                            )
                        } else if (store == null) {
                            PageHost(stack = navigation.pages) { page, back ->
                                Box(Modifier.fillMaxSize().then(if (page == RiffetPage.Workbench) Modifier else Modifier.keyboardPadding())) {
                                    when (page) {
                                        RiffetPage.Workbench -> UnconnectedWorkbench(
                                            navigation = navigation, connection = connection, onPaired = paired, scope = scope,
                                            settings = {
                                                LocalSettingsScreen(
                                                    themeMode = themeMode,
                                                    onThemeModeChange = onThemeMode,
                                                    iconPacks = iconPacks,
                                                    themes = themes,
                                                    themeId = themeId,
                                                    onThemeIdChange = onThemeId,
                                                    onBack = { navigation.tab = HomeTab.NEW_SESSION },
                                                    connection = connection,
                                                    onPaired = paired,
                                                    onRepair = { address -> navigation.requestPairing(address) },
                                                    onDisconnected = disconnected,
                                                    operationScope = scope,
                                                    connectionOperation = navigation.connectionOperation,
                                                )
                                            },
                                        )
                                        RiffetPage.Pairing -> PairingScreen(
                                            connection = connection,
                                            onPaired = paired,
                                            initialAddress = navigation.pairingAddress.orEmpty(),
                                            startWithScan = navigation.pairingScan,
                                            onCancel = back,
                                            operationScope = scope,
                                            connectionOperation = navigation.connectionOperation,
                                        )
                                        RiffetPage.Downloads -> DownloadsScreen(api = null, projectName = { null }, onBack = back)
                                        else -> Unit
                                    }
                                }
                            }
                        } else {
                            val signedOut by store.unauthenticated.collectAsState()
                            // A rejected token cannot recover by itself; pairing again is the only way on.
                            LaunchedEffect(store, signedOut) {
                                if (signedOut) {
                                    navigation.requestPairing(api?.baseUrl)
                                }
                            }
                            PageHost(stack = navigation.pages) { page, back ->
                                Box(Modifier.fillMaxSize().then(if (page == RiffetPage.Workbench) Modifier else Modifier.keyboardPadding())) {
                                when (page) {
                                    RiffetPage.Workbench -> Workbench(
                                        store = store, api = api, navigation = navigation,
                                        preferences = serverPreferences, scope = scope,
                                        marks = marks,
                                        connection = connection,
                                        onPaired = paired,
                                        owner = owner,
                                        settings = {
                                            if (api != null && owner != null) SettingsScreen(
                                                api = api,
                                                owner = owner,
                                                ownerRequested = navigation.ownerPageRequested,
                                                onOwnerRequestHandled = { navigation.ownerPageRequested = false },
                                                projectId = navigation.projectId ?: store.list.value.projects.firstOrNull { !it.isAssistant }?.id,
                                                themeMode = themeMode,
                                                onThemeModeChange = onThemeMode,
                                                iconPacks = iconPacks,
                                                themes = themes,
                                                themeId = themeId,
                                                onThemeIdChange = onThemeId,
                                                onBack = { navigation.tab = HomeTab.TASKS },
                                                connection = connection,
                                                onPaired = paired,
                                                onRepair = { address -> navigation.requestPairing(address) },
                                                onDisconnected = disconnected,
                                                operationScope = scope,
                                                connectionOperation = navigation.connectionOperation,
                                                onSettingsSaved = store::applySavedSettings,
                                                onProfilesChanged = store::invalidateBackendCatalog,
                                            )
                                        },
                                    )
                                    RiffetPage.Pairing -> PairingScreen(
                                        connection = connection,
                                        onPaired = paired,
                                        initialAddress = navigation.pairingAddress.orEmpty(),
                                        onCancel = back,
                                        revoked = signedOut,
                                        operationScope = scope,
                                        connectionOperation = navigation.connectionOperation,
                                    )
                                    RiffetPage.Stats -> if (api != null) StatsScreen(api = api, onBack = back)
                                    RiffetPage.Abilities -> if (api != null) ExtensionsPage(
                                        api = api,
                                        projectId = assistantProject(store.list.collectAsState().value.projects)?.id,
                                        title = stringResource(Res.string.assistant_abilities),
                                        onBack = back,
                                        backend = NativeBackendId.CLAUDE,
                                    )
                                    RiffetPage.Downloads -> DownloadsScreen(
                                        api = api,
                                        projectName = { id -> store.list.value.projects.firstOrNull { it.id == id }?.name },
                                        onBack = back,
                                    )
                                    is RiffetPage.Panel -> {
                                        val open = navigation.session
                                        if (api != null && open != null) {
                                            when (page.panel) {
                                                ProjectPanel.GIT -> GitPanel(
                                                    api = api, projectId = open.projectId, sessionId = open.id,
                                                    onBack = back,
                                                    writeScope = scope,
                                                    onOpenFile = { path, line ->
                                                        navigation.fileTarget = FileTarget(path, line)
                                                        navigation.panel = ProjectPanel.FILES
                                                    },
                                                )
                                                ProjectPanel.FILES -> FilesPanel(
                                                    api = api,
                                                    projectId = open.projectId,
                                                    projectName = store.list.value.projects.firstOrNull { it.id == open.projectId }?.name ?: open.projectId,
                                                    onBack = back,
                                                    initialPreviewPath = page.file?.path,
                                                    initialPreviewLine = page.file?.line,
                                                    initialVisualization = page.file?.visualization == true,
                                                )
                                            }
                                        }
                                    }
                                    is RiffetPage.Subagent -> {
                                        val parent = store.selected.collectAsState().value
                                        val openTerminal: (() -> Unit)? = parent?.terminalId?.let { id ->
                                            { navigation.terminal = TerminalTarget(id, parent.title) }
                                        }
                                        CompositionLocalProvider(LocalTerminalOpen provides openTerminal) {
                                            SubagentScreen(
                                                store = store, target = page.target,
                                                project = store.list.collectAsState().value.projects.firstOrNull { it.id == navigation.session?.projectId },
                                                onBack = back,
                                                onReturnToSession = { navigation.subagent = null },
                                                onOpenFile = { path, line ->
                                                    navigation.fileTarget = FileTarget(path, line)
                                                    navigation.panel = ProjectPanel.FILES
                                                },
                                                onOpenVisualization = { path ->
                                                    navigation.fileTarget = FileTarget(path, null, visualization = true)
                                                    navigation.panel = ProjectPanel.FILES
                                                },
                                                api = api,
                                            )
                                        }
                                    }
                                    is RiffetPage.Terminal -> if (api != null) TerminalScreen(
                                        api = api, terminalId = page.target.id, title = page.target.title, onBack = back,
                                    )
                                }
                                }
                            }
                        }

                        if (store != null) {
                            DownloadFeedback(
                                api = api,
                                downloadsVisible = navigation.pages.current == RiffetPage.Downloads,
                                onOpenDownloads = {
                                    navigation.drawerOpen = false
                                    navigation.downloadsOpen = true
                                },
                            )
                        }
                    }
                }
                }
            }
        }
    }
}

/**
 * The web's `Workbench` on a phone: the 新会话 / 任务 / 设置 tabs with the navigation drawer on the
 * left, and the open session over them with its details as the right drawer. From
 * [TwoPaneMinWidth] the 任务 list and the session sit side by side.
 */
@Composable
internal fun Workbench(
    store: SessionStore,
    api: RiffetApi?,
    navigation: RiffetNavigation,
    preferences: AppPreferences,
    scope: CoroutineScope,
    connection: RiffetConnection,
    onPaired: (RiffetApi) -> Unit,
    marks: SessionMarks? = null,
    /** The owner's personal info on this server, for the drawer's header; null while unconnected. */
    owner: OwnerController? = null,
    /** The 设置 tab's content. */
    settings: @Composable () -> Unit,
) {
    // Navigation waits for a Compose frame; the host's write scope only carries Dispatchers.Main.
    val navigationScope = rememberCoroutineScope()
    val list by store.list.collectAsState()
    val session = navigation.session
    val drafts = LocalComposerDrafts.current
    val snackbar = LocalRiffetSnackbar.current

    // A launch opens the tab chosen in 设置 (新会话 until then); the tab picked since stays for the run.
    if (!navigation.tabRestored) {
        navigation.tabRestored = true
        navigation.tab = homeTab(DisplaySettings.shared.launchTab)
    }

    LaunchedEffect(store) { store.refresh() }

    // Reopen where the reader left off (the web's persisted `KEYS.session`), once the list is in.
    LaunchedEffect(list.loaded) {
        if (!list.loaded || navigation.restored) return@LaunchedEffect
        navigation.restored = true
        if (navigation.session != null) return@LaunchedEffect
        // The last conversation belongs to 任务; a launch on another tab stays there.
        if (navigation.tab != HomeTab.TASKS) return@LaunchedEffect
        val last = preferences.string(PreferenceKeys.SESSION)?.let { id -> list.sessions.firstOrNull { it.id == id } }
        if (last != null) {
            store.select(last)
            navigation.open(last)
        }
    }
    LaunchedEffect(session?.id) {
        if (navigation.restored) preferences.setString(PreferenceKeys.SESSION, session?.id)
    }

    // The assistant's one long conversation, shown by its tab once it exists (docs/ASSISTANT.md §3).
    val assistantSetup = remember(api, scope) { AssistantSetup(api, scope) }
    val assistantProject = remember(list.projects) { assistantProject(list.projects) }
    var assistantStarted by remember { mutableStateOf<Session?>(null) }
    val assistantMain = remember(assistantProject, list.sessions, assistantStarted) {
        // A conversation just made shows before the project's own `mainSessionId` arrives.
        assistantMain(assistantProject, list.sessions)
            ?: assistantStarted?.let { made -> list.sessions.firstOrNull { it.id == made.id } ?: made }
                ?.takeIf { assistantProject != null && it.projectId == assistantProject.id && it.archivedAt == null }
    }
    // Derived reads of the tab here and below: a swipe between tabs recomposes this workbench only
    // when one of these answers changes, not on every tab.
    val onAssistantPage by remember(navigation) { derivedStateOf { navigation.tab == HomeTab.ASSISTANT && navigation.session == null } }
    // What the session info and the composer's pickers act on: the visit, or the assistant's page.
    val active = session ?: assistantMain.takeIf { onAssistantPage }
    var assistantSheet by remember { mutableStateOf<AssistantSheet?>(null) }
    // Packs are added in 设置: read again each time the assistant's page comes back.
    LaunchedEffect(onAssistantPage) { if (onAssistantPage) assistantSetup.loadPacks() }
    val assistantEntries = remember(assistantSetup) {
        AssistantEntries(assistantSetup, onSheet = { assistantSheet = it }, onAbilities = {
            navigation.detailsOpen = false
            navigation.abilitiesOpen = true
        })
    }

    val openSession: (Session) -> Unit = { target ->
        navigation.open(target)
        navigationScope.launch {
            // Let the destination's first frame start before resetting the previous transcript.
            androidx.compose.runtime.withFrameNanos { }
            if (navigation.session?.id == target.id) store.select(target)
        }
    }

    val requested = navigation.requested
    LaunchedEffect(requested, list.sessions) {
        val request = requested ?: return@LaunchedEffect
        val target = list.sessions.firstOrNull { it.id == request.sessionId } ?: return@LaunchedEffect
        navigation.requested = null
        // The assistant's conversation is its tab, not a page over the others.
        if (target.id == assistantMain?.id) {
            navigation.restored = true
            navigation.statsOpen = false
            navigation.downloadsOpen = false
            navigation.pairingRequested = false
            navigation.close()
            navigation.tab = HomeTab.ASSISTANT
            navigation.focus = request.sequence?.let { TimelineFocus(target.id, it, platformNowMillis()) }
            return@LaunchedEffect
        }
        // An explicit request wins over reopening the last session; back from it lands on 任务.
        navigation.restored = true
        navigation.statsOpen = false
        navigation.downloadsOpen = false
        navigation.pairingRequested = false
        navigation.tab = HomeTab.TASKS
        openSession(target)
        navigation.focus = request.sequence?.let { TimelineFocus(target.id, it, platformNowMillis()) }
    }
    // A focus belongs to one visit; coming back to the session later starts at the tail again.
    LaunchedEffect(session?.id) {
        if (navigation.focus?.sessionId != session?.id) navigation.focus = null
    }

    // A link with a prompt opens 新建任务 rather than reopening the last conversation.
    LaunchedEffect(navigation.startRequest) {
        val request = navigation.startRequest ?: return@LaunchedEffect
        navigation.startRequest = null
        navigation.restored = true
        navigation.statsOpen = false
        navigation.downloadsOpen = false
        navigation.pairingRequested = false
        navigation.openStart()
        if (!request.text.isNullOrBlank()) {
            drafts?.draftFor(HOME_DRAFT_ID)?.let { draft ->
                draft.text.value = request.text
                draft.references.value = emptyList()
                drafts.save(HOME_DRAFT_ID, draft)
            }
        }
    }

    // A scope whose project left a confirmed server list falls back to every project; a missing
    // project in the device copy or a failed read is not an authoritative removal.
    LaunchedEffect(navigation.scope, list.loaded, list.loading, list.cachedAt, list.error, list.projects, list.sessions) {
        val current = navigation.scope ?: return@LaunchedEffect
        if (!list.loaded || list.loading || list.cachedAt != null || list.error != null) return@LaunchedEffect
        if (visibleGroups(list.projects, list.sessions, "", false).none { it.project.id == current }) navigation.scope = null
    }

    // The session's catalog and its four writes, held here rather than in the screen below: the
    // details pane on the right shows the same 模型 / 权限 and issues the same writes, and one
    // controller is what keeps the two from fetching two catalogs and from disagreeing about
    // whether a write is in flight.
    val controller = remember(api, active?.id) {
        val open = active
        if (api == null || open == null) null
        else SessionDetailController(api = api, scope = scope, sessionId = open.id, onSession = store::applySession)
    }
    LaunchedEffect(controller, active?.backendId, active?.backendProfileId, active?.projectId) {
        val open = active ?: return@LaunchedEffect
        controller?.load(open.backendId ?: NativeBackendId.CURSOR, open.backendProfileId, open.projectId)
    }
    // One delete confirmation for the list's menu and the details drawer. A conversation removed here
    // or on another device closes its page (back to the list) and any confirmation for it.
    val deletion = rememberSessionDeletion(store, scope)
    LaunchedEffect(store, deletion, drafts) {
        store.removedSessions.collect { ids ->
            deletion.forget(ids)
            for (id in ids) drafts?.forget(id)
            if (navigation.session?.id in ids) navigation.close()
        }
    }
    // The one rename dialog, opened from the details drawer.
    var renaming by remember(session?.id) { mutableStateOf(false) }
    // One transcript presenter per store, outliving the per-session screens: it projects off the
    // main thread, and a reopened session draws its last presentation at once.
    val presenter = remember(store) { TimelinePresenter(store, scope, prepare = ::prepareTranscriptMarkdown) }

    val openMenu: () -> Unit = {
        navigation.detailsOpen = false
        navigation.drawerOpen = true
    }
    val drawerBackTarget = PageBackHandler(enabled = navigation.detailsOpen || navigation.drawerOpen) {
        navigation.backFromOverlay()
    }
    // Back on 新会话 or 设置 returns to 任务 first, as Material's bottom navigation does. This sits
    // at the page's own depth, so a settings section pushed over the tab still goes back first.
    val tabBack = rememberUpdatedState { navigation.tab = HomeTab.TASKS }
    val tabBackTarget = remember { TabBackTarget { tabBack.value() } }
    val offTasks by remember(navigation) { derivedStateOf { navigation.tab != HomeTab.TASKS } }
    RegisterPageBackTarget(tabBackTarget, enabled = offTasks)

    val waiting = remember(list.sessions) { waitingCount(list.sessions) }
    // 新建任务's project, as the web's `lastTaskProject`.
    val homeProject = rememberHomeProject(store, navigation, preferences)
    val homeConfigs = rememberHomeConfigs(api, preferences)
    // The terminal import picker: the project it opens in, or none for every project.
    var importScope by remember { mutableStateOf<ImportScope?>(null) }
    val sessionList: @Composable (Boolean) -> Unit = { showSelection ->
        SessionList(
            store = store,
            preferences = preferences,
            selectedSessionId = session?.id.takeIf { showSelection },
            scope = navigation.scope,
            onSelectSession = openSession,
            onOpenHit = { hit -> navigation.request(hit.sessionId, hit.sequence) },
            onNewSession = { project -> navigation.openStart(project.id) },
            onScope = { project ->
                navigation.scope = project?.id
                // A scoped list also points 新会话 at that project.
                if (project != null && project.system != "task-workspace") navigation.projectId = project.id
            },
            onOpenMenu = openMenu,
            onSessionAction = { action ->
                scope.launch {
                    try {
                        when (action) {
                            is SessionAction.Pin -> store.updateSession(action.session.id, SessionUpdate(pinned = action.pinned))
                            is SessionAction.Rename -> store.updateSession(action.session.id, SessionUpdate(title = action.title))
                            is SessionAction.Archive -> store.updateSession(action.session.id, SessionUpdate(archived = action.archived))
                            is SessionAction.Delete -> deletion.request(action.session)
                        }
                    } catch (cancellation: CancellationException) {
                        throw cancellation
                    } catch (failure: Throwable) {
                        store.reportListError(failure.message?.takeIf { it.isNotBlank() } ?: getString(Res.string.app_operation_failed))
                    }
                }
            },
            deletingId = deletion.preparing,
        )
    }

    // One screen per session: switching starts a fresh transcript, folds and draft rather than
    // carrying the last session's over. [paned] drops the slide: beside the list it is not a page.
    val sessionPane: @Composable (Session, Boolean, PageBackState?) -> Unit = { open, paned, sessionPage ->
        key(open.id) {
            SwipeBackPage(
                canGoBack = !navigation.detailsOpen,
                onBack = navigation::close,
                mode = if (paned) PageSwipeMode.NONE else PageSwipeMode.FULL,
                state = sessionPage ?: rememberPageBackState(animateEntrance = !paned),
            ) { back ->
                SessionScreen(
                    store = store,
                    session = open,
                    writeScope = scope,
                    onBack = back,
                    project = list.projects.firstOrNull { it.id == open.projectId },
                    api = api,
                    controller = controller,
                    context = store.context.collectAsState().value,
                    onOpenDetails = { navigation.detailsOpen = true },
                    onOpenSession = openSession,
                    onOpenSubagent = { target -> navigation.subagent = target },
                    onOpenTerminal = { id -> navigation.terminal = TerminalTarget(id, open.title) },
                    onOpenFile = { path, line ->
                        navigation.fileTarget = FileTarget(path, line)
                        navigation.panel = ProjectPanel.FILES
                    },
                    onOpenVisualization = { path ->
                        navigation.fileTarget = FileTarget(path, null, visualization = true)
                        navigation.panel = ProjectPanel.FILES
                    },
                    focus = navigation.focus
                        ?.takeIf { it.sessionId == open.id }
                        ?.let { TimelineFocusTarget(it.sequence, it.token) },
                    presenter = presenter,
                    marks = marks,
                )
            }
        }
    }
    val cannotUseDirectory = stringResource(Res.string.session_cannot_use_directory)

    // The page is the conversation the store holds: select it when the tab is on it, and keep the
    // owner's time zone current for the model (docs/ASSISTANT.md §5.1).
    LaunchedEffect(onAssistantPage, assistantMain?.id) {
        val main = assistantMain ?: return@LaunchedEffect
        if (!onAssistantPage) return@LaunchedEffect
        androidx.compose.runtime.withFrameNanos { }
        if (store.selected.value?.id != main.id) store.select(main)
    }
    val zone = riffet.ui.timeline.platformTimeZoneId()
    LaunchedEffect(onAssistantPage, assistantMain?.id, list.settings?.assistant?.timeZone, zone) {
        if (!onAssistantPage || assistantMain == null || api == null || list.settings?.assistant?.timeZone == zone) return@LaunchedEffect
        runCatching { api.reportAssistantTimeZone(zone) }.getOrNull()?.let(store::applySavedSettings)
    }

    // The tabs are pages side by side: a drag scrolls them by the finger, a tap on the bar scrolls to
    // the tab, and the bar reads the same position, so its selection and fold move with the pages.
    val tabPager = rememberPagerState(initialPage = navigation.tab.ordinal) { HomeTab.entries.size }
    val tabSettle = riffet.ui.pager.rememberTabSettle()
    val tabFlingVelocity = with(androidx.compose.ui.platform.LocalDensity.current) { TAB_FLING_VELOCITY.toPx() }
    // A composition scope: the release's settle animation needs the frame clock.
    val tabSwipeScope = rememberCoroutineScope()
    // The other tabs are composed once the first frames are out, not in the launch frame.
    var tabsWarm by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        androidx.compose.runtime.withFrameNanos { }
        delay(TABS_WARM_DELAY_MS)
        tabsWarm = true
    }
    val tabSwipe = remember(tabPager, navigation, tabSwipeScope) { TabSwipe(tabPager, navigation.backDispatcher, tabSwipeScope) }
    SideEffect {
        tabSwipe.settle = tabSettle
        tabSwipe.minFlingVelocity = tabFlingVelocity
    }

    AdaptiveWorkbench(tasks = { navigation.tab == HomeTab.TASKS }) { layout ->
        // Where the pages are heading: a right swipe while sliding back to 新会话 already opens the drawer.
        val onFirstTab by remember(tabSwipe) { derivedStateOf { tabSwipe.heading == HomeTab.NEW_SESSION.ordinal } }
        val rail = layout.rail
        val paned = layout.twoPane
        // On a phone the session is a page over the tabs: the bar goes with them.
        val covering = session != null && !paned
        // With the bottom bar, a horizontal drag moves between tabs and only 新会话 opens the drawer
        // with it (it has no tab before it); the rail keeps the drawer swipe on every tab.
        SideEffect { tabSwipe.enabled = !rail && !covering }
        // Hoisted so the tabs under a phone's session can follow its slide (see [coveredBy]).
        val sessionPage = session?.let { open -> key(open.id, paned) { rememberPageBackState(animateEntrance = !paned) } }
        SideDrawers(
            startOpen = navigation.drawerOpen,
            onStartOpenChange = { open ->
                if (open) navigation.detailsOpen = false
                navigation.drawerOpen = open
            },
            endOpen = navigation.detailsOpen,
            onEndOpenChange = { open ->
                if (open) navigation.drawerOpen = false
                navigation.detailsOpen = open
            },
            endEnabled = active != null,
            startEnabled = !covering && (rail || onFirstTab),
            backSwipe = { navigation.backSwipeFor(drawerBackTarget) },
            pageSwipe = tabSwipe,
            startDrawer = {
                WorkbenchDrawer(
                    api = api,
                    owner = owner,
                    connection = connection,
                    status = store.connection.collectAsState().value,
                    onClose = { navigation.drawerOpen = false },
                    onPaired = onPaired,
                    onOwner = {
                        navigation.drawerOpen = false
                        navigation.statsOpen = false
                        navigation.downloadsOpen = false
                        navigation.ownerPageRequested = true
                        navigation.tab = HomeTab.SETTINGS
                    },
                    onRepair = { address ->
                        navigation.drawerOpen = false
                        navigation.requestPairing(address)
                    },
                    onFavorite = { favorite ->
                        navigation.drawerOpen = false
                        scope.launch {
                            try {
                                navigation.openStart(store.openDirectory(favorite.path).id)
                            } catch (cancellation: CancellationException) {
                                throw cancellation
                            } catch (failure: Throwable) {
                                snackbar?.show(failure.message?.takeIf { it.isNotBlank() } ?: cannotUseDirectory)
                            }
                        }
                    },
                    onDownloads = {
                        navigation.drawerOpen = false
                        navigation.statsOpen = false
                        navigation.downloadsOpen = true
                    },
                    onStats = {
                        navigation.drawerOpen = false
                        navigation.downloadsOpen = false
                        navigation.statsOpen = true
                    },
                    operationScope = scope,
                    connectionOperation = navigation.connectionOperation,
                )
            },
            endDrawer = {
                val open = active
                if (open != null) {
                    SessionDetailsPane(
                        store = store,
                        session = open,
                        project = list.projects.firstOrNull { it.id == open.projectId },
                        api = api,
                        controller = controller,
                        onClose = { navigation.detailsOpen = false },
                        onOpenGit = { navigation.panel = ProjectPanel.GIT },
                        onOpenFiles = {
                            navigation.fileTarget = null
                            navigation.panel = ProjectPanel.FILES
                        },
                        onOpenTerminal = { id -> navigation.terminal = TerminalTarget(id, open.title) },
                        onRename = { renaming = true },
                        onFind = {
                            navigation.detailsOpen = false
                            store.find.open(null)
                        },
                        onDelete = if (list.canDeleteSessions) ({ deletion.request(open) }) else null,
                        deleteBusy = deletion.preparing != null,
                        onOpenSubagent = { entry ->
                            navigation.subagent = SubagentTarget(toolCallId = entry.toolCallId, name = entry.name)
                        },
                        assistant = assistantEntries.takeIf { open.id == assistantMain?.id },
                    )
                }
            },
        ) {
            Box(Modifier.fillMaxSize()) {
                // Retain the tabs under a session; covered controls leave the accessibility tree.
                CompositionLocalProvider(LocalPageActive provides (LocalPageActive.current && !covering)) {
                    Box(Modifier.fillMaxSize().then(if (covering) Modifier.clearAndSetSemantics { } else Modifier).coveredBy(sessionPage.takeIf { covering })) {
                        val tabs = rememberSaveableStateHolder()
                        HomeShell(tab = navigation.tab, onTab = { tabSwipe.select(it.ordinal); navigation.tab = it }, waiting = waiting, rail = rail,
                            dockTab = HomeTab.ASSISTANT.takeIf { !rail && assistantMain != null },
                            position = { tabPager.currentPage + tabPager.currentPageOffsetFraction },
                            heading = { HomeTab.entries[tabSwipe.heading] }) {
                            // The leaving tab stays composed while it is in view but no longer owns back or input.
                            val tabInsets = systemBarsPadding(includeDisplayCutout = false)
                            riffet.ui.pager.RiffetTabPager(
                                selected = navigation.tab.ordinal,
                                onSelect = { navigation.tab = HomeTab.entries[it] },
                                pageCount = HomeTab.entries.size,
                                // Alpha transitions clip to this layer's bounds. Include the system
                                // bars, then restore the safe area inside each page.
                                modifier = Modifier.coverSystemBars(tabInsets),
                                // Drags come through SideDrawers (TabSwipe), which also owns the drawer swipe.
                                userScrollEnabled = false,
                                pagerState = tabPager,
                                followFinger = true,
                                // Every tab stays composed, so a swipe never builds a page in its first frame.
                                beyondViewportPageCount = if (tabsWarm) HomeTab.entries.size - 1 else 0,
                            ) { page ->
                                val shown = HomeTab.entries[page]
                                val active = rememberUpdatedState(LocalPageActive.current && shown == navigation.tab)
                                // Touch follows where the pages are heading, not where they settled: the
                                // page a release is sliding to takes the next tap at once. A page sliding
                                // away keeps its controls out of reach without consuming, so a swipe that
                                // starts on it still reaches the drawers' arbiter. Read at hit time.
                                val coveredOrHidden = rememberUpdatedState(!LocalPageActive.current)
                                val inView by remember(tabPager, page) {
                                    derivedStateOf { kotlin.math.abs(tabPager.currentPage + tabPager.currentPageOffsetFraction - page) < 1f }
                                }
                                Box(Modifier.fillMaxSize().padding(tabInsets)
                                    .focusProperties { canFocus = active.value }
                                    .semantics { if (!active.value) hideFromAccessibility() }) {
                                    CompositionLocalProvider(LocalPageActive provides active.value, LocalPageInView provides (!coveredOrHidden.value && inView)) {
                                        tabs.SaveableStateProvider(shown.name) {
                                            when (shown) {
                                                HomeTab.NEW_SESSION -> ProjectHome(
                                                    store = store,
                                                    api = api,
                                                    project = homeProject,
                                                    onSelectProject = { navigation.projectId = it.id },
                                                    configs = homeConfigs,
                                                    onOpenMenu = openMenu,
                                                    onOpenSession = openSession,
                                                    onImportSession = { importScope = ImportScope(homeProject?.id) },
                                                    onOpenTerminal = { id, title -> navigation.terminal = TerminalTarget(id, title) },
                                                )
                                                HomeTab.ASSISTANT -> when {
                                                    // A conversation opened over the tabs owns the transcript, so this page waits behind it.
                                                    assistantMain != null -> if (session == null) key(assistantMain.id) {
                                                        TabComposerDock(enabled = !rail) { SessionScreen(
                                                            store = store,
                                                            session = assistantMain,
                                                            writeScope = scope,
                                                            onBack = openMenu,
                                                            onOpenMenu = openMenu,
                                                            assistantPacks = assistantSetup.packs.orEmpty(),
                                                            project = assistantProject,
                                                            api = api,
                                                            controller = controller,
                                                            context = store.context.collectAsState().value,
                                                            onOpenDetails = { navigation.detailsOpen = true },
                                                            onOpenSession = openSession,
                                                            onOpenSubagent = { target -> navigation.subagent = target },
                                                            onOpenTerminal = { id -> navigation.terminal = TerminalTarget(id, assistantMain.title) },
                                                            focus = navigation.focus
                                                                ?.takeIf { it.sessionId == assistantMain.id }
                                                                ?.let { TimelineFocusTarget(it.sequence, it.token) },
                                                            presenter = presenter,
                                                            marks = marks,
                                                        ) }
                                                    }
                                                    assistantProject != null -> AssistantHome(
                                                        store = store,
                                                        api = api,
                                                        project = assistantProject,
                                                        configs = homeConfigs,
                                                        entries = assistantEntries,
                                                        onOpenMenu = openMenu,
                                                        onOpenSession = { made ->
                                                            assistantStarted = made
                                                            store.refresh()
                                                            navigationScope.launch {
                                                                androidx.compose.runtime.withFrameNanos { }
                                                                if (navigation.session == null) store.select(made)
                                                            }
                                                        },
                                                        onStarted = { backend, profile, model ->
                                                            scope.launch {
                                                                val saved = runCatching { api?.rememberAssistant(backend, profile, model) }.getOrNull()
                                                                if (saved != null) store.applySavedSettings(saved)
                                                            }
                                                        },
                                                    )
                                                    else -> EmptyPane()
                                                }
                                                HomeTab.TASKS -> if (paned) {
                                                    AdaptiveSessionPanes(
                                                        list = { sessionList(true) },
                                                        detail = { if (session != null) sessionPane(session, true, null) else EmptyPane() },
                                                    )
                                                } else {
                                                    sessionList(false)
                                                }
                                                HomeTab.SETTINGS -> CompositionLocalProvider(LocalTabMenu provides openMenu) { settings() }
                                            }
                                        }
                                    }
                                    Spacer(Modifier.matchParentSize().blockTouchesWhen { coveredOrHidden.value || tabSwipe.heading != page })
                                }
                            }
                        }
                    }
                }
                if (covering) Box(Modifier.fillMaxSize().keyboardPadding()) { sessionPane(session, false, sessionPage) }
            }
        }
    }

    if (LocalPageActive.current && renaming && session != null) {
        RenameSessionDialog(
            initial = session.title,
            onDismiss = { renaming = false },
            onConfirm = { title ->
                renaming = false
                if (title != session.title) controller?.update(SessionUpdate(title = title))
            },
        )
    }
    SessionDeletionDialog(deletion)
    AssistantSheets(assistantSetup, assistantSheet, onDismiss = { assistantSheet = null })
    importScope?.let { target ->
        if (api != null) ExternalSessionPickerSheet(
            api = api,
            store = store,
            projects = list.projects,
            projectId = target.projectId,
            onOpen = { imported ->
                navigation.tab = HomeTab.TASKS
                openSession(imported)
            },
            onDismiss = { importScope = null },
        )
    }
}

private class ImportScope(val projectId: String?)

/**
 * 新建任务's project: the one asked for, else the last used, else the busiest.
 */
@Composable
private fun rememberHomeProject(store: SessionStore, navigation: RiffetNavigation, preferences: AppPreferences): Project? {
    val list by store.list.collectAsState()
    val project: Project? = remember(list.projects, list.sessions, navigation.projectId) {
        val live = list.projects.filter { it.archivedAt == null && !it.isAssistant && it.system != "task-workspace" }
        live.firstOrNull { it.id == navigation.projectId }
            ?: live.firstOrNull { it.id == preferences.string(PreferenceKeys.PROJECT) }
            ?: visibleGroups(live, list.sessions, "", false).firstOrNull()?.project
            ?: live.firstOrNull()
    }
    LaunchedEffect(project?.id) {
        project?.id?.let { preferences.setString(PreferenceKeys.PROJECT, it) }
    }
    return project
}

/** The full-screen project panels a session can open. */
internal enum class ProjectPanel { GIT, FILES }

internal data class SessionRequest(val sessionId: String, val sequence: Long?)

internal data class StartRequest(val text: String?)

/** [token] tells two requests for the same event apart, so the second one scrolls again. */
internal data class TimelineFocus(val sessionId: String, val sequence: Long, val token: Long)

internal data class FileTarget(val path: String, val line: Int?, val visualization: Boolean = false)

internal data class TerminalTarget(val id: String, val title: String)

/** History routes carry the intent of that visit, e.g. which file opened over a subagent. */
internal sealed interface RiffetPage {
    data object Workbench : RiffetPage
    data object Pairing : RiffetPage
    data object Stats : RiffetPage
    data object Downloads : RiffetPage
    data object Abilities : RiffetPage
    data class Panel(val panel: ProjectPanel, val file: FileTarget? = null) : RiffetPage
    data class Subagent(val target: SubagentTarget) : RiffetPage
    data class Terminal(val target: TerminalTarget) : RiffetPage
}

/** Navigation and unsent content belong to the server; appearance remains device-wide. */
private val serverScopedKeys = setOf(PreferenceKeys.SESSION, PreferenceKeys.PROJECT, PreferenceKeys.TOOL_GROUPS)

private fun serverPreferences(preferences: AppPreferences, origin: String?): AppPreferences {
    val prefix = "server:${origin.orEmpty()}:"
    if (preferences.string("server-navigation-migrated") == null) {
        listOf(PreferenceKeys.PROJECT, PreferenceKeys.SESSION).forEach { key ->
            if (origin != null) preferences.string(key)?.let { preferences.setString(prefix + key, it) }
            preferences.setString(key, null)
        }
        preferences.setString("server-navigation-migrated", origin ?: "unpaired")
    }
    return object : AppPreferences {
        override fun themeMode() = preferences.themeMode()
        override fun setThemeMode(mode: ThemeMode) = preferences.setThemeMode(mode)
        override fun string(key: String) = preferences.string(if (key in serverScopedKeys) prefix + key else key)
        override fun setString(key: String, value: String?) = preferences.setString(if (key in serverScopedKeys) prefix + key else key, value)
    }
}

/** The local flag for the first-launch onboarding: set once it was finished or skipped, or an existing pairing was found. */
internal const val ONBOARDING_KEY = "onboarding-done"
private const val ONBOARDING_OFF = -1

/** How long after launch the tabs other than the first one shown are composed. */
private const val TABS_WARM_DELAY_MS = 600L

/** A release faster than this turns the tab even on a short swipe (the pager's own fling threshold). */
private val TAB_FLING_VELOCITY = 400.dp
