package riffet.ui.session

import riffet.ui.app.RiffetPageScaffold
import riffet.ui.design.materialBackdropEnabled

import riffet.ui.design.LocalRiffetSurfaces
import riffet.ui.design.LocalInterfaceStyle
import androidx.compose.material3.MaterialTheme
import riffet.ui.app.PageBarAction
import riffet.ui.app.snackbarBottomBar
import androidx.compose.foundation.background
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.layout.heightIn
import riffet_mobile.shared.generated.resources.session_details
import riffet_mobile.shared.generated.resources.pickers_close
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import riffet.ui.design.AlertDialog
import riffet.ui.design.ConfirmDialog
import riffet.ui.design.RiffetProgressIndicator as CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import riffet.ui.icons.Icon
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.ui.semantics.Role

import riffet.ui.design.RiffetTextField as OutlinedTextField
import androidx.compose.material3.Text
import riffet.ui.design.RiffetTextButton as TextButton
import androidx.compose.ui.draw.clip
import riffet.contracts.Project
import riffet.ui.composer.ComposerSettings
import riffet.ui.pickers.SendSettingRow
import riffet.ui.pickers.SendSettingsPage
import riffet.ui.pickers.ToolsPickerPage
import riffet.ui.pickers.extensionsPick
import riffet.ui.pickers.rememberExtensionsListed
import riffet.ui.pickers.rememberToolDevices
import riffet.ui.pickers.rememberPluginToolGroups
import riffet.ui.pickers.toolsOffered
import riffet.ui.pickers.toolsSummary
import riffet.ui.pickers.modelSelectionSummary
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.runtime.Composable
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import riffet.ui.timeline.FindLanding
import riffet.ui.timeline.TimelineEntry
import androidx.compose.runtime.State
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier

import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp

import riffet.contracts.NativeBackendId
import riffet.contracts.NativeContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import riffet.contracts.NativeStatus
import riffet.contracts.NativeStatusPhase
import riffet.contracts.Session
import riffet.shared.SessionUpdate
import riffet.contracts.SessionState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import riffet.contracts.RunState
import riffet.shared.restartSession
import riffet.shared.startSession
import riffet.ui.state.conversationStatus
import riffet.ui.state.supportsNativeTerminal
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import riffet.shared.RiffetApi
import riffet.ui.app.LocalRiffetSnackbar
import riffet.ui.composer.Composer
import riffet.ui.composer.Reveal
import riffet.ui.composer.FeedbackValue
import riffet.ui.composer.VisibleFeedback
import riffet.ui.composer.FeedbackVisible
import riffet.ui.composer.rememberFeedback
import riffet.i18n.L10n
import riffet.ui.pickers.ApprovalPickerPage
import riffet.ui.pickers.ContextBreakdownSheet
import riffet.ui.pickers.ModePickerPage
import riffet.ui.pickers.ModelPickerPages
import riffet.ui.pickers.sessionProviderGroups
import riffet.ui.pickers.PickerSheet
import riffet.ui.pickers.optionLabelOf
import riffet.ui.icons.RiffetIcons
import riffet.ui.interaction.InteractionCard
import riffet.ui.focus.blurOnTap
import riffet.ui.settings.SettingsMessageBanner
import riffet.ui.settings.SettingsNoticeKind
import riffet.ui.state.SessionStore
import riffet.ui.state.SessionMarks
import riffet.ui.state.RiffetConnectionState
import androidx.compose.foundation.lazy.rememberLazyListState
import riffet.ui.sessionlist.relativeTimeLabel
import riffet.ui.sessionlist.isJustNow
import riffet.ui.timeline.prepareTranscriptMarkdown
import riffet.ui.timeline.FileAccess
import riffet.ui.timeline.TimelineFocusTarget
import riffet.ui.timeline.LocalFileAccess
import riffet.ui.timeline.resolveFileMention
import riffet.ui.timeline.conversationFiles
import riffet.ui.timeline.LocalMarkActions
import riffet.ui.timeline.MarkActions
import riffet.ui.timeline.LocalQuote
import riffet.ui.timeline.LocalRestoreNativeRun
import riffet.ui.timeline.LocalSessionReferenceStore
import riffet.ui.timeline.LocalSessionReferenceOpen
import riffet.ui.timeline.LocalRunRecoveryStore
import riffet.ui.composer.ComposerQuote
import riffet.ui.state.active
import riffet.ui.state.plainSummary
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import riffet.ui.haptics.rememberAppHaptics
import riffet.ui.interaction.LocalTerminalOpen
import riffet.ui.timeline.LocalSubagentOpen
import riffet.ui.timeline.ProcessFolds
import riffet.shared.DownloadCenter
import riffet.shared.downloadsSupported
import androidx.compose.runtime.CompositionLocalProvider

import riffet.ui.timeline.TimelineGrouping
import riffet.ui.timeline.TimelineLayout
import riffet.ui.timeline.TimelineRhythm

import riffet.ui.timeline.layoutTimeline
import riffet.ui.timeline.platformNowMillis
import riffet.ui.timeline.rememberTickingNow
import riffet.ui.timeline.TimelineFollow
import riffet.ui.timeline.animateScrollToItemNear
import riffet.ui.timeline.TimelinePresenter
import riffet.ui.state.traced
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.visualWorkActive
import riffet.ui.theme.localizedAppearanceTitle
import riffet.ui.theme.LocalRiffetTypography
import riffet.ui.theme.LocalRiffetPageMotion
import org.jetbrains.compose.resources.stringResource
import org.jetbrains.compose.resources.rememberResourceEnvironment
import riffet_mobile.shared.generated.resources.confirm_restart_session_title
import riffet_mobile.shared.generated.resources.session_profile_restart_title
import riffet_mobile.shared.generated.resources.session_profile_restart_effect
import riffet_mobile.shared.generated.resources.session_profile_restart
import riffet_mobile.shared.generated.resources.session_profile_pending
import riffet_mobile.shared.generated.resources.session_resume
import riffet_mobile.shared.generated.resources.session_resume_failed
import riffet_mobile.shared.generated.resources.session_restore
import riffet_mobile.shared.generated.resources.timeline_interaction_answer_in_terminal
import riffet_mobile.shared.generated.resources.session_last_change_failed
import riffet_mobile.shared.generated.resources.pickers_catalog_failed
import riffet_mobile.shared.generated.resources.pickers_retry
import riffet_mobile.shared.generated.resources.session_state_starting
import riffet_mobile.shared.generated.resources.Res
import riffet_mobile.shared.generated.resources.pickers_approval_title
import riffet_mobile.shared.generated.resources.pickers_tools_next_launch
import riffet_mobile.shared.generated.resources.pickers_tools_title
import riffet_mobile.shared.generated.resources.session_cancel
import riffet_mobile.shared.generated.resources.session_history_sync_failed
import riffet_mobile.shared.generated.resources.session_connection_failed
import riffet_mobile.shared.generated.resources.session_connecting
import riffet_mobile.shared.generated.resources.session_disconnected
import riffet_mobile.shared.generated.resources.session_info_actions
import riffet_mobile.shared.generated.resources.session_mark_failed
import riffet_mobile.shared.generated.resources.session_mode
import riffet_mobile.shared.generated.resources.session_model
import riffet_mobile.shared.generated.resources.session_no_messages
import riffet_mobile.shared.generated.resources.session_not_set
import riffet_mobile.shared.generated.resources.session_offline_age
import riffet_mobile.shared.generated.resources.session_offline_synced_now
import riffet_mobile.shared.generated.resources.app_back
import riffet_mobile.shared.generated.resources.assistant_title
import riffet_mobile.shared.generated.resources.session_open_sidebar
import riffet_mobile.shared.generated.resources.session_permission
import riffet_mobile.shared.generated.resources.session_reconnecting
import riffet_mobile.shared.generated.resources.session_rename_session
import riffet_mobile.shared.generated.resources.session_retry
import riffet_mobile.shared.generated.resources.session_save
import riffet_mobile.shared.generated.resources.session_select_model
import riffet_mobile.shared.generated.resources.session_syncing
import riffet_mobile.shared.generated.resources.session_title
import riffet_mobile.shared.generated.resources.session_turn_image
import riffet_mobile.shared.generated.resources.session_turn_plan
import riffet_mobile.shared.generated.resources.session_turn_thought
import riffet_mobile.shared.generated.resources.session_turn_tool
import riffet_mobile.shared.generated.resources.session_turn_user
import riffet_mobile.shared.generated.resources.session_waiting_for_you

/**
 * The session view's shell: a top bar, the "agent is blocked on you" strip, and the transcript.
 *
 * The transcript itself is the other agent's entry point,
 * `riffet.ui.timeline.Timeline(layout, …)`, which owns the `LazyColumn`. This screen
 * deliberately does not wrap it in a second `LazyColumn`: nesting two vertical scroll containers is
 * a measure-time error, so `Timeline` is given a bounded `Box` that gets `fillMaxSize()`.
 *
 * Everything here reads [SessionStore]; the host owns which session is open.
 */
@Composable
fun SessionScreen(
    store: SessionStore,
    session: Session,
    /** Back to the session list: the header's leading button. */
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    project: Project? = null,
    /**
     * Null when the host has no working connection to hand over. Every control that needs to write
     * to the server then renders **dimmed with the reason showing**, never as a button that looks
     * live and does nothing.
     */
    api: RiffetApi? = null,
    /**
     * The session's catalog and its four writes. Created and held by the workbench, because the
     * details pane beside this screen reads the same catalog and must agree with it about what is
     * in flight; see [SessionDetailController].
     */
    controller: SessionDetailController? = null,
    /** Context-window occupancy from the stream; null means the backend does not report it. */
    context: NativeContext? = null,
    /** Opens the details pane the workbench draws on the right. */
    onOpenDetails: () -> Unit = {},
    onOpenSession: ((Session) -> Unit)? = null,
    /** Opens a file the transcript names in the project's file panel, at a line when given. */
    onOpenFile: ((path: String, line: Int?) -> Unit)? = null,
    /** Opens an explicit visualization with its interactive HTML preview enabled. */
    onOpenVisualization: ((path: String) -> Unit)? = null,
    /** Opens a subagent's own transcript over this session (the web's sub-session page). */
    onOpenSubagent: ((SubagentTarget) -> Unit)? = null,
    /** Opens the session's terminal; used by interaction cards that must be answered there. */
    onOpenTerminal: ((terminalId: String) -> Unit)? = null,
    /** A message to scroll to once, e.g. the search hit this screen was opened for. */
    focus: TimelineFocusTarget? = null,
    /** The store's transcript presenter; the workbench keeps one so reopening a session draws at once. */
    presenter: TimelinePresenter? = null,
    writeScope: CoroutineScope? = null,
    /** Saved replies (收藏); null on a host that has none. */
    marks: SessionMarks? = null,
    /**
     * The assistant tab's conversation (docs/ASSISTANT.md §3.1): the title is fixed, and the bar leads
     * with the menu (the page is a tab, not a visit) instead of a way back.
     */
    onOpenMenu: (() -> Unit)? = null,
    /** The assistant's capability packs, as chips above its composer. */
    assistantPacks: List<riffet.contracts.AssistantPack> = emptyList(),
) {
    val designMetrics = LocalInterfaceStyle.current.metrics
    val pageMotion = LocalRiffetPageMotion.current
    val selected by store.selected.collectAsState()
    // A plain local, not `by`: a delegated property cannot be smart-cast, and the failure branch
    // below needs `connection.reason` after checking the type.
    val connection = store.connection.collectAsState().value
    // The status frame carries the output rate, which changes on almost every frame; only the
    // working line reads it ([WorkingFooter]). Everything here sees the status without it, so a
    // rate frame leaves this screen alone.
    val statusFeed = store.status.collectAsState()
    val status by remember(statusFeed) {
        derivedStateOf { statusFeed.value?.let { if (it.outputRate == null) it else it.copy(outputRate = null) } }
    }
    val cachedAt by store.cachedAt.collectAsState()
    val runs by store.runs.collectAsState()
    val sendState by store.sendState.collectAsState()
    val interaction by store.interaction.collectAsState()
    val loadingHistory by store.loadingHistory.collectAsState()
    val historyError by store.historyError.collectAsState()
    val history by store.history.collectAsState()
    val hasNewerHistory by store.hasNewerHistory.collectAsState()
    val colors = LocalRiffetColors.current

    // A live `session` frame updates the session in place; fall back to the host's copy until then.
    val current = selected?.takeIf { it.id == session.id } ?: session
    // On screen in the foreground (resumed, the top page, the window focused): what arrives is seen, on every device.
    val shown = visualWorkActive()
    LaunchedEffect(current.id, current.lastActivityAt, shown) { if (shown) store.markSeen(current.id) }
    // What the reader last picked: a model or parameter change shows at once, before the server answers.
    val detail = controller?.state?.collectAsState()?.value
    val intended = detail?.intended(current) ?: current
    // A quick chat has no permissions, context meter or terminal; its modes are 对话 and the presets.
    val quickChat = current.backendId == NativeBackendId.CHAT

    var profileRestartTarget by remember(current.id) { mutableStateOf<riffet.contracts.SessionNativeRuntime?>(null) }
    var restartingProfile by remember(current.id) { mutableStateOf(false) }
    // Reopening and 重启并应用 both start the CLI; only one may run at a time.
    var resuming by remember(current.id) { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    // Todos, goal, the visible rows, their grouping and the per-row speeds are computed together off
    // the main thread (`TimelinePresenter`, as on iOS and macOS); composition only lays them out.
    val transcript = presenter ?: remember(store) { TimelinePresenter(store, scope, prepare = ::prepareTranscriptMarkdown) }
    val presentation = transcript.presentation.collectAsState().value?.takeIf { it.sessionId == current.id }
    val loaded = presentation?.loaded == true
    val visible = presentation?.grouping?.items.orEmpty()
    // Rows arriving during the slide stay deferred until it ends. The presenter can still prepare
    // them off the main thread while the page animation has the UI frame budget.
    val entered = riffet.ui.app.LocalPageContentReady.current
    val haptics = rememberAppHaptics()
    var quote by remember(current.id) { mutableStateOf<ComposerQuote?>(null) }
    var restoreRun by remember(current.id) { mutableStateOf<riffet.contracts.Run?>(null) }
    val quoteMessage: (String) -> Unit = remember(haptics) {
        { text ->
            haptics.performHapticFeedback(HapticFeedbackType.ContextClick)
            quote = ComposerQuote(plainSummary(text, QUOTE_LIMIT), platformNowMillis())
        }
    }
    // The turn ending, failing or stopping to ask, felt while the reader watches it: the
    // notification for the same change is skipped for the session on screen.
    var lastState by remember(current.id) { mutableStateOf(current.state) }
    LaunchedEffect(current.state) {
        val before = lastState
        lastState = current.state
        when (current.state) {
            before -> Unit
            SessionState.IDLE -> if (before.active) haptics.performHapticFeedback(HapticFeedbackType.Confirm)
            SessionState.FAILED -> haptics.performHapticFeedback(HapticFeedbackType.Reject)
            SessionState.WAITING -> haptics.performHapticFeedback(HapticFeedbackType.GestureThresholdActivate)
            else -> Unit
        }
    }
    var sheet by remember { mutableStateOf<SessionSheet?>(null) }
    var contextOpen by remember { mutableStateOf(false) }

    // The controller is the workbench's (it also feeds the details pane beside this screen), so the
    // catalog is fetched once per session rather than once per surface that shows it.
    val writeBlocked = detailWriteBlocked(api, detail, current)
    // A metadata write in flight disables the setting rows and spins where their chevron goes.
    val writeBusy = detail?.actionBusy == true
    val running = remember(runs) { runs.lastOrNull { it.state == RunState.RUNNING } }

    // The turn navigator and the transcript share one scroll state and one projection: the
    // presenter's grouping is laid out here and handed to `Timeline`.
    val listState = rememberLazyListState()
    // Hoisted from the transcript: 回到最新 reads it, and sending a message resumes it.
    val follow = remember(current.id) { TimelineFollow() }
    // 会话内查找: the bar replaces the top bar; the transcript only needs where it is landing, so typing
    // and counting do not recompose this screen.
    val findOpen by remember(store) { store.find.state.map { it.open }.distinctUntilChanged() }.collectAsState(false)
    val findLanding by remember(store) {
        store.find.state.map { s -> s.target?.takeIf { s.open }?.let { FindLanding(it.key, s.needle, it.nth, it.request) } }.distinctUntilChanged()
    }.collectAsState(null)
    // The previous frame's layout and ticks are kept so a chunk only rebuilds the rows it touched and
    // hands the list the same instances for the rest.
    val previous = remember(current.id) { PreviousTimeline() }
    // The last non-empty rows, for a transcript that is fading out after they went away.
    val lastRows = remember(current.id) { LastRows() }
    // Fold state outlives the lazy items it controls, so it lives here, one holder per session.
    val folds = remember(current.id) { ProcessFolds() }
    // The gaps are baked into the entries, so a new 会话间距 lays the transcript out again.
    val spacing = TimelineRhythm.scale
    val grouping = presentation?.grouping.takeIf { entered }
    val layout = remember(grouping, entered, folds, folds.version, spacing) {
        if (!entered) previous.layout ?: TimelineLayout(emptyList(), IntArray(0))
        else {
            val rows = grouping?.rows.orEmpty()
            folds.sync(rows)
            traced("riffet.timeline.layout") { layoutTimeline(rows, previous.layout, folds::isOpen) }.also { previous.layout = it }
        }
    }
    // The `pos` of the row at the reader's place, where find begins; read only when find asks.
    val layoutNow by rememberUpdatedState(layout)
    val readingPos: () -> String? = remember(listState) {
        {
            when (val entry = layoutNow.entries.getOrNull(listState.firstVisibleItemIndex)) {
                is TimelineEntry.Row -> when (val row = entry.row) {
                    is riffet.ui.timeline.TimelineRow.Single -> row.item.key
                    is riffet.ui.timeline.TimelineRow.Trigger -> row.notices.firstOrNull()?.key
                    is riffet.ui.timeline.TimelineRow.Process -> row.items.firstOrNull()?.key
                }
                is TimelineEntry.ProcessHeader -> entry.row.items.firstOrNull()?.key
                is TimelineEntry.ProcessChild -> entry.item.key
                is TimelineEntry.ToolRun -> entry.items.firstOrNull()?.key
                else -> null
            }
        }
    }
    // Ticks name grouped rows; the list scrolls by entry, so each tick is moved to its row's first
    // entry in the flattened layout.
    val turnLabels = TurnLabels(
        user = stringResource(Res.string.session_turn_user),
        thought = stringResource(Res.string.session_turn_thought),
        tool = stringResource(Res.string.session_turn_tool),
        plan = stringResource(Res.string.session_turn_plan),
        image = stringResource(Res.string.session_turn_image),
    )
    val ticks = remember(grouping, entered, layout, turnLabels) {
        if (!entered) previous.ticks else {
            val next = buildTurnTicks(grouping?.rows.orEmpty(), grouping?.activeTurns.orEmpty(), turnLabels).map { tick ->
                tick.copy(index = layout.rowStart.getOrElse(tick.index) { tick.index })
            }
            (previous.ticks.takeIf { it == next } ?: next).also { previous.ticks = it }
        }
    }
    // `derivedStateOf`, not `remember`: the value is a function of the scroll position, so it must
    // re-evaluate as the reader scrolls. `remember(ticks, listState)` would compute it once and the
    // navigator would never move (the underlying `listState` object never changes identity).
    // The web's `TurnRail` rules: at the tail the last turn is current, otherwise the turn whose row
    // crosses a reading line just under the top. The top edge alone would name the previous turn
    // whenever its answer's footer is still peeking in above the newest prompt.
    val readingLine = with(LocalDensity.current) { 96.dp.toPx() }
    val activeTurnIndex by remember(ticks, listState, readingLine) {
        derivedStateOf {
            if (!listState.canScrollForward) return@derivedStateOf ticks.lastIndex.coerceAtLeast(0)
            val info = listState.layoutInfo
            val line = minOf(readingLine, (info.viewportEndOffset - info.viewportStartOffset) * 0.2f)
            val anchor = info.visibleItemsInfo.lastOrNull { it.offset <= line }?.index ?: listState.firstVisibleItemIndex
            ticks.indexOfLast { it.index <= anchor }.coerceAtLeast(0)
        }
    }
    // The web's gate (`NativeSession.tsx`), with the store's `working` (busy or waiting on the
    // reader) as on iOS and macOS: the turn has shown more than thinking.
    // Compaction's timeline activity already carries its own progress indicator and clock.
    val workingVisible = sendState.interrupting || presentation?.showsWorking == true && !presentation.dock.compacting
    // Delegated work that outlives the turn; the presenter keeps it zero while the main agent works.
    val delegatedAgents = presentation?.delegatedAgents ?: 0
    val delegatedWorkflows = presentation?.delegatedWorkflows ?: 0

    val catalog = detail?.catalog.orEmpty()
    val providerGroups = remember(detail?.catalog, detail?.profiles, detail?.continuations, current.backendProfileId) {
        sessionProviderGroups(current.backendProfileId, catalog, detail?.profiles.orEmpty(), detail?.continuations.orEmpty())
    }
    val capabilities = detail?.capabilities
    // The phones the agent may control: offered only where the backend takes tools, and where there is
    // a phone to pick or one already picked to switch off.
    val toolsSupported = !quickChat && current.archivedAt == null && capabilities?.supportsRiffetTools == true
    val toolDevices = rememberToolDevices(api, enabled = toolsSupported)
    val toolGroups = riffet.shared.ToolGroups.picks(intended.toolGroups)
    val pluginTools = rememberPluginToolGroups(api, enabled = toolsSupported, value = toolGroups)
    val extensionsOff = riffet.shared.ExtensionsOff.clean(intended.extensionsOff)
    val extensions = extensionsPick(
        api, allowed = !quickChat && current.archivedAt == null, capabilities = capabilities, backendId = current.backendId,
        profileId = current.backendProfileId, projectId = current.projectId, off = extensionsOff,
        onChange = { controller?.setExtensionsOff(it) },
    )
    val extensionsListed = rememberExtensionsListed(extensions)
    val toolsShown = (toolsSupported && toolsOffered(toolDevices, toolGroups, pluginTools)) || (extensions != null && extensionsListed != false)
    val currentModelLabel = detailModelLabel(detail, intended)
    // The composer's chip and the 发送设置 row repeat Fast / Max / the thinking level: their controls
    // are two sheets deep, so the state has to be readable without opening them.
    val currentModelSummary = modelSelectionSummary(catalog, intended.model).ifEmpty { currentModelLabel }
    val currentApprovalLabel = detailApprovalLabel(detail, intended, stringResource(Res.string.pickers_approval_title))

    // The instance stays put while the timeline streams (`LocalFileAccess` is static); a tap reads the latest rows.
    val latestRows = rememberUpdatedState(visible)
    val latestRoot = rememberUpdatedState(project?.cwd)
    // Downloads land on the downloads page (`DownloadCenter`): they outlive this screen, and the app
    // shows a short notice when one starts or ends.
    val fileAccess = remember(api, current.projectId, onOpenFile, onOpenVisualization) {
        api?.let {
            FileAccess(
                projectId = current.projectId,
                open = { path, line -> onOpenFile?.invoke(path, line) },
                openVisualization = { path ->
                    if (onOpenVisualization != null) onOpenVisualization(path) else onOpenFile?.invoke(path, null)
                },
                canDownload = downloadsSupported,
                download = { path -> DownloadCenter.shared.start(api, current.projectId, path) },
                downloadAttachment = { id, name -> DownloadCenter.shared.startAttachment(api, id, name) },
                resolve = { path -> resolveFileMention(path, conversationFiles(latestRows.value, latestRoot.value)) },
            )
        }
    }

    // `LocalSubagentOpen` is what makes the transcript's Task rows open the child's page: outside a
    // session (or inside a child page) it stays null and those rows unfold as they always did.
    val openSubagentPage: ((String, String) -> Unit)? = onOpenSubagent?.let { open ->
        { toolCallId, name -> open(SubagentTarget(toolCallId = toolCallId, name = name)) }
    }
    // The open transcript's marks stay current while it is on screen; its rows read them through
    // `LocalMarkActions`, so one instance serves the bubble menus and the bookmarks beside them.
    DisposableEffect(marks, current.id) {
        marks?.watch(current.id)
        onDispose { marks?.unwatch(current.id) }
    }
    val snackbar = LocalRiffetSnackbar.current
    if (profileRestartTarget != null) {
        ConfirmDialog(
            title = stringResource(Res.string.confirm_restart_session_title, current.shownTitle),
            message = stringResource(Res.string.session_profile_restart_effect),
            confirmLabel = stringResource(Res.string.session_profile_restart),
            danger = true,
            onDismiss = { profileRestartTarget = null },
            onConfirm = {
                    val binding = profileRestartTarget
                    profileRestartTarget = null
                    if (api != null && binding != null && !restartingProfile && !resuming) {
                        restartingProfile = true
                        scope.launch {
                            try { api.restartSession(current.id, binding.fingerprint, binding.address); store.retry() }
                            catch (cancelled: CancellationException) { throw cancelled }
                            catch (failure: Throwable) { snackbar?.show(failure.message.orEmpty()) }
                            finally { restartingProfile = false }
                        }
                    }
            },
        )
    }
    // 待恢复 → 恢复: a CLI that is not running is reopened from the header, as iOS does (`needsResume`).
    rememberResourceEnvironment()
    val conversation = conversationStatus(
        session = current,
        status = status,
        connection = connection,
        runs = runs,
        interaction = interaction,
        reopening = resuming,
        supportsTerminal = supportsNativeTerminal(detail?.capabilities, current.backendId ?: NativeBackendId.CURSOR),
        requiresLiveTerminal = detail?.capabilities?.requiresLiveTerminal == true,
    )
    val needsResume = conversation.statusKnown && !conversation.live && !conversation.archived &&
        !conversation.starting && !conversation.syncing && conversation.connectionNotice == null
    val resumeFailed = stringResource(Res.string.session_resume_failed)
    val resume: (() -> Unit)? = if (api != null && (resuming || (needsResume && detail?.capabilities?.supportsResume == true))) {
        {
            if (!resuming && !restartingProfile) {
                resuming = true
                scope.launch {
                    try {
                        api.startSession(current.id).session?.let(store::applySession)
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (failure: Throwable) {
                        snackbar?.show(failure.message?.takeIf { it.isNotBlank() } ?: resumeFailed)
                    } finally {
                        resuming = false
                    }
                }
            }
        }
    } else {
        null
    }
    val markFailed = stringResource(Res.string.session_mark_failed)
    val marksBySession = marks?.bySession?.collectAsState()?.value
    val markActions = if (marks != null) {
        remember(marks, current.id, marksBySession) {
            MarkActions(
                marked = { item -> marks.messageMark(current.id, item) != null },
                toggle = { item, text ->
                    scope.launch {
                        try {
                            val saved = marks.messageMark(current.id, item)
                            if (saved != null) marks.delete(listOf(saved.id)) else marks.create(current.id, "message", item, text)
                        } catch (cancellation: CancellationException) {
                            throw cancellation
                        } catch (failure: Throwable) {
                            snackbar?.show(failure.message?.takeIf { it.isNotBlank() } ?: markFailed)
                        }
                    }
                },
            )
        }
    } else {
        null
    }
    val connectionMessage = status?.connection?.takeIf { it.state == "failed" || it.state == "conflict" }?.let {
        it.message ?: stringResource(Res.string.session_connection_failed)
    }
    val historyMessage = status?.history?.takeIf { it.state == "error" }?.let {
        it.message ?: stringResource(Res.string.session_history_sync_failed)
    }?.takeIf { it != connectionMessage }
    // Info is routine progress, not something to act on: it never becomes a banner. A missing level is a warning.
    val nativeNotice = status?.notice?.takeIf { it.isNotBlank() && status?.noticeLevel != "info" && it != connectionMessage && it != historyMessage }
    var noticeDetail by remember(store, current.id) { mutableStateOf<Pair<String, SessionBanner>?>(null) }
    val bannerSource = listOfNotNull(
        connectionMessage?.let { FeedbackValue("connection:$it", SessionBanner("connection", it, SettingsNoticeKind.WARNING)) },
        historyMessage?.let { FeedbackValue("history:$it", SessionBanner("history", it, SettingsNoticeKind.WARNING)) },
        nativeNotice?.let { FeedbackValue("notice:$it", SessionBanner("notice", it, if (status?.noticeLevel == "error") SettingsNoticeKind.ERROR else SettingsNoticeKind.WARNING)) },
    )
    val feedbackVisible = sheet == null && !contextOpen && profileRestartTarget == null && noticeDetail == null
    // Every notice stays in the feedback source, so one that is only hidden is not read as resolved.
    // One is drawn per page (mobile.md §5): a live one before a resolved one, an error before a
    // warning; among equals the agent's connection first, since a failed history sync or a notice
    // usually follows from it.
    val presentedBanners = rememberFeedback(store to current.id, bannerSource, visible = feedbackVisible)
        .sortedWith(compareBy({ !it.current }, { if (it.value.tone == SettingsNoticeKind.ERROR) 0 else 1 }))
        .take(1)
    var persistentEntered by remember(store, current.id) { mutableStateOf(false) }
    var floatingEntered by remember(store, current.id) { mutableStateOf(false) }
    val persistentBanners = presentedBanners.filter { it.value.kind != "notice" }
    val floatingBanners = presentedBanners.filter { it.value.kind == "notice" }
    @Composable fun banner(entry: VisibleFeedback<SessionBanner>) {
        rememberResourceEnvironment()
        val live = entry.current && bannerSource.any { it.key == entry.key }
        val recovered = !live && when (entry.value.kind) {
            "connection" -> status?.connection?.state == "connected"
            "history" -> status?.history?.state == "ready"
            else -> false
        }
        var overflow by remember(entry.key) { mutableStateOf(false) }
        val floating = entry.value.kind == "notice"
        val text = if (recovered) L10n.uiText("feedback.recovered") + " · " + entry.value.text else entry.value.text
        SettingsMessageBanner(
            text,
            if (!live) SettingsNoticeKind.INFO else entry.value.tone,
            when { overflow -> stringResource(Res.string.session_details); live && !floating -> stringResource(Res.string.session_retry); else -> null },
            when { overflow -> ({ noticeDetail = entry.key to entry.value }); live && !floating -> ({ if (bannerSource.any { it.key == entry.key }) store.retry() }); else -> null },
            maxLines = 3,
            onOverflow = { overflow = it },
        )
    }
    noticeDetail?.let { (key, banner) ->
        riffet.ui.pickers.PickerOverlay(title = stringResource(Res.string.session_details), onDismiss = { noticeDetail = null }) {
            SelectionContainer {
                Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()).padding(horizontal = riffet.ui.pickers.SheetInset)) { Text(banner.text) }
            }
            if (banner.kind != "notice" && bannerSource.any { it.key == key }) {
                riffet.ui.design.GroupRow(
                    title = stringResource(Res.string.session_retry),
                    titleColor = LocalRiffetColors.current.accent,
                    onClick = {
                        if (bannerSource.any { it.key == key }) store.retry()
                        noticeDetail = null
                    },
                )
            }
        }
    }
    CompositionLocalProvider(
        LocalFileAccess provides fileAccess,
        LocalSubagentOpen provides openSubagentPage,
        LocalQuote provides quoteMessage,
        LocalSessionReferenceStore provides store,
        LocalSessionReferenceOpen provides onOpenSession?.let { open -> { id: String ->
            store.list.value.sessions.firstOrNull { it.id == id }?.let(open)
        } },
        LocalRunRecoveryStore provides store.takeIf { capabilities?.supportsRecovery == true },
        LocalRestoreNativeRun provides { run -> restoreRun = run },
        LocalTerminalOpen provides current.terminalId?.let { id -> onOpenTerminal?.let { open -> { open(id) } } },
        LocalMarkActions provides markActions,
    ) {
        Box(
            modifier = modifier
                .fillMaxSize()
                // Ctrl+F from a hardware keyboard.
                .onPreviewKeyEvent { event ->
                    val find = event.type == KeyEventType.KeyDown && event.isCtrlPressed && event.key == Key.F
                    if (find && !findOpen) store.find.open(null)
                    find
                }
                // Tapping the conversation ends the composer's focus (and a text selection), as a
                // browser does; the composer dock keeps its own taps (`keepsFocusOnTap`).
                .blurOnTap(),
        ) {
            RiffetPageScaffold(
                modifier = Modifier.fillMaxSize(),
                floatingBottomBar = true,
                // The transcript defers its rows itself, and the composer and its overlays stay in place.
                deferBody = false,
                topBar = {
                    Column {
                        if (findOpen) SessionFindBar(store.find, readingKey = readingPos) else SessionTopBar(
                            session = current,
                            connection = connection,
                            cachedAt = cachedAt,
                            onBack = onBack,
                            onOpenMenu = onOpenMenu,
                            onOpenDetails = onOpenDetails,
                            onRetry = { store.retry() },
                            onResume = resume,
                            resuming = resuming,
                            resumeEnabled = !restartingProfile,
                        )
                        if (!materialBackdropEnabled) HorizontalDivider(color = colors.line)

                        WaitingStrip(session = current, status = status, scope = store to current.id, visible = feedbackVisible, cardShown = interaction != null)

                        androidx.compose.runtime.key(store, current.id) {
                            Reveal(persistentBanners.takeIf { it.isNotEmpty() }, onEnteredChanged = { persistentEntered = it }) { banners ->
                                Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                    banners.forEach { entry -> FeedbackVisible(entry, persistentEntered) { banner(entry) } }
                                }
                            }
                        }
                    }
                },
                bottomBar = {
                    // A wide single pane (Pad, an unfolded phone) keeps the transcript's reading column.
                    Column(Modifier.fillMaxWidth().wrapContentWidth().widthIn(max = designMetrics.contentMaxWidth).snackbarBottomBar()
                        // Inside a tab the bar sits under the composer.
                        .padding(bottom = riffet.ui.app.LocalTabContentBottomPadding.current)) {
                        Reveal(Unit.takeIf { status?.profilePending == true && current.archivedAt == null }) {
                            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                                Text(stringResource(Res.string.session_profile_pending), color = colors.fg3, modifier = Modifier.weight(1f))
                                TextButton(enabled = api != null && current.nativeRuntime != null && !restartingProfile && !resuming, onClick = { profileRestartTarget = current.nativeRuntime }) {
                                    Text(stringResource(Res.string.session_profile_restart))
                                }
                            }
                        }
                        Reveal(
                            status?.runtimeControl?.takeIf {
                                selected?.id == current.id && current.archivedAt == null && connection is RiffetConnectionState.Live &&
                                    (it.notice?.label != null || it.notice?.detail != null || it.notice?.action != null)
                            },
                        ) { control ->
                            val notice = control.notice
                            val pending = detail?.runtimeActionPending == true
                            val tone = notice?.tone
                            val label = notice?.label?.let { localizedAppearanceTitle(it) }.orEmpty()
                            val action = notice?.action
                            Column {
                                Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                                    Text(label, color = if (tone == "danger") colors.danger else colors.fg3, modifier = Modifier.weight(1f))
                                    if (tone == "progress" || pending) {
                                        CircularProgressIndicator(modifier = Modifier.size(14.dp), strokeWidth = 1.5.dp, color = colors.fg3)
                                    } else if (action != null) {
                                        TextButton(enabled = controller != null && action.disabled != true, onClick = { controller?.runRuntimeAction(action, control.revision) }) {
                                            Text(localizedAppearanceTitle(action.label))
                                        }
                                    }
                                }
                                if (tone == "danger") notice?.detail?.let { message -> Text(message, color = colors.danger, modifier = Modifier.padding(horizontal = designMetrics.pageInset)) }
                                detail?.error?.let { message -> Text(message, color = colors.danger, modifier = Modifier.padding(horizontal = designMetrics.pageInset)) }
                            }
                        }
                        // The agent's question or approval, rendered as controls on the conversation rather than
                        // sent to the terminal. Above the composer because answering is what unblocks the run.
                        Reveal(interaction) { pending ->
                            InteractionCard(
                                interaction = pending,
                                connected = connection is RiffetConnectionState.Live ||
                                    connection is RiffetConnectionState.Connecting,
                                onRespond = { response ->
                                    haptics.performHapticFeedback(HapticFeedbackType.Confirm)
                                    store.respondInteraction(response)
                                },
                                onSync = { store.syncInteraction() },
                            )
                        }

                        // The composer is always mounted, even while the stream is down: a draft is still useful,
                        // and the send button reports the disconnected state instead of disappearing.
                        Composer(
                            store = store,
                            session = current,
                            writeScope = writeScope,
                            packs = assistantPacks,
                            supportsSteer = detail?.capabilities?.supportsSteer == true,
                            supportsSessionReferences = detail?.capabilities?.supportsSessionReferences == true,
                            supportsTargetedStop = detail?.capabilities?.supportsTargetedStop == true,
                            acceptsMessages = detail?.capabilities?.requiresLiveTerminal != true || conversation.live,
                            settings = ComposerSettings(
                                label = currentModelSummary.ifEmpty { stringResource(Res.string.session_select_model) },
                                icon = null,
                                context = context.takeUnless { quickChat },
                                enabled = controller != null,
                                onOpen = { sheet = SessionSheet.Settings },
                                loading = detail?.catalogLoading == true,
                                switching = detail?.switching == true,
                                error = detail?.catalogError != null,
                            ),
                            // The dock above the input card owns the plan rows the transcript hides.
                            todos = presentation?.todos.orEmpty(),
                            goal = presentation?.goal,
                            quote = quote,
                            restoreRun = restoreRun,
                            onRestoreHandled = { run -> if (restoreRun?.id == run.id) restoreRun = null },
                            background = presentation?.backgroundSubagents ?: 0,
                            // What the reader just sent is what they want to watch.
                            onSubmit = {
                                store.jumpToLatest()
                                follow.resume()
                            },
                        )
                    }
                },
                overlay = { chromePadding ->
                    // Above the recorded transcript, so their material frosts the rows beneath them.
                    AnimatedVisibility(visible = entered && visible.isNotEmpty(), modifier = Modifier.fillMaxSize(),
                        enter = pageMotion.reveal(), exit = pageMotion.conceal()) {
                        Box(Modifier.fillMaxSize()) {
                            HistoryPill(
                                error = historyError,
                                onRetry = store::retryHistory,
                                modifier = Modifier.align(Alignment.TopCenter).padding(top = chromePadding.calculateTopPadding() + 8.dp),
                                syncing = cachedAt != null,
                            )
                            TurnNavigator(
                                ticks = ticks,
                                activeIndex = activeTurnIndex,
                                onJump = { position ->
                                    ticks.getOrNull(position)?.let { tick ->
                                        follow.pause()
                                        scope.launch { listState.animateScrollToItemNear(tick.index) }
                                    }
                                },
                                modifier = Modifier.align(Alignment.TopEnd).padding(top = chromePadding.calculateTopPadding() + 4.dp, end = 8.dp),
                            )
                            val awayFromTail by remember(follow, listState, hasNewerHistory) {
                                derivedStateOf { (!follow.following && listState.canScrollForward) || hasNewerHistory }
                            }
                            JumpToLatest(
                                visible = awayFromTail,
                                unread = follow.unread,
                                onClick = {
                                    store.jumpToLatest()
                                    follow.resume()
                                },
                                modifier = Modifier.align(Alignment.BottomEnd).padding(end = 8.dp, bottom = chromePadding.calculateBottomPadding() + 4.dp),
                            )
                        }
                    }
                },
            ) { chromePadding ->
                // One fixed slot for five states. Deferred rows reveal once after the page settles;
                // other body changes follow the page motion. The hoisted list and follow state survive both.
                if (layout.entries.isNotEmpty()) {
                    lastRows.layout = layout
                    lastRows.tail = visible.lastOrNull()
                }
                val body = when {
                    connection is RiffetConnectionState.Failed && visible.isEmpty() -> TranscriptBody.FAILED
                    !loaded && visible.isEmpty() -> TranscriptBody.LOADING
                    visible.isEmpty() -> TranscriptBody.EMPTY
                    !entered -> TranscriptBody.ENTERING
                    else -> TranscriptBody.TRANSCRIPT
                }
                AnimatedContent(
                    targetState = body,
                    modifier = Modifier.fillMaxSize(),
                    // Fixed-size slot: the keyboard resizes it every frame, which a size animation would lag behind.
                    transitionSpec = {
                        if (initialState == TranscriptBody.ENTERING) pageMotion.revealTransition()
                        else pageMotion.transition()
                    },
                    label = "transcript",
                ) { state ->
                    when (state) {
                        TranscriptBody.FAILED ->
                            TranscriptMessage(
                                modifier = Modifier.fillMaxSize().padding(chromePadding),
                                title = stringResource(Res.string.session_connection_failed),
                                body = (connection as? RiffetConnectionState.Failed)?.reason,
                                action = stringResource(Res.string.session_retry) to { store.retry() },
                            )

                        TranscriptBody.LOADING ->
                            Box(
                                modifier = Modifier.fillMaxSize().padding(chromePadding),
                                contentAlignment = Alignment.Center,
                            ) {
                                CircularProgressIndicator(color = colors.accent)
                            }

                        TranscriptBody.EMPTY ->
                            TranscriptMessage(
                                modifier = Modifier.fillMaxSize().padding(chromePadding),
                                title = stringResource(Res.string.session_no_messages),
                            )

                        TranscriptBody.ENTERING -> Box(Modifier.fillMaxSize())

                        TranscriptBody.TRANSCRIPT -> Box(modifier = Modifier.fillMaxSize()) {
                            // While this child leaves because the rows went away, it keeps the last rows it
                            // had: a list measured with none would reset the hoisted state to the top.
                            val shown = if (layout.entries.isNotEmpty()) layout else lastRows.layout ?: layout
                            val shownTail = visible.lastOrNull() ?: lastRows.tail
                            // Measured turn speed, so a turn header can report `tok/s` while it runs. The live
                            // map wins over the persisted one: a running turn's aggregate is fresher than the
                            // last `runs` snapshot.
                            val stoppingActivities by store.stoppingActivities.collectAsState()
                            val activityActions = remember(store, stoppingActivities) {
                                riffet.ui.timeline.ActivityActions(
                                    stopping = stoppingActivities,
                                    onStop = { id -> scope.launch { store.stopActivity(id) } },
                                    loadText = { blobRef -> store.activityText(blobRef) },
                                )
                            }
                            androidx.compose.runtime.CompositionLocalProvider(riffet.ui.timeline.LocalActivityActions provides activityActions) {
                            riffet.ui.timeline.Timeline(
                                // The same layout the ticks above were built from: the transcript must not
                                // re-project the timeline a second time for every streamed frame.
                                contentPadding = chromePadding,
                                layout = shown,
                                tail = shownTail,
                                onToggleProcess = folds::toggle,
                                // Lines stay readable on a wide single pane; narrower windows are unchanged.
                                modifier = Modifier.fillMaxSize().wrapContentWidth().widthIn(max = designMetrics.contentMaxWidth).fillMaxWidth(),
                                root = project?.cwd,
                                // Per answer row, already resolved by the presenter: a metrics frame
                                // re-renders only the rows whose label changed.
                                speeds = presentation?.speeds.orEmpty(),
                                onOpenFile = { path, line -> onOpenFile?.invoke(path, line) },
                                // The turn navigator scrolls this same state, so a tap actually moves the transcript.
                                listState = listState,
                                footer = if (workingVisible) {
                                    { WorkingFooter(statusFeed, run = running, live = connection is RiffetConnectionState.Live, stopping = sendState.interrupting) }
                                } else if (delegatedAgents + delegatedWorkflows > 0) {
                                    { DelegatedWorkIndicator(agents = delegatedAgents, workflows = delegatedWorkflows, onClick = onOpenDetails) }
                                } else {
                                    null
                                },
                                onReachTop = store::loadOlder,
                                reachTopKey = remember(loadingHistory, history?.hasMore, history?.cursor, historyError) {
                                    listOf(loadingHistory, history?.hasMore, history?.cursor, historyError)
                                },
                                focus = focus,
                                find = findLanding,
                                follow = follow,
                            )
                            }
                        }
                    }
                }
                // Transient provider notices float over the transcript without resizing its viewport.
                Box(Modifier.fillMaxSize().padding(top = chromePadding.calculateTopPadding())) {
                    androidx.compose.runtime.key(store, current.id) {
                        Reveal(floatingBanners.takeIf { it.isNotEmpty() }, Modifier.align(Alignment.TopCenter), onEnteredChanged = { floatingEntered = it }) { banners ->
                            Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                banners.forEach { entry -> FeedbackVisible(entry, floatingEntered) { banner(entry) } }
                            }
                        }
                    }
                }
            }
        }
    }

    // Sheets sit outside the Column so their scrim covers the composer too. One sheet, several
    // pages: settings is the root and mode, permission and model are one step deeper. A pick applies
    // its choice and the sheet then leaves on its own, so nothing below closes it by hand.
    sheet?.let { page ->
        PickerSheet(page = page, onDismiss = { sheet = null }, depth = { if (it == SessionSheet.Settings) 0 else 1 }) { shown ->
            when (shown) {
                SessionSheet.Settings -> {
                    // One notice, the most actionable first: a failed restore, why writes are blocked, then a
                    // catalog that could not be read. Each carries its one safe remedy.
                    val archived = current.archivedAt != null
                    val restore = if (archived && controller != null && detail?.actionBusy != true) {
                        stringResource(Res.string.session_restore) to { controller.update(SessionUpdate(archived = false)) }
                    } else {
                        null
                    }
                    val changeError = detail?.error?.takeIf { archived }
                    val catalogError = detail?.catalogError?.takeIf { writeBlocked == null }
                    SendSettingsPage(
                        notice = when {
                            changeError != null -> stringResource(Res.string.session_last_change_failed, changeError)
                            writeBlocked != null -> writeBlocked
                            catalogError != null -> stringResource(Res.string.pickers_catalog_failed, catalogError)
                            else -> null
                        },
                        noticeKind = if (changeError != null || (writeBlocked == null && catalogError != null)) SettingsNoticeKind.ERROR else SettingsNoticeKind.INFO,
                        noticeAction = when {
                            changeError != null || writeBlocked != null -> restore
                            catalogError != null && controller != null -> stringResource(Res.string.pickers_retry) to {
                                controller.retryCatalog(current.backendId ?: NativeBackendId.CURSOR, current.backendProfileId, current.projectId)
                            }
                            else -> null
                        },
                        context = context.takeUnless { quickChat },
                        // The breakdown is a sheet of its own (it has no page form), so this one steps aside for it.
                        onOpenContext = { sheet = null; contextOpen = true },
                        rows = buildList {
                            // A quick chat can switch between 对话 and its presets; only a backend with a single
                            // mode has nothing to offer.
                            capabilities?.modes?.takeIf { modes -> if (quickChat) modes.size > 1 else modes.isNotEmpty() }?.let { modes ->
                                add(SendSettingRow(label = stringResource(Res.string.session_mode), value = optionLabelOf(modes, intended.mode, stringResource(Res.string.session_mode)), enabled = writeBlocked == null && !writeBusy) { sheet = SessionSheet.Mode })
                            }
                            if (!quickChat) {
                                capabilities?.permissions?.takeIf { it.isNotEmpty() }?.let {
                                    add(
                                        SendSettingRow(
                                            label = stringResource(Res.string.session_permission),
                                            value = currentApprovalLabel ?: stringResource(Res.string.session_not_set),
                                            enabled = writeBlocked == null && !writeBusy,
                                        ) { sheet = SessionSheet.Approval },
                                    )
                                }
                            }
                            add(
                                SendSettingRow(
                                    label = stringResource(Res.string.session_model),
                                    value = currentModelSummary.ifEmpty { stringResource(Res.string.session_not_set) },
                                    enabled = writeBlocked == null && !writeBusy,
                                    loading = detail?.catalogLoading == true,
                                    switching = detail?.switching == true,
                                    error = detail?.catalogError != null,
                                ) { sheet = SessionSheet.Model },
                            )
                            if (toolsShown) {
                                add(
                                    SendSettingRow(
                                        label = stringResource(Res.string.pickers_tools_title),
                                        value = toolsSummary(toolGroups, if (extensions != null) extensionsOff else emptyList(), switches = extensions != null),
                                        icon = RiffetIcons.Puzzle,
                                        enabled = writeBlocked == null,
                                    ) { sheet = SessionSheet.Tools },
                                )
                            }
                        },
                    )
                }

                SessionSheet.Model -> if (controller != null && detail != null) {
                    ModelPickerPages(
                        catalog = detail.catalog,
                        catalogLoading = detail.catalogLoading,
                        catalogError = detail.catalogError,
                        // The newest pick, not the session: a parameter changed while the last write is still in
                        // flight must build on it, or the earlier change is overwritten.
                        selection = intended.model ?: "",
                        switching = detail.switching,
                        disabledReason = writeBlocked ?: "".takeIf { writeBusy },
                        onSelect = { controller.setModel(it) },
                        // Fast / Max / the thinking level keep the sheet open, as the web's `onParamChange` does.
                        onParamChange = { controller.setModel(it) },
                        onBack = { sheet = SessionSheet.Settings },
                        onRetryCatalog = { controller.retryCatalog(current.backendId ?: riffet.contracts.NativeBackendId.CURSOR, current.backendProfileId, current.projectId) },
                        loadUsage = { controller.usage(current.backendId ?: riffet.contracts.NativeBackendId.CURSOR) },
                        usageScopeKey = "${current.backendId}|${current.id}|${current.backendProfileId ?: ""}",
                        showSubtitle = !quickChat,
                        groups = providerGroups,
                        activeProfileId = current.backendProfileId,
                        onSelectChoice = { profileId, selection ->
                            if (profileId == current.backendProfileId) controller.setModel(selection) else controller.switchProfile(profileId, selection)
                        },
                    )
                }

                SessionSheet.Mode -> if (controller != null) capabilities?.let { caps ->
                    ModePickerPage(
                        options = caps.modes,
                        value = intended.mode,
                        currentLabel = optionLabelOf(caps.modes, intended.mode, stringResource(Res.string.session_mode)),
                        disabledReason = writeBlocked ?: "".takeIf { writeBusy },
                        onSelect = { controller.setMode(it) },
                        onBack = { sheet = SessionSheet.Settings },
                    )
                }

                SessionSheet.Tools -> if (controller != null) {
                    ToolsPickerPage(
                        value = toolGroups,
                        devices = toolDevices,
                        plugins = pluginTools,
                        onChange = { controller.setToolGroups(it) },
                        extensions = extensions,
                        footnote = stringResource(Res.string.pickers_tools_next_launch),
                        error = detail?.error,
                        enabled = writeBlocked == null,
                        onBack = { sheet = SessionSheet.Settings },
                    )
                }

                SessionSheet.Approval -> if (controller != null) capabilities?.let { caps ->
                    ApprovalPickerPage(
                        options = caps.permissions,
                        value = intended.approval ?: "",
                        currentLabel = optionLabelOf(caps.permissions, intended.approval ?: "", stringResource(Res.string.pickers_approval_title)),
                        disabledReason = writeBlocked ?: "".takeIf { writeBusy },
                        onSelect = { controller.setApproval(it) },
                        onBack = { sheet = SessionSheet.Settings },
                    )
                }
            }
        }
    }
    if (contextOpen && context != null) {
        ContextBreakdownSheet(usage = context, onDismiss = { contextOpen = false }, onBack = { contextOpen = false; sheet = SessionSheet.Settings })
    }
}

/** The pages of the session's one send-settings sheet: Settings is the root, the rest are one step deeper. */
private enum class SessionSheet { Settings, Mode, Approval, Model, Tools }

/**
 * The last frame's transcript projection, which the next frame is diffed against.
 *
 * Shared with `SubagentScreen`: a child transcript is projected the same way, and it pays the same
 * price for re-grouping every streamed chunk.
 */
internal class PreviousTimeline {
    var grouping: TimelineGrouping? = null
    var layout: TimelineLayout? = null
    var ticks: List<TurnTick> = emptyList()
}

/** The one rename dialog, shared by the details drawer and the list row menu. */
@Composable
fun RenameSessionDialog(initial: String, onDismiss: () -> Unit, onConfirm: (String) -> Unit) {
    var text by remember { mutableStateOf(initial) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(text = stringResource(Res.string.session_rename_session)) },
        text = {
            OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                singleLine = true,
                label = { Text(text = stringResource(Res.string.session_title)) },
                modifier = Modifier.fillMaxWidth(),
            )
        },
        confirmButton = {
            TextButton(onClick = { onConfirm(text.trim()) }, enabled = text.isNotBlank()) { Text(text = stringResource(Res.string.session_save)) }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(text = stringResource(Res.string.session_cancel)) }
        },
    )
}

/**
 * The web's mobile `Header`: back to the list, then the session title — the title itself is the
 * button that opens 会话信息与操作, which the workbench now draws as its right drawer rather than as
 * a sheet over this screen. The model is not in the header; it lives in the composer's settings chip,
 * next to what it configures. Running state is the transcript's to show.
 */
@Composable
private fun SessionTopBar(
    session: Session,
    connection: RiffetConnectionState,
    cachedAt: Long?,
    onBack: () -> Unit,
    onOpenMenu: (() -> Unit)?,
    onOpenDetails: () -> Unit,
    onRetry: () -> Unit,
    /** Present while the CLI is not running and can be reopened (or is being reopened). */
    onResume: (() -> Unit)? = null,
    resuming: Boolean = false,
    resumeEnabled: Boolean = true,
) {
    val colors = LocalRiffetColors.current
    Row(
        modifier = Modifier.fillMaxWidth().height(64.dp).padding(start = 4.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (onOpenMenu != null) PageBarAction(icon = RiffetIcons.Menu, description = stringResource(Res.string.session_open_sidebar), onClick = onOpenMenu, tint = colors.fg)
        else PageBarAction(icon = RiffetIcons.ArrowLeft, description = stringResource(Res.string.app_back), onClick = onBack, tint = colors.fg)
        Box(
            modifier = Modifier
                .weight(1f)
                .height(48.dp)
                .clip(CircleShape)
                .clickable(role = Role.Button, onClick = onOpenDetails)
                .padding(start = 4.dp, end = 4.dp),
            contentAlignment = Alignment.CenterStart,
        ) {
            Text(
                text = if (onOpenMenu != null) stringResource(Res.string.assistant_title) else session.shownTitle,
                // A title someone else wrote, often long: a row title's size, not a page heading's.
                style = LocalRiffetTypography.current.headline,
                color = colors.fg,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        if (onResume != null && connection !is RiffetConnectionState.Failed) {
            ResumeChip(resuming = resuming, enabled = resumeEnabled, onClick = onResume)
        } else {
            ConnectionPill(connection = connection, cachedAt = cachedAt, onRetry = onRetry)
        }
        // Last in the bar: neither the title nor connection/resume controls can move this arrow.
        PageBarAction(
            icon = RiffetIcons.ChevronRight,
            description = stringResource(Res.string.session_info_actions),
            onClick = onOpenDetails,
            tint = colors.fg2,
        )
    }
}

/** 恢复: the not-running state as its remedy. The spinner keeps the word's width while it reopens. */
@Composable
private fun ResumeChip(resuming: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val label = stringResource(Res.string.session_resume)
    val startingLabel = stringResource(Res.string.session_state_starting)
    Box(
        modifier = Modifier
            .minimumInteractiveComponentSize()
            .padding(horizontal = 4.dp)
            .clip(CircleShape)
            .background(LocalRiffetSurfaces.current.card)
            .clickable(role = Role.Button, enabled = enabled && !resuming, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 6.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(text = label, style = typography.label, color = if (enabled) LocalRiffetSurfaces.current.selectedContent else LocalRiffetSurfaces.current.disabledContent, modifier = if (resuming) Modifier.alpha(0f) else Modifier)
        if (resuming) {
            CircularProgressIndicator(
                modifier = Modifier.size(14.dp).semantics { stateDescription = startingLabel },
                strokeWidth = 1.5.dp,
                color = colors.fg3,
            )
        }
    }
}

/**
 * The connection state as one compact pill: a dot and, only when something is wrong or in progress,
 * a word. `Live` is the healthy steady state and stays icon-only so the title keeps the width.
 *
 * While the transcript is the device's stored copy ([cachedAt]) the word says so: it is being
 * brought up to date, or, without a connection, how old it is.
 */
@Composable
private fun ConnectionPill(connection: RiffetConnectionState, cachedAt: Long?, onRetry: () -> Unit) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    // Healthy is silent: the header's dot belongs to the session's state, not the socket's.
    if (connection == RiffetConnectionState.Idle) return
    if (connection == RiffetConnectionState.Live && cachedAt == null) return
    // Refreshed every minute, so an hour offline does not keep saying 刚刚同步.
    val now = rememberTickingNow(active = cachedAt != null, intervalMillis = 60_000L)
    val offline = cachedAt?.let {
        if (isJustNow(it, now)) stringResource(Res.string.session_offline_synced_now)
        else stringResource(Res.string.session_offline_age, relativeTimeLabel(it, now))
    }
    val (tint, label) = when (connection) {
        RiffetConnectionState.Idle -> colors.fg4 to ""
        RiffetConnectionState.Connecting -> colors.accent to if (cachedAt != null) stringResource(Res.string.session_syncing) else stringResource(Res.string.session_connecting)
        RiffetConnectionState.Live -> colors.accent to stringResource(Res.string.session_syncing)
        RiffetConnectionState.Reconnecting -> colors.fg3 to (offline ?: stringResource(Res.string.session_reconnecting))
        is RiffetConnectionState.Failed -> colors.danger to (offline ?: stringResource(Res.string.session_disconnected))
    }
    Row(
        modifier = Modifier.padding(horizontal = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(modifier = Modifier.size(7.dp).background(tint, CircleShape))
        if (label.isNotEmpty()) {
            Spacer(Modifier.width(5.dp))
            Text(text = label, style = typography.caption, color = colors.fg3)
        }
        if (connection is RiffetConnectionState.Failed) {
            Spacer(Modifier.width(4.dp))
            // The word stays small; the touch target around it is 48dp.
            Box(
                modifier = Modifier
                    .minimumInteractiveComponentSize()
                    .clip(RoundedCornerShape(LocalInterfaceStyle.current.controlRadius))
                    .clickable(role = Role.Button, onClick = onRetry),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = stringResource(Res.string.session_retry),
                    style = typography.label,
                    color = colors.accent,
                    modifier = Modifier.padding(horizontal = 6.dp, vertical = 4.dp),
                )
            }
        }
    }
}

/**
 * The single most useful thing a phone can show: the agent has stopped and needs the human. A
 * waiting session state and an `attention` status are the two ways the server expresses that, and
 * an interaction carries the question that is actually being asked.
 *
 * One fact in one place (mobile.md §5): while the question is on its card above the composer
 * ([cardShown]), the card is where it is read and answered, and this strip stays away. It shows
 * only for a wait the app cannot answer, with the way to the terminal.
 */
@Composable
private fun WaitingStrip(session: Session, status: NativeStatus?, scope: Any, visible: Boolean, cardShown: Boolean) {
    // Live status wins over the session snapshot, which can still say WAITING after an answer.
    val waiting = !cardShown && (status?.let { it.phase == NativeStatusPhase.ATTENTION }
        ?: (session.state == SessionState.WAITING))
    val interaction = status?.interaction
    // The heading already says the agent is waiting; the line under it only carries the question.
    val text = interaction?.message?.takeIf { it.isNotBlank() }
        ?: interaction?.title?.takeIf { it.isNotBlank() }
    // With no question to draw, the terminal is where the agent is waiting.
    val openTerminal = if (status != null && interaction == null) LocalTerminalOpen.current else null
    val key = "waiting:${interaction?.id.orEmpty()}:${text.orEmpty()}"
    val source = if (waiting) listOf(FeedbackValue(key, WaitingContent(text))) else emptyList()
    val entries = rememberFeedback(scope, source, visible)
    var entered by remember(scope) { mutableStateOf(false) }
    androidx.compose.runtime.key(scope) {
        Reveal(entries.takeIf { it.isNotEmpty() }, onEnteredChanged = { entered = it }) { retained ->
            Column {
                retained.forEach { entry ->
                    val current = entry.current && waiting && entry.key == key
                    FeedbackVisible(entry, entered) {
                        WaitingRow(entry.value.text, openTerminal.takeIf { current }, current)
                    }
                }
            }
        }
    }
}

private data class WaitingContent(val text: String?)

@Composable
private fun WaitingRow(text: String?, openTerminal: (() -> Unit)?, current: Boolean) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(if (current) colors.warningSoft else colors.bg)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(if (current) RiffetIcons.Warning else RiffetIcons.Info, contentDescription = null, tint = if (current) colors.warning else colors.fg3, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(8.dp))
        Column(modifier = Modifier.weight(1f)) {
            if (current) Text(text = stringResource(Res.string.session_waiting_for_you), style = typography.label, color = colors.warning)
            if (text != null) {
                Text(
                    text = text,
                    style = typography.bodySmall,
                    color = colors.fg2,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (openTerminal != null) {
            Text(
                text = stringResource(Res.string.timeline_interaction_answer_in_terminal),
                style = typography.label,
                color = colors.accent,
                modifier = Modifier
                    .padding(start = 8.dp)
                    .minimumInteractiveComponentSize()
                    .clip(RoundedCornerShape(LocalInterfaceStyle.current.controlRadius))
                    .clickable(role = Role.Button, onClick = openTerminal)
                    .padding(horizontal = 6.dp, vertical = 4.dp),
            )
        }
    }
}

@Composable
private fun TranscriptMessage(
    modifier: Modifier = Modifier,
    title: String,
    body: String? = null,
    action: Pair<String, () -> Unit>? = null,
) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    Column(
        modifier = modifier.padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(text = title, style = typography.title, color = colors.fg)
        if (body != null) {
            Spacer(Modifier.height(8.dp))
            Text(text = body, style = typography.bodySmall, color = colors.fg3)
        }
        if (action != null) {
            Spacer(Modifier.height(20.dp))
            Row(
                modifier = Modifier
                    .clip(RoundedCornerShape(LocalInterfaceStyle.current.controlRadius))
                    .background(LocalRiffetSurfaces.current.card)
                    .clickable(role = Role.Button, onClick = action.second)
                    .padding(horizontal = 16.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(RiffetIcons.Refresh, contentDescription = null, tint = colors.fg2, modifier = Modifier.size(14.dp))
                Spacer(Modifier.width(6.dp))
                Text(text = action.first, style = typography.label, color = colors.fg)
            }
        }
    }
}

private class LastRows {
    var layout: TimelineLayout? = null
    var tail: riffet.core.TimelineItem? = null
}

/** What the transcript's slot shows; a change of kind cross-fades. */
private enum class TranscriptBody { FAILED, LOADING, EMPTY, ENTERING, TRANSCRIPT }

private data class SessionBanner(val kind: String, val text: String, val tone: SettingsNoticeKind)

/** The working line. It alone reads the status feed's output rate, so a rate frame recomposes only this. */
@Composable
private fun WorkingFooter(feed: State<NativeStatus?>, run: riffet.contracts.Run?, live: Boolean, stopping: Boolean) {
    WorkingIndicator(run = run, outputRate = feed.value?.outputRate?.takeIf { live }, stopping = stopping)
}

/** How much of a message a quote carries into the draft. */
private const val QUOTE_LIMIT = 200
