package riffet.ui.home

import riffet.ui.theme.appearancePageBackground

import riffet.ui.app.LocalTabContentBottomPadding

import riffet.ui.design.LocalRiffetSurfaces
import riffet.ui.design.LocalInterfaceStyle
import androidx.compose.foundation.border
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import kotlinx.coroutines.delay
import riffet.ui.theme.LocalRiffetMotion
import riffet.ui.theme.LocalRiffetPageMotion
import androidx.compose.runtime.Stable
import androidx.compose.ui.unit.Dp
import riffet.ui.app.TabTopBar
import riffet.ui.assistant.AssistantEntries
import riffet.ui.assistant.AssistantSheet
import riffet.shared.ASSISTANT_BACKENDS
import riffet.shared.assistantSettings
import riffet_mobile.shared.generated.resources.assistant_title
import riffet_mobile.shared.generated.resources.assistant_memory
import riffet_mobile.shared.generated.resources.assistant_rules
import riffet_mobile.shared.generated.resources.assistant_abilities
import riffet.ui.app.RiffetPageScaffold
import androidx.compose.ui.semantics.Role
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.material3.MaterialTheme
import riffet_mobile.shared.generated.resources.session_tab_new
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.layout.heightIn
import riffet.ui.timeline.Spinner
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
import riffet.ui.composer.rememberComposerDictation
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
import riffet.shared.PrewarmBody
import riffet.ui.app.LocalPageActive
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
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
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
import androidx.compose.foundation.layout.RowScope
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
import riffet.ui.pickers.ModePickerPage
import riffet.ui.pickers.ModelPickerGroup
import riffet.ui.pickers.ModelPickerPages
import riffet.ui.pickers.ModelPanelAgents
import riffet.ui.design.ChipItem
import riffet.ui.pickers.PickerSheet
import riffet.ui.pickers.SendSettingRow
import riffet.ui.pickers.ToolsPickerPage
import riffet.ui.pickers.extensionsPick
import riffet.ui.pickers.rememberExtensionsListed
import riffet.ui.pickers.offeredPicks
import riffet.ui.pickers.rememberPluginToolGroups
import riffet.ui.pickers.rememberToolDevices
import riffet.ui.pickers.toolsOffered
import riffet.ui.pickers.toolsSummary
import riffet.ui.composer.ComposerSettings
import riffet.ui.pickers.SendSettingsPage
import riffet.ui.settings.SettingsNoticeKind
import androidx.compose.ui.text.style.TextOverflow
import riffet.ui.pickers.modelLabel
import riffet.ui.pickers.modelSelectionSummary
import riffet.ui.pickers.optionLabelOf
import riffet.ui.session.backendName
import riffet.ui.sessionlist.compareSessions
import riffet.ui.sessionlist.relativeTimeLabel
import riffet.ui.state.SessionStore
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet.shared.backendCatalog
import riffet.shared.backendUsage
import riffet.shared.updateSettings
import riffet.shared.backends
import riffet.shared.isAssistant
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
import riffet_mobile.shared.generated.resources.session_refresh
import riffet_mobile.shared.generated.resources.session_remove
import riffet_mobile.shared.generated.resources.external_import_action
import riffet_mobile.shared.generated.resources.session_terminal
import riffet_mobile.shared.generated.resources.session_switch_project
import riffet_mobile.shared.generated.resources.session_task_placeholder
import riffet_mobile.shared.generated.resources.session_reference_limit
import riffet.ui.design.agentMarkTint

/*
 * The workbench with no session open: `apps/web/src/app/ProjectHome.tsx`.
 *
 * The run configuration lives above the page ([HomeConfigs]), so leaving the tab reads no catalog
 * again. The agent, model, mode and permission start from the server's saved defaults
 * (`settings.nativeBackendDefaults`) exactly as the web's home does.
 */

/** The page's one draft (the web's `new:home`). */
internal const val HOME_DRAFT_ID = "home"

/** The assistant page's own draft: what is typed there is not 新会话's. */
private const val ASSISTANT_DRAFT_ID = "assistant"


/**
 * 新会话's and the assistant's run configurations. Held by the workbench rather than the page, so a
 * tab switch keeps the loaded catalogs; they reload only when the providers
 * change (`backendRevision`), the saved defaults change, or the reader retries.
 */
@Stable
class HomeConfigs internal constructor(internal val task: HomeConfig, internal val assistant: HomeConfig)

@Composable
fun rememberHomeConfigs(api: RiffetApi?, preferences: AppPreferences? = null): HomeConfigs {
    val scope = rememberCoroutineScope()
    val catalogReadFailed = stringResource(Res.string.session_catalog_read_failed)
    val providerNotRead = stringResource(Res.string.session_provider_not_read)
    return remember(api, preferences, catalogReadFailed, providerNotRead) {
        HomeConfigs(
            task = HomeConfig(api, scope, catalogReadFailed, providerNotRead, preferences = preferences, remembersPicks = true),
            assistant = HomeConfig(api, scope, catalogReadFailed, providerNotRead, offers = { it in ASSISTANT_BACKENDS }),
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
    configs: HomeConfigs,
    /** Opens the navigation drawer: the 新会话 tab's top bar leads with it. */
    onOpenMenu: () -> Unit,
    onOpenSession: (Session) -> Unit,
    /** Opens the terminal import picker. */
    onImportSession: () -> Unit,
    /** Shows a terminal by id and title. */
    onOpenTerminal: (String, String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val pageMotion = LocalRiffetPageMotion.current
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
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (failure: Throwable) {
                bindError = failure.message?.takeIf { it.isNotBlank() } ?: getString(Res.string.session_cannot_use_directory)
            } finally {
                binding = false
            }
        }
    }

    // The configuration follows the server's settings while the page is up; an unchanged key reads
    // nothing, so coming back to the tab costs no request.
    LaunchedEffect(configs, project?.id, list.settings, list.backendRevision) {
        project?.let { configs.task.sync(it.id, list.settings, list.backendRevision) }
    }

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
            topBar = { TabTopBar(title = stringResource(Res.string.session_tab_new), onOpenMenu = onOpenMenu) },
        ) { contentInsets ->
            Box(Modifier.fillMaxSize()) {
                // What the composer was last showing: while it fades out after the project is gone,
                // it still has something to draw.
                val last = remember { arrayOfNulls<Project>(1) }
                project?.let { last[0] = it }
                // The empty state and the composer replace each other in place (loading, then the
                // first project, then the composer); the composer's sheets overflow this box over the
                // system bars, so no size transform and no clip.
                // Which of the three is shown is the transition's state, not read inside it: the page leaving
                // must keep drawing what it was. Read inside, the loading page that fades out as the first
                // project arrives would turn into the setup steps on its way out, a flash on every launch.
                val shown = when {
                    project != null -> HomeShown.Composer
                    !list.loaded -> HomeShown.Loading
                    list.error != null -> HomeShown.Failed
                    else -> HomeShown.Setup
                }
                AnimatedContent(
                    targetState = shown,
                    transitionSpec = { pageMotion.transition() using null },
                    label = "homeContent",
                ) { state ->
                    if (state != HomeShown.Composer) {
                        // Reading the projects (or failing to) keeps its own state; once they are known the
                        // steps still missing sit in the composer's place.
                        if (state == HomeShown.Loading) {
                            // The device copy usually lands within a few frames: a loading page shown at once only
                            // flashes before the composer. It fades in if the read is still going after a moment.
                            var slow by remember { mutableStateOf(false) }
                            LaunchedEffect(Unit) { delay(SLOW_LOAD_MILLIS); slow = true }
                            AnimatedVisibility(visible = slow, enter = fadeIn(LocalRiffetMotion.current.effects())) {
                                HomeEmptyState(loaded = false, error = null, canAdd = false, onAdd = {}, onRefresh = {}, contentPadding = contentInsets)
                            }
                        } else if (state == HomeShown.Failed) HomeEmptyState(
                            loaded = true,
                            error = list.error,
                            canAdd = api != null,
                            onAdd = {
                                bindError = null
                                pickerOpen = true
                            },
                            onRefresh = { store.refresh() },
                            contentPadding = contentInsets,
                        ) else riffet.ui.onboarding.HomeSetupPage(
                            api = api,
                            projects = list.projects,
                            contentPadding = contentInsets,
                            onSelectProject = onSelectProject,
                            onAddDirectory = if (api != null) ({
                                bindError = null
                                pickerOpen = true
                            }) else null,
                        )
                    } else {
                        val shownTarget = last[0]!!
                        HomeContent(
                            store = store,
                            api = api,
                            target = shownTarget,
                            config = configs.task,
                            slot = {
                                Box(Modifier.fillMaxWidth().height(SlotHeight), contentAlignment = Alignment.CenterStart) {
                                    if (project != null) ProjectContext(project, onClick = { projectSheet = true })
                                }
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
                projects = list.projects.filter { it.archivedAt == null && !it.isAssistant && it.system != "task-workspace" },
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

/** The slot above the composer: a fixed line, so the composer does not move when the project loads. */
private val SlotHeight = 48.dp

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
    riffet.ui.design.EmptyState(
        message = error.takeIf { loaded },
        modifier = Modifier.padding(contentPadding),
        icon = RiffetIcons.Folder,
        title = if (loaded) stringResource(Res.string.session_no_directory) else stringResource(Res.string.session_loading_projects),
        actions = if (loaded) {
            {
                riffet.ui.design.RiffetButton(stringResource(Res.string.session_add_directory), onAdd, enabled = canAdd, primary = true)
                riffet.ui.design.RiffetButton(stringResource(Res.string.session_refresh), onRefresh)
            }
        } else null,
    )
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

/** The mark's size when the page has room for it, and the room below which it gives way. */
private val HomeMarkSize = 104.dp
private val HomeMarkMinRoom = 56.dp

/**
 * One of the terminal tools under the composer: an icon and a name in an outline, no fill. The
 * composer is the page's one filled card; the tools are secondary and read so (Material's filled
 * versus outlined emphasis).
 */
@Composable
private fun HomeToolCard(icon: ImageVector, title: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val style = LocalInterfaceStyle.current
    val metrics = style.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val shape = RoundedCornerShape(metrics.controlRadius)
    // Where tone separates surfaces, the card is the quiet fill a filter chip rests on, not one more outline.
    val frame = if (style.components.surfaces.softLines) Modifier.background(LocalRiffetSurfaces.current.press)
        else Modifier.border(metrics.hairlineWidth, colors.line, shape)
    Row(
        modifier = modifier
            .clip(shape)
            .then(frame)
            .clickable(role = Role.Button, onClick = onClick)
            .heightIn(min = metrics.rowHeight)
            .padding(horizontal = metrics.rowPadding),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(metrics.controlInset),
    ) {
        Icon(icon, contentDescription = null, tint = colors.fg2, modifier = Modifier.size(metrics.smallIconSize))
        Text(title, style = typography.bodySmall, color = colors.fg, maxLines = 1, overflow = TextOverflow.Ellipsis,
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
internal fun HomeBands(
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
    /** The project the next session starts in. */
    target: Project,
    config: HomeConfig,
    /** Above the composer: where the session starts. */
    slot: @Composable () -> Unit,
    onOpenSession: (Session) -> Unit,
    /** Continue a terminal conversation; null where the server cannot import. */
    onImport: (() -> Unit)?,
    /** Shows a terminal by id and title. */
    onOpenTerminal: (String, String) -> Unit,
    contentPadding: PaddingValues = PaddingValues(),
    /** The assistant's page: its own draft, no terminal tools, the setup cards in their place. */
    assistant: AssistantHomeParts? = null,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val motion = LocalRiffetMotion.current
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val dictation = rememberComposerDictation(store)
    val list by store.list.collectAsState()
    val scope = rememberCoroutineScope()
    val pageActive = LocalPageActive.current

    val draftId = if (assistant != null) ASSISTANT_DRAFT_ID else HOME_DRAFT_ID
    val drafts = LocalComposerDrafts.current
    val draft = remember(drafts) { drafts?.draftFor(draftId) ?: ComposerDraft() }
    var text by draft.text
    var attachments by draft.attachments
    var references by draft.references
    SideEffect { drafts?.save(draftId, draft) }
    DisposableEffect(drafts) {
        onDispose { drafts?.save(draftId, draft) }
    }
    val composerFocus = remember { androidx.compose.ui.focus.FocusRequester() }
    var thumbnails by remember { mutableStateOf<Map<String, ImageBitmap>>(emptyMap()) }
    var uploading by remember { mutableStateOf(false) }
    var creating by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
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
    val toolsSupported = config.capabilities?.supportsRiffetTools == true
    val toolDevices = rememberToolDevices(api, enabled = toolsSupported)
    val pluginTools = rememberPluginToolGroups(api, enabled = toolsSupported, value = emptyList())
    val pickedTools = offeredPicks(toolDevices, config.toolGroups, pluginTools)
    val phonesShown = toolsSupported && toolsOffered(toolDevices, emptyList(), pluginTools)
    // MCP servers and Skills switched off for this conversation only; a new one starts with everything on.
    var extensionsOff by remember(config.backendId, config.profileId, target.id) { mutableStateOf(emptyList<String>()) }
    val extensions = extensionsPick(
        api, allowed = true, capabilities = config.capabilities, backendId = config.backendId, profileId = config.profileId,
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
                drafts?.save(draftId, draft)
                uploading = false
            }
        }
    }

    // While the page shows an Agent that keeps a warm CLI (`supportsPrewarm`), one is held for its choice;
    // leaving the page or choosing otherwise releases it, and a send hands it to the new conversation.
    val prewarm = remember { PrewarmLease() }
    val prewarmBody = if (pageActive && assistant == null && config.capabilities?.supportsPrewarm == true) PrewarmBody(
        projectId = target.id, backendId = config.backendId, backendProfileId = config.profileId,
        model = config.model.takeIf { it.isNotBlank() }, mode = config.mode, approval = config.approval,
    ) else null
    LaunchedEffect(api, prewarmBody) { prewarm.hold(api, prewarmBody) }
    DisposableEffect(prewarm) { onDispose { prewarm.close() } }

    fun create() {
        val prompt = text.trim()
        if (prompt.isEmpty() || creating || uploading) return
        creating = true
        error = null
        prewarm.sent()
        scope.launch {
            try {
                val session = store.createSession(
                    projectId = target.id,
                    prompt = prompt,
                    attachments = attachments,
                    backendId = config.backendId,
                    backendProfileId = config.profileId,
                    model = config.model,
                    mode = config.mode,
                    approval = config.approval,
                    context = references,
                    agentId = null,
                    toolGroups = if (phonesShown) pickedTools else null,
                    extensionsOff = extensionsOff.takeIf { extensions != null && it.isNotEmpty() },
                )
                text = ""
                attachments = emptyList()
                references = emptyList()
                thumbnails = emptyMap()
                drafts?.save(draftId, draft)
                assistant?.onStarted?.invoke(config.backendId, config.profileId, config.model)
                onOpenSession(session)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (failure: Throwable) {
                prewarm.sendFailed()
                error = failure.message?.takeIf { it.isNotBlank() } ?: getString(Res.string.session_create_session_failed)
            } finally {
                creating = false
            }
        }
    }

    val modelSummary = modelSelectionSummary(config.catalog, config.model).ifEmpty { config.model.ifEmpty { stringResource(Res.string.session_default_model) } }
    val referenceLimitText = stringResource(Res.string.session_reference_limit)
    val providerGroups = config.providerGroups()
    val caps = config.capabilities
    val controlsEnabled = api != null && !creating
    // What the model panel's 更多设置 opens: the settings the panel leaves out.
    val rows = buildList {
        caps?.modes?.takeIf { it.size > 1 }?.let { modes ->
            add(SendSettingRow(label = stringResource(Res.string.session_mode), value = optionLabelOf(modes, config.mode, stringResource(Res.string.session_mode))) { sheet = HomeSheet.Mode })
        }
        caps?.permissions?.takeIf { it.isNotEmpty() }?.let { permissions ->
            add(SendSettingRow(label = stringResource(Res.string.session_permission), value = optionLabelOf(permissions, config.approval, stringResource(Res.string.pickers_approval_title))) { sheet = HomeSheet.Approval })
        }
        if (toolsShown) {
            add(SendSettingRow(label = stringResource(Res.string.pickers_tools_title), value = toolsSummary(pickedTools, if (extensions != null) extensionsOff else emptyList(), switches = extensions != null), icon = RiffetIcons.Puzzle) { sheet = HomeSheet.Tools })
        }
    }
    val agents = ModelPanelAgents(
        items = config.backends.map { entry ->
            val mark = entry.backendId.name.lowercase()
            ChipItem(entry.backendId.name, entry.label.ifBlank { backendName(entry.backendId) }, icon = AgentMarks.vector(mark),
                iconTint = colors.agentMarkTint(mark), enabled = entry.available)
        },
        selected = config.backendId.name,
        onSelect = { name ->
            config.backends.firstOrNull { it.backendId.name == name && it.available }?.let { config.selectBackend(it.backendId, target.id, list.settings) }
        },
    )
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
                    if (assistant != null) {
                        Row(Modifier.padding(top = 2.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) { assistant.cards(this) }
                    } else if (onImport != null) {
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
                        placeholder = if (assistant != null) stringResource(Res.string.composer_placeholder_online) else stringResource(Res.string.session_task_placeholder),
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
                            icon = AgentMarks.vector(agentMark) ?: RiffetIcons.Bot,
                            iconTint = colors.agentMarkTint(agentMark),
                            enabled = controlsEnabled,
                            onOpen = { sheet = HomeSheet.Model },
                            loading = config.catalogLoading,
                            error = config.catalogError != null,
                        ),
                        sendEnabled = api != null && text.isNotBlank() && !uploading && !creating && !config.catalogLoading,
                        sendBusy = creating,
                        onSend = ::create,
                        dictation = dictation,
                        hero = true,
                        heroMinLines = 4,
                        slash = config.slash,
                        sessionCandidates = if (config.capabilities?.supportsSessionReferences == true) list.sessions else emptyList(),
                        sessionProjects = list.projects,
                        referenceProjectId = target.id,
                        sessionReferences = references.filter { it.kind == "session" },
                        onReferenceSession = if (config.capabilities?.supportsSessionReferences == true) ({ selected ->
                            if (references.count { it.kind == "session" } >= 5) error = referenceLimitText
                            else if (references.none { it.sessionId == selected.id }) references = references + sessionReference(selected)
                        }) else null,
                        onOpenSessionReference = { reference ->
                            drafts?.save(draftId, draft)
                            list.sessions.firstOrNull { it.id == reference.sessionId }?.let(onOpenSession)
                        },
                        onRemoveSessionReference = { reference -> references = references - reference },
                        focusRequester = composerFocus,
                    )
                }
            },
        )
    }

    sheet?.let { page ->
        // A pick applies its choice first and the sheet then slides away on its own
        // (`PickerHost.dismiss`), so nothing below closes the sheet by hand.
        // The model panel is the root; 更多设置 opens the rest a level down, and each of those a level further.
        PickerSheet(page = page, onDismiss = { sheet = null }, depth = { it.ordinal }) { shown ->
            val back = { sheet = HomeSheet.Settings }
            when (shown) {
                HomeSheet.Settings -> SendSettingsPage(
                    notice = config.catalogError?.let { stringResource(Res.string.pickers_catalog_failed, it) },
                    noticeKind = SettingsNoticeKind.ERROR,
                    noticeAction = stringResource(Res.string.pickers_retry) to { config.load(target.id, list.settings, force = true) },
                    rows = rows,
                    onBack = { sheet = HomeSheet.Model },
                )
                HomeSheet.Model -> ModelPickerPages(
                    catalog = config.catalog,
                    catalogLoading = config.catalogLoading,
                    catalogError = config.catalogError,
                    selection = config.model,
                    disabledReason = null,
                    onSelect = { config.model = it; config.rememberPick(store::applySavedSettings) },
                    onParamChange = { config.model = it; config.rememberPick(store::applySavedSettings) },
                    onRetryCatalog = { config.load(target.id, list.settings, force = true) },
                    loadUsage = config.usageLoader(target.id),
                    remembered = config.rememberedModels,
                    groups = providerGroups,
                    activeProfileId = config.profileId,
                    usageScopeKey = "${config.backendId}|${target.id}|${config.profileId ?: ""}",
                    onSelectChoice = { profileId, selection -> config.selectProviderModel(profileId, selection); config.rememberPick(store::applySavedSettings) },
                    onRetryGroup = { profileId -> config.retryProviderCatalog(target.id, profileId) },
                    agents = agents,
                    onMore = if (rows.isNotEmpty()) ({ sheet = HomeSheet.Settings }) else null,
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
                    plugins = pluginTools,
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
                        onBack = back,
                    )
                }
            }
        }
    }
}

/** How long the projects may take to read before the page says it is loading them. */
private const val SLOW_LOAD_MILLIS = 400L

/** What the new-session page shows: the projects being read, failing to be, the setup steps, or the composer. */
private enum class HomeShown { Loading, Failed, Setup, Composer }

/** The pages of the composer's one sheet, by depth: the model panel, its 更多设置, and what those rows open. */
private enum class HomeSheet { Model, Settings, Mode, Approval, Tools }

/** What the assistant's page adds to the home composer: the setup cards under it, and what to do once the first message is sent. */
internal class AssistantHomeParts(
    val cards: @Composable RowScope.() -> Unit,
    val onStarted: ((NativeBackendId, String?, String) -> Unit)?,
    val packs: List<riffet.contracts.AssistantPack> = emptyList(),
)

/**
 * The assistant before it has a conversation (`apps/web/src/app/ProjectHome.tsx`): the home composer
 * in the assistant's project with 记忆 / 规则 / 能力 under it. The agent and model start from the
 * assistant's own choice; the first message makes the conversation, which the workbench then shows.
 */
@Composable
internal fun AssistantHome(
    store: SessionStore,
    api: RiffetApi?,
    project: Project,
    configs: HomeConfigs,
    entries: AssistantEntries,
    onOpenMenu: () -> Unit,
    onOpenSession: (Session) -> Unit,
    onStarted: (NativeBackendId, String?, String) -> Unit,
) {
    val list by store.list.collectAsState()
    val config = configs.assistant
    val settings = remember(list.settings, config.backends) { assistantSettings(list.settings, config.backends) }
    LaunchedEffect(configs, project.id, settings, list.backendRevision) { config.sync(project.id, settings, list.backendRevision) }
    Box(Modifier.fillMaxSize().appearancePageBackground(LocalRiffetSurfaces.current.page).blurOnTap()) {
        RiffetPageScaffold(
            modifier = Modifier.fillMaxSize(),
            topBar = { TabTopBar(title = stringResource(Res.string.assistant_title), onOpenMenu = onOpenMenu) },
        ) { contentInsets ->
            HomeContent(
                store = store, api = api, target = project, config = config, slot = {},
                onOpenSession = onOpenSession, onImport = null, onOpenTerminal = { _, _ -> },
                contentPadding = contentInsets,
                assistant = AssistantHomeParts(
                    cards = {
                        HomeToolCard(RiffetIcons.Brain, stringResource(Res.string.assistant_memory), { entries.onSheet(AssistantSheet.MEMORY) }, Modifier.weight(1f))
                        HomeToolCard(RiffetIcons.FileText, stringResource(Res.string.assistant_rules), { entries.onSheet(AssistantSheet.RULES) }, Modifier.weight(1f))
                        HomeToolCard(RiffetIcons.Puzzle, stringResource(Res.string.assistant_abilities), entries.onAbilities, Modifier.weight(1f))
                    },
                    onStarted = onStarted,
                    packs = entries.setup.packs.orEmpty(),
                ),
            )
        }
    }
}

/** The web's `tildePath`, also covering Linux homes (`/home/x`, `/<mount>/home/x`, `/root`). */
internal fun tildePath(path: String): String =
    path.replace(Regex("^(/Users/[^/]+|(/[^/]+)?/home/[^/]+|/root)(?=/|$)"), "~")

/**
 * One provider's catalog, as loaded for the new-session model picker.
 *
 * [error] is a failed read. The other providers still list, and this one can be retried on its own.
 */
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
 * provider. Picking a model from another provider points the next session at that provider. On the
 * task composer a pick is also saved as the agent's default (`rememberPick`), as on the web, so the
 * server keeps each provider's last model. An open session keeps the provider it was created with.
 */
internal class HomeConfig(
    private val api: RiffetApi?,
    private val scope: kotlinx.coroutines.CoroutineScope,
    private val catalogReadFailed: String = "",
    private val providerNotRead: String = "",
    /** Keeps the last tool pick, so the next new conversation starts from it. */
    private val preferences: AppPreferences? = null,
    /** The agents this composer offers; the assistant's are only those that isolate it. */
    private val offers: (NativeBackendId) -> Boolean = { true },
    /** Saves a pick as the agent's default so the next conversation starts on it; only the task composer does. */
    private val remembersPicks: Boolean = false,
) {
    /** The phones the next session may control: what the last one on this device was given, read before the first frame. */
    var toolGroups by mutableStateOf(ToolGroups.decode(preferences?.string(PreferenceKeys.TOOL_GROUPS)))
        private set

    fun pickToolGroups(groups: List<String>) {
        toolGroups = ToolGroups.picks(groups)
        preferences?.setString(PreferenceKeys.TOOL_GROUPS, ToolGroups.encode(groups))
    }

    var backends by mutableStateOf<List<NativeBackendCatalogEntry>>(emptyList())
    var backendId by mutableStateOf(NativeBackendId.CLAUDE)
    var catalog by mutableStateOf<List<ModelInfo>>(emptyList())
    var capabilities by mutableStateOf<NativeBackendCapabilities?>(null)
    var catalogLoading by mutableStateOf(false)
    var catalogError by mutableStateOf<String?>(null)

    /** The reader's own picks; the defaults are never written into them, see [NewSessionDraft]. */
    private var picks by mutableStateOf(NewSessionDraft())
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

    /** The last selection picked on each provider of this agent (`""` for an agent without providers). */
    val rememberedModels: Map<String, String>
        get() = settings?.nativeBackendDefaults?.get(backendId)?.profileModels.orEmpty()

    /**
     * Saves the provider and full selection now in force as the agent's default, through the same
     * settings write as the settings page; the server records it per provider. [onSaved] gets the
     * effective settings. A failed write leaves the pick on this composer only.
     */
    fun rememberPick(onSaved: (riffet.contracts.AppSettings) -> Unit) {
        val api = api ?: return
        if (!remembersPicks) return
        val backend = backendId
        val profile = choice.profileId
        val model = choice.model
        if (model.isBlank()) return
        val previous = settings?.nativeBackendDefaults?.get(backend)
        if (previous?.model == model && previous.profileId == profile) return
        val update = riffet.contracts.AppSettingsUpdate(
            nativeBackendDefaults = settings?.nativeBackendDefaults.orEmpty() + (backend to (previous ?: riffet.contracts.NativeBackendDefaults()).copy(profileId = profile, model = model, profileModels = null)),
        )
        scope.launch {
            try { onSaved(api.updateSettings(update)) }
            catch (cancellation: CancellationException) { throw cancellation }
            catch (_: Throwable) { }
        }
    }

    /** Resolves the picks against the loaded catalog: a pick it still offers stays, the rest follow the defaults. */
    private fun settle() {
        val catalog = source
        choice = if (catalog != null) picks.resolve(catalog, settings?.nativeBackendDefaults?.get(catalog.backendId), settings?.defaultModel, listed)
        else NewSessionChoice(picks.profileId, picks.model.orEmpty(), picks.mode, picks.approval)
    }

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
    fun sync(projectId: String, settings: riffet.contracts.AppSettings?, backendRevision: Long) {
        val providersChanged = seenRevision != null && seenRevision != backendRevision
        seenRevision = backendRevision
        load(projectId, settings, force = providersChanged)
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

    fun load(projectId: String, settings: riffet.contracts.AppSettings?, force: Boolean = false) {
        val api = api ?: return
        if (defaultBackendId != settings?.defaultBackendId) userChoseBackend = false
        defaultBackendId = settings?.defaultBackendId
        if (!userChoseBackend) backendId = settings?.defaultBackendId ?: backends.firstOrNull { it.available }?.backendId ?: NativeBackendId.CLAUDE
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
            // Another agent's providers and models are not this one's; within one agent they stay until the new answer.
            // The model panel holds placeholder rows meanwhile rather than the last agent's list.
            knownProfiles = emptyList()
            providerCatalogs = emptyList()
            catalog = emptyList()
            catalogLoading = true
        }
        scope.launch {
            if (version != requestVersion) return@launch
            if (cached == null) catalogLoading = true
            catalogError = null
            providerCatalogsLoading = false
            try {
                val choices = if (backends.isEmpty() || force) {
                    try { api.backends().filter { offers(it.backendId) } }
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
