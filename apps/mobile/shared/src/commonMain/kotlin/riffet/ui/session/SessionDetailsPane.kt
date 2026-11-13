package riffet.ui.session

import riffet.ui.design.materialContentBackground

import riffet.ui.design.cardEdge
import riffet.ui.design.LocalRiffetSurfaces
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.Group
import riffet.ui.design.GroupTitle
import riffet.ui.design.GroupRow
import riffet.ui.design.IconTile
import riffet.ui.design.RiffetTextButton
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.material3.MaterialTheme
import riffet.ui.settings.SettingsNoticeKind
import riffet.ui.app.PageBarAction
import androidx.compose.ui.semantics.Role
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import riffet.ui.icons.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flowOn
import riffet.contracts.NativeBackendId
import riffet.contracts.Project
import riffet.contracts.Session
import riffet.contracts.SessionState
import riffet.core.SubagentEntry
import riffet.core.SubagentState
import riffet.core.subagentEntries
import riffet.contracts.NativeActivity
import androidx.compose.animation.AnimatedVisibility
import riffet.ui.theme.LocalRiffetMotion
import riffet.ui.theme.localizedAppearanceTitle
import riffet.ui.timeline.ActivityView
import riffet.ui.timeline.Chevron
import riffet.ui.timeline.StopConfirmation
import riffet.ui.timeline.activityDock
import riffet.ui.timeline.activityView
import riffet.ui.timeline.rememberTickingNow
import riffet.ui.timeline.timelineActivities
import kotlinx.coroutines.launch
import androidx.compose.runtime.rememberCoroutineScope
import riffet.shared.SessionUpdate
import riffet.shared.RiffetApi
import riffet.ui.icons.RiffetIcons
import riffet.ui.pickers.SheetNotice
import riffet.ui.state.SessionStore
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet.ui.timeline.StatusDot
import riffet.ui.timeline.platformNowMillis
import riffet.ui.sessionlist.activityAt
import riffet.ui.sessionlist.relativeTimeAgo
import riffet.ui.pickers.modelLabel
import riffet.ui.pickers.optionLabelOf
import riffet.ui.state.RiffetConnectionState
import org.jetbrains.compose.resources.stringResource
import org.jetbrains.compose.resources.rememberResourceEnvironment
import riffet_mobile.shared.generated.resources.Res
import riffet_mobile.shared.generated.resources.session_archive
import riffet_mobile.shared.generated.resources.session_archived
import riffet_mobile.shared.generated.resources.session_delete_menu
import riffet_mobile.shared.generated.resources.session_background_running
import riffet_mobile.shared.generated.resources.session_background_tasks
import riffet_mobile.shared.generated.resources.session_branch
import riffet_mobile.shared.generated.resources.session_changes
import riffet_mobile.shared.generated.resources.session_close_details
import riffet_mobile.shared.generated.resources.session_collapse
import riffet_mobile.shared.generated.resources.session_created
import riffet_mobile.shared.generated.resources.session_details
import riffet_mobile.shared.generated.resources.session_directory
import riffet_mobile.shared.generated.resources.session_expand
import riffet_mobile.shared.generated.resources.session_failed
import riffet_mobile.shared.generated.resources.session_files
import riffet_mobile.shared.generated.resources.session_find
import riffet_mobile.shared.generated.resources.session_last_change_failed
import riffet_mobile.shared.generated.resources.session_model
import riffet_mobile.shared.generated.resources.session_permission
import riffet_mobile.shared.generated.resources.pickers_approval_title
import riffet_mobile.shared.generated.resources.session_pin
import riffet_mobile.shared.generated.resources.session_project
import riffet_mobile.shared.generated.resources.session_project_with_worktree
import riffet_mobile.shared.generated.resources.session_quick_chat
import riffet_mobile.shared.generated.resources.session_recent_activity
import riffet_mobile.shared.generated.resources.session_resume_in_terminal
import riffet_mobile.shared.generated.resources.session_rename
import riffet_mobile.shared.generated.resources.session_restore
import riffet_mobile.shared.generated.resources.session_section
import riffet_mobile.shared.generated.resources.session_state_cancelling
import riffet_mobile.shared.generated.resources.session_state_idle
import riffet_mobile.shared.generated.resources.session_state_interrupted
import riffet_mobile.shared.generated.resources.session_state_running
import riffet_mobile.shared.generated.resources.session_state_starting
import riffet_mobile.shared.generated.resources.session_stop
import riffet_mobile.shared.generated.resources.session_subagent_count
import riffet_mobile.shared.generated.resources.session_subagent_count_running
import riffet_mobile.shared.generated.resources.session_subagent_running
import riffet_mobile.shared.generated.resources.session_subagents
import riffet_mobile.shared.generated.resources.session_tag_separator
import riffet_mobile.shared.generated.resources.session_tags
import riffet_mobile.shared.generated.resources.session_terminal
import riffet_mobile.shared.generated.resources.session_unpin
import riffet_mobile.shared.generated.resources.session_waiting_for_you
import riffet_mobile.shared.generated.resources.session_write_archived
import riffet_mobile.shared.generated.resources.session_write_no_api

/**
 * 会话信息与操作: the web header's mobile details sheet (`Header.tsx`) as the workbench's **right
 * drawer** — the left conversation list's mirror, sliding in over the conversation from the end
 * edge with the same width and scrim.
 *
 * It used to be a bottom sheet, whose own actions (变更 / 文件 / 子 Agent's page) had to close it
 * first. What this drawer opens still lands over it (a project panel and a child transcript are
 * full-screen surfaces), but coming back returns to the open drawer.
 *
 * Three blocks, in the web's order: places this session can take you (变更 / 文件), what it is
 * (project, directory, branch, model, permission, tags, times), and what you can do to it (rename,
 * pin, archive).
 *
 * ## Why this pane reads the store itself
 *
 * The workbench draws the drawer beside `SessionScreen`, not inside it, so it projects what it needs
 * from the [SessionStore] on its own: the live session (`selected`), and the subagent rows, which
 * are a fold over the timeline's tool calls. Only [SessionDetailController] is shared with the
 * screen — one catalog, one set of writes — because two of those would mean two catalog fetches and
 * two answers to "is a write in flight".
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
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
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
    // A metadata write in flight disables the rows that would race it; the wait is not a notice.
    val writeBusy = detail?.actionBusy == true
    val state = stateLabel(current.state)
    // A quick chat has no checkout, terminal or permissions; its details are the model, tags and times.
    val quickChat = current.backendId == NativeBackendId.CHAT
    var resumeOpen by remember(current.id) { mutableStateOf(false) }
    val subtitle = listOfNotNull(state.first, backendName(current.backendId)).joinToString(" · ")

    Column(modifier = modifier.fillMaxHeight().background(
        materialContentBackground(LocalRiffetSurfaces.current.groupedPage),
    )) {
        DetailsHeader(title = current.title, subtitle = subtitle, onClose = onClose)
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = if (!LocalInterfaceStyle.current.components.lists.grouped) metrics.pageInset else 0.dp)
                .padding(top = metrics.controlInset / 3, bottom = metrics.controlInset * 2),
            verticalArrangement = Arrangement.spacedBy(if (!LocalInterfaceStyle.current.components.lists.grouped) metrics.sectionGap else metrics.controlInset * (2f / 3f)),
        ) {
            val terminalId = current.terminalId
            val openTerminal = if (onOpenTerminal != null && terminalId != null) ({ onOpenTerminal(terminalId) }) else null
            if (!quickChat && (onOpenGit != null || onOpenFiles != null || openTerminal != null)) {
                if (LocalInterfaceStyle.current.components.lists.grouped) PaneGroup {
                    onOpenGit?.let { NavTile(icon = RiffetIcons.Branch, label = stringResource(Res.string.session_changes), onClick = it) }
                    onOpenFiles?.let {
                        if (onOpenGit != null) PaneDivider()
                        NavTile(icon = RiffetIcons.Folder, label = stringResource(Res.string.session_files), onClick = it)
                    }
                    openTerminal?.let {
                        if (onOpenGit != null || onOpenFiles != null) PaneDivider()
                        NavTile(icon = RiffetIcons.SquareTerminal, label = stringResource(Res.string.session_terminal), onClick = it)
                    }
                } else Row(horizontalArrangement = Arrangement.spacedBy(metrics.controlInset / 2)) {
                    onOpenGit?.let { NavTile(icon = RiffetIcons.Branch, label = stringResource(Res.string.session_changes), onClick = it, modifier = Modifier.weight(1f)) }
                    onOpenFiles?.let { NavTile(icon = RiffetIcons.Folder, label = stringResource(Res.string.session_files), onClick = it, modifier = Modifier.weight(1f)) }
                    openTerminal?.let { NavTile(icon = RiffetIcons.SquareTerminal, label = stringResource(Res.string.session_terminal), onClick = it, modifier = Modifier.weight(1f)) }
                }
            }

            writeBlocked?.let {
                // Archived is the one block with a single safe remedy: restoring, as the action row below does.
                val restore = if (current.archivedAt != null && controller != null && detail?.actionBusy != true) ({ controller.update(SessionUpdate(archived = false)) }) else null
                Box(Modifier.padding(horizontal = if (!LocalInterfaceStyle.current.components.lists.grouped) 0.dp else 16.dp)) {
                    SheetNotice(it, SettingsNoticeKind.INFO, stringResource(Res.string.session_restore), restore)
                }
            }
            detail?.error?.let { message ->
                PaneGroup {
                    ActionRow(icon = RiffetIcons.Error, label = stringResource(Res.string.session_last_change_failed, message), tone = colors.danger, onClick = { controller.clearError() })
                }
            }

            val now = platformNowMillis()
            val branch = project?.worktree?.branch?.removePrefix("refs/heads/")?.takeIf { it.isNotBlank() }
            val rows = buildList {
                if (!quickChat) {
                    project?.let { add(Info(RiffetIcons.Folder, stringResource(Res.string.session_project), if (it.worktree != null) stringResource(Res.string.session_project_with_worktree, it.name) else it.name)) }
                    project?.let { add(Info(RiffetIcons.FolderOpen, stringResource(Res.string.session_directory), tildePath(it.cwd), mono = true)) }
                    branch?.let { add(Info(RiffetIcons.Branch, stringResource(Res.string.session_branch), it, mono = true)) }
                }
                detailModelLabel(detail, detail?.intended(current) ?: current).takeIf { it.isNotBlank() }?.let { add(Info(RiffetIcons.Bot, stringResource(Res.string.session_model), it, mono = true)) }
                if (!quickChat) {
                    detailApprovalLabel(detail, detail?.intended(current) ?: current, stringResource(Res.string.pickers_approval_title))?.takeIf { it.isNotBlank() }?.let { add(Info(RiffetIcons.Shield, stringResource(Res.string.session_permission), it)) }
                }
                if (current.tags.isNotEmpty()) add(Info(RiffetIcons.Tag, stringResource(Res.string.session_tags), current.tags.joinToString(stringResource(Res.string.session_tag_separator))))
                relativeTimeAgo(current.createdAt, now)?.let { add(Info(RiffetIcons.Clock, stringResource(Res.string.session_created), it)) }
                relativeTimeAgo(activityAt(current), now)?.let { add(Info(RiffetIcons.Message, stringResource(Res.string.session_recent_activity), it)) }
            }
            if (rows.isNotEmpty()) {
                PaneGroup(title = stringResource(Res.string.session_details)) {
                    rows.forEachIndexed { index, info ->
                        if (index > 0) PaneDivider()
                        InfoRow(info)
                    }
                }
            }

            // The web puts its work lists here too: the subagents this session fanned out, newest
            // last. Collapsed by default, like the web's phone section, because the header is the
            // answer to "is anything still running" and the list is the detail.
            if (subTasks.subagents.isNotEmpty()) SubagentSection(subTasks.subagents, subTasks.activities, store, onOpenSubagent)
            if (subTasks.tasks.isNotEmpty()) BackgroundTaskSection(subTasks.tasks, store)

            if (runtimeControl != null) {
                PaneGroup {
                    runtimeControl.actions.orEmpty().forEachIndexed { index, action ->
                        if (index > 0) PaneDivider()
                        ActionRow(
                            icon = RiffetIcons.Puzzle,
                            label = localizedAppearanceTitle(action.label),
                            hint = action.hint?.let { localizedAppearanceTitle(it) }?.takeIf { it.isNotEmpty() },
                            enabled = controller != null && !runtimePending && action.disabled != true,
                            onClick = { controller?.runRuntimeAction(action, runtimeControl.revision) },
                        )
                    }
                }
            }

            PaneGroup(title = stringResource(Res.string.session_section)) {
                // Find reads the conversation itself, so it is here for a quick chat too, and open while archived.
                if (onFind != null) {
                    ActionRow(icon = RiffetIcons.Search, label = stringResource(Res.string.session_find), onClick = onFind)
                    PaneDivider()
                }
                ActionRow(icon = RiffetIcons.Pencil, label = stringResource(Res.string.session_rename), enabled = writeBlocked == null && !writeBusy, onClick = onRename)
                PaneDivider()
                ActionRow(
                    icon = if (current.pinnedAt != null) RiffetIcons.PinOff else RiffetIcons.Pin,
                    label = if (current.pinnedAt != null) stringResource(Res.string.session_unpin) else stringResource(Res.string.session_pin),
                    enabled = writeBlocked == null && !writeBusy,
                    onClick = { controller?.update(SessionUpdate(pinned = current.pinnedAt == null)) },
                )
                PaneDivider()
                ActionRow(
                    icon = if (current.archivedAt != null) RiffetIcons.ArchiveRestore else RiffetIcons.Archive,
                    label = if (current.archivedAt != null) stringResource(Res.string.session_restore) else stringResource(Res.string.session_archive),
                    // Restoring is how an archived session becomes writable again.
                    enabled = (writeBlocked == null && !writeBusy) || current.archivedAt != null,
                    onClick = { controller?.update(SessionUpdate(archived = current.archivedAt == null)) },
                )
                if (api != null && current.nativeSessionId != null && current.terminalHold == null && current.archivedAt == null && !quickChat) {
                    PaneDivider()
                    ActionRow(icon = RiffetIcons.Terminal, label = stringResource(Res.string.session_resume_in_terminal), onClick = { resumeOpen = true })
                }
                if (onDelete != null) {
                    PaneDivider()
                    ActionRow(
                        icon = RiffetIcons.Trash,
                        label = stringResource(Res.string.session_delete_menu),
                        enabled = !deleteBusy,
                        tone = colors.danger,
                        onClick = onDelete,
                    )
                }
            }
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

private val GroupShape
    @Composable get() = RoundedCornerShape(LocalInterfaceStyle.current.groupRadius)

/** One property row: what it is, and its value under it. */
private class Info(val icon: ImageVector, val label: String, val value: String, val mono: Boolean = false)

/**
 * A titled block of rows, Material 3's segmented list: one tonal surface whose rows are parted by
 * a gap of the pane's own colour rather than by hairlines.
 */
@Composable
private fun PaneGroup(title: String? = null, content: @Composable ColumnScope.() -> Unit) {
    if (LocalInterfaceStyle.current.components.lists.grouped) {
        Column(Modifier.fillMaxWidth()) {
            if (title != null) GroupTitle(title)
            Group { Column(Modifier.fillMaxWidth(), content = content) }
        }
        return
    }
    val colors = LocalRiffetColors.current
    Column(modifier = Modifier.fillMaxWidth()) {
        if (title != null) {
            Text(
                text = title,
                style = LocalRiffetTypography.current.label,
                color = colors.accent,
                modifier = Modifier.padding(start = 16.dp, bottom = 8.dp),
            )
        }
        Column(modifier = Modifier.fillMaxWidth().cardEdge(GroupShape).clip(GroupShape).background(materialContentBackground(LocalRiffetSurfaces.current.card)), content = content)
    }
}

@Composable
private fun PaneDivider() {
    val style = LocalInterfaceStyle.current
    Spacer(Modifier.fillMaxWidth().padding(start = if (!style.components.lists.grouped) 0.dp else style.metrics.pageInset + style.metrics.iconSlot + style.metrics.controlInset)
        .height(style.metrics.hairlineWidth).background(LocalRiffetSurfaces.current.hairline))
}

/**
 * The pane's own header: what the sheet's `PickerOverlay` used to draw, plus the close button the
 * pane needs because there is no scrim to tap.
 */
@Composable
private fun DetailsHeader(title: String, subtitle: String, onClose: () -> Unit) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    Row(
        modifier = Modifier.fillMaxWidth().padding(start = metrics.pageInset, end = metrics.controlInset / 2,
            top = metrics.controlInset / 3, bottom = metrics.rowPadding),
        verticalAlignment = Alignment.Top,
    ) {
        Column(modifier = Modifier.weight(1f).padding(top = 8.dp)) {
            Text(text = title, style = typography.dialogTitle,
                color = colors.fg, maxLines = if (!LocalInterfaceStyle.current.components.lists.grouped) 3 else 2, overflow = TextOverflow.Ellipsis)
            if (subtitle.isNotEmpty()) {
                Spacer(Modifier.height(4.dp))
                Text(text = subtitle, style = typography.bodySmall, color = colors.fg2, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        Spacer(Modifier.width(8.dp))
        PageBarAction(icon = RiffetIcons.Close, description = stringResource(Res.string.session_close_details), onClick = onClose)
    }
}

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

/**
 * 子 Agent: the phone's half of the web's `SessionWorkActions`.
 *
 * The same shape as the web's `WorkSection` — a rounded well whose header counts the rows and whose
 * chevron opens them in place — because the pane would otherwise push the session's own actions out
 * of reach. Collapsed by default, like the web: the header is the answer to "is anything still
 * running", and the list is the detail.
 */
@Composable
private fun SubagentSection(
    entries: List<SubagentEntry>,
    activities: List<NativeActivity>,
    store: SessionStore,
    onOpen: ((SubagentEntry) -> Unit)?,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val motion = LocalRiffetMotion.current
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val scope = rememberCoroutineScope()
    val stopping by store.stoppingActivities.collectAsState()
    val activitiesByTool = remember(activities) { activities.associateBy { it.toolCallId } }
    var open by remember { mutableStateOf(false) }
    var confirming by remember { mutableStateOf<NativeActivity?>(null) }
    PaneGroup(title = stringResource(Res.string.session_subagents)) {
        if (LocalInterfaceStyle.current.components.lists.grouped) {
            GroupRow(
                title = if (entries.any { it.state == SubagentState.RUNNING }) stringResource(Res.string.session_subagent_count_running, entries.size, entries.count { it.state == SubagentState.RUNNING }) else stringResource(Res.string.session_subagent_count, entries.size),
                leading = { IconTile(RiffetIcons.Bot, colors.accent) },
                trailing = { Chevron(open, size = 18.dp, tint = colors.fg3, icon = RiffetIcons.ChevronDown, openAngle = 180f) },
                onClickLabel = if (open) stringResource(Res.string.session_collapse) else stringResource(Res.string.session_expand),
                onClick = { open = !open },
            )
        } else Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(56.dp)
                .clickable(role = Role.Button) { open = !open }
                .padding(horizontal = metrics.pageInset),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(RiffetIcons.Bot, contentDescription = null, tint = colors.fg2, modifier = Modifier.size(metrics.iconSize))
            Spacer(Modifier.width(16.dp))
            val running = entries.count { it.state == SubagentState.RUNNING }
            Text(
                text = if (running > 0) {
                    stringResource(Res.string.session_subagent_count_running, entries.size, running)
                } else {
                    stringResource(Res.string.session_subagent_count, entries.size)
                },
                style = typography.body,
                color = colors.fg,
                modifier = Modifier.weight(1f),
            )
            Chevron(
                open,
                size = 24.dp,
                tint = colors.fg2,
                icon = RiffetIcons.ChevronDown,
                openAngle = 180f,
                description = if (open) stringResource(Res.string.session_collapse) else stringResource(Res.string.session_expand),
            )
        }
        AnimatedVisibility(visible = open, enter = motion.expandIn(), exit = motion.collapseOut()) {
            val now = rememberTickingNow(active = activities.isNotEmpty())
            // Its own scroll, like the web's `max-h-[50dvh]`: a fan-out of a dozen subagents must not
            // push the session's own actions off the pane.
            Column(modifier = Modifier.fillMaxWidth().heightIn(max = 320.dp).verticalScroll(rememberScrollState())) {
                rememberResourceEnvironment()
                entries.forEach { entry ->
                    PaneDivider()
                    val task = activitiesByTool[entry.toolCallId]
                    val view = task?.let { activityView(it, stopping = it.id in stopping, nowMillis = now) }
                    SubagentRow(entry, view, onOpen) {
                        if (task != null) {
                            if (view?.stopWarning != null) confirming = task else scope.launch { store.stopActivity(task.id) }
                        }
                    }
                }
            }
        }
    }
    confirming?.let { task ->
        StopConfirmation(
            warning = activityView(task).stopWarning,
            onConfirm = { confirming = null; scope.launch { store.stopActivity(task.id) } },
            onDismiss = { confirming = null },
        )
    }
}

/** 后台任务: the live background tasks that are not subagents, in the same collapsible well. */
@Composable
private fun BackgroundTaskSection(tasks: List<NativeActivity>, store: SessionStore) {
    val metrics = LocalInterfaceStyle.current.metrics
    val motion = LocalRiffetMotion.current
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val scope = rememberCoroutineScope()
    val stopping by store.stoppingActivities.collectAsState()
    var open by remember { mutableStateOf(false) }
    var confirming by remember { mutableStateOf<NativeActivity?>(null) }
    PaneGroup(title = stringResource(Res.string.session_background_tasks)) {
        if (LocalInterfaceStyle.current.components.lists.grouped) {
            GroupRow(
                title = stringResource(Res.string.session_background_running, tasks.size),
                leading = { IconTile(RiffetIcons.SquareTerminal, colors.accent) },
                trailing = { Chevron(open, size = 18.dp, tint = colors.fg3, icon = RiffetIcons.ChevronDown, openAngle = 180f) },
                onClickLabel = if (open) stringResource(Res.string.session_collapse) else stringResource(Res.string.session_expand),
                onClick = { open = !open },
            )
        } else Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(56.dp)
                .clickable(role = Role.Button) { open = !open }
                .padding(horizontal = metrics.pageInset),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(RiffetIcons.SquareTerminal, contentDescription = null, tint = colors.fg2, modifier = Modifier.size(metrics.iconSize))
            Spacer(Modifier.width(16.dp))
            Text(text = stringResource(Res.string.session_background_running, tasks.size), style = typography.body, color = colors.fg, modifier = Modifier.weight(1f))
            Chevron(
                open,
                size = 24.dp,
                tint = colors.fg2,
                icon = RiffetIcons.ChevronDown,
                openAngle = 180f,
                description = if (open) stringResource(Res.string.session_collapse) else stringResource(Res.string.session_expand),
            )
        }
        AnimatedVisibility(visible = open, enter = motion.expandIn(), exit = motion.collapseOut()) {
            val now = rememberTickingNow(active = true)
            Column(modifier = Modifier.fillMaxWidth().heightIn(max = 320.dp).verticalScroll(rememberScrollState())) {
                rememberResourceEnvironment()
                tasks.forEach { task ->
                    PaneDivider()
                    TaskRow(task, activityView(task, stopping = task.id in stopping, nowMillis = now)) {
                        if (it.stopWarning != null) confirming = task else scope.launch { store.stopActivity(task.id) }
                    }
                }
            }
        }
    }
    confirming?.let { task ->
        StopConfirmation(
            warning = activityView(task).stopWarning,
            onConfirm = { confirming = null; scope.launch { store.stopActivity(task.id) } },
            onDismiss = { confirming = null },
        )
    }
}

/** One live background task: what it runs, how long, and the stop button. */
@Composable
private fun TaskRow(task: NativeActivity, view: ActivityView, onStop: (ActivityView) -> Unit) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    if (LocalInterfaceStyle.current.components.lists.grouped) {
        GroupRow(
            title = view.subject ?: view.label, subtitle = view.stats,
            leading = { StatusDot(color = colors.accent, size = 8.dp) },
            trailing = if (view.canStop) ({
                RiffetTextButton(onClick = { onStop(view) }, danger = true, contentPadding = PaddingValues(horizontal = 4.dp)) {
                    Text(stringResource(Res.string.session_stop))
                }
            }) else null,
        )
        return
    }
    Row(
        modifier = Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(start = 16.dp, end = 12.dp, top = 10.dp, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(modifier = Modifier.size(metrics.iconSize), contentAlignment = Alignment.Center) { StatusDot(color = colors.accent, size = 8.dp) }
        Spacer(Modifier.width(16.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = view.subject ?: view.label,
                style = typography.body,
                color = colors.fg,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            view.stats?.let { Text(text = it, style = typography.bodySmall, color = colors.fg3, maxLines = 1) }
        }
        if (view.canStop) {
            Text(
                text = stringResource(Res.string.session_stop),
                style = typography.body,
                color = colors.danger,
                modifier = Modifier
                    .clip(RoundedCornerShape(LocalInterfaceStyle.current.controlRadius))
                    .clickable(role = Role.Button) { onStop(view) }
                    .heightIn(min = metrics.controlHeight)
                    // Text draws its line at the top of a taller box; centre it in the tap target.
                    .wrapContentHeight(Alignment.CenterVertically)
                    .padding(horizontal = 12.dp, vertical = 12.dp),
            )
        }
    }
}

/** One subagent: a status dot, what it was asked to do, and whether it is still going. */
@Composable
private fun SubagentRow(
    entry: SubagentEntry,
    activity: ActivityView?,
    onOpen: ((SubagentEntry) -> Unit)?,
    onStop: () -> Unit,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    if (LocalInterfaceStyle.current.components.lists.grouped) {
        val status = activity?.stats ?: when (entry.state) {
            SubagentState.RUNNING -> stringResource(Res.string.session_subagent_running)
            SubagentState.FAILED -> stringResource(Res.string.session_failed)
            SubagentState.DONE, SubagentState.UNKNOWN -> null
        }
        val line = listOfNotNull(status, entry.detail).joinToString(" · ").takeIf { it.isNotEmpty() }
        GroupRow(
            title = entry.name, subtitle = line,
            leading = {
                StatusDot(color = when (entry.state) {
                    SubagentState.RUNNING -> colors.accent
                    SubagentState.DONE -> colors.success
                    SubagentState.FAILED -> colors.danger
                    SubagentState.UNKNOWN -> colors.fg4
                }, size = 8.dp)
            },
            trailing = if (activity?.canStop == true) ({
                RiffetTextButton(onClick = onStop, danger = true, contentPadding = PaddingValues(horizontal = 4.dp)) {
                    Text(stringResource(Res.string.session_stop))
                }
            }) else null,
            chevron = onOpen != null,
            onClick = onOpen?.let { { it(entry) } },
        )
        return
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 64.dp)
            .clickable(enabled = onOpen != null) { onOpen?.invoke(entry) }
            .padding(start = 16.dp, end = 12.dp, top = 10.dp, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(modifier = Modifier.size(metrics.iconSize), contentAlignment = Alignment.Center) {
            StatusDot(
                color = when (entry.state) {
                    SubagentState.RUNNING -> colors.accent
                    SubagentState.DONE -> colors.success
                    SubagentState.FAILED -> colors.danger
                    SubagentState.UNKNOWN -> colors.fg4
                },
                size = 8.dp,
            )
        }
        Spacer(Modifier.width(16.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(text = entry.name, style = typography.body, color = colors.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val status = activity?.stats ?: when (entry.state) {
                SubagentState.RUNNING -> stringResource(Res.string.session_subagent_running)
                SubagentState.FAILED -> stringResource(Res.string.session_failed)
                SubagentState.DONE, SubagentState.UNKNOWN -> null
            }
            val line = listOfNotNull(status, entry.detail).joinToString(" · ")
            if (line.isNotEmpty()) {
                Text(
                    text = line,
                    style = typography.bodySmall,
                    color = when (entry.state) {
                        SubagentState.RUNNING -> colors.accent
                        SubagentState.FAILED -> colors.danger
                        else -> colors.fg3
                    },
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (activity?.canStop == true) {
            Text(
                text = stringResource(Res.string.session_stop),
                style = typography.body,
                color = colors.danger,
                modifier = Modifier
                    .clip(RoundedCornerShape(LocalInterfaceStyle.current.controlRadius))
                    .clickable(role = Role.Button, onClick = onStop)
                    .heightIn(min = metrics.controlHeight)
                    // Text draws its line at the top of a taller box; centre it in the tap target.
                    .wrapContentHeight(Alignment.CenterVertically)
                    .padding(horizontal = 12.dp, vertical = 12.dp),
            )
        }
        // The web's row ends in a chevron-right; a tappable line needs to look like one.
        if (onOpen != null) {
            Spacer(Modifier.width(8.dp))
            Icon(RiffetIcons.ChevronRight, contentDescription = null, tint = colors.fg3, modifier = Modifier.size(metrics.iconSize))
        }
    }
}

@Composable
private fun NavTile(icon: ImageVector, label: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    if (LocalInterfaceStyle.current.components.lists.grouped) {
        GroupRow(title = label, modifier = modifier, leading = { IconTile(icon, colors.accent) }, chevron = true, onClick = onClick)
        return
    }
    Column(
        modifier = modifier
            .clip(GroupShape)
            .background(materialContentBackground(LocalRiffetSurfaces.current.card))
            .clickable(role = Role.Button, onClick = onClick)
            .padding(vertical = 16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(
            modifier = Modifier.size(metrics.controlHeight).clip(RoundedCornerShape(LocalInterfaceStyle.current.controlRadius)).background(LocalRiffetSurfaces.current.selected),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, contentDescription = null, tint = LocalRiffetSurfaces.current.selectedContent, modifier = Modifier.size(metrics.iconSize))
        }
        Spacer(Modifier.height(8.dp))
        Text(text = label, style = LocalRiffetTypography.current.label, color = colors.fg)
    }
}

@Composable
private fun InfoRow(info: Info) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    if (LocalInterfaceStyle.current.components.lists.grouped) {
        CompositionLocalProvider(LocalRiffetTypography provides typography.copy(subhead = if (info.mono) typography.monoSmall else typography.subhead)) {
            GroupRow(title = info.label, subtitle = info.value, subtitleLines = Int.MAX_VALUE,
                leading = { Icon(info.icon, null, tint = colors.fg3, modifier = Modifier.size(22.dp)) })
        }
        return
    }
    Row(
        modifier = Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(horizontal = metrics.pageInset, vertical = metrics.rowPadding),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(info.icon, contentDescription = null, tint = colors.fg2, modifier = Modifier.size(metrics.iconSize))
        Spacer(Modifier.width(16.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(text = info.label, style = typography.body, color = colors.fg)
            Text(
                text = info.value,
                style = if (info.mono) typography.monoSmall else typography.bodySmall,
                color = colors.fg2,
            )
        }
    }
}

@Composable
private fun ActionRow(
    icon: ImageVector,
    label: String,
    onClick: () -> Unit,
    enabled: Boolean = true,
    tone: Color? = null,
    hint: String? = null,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    if (LocalInterfaceStyle.current.components.lists.grouped) {
        RiffetTextButton(onClick = onClick, enabled = enabled, danger = tone == colors.danger,
            modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp), contentPadding = PaddingValues(horizontal = 16.dp, vertical = 10.dp)) {
            val tint = if (!enabled) LocalRiffetSurfaces.current.disabledContent else tone ?: colors.accent
            Box(Modifier.size(30.dp), contentAlignment = Alignment.Center) { Icon(icon, null, tint = tint, modifier = Modifier.size(22.dp)) }
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Text(label, color = tint, maxLines = 2, overflow = TextOverflow.Ellipsis)
                if (hint != null) Text(hint, style = LocalRiffetTypography.current.subhead, color = colors.fg3)
            }
        }
        return
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .clickable(role = Role.Button, enabled = enabled, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = null, tint = if (!enabled) LocalRiffetSurfaces.current.disabledContent else tone ?: colors.fg2, modifier = Modifier.size(metrics.iconSize))
        Spacer(Modifier.width(16.dp))
        Column {
            Text(
                text = label,
                style = LocalRiffetTypography.current.body,
                color = if (!enabled) LocalRiffetSurfaces.current.disabledContent else tone ?: colors.fg,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            if (hint != null) Text(hint, style = LocalRiffetTypography.current.bodySmall, color = colors.fg3)
        }
    }
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
