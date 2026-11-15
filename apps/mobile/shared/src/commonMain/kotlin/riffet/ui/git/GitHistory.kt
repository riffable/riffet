package riffet.ui.git

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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import org.jetbrains.compose.resources.stringResource
import riffet.contracts.GitCommit
import riffet.contracts.GitRefKind
import riffet.contracts.GitRefLabel
import riffet.contracts.GitStatus
import riffet.ui.app.LocalPageActive
import riffet.ui.design.AlertDialog
import riffet.ui.design.ChipButton
import riffet.ui.design.ChipItem
import riffet.ui.design.ChipRow
import riffet.ui.design.RiffetTextButton
import riffet.ui.icons.Icon
import riffet.ui.icons.RiffetIcons
import riffet.ui.pickers.RiffetDropdownMenu
import riffet.ui.pickers.RiffetMenuItem
import riffet.ui.settings.SettingsButton
import riffet.ui.settings.SettingsField
import riffet.ui.settings.SettingsSegmented
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet.ui.timeline.Spinner
import riffet.ui.timeline.formatDateTime
import riffet.ui.timeline.instantMillis
import riffet.ui.timeline.platformNowMillis
import riffet_mobile.shared.generated.resources.*

private val HistoryRowHeight = 52.dp

/** The History tab: the branch menu and the Current / All filter in one strip, then the commit list with its graph. */
@Composable
internal fun GitHistoryTab(state: GitHistoryState, history: GitHistoryController, status: GitStatus?, onCheckOutRemote: () -> Unit) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val busy = state.busy
    val refs = state.refs
    var menu by remember { mutableStateOf(false) }
    // Not a repository: the Changes tab says so; there is no history to show.
    val lanes = remember(state.rows) { (state.rows.maxOfOrNull { it.width } ?: 1).coerceIn(1, GitMaxLanes) }
    val now = remember(state.commits) { platformNowMillis() }

    Column(Modifier.fillMaxSize()) {
        ChipRow(
            items = listOf(ChipItem("current", stringResource(Res.string.git_history_current)), ChipItem("all", stringResource(Res.string.git_history_all))),
            selected = if (state.all) "all" else "current",
            onSelect = { history.setAll(it == "all") },
            leading = {
                Box {
                    ChipButton(
                        label = refs?.head ?: status?.branch ?: stringResource(Res.string.git_head),
                        active = false,
                        onClick = { if (!busy) menu = true },
                        icon = RiffetIcons.Branch,
                    )
                    RiffetDropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        refs?.branches?.forEach { branch ->
                            RiffetMenuItem(
                                onClick = { menu = false; history.switchTo(branch.name) },
                                selected = branch.current == true,
                                showCheck = true,
                                enabled = branch.elsewhere != true,
                            ) { Text(branch.name, style = typography.body, color = colors.fg, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                        }
                        if (refs != null && refs.remoteCount <= GIT_REMOTES_IN_MENU) {
                            refs.remotes.take(GIT_REMOTES_IN_MENU).forEach { remote ->
                                RiffetMenuItem(onClick = { menu = false; history.checkOutRemote(remote.name) }) {
                                    Text(remote.name, style = typography.body, color = colors.fg2, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                }
                            }
                        }
                        if (refs != null && refs.remoteCount > GIT_REMOTES_IN_MENU) {
                            RiffetMenuItem(text = stringResource(Res.string.git_checkout_remote), onClick = { menu = false; onCheckOutRemote() })
                        }
                    }
                }
            },
        )

        when {
            !state.loaded -> Box(Modifier.fillMaxWidth().padding(vertical = 40.dp), contentAlignment = Alignment.Center) { Spinner(size = 20.dp) }

            state.commits.isEmpty() -> Box(Modifier.fillMaxWidth().padding(vertical = 40.dp), contentAlignment = Alignment.Center) {
                Text(stringResource(Res.string.git_no_commits), style = typography.body, color = colors.fg3)
            }

            else -> {
                val list = rememberLazyListState()
                // The next page is read when the last rows come into view.
                val nearEnd by remember { derivedStateOf { list.layoutInfo.let { it.totalItemsCount > 0 && (it.visibleItemsInfo.lastOrNull()?.index ?: 0) >= it.totalItemsCount - 15 } } }
                LaunchedEffect(nearEnd, state.commits.size, state.more) { if (nearEnd) history.loadMore() }
                LazyColumn(Modifier.weight(1f), state = list, contentPadding = PaddingValues(bottom = 12.dp)) {
                    itemsIndexed(state.commits, key = { _, commit -> commit.hash }) { index, commit ->
                        GitCommitRow(commit, state.rows.getOrNull(index), lanes, now, onOpen = { history.openCommit(commit.hash) })
                    }
                    if (state.loadingMore) item(key = "loading") {
                        Box(Modifier.fillMaxWidth().padding(vertical = 16.dp), contentAlignment = Alignment.Center) { Spinner(size = 16.dp) }
                    }
                }
            }
        }
    }
}

@Composable
private fun GitCommitRow(commit: GitCommit, graph: riffet.shared.GitGraphRow?, lanes: Int, now: Long, onOpen: () -> Unit) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    Row(
        modifier = Modifier.fillMaxWidth().height(HistoryRowHeight).clickable(role = Role.Button, onClick = onOpen).padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (graph != null) GitGraphCell(graph, lanes, HistoryRowHeight) else Spacer(Modifier.width(GitLaneWidth * lanes))
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                commit.refs.take(2).forEach { ref ->
                    GitRefChip(ref)
                    Spacer(Modifier.width(4.dp))
                }
                Text(commit.subject, style = typography.bodySmall, color = colors.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            }
            Text(
                text = listOf(commit.author, gitAgo(commit.date, now)).filter { it.isNotEmpty() }.joinToString(" · "),
                style = typography.caption,
                color = colors.fg3,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/** A name on a commit: the checked-out branch stands out, tags and remotes recede. */
@Composable
private fun GitRefChip(ref: GitRefLabel) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val emphasised = ref.current == true || ref.kind == GitRefKind.HEAD
    Text(
        text = ref.name,
        style = typography.monoSmall,
        color = if (emphasised) colors.accent else colors.fg3,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier
            .clip(RoundedCornerShape(4.dp))
            .background(if (emphasised) colors.accentSoft else colors.bgMuted)
            .padding(horizontal = 5.dp, vertical = 1.dp),
    )
}

/** A commit as a page: its message, who and when, the hash, and the files it changed (Copy Hash and New Branch from Here are in the bar). */
@Composable
internal fun GitCommitPage(
    hash: String,
    state: GitHistoryState,
    onOpenDiff: (String) -> Unit,
) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val detail = state.detail?.takeIf { it.hash == hash }

    if (detail == null) {
        Box(Modifier.fillMaxSize().padding(vertical = 40.dp), contentAlignment = Alignment.TopCenter) { Spinner(size = 20.dp) }
    } else {
        val total = detail.filesTotal
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 16.dp)) {
            item(key = "header") {
                Column(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(detail.subject, style = typography.body, color = colors.fg)
                    if (detail.body.isNotBlank()) Text(detail.body.trim(), style = typography.bodySmall, color = colors.fg2)
                    Text(
                        text = listOfNotNull(detail.author.takeIf { it.isNotEmpty() }, formatDateTime(detail.date)).joinToString(" · "),
                        style = typography.caption,
                        color = colors.fg3,
                    )
                    Text(detail.hash.take(8), style = typography.monoSmall, color = colors.fg2)
                    Spacer(Modifier.height(4.dp))
                }
            }
            itemsIndexed(detail.files, key = { _, file -> file.path }) { index, file ->
                GitFileRow(
                    path = file.path,
                    originalPath = file.originalPath,
                    letter = file.status.take(1).uppercase().ifEmpty { "M" },
                    added = file.added,
                    removed = file.removed,
                    first = index == 0,
                    last = index == detail.files.lastIndex,
                    onOpen = { onOpenDiff(file.path) },
                    copyable = true,
                    onDiscard = null,
                    trailing = {},
                )
            }
            if (total != null && total > detail.files.size) item(key = "total") {
                Text(
                    text = stringResource(Res.string.git_files_first, detail.files.size, total),
                    style = typography.caption,
                    color = colors.fg3,
                    modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp),
                    textAlign = TextAlign.Center,
                )
            }
        }
    }
}

/** A dialog asking for one line of text; a blank answer is allowed only when [required] is false. */
@Composable
internal fun GitTextPrompt(title: String, placeholder: String, confirm: String, onConfirm: (String) -> Unit, onDismiss: () -> Unit, required: Boolean = true) {
    var text by remember { mutableStateOf("") }
    val pageActive = LocalPageActive.current
    if (pageActive) riffet.ui.app.PageBackHandler { onDismiss() }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { SettingsField(value = text, onValueChange = { text = it }, placeholder = placeholder, mono = true) },
        confirmButton = { RiffetTextButton(enabled = !required || text.isNotBlank(), onClick = { onConfirm(text.trim()) }) { Text(confirm) } },
        dismissButton = { RiffetTextButton(onClick = onDismiss) { Text(stringResource(Res.string.git_cancel)) } },
    )
}

/** A short English age: `now`, `5m`, `3h`, `2d`, `4mo`, `1y`; empty when the date cannot be read. */
private fun gitAgo(date: String, now: Long): String {
    val at = instantMillis(date) ?: return ""
    val minutes = (now - at).coerceAtLeast(0L) / 60_000L
    return when {
        minutes < 1L -> "now"
        minutes < 60L -> "${minutes}m"
        minutes < 1_440L -> "${minutes / 60L}h"
        minutes < 43_200L -> "${minutes / 1_440L}d"
        minutes < 525_600L -> "${minutes / 43_200L}mo"
        else -> "${minutes / 525_600L}y"
    }
}
