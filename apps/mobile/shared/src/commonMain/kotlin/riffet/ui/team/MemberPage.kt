package riffet.ui.team

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import org.jetbrains.compose.resources.stringResource
import riffet.contracts.AgentMember
import riffet.contracts.NativeBackendId
import riffet.contracts.Project
import riffet.contracts.Session
import riffet.shared.MemberRowMark
import riffet.shared.RiffetApi
import riffet.shared.callerMember
import riffet.shared.memberSessions
import riffet.ui.app.PageBarAction
import riffet.ui.app.RiffetPageScaffold
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.StyleTopBar
import riffet.ui.focus.blurOnTap
import riffet.ui.home.AssistantHomeParts
import riffet.ui.home.MemberComposer
import riffet.ui.home.memberSettings
import riffet.ui.home.rememberMemberConfig
import riffet.ui.icons.RiffetIcons
import riffet.ui.sessionlist.TimeBucketLabel
import riffet.ui.sessionlist.activityAt
import riffet.ui.sessionlist.isUnread
import riffet.ui.sessionlist.dayTimeLabel
import riffet.ui.sessionlist.timeBands
import riffet.ui.state.SessionStore
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet.ui.timeline.localDayStart
import riffet.ui.timeline.rememberTickingNow
import riffet.contracts.SessionState
import riffet_mobile.shared.generated.resources.Res
import riffet_mobile.shared.generated.resources.app_back
import riffet_mobile.shared.generated.resources.session_info_actions
import riffet_mobile.shared.generated.resources.team_called_by
import riffet_mobile.shared.generated.resources.team_initiator_auto
import riffet_mobile.shared.generated.resources.team_initiator_you

/**
 * A member's own page (mobile.md §9.12): for a `fresh` member its conversations by day above a composer that starts a
 * new one with each send, for a `continuous` member with no main conversation yet the assistant's empty state. A
 * conversation the composer makes comes back through [onOpenSession].
 */
@Composable
internal fun MemberPage(
    store: SessionStore,
    api: RiffetApi?,
    member: AgentMember,
    project: Project?,
    onBack: () -> Unit,
    onOpenPanel: () -> Unit,
    onOpenSession: (Session) -> Unit,
    onStarted: (NativeBackendId, String?, String) -> Unit,
) {
    val list by store.list.collectAsState()
    val config = rememberMemberConfig(api, member.id)
    val settings = remember(list.settings, config.backends, member.target) { memberSettings(list.settings, member, config.backends) }
    if (project != null) LaunchedEffect(config, project.id, settings, list.backendRevision) { config.sync(project.id, settings, list.backendRevision) }
    val projectName = member.takeIf { it.scope.kind == "project" }
        ?.let { m -> list.projects.firstOrNull { it.id == m.scope.projectIds?.firstOrNull() }?.name }
    RiffetPageScaffold(
        modifier = Modifier.fillMaxSize().blurOnTap(),
        topBar = { MemberBar(member, projectName, onBack, onOpenPanel) },
    ) { insets ->
        if (project != null) MemberComposer(
            store = store, api = api, project = project, config = config,
            parts = AssistantHomeParts(
                cards = {}, onStarted = onStarted, member = member,
                docked = if (member.continuous) null else { padding -> MemberSessions(store, member, padding) { onOpenSession(it) } },
            ),
            onOpenSession = onOpenSession,
            contentPadding = insets,
        )
    }
}

/** Back, the member's small avatar and name (a bound project after it), then the panel. */
@Composable
internal fun MemberBar(member: AgentMember, projectName: String?, onBack: (() -> Unit)?, onOpenPanel: () -> Unit) {
    val colors = LocalRiffetColors.current
    val type = LocalRiffetTypography.current
    val metrics = LocalInterfaceStyle.current.metrics
    StyleTopBar(
        title = {
            Row(horizontalArrangement = Arrangement.spacedBy(metrics.controlInset / 2), verticalAlignment = Alignment.CenterVertically) {
                MemberAvatar(member, 28.dp)
                Text(member.name, style = type.headline, color = colors.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                if (projectName != null) Text(projectName, style = type.caption, color = colors.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false))
            }
        },
        navigation = { if (onBack != null) PageBarAction(RiffetIcons.ArrowLeft, stringResource(Res.string.app_back), onBack) },
        actions = { PageBarAction(RiffetIcons.ChevronRight, stringResource(Res.string.session_info_actions), onOpenPanel, tint = colors.fg2) },
    )
}

/** The page head (a large avatar, what the member is for) and its conversations under day labels. */
@Composable
private fun MemberSessions(store: SessionStore, member: AgentMember, padding: PaddingValues, onOpen: (Session) -> Unit) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val type = LocalRiffetTypography.current
    val list by store.list.collectAsState()
    val now = rememberTickingNow(active = true, intervalMillis = 60_000L)
    val dayStart = localDayStart(now)
    val bands = remember(member, list.sessions, dayStart) { timeBands(memberSessions(member, list.sessions), dayStart) }
    // Who called each conversation in, worked out once for the page: a row reads its own entry, not the whole list.
    val callers = remember(bands, list.sessions, list.projects, list.teamMembers) {
        val members = list.teamMembers.orEmpty()
        bands.flatMap { it.sessions }.associate { session ->
            session.id to Caller(
                callerMember(session, list.sessions, list.projects, members),
                session.origin?.takeIf { it.kind == "call" }?.sessionId?.let { id -> list.sessions.firstOrNull { it.id == id }?.shownTitle },
            )
        }
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(top = padding.calculateTopPadding(), bottom = metrics.controlInset)) {
        item(key = "head", contentType = "head") {
            Column(
                Modifier.fillMaxWidth().padding(horizontal = metrics.pageInset, vertical = metrics.controlInset),
                horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(metrics.controlInset),
            ) {
                MemberAvatar(member, 64.dp)
                val description = member.description.orEmpty()
                if (description.isNotBlank()) Text(description, style = type.subhead, color = colors.fg3, textAlign = TextAlign.Center)
            }
        }
        bands.forEach { band ->
            item(key = "band:${band.label}", contentType = "band") { TimeBucketLabel(band, dayStart) }
            items(band.sessions, key = { it.id }, contentType = { "session" }) { session ->
                MemberSessionRow(session, callers[session.id], now, dayStart) { onOpen(session) }
            }
        }
    }
}

/** Who called a conversation in: the calling member, else the calling conversation's title. */
private class Caller(val member: AgentMember?, val sessionTitle: String?)

@Composable
private fun MemberSessionRow(session: Session, called: Caller?, now: Long, dayStart: Long, onOpen: () -> Unit) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val type = LocalRiffetTypography.current
    val caller = called?.member
    val mark = when {
        session.state == SessionState.WAITING -> MemberRowMark.WAITING
        session.state == SessionState.RUNNING || session.state == SessionState.STARTING || session.state == SessionState.CANCELLING -> MemberRowMark.RUNNING
        isUnread(session) -> MemberRowMark.UNREAD
        else -> MemberRowMark.NONE
    }
    val initiator = when {
        caller != null -> stringResource(Res.string.team_called_by, caller.name)
        session.origin?.kind == "call" -> stringResource(Res.string.team_called_by, called?.sessionTitle.orEmpty())
        session.origin?.kind in AUTOMATIC_ORIGINS -> stringResource(Res.string.team_initiator_auto)
        else -> stringResource(Res.string.team_initiator_you)
    }
    // When it began and when it last moved, like the reader's clock: today's rows by the time of day.
    val created = dayTimeLabel(session.createdAt, now, dayStart)
    Row(
        Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = onOpen)
            .heightIn(min = metrics.controlHeight + metrics.controlInset)
            .padding(horizontal = metrics.pageInset, vertical = metrics.rowPadding / 2),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(metrics.controlInset),
    ) {
        Column(Modifier.weight(1f)) {
            Text(session.shownTitle, style = type.headline, color = colors.fg, maxLines = 1, overflow = TextOverflow.Ellipsis,
                fontWeight = if (mark == MemberRowMark.UNREAD) FontWeight.Medium else null)
            Row(horizontalArrangement = Arrangement.spacedBy(metrics.controlInset / 3), verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(top = metrics.hairlineWidth * 2)) {
                if (caller != null) MemberAvatar(caller, 16.dp)
                Text(listOfNotNull(initiator, created).joinToString(" · "), style = type.subhead, color = colors.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        if (mark != MemberRowMark.NONE) RowMark(mark)
        else dayTimeLabel(activityAt(session), now, dayStart)?.let { Text(it, style = type.caption.copy(fontFeatureSettings = "tnum"), color = colors.fg3, maxLines = 1) }
    }
}

/** Conversations that start themselves: a schedule, a template, an automation, the assistant's own runs. */
private val AUTOMATIC_ORIGINS = setOf("automation", "schedule", "template")
