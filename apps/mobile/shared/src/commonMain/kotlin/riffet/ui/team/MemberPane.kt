package riffet.ui.team

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.background
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.size
import org.jetbrains.compose.resources.stringResource
import riffet.contracts.AgentIds
import riffet.contracts.AgentMember
import riffet.contracts.Session
import riffet.contracts.SessionState
import riffet.shared.callerMember
import riffet.shared.memberMain
import riffet.shared.memberSessions
import riffet.ui.app.PaneAction
import riffet.ui.app.PaneActionBar
import riffet.shared.downloadsSupported
import riffet.ui.app.PaneEnd
import riffet.ui.app.PaneGap
import riffet.ui.app.PaneHeader
import riffet.ui.app.PaneIcon
import riffet.ui.app.PaneRow
import riffet.ui.app.PaneSection
import riffet.ui.app.PaneValueRow
import riffet.ui.assistant.AssistantSetup
import riffet.ui.assistant.AssistantSheet
import riffet.ui.design.ConfirmDialog
import riffet.ui.design.Group
import riffet.ui.design.LocalRiffetSurfaces
import riffet.ui.design.materialContentBackground
import riffet.ui.icons.Icon
import riffet.ui.icons.RiffetIcons
import riffet.ui.pickers.PickerOverlay
import riffet.ui.session.backendName
import riffet.ui.sessionlist.relativeTimeLabel
import riffet.ui.state.SessionStore
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet.ui.timeline.Spinner
import riffet.ui.timeline.platformNowMillis
import riffet_mobile.shared.generated.resources.Res
import riffet_mobile.shared.generated.resources.assistant_abilities
import riffet_mobile.shared.generated.resources.assistant_delegations
import riffet_mobile.shared.generated.resources.assistant_memory
import riffet_mobile.shared.generated.resources.assistant_rules
import riffet_mobile.shared.generated.resources.details_pin
import riffet_mobile.shared.generated.resources.details_unpin
import riffet_mobile.shared.generated.resources.session_files
import riffet_mobile.shared.generated.resources.team_called_by
import riffet_mobile.shared.generated.resources.team_delete
import riffet_mobile.shared.generated.resources.team_delete_message
import riffet_mobile.shared.generated.resources.team_delete_title
import riffet_mobile.shared.generated.resources.team_fact_agent
import riffet_mobile.shared.generated.resources.team_fact_scope
import riffet_mobile.shared.generated.resources.team_scope_global
import riffet_mobile.shared.generated.resources.team_scope_personal
import riffet_mobile.shared.generated.resources.team_session_current
import riffet_mobile.shared.generated.resources.team_sessions
import riffet_mobile.shared.generated.resources.team_sessions_all
import riffet_mobile.shared.generated.resources.team_archive
import riffet_mobile.shared.generated.resources.team_sessions_count
import riffet_mobile.shared.generated.resources.team_sessions_total

/** Where a member's panel rows lead, and the member they speak for. */
internal class MemberPaneEntries(
    val member: AgentMember,
    val setup: AssistantSetup,
    val onSheet: (AssistantSheet) -> Unit,
    val onAbilities: () -> Unit,
    /** The open conversation, marked 当前 in the list. */
    val currentSessionId: String?,
    val onOpenSession: (Session) -> Unit,
    val onPin: (Boolean) -> Unit,
    /** Takes the member out of the list, which leaves its page. */
    val onArchive: () -> Unit,
    val onDelete: () -> Unit,
)

/** How many conversations the first level lists before 「全部 N 个」. */
private const val InlineSessions = 3

/**
 * A member's own part of the panel (mobile.md §9.12): 记忆 · 规则 · 能力, its conversations, the facts that say what it
 * runs on and where, and 归档 · 置顶. The delete row is [MemberPaneDelete], last in the panel. [showsPin] is false in a
 * conversation's panel, whose own action bar carries 归档 and the member's 置顶 (see [memberPinAction]).
 */
@Composable
internal fun MemberPaneRows(entries: MemberPaneEntries, store: SessionStore, showsPin: Boolean = true) {
    val member = entries.member
    val setup = entries.setup
    LaunchedEffect(setup) { setup.load() }
    val colors = LocalRiffetColors.current
    val list by store.list.collectAsState()
    val now = platformNowMillis()
    var allOpen by remember(member.id) { mutableStateOf(false) }

    var filesOpen by remember(member.id) { mutableStateOf(false) }
    val files = setup.files.takeIf { downloadsSupported }.orEmpty()
    PaneActionBar(listOfNotNull(
        PaneAction(RiffetIcons.Brain, stringResource(Res.string.assistant_memory)) { entries.onSheet(AssistantSheet.MEMORY) },
        PaneAction(RiffetIcons.FileText, stringResource(Res.string.assistant_rules)) { entries.onSheet(AssistantSheet.RULES) },
        PaneAction(RiffetIcons.Puzzle, stringResource(Res.string.assistant_abilities), onClick = entries.onAbilities),
        // Only once the member has left something in its `files/` folder (DECISIONS 2026-11-16).
        if (files.isEmpty()) null else PaneAction(RiffetIcons.Folder, stringResource(Res.string.session_files)) { filesOpen = true },
    ))
    if (filesOpen) PickerOverlay(title = stringResource(Res.string.session_files), onDismiss = { filesOpen = false }, fullHeight = true) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            Group {
                files.forEach { file ->
                    PaneRow(
                        file.path.substringAfterLast('/'),
                        subtitle = file.path.substringBeforeLast('/', "").ifEmpty { null },
                        trailing = { Icon(RiffetIcons.Download, null, Modifier.size(18.dp), colors.fg3) },
                    ) { setup.download(file); filesOpen = false }
                }
            }
        }
    }

    val sessions = remember(member, list.sessions, list.projects) {
        val owned = memberSessions(member, list.sessions)
        val main = memberMain(member, list.projects, list.sessions)
        if (main == null) owned else listOf(main) + owned.filter { it.id != main.id }
    }
    if (sessions.isNotEmpty()) {
        val running = sessions.count { it.state == SessionState.RUNNING || it.state == SessionState.STARTING || it.state == SessionState.CANCELLING }
        PaneGap()
        PaneSection(stringResource(Res.string.team_sessions), figure = if (running > 0) stringResource(Res.string.team_sessions_count, running, sessions.size) else stringResource(Res.string.team_sessions_total, sessions.size)) {
            sessions.take(InlineSessions).forEach { session -> PaneSessionRow(store, entries, session, now) }
            if (sessions.size > InlineSessions) PaneRow(
                stringResource(Res.string.team_sessions_all, sessions.size), chevron = true, tone = colors.accent,
            ) { allOpen = true }
        }
    }
    if (allOpen) PickerOverlay(title = stringResource(Res.string.team_sessions), onDismiss = { allOpen = false }, fullHeight = true) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            Group {
                sessions.forEach { session -> PaneSessionRow(store, entries, session, now, onOpened = { allOpen = false }) }
            }
        }
    }

    val target = member.target
    val agent = target?.backendId?.let { id -> AgentIds.builtin(id)?.let { backendName(it) } ?: id }
    val active = setup.delegations?.count { it.state == "active" } ?: 0
    val projectNames = member.scope.projectIds.orEmpty().mapNotNull { id -> list.projects.firstOrNull { it.id == id }?.name }
    val scopeLabel = when (member.scope.kind) {
        "global" -> stringResource(Res.string.team_scope_global)
        "personal" -> stringResource(Res.string.team_scope_personal)
        else -> projectNames.joinToString(", ").ifEmpty { member.scope.kind }
    }
    PaneGap()
    PaneSection {
        agent?.let { PaneValueRow(stringResource(Res.string.team_fact_agent), listOfNotNull(it, target.model?.takeIf(String::isNotBlank)).joinToString(" · ")) }
        PaneValueRow(stringResource(Res.string.team_fact_scope), scopeLabel)
        if (active > 0) PaneValueRow(stringResource(Res.string.assistant_delegations), active.toString()) { entries.onSheet(AssistantSheet.DELEGATIONS) }
    }

    // The default member cannot be archived (the server refuses it), and a bar of 置顶 alone is not worth a card: it
    // already sorts first after the pinned ones, and its row in 团队 still offers 置顶.
    if (showsPin && !member.isDefault) {
        PaneGap()
        PaneActionBar(listOf(
            PaneAction(RiffetIcons.Archive, stringResource(Res.string.team_archive), onClick = entries.onArchive),
            memberPinAction(entries),
        ))
    }
}

/** 置顶 / 取消置顶 of the member, for its own bar or a conversation's. */
@Composable
internal fun memberPinAction(entries: MemberPaneEntries): PaneAction {
    val pinned = entries.member.pinned == true
    return PaneAction(
        if (pinned) RiffetIcons.PinOff else RiffetIcons.Pin,
        stringResource(if (pinned) Res.string.details_unpin else Res.string.details_pin),
    ) { entries.onPin(!pinned) }
}

/** One conversation in the member's list: the title, who called it in, and what it is doing. */
@Composable
private fun PaneSessionRow(store: SessionStore, entries: MemberPaneEntries, session: Session, now: Long, onOpened: () -> Unit = {}) {
    val list by store.list.collectAsState()
    val colors = LocalRiffetColors.current
    val caller = remember(session, list.sessions, list.projects, list.teamMembers) {
        callerMember(session, list.sessions, list.projects, list.teamMembers.orEmpty())
    }
    val running = session.state == SessionState.RUNNING || session.state == SessionState.STARTING || session.state == SessionState.CANCELLING
    val time = relativeTimeLabel(session.lastActivityAt ?: session.createdAt, now)
    PaneRow(
        title = session.shownTitle,
        subtitle = caller?.let { listOfNotNull(stringResource(Res.string.team_called_by, it.name), time).joinToString(" · ") },
        leading = { if (caller != null) MemberAvatar(caller, 22.dp) else PaneIcon(RiffetIcons.Message) },
        trailing = when {
            session.id == entries.currentSessionId -> ({
                Text(stringResource(Res.string.team_session_current), style = LocalRiffetTypography.current.bodySmall, color = colors.fg3, maxLines = 1)
            })
            running -> ({ Spinner(size = 16.dp) })
            else -> null
        },
    ) { onOpened(); entries.onOpenSession(session) }
}

/** The member's removal, last in the panel; the default member cannot be removed. */
@Composable
internal fun MemberPaneDelete(entries: MemberPaneEntries) {
    if (entries.member.isDefault) return
    var asking by remember { mutableStateOf(false) }
    val danger = LocalRiffetColors.current.danger
    PaneGap()
    PaneSection {
        PaneRow(stringResource(Res.string.team_delete), leading = { PaneIcon(RiffetIcons.Trash, danger) }, tone = danger) { asking = true }
    }
    if (asking) ConfirmDialog(
        title = stringResource(Res.string.team_delete_title, entries.member.name),
        message = stringResource(Res.string.team_delete_message),
        confirmLabel = stringResource(Res.string.team_delete),
        danger = true,
        onConfirm = { asking = false; entries.onDelete() },
        onDismiss = { asking = false },
    )
}

/** The panel of a member's own page, which has no conversation open: the member's header and [MemberPaneRows]. */
@Composable
internal fun MemberPaneStandalone(entries: MemberPaneEntries, store: SessionStore, onClose: () -> Unit, modifier: Modifier = Modifier) {
    val member = entries.member
    Column(modifier.fillMaxHeight().background(materialContentBackground(LocalRiffetSurfaces.current.groupedPage))) {
        PaneHeader(
            title = member.name, subtitle = member.description?.takeIf { it.isNotBlank() }, onClose = onClose,
            leading = { MemberAvatar(member, MemberPaneAvatarSize) },
        )
        Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState())) {
            MemberPaneRows(entries, store)
            MemberPaneDelete(entries)
            PaneEnd()
        }
    }
}

/** The avatar beside the panel's title. */
internal val MemberPaneAvatarSize = 44.dp
