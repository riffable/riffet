package riffet.ui.home

import riffet.ui.theme.appearancePageBackground

import riffet.ui.app.LocalTabContentBottomPadding

import riffet.ui.design.LocalRiffetSurfaces
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.pressScale
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.tween
import androidx.compose.runtime.mutableFloatStateOf
import kotlinx.coroutines.Job
import riffet.ui.theme.LocalRiffetMotion
import riffet.ui.theme.LocalRiffetPageMotion
import androidx.compose.material3.TabRowDefaults
import androidx.compose.runtime.Stable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.lerp
import riffet.contracts.NativeBackendOption
import riffet.ui.app.TabTopBar
import riffet.ui.app.RiffetPageScaffold
import riffet.ui.design.materialBackdropEnabled
import riffet_mobile.shared.generated.resources.session_quick_chat_plain
import androidx.compose.ui.semantics.Role
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.awaitHorizontalTouchSlopOrCancellation
import androidx.compose.foundation.gestures.horizontalDrag
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.PrimaryScrollableTabRow
import androidx.compose.material3.Tab
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.unit.LayoutDirection
import riffet_mobile.shared.generated.resources.session_mode_chat
import riffet_mobile.shared.generated.resources.session_mode_task
import riffet_mobile.shared.generated.resources.session_tab_new
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.layout.heightIn
import riffet.ui.timeline.Spinner
import riffet.ui.timeline.rememberReducedMotion
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import riffet.ui.design.RiffetTextButton as TextButton
import riffet.ui.icons.Icon
import riffet.ui.design.RiffetIconButton as IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.SideEffect
import riffet.ui.composer.ComposerDraft
import riffet.ui.composer.LocalComposerDrafts
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.IntState
import androidx.compose.ui.graphics.vector.ImageVector
import riffet.shared.createShellTerminal
import riffet.shared.terminals
import riffet.contracts.TerminalState
import riffet.contracts.TerminalKind
import riffet.ui.icons.LiveBrandMark
import androidx.compose.foundation.layout.ime
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.layout
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.supervisorScope
import riffet.contracts.Attachment
import riffet.ui.focus.blurOnTap
import riffet.contracts.ModelInfo
import riffet.contracts.NativeBackendCapabilities
import riffet.contracts.NativeBackendCatalogEntry
import riffet.contracts.NativeBackendId
import riffet.contracts.NativeBackendProfile
import riffet.contracts.NativeSlashCatalog
import riffet.contracts.Project
import riffet.contracts.Session
import riffet.contracts.SessionState
import riffet.shared.AppPreferences
import riffet.shared.ExtensionsOff
import riffet.shared.PreferenceKeys
import riffet.shared.ToolGroups
import riffet.shared.RiffetApi
import riffet.shared.sessionReference
import riffet.ui.composer.ComposerCard
import riffet.ui.composer.AttachmentIntakeError
import riffet.ui.composer.attachmentIntakeError
import riffet.ui.composer.rememberAttachmentPicker
import riffet.ui.icons.AgentMarks
import riffet.ui.icons.RiffetIcons
import riffet.ui.pickers.ApprovalPickerPage
import riffet.ui.pickers.LocalPickerHost
import riffet.ui.pickers.ModePickerPage
import riffet.ui.pickers.ModelPickerGroup
import riffet.ui.pickers.ModelPickerPages
import riffet.ui.pickers.OptionRow
import riffet.ui.pickers.PickerPage
import riffet.ui.pickers.PickerSheet
import riffet.ui.pickers.SendSettingRow
import riffet.ui.pickers.ToolsPickerPage
import riffet.ui.pickers.extensionsPick
import riffet.ui.pickers.rememberExtensionsListed
import riffet.ui.pickers.offeredPicks
import riffet.ui.pickers.rememberToolDevices
import riffet.ui.pickers.toolsOffered
import riffet.ui.pickers.toolsSummary
import riffet.ui.pickers.approvalIcon
import riffet.ui.composer.ComposerSettings
import riffet.ui.pickers.SendSettingsPage
import riffet.ui.settings.SettingsNoticeKind
import androidx.compose.ui.text.style.TextOverflow
import riffet.ui.quickchat.QuickChatModeChips
import riffet.ui.quickchat.QuickChatPresetPrompt
import riffet.ui.pickers.modelLabel
import riffet.ui.pickers.modelSelectionSummary
import riffet.ui.pickers.optionLabelOf
import riffet.ui.session.backendName
import riffet.ui.sessionlist.activityAt
import riffet.ui.timeline.instantMillis
import riffet.ui.sessionlist.compareSessions
import riffet.ui.sessionlist.relativeTimeLabel
import riffet.ui.state.SessionStore
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet.shared.backendCatalog
import riffet.shared.backendUsage
import riffet.shared.backends
import riffet.shared.isQuickChat
import riffet.shared.slashCatalog
import org.jetbrains.compose.resources.getString
import org.jetbrains.compose.resources.stringResource
import riffet_mobile.shared.generated.resources.Res
import riffet_mobile.shared.generated.resources.pickers_catalog_failed
import riffet_mobile.shared.generated.resources.pickers_retry
import riffet_mobile.shared.generated.resources.composer_attachment_too_large
import riffet_mobile.shared.generated.resources.composer_attachments_limit
import riffet_mobile.shared.generated.resources.app_operation_failed
import riffet_mobile.shared.generated.resources.composer_placeholder_online
import riffet_mobile.shared.generated.resources.pickers_approval_title
import riffet_mobile.shared.generated.resources.pickers_tools_title
import riffet_mobile.shared.generated.resources.session_add_directory
import riffet_mobile.shared.generated.resources.session_attachment_upload_failed
import riffet_mobile.shared.generated.resources.session_attachment_uploading
import riffet_mobile.shared.generated.resources.session_cannot_use_directory
import riffet_mobile.shared.generated.resources.session_catalog_read_failed
import riffet_mobile.shared.generated.resources.session_create_session_failed
import riffet_mobile.shared.generated.resources.session_default_model
import riffet_mobile.shared.generated.resources.session_loading_projects
import riffet_mobile.shared.generated.resources.session_mode
import riffet_mobile.shared.generated.resources.session_model
import riffet_mobile.shared.generated.resources.session_new_session
import riffet_mobile.shared.generated.resources.session_no_directory
import riffet_mobile.shared.generated.resources.session_permission
import riffet_mobile.shared.generated.resources.session_provider_not_read
import riffet_mobile.shared.generated.resources.session_provider_unavailable
import riffet_mobile.shared.generated.resources.session_quick_chat
import riffet_mobile.shared.generated.resources.session_refresh
import riffet_mobile.shared.generated.resources.session_remove
import riffet_mobile.shared.generated.resources.external_import_action
import riffet_mobile.shared.generated.resources.session_terminal
import riffet_mobile.shared.generated.resources.session_switch_project
import riffet_mobile.shared.generated.resources.session_task_placeholder
import riffet_mobile.shared.generated.resources.session_reference_limit

/*
 * The workbench with no session open: `apps/web/src/app/ProjectHome.tsx`.
 *
 * 新建任务 / 快速会话 under the top bar (the web's `UnderlineTabs`) are two launch targets for one
 * draft, as on the web: switching is local state on this page, not a project change. One composer
 * stays in place with its text and attachments; only the launch target, its placeholder and
 * settings chip, and the slot below the composer (the directory for a task, the presets for a chat)
 * change. Both run configurations live above the page ([HomeConfigs]), so switching back and forth,
 * or leaving the tab, reads no catalog again. The agent, model, mode and permission start from the
 * server's saved defaults (`settings.nativeBackendDefaults`) exactly as the web's home does.
 */

/** The page's one draft, shared by both launch targets (the web's `new:home`). */
internal const val HOME_DRAFT_ID = "home"


/** A fling faster than this settles the mode the way it was flung. */
private val ModeSettleVelocity = 400.dp

/**
 * 新会话's two run configurations, one per launch target. Held by the workbench rather than the page,
 * so a mode switch or a tab switch keeps the loaded catalogs; they reload only when the providers
 * change (`backendRevision`), the saved defaults change, or the reader retries.
 */
@Stable
class HomeConfigs internal constructor(internal val task: HomeConfig, internal val chat: HomeConfig)

@Composable
fun rememberHomeConfigs(api: RiffetApi?, preferences: AppPreferences? = null): HomeConfigs {
    val scope = rememberCoroutineScope()
    val catalogReadFailed = stringResource(Res.string.session_catalog_read_failed)
    val providerNotRead = stringResource(Res.string.session_provider_not_read)
    return remember(api, preferences, catalogReadFailed, providerNotRead) {
        HomeConfigs(
            task = HomeConfig(api, scope, catalogReadFailed, providerNotRead, preferences = preferences),
            chat = HomeConfig(api, scope, catalogReadFailed, providerNotRead, quickChat = true),
        )
    }
}

@Composable
fun ProjectHome(
    store: SessionStore,
    api: RiffetApi?,
    /** 新建任务's project; null while there is none yet. */
    project: Project?,
    onSelectProject: (Project) -> Unit,
    /** The server's quick chat project; null hides 快速会话. */
    chatProject: Project?,
    /** 快速会话 is showing. */
    chat: Boolean,
    onChatChange: (Boolean) -> Unit,
    configs: HomeConfigs,
    /** Opens the navigation drawer: the 新会话 tab's top bar leads with it. */
    onOpenMenu: () -> Unit,
    onOpenSession: (Session) -> Unit,
    /** Opens the terminal import picker. */
    onImportSession: () -> Unit,
    /** Shows a terminal by id and title. */
    onOpenTerminal: (String, String) -> Unit,
    modifier: Modifier = Modifier,
    /** A quick chat entry's preselected mode, e.g. `preset:translate`; null is the plain 对话. */
    initialMode: String? = null,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val motion = LocalRiffetMotion.current
    val pageMotion = LocalRiffetPageMotion.current
    val reduced = rememberReducedMotion()
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val list by store.list.collectAsState()
    val scope = rememberCoroutineScope()

    // The picker is owned here rather than inside `HomeContent`, because the empty state needs the
    // same one: "add a directory" is how a phone gets its first project, not a follow-up to having
    // one. This mirrors the web, where `Workbench` owns the picker for both callers.
    var pickerOpen by remember { mutableStateOf(false) }
    var projectSheet by remember { mutableStateOf(false) }
    var binding by remember { mutableStateOf(false) }
    var bindError by remember { mutableStateOf<String?>(null) }

    /**
     * The web's `startSessionInDirectory`: bind the chosen directory — the server is idempotent per
     * canonical path, so picking an already-registered one just selects it — and land on its
     * composer. Nothing is guessed locally: the project the server returns is what gets selected.
     */
    fun chooseDirectory(path: String) {
        if (api == null || binding) return
        scope.launch {
            binding = true
            bindError = null
            try {
                val target = store.openDirectory(path)
                pickerOpen = false
                onSelectProject(target)
                onChatChange(false)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (failure: Throwable) {
                bindError = failure.message?.takeIf { it.isNotBlank() } ?: getString(Res.string.session_cannot_use_directory)
            } finally {
                binding = false
            }
        }
    }

    // Both configurations follow the server's settings while the page is up; an unchanged key reads
    // nothing, so coming back to the tab or switching modes costs no request.
    val recentChatModel = chatProject?.let { latestQuickChatModel(list.sessions, it.id) }
    LaunchedEffect(configs, project?.id, list.settings, list.backendRevision) {
        project?.let { configs.task.sync(it.id, list.settings, list.backendRevision) }
    }
    LaunchedEffect(configs, chatProject?.id, list.settings, list.backendRevision, recentChatModel) {
        chatProject?.let { configs.chat.sync(it.id, list.settings, list.backendRevision, recentChatModel) }
    }
    LaunchedEffect(configs, initialMode) { configs.chat.preselect(initialMode) }

    // 0 is 新建任务, 1 is 快速会话; a swipe drags it and the tab indicator and slot follow. Plain
    // state rather than an `Animatable`: a drag stores into it on every pointer event, which should
    // be a write, not a coroutine launched per event just to `snapTo`.
    var position by remember { mutableFloatStateOf(if (chat) 1f else 0f) }
    var dragging by remember { mutableStateOf(false) }
    val glide = remember { PositionGlide(if (chat) 1f else 0f) }
    /** Runs [position] to [target]; a release passes its fling velocity, a tab tap does not. */
    fun glideTo(target: Float, velocity: Float? = null) {
        glide.job?.cancel()
        glide.target = target
        if (!pageMotion.enabled || reduced) {
            position = target
            return
        }
        glide.job = scope.launch {
            animate(
                initialValue = position,
                targetValue = target,
                initialVelocity = velocity ?: 0f,
                animationSpec = if (velocity != null) motion.settle() else
                    tween(pageMotion.motion.pageEnter, easing = pageMotion.motion.EmphasizedDecelerate),
            ) { value, _ -> position = value }
        }
    }
    LaunchedEffect(chat) {
        val target = if (chat) 1f else 0f
        if (!dragging && glide.target != target) glideTo(target)
    }
    val latestChat by rememberUpdatedState(chat)
    val latestChatChange by rememberUpdatedState(onChatChange)
    val settlePx = with(LocalDensity.current) { ModeSettleVelocity.toPx() }

    // A Box, so the sheets emitted after the page cover the header too.
    Box(
        modifier = modifier
            .fillMaxSize()
            .appearancePageBackground(LocalRiffetSurfaces.current.page)
            // The hero composer's ring goes away the way the session screen's does: a tap on the
            // page ends its focus, a tap on the composer card is its own (`keepsFocusOnTap`).
            .blurOnTap(),
    ) {
        RiffetPageScaffold(
            modifier = Modifier.fillMaxSize(),
            topBar = {
                Column {
                    TabTopBar(title = stringResource(Res.string.session_tab_new), onOpenMenu = onOpenMenu)
                    if (chatProject != null) {
                        Box(Modifier.fillMaxWidth().padding(horizontal = metrics.pageInset), contentAlignment = Alignment.Center) {
                            HomeModeTabs(chat = chat, position = { position }, onSelect = onChatChange)
                        }
                    }
                }
            },
        ) { contentInsets ->
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    // A horizontal swipe drags between the two targets, pager-like. A swipe with
                    // nowhere to go (rightward on 新建任务) is left to the parent: the drawer.
                    .pointerInput(chatProject != null, motion, pageMotion, reduced) {
                        if (chatProject == null) return@pointerInput
                        val widthPx = size.width.toFloat().coerceAtLeast(1f)
                        awaitEachGesture {
                            val down = awaitFirstDown(requireUnconsumed = false)
                            val from = latestChat
                            var progress = if (from) 1f else 0f
                            val drag = awaitHorizontalTouchSlopOrCancellation(down.id) { change, over ->
                                if ((over < 0f && !from) || (over > 0f && from)) {
                                    progress = (progress - over / widthPx).coerceIn(0f, 1f)
                                    dragging = true
                                    // A finger on the page stops whatever was still settling.
                                    glide.job?.cancel()
                                    glide.target = Float.NaN
                                    position = progress
                                    change.consume()
                                }
                            } ?: return@awaitEachGesture
                            val tracker = VelocityTracker()
                            tracker.addPosition(drag.uptimeMillis, drag.position)
                            try {
                                horizontalDrag(drag.id) { change ->
                                    tracker.addPosition(change.uptimeMillis, change.position)
                                    progress = (progress - change.positionChange().x / widthPx).coerceIn(0f, 1f)
                                    position = progress
                                    change.consume()
                                }
                            } finally {
                                dragging = false
                            }
                            // Positive is toward 快速会话.
                            val velocity = -tracker.calculateVelocity().x
                            val toChat = when {
                                velocity > settlePx -> true
                                velocity < -settlePx -> false
                                else -> progress > 0.5f
                            }
                            glideTo(if (toChat) 1f else 0f, velocity = velocity / widthPx)
                            if (toChat != from) latestChatChange(toChat)
                        }
                    },
            ) {
                // What the composer was last showing: while it fades out after the project is gone,
                // it still has something to draw.
                val last = remember { arrayOfNulls<Pair<Boolean, Project>>(1) }
                (if (chat) chatProject else project)?.let { last[0] = chat to it }
                // The empty state and the composer replace each other in place (loading, then the
                // first project, then the composer); the composer's sheets overflow this box over the
                // system bars, so no size transform and no clip.
                AnimatedContent(
                    targetState = !chat && project == null,
                    transitionSpec = { pageMotion.transition() using null },
                    label = "homeContent",
                ) { empty ->
                    if (empty) {
                        HomeEmptyState(
                            loaded = list.loaded,
                            error = list.error,
                            canAdd = api != null,
                            onAdd = {
                                bindError = null
                                pickerOpen = true
                            },
                            onRefresh = { store.refresh() },
                            contentPadding = contentInsets,
                        )
                    } else {
                        val (shownChat, shownTarget) = last[0]!!
                        HomeContent(
                            store = store,
                            api = api,
                            target = shownTarget,
                            chat = shownChat,
                            config = if (shownChat) configs.chat else configs.task,
                            slot = {
                                HomeSlot(
                                    position = { position },
                                    task = { if (project != null) ProjectContext(project, onClick = { projectSheet = true }) },
                                    chat = {
                                        val modes = quickChatModes(list.settings, configs.chat.capabilities?.modes)
                                        if (modes.size > 1) {
                                            QuickChatModeChips(
                                                options = modes,
                                                value = configs.chat.mode,
                                                onSelect = { configs.chat.mode = it },
                                            )
                                        }
                                    },
                                )
                            },
                            onOpenSession = onOpenSession,
                            onImport = if (api != null) onImportSession else null,
                            onOpenTerminal = onOpenTerminal,
                            contentPadding = contentInsets,
                        )
                    }
                }
            }
        }

        if (projectSheet && project != null) {
            ProjectPickerSheet(
                projects = list.projects.filter { it.archivedAt == null && !it.isQuickChat && it.system != "task-workspace" },
                selectedId = project.id,
                onSelect = { picked -> if (picked != null && picked.id != project.id) onSelectProject(picked) },
                onDismiss = { projectSheet = false },
                onChooseDirectory = if (api != null) ({
                    bindError = null
                    pickerOpen = true
                }) else null,
            )
        }

        if (pickerOpen && api != null) {
            DirectoryPickerSheet(
                api = api,
                initialPath = project?.cwd,
                busy = binding,
                error = bindError,
                onDismiss = { pickerOpen = false },
                onPick = ::chooseDirectory,
            )
        }
    }
}

/**
 * 快速会话's modes for the chips: 对话 and the presets. They come from the settings the list already
 * holds (the server returns the effective presets in `GET /api/settings`), so they show before the
 * chat catalog answers; a server that predates presets falls back to the catalog's modes.
 */
@Composable
private fun quickChatModes(settings: riffet.contracts.AppSettings?, catalog: List<NativeBackendOption>?): List<NativeBackendOption> {
    val presets = settings?.quickChat?.presets ?: return catalog.orEmpty()
    val plain = stringResource(Res.string.session_quick_chat_plain)
    return remember(presets, plain) {
        listOf(NativeBackendOption(QUICK_CHAT_PLAIN_MODE, plain)) +
            presets.map { NativeBackendOption("$QUICK_CHAT_PRESET_MODE${it.id}", it.name, it.prompt) }
    }
}

/** The chat backend's plain mode and its preset prefix (`backends/chat` on the server). */
private const val QUICK_CHAT_PLAIN_MODE = "agent"
private const val QUICK_CHAT_PRESET_MODE = "preset:"

/** The slot above the composer reserves the same height in both modes. */
private val SlotHeight = 48.dp

/** The slot above the composer follows the global page motion at the current swipe [position]. */
@Composable
private fun HomeSlot(position: () -> Float, task: @Composable () -> Unit, chat: @Composable () -> Unit) {
    val pageMotion = LocalRiffetPageMotion.current
    val taskShown by remember { derivedStateOf { position() < 1f } }
    val chatShown by remember { derivedStateOf { position() > 0f } }
    Box(Modifier.fillMaxWidth().height(SlotHeight), contentAlignment = Alignment.CenterStart) {
        if (taskShown) {
            Box(Modifier.graphicsLayer {
                val progress = position()
                alpha = if (pageMotion.enabled) pageMotion.alpha(progress) else if (progress < 0.5f) 1f else 0f
                translationX = -pageMotion.translation(progress, size.width)
                scaleX = pageMotion.scale(progress)
                scaleY = scaleX
            }) { task() }
        }
        if (chatShown) {
            Box(Modifier.fillMaxWidth().graphicsLayer {
                val progress = 1f - position()
                alpha = if (pageMotion.enabled) pageMotion.alpha(progress) else if (progress <= 0.5f) 1f else 0f
                translationX = pageMotion.translation(progress, size.width)
                scaleX = pageMotion.scale(progress)
                scaleY = scaleX
            }, contentAlignment = Alignment.CenterStart) { chat() }
        }
    }
}

/**
 * Where the task starts, as the line the composer hangs from: the directory's name, where it lives,
 * and a chevron to the project sheet. Text, not a chip: it is context first and a control second.
 */
@Composable
private fun ProjectContext(project: Project, onClick: () -> Unit) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    Row(verticalAlignment = Alignment.CenterVertically) {
        Row(
            modifier = Modifier
                .weight(1f, fill = false)
                .height(metrics.controlHeight)
                .clip(RoundedCornerShape(LocalInterfaceStyle.current.controlRadius))
                .clickable(onClickLabel = stringResource(Res.string.session_switch_project), role = Role.Button, onClick = onClick)
                .padding(horizontal = metrics.controlInset),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(metrics.controlInset / 2),
        ) {
            Icon(RiffetIcons.Folder, contentDescription = null, tint = colors.fg2, modifier = Modifier.size(metrics.smallIconSize))
            Text(project.name, style = typography.headline, color = colors.fg, maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false))
        }
    }
}

/** No project yet: the way to the first one. */
@Composable
private fun HomeEmptyState(loaded: Boolean, error: String?, canAdd: Boolean, onAdd: () -> Unit, onRefresh: () -> Unit, contentPadding: PaddingValues = PaddingValues()) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    Column(
        modifier = Modifier.fillMaxSize().padding(contentPadding).padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Spacer(Modifier.height(64.dp))
        Icon(RiffetIcons.Folder, contentDescription = null, tint = colors.fg3, modifier = Modifier.size(28.dp))
        Spacer(Modifier.height(14.dp))
        Text(
            text = if (loaded) stringResource(Res.string.session_no_directory) else stringResource(Res.string.session_loading_projects),
            style = typography.title,
            color = colors.fg,
        )
        if (loaded) {
            error?.let { failure ->
                Spacer(Modifier.height(8.dp))
                Text(text = failure, style = typography.bodySmall, color = colors.fg3, textAlign = TextAlign.Center)
            }
            Spacer(Modifier.height(16.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                HomeActionButton(label = stringResource(Res.string.session_add_directory), enabled = canAdd, primary = true, onClick = onAdd)
                HomeActionButton(label = stringResource(Res.string.session_refresh), enabled = true, primary = false, onClick = onRefresh)
            }
        }
    }
}

/**
 * A home-screen action. It is the same shape as the settings screens' button — this app has one
 * button treatment, and two files drawing it slightly differently is how a design system drifts.
 */
@Composable
internal fun HomeActionButton(
    label: String,
    onClick: () -> Unit,
    enabled: Boolean = true,
    primary: Boolean = false,
) {
    riffet.ui.design.RiffetButton(label, onClick, enabled, primary)
}

/**
 * Centred launch targets use the current theme's segmented or underline variant.
 * Both variants preserve the same task/chat state and swipe-driven page position.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun HomeModeTabs(chat: Boolean, position: () -> Float, onSelect: (Boolean) -> Unit) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val taskLabel = stringResource(Res.string.session_mode_task)
    val chatLabel = stringResource(Res.string.session_mode_chat)
    val style = LocalInterfaceStyle.current
    val labelStyle = typography.segmented
    val textMeasurer = rememberTextMeasurer()
    // Size the group to both labels plus Material Tab's 16dp padding on each side.
    // The parent centres the whole group; larger fonts and translated labels keep their width.
    // The native Material text-tab API supplies 16dp on each side; its padding cannot be
    // changed by controlInset. Reserve that actual width so translated/scaled labels do not scroll.
    val tabPadding = if ((style.components.navigation.tabs == riffet.ui.design.ComponentBackend.MATERIAL) && style.variants.homeTabs == riffet.ui.design.HomeTabPresentation.UNDERLINE) 16.dp else metrics.controlInset
    val groupWidth = with(LocalDensity.current) {
        (textMeasurer.measure(taskLabel, labelStyle, maxLines = 1).size.width +
            textMeasurer.measure(chatLabel, labelStyle, maxLines = 1).size.width).toDp() + tabPadding * 4
    }
    if (style.variants.homeTabs == riffet.ui.design.HomeTabPresentation.SEGMENTED) {
        riffet.ui.design.SegmentedControl(
            options = listOf(taskLabel, chatLabel), selected = if (chat) 1 else 0,
            onSelect = { onSelect(it == 1) }, modifier = Modifier.width(groupWidth),
        )
        return
    }
    if (!(style.components.navigation.tabs == riffet.ui.design.ComponentBackend.MATERIAL)) {
        val surfaces = LocalRiffetSurfaces.current
        val density = LocalDensity.current
        val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl
        val taskWidth = with(density) { textMeasurer.measure(taskLabel, labelStyle, maxLines = 1).size.width.toDp() }
        val chatWidth = with(density) { textMeasurer.measure(chatLabel, labelStyle, maxLines = 1).size.width.toDp() }
        Row(
            Modifier.width(groupWidth).height(metrics.controlHeight).selectableGroup().drawBehind {
                val fraction = position().coerceIn(0f, 1f)
                val width = lerp(taskWidth, chatWidth, fraction).toPx()
                val taskCenter = (taskWidth / 2 + metrics.controlInset).toPx()
                val chatCenter = (taskWidth + chatWidth / 2 + metrics.controlInset * 3).toPx()
                val logicalCenter = taskCenter + (chatCenter - taskCenter) * fraction
                val center = if (rtl) size.width - logicalCenter else logicalCenter
                drawLine(colors.accent, Offset(center - width / 2, size.height - 1.dp.toPx()),
                    Offset(center + width / 2, size.height - 1.dp.toPx()), strokeWidth = 2.dp.toPx())
            },
        ) {
            listOf(taskLabel, chatLabel).forEachIndexed { index, label ->
                val selected = chat == (index == 1)
                val source = remember { MutableInteractionSource() }
                val focused by source.collectIsFocusedAsState()
                val shape = RoundedCornerShape(style.controlRadius)
                Box(
                    Modifier.width((if (index == 0) taskWidth else chatWidth) + metrics.controlInset * 2)
                        .fillMaxHeight().pressScale(source).clip(shape)
                        .then(if (focused) Modifier.border(metrics.focusWidth, surfaces.focus, shape) else Modifier)
                        .selectable(selected, interactionSource = source, indication = LocalIndication.current,
                            role = Role.Tab, onClick = { onSelect(index == 1) }),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(label, style = labelStyle, color = if (selected) colors.accent else colors.fg2, maxLines = 1)
                }
            }
        }
        return
    }
    PrimaryScrollableTabRow(
        modifier = Modifier.width(groupWidth),
        edgePadding = 0.dp,
        minTabWidth = 0.dp,
        selectedTabIndex = if (chat) 1 else 0,
        containerColor = if (materialBackdropEnabled) Color.Transparent else LocalRiffetSurfaces.current.page,
        divider = {},
        indicator = {
            TabRowDefaults.PrimaryIndicator(
                width = Dp.Unspecified,
                height = 2.dp,
                modifier = Modifier.tabIndicatorLayout { measurable, constraints, tabs ->
                    if (tabs.size < 2) return@tabIndicatorLayout layout(0, 0) {}
                    val fraction = position()
                    val width = lerp(tabs[0].contentWidth, tabs[1].contentWidth, fraction).roundToPx()
                    val center = lerp(tabs[0].left + tabs[0].width / 2, tabs[1].left + tabs[1].width / 2, fraction).roundToPx()
                    val placeable = measurable.measure(constraints.copy(minWidth = width, maxWidth = width))
                    // ScrollableTabRow centres this layout inside the selected tab before placing it.
                    // Remove that parent inset so the interpolated centre stays under the text.
                    val selectedWidth = tabs[if (chat) 1 else 0].width.roundToPx()
                    val parentInset = ((selectedWidth - constraints.maxWidth) / 2).coerceAtLeast(0)
                    layout(constraints.maxWidth, placeable.height) {
                        placeable.placeRelative(center - width / 2 - parentInset, 0)
                    }
                },
            )
        },
    ) {
        val selected = MaterialTheme.colorScheme.primary
        val unselected = MaterialTheme.colorScheme.onSurfaceVariant
        Tab(selected = !chat, onClick = { onSelect(false) }, selectedContentColor = selected, unselectedContentColor = unselected,
            text = { Text(taskLabel, style = labelStyle, maxLines = 1) })
        Tab(selected = chat, onClick = { onSelect(true) }, selectedContentColor = selected, unselectedContentColor = unselected,
            text = { Text(chatLabel, style = labelStyle, maxLines = 1) })
    }
}

/** The mark's size when the page has room for it, and the room below which it gives way. */
private val HomeMarkSize = 104.dp
private val HomeMarkMinRoom = 56.dp

/** One of the terminal tools under the composer, as on web: an icon tile and a name. */
@Composable
private fun HomeToolCard(icon: ImageVector, title: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val style = LocalInterfaceStyle.current
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val shape = RoundedCornerShape(style.controlRadius)
    Row(
        modifier = modifier
            .clip(shape)
            .background(colors.bgElevated)
            .border(style.metrics.hairlineWidth, colors.line, shape)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(
            Modifier.size(24.dp).clip(RoundedCornerShape(style.metrics.iconTileRadius)).background(colors.bgMuted),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, contentDescription = null, tint = colors.fg2, modifier = Modifier.size(style.metrics.smallIconSize))
        }
        Text(title, style = typography.caption, color = colors.fg, maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f))
    }
}

/**
 * The page's three bands: the living mark, the form (the line and the composer) and what hangs under
 * it. The form is centred in [viewport], the height the page is shown in, less [verticalPadding], on
 * its own, so it stays put across 新建任务 and 快速对话; the mark takes the room above it. A page taller than the viewport scrolls.
 * The keyboard folds the mark away; its height and the sizes are read in the layout pass only, so
 * none of it recomposes.
 */
@Composable
private fun HomeBands(
    viewport: IntState,
    verticalPadding: Dp,
    mark: @Composable () -> Unit,
    form: @Composable () -> Unit,
    tools: @Composable () -> Unit,
) {
    val ime = WindowInsets.ime
    // Each band is one child even when it draws nothing, so the three are always there to measure.
    Layout(content = { Box { mark() }; Box { form() }; Box { tools() } }, modifier = Modifier.fillMaxWidth()) { measurables, constraints ->
        val loose = constraints.copy(minWidth = constraints.maxWidth, minHeight = 0, maxHeight = Constraints.Infinity)
        val form = measurables[1].measure(loose)
        val tools = measurables[2].measure(loose)
        val avail = (viewport.intValue - verticalPadding.roundToPx()).coerceAtLeast(0)
        val edge = 8.dp.roundToPx()
        // The form alone decides where it sits, so what hangs below (it differs by mode) never moves it.
        val top = maxOf((avail - form.height) / 2, edge)
        val room = top - 2 * edge
        val folded = (1f - ime.getBottom(this) / (HomeMarkSize.roundToPx() * 1.2f)).coerceIn(0f, 1f)
        val size = if (room < HomeMarkMinRoom.roundToPx()) 0 else minOf(HomeMarkSize.roundToPx(), room)
        val shown = (size * folded).toInt()
        val mark = measurables[0].measure(Constraints.fixed(shown, shown))
        val height = maxOf(avail, top + form.height + tools.height)
        layout(constraints.maxWidth, height) {
            mark.placeRelativeWithLayer((constraints.maxWidth - shown) / 2, (top - shown) / 2) { alpha = folded }
            form.placeRelative(0, top)
            tools.placeRelative(0, top + form.height)
        }
    }
}

@Composable
private fun HomeContent(
    store: SessionStore,
    api: RiffetApi?,
    /** The project the next session starts in: the task project, or the quick chat one. */
    target: Project,
    chat: Boolean,
    config: HomeConfig,
    /** Above the composer: where the session starts (the directory, or the quick chat mode). */
    slot: @Composable () -> Unit,
    onOpenSession: (Session) -> Unit,
    /** Continue a terminal conversation; null where the server cannot import. */
    onImport: (() -> Unit)?,
    /** Shows a terminal by id and title. */
    onOpenTerminal: (String, String) -> Unit,
    contentPadding: PaddingValues = PaddingValues(),
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val motion = LocalRiffetMotion.current
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val list by store.list.collectAsState()
    val scope = rememberCoroutineScope()

    val drafts = LocalComposerDrafts.current
    val draft = remember(drafts) { drafts?.draftFor(HOME_DRAFT_ID) ?: ComposerDraft() }
    var text by draft.text
    var attachments by draft.attachments
    var references by draft.references
    SideEffect { drafts?.save(HOME_DRAFT_ID, draft) }
    DisposableEffect(drafts) {
        onDispose { drafts?.save(HOME_DRAFT_ID, draft) }
    }
    var thumbnails by remember { mutableStateOf<Map<String, ImageBitmap>>(emptyMap()) }
    var uploading by remember { mutableStateOf(false) }
    var creating by remember { mutableStateOf(false) }
    // An error belongs to the target it came from.
    var error by remember(chat) { mutableStateOf<String?>(null) }
    // The project's running shell if it has one, as the iPhone's terminal page opens; otherwise a new one.
    fun openShell() {
        val client = api ?: return
        scope.launch {
            runCatching {
                client.terminals().firstOrNull { it.projectId == target.id && it.kind == TerminalKind.SHELL && it.state != TerminalState.EXITED }
                    ?: client.createShellTerminal(target.id)
            }.onSuccess { onOpenTerminal(it.id, it.title) }
                .onFailure { failure -> if (failure is CancellationException) throw failure else error = failure.message }
        }
    }
    // One sheet for the settings → agent / model / mode / tools hop: the scrim and the sheet stay up
    // and only the page changes, so the pickers never tear down and remount.
    var sheet by remember { mutableStateOf<HomeSheet?>(null) }
    val catalogReady = config.capabilities != null
    // The phones the agent may control: offered only where the backend takes tools and there is a phone to pick.
    val toolsSupported = !chat && config.capabilities?.supportsRiffetTools == true
    val toolDevices = rememberToolDevices(api, enabled = toolsSupported)
    val pickedTools = offeredPicks(toolDevices, config.toolGroups)
    val phonesShown = toolsSupported && toolsOffered(toolDevices, emptyList())
    // MCP servers and Skills switched off for this conversation only; a new one starts with everything on.
    var extensionsOff by remember(config.backendId, config.profileId, target.id) { mutableStateOf(emptyList<String>()) }
    val extensions = extensionsPick(
        api, allowed = !chat, capabilities = config.capabilities, backendId = config.backendId, profileId = config.profileId,
        projectId = target.id, off = extensionsOff, onChange = { extensionsOff = ExtensionsOff.clean(it) },
    )
    // Nothing to switch, nothing to show: the row waits only on a list it cannot read yet.
    val extensionsListed = rememberExtensionsListed(extensions)
    val toolsShown = phonesShown || (extensions != null && extensionsListed != false)
    LaunchedEffect(config, target.id, config.backendId, config.profileId, catalogReady) {
        if (catalogReady) config.loadSlash(target.id)
    }

    val attachmentUploadingNotice = stringResource(Res.string.session_attachment_uploading)
    val picker = rememberAttachmentPicker(onError = { error = it }) { picked ->
        if (picked.isEmpty()) return@rememberAttachmentPicker
        if (uploading) { error = attachmentUploadingNotice; return@rememberAttachmentPicker }
        attachmentIntakeError(picked, attachments.size)?.let { failure ->
            scope.launch {
                error = when (failure) {
                    is AttachmentIntakeError.TooMany -> getString(Res.string.composer_attachments_limit, failure.limit)
                    is AttachmentIntakeError.TooLarge -> getString(Res.string.composer_attachment_too_large, failure.name)
                }
            }
            return@rememberAttachmentPicker
        }
        val uploadProject = target.id
        scope.launch {
            uploading = true
            error = null
            try {
                val uploaded = picked.map { store.uploadAttachment(it, uploadProject) }
                attachments = attachments + uploaded
                picked.zip(uploaded).forEach { (item, attachment) ->
                    item.thumbnail?.let { thumbnails = thumbnails + (attachment.id to it) }
                }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (failure: Throwable) {
                error = failure.message ?: getString(Res.string.session_attachment_upload_failed)
            } finally {
                drafts?.save(HOME_DRAFT_ID, draft)
                uploading = false
            }
        }
    }

    fun create() {
        val prompt = text.trim()
        if (prompt.isEmpty() || creating || uploading) return
        creating = true
        error = null
        scope.launch {
            try {
                val session = store.createSession(
                    projectId = target.id,
                    prompt = prompt,
                    attachments = attachments,
                    backendId = if (chat) NativeBackendId.CHAT else config.backendId,
                    backendProfileId = if (chat) null else config.profileId,
                    model = if (chat) config.model.takeIf { it.isNotBlank() } else config.model,
                    mode = config.mode,
                    approval = if (chat) null else config.approval,
                    context = references,
                    agentId = null,
                    toolGroups = if (phonesShown) pickedTools else null,
                    extensionsOff = extensionsOff.takeIf { extensions != null && it.isNotEmpty() },
                )
                text = ""
                attachments = emptyList()
                references = emptyList()
                thumbnails = emptyMap()
                drafts?.save(HOME_DRAFT_ID, draft)
                onOpenSession(session)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (failure: Throwable) {
                error = failure.message?.takeIf { it.isNotBlank() } ?: getString(Res.string.session_create_session_failed)
            } finally {
                creating = false
            }
        }
    }

    val modelSummary = modelSelectionSummary(config.catalog, config.model).ifEmpty { config.model.ifEmpty { stringResource(Res.string.session_default_model) } }
    val referenceLimitText = stringResource(Res.string.session_reference_limit)
    val providerGroups = config.providerGroups()
    val providerName = providerGroups.firstOrNull { it.profileId == config.profileId }?.name
    val modelText = if (providerName.isNullOrBlank()) modelSummary else "$providerName · $modelSummary"
    val caps = config.capabilities
    val controlsEnabled = api != null && !creating
    // What the composer's model chip opens.
    val rows = buildList {
        if (!chat && config.backends.size > 1) {
            val mark = config.backendId.name.lowercase()
            add(SendSettingRow(label = "Agent", value = backendName(config.backendId), icon = AgentMarks.vector(mark),
                iconTint = if (mark == "codex") Color.Unspecified else null) { sheet = HomeSheet.Agent })
        }
        if (!chat) caps?.modes?.takeIf { it.size > 1 }?.let { modes ->
            add(SendSettingRow(label = stringResource(Res.string.session_mode), value = optionLabelOf(modes, config.mode, stringResource(Res.string.session_mode))) { sheet = HomeSheet.Mode })
        }
        if (!chat) caps?.permissions?.takeIf { it.isNotEmpty() }?.let { permissions ->
            add(SendSettingRow(label = stringResource(Res.string.session_permission), value = optionLabelOf(permissions, config.approval, stringResource(Res.string.pickers_approval_title)), icon = approvalIcon(config.approval)) { sheet = HomeSheet.Approval })
        }
        add(SendSettingRow(label = stringResource(Res.string.session_model), value = modelText, loading = config.catalogLoading, error = config.catalogError != null) { sheet = HomeSheet.Model })
        if (toolsShown) {
            add(SendSettingRow(label = stringResource(Res.string.pickers_tools_title), value = toolsSummary(pickedTools, if (extensions != null) extensionsOff else emptyList(), switches = extensions != null), icon = RiffetIcons.Puzzle) { sheet = HomeSheet.Tools })
        }
    }
    // With the model as the only row, the chip goes straight to the model list.
    val rooted = rows.size > 1
    val agentMark = config.backendId.name.lowercase()

    // The viewport's height, written by the layout above the scroll and read only while the bands
    // inside it measure: a new height remeasures them, and composition never reads it.
    val viewport = remember { mutableIntStateOf(0) }
    val topPadding = contentPadding.calculateTopPadding()
    val bottomPadding = contentPadding.calculateBottomPadding() + LocalTabContentBottomPadding.current
    Box(
        Modifier.fillMaxSize().layout { measurable, constraints ->
            viewport.intValue = constraints.maxHeight
            val placeable = measurable.measure(constraints)
            layout(placeable.width, placeable.height) { placeable.place(0, 0) }
        }.verticalScroll(rememberScrollState())
            .padding(start = metrics.pageInset, end = metrics.pageInset)
            .padding(top = topPadding, bottom = bottomPadding),
    ) {
        HomeBands(
            viewport = viewport,
            verticalPadding = topPadding + bottomPadding,
            mark = { LiveBrandMark(modifier = Modifier.fillMaxSize(), fg = colors.fg, accent = colors.accent) },
            tools = {
                Column {
                    Spacer(Modifier.height(10.dp))
                    if (chat) {
                        val modes = quickChatModes(list.settings, config.capabilities?.modes)
                        if (modes.any { it.id == config.mode && it.id != QUICK_CHAT_PLAIN_MODE && !it.description.isNullOrBlank() }) {
                            QuickChatPresetPrompt(options = modes, value = config.mode)
                            Spacer(Modifier.height(10.dp))
                        }
                    }
                    // Keep the last message during its exit animation.
                    val shownError = remember { arrayOfNulls<String>(1) }
                    if (error != null) shownError[0] = error
                    val shownText = shownError[0].orEmpty()
                    AnimatedVisibility(visible = error != null, enter = motion.expandIn(), exit = motion.collapseOut()) {
                        Column {
                            Text(text = shownText, style = typography.caption, color = colors.danger, modifier = Modifier.padding(horizontal = 4.dp))
                            Spacer(Modifier.height(8.dp))
                        }
                    }
                    if (!chat && onImport != null) {
                        Row(Modifier.padding(top = 2.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            HomeToolCard(RiffetIcons.Terminal, stringResource(Res.string.session_terminal), ::openShell, Modifier.weight(1f))
                            HomeToolCard(RiffetIcons.Clock, stringResource(Res.string.external_import_action), onImport, Modifier.weight(1f))
                        }
                    }
                }
            },
            form = {
                Column {
                    slot()
                    Spacer(Modifier.height(metrics.controlInset / 2))
                    ComposerCard(
                        text = text,
                        onTextChange = { text = it },
                        placeholder = if (chat) stringResource(Res.string.composer_placeholder_online) else stringResource(Res.string.session_task_placeholder),
                        attachments = attachments,
                        thumbnails = thumbnails,
                        uploading = uploading,
                        onRemoveAttachment = { id ->
                            attachments = attachments.filterNot { it.id == id }
                            thumbnails = thumbnails - id
                        },
                        onAttach = if (picker.available) ({ picker.launch() }) else null,
                        settings = ComposerSettings(
                            label = modelSummary,
                            icon = if (chat) RiffetIcons.Message else AgentMarks.vector(agentMark) ?: RiffetIcons.Bot,
                            iconTint = if (!chat && agentMark == "codex") Color.Unspecified else null,
                            enabled = controlsEnabled,
                            onOpen = { sheet = if (rooted) HomeSheet.Settings else HomeSheet.Model },
                            loading = config.catalogLoading,
                            error = config.catalogError != null,
                        ),
                        sendEnabled = api != null && text.isNotBlank() && !uploading && !creating && !config.catalogLoading,
                        sendBusy = creating,
                        onSend = ::create,
                        hero = true,
                        heroMinLines = 4,
                        slash = config.slash,
                        sessionCandidates = if (!chat && config.capabilities?.supportsSessionReferences == true) list.sessions else emptyList(),
                        sessionProjects = list.projects,
                        referenceProjectId = target.id,
                        sessionReferences = references.filter { it.kind == "session" },
                        onReferenceSession = if (!chat && config.capabilities?.supportsSessionReferences == true) ({ selected ->
                            if (references.count { it.kind == "session" } >= 5) error = referenceLimitText
                            else if (references.none { it.sessionId == selected.id }) references = references + sessionReference(selected)
                        }) else null,
                        onOpenSessionReference = { reference ->
                            drafts?.save(HOME_DRAFT_ID, draft)
                            list.sessions.firstOrNull { it.id == reference.sessionId }?.let(onOpenSession)
                        },
                        onRemoveSessionReference = { reference -> references = references - reference },
                    )
                }
            },
        )
    }

    sheet?.let { page ->
        // A pick applies its choice first and the sheet then slides away on its own
        // (`PickerHost.dismiss`), so nothing below closes the sheet by hand.
        PickerSheet(page = page, onDismiss = { sheet = null }, depth = { if (it == HomeSheet.Settings) 0 else 1 }) { shown ->
            // A page reached from the settings list steps back to it; one opened straight from the composer closes.
            val back: (() -> Unit)? = if (rooted) ({ sheet = HomeSheet.Settings }) else null
            when (shown) {
                HomeSheet.Settings -> SendSettingsPage(
                    notice = config.catalogError?.let { stringResource(Res.string.pickers_catalog_failed, it) },
                    noticeKind = SettingsNoticeKind.ERROR,
                    noticeAction = stringResource(Res.string.pickers_retry) to { config.load(target.id, list.settings, force = true) },
                    rows = rows,
                )
                HomeSheet.Agent -> {
                    val host = LocalPickerHost.current
                    PickerPage(title = "Agent", onBack = back) {
                        Column(modifier = Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(bottom = 16.dp)) {
                            config.backends.forEach { entry ->
                                OptionRow(
                                    label = entry.label.ifBlank { backendName(entry.backendId) },
                                    icon = AgentMarks.vector(entry.backendId.name.lowercase()),
                                    iconTint = if (entry.backendId.name.lowercase() == "codex") Color.Unspecified else null,
                                    description = entry.reason?.takeIf { !entry.available },
                                    selected = entry.backendId == config.backendId,
                                    onClick = {
                                        config.selectBackend(entry.backendId, target.id, list.settings)
                                        host?.dismiss?.invoke()
                                    },
                                    disabledReason = if (entry.available) null else (entry.reason ?: stringResource(Res.string.session_provider_unavailable)),
                                )
                            }
                        }
                    }
                }
                HomeSheet.Model -> ModelPickerPages(
                    catalog = config.catalog,
                    catalogLoading = config.catalogLoading,
                    catalogError = config.catalogError,
                    selection = config.model,
                    switching = false,
                    disabledReason = null,
                    onSelect = { config.model = it },
                    onParamChange = { config.model = it },
                    onRetryCatalog = { config.load(target.id, list.settings, force = true) },
                    loadUsage = config.usageLoader(target.id),
                    groups = providerGroups,
                    activeProfileId = config.profileId,
                    usageScopeKey = "${config.backendId}|${target.id}|${config.profileId ?: ""}",
                    onSelectChoice = { profileId, selection -> config.selectProviderModel(profileId, selection) },
                    onRetryGroup = { profileId -> config.retryProviderCatalog(target.id, profileId) },
                    showSubtitle = !chat,
                    onBack = back,
                )
                HomeSheet.Mode -> caps?.let {
                    ModePickerPage(
                        options = it.modes,
                        value = config.mode,
                        currentLabel = optionLabelOf(it.modes, config.mode, stringResource(Res.string.session_mode)),
                        disabledReason = null,
                        onSelect = { mode -> config.mode = mode },
                        onBack = back,
                    )
                }
                HomeSheet.Tools -> ToolsPickerPage(
                    value = pickedTools,
                    devices = toolDevices,
                    onChange = { config.pickToolGroups(it) },
                    extensions = extensions,
                    enabled = api != null,
                    onBack = back,
                )
                HomeSheet.Approval -> caps?.let {
                    ApprovalPickerPage(
                        options = it.permissions,
                        value = config.approval,
                        currentLabel = optionLabelOf(it.permissions, config.approval, stringResource(Res.string.pickers_approval_title)),
                        disabledReason = null,
                        onSelect = { approval -> config.approval = approval },
                    )
                }
            }
        }
    }
}

/** The pages of the composer's one settings sheet; Settings is the root, the rest are one step deeper. */
private enum class HomeSheet { Settings, Agent, Model, Mode, Approval, Tools }

/** Where the page-to-page glide is headed, so a tab change does not restart one a swipe already started. */
private class PositionGlide(var target: Float) {
    var job: Job? = null
}

/** The web's `tildePath`, also covering Linux homes (`/home/x`, `/<mount>/home/x`, `/root`). */
internal fun tildePath(path: String): String =
    path.replace(Regex("^(/Users/[^/]+|(/[^/]+)?/home/[^/]+|/root)(?=/|$)"), "~")

/**
 * One provider's catalog, as loaded for the new-session model picker.
 *
 * [error] is a failed read. The other providers still list, and this one can be retried on its own.
 */
/** The model of the most recently active quick chat in [projectId], by activity rather than list order. */
internal fun latestQuickChatModel(sessions: List<Session>, projectId: String): String? =
    sessions.filter { it.projectId == projectId && it.backendId == NativeBackendId.CHAT && !it.model.isNullOrBlank() }
        .maxByOrNull { instantMillis(activityAt(it)) ?: 0L }?.model

internal data class ProviderCatalog(
    val profile: NativeBackendProfile,
    val models: List<ModelInfo>,
    val available: Boolean,
    val reason: String?,
    val error: String?,
    /** The provider's whole catalog entry; its capabilities replace the composer's when it is picked. */
    val entry: NativeBackendCatalogEntry? = null,
)

/**
 * The home composer's run configuration: which CLI, profile, model, mode and permission the next
 * session starts with. Defaults come from the server's saved settings, the same precedence as the
 * web's `ProjectHome` (saved backend defaults, then the global default model for Cursor's default
 * profile, then the backend's own default).
 *
 * When the agent has several providers, each one's catalog is loaded and the model sheet groups by
 * provider. Picking a model from another provider points the next session at that provider. The
 * choice stays on this composer, the same way a model draft does; it does not rewrite the saved
 * default. An open session keeps the provider it was created with.
 */
internal class HomeConfig(
    private val api: RiffetApi?,
    private val scope: kotlinx.coroutines.CoroutineScope,
    private val catalogReadFailed: String = "",
    private val providerNotRead: String = "",
    /** The quick chat composer: one backend, one catalog, no provider or approval choices. */
    private val quickChat: Boolean = false,
    /** A quick chat entry's preselected mode, e.g. `preset:translate`. */
    private var initialMode: String? = null,
    /** Keeps the last tool pick, so the next new conversation starts from it. */
    private val preferences: AppPreferences? = null,
) {
    /** The phones the next session may control: what the last one on this device was given, read before the first frame. */
    var toolGroups by mutableStateOf(ToolGroups.decode(preferences?.string(PreferenceKeys.TOOL_GROUPS)))
        private set

    fun pickToolGroups(groups: List<String>) {
        toolGroups = ToolGroups.phones(groups)
        preferences?.setString(PreferenceKeys.TOOL_GROUPS, ToolGroups.encode(groups))
    }

    var backends by mutableStateOf<List<NativeBackendCatalogEntry>>(emptyList())
    var backendId by mutableStateOf(if (quickChat) NativeBackendId.CHAT else NativeBackendId.CURSOR)
    var catalog by mutableStateOf<List<ModelInfo>>(emptyList())
    var capabilities by mutableStateOf<NativeBackendCapabilities?>(null)
    var catalogLoading by mutableStateOf(false)
    var catalogError by mutableStateOf<String?>(null)

    /** The reader's own picks; the defaults are never written into them, see [NewSessionDraft]. */
    private var picks by mutableStateOf(NewSessionDraft(mode = initialMode))
    private var picksBackend: NativeBackendId? = null
    private var choice by mutableStateOf(NewSessionChoice(null, "", null, null))
    private var source: NativeBackendCatalogEntry? = null
    private var listed: NativeBackendCatalogEntry? = null
    private var settings: riffet.contracts.AppSettings? = null

    val profileId: String? get() = choice.profileId
    var model: String
        get() = choice.model
        set(value) = pick(picks.copy(model = value))
    var mode: String
        get() = choice.mode ?: "agent"
        set(value) = pick(picks.copy(mode = value))
    var approval: String
        get() = choice.approval ?: ""
        set(value) = pick(picks.copy(approval = value))

    private fun pick(next: NewSessionDraft) {
        picks = next
        settle()
    }

    /** Resolves the picks against the loaded catalog: a pick it still offers stays, the rest follow the defaults. */
    private fun settle() {
        val catalog = source
        // Without a saved default, a new quick chat continues with the latest chat's model and switches.
        val recent = recentModel.takeIf { quickChat && settings?.auxiliaryModels?.chat == null && picks.model == null }
        val draft = if (recent != null) picks.copy(model = recent) else picks
        choice = if (catalog != null) draft.resolve(catalog, settings?.nativeBackendDefaults?.get(catalog.backendId), settings?.defaultModel, listed)
        else NewSessionChoice(picks.profileId, picks.model.orEmpty(), picks.mode, picks.approval)
    }

    private var recentModel: String? = null

    private var loadedKey: String? = null

    /** What one successful read left on screen, kept per key so coming back to it applies at once. */
    private class LoadedConfig(
        val backends: List<NativeBackendCatalogEntry>,
        val catalog: NativeBackendCatalogEntry,
        val listed: NativeBackendCatalogEntry?,
        val profiles: List<NativeBackendProfile>,
        val providerCatalogs: List<ProviderCatalog>,
    )
    private val loadedConfigs = mutableMapOf<String, LoadedConfig>()

    /** The profile is part of the key: a read answers for the provider the picks asked for. */
    private fun cacheKey(key: String) = "$key|${picks.profileId.orEmpty()}"

    /** Shows a remembered read in the same pass; the caller still reads again without a loading state. */
    private fun apply(cached: LoadedConfig, settings: riffet.contracts.AppSettings?) {
        backends = cached.backends
        catalog = cached.catalog.models
        capabilities = cached.catalog.capabilities
        source = cached.catalog
        listed = cached.listed
        this.settings = settings
        catalogError = null
        settle()
        knownProfiles = cached.profiles
        providerCatalogs = cached.providerCatalogs
    }
    private var loadedBackend: NativeBackendId? = null
    private var userChoseBackend = false
    private var defaultBackendId: NativeBackendId? = null
    private var requestVersion = 0L
    private var providerFetch = 0L
    private var knownProfiles by mutableStateOf<List<NativeBackendProfile>>(emptyList())
    private var providerCatalogs by mutableStateOf<List<ProviderCatalog>>(emptyList())
    private var providerCatalogsLoading by mutableStateOf(false)

    /** Headings for the model sheet. Empty when this agent has fewer than two providers. */
    fun providerGroups(): List<ModelPickerGroup> {
        if (knownProfiles.size < 2) return emptyList()
        return knownProfiles.map { profile ->
            val loaded = providerCatalogs.firstOrNull { it.profile.id == profile.id }
            val active = profile.id == profileId
            when {
                loaded != null -> ModelPickerGroup(
                    profileId = profile.id,
                    name = profile.name.ifBlank { profile.id },
                    models = if (active && catalog.isNotEmpty()) catalog else loaded.models,
                    available = loaded.available,
                    unavailableReason = loaded.reason,
                    error = loaded.error,
                    loading = loaded.error == null && loaded.models.isEmpty() && providerCatalogsLoading,
                )
                active -> ModelPickerGroup(
                    profileId = profile.id,
                    name = profile.name.ifBlank { profile.id },
                    models = catalog,
                    error = catalogError,
                    loading = catalogLoading,
                )
                else -> ModelPickerGroup(
                    profileId = profile.id,
                    name = profile.name.ifBlank { profile.id },
                    models = emptyList(),
                    loading = providerCatalogsLoading,
                    error = if (providerCatalogsLoading) null else providerNotRead,
                )
            }
        }
    }

    /**
     * Applies a model from [profileId]. A different provider replaces the catalog the parameters
     * and the usage read are taken from, and is the profile [createSession] will start.
     *
     * A provider whose catalog failed or is empty is left unselected: there is no model to start
     * with, and the current provider stays in place.
     */
    fun selectProviderModel(profileId: String, selection: String) {
        if (profileId == this.profileId) {
            model = selection
            return
        }
        val chosen = providerCatalogs.firstOrNull { it.profile.id == profileId } ?: return
        if (!chosen.available || chosen.error != null || chosen.models.isEmpty()) return
        catalog = chosen.models
        // The other provider's capabilities decide which modes and permissions are valid for it.
        chosen.entry?.let { entry ->
            capabilities = entry.capabilities
            source = entry
        }
        pick(picks.withModel(profileId, selection))
    }

    /** Reloads one provider's catalog without moving the composer back to the saved default. */
    fun retryProviderCatalog(projectId: String, profileId: String) {
        val api = api ?: return
        val profile = knownProfiles.firstOrNull { it.id == profileId } ?: return
        val fetch = ++providerFetch
        val version = requestVersion
        val backend = backendId
        scope.launch {
            providerCatalogsLoading = true
            providerCatalogs = providerCatalogs.map { current ->
                if (current.profile.id == profileId) current.copy(models = emptyList(), available = true, reason = null, error = null) else current
            }
            try {
                val result = readProviderCatalog(api, backend, projectId, profile, catalogReadFailed)
                if (fetch != providerFetch || version != requestVersion || backend != backendId) return@launch
                providerCatalogs = knownProfiles.map { known ->
                    when (known.id) {
                        profileId -> result
                        else -> providerCatalogs.firstOrNull { it.profile.id == known.id }
                            ?: ProviderCatalog(known, emptyList(), true, null, providerNotRead)
                    }
                }
                if (profileId == this@HomeConfig.profileId && result.error == null) {
                    catalog = result.models
                    result.entry?.let { source = it }
                    settle()
                }
            } finally {
                if (fetch == providerFetch && version == requestVersion) providerCatalogsLoading = false
            }
        }
    }

    /** Reads quota and load for the backend and profile this composer is on, or null without an API. */
    fun usageLoader(projectId: String): (suspend () -> riffet.contracts.NativeBackendUsage)? {
        val api = api ?: return null
        val backend = backendId
        val profile = profileId
        return { api.backendUsage(backend, projectId = projectId, profileId = profile) }
    }

    private var seenRevision: Long? = null

    /**
     * Follows the list's settings and provider revision: an unchanged key reads nothing, a new
     * [backendRevision] (providers edited) reads the catalog again.
     */
    fun sync(projectId: String, settings: riffet.contracts.AppSettings?, backendRevision: Long, recentModel: String? = null) {
        val providersChanged = seenRevision != null && seenRevision != backendRevision
        seenRevision = backendRevision
        load(projectId, settings, force = providersChanged, recentModel = recentModel)
    }

    /** A quick chat entry's mode; null goes back to the plain 对话. The catalog still has the last word. */
    fun preselect(mode: String?) {
        if (mode == initialMode) return
        initialMode = mode
        pick(picks.copy(mode = mode))
    }

    /** The slash commands for the current backend and profile in the last project asked for. */
    var slash by mutableStateOf<NativeSlashCatalog?>(null)
        private set
    private var slashKey: String? = null

    suspend fun loadSlash(projectId: String) {
        val api = api ?: return
        val backend = backendId
        val profile = profileId
        val key = "$projectId|$backend|${profile.orEmpty()}"
        if (key == slashKey) return
        slashKey = key
        slash = null
        slash = try {
            api.slashCatalog(backend, projectId = projectId, profileId = profile)
        } catch (cancellation: CancellationException) {
            slashKey = null
            throw cancellation
        } catch (_: Throwable) {
            slashKey = null
            null
        }
    }

    /** [recentModel]: the latest quick chat's model, offered when no default is saved. */
    fun load(projectId: String, settings: riffet.contracts.AppSettings?, force: Boolean = false, recentModel: String? = null) {
        val api = api ?: return
        if (quickChat) {
            if (recentModel != this.recentModel) {
                this.recentModel = recentModel
                if (source != null) settle()
            }
            backendId = NativeBackendId.CHAT
            if (backendId != picksBackend) {
                picks = NewSessionDraft(mode = initialMode)
                picksBackend = backendId
            }
            val key = "$projectId:chat:${settings?.auxiliaryModels?.chat}:${settings?.quickChat?.presets}"
            if (!force && loadedKey == key) return
            loadedKey = key
            val version = ++requestVersion
            val fetch = ++providerFetch
            if (force) loadedConfigs.clear()
            val cached = loadedConfigs[cacheKey(key)]
            if (cached != null) apply(cached, settings)
            scope.launch {
                if (version != requestVersion) return@launch
                if (cached == null) catalogLoading = true
                catalogError = null
                providerCatalogsLoading = false
                try {
                    // The chat backend is not in GET /api/backends; its catalog is read directly.
                    val loaded = api.backendCatalog(NativeBackendId.CHAT, profileId = null, projectId = projectId)
                    if (version != requestVersion) return@launch
                    backends = emptyList()
                    catalog = loaded.models
                    capabilities = loaded.capabilities
                    source = loaded
                    listed = loaded
                    this@HomeConfig.settings = settings
                    settle()
                    loadedConfigs[cacheKey(key)] = LoadedConfig(backends, loaded, listed, knownProfiles, providerCatalogs)
                } catch (cancellation: CancellationException) {
                    throw cancellation
                } catch (failure: Throwable) {
                    if (version == requestVersion) {
                        catalogError = failure.message ?: catalogReadFailed
                        loadedKey = null
                    }
                } finally {
                    if (version == requestVersion) catalogLoading = false
                }
            }
            return
        }
        if (defaultBackendId != settings?.defaultBackendId) userChoseBackend = false
        defaultBackendId = settings?.defaultBackendId
        if (!userChoseBackend) backendId = settings?.defaultBackendId ?: NativeBackendId.CURSOR
        // Another backend has other providers, models and permissions: its picks start over.
        if (backendId != picksBackend) {
            picks = NewSessionDraft()
            picksBackend = backendId
        }
        val key = "$projectId:$backendId:${settings?.nativeBackendDefaults?.get(backendId)}:${if (backendId == NativeBackendId.CURSOR) settings?.defaultModel else null}"
        if (!force && loadedKey == key) return
        loadedKey = key
        val version = ++requestVersion
        val fetch = ++providerFetch
        val requestedBackend = backendId
        if (force) loadedConfigs.clear()
        val cached = loadedConfigs[cacheKey(key)]
        if (cached != null) apply(cached, settings)
        else if (loadedBackend != requestedBackend) {
            // Another agent's providers are not this one's; within one agent they stay until the new answer.
            knownProfiles = emptyList()
            providerCatalogs = emptyList()
        }
        scope.launch {
            if (version != requestVersion) return@launch
            if (cached == null) catalogLoading = true
            catalogError = null
            providerCatalogsLoading = false
            try {
                val choices = if (backends.isEmpty() || force) {
                    try { api.backends() }
                    catch (cancellation: CancellationException) { throw cancellation }
                    catch (_: Throwable) { backends }
                } else backends
                val defaults = settings?.nativeBackendDefaults?.get(requestedBackend)
                val entry = choices.firstOrNull { it.backendId == requestedBackend }
                val requestedProfile = picks.requestedProfile(entry, defaults)
                val loaded = api.backendCatalog(backendId = requestedBackend, profileId = requestedProfile, projectId = projectId)
                if (version != requestVersion) return@launch
                backends = choices
                catalog = loaded.models
                capabilities = loaded.capabilities
                source = loaded
                listed = entry
                this@HomeConfig.settings = settings
                settle()
                val profiles = entry?.profiles.orEmpty()
                knownProfiles = profiles
                if (profiles.size < 2) {
                    providerCatalogs = emptyList()
                } else {
                    val activeProfile = profiles.firstOrNull { it.id == profileId } ?: profiles.firstOrNull { it.isDefault == true }
                    val active = activeProfile?.let { ProviderCatalog(it, loaded.models, loaded.available, loaded.reason, null, loaded) }
                    loadProviderCatalogs(api, requestedBackend, projectId, profiles, active, version, fetch)
                }
                if (version == requestVersion) {
                    loadedBackend = requestedBackend
                    loadedConfigs[cacheKey(key)] = LoadedConfig(choices, loaded, entry, profiles, providerCatalogs)
                }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (failure: Throwable) {
                if (version == requestVersion) {
                    catalogError = failure.message ?: catalogReadFailed
                    loadedKey = null
                }
            } finally {
                if (version == requestVersion) catalogLoading = false
            }
        }
    }

    fun selectBackend(id: NativeBackendId, projectId: String, settings: riffet.contracts.AppSettings?) {
        if (id == backendId) return
        userChoseBackend = true
        backendId = id
        load(projectId, settings)
    }

    private suspend fun loadProviderCatalogs(
        api: RiffetApi,
        backend: NativeBackendId,
        projectId: String,
        profiles: List<NativeBackendProfile>,
        active: ProviderCatalog?,
        version: Long,
        fetch: Long,
    ) {
        providerCatalogsLoading = true
        // Each provider is shown as soon as it answers, in configured order: a slow gateway must not hold back the others.
        // The previous answers stay in place until their replacements land, so the sheet does not blank.
        val read = mutableMapOf<String, ProviderCatalog>()
        providerCatalogs.forEach { previous -> if (profiles.any { it.id == previous.profile.id }) read[previous.profile.id] = previous }
        if (active != null) read[active.profile.id] = active
        providerCatalogs = profiles.mapNotNull { read[it.id] }
        try {
            supervisorScope {
                profiles.filter { it.id != active?.profile?.id }.map { profile ->
                    async {
                        val catalog = readProviderCatalog(api, backend, projectId, profile, catalogReadFailed)
                        if (version == requestVersion && fetch == providerFetch) {
                            read[profile.id] = catalog
                            providerCatalogs = profiles.mapNotNull { read[it.id] }
                        }
                    }
                }.awaitAll()
            }
        } finally {
            if (version == requestVersion && fetch == providerFetch) providerCatalogsLoading = false
        }
    }
}

private suspend fun readProviderCatalog(
    api: RiffetApi,
    backend: NativeBackendId,
    projectId: String,
    profile: NativeBackendProfile,
    readFailed: String,
): ProviderCatalog = try {
    val entry = api.backendCatalog(backendId = backend, profileId = profile.id, projectId = projectId)
    ProviderCatalog(profile, entry.models, entry.available, entry.reason, null, entry)
} catch (cancellation: CancellationException) {
    throw cancellation
} catch (failure: Throwable) {
    ProviderCatalog(profile, emptyList(), false, null, failure.message ?: readFailed)
}
