package riffet.ui.team

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.stringResource
import riffet.contracts.AgentMember
import riffet.shared.MemberRowMark
import riffet.shared.MemberRowState
import riffet.shared.RiffetApi
import riffet.shared.archiveTeamMember
import riffet.shared.deleteTeamMember
import riffet.shared.memberMain
import riffet.shared.memberRowState
import riffet.shared.setTeamMemberPinned
import riffet.shared.sortTeamMembers
import riffet.ui.app.LocalTabChrome
import riffet.ui.app.LocalTabContentBottomPadding
import riffet.ui.app.PageBarAction
import riffet.ui.app.RiffetPageScaffold
import riffet.ui.app.TabTopBar
import riffet.ui.design.ConfirmDialog
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.icons.RiffetIcons
import riffet.ui.pickers.RiffetDropdownMenu
import riffet.ui.pickers.RiffetMenuItem
import riffet.ui.pickers.RiffetMenuSeparator
import riffet.ui.sessionlist.activityAt
import riffet.ui.sessionlist.relativeTimeLabel
import riffet.ui.state.SessionStore
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet.ui.timeline.rememberTickingNow
import riffet_mobile.shared.generated.resources.Res
import riffet_mobile.shared.generated.resources.app_operation_failed
import riffet_mobile.shared.generated.resources.team_archive
import riffet_mobile.shared.generated.resources.team_delete
import riffet_mobile.shared.generated.resources.team_delete_message
import riffet_mobile.shared.generated.resources.team_delete_title
import riffet_mobile.shared.generated.resources.team_new_member
import riffet_mobile.shared.generated.resources.team_pin
import riffet_mobile.shared.generated.resources.team_tab
import riffet_mobile.shared.generated.resources.team_unpin

/** A row's least height and its avatar: a session row's. */
private val RowHeight = 68.dp
private val AvatarSize = 44.dp

/**
 * The 团队 tab (mobile.md §9.12): one row per member in the web sidebar's order, a chat list's rows. A row speaks for
 * one of the member's conversations and carries at most one mark.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun TeamTab(
    store: SessionStore,
    api: RiffetApi?,
    members: List<AgentMember>,
    onOpenMenu: () -> Unit,
    onOpenMember: (AgentMember) -> Unit,
    onNewMember: () -> Unit,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val list by store.list.collectAsState()
    val scope = rememberCoroutineScope()
    val sorted = remember(members) { sortTeamMembers(members) }
    val states = remember(sorted, list.projects, list.sessions) {
        sorted.associate { it.id to memberRowState(it, list.projects, list.sessions) }
    }
    // The main conversation of each continuous member: a row resting on it says what the member is for.
    val mains = remember(sorted, list.projects, list.sessions) {
        sorted.mapNotNull { member -> memberMain(member, list.projects, list.sessions)?.let { member.id to it.id } }.toMap()
    }
    val listState = rememberLazyListState()
    val now = rememberTickingNow(active = true, intervalMillis = 60_000L)

    // Tapping the current tab again returns to the top.
    val reselected = LocalTabChrome.current?.reselected ?: 0
    var seenReselected by remember { mutableIntStateOf(reselected) }
    LaunchedEffect(reselected) {
        if (reselected == seenReselected) return@LaunchedEffect
        seenReselected = reselected
        listState.animateScrollToItem(0)
    }

    var deleting by remember { mutableStateOf<AgentMember?>(null) }
    val failed = stringResource(Res.string.app_operation_failed)
    fun run(block: suspend (RiffetApi) -> Unit) {
        val client = api ?: return
        scope.launch {
            try {
                block(client)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (failure: Throwable) {
                store.reportListError(failure.message?.takeIf { it.isNotBlank() } ?: failed)
            }
        }
    }

    RiffetPageScaffold(
        modifier = Modifier.fillMaxSize(),
        topBar = {
            TabTopBar(
                title = stringResource(Res.string.team_tab),
                onOpenMenu = onOpenMenu,
                actions = { PageBarAction(RiffetIcons.Plus, stringResource(Res.string.team_new_member), onNewMember, tint = LocalRiffetColors.current.fg) },
            )
        },
    ) { insets ->
        PullToRefreshBox(isRefreshing = list.loading && list.loaded, onRefresh = { store.refresh() }, modifier = Modifier.fillMaxSize()) {
            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(top = insets.calculateTopPadding(), bottom = insets.calculateBottomPadding() + metrics.controlInset + LocalTabContentBottomPadding.current),
            ) {
                items(sorted, key = { it.id }, contentType = { "member" }) { member ->
                    MemberRow(
                        member = member,
                        state = states[member.id] ?: MemberRowState(null, MemberRowMark.NONE),
                        mainId = mains[member.id],
                        now = now,
                        onOpen = { onOpenMember(member) },
                        onPin = { pinned -> run { client -> store.applyTeamMember(client.setTeamMemberPinned(member.id, pinned)) } },
                        // Archiving is undone on the web, like a session's: no confirmation.
                        onArchive = { run { client -> store.applyTeamMember(client.archiveTeamMember(member.id)) } },
                        onDelete = { deleting = member },
                        projectName = member.takeIf { it.scope.kind == "project" }
                            ?.let { m -> list.projects.firstOrNull { it.id == m.scope.projectIds?.firstOrNull() }?.name },
                    )
                }
            }
        }
    }

    deleting?.let { member ->
        ConfirmDialog(
            title = stringResource(Res.string.team_delete_title, member.name),
            message = stringResource(Res.string.team_delete_message),
            confirmLabel = stringResource(Res.string.team_delete),
            danger = true,
            onConfirm = {
                deleting = null
                run { client -> client.deleteTeamMember(member.id); store.removeTeamMember(member.id) }
            },
            onDismiss = { deleting = null },
        )
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun MemberRow(
    member: AgentMember,
    state: MemberRowState,
    mainId: String?,
    now: Long,
    onOpen: () -> Unit,
    onPin: (Boolean) -> Unit,
    onArchive: () -> Unit,
    onDelete: () -> Unit,
    projectName: String?,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val type = LocalRiffetTypography.current
    val haptics = LocalHapticFeedback.current
    val density = LocalDensity.current
    var menuOpen by remember { mutableStateOf(false) }
    // Where the finger last went down, and the row's height: the menu opens at the touch, as on a session row.
    val press = remember { floatArrayOf(Float.NaN, 0f, 0f) }
    val session = state.session
    // A continuous member resting on its main conversation says what it is for; any other row says what was last said.
    val subtitle = when {
        session == null -> member.description.orEmpty()
        state.mark == MemberRowMark.NONE && session.id == mainId -> member.description.orEmpty()
        else -> session.shownTitle
    }
    val time = session?.let { relativeTimeLabel(activityAt(it), now) }
    val unread = state.mark == MemberRowMark.UNREAD
    val timeStyle = remember(type) { type.caption.copy(fontFeatureSettings = "tnum") }
    Box(
        Modifier.fillMaxWidth()
            .onSizeChanged { press[2] = it.height.toFloat() }
            .pointerInput(Unit) {
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                    press[0] = down.position.x
                    press[1] = down.position.y
                }
            },
    ) {
        Row(
            Modifier.fillMaxWidth()
                .padding(horizontal = metrics.controlInset * 2 / 3)
                .clip(RoundedCornerShape(LocalInterfaceStyle.current.rowRadius))
                .combinedClickable(
                    role = Role.Button,
                    onClick = onOpen,
                    onLongClick = {
                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                        menuOpen = true
                    },
                )
                .heightIn(min = RowHeight)
                .padding(horizontal = metrics.controlInset * 2 / 3, vertical = metrics.rowPadding * 5 / 8),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(metrics.controlInset),
        ) {
            MemberAvatar(member, AvatarSize)
            Column(Modifier.weight(1f)) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    // The name keeps its width; the bound project after it takes what is left.
                    Row(Modifier.weight(1f).alignByBaseline(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(
                            member.name, style = type.headline, color = colors.fg,
                            fontWeight = if (unread) FontWeight.Medium else null,
                            maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.alignByBaseline(),
                        )
                        if (projectName != null) Text(
                            projectName, style = type.caption, color = colors.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f, fill = false).alignByBaseline(),
                        )
                    }
                    if (time != null) Text(time, style = timeStyle, color = colors.fg3, maxLines = 1, modifier = Modifier.alignByBaseline())
                }
                // Without anything to say the name stands alone, centred on the avatar.
                if (subtitle.isNotEmpty() || state.mark != MemberRowMark.NONE) {
                    Row(Modifier.padding(top = 2.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(subtitle, style = type.subhead, color = colors.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                        RowMark(state.mark)
                    }
                }
            }
        }
        RiffetDropdownMenu(
            expanded = menuOpen,
            onDismissRequest = { menuOpen = false },
            // The menu hangs below the row's bottom edge: back up by the row, then down to the touch.
            offset = if (press[0].isNaN()) DpOffset(16.dp, (-8).dp) else with(density) {
                DpOffset(press[0].toDp(), (press[1] - press[2]).toDp())
            },
            modifier = Modifier.width(248.dp),
        ) {
            // What the row cuts short: the whole name and what the member is for.
            Column(Modifier.padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 4.dp)) {
                Text(member.name, style = type.body.copy(lineHeight = 22.sp), fontWeight = FontWeight.Medium, color = colors.fg, maxLines = 2, overflow = TextOverflow.Ellipsis)
                listOfNotNull(projectName, member.description?.takeIf { it.isNotBlank() }).joinToString(" · ").takeIf { it.isNotEmpty() }?.let {
                    Spacer(Modifier.height(4.dp))
                    Text(it, style = type.bodySmall, color = colors.fg2, maxLines = 3, overflow = TextOverflow.Ellipsis)
                }
            }
            RiffetMenuSeparator()
            val pinned = member.pinned == true
            RiffetMenuItem(
                text = stringResource(if (pinned) Res.string.team_unpin else Res.string.team_pin),
                icon = if (pinned) RiffetIcons.PinOff else RiffetIcons.Pin,
                onClick = { menuOpen = false; onPin(!pinned) },
            )
            // The default member is neither archived nor deleted (the server refuses both).
            if (!member.isDefault) {
                RiffetMenuItem(text = stringResource(Res.string.team_archive), icon = RiffetIcons.Archive, onClick = { menuOpen = false; onArchive() })
                RiffetMenuItem(text = stringResource(Res.string.team_delete), icon = RiffetIcons.Trash, danger = true, onClick = { menuOpen = false; onDelete() })
            }
        }
    }
}
