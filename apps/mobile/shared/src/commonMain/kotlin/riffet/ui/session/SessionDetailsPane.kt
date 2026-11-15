package riffet.ui.session

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.stringResource
import riffet.contracts.NativeActivity
import riffet.contracts.NativeBackendId
import riffet.contracts.Project
import riffet.contracts.Session
import riffet.contracts.SessionState
import riffet.core.SubagentEntry
import riffet.core.SubagentState
import riffet.core.subagentEntries
import riffet.shared.RiffetApi
import riffet.shared.SessionUpdate
import riffet.ui.app.PageBackHandler
import riffet.ui.app.PageBarAction
import riffet.ui.app.PaneAction
import riffet.ui.app.PaneActionBar
import riffet.ui.app.PaneDot
import riffet.ui.app.PaneEnd
import riffet.ui.app.PaneIcon
import riffet.ui.app.PaneRow
import riffet.ui.app.PaneSection
import riffet.ui.app.PaneGap
import riffet.ui.app.PaneHeader
import riffet.ui.app.PaneValueRow
import riffet.ui.design.ConfirmDialog
import riffet.ui.design.Group
import riffet.ui.design.GroupRow
import riffet.ui.design.GroupTitle
import riffet.ui.design.IconTile
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.LocalRiffetSurfaces
import riffet.ui.design.materialContentBackground
import riffet.ui.icons.RiffetIcons
import riffet.ui.pickers.modelLabel
import riffet.ui.pickers.optionLabelOf
import riffet.ui.settings.PageBanner
import riffet.ui.settings.SettingsActionRow
import riffet.ui.settings.SettingsNoticeKind
import riffet.ui.sessionlist.activityAt
import riffet.ui.sessionlist.relativeTimeAgo
import riffet.ui.state.RiffetConnectionState
import riffet.ui.state.SessionStore
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.localizedAppearanceTitle
import riffet.ui.timeline.StatusDot
import riffet.ui.timeline.activityDock
import riffet.ui.timeline.activityView
import riffet.ui.timeline.platformNowMillis
import riffet.ui.timeline.rememberTickingNow
import riffet.ui.timeline.timelineActivities
import riffet_mobile.shared.generated.resources.*

/**
 * 会话信息与操作: the workbench's **right drawer** (mobile.md §2.7).
 *
 * Top to bottom: [PaneHeader] (title, state · backend), a notice only for an exception, the
 * destination tiles (changes, files, terminal, find), 正在进行 (up to three subagents or background
 * tasks inline, the rest one level down), the runtime extension's actions, the read-only facts, the
 * low-frequency actions, and delete alone at the bottom.
 *
 * ## Why this pane reads the store itself
 *
 * The workbench draws the drawer beside `SessionScreen`, not inside it, so it projects what it needs
 * from the [SessionStore] on its own: the live session (`selected`), and the subagent rows, which
 * are a fold over the timeline's tool calls. Only [SessionDetailController] is shared with the
 * screen — one catalog, one set of writes.
 */
@Composable
internal fun SessionDetailsPane(
    store: SessionStore,
    /** The session the workbench opened; the live copy below may be newer. */
    session: Session,
    project: Project?,
    api: RiffetApi?,
    controller: SessionDetailController?,
    onClose: () -> Unit,
    onOpenGit: (() -> Unit)?,
    onOpenFiles: (() -> Unit)?,
    /** Opens the session's terminal; the tile is shown only when the session has one. */
    onOpenTerminal: ((terminalId: String) -> Unit)?,
    onRename: () -> Unit,
    /** Opens 会话内查找 over the conversation; the host closes this drawer first. */
    onFind: (() -> Unit)?,
    onOpenSubagent: ((SubagentEntry) -> Unit)?,
    /** Opens the delete confirmation; null when the server cannot delete. */
    onDelete: (() -> Unit)? = null,
    /** The delete preview is loading. */
    deleteBusy: Boolean = false,
    modifier: Modifier = Modifier,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    // A live `session` frame updates the session in place; fall back to the host's copy until then.
    val selected by store.selected.collectAsState()
    val current = selected?.takeIf { it.id == session.id } ?: session
    val subTasks = rememberSubTasks(store, current)
    val detail = controller?.state?.collectAsState()?.value
    val status by store.status.collectAsState()
    val connection by store.connection.collectAsState()
    val runtimeControl = status?.runtimeControl?.takeIf {
        selected?.id == current.id && current.archivedAt == null && connection is RiffetConnectionState.Live && !it.actions.isNullOrEmpty()
    }
    val runtimePending = detail?.runtimeActionPending == true
    val writeBlocked = detailWriteBlocked(api, detail, current)
    // A metadata write in flight disables the controls that would race it; the wait is not a notice.
    val writeBusy = detail?.actionBusy == true
    val state = stateLabel(current.state)
    // A quick chat has no checkout, terminal or permissions; its details are the model, tags and times.
    val quickChat = current.backendId == NativeBackendId.CHAT
    var resumeOpen by remember(current.id) { mutableStateOf(false) }
    var showAll by remember(current.id) { mutableStateOf<WorkKind?>(null) }
    // Nothing left to list: fall back to the first level.
    val shownAll = showAll?.takeIf { (it == WorkKind.SUBAGENTS && subTasks.subagents.isNotEmpty()) || (it == WorkKind.TASKS && subTasks.tasks.isNotEmpty()) }
    PageBackHandler(enabled = shownAll != null) { showAll = null }
    val subtitle = listOfNotNull(state.first, backendName(current.backendId)).joinToString(" · ")

    Column(modifier = modifier.fillMaxHeight().background(
        materialContentBackground(LocalRiffetSurfaces.current.groupedPage),
    )) {
        PaneHeader(
            title = when (shownAll) {
                WorkKind.SUBAGENTS -> stringResource(Res.string.details_subagents)
                WorkKind.TASKS -> stringResource(Res.string.details_tasks)
                null -> current.title
            },
            subtitle = if (shownAll != null) current.title else subtitle,
            onClose = onClose,
            onBack = if (shownAll != null) ({ showAll = null }) else null,
        )
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(bottom = metrics.controlInset * 2),
        ) {
            when (shownAll) {
                WorkKind.SUBAGENTS -> SubagentSection(subTasks, store, onOpenSubagent, limit = null) {}
                WorkKind.TASKS -> TaskSection(subTasks.tasks, store, limit = null) {}
                null -> {
                    // At most one notice, and only for an exception.
                    val error = detail?.error
                    if (error != null && controller != null) {
                        Box(Modifier.padding(horizontal = metrics.pageInset)) {
                            PageBanner(stringResource(Res.string.session_last_change_failed, error), SettingsNoticeKind.ERROR,
                                stringResource(Res.string.details_dismiss)) { controller.clearError() }
                        }
                        PaneGap()
                    } else if (writeBlocked != null) {
                        // Archived is the one block with a single safe remedy: restoring.
                        val restore = if (current.archivedAt != null && controller != null && !writeBusy) ({ controller.update(SessionUpdate(archived = false)) }) else null
                        Box(Modifier.padding(horizontal = metrics.pageInset)) { PageBanner(writeBlocked, SettingsNoticeKind.INFO, restore?.let { stringResource(Res.string.session_restore) }, restore) }
                        PaneGap()
                    }

                    val terminalId = current.terminalId
                    PaneActionBar(buildList {
                        if (!quickChat) {
                            onOpenGit?.let { add(PaneAction(RiffetIcons.Branch, stringResource(Res.string.session_changes), onClick = it)) }
                            onOpenFiles?.let { add(PaneAction(RiffetIcons.Folder, stringResource(Res.string.session_files), onClick = it)) }
                            if (onOpenTerminal != null && terminalId != null) {
                                add(PaneAction(RiffetIcons.SquareTerminal, stringResource(Res.string.session_terminal)) { onOpenTerminal(terminalId) })
                            }
                        }
                        // Find reads the conversation itself, so it is here for a quick chat too, and open while archived.
                        onFind?.let { add(PaneAction(RiffetIcons.Search, stringResource(Res.string.session_find), onClick = it)) }
                    })

                    if (subTasks.subagents.isNotEmpty()) SubagentSection(subTasks, store, onOpenSubagent, limit = InlineWork) { showAll = WorkKind.SUBAGENTS }
                    if (subTasks.tasks.isNotEmpty()) TaskSection(subTasks.tasks, store, limit = InlineWork) { showAll = WorkKind.TASKS }

                    if (runtimeControl != null) {
                        PaneGap()
                        PaneSection {
                            val accent = LocalRiffetColors.current.accent
                            runtimeControl.actions.orEmpty().forEach { action ->
                                PaneRow(
                                    title = localizedAppearanceTitle(action.label),
                                    subtitle = action.hint?.let { localizedAppearanceTitle(it) }?.takeIf { it.isNotEmpty() },
                                    leading = { PaneIcon(RiffetIcons.Puzzle, accent) },
                                    tone = accent,
                                    enabled = controller != null && !runtimePending && action.disabled != true,
                                ) { controller?.runRuntimeAction(action, runtimeControl.revision) }
                            }
                        }
                    }

                    val now = platformNowMillis()
                    val branch = project?.worktree?.branch?.removePrefix("refs/heads/")?.takeIf { it.isNotBlank() }
                    // Monospace only for what is code: the path and the branch.
                    val facts = buildList<Triple<String, String, Boolean>> {
                        if (!quickChat) {
                            project?.let { add(Triple(stringResource(Res.string.session_project), if (it.worktree != null) stringResource(Res.string.session_project_with_worktree, it.name) else it.name, false)) }
                            project?.let { add(Triple(stringResource(Res.string.session_directory), tildePath(it.cwd), true)) }
                            branch?.let { add(Triple(stringResource(Res.string.session_branch), it, true)) }
                        }
                        detailModelLabel(detail, detail?.intended(current) ?: current).takeIf { it.isNotBlank() }?.let { add(Triple(stringResource(Res.string.session_model), it, false)) }
                        if (!quickChat) {
                            detailApprovalLabel(detail, detail?.intended(current) ?: current, stringResource(Res.string.pickers_approval_title))?.takeIf { it.isNotBlank() }?.let { add(Triple(stringResource(Res.string.session_permission), it, false)) }
                        }
                        if (current.tags.isNotEmpty()) add(Triple(stringResource(Res.string.session_tags), current.tags.joinToString(stringResource(Res.string.session_tag_separator)), false))
                        relativeTimeAgo(current.createdAt, now)?.let { add(Triple(stringResource(Res.string.session_created), it, false)) }
                        relativeTimeAgo(activityAt(current), now)?.let { add(Triple(stringResource(Res.string.session_recent_activity), it, false)) }
                    }
                    if (facts.isNotEmpty()) PaneSection(stringResource(Res.string.session_details)) {
                        facts.forEach { (label, value, mono) -> PaneValueRow(label, value, mono) }
                    }

                    val canResume = api != null && current.nativeSessionId != null && current.terminalHold == null && current.archivedAt == null && !quickChat
                    val editable = writeBlocked == null && !writeBusy
                    PaneGap()
                    PaneActionBar(buildList {
                        add(PaneAction(
                            if (current.pinnedAt != null) RiffetIcons.PinOff else RiffetIcons.Pin,
                            if (current.pinnedAt != null) stringResource(Res.string.details_unpin) else stringResource(Res.string.details_pin),
                            enabled = editable,
                        ) { controller?.update(SessionUpdate(pinned = current.pinnedAt == null)) })
                        add(PaneAction(RiffetIcons.Pencil, stringResource(Res.string.session_rename), enabled = editable, onClick = onRename))
                        add(PaneAction(
                            if (current.archivedAt != null) RiffetIcons.ArchiveRestore else RiffetIcons.Archive,
                            if (current.archivedAt != null) stringResource(Res.string.details_unarchive) else stringResource(Res.string.details_archive),
                            // Restoring is how an archived session becomes writable again.
                            enabled = editable || current.archivedAt != null,
                        ) { controller?.update(SessionUpdate(archived = current.archivedAt == null)) })
                        if (canResume) add(PaneAction(RiffetIcons.Terminal, stringResource(Res.string.details_resume)) { resumeOpen = true })
                    })

                    if (onDelete != null) {
                        PaneGap()
                        PaneSection {
                            val danger = LocalRiffetColors.current.danger
                            PaneRow(stringResource(Res.string.session_delete_menu), leading = { PaneIcon(RiffetIcons.Trash, danger) },
                                tone = danger, enabled = !deleteBusy, onClick = onDelete)
                        }
                    }
                }
            }
            PaneEnd()
        }
    }
    if (resumeOpen && api != null) TerminalResumeDialog(api = api, sessionId = current.id, onDismiss = { resumeOpen = false })
}

/*
 * The three values the details pane and the session screen both need, so the sidebar and the
 * composer can never disagree about what is writable or what the current model is called. They were
 * inline in `SessionScreen` until the details became a pane of its own.
 */

/** Every reason a write is unavailable, in one place so each control states the same thing. */
@Composable
internal fun detailWriteBlocked(api: RiffetApi?, detail: SessionDetailState?, session: Session): String? = when {
    api == null || detail == null -> stringResource(Res.string.session_write_no_api)
    session.archivedAt != null -> stringResource(Res.string.session_write_archived)
    else -> null
}

/** The catalog's own name for the model, falling back to the raw id it was configured with. */
internal fun detailModelLabel(detail: SessionDetailState?, session: Session): String =
    modelLabel(detail?.catalog.orEmpty(), session.model).ifEmpty { session.model.orEmpty() }

/** The backend's own label for the approval mode, resolved from the catalog it reported. */
internal fun detailApprovalLabel(detail: SessionDetailState?, session: Session, fallback: String): String? =
    session.approval?.let { id -> detail?.capabilities?.permissions?.let { optionLabelOf(it, id, fallback) } ?: id }


/** How many work items the first level lists before 「全部 N 个」. */
private const val InlineWork = 3

private enum class WorkKind { SUBAGENTS, TASKS }

/** The pane's work lists: the subagents, and the live background tasks that are not one of them. */
private class SubTasks(
    val subagents: List<SubagentEntry>,
    val activities: List<NativeActivity>,
) {
    val tasks: List<NativeActivity> = subagents.mapTo(HashSet()) { it.toolCallId }.let { owned ->
        activities.filter { it.toolCallId !in owned }
    }
}

/**
 * The store already publishes projected items with tool updates merged. The drawer only needs
 * subagent metadata, not another copy of the transcript's grouping and layout. Derive that metadata
 * off the UI thread, and collect only while the drawer is composed.
 */
@Composable
private fun rememberSubTasks(store: SessionStore, session: Session): SubTasks {
    val tasks by produceState(SubTasks(emptyList(), emptyList()), store, session.id) {
        value = SubTasks(emptyList(), emptyList())
        combine(store.timeline, store.subagents, store.status) { timeline, stored, status ->
            val subagents = subagentEntries(timeline, stored)
            // Keep the activity's stop capability on its single, retained subagent row.
            SubTasks(subagents, activityDock(status?.activity, timelineActivities(timeline)).tasks)
        }.flowOn(Dispatchers.Default).collect { value = it }
    }
    return tasks
}

/** A running task the reader asked to stop, named in the confirmation. */
private class StopRequest(val task: NativeActivity, val name: String)

@Composable
private fun StopTaskDialog(request: StopRequest?, store: SessionStore, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    request ?: return
    ConfirmDialog(
        title = stringResource(Res.string.details_stop_title, request.name),
        message = activityView(request.task).stopWarning,
        confirmLabel = stringResource(Res.string.session_stop),
        danger = true,
        onDismiss = onDismiss,
        onConfirm = { onDismiss(); scope.launch { store.stopActivity(request.task.id) } },
    )
}

/** The one trailing control of a running item; the caller confirms before stopping. */
@Composable
private fun StopButton(tint: Color, onClick: () -> Unit) {
    PageBarAction(RiffetIcons.Stop, stringResource(Res.string.session_stop), onClick, tint = tint)
}

/**
 * 子 Agent: running ones first, each opening its transcript; a running one has a stop control. With a
 * [limit], the first few under a labelled block and a 「全部 N 个」 row ([onAll]); without, all of
 * them with their detail (the second level).
 */
@Composable
private fun SubagentSection(tasks: SubTasks, store: SessionStore, onOpen: ((SubagentEntry) -> Unit)?, limit: Int?, onAll: () -> Unit) {
    val colors = LocalRiffetColors.current
    val stopping by store.stoppingActivities.collectAsState()
    val byTool = remember(tasks.activities) { tasks.activities.associateBy { it.toolCallId } }
    var confirming by remember { mutableStateOf<StopRequest?>(null) }
    val now = rememberTickingNow(active = tasks.activities.isNotEmpty())
    val all = tasks.subagents
    val running = all.count { it.state == SubagentState.RUNNING }
    val ordered = all.sortedBy { if (it.state == SubagentState.RUNNING) 0 else 1 }
    val shown = if (limit != null) ordered.take(limit) else ordered
    PaneSection(
        title = if (limit != null) stringResource(Res.string.details_subagents) else null,
        figure = if (limit == null) null else if (running > 0) stringResource(Res.string.details_running_of, running, all.size) else all.size.toString(),
    ) {
        shown.forEach { entry ->
            val task = byTool[entry.toolCallId]
            val view = task?.let { activityView(it, stopping = it.id in stopping, nowMillis = now) }
            val status = view?.stats ?: when (entry.state) {
                SubagentState.RUNNING -> stringResource(Res.string.session_subagent_running)
                SubagentState.FAILED -> stringResource(Res.string.session_failed)
                SubagentState.DONE, SubagentState.UNKNOWN -> null
            }
            PaneRow(
                title = entry.name,
                subtitle = if (limit == null) entry.detail?.takeIf { it.isNotBlank() } else null,
                leading = {
                    PaneDot(when (entry.state) {
                        SubagentState.RUNNING -> colors.accent
                        SubagentState.FAILED -> colors.danger
                        SubagentState.DONE, SubagentState.UNKNOWN -> colors.fg4
                    })
                },
                value = status.takeIf { view?.canStop != true },
                trailing = if (view?.canStop == true) ({ StopButton(colors.danger) { confirming = StopRequest(task, entry.name) } }) else null,
                onClick = onOpen?.let { { it(entry) } },
            )
        }
        if (limit != null && all.size > limit) PaneRow(stringResource(Res.string.details_all, all.size), tone = colors.accent, chevron = true, onClick = onAll)
    }
    StopTaskDialog(confirming, store) { confirming = null }
}

/** 后台任务: what each runs and for how long, with its stop control; the first few or all, as [SubagentSection]. */
@Composable
private fun TaskSection(tasks: List<NativeActivity>, store: SessionStore, limit: Int?, onAll: () -> Unit) {
    val colors = LocalRiffetColors.current
    val stopping by store.stoppingActivities.collectAsState()
    var confirming by remember { mutableStateOf<StopRequest?>(null) }
    val now = rememberTickingNow(active = true)
    val shown = if (limit != null) tasks.take(limit) else tasks
    PaneSection(
        title = if (limit != null) stringResource(Res.string.details_tasks) else null,
        figure = if (limit != null) tasks.size.toString() else null,
    ) {
        shown.forEach { task ->
            val view = activityView(task, stopping = task.id in stopping, nowMillis = now)
            val name = view.subject ?: view.label
            PaneRow(
                title = name,
                subtitle = view.stats,
                leading = { PaneDot(colors.accent) },
                trailing = if (view.canStop) ({ StopButton(colors.danger) { confirming = StopRequest(task, name) } }) else null,
            )
        }
        if (limit != null && tasks.size > limit) PaneRow(stringResource(Res.string.details_all, tasks.size), tone = colors.accent, chevron = true, onClick = onAll)
    }
    StopTaskDialog(confirming, store) { confirming = null }
}

/** The header's status dot: only the states worth a mark get a colour. */
@Composable
internal fun SessionStateDot(state: SessionState) {
    val colors = LocalRiffetColors.current
    val tint = when (state) {
        SessionState.RUNNING, SessionState.STARTING -> colors.accent
        SessionState.WAITING, SessionState.CANCELLING -> colors.warning
        SessionState.FAILED -> colors.danger
        else -> null
    }
    if (tint != null) StatusDot(color = tint, size = 7.dp)
}

@Composable
private fun stateLabel(state: SessionState): Pair<String?, Boolean> = when (state) {
    SessionState.RUNNING -> stringResource(Res.string.session_state_running) to true
    SessionState.STARTING -> stringResource(Res.string.session_state_starting) to true
    SessionState.WAITING -> stringResource(Res.string.session_waiting_for_you) to true
    SessionState.CANCELLING -> stringResource(Res.string.session_state_cancelling) to true
    SessionState.FAILED -> stringResource(Res.string.session_failed) to true
    SessionState.INTERRUPTED -> stringResource(Res.string.session_state_interrupted) to false
    SessionState.ARCHIVED -> stringResource(Res.string.session_archived) to false
    SessionState.IDLE -> stringResource(Res.string.session_state_idle) to false
}

@Composable
internal fun backendName(id: NativeBackendId?): String = when (id) {
    NativeBackendId.CODEX -> "Codex"
    NativeBackendId.CLAUDE -> "Claude"
    NativeBackendId.DSH -> "DSH"
    NativeBackendId.DROID -> "Droid"
    NativeBackendId.TRAEX -> "TRAE"
    NativeBackendId.PI -> "pi"
    NativeBackendId.ANTIGRAVITY -> "Antigravity"
    NativeBackendId.CHAT -> stringResource(Res.string.session_quick_chat)
    NativeBackendId.CURSOR, null -> "Cursor"
}

private fun tildePath(path: String): String =
    Regex("^/(?:Users|home)/[^/]+").replace(path, "~")
