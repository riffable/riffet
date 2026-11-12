package riffet.ui.git

import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.RowScope
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import kotlinx.coroutines.flow.combine
import riffet.contracts.BranchInfo
import riffet.ui.app.LocalPageActive
import riffet.ui.app.PageStack
import riffet.ui.theme.rememberVisualHostResumed
import riffet.ui.design.AlertDialog
import riffet.ui.design.RiffetIconButton
import riffet.ui.design.RiffetTextButton
import riffet.ui.pickers.RiffetDropdownMenu
import riffet.ui.pickers.RiffetMenuItem
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.app.pageColor
import riffet.ui.app.cardColor
import riffet.ui.app.pageBackground
import androidx.compose.ui.semantics.Role
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.lazy.itemsIndexed
import riffet.ui.app.PageBarAction
import riffet.ui.app.PageTopBar
import riffet.ui.app.LocalRiffetSnackbar
import riffet.ui.app.SnackbarNotice
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import riffet.ui.icons.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import org.jetbrains.compose.resources.stringResource
import riffet_mobile.shared.generated.resources.*
import riffet.contracts.Checkpoint
import riffet.contracts.CheckpointChange
import riffet.contracts.CheckpointChangeKind
import riffet.contracts.GitDiff
import riffet.contracts.GitEntry
import riffet.contracts.GitStatus
import riffet.contracts.WorktreeInfo
import riffet.shared.CreateCheckpointRequest
import riffet.shared.CreateWorktreeRequest
import riffet.shared.RiffetApi
import riffet.shared.RiffetHttpException
import riffet.ui.files.fileBasename
import riffet.ui.files.gitStaged
import riffet.ui.files.gitUnstaged
import riffet.ui.files.tildePath
import riffet.ui.focus.blurOnTap
import riffet.ui.icons.RiffetIcons
import riffet.ui.pager.RiffetTabPager
import riffet.ui.settings.SettingsButton
import riffet.ui.settings.SettingsField
import riffet.ui.settings.SettingsNoticeKind
import riffet.ui.settings.SettingsMessageBanner
import riffet.ui.settings.SettingsSegmented
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet.ui.theme.LocalRiffetMotion
import riffet.ui.timeline.CodeBlock
import riffet.ui.timeline.DiffBlock
import riffet.ui.timeline.Spinner
import riffet.ui.timeline.formatDateTime

/*
 * The Git surface, ported from `apps/web/src/app/panels/GitPanel.tsx` with the phone's own shape:
 * four tabs, one view at a time. The views are pages of a horizontal pager ([RiffetTabPager]), so
 * the segment strip above them is only the other half of the same selection: a sideways swipe
 * changes tabs too, and a tap on the strip scrolls the pager. A commit and a file's diff are pages
 * pushed over the tabs; the controllers say which are open and this panel keeps the page stack in
 * step, so back and the edge swipe close them there.
 *
 * Two things in the web original are load-bearing and are kept exactly:
 *
 *  1. **Writes report what was observed.** `stage`/`unstage`/`commit`/`createCheckpoint`/
 *     `createWorktree`/`removeWorktree` return no payload, so "success" is never assumed from the
 *     absence of an exception. Each write is followed by a re-read, and the notice says what the
 *     re-read actually shows.
 *  2. **Checkpoint restore is guarded by the reviewed change list.** `restoreCheckpoint` takes the
 *     `expectedChanges` the reader was looking at. The server compares them with the current tree
 *     and answers `CHECKPOINT_CONFLICT` (409) if it moved on. On that answer this panel re-reads and
 *     re-presents the changes, so a stale confirmation cannot overwrite work the reader never saw.
 *
 * Every string of the panel is English in every locale, as on the other clients.
 *
 * @param sessionId attached to a checkpoint created here, exactly as the web does, and the
 *   conversation whose latest turn the Changes tab can compare with. Null is fine: checkpoints are
 *   project-scoped.
 * @param onOpenFile optional. [DiffBlock] offers to open the file it is showing; the host decides
 *   what "open" means, so the default simply ignores it.
 * @param onOpenWorktree optional. The web offers "start a session in this worktree"; the host owns
 *   navigation, so the action is only offered when the caller supplies the callback.
 * @param writeScope where stage, commit, checkpoint and worktree writes run. It must outlive this
 *   panel: a commit or a restore cancelled because the page went away has an unknown outcome on the
 *   server. Reads stay on the panel's own scope and end with it.
 */

private val GitPanelTab.id: String get() = when (this) {
    GitPanelTab.CHANGES -> "changes"
    GitPanelTab.HISTORY -> "history"
    GitPanelTab.CHECKPOINTS -> "checkpoints"
    GitPanelTab.WORKTREES -> "worktrees"
}

/** A page over the tabs: a commit, or a file's diff (from the working tree, a scope or a commit). */
internal sealed interface GitPage {
    data object Tabs : GitPage
    data class Commit(val hash: String) : GitPage
    data class Diff(val target: GitDiffTarget) : GitPage
}

/** `statusLetter` in GitPanel.tsx; `?` renders as `U` because "untracked" is what it means. */
internal fun gitStatusLetter(entry: GitEntry): String {
    val code = (if (entry.worktree != " ") entry.worktree else entry.index).trim().ifEmpty { " " }
    return when (code) {
        "?" -> "U"
        else -> code
    }
}

/** Puts the page stack in line with the pages the controllers want open, keeping what already matches. */
private fun PageStack<GitPage>.show(desired: List<GitPage>) {
    val have = entries.drop(1).map { it.route }
    var keep = 0
    while (keep < desired.size && keep < have.size && desired[keep]::class == have[keep]::class &&
        (desired[keep] !is GitPage.Commit || desired[keep] == have[keep])
    ) keep++
    while (entries.size - 1 > keep) pop()
    // A diff reloaded in place (its file's status changed) is the same page with new contents.
    if (keep > 0 && entries.last().route != desired[keep - 1]) replace(desired[keep - 1])
    for (index in keep until desired.size) push(desired[index])
}

@Composable
fun GitPanel(
    api: RiffetApi,
    projectId: String,
    sessionId: String? = null,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    onOpenFile: ((path: String, line: Int?) -> Unit)? = null,
    onOpenWorktree: ((path: String) -> Unit)? = null,
    writeScope: CoroutineScope = rememberCoroutineScope(),
) {
    val designMetrics = LocalInterfaceStyle.current.metrics
    val scope = rememberCoroutineScope()
    val controller = remember(api, projectId, sessionId) { GitPanelController(api, projectId, sessionId, scope, writeScope) }
    val history = remember(controller) { GitHistoryController(api, projectId, scope, writeScope) { controller.refreshStatus() } }
    val state by controller.state.collectAsState()
    val historyState by history.state.collectAsState()
    val tabLabels = mapOf(
        GitPanelTab.CHANGES to stringResource(Res.string.git_tab_changes),
        GitPanelTab.HISTORY to stringResource(Res.string.git_tab_history),
        GitPanelTab.CHECKPOINTS to stringResource(Res.string.git_tab_checkpoints),
        GitPanelTab.WORKTREES to stringResource(Res.string.git_tab_worktrees),
    )

    var tab by remember(projectId) { mutableStateOf(GitPanelTab.CHANGES) }
    SnackbarNotice(state.notice, controller::consumeNotice)
    DiscardedNotice(state.discarded, controller)

    // Drafts the reader is typing stay here; the controller clears them only once a write is taken.
    var commitMessage by remember(projectId) { mutableStateOf("") }
    var checkpointTitle by remember(projectId) { mutableStateOf("") }
    var worktreeBranch by remember(projectId) { mutableStateOf("") }
    var worktreeBase by remember(projectId) { mutableStateOf("") }

    // The controllers say which commit and which file are open; back and the edge swipe pop the
    // pages here, which closes them there.
    val pages = remember(projectId) { PageStack<GitPage>(GitPage.Tabs) }
    LaunchedEffect(controller, history, pages) {
        combine(
            controller.state.map { it.diffTarget }.distinctUntilChanged(),
            history.state.map { it.openCommit }.distinctUntilChanged(),
        ) { diff, commit ->
            listOfNotNull(commit?.let { GitPage.Commit(it) }, diff?.let { GitPage.Diff(it) })
        }.collect { pages.show(it) }
    }
    LaunchedEffect(controller, history, pages) {
        snapshotFlow { pages.entries.map { it.route } }.collect { stack ->
            if (stack.none { it is GitPage.Diff }) controller.closeDiff()
            if (stack.none { it is GitPage.Commit }) history.closeCommit()
        }
    }

    val pageActive = LocalPageActive.current
    LaunchedEffect(controller) { controller.refreshStatus() }
    // The server watches the files only while a stream is open.
    // and stops with the app in the background.
    val resumed = rememberVisualHostResumed()
    LaunchedEffect(controller, pageActive, resumed) { if (pageActive && resumed) controller.watchStatus() }
    // The log follows the repository: a moved branch reads it again.
    LaunchedEffect(history, state.status) { history.statusChanged() }
    LaunchedEffect(controller, history, tab) {
        controller.show(tab)
        if (tab == GitPanelTab.HISTORY) history.show()
    }

    val busy = state.busy || historyState.busy
    riffet.ui.app.PageLeaveGuard { !busy }
    riffet.ui.app.PageHost(pages, modifier) { page, back ->
        riffet.ui.app.PageLeaveGuard { !busy }
        val title = when (page) {
            is GitPage.Tabs -> stringResource(Res.string.git_title, tabLabels.getValue(tab))
            is GitPage.Commit -> page.hash.take(8)
            is GitPage.Diff -> page.target.title ?: stringResource(Res.string.git_diff_title)
        }
        Column(Modifier.fillMaxSize().pageBackground(pageColor())) {
            PageTopBar(title = title, onBack = { if (page is GitPage.Tabs) onBack() else back() }) {
                if (page is GitPage.Tabs) {
                    PageBarAction(
                        icon = RiffetIcons.Refresh,
                        description = stringResource(Res.string.git_refresh),
                        enabled = !busy,
                        onClick = {
                            controller.refresh(tab)
                            if (tab == GitPanelTab.HISTORY) history.reload()
                        },
                    )
                }
            }

            if (page is GitPage.Tabs) {
                Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)) {
                    SettingsSegmented(
                        options = GitPanelTab.entries.map { it.id to tabLabels.getValue(it) },
                        value = tab.id,
                        onSelect = { id -> GitPanelTab.entries.firstOrNull { it.id == id }?.let { tab = it } },
                    )
                }
            }

            (state.error ?: historyState.error)?.let {
                Box(Modifier.fillMaxWidth().padding(horizontal = designMetrics.pageInset)) {
                    SettingsMessageBanner(it, SettingsNoticeKind.ERROR)
                }
                Spacer(Modifier.height(8.dp))
            }
            if (LocalRiffetSnackbar.current == null) {
                state.notice?.let {
                    Box(Modifier.fillMaxWidth().padding(horizontal = designMetrics.pageInset)) {
                        SettingsMessageBanner(it, SettingsNoticeKind.SUCCESS)
                    }
                    Spacer(Modifier.height(8.dp))
                }
                state.discarded?.let { discarded ->
                    val backup = discarded.backup
                    Box(Modifier.fillMaxWidth().padding(horizontal = designMetrics.pageInset)) {
                        SettingsMessageBanner(
                            message = stringResource(Res.string.git_discarded),
                            kind = SettingsNoticeKind.SUCCESS,
                            action = backup?.let { stringResource(Res.string.git_undo) },
                            onAction = backup?.let { { controller.consumeDiscarded(discarded); controller.undoDiscard(it) } },
                        )
                    }
                    Spacer(Modifier.height(8.dp))
                }
            }

            riffet.ui.app.PageBody(Modifier.weight(1f).fillMaxWidth()) {
                when (page) {
                    is GitPage.Diff -> GitDiffPage(
                        target = page.target,
                        state = state,
                        controller = controller,
                        onOpenFile = onOpenFile,
                    )

                    is GitPage.Commit -> GitCommitPage(
                        hash = page.hash,
                        state = historyState,
                        busy = busy,
                        history = history,
                        onOpenDiff = { path -> controller.openCommitDiff(page.hash, path) },
                    )

                    // The tabs are pages of one swipe container: tapping a segment and swiping
                    // sideways change the same `tab`. The strip and the banners stay above the
                    // pager, so a swipe never carries the reader's error message away with the page.
                    is GitPage.Tabs -> key(projectId) {
                        RiffetTabPager(
                            selected = tab.ordinal,
                            onSelect = { index -> GitPanelTab.entries.getOrNull(index)?.let { tab = it } },
                            pageCount = GitPanelTab.entries.size,
                            modifier = Modifier.fillMaxSize(),
                        ) { index ->
                            when (GitPanelTab.entries[index]) {
                                GitPanelTab.CHANGES -> ChangesTab(
                                    state = state,
                                    controller = controller,
                                    commitMessage = commitMessage,
                                    onCommitMessageChange = { commitMessage = it },
                                    onCommit = { controller.commit(commitMessage) { commitMessage = "" } },
                                )

                                GitPanelTab.HISTORY -> GitHistoryTab(
                                    state = historyState,
                                    history = history,
                                    status = state.status,
                                )

                                GitPanelTab.CHECKPOINTS -> CheckpointsTab(
                                    checkpoints = state.checkpoints,
                                    busy = state.busy,
                                    checkpointTitle = checkpointTitle,
                                    onCheckpointTitleChange = { checkpointTitle = it },
                                    expandedId = state.expandedCheckpoint,
                                    changes = state.changesByCheckpoint,
                                    pendingRestore = state.pendingRestore,
                                    pendingRestoreChanges = state.pendingRestoreChanges,
                                    onCreate = { controller.createCheckpoint(checkpointTitle, sessionId) { checkpointTitle = "" } },
                                    onToggle = controller::toggleCheckpoint,
                                    onRequestRestore = controller::requestRestore,
                                    onCancelRestore = controller::cancelRestore,
                                    onConfirmRestore = controller::confirmRestore,
                                )

                                GitPanelTab.WORKTREES -> WorktreesTab(
                                    worktrees = state.worktrees,
                                    busy = state.busy,
                                    branch = worktreeBranch,
                                    base = worktreeBase,
                                    onBranchChange = { worktreeBranch = it },
                                    onBaseChange = { worktreeBase = it },
                                    pendingRemove = state.pendingRemove,
                                    onOpenWorktree = onOpenWorktree,
                                    onCreate = {
                                        controller.createWorktree(worktreeBranch, worktreeBase) {
                                            worktreeBranch = ""
                                            worktreeBase = ""
                                        }
                                    },
                                    onRequestRemove = controller::requestRemove,
                                    onCancelRemove = controller::cancelRemove,
                                    onConfirmRemove = controller::confirmRemove,
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    state.confirmDiscard?.let { path ->
        if (pageActive) riffet.ui.app.PageBackHandler { controller.cancelPermanentDiscard() }
        AlertDialog(
            onDismissRequest = controller::cancelPermanentDiscard,
            title = { Text(stringResource(Res.string.git_discard_title, fileBasename(path))) },
            text = { Text(stringResource(Res.string.git_discard_body)) },
            confirmButton = { RiffetTextButton(danger = true, onClick = controller::confirmPermanentDiscard) { Text(stringResource(Res.string.git_discard)) } },
            dismissButton = { RiffetTextButton(onClick = controller::cancelPermanentDiscard) { Text(stringResource(Res.string.git_cancel)) } },
        )
    }
}

/** Shows `Discarded` with `Undo` once per discard, over the app's snackbar. */
@Composable
private fun DiscardedNotice(discarded: GitDiscarded?, controller: GitPanelController) {
    val snackbar = LocalRiffetSnackbar.current
    val active = LocalPageActive.current
    val message = stringResource(Res.string.git_discarded)
    val undo = stringResource(Res.string.git_undo)
    LaunchedEffect(snackbar, discarded, active) {
        if (snackbar != null && discarded != null && active) {
            controller.consumeDiscarded(discarded)
            val backup = discarded.backup
            snackbar.show(message, backup?.let { undo }, onAction = { backup?.let(controller::undoDiscard) })
        }
    }
}

/** `N files`, with the singular right. */
@Composable
internal fun gitFileCount(count: Int): String =
    if (count == 1) stringResource(Res.string.git_file_one) else stringResource(Res.string.git_file_count, count)

/* --------------------------------------------------------------------------------------------- */
/* Changes                                                                                        */
/* --------------------------------------------------------------------------------------------- */

@Composable
private fun ChangesTab(
    state: GitPanelState,
    controller: GitPanelController,
    commitMessage: String,
    onCommitMessageChange: (String) -> Unit,
    onCommit: () -> Unit,
) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val status = state.status
    val busy = state.busy
    val scope = state.shownScope
    val entries = status?.entries ?: emptyList()
    val stagedCount = entries.count { gitStaged(it) }
    val unstagedCount = entries.count { gitUnstaged(it) }
    val allPaths = entries.map { it.path }
    val canCommit = commitMessage.isNotBlank() && stagedCount > 0 && !busy
    val working = scope == GitScope.UNCOMMITTED
    // `contracts` is a separate module, so a nullable property cannot be smart-cast after a null
    // check; read it into a local first.
    val added = status?.added
    val removed = status?.removed
    val scoped = state.scoped?.takeIf { it.scope == scope }
    val rows = if (working) entries.size else scoped?.files?.size ?: 0

    Column(Modifier.fillMaxSize()) {
        Row(
            modifier = Modifier.fillMaxWidth().height(40.dp).padding(horizontal = 20.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(RiffetIcons.Branch, contentDescription = null, tint = colors.fg3, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(6.dp))
            Text(status?.branch ?: "…", style = typography.monoSmall, color = colors.fg2, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Spacer(Modifier.weight(1f))
            Text(
                text = if (status == null || rows == 0) "" else gitFileCount(rows),
                style = typography.caption,
                color = colors.fg3,
                maxLines = 1,
            )
            if (working && added != null && added > 0) {
                Spacer(Modifier.width(8.dp))
                Text("+$added", style = typography.monoSmall, color = colors.success, maxLines = 1)
            }
            if (working && removed != null && removed > 0) {
                Spacer(Modifier.width(6.dp))
                Text("−$removed", style = typography.monoSmall, color = colors.danger, maxLines = 1)
            }
        }

        if (status != null) PublishRow(state.branch, busy, controller)

        if (status != null && (state.turn != null || status.base != null)) {
            Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 8.dp)) {
                SettingsSegmented(
                    options = listOfNotNull(
                        GitScope.UNCOMMITTED to stringResource(Res.string.git_scope_uncommitted),
                        if (state.turn != null) GitScope.TURN to stringResource(Res.string.git_scope_turn) else null,
                        if (status.base != null) GitScope.BRANCH to stringResource(Res.string.git_scope_branch) else null,
                    ).map { it.first.name to it.second },
                    value = scope.name,
                    onSelect = { name -> GitScope.entries.firstOrNull { it.name == name }?.let(controller::selectScope) },
                )
            }
        }

        if (working && entries.isNotEmpty()) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                SettingsButton(stringResource(Res.string.git_stage_all), onClick = { controller.stage(allPaths) }, enabled = unstagedCount > 0 && !busy)
                Spacer(Modifier.width(8.dp))
                SettingsButton(stringResource(Res.string.git_unstage_all), onClick = { controller.unstage(allPaths) }, enabled = stagedCount > 0 && !busy)
            }
        }

        when {
            status == null && !state.statusLoaded -> CenteredBox { Spinner(size = 20.dp) }

            status == null -> CenteredBox { Text(stringResource(Res.string.git_not_repo), style = typography.body, color = colors.fg3) }

            working && entries.isEmpty() -> CenteredBox { Text(stringResource(Res.string.git_clean), style = typography.body, color = colors.fg) }

            state.scopedFailed || (!working && scoped == null) -> CenteredBox {
                if (state.scopedFailed) Text(stringResource(Res.string.git_diff_failed), style = typography.body, color = colors.fg3) else Spinner(size = 20.dp)
            }

            !working && scoped != null && scoped.files.isEmpty() -> CenteredBox {
                Text(
                    text = if (scope == GitScope.TURN) stringResource(Res.string.git_no_turn_changes)
                    else stringResource(Res.string.git_no_differences, scoped.ref ?: scoped.base ?: ""),
                    style = typography.body,
                    color = colors.fg,
                )
            }

            // One list for every scope: switching scope changes its items, not the list's place in the tree.
            else -> {
                val shownEntries = if (working) entries.take(state.shownRows) else emptyList()
                val shownFiles = if (working) emptyList() else scoped?.files.orEmpty().take(state.shownRows)
                val listed = if (working) entries.size else scoped?.files?.size ?: 0
                val total = scoped?.total
                LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 12.dp)) {
                    itemsIndexed(shownEntries, key = { _, it -> "e:${it.path}:${it.index}${it.worktree}" }, contentType = { _, _ -> "row" }) { index, entry ->
                        GitEntryRow(
                            entry = entry,
                            first = index == 0,
                            last = index == shownEntries.lastIndex && shownEntries.size == entries.size,
                            busy = busy,
                            onOpen = { controller.openDiff(entry) },
                            onStage = { controller.stage(listOf(entry.path)) },
                            onUnstage = { controller.unstage(listOf(entry.path)) },
                            onDiscard = { controller.discard(entry.path) },
                        )
                    }
                    itemsIndexed(shownFiles, key = { _, it -> "s:${it.path}" }, contentType = { _, _ -> "row" }) { index, file ->
                        GitFileRow(
                            path = file.path,
                            originalPath = null,
                            letter = file.letter,
                            added = file.added,
                            removed = file.removed,
                            first = index == 0,
                            last = index == shownFiles.lastIndex && shownFiles.size == listed,
                            onOpen = { controller.openDiff(file) },
                            copyable = false,
                            onDiscard = null,
                            trailing = {},
                        )
                    }
                    val shownCount = shownEntries.size + shownFiles.size
                    if (shownCount < listed) item(key = "more", contentType = "more") { MoreFilesRow(listed - shownCount, controller::showMoreRows) }
                    if (!working && total != null && total > listed) item(key = "total", contentType = "total") {
                        Text(
                            text = stringResource(Res.string.git_files_first, listed, total),
                            style = typography.caption,
                            color = colors.fg3,
                            modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp),
                            textAlign = TextAlign.Center,
                        )
                    }
                }
            }
        }

        if (working && entries.isNotEmpty()) {
            Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                SettingsField(
                    value = commitMessage,
                    onValueChange = onCommitMessageChange,
                    placeholder = stringResource(Res.string.git_commit_placeholder),
                    enabled = !busy,
                )
                SettingsButton(
                    text = when (stagedCount) {
                        0 -> stringResource(Res.string.git_commit)
                        1 -> stringResource(Res.string.git_commit_file_one)
                        else -> stringResource(Res.string.git_commit_files, stagedCount)
                    },
                    onClick = onCommit,
                    enabled = canCommit,
                    primary = true,
                )
            }
        }
    }
}

@Composable
private fun CenteredBox(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxWidth().padding(vertical = 40.dp), contentAlignment = Alignment.Center) { content() }
}

/** `N more files`: shows the next thousand. */
@Composable
private fun MoreFilesRow(count: Int, onMore: () -> Unit) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    Box(Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = onMore).padding(vertical = 14.dp), contentAlignment = Alignment.Center) {
        Text(
            text = if (count == 1) stringResource(Res.string.git_more_file_one) else stringResource(Res.string.git_more_files, count),
            style = typography.bodySmall,
            color = colors.accent,
        )
    }
}

/** Pull when the branch is behind its upstream; Push when it has commits to give (or no upstream yet). */
@Composable
private fun PublishRow(branch: BranchInfo?, busy: Boolean, controller: GitPanelController) {
    if (branch == null) return
    val behind = branch.behind > 0
    val canPush = branch.head != null && branch.remotes.isNotEmpty() && (branch.upstream == null || branch.ahead > 0)
    if (!behind && !canPush) return
    // No upstream and several remotes (none of them origin): the reader picks where to publish.
    val choose = branch.upstream == null && branch.remotes.size > 1 && "origin" !in branch.remotes
    var menu by remember { mutableStateOf(false) }
    Row(
        modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (behind) {
            SettingsButton(stringResource(Res.string.git_pull), onClick = controller::pull, enabled = !busy)
            Spacer(Modifier.width(8.dp))
        }
        if (canPush && !choose) SettingsButton(stringResource(Res.string.git_push), onClick = { controller.push() }, enabled = !busy)
        if (canPush && choose) Box {
            SettingsButton(stringResource(Res.string.git_push_to), onClick = { menu = true }, enabled = !busy)
            RiffetDropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                branch.remotes.forEach { remote ->
                    RiffetMenuItem(text = remote, onClick = { menu = false; controller.push(remote) })
                }
            }
        }
    }
}

@Composable
private fun GitEntryRow(
    entry: GitEntry,
    first: Boolean,
    last: Boolean,
    busy: Boolean,
    onOpen: () -> Unit,
    onStage: () -> Unit,
    onUnstage: () -> Unit,
    onDiscard: () -> Unit,
) {
    GitFileRow(
        path = entry.path,
        originalPath = entry.originalPath,
        letter = gitStatusLetter(entry),
        added = entry.added,
        removed = entry.removed,
        first = first,
        last = last,
        // A collapsed untracked folder has no diff; it can still be staged or discarded.
        onOpen = if (entry.path.endsWith("/")) null else onOpen,
        copyable = true,
        onDiscard = if (busy) null else onDiscard,
        trailing = {
            if (gitUnstaged(entry)) {
                SettingsButton(stringResource(Res.string.git_stage), onClick = onStage, enabled = !busy)
            }
            if (gitStaged(entry)) {
                SettingsButton(stringResource(Res.string.git_unstage), onClick = onUnstage, enabled = !busy)
            }
        },
    )
}

/**
 * One changed file. [copyable] and [onDiscard] feed the row's menu (the ellipsis button and a long
 * press); a null [onOpen] is a row with no diff (a folder).
 */
@Composable
internal fun GitFileRow(
    path: String,
    originalPath: String?,
    letter: String,
    added: Long?,
    removed: Long?,
    first: Boolean,
    last: Boolean,
    onOpen: (() -> Unit)?,
    copyable: Boolean,
    onDiscard: (() -> Unit)?,
    trailing: @Composable RowScope.() -> Unit,
) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val clipboard = LocalClipboardManager.current
    val folder = path.endsWith("/")
    val directory = path.trimEnd('/').substringBeforeLast('/', "")
    val name = fileBasename(path.trimEnd('/'))
    val tone = when (letter) {
        "U", "A" -> colors.success
        "D" -> colors.danger
        "R" -> colors.accent
        else -> colors.warning
    }
    val hasMenu = copyable || onDiscard != null
    var menu by remember { mutableStateOf(false) }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .listCard(first, last)
            .combinedClickable(enabled = onOpen != null || hasMenu, role = Role.Button, onClick = { onOpen?.invoke() }, onLongClick = if (hasMenu) ({ menu = true }) else null)
            .height(60.dp)
            .padding(start = 12.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier.size(32.dp).clip(CircleShape).background(tone.copy(alpha = 0.14f)),
            contentAlignment = Alignment.Center,
        ) {
            if (folder) Icon(RiffetIcons.Folder, contentDescription = null, tint = tone, modifier = Modifier.size(16.dp))
            else Text(text = letter, style = typography.label, color = tone, maxLines = 1)
        }
        Spacer(Modifier.width(12.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = name,
                style = typography.bodySmall,
                color = colors.fg,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            val secondary = originalPath?.let { "$it → $path" } ?: directory
            if (secondary.isNotEmpty()) {
                Text(secondary, style = typography.monoSmall, color = colors.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        if (added != null && added > 0) {
            Text("+$added", style = typography.monoSmall, color = colors.success, maxLines = 1)
            Spacer(Modifier.width(4.dp))
        }
        if (removed != null && removed > 0) {
            Text("−$removed", style = typography.monoSmall, color = colors.danger, maxLines = 1)
            Spacer(Modifier.width(4.dp))
        }
        trailing()
        if (hasMenu) Box {
            RiffetIconButton(onClick = { menu = true }) {
                Icon(RiffetIcons.Ellipsis, contentDescription = null, tint = colors.fg3, modifier = Modifier.size(18.dp))
            }
            RiffetDropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                if (copyable) RiffetMenuItem(text = stringResource(Res.string.git_copy_path), onClick = { menu = false; clipboard.setText(AnnotatedString(path)) })
                if (onDiscard != null) RiffetMenuItem(text = stringResource(Res.string.git_discard), danger = true, onClick = { menu = false; onDiscard() })
            }
        }
    }
    if (!last) ListDivider(start = 56.dp)
}

internal val ListCorner: androidx.compose.ui.unit.Dp
    @Composable get() = LocalInterfaceStyle.current.groupRadius

/** The rows of one list read as one card: only the first and last round their outer corners. */
@Composable
internal fun Modifier.listCard(first: Boolean, last: Boolean): Modifier {
    val shape = RoundedCornerShape(
        topStart = if (first) ListCorner else 0.dp,
        topEnd = if (first) ListCorner else 0.dp,
        bottomStart = if (last) ListCorner else 0.dp,
        bottomEnd = if (last) ListCorner else 0.dp,
    )
    return clip(shape).background(cardColor())
}

@Composable
internal fun ListDivider(start: androidx.compose.ui.unit.Dp) {
    val colors = LocalRiffetColors.current
    HorizontalDivider(color = colors.line, modifier = Modifier.background(cardColor()).padding(start = start))
}

/* --------------------------------------------------------------------------------------------- */
/* Checkpoints                                                                                    */
/* --------------------------------------------------------------------------------------------- */

@Composable
private fun CheckpointsTab(
    checkpoints: List<Checkpoint>?,
    busy: Boolean,
    checkpointTitle: String,
    onCheckpointTitleChange: (String) -> Unit,
    expandedId: String?,
    changes: Map<String, List<CheckpointChange>>,
    pendingRestore: Checkpoint?,
    pendingRestoreChanges: List<CheckpointChange>,
    onCreate: () -> Unit,
    onToggle: (Checkpoint) -> Unit,
    onRequestRestore: (Checkpoint) -> Unit,
    onCancelRestore: () -> Unit,
    onConfirmRestore: () -> Unit,
) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current

    val listed = checkpoints
    Column(Modifier.fillMaxSize()) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.weight(1f)) {
                SettingsField(
                    value = checkpointTitle,
                    onValueChange = onCheckpointTitleChange,
                    placeholder = stringResource(Res.string.git_checkpoint_placeholder),
                    enabled = !busy,
                )
            }
            Spacer(Modifier.width(8.dp))
            SettingsButton(stringResource(Res.string.git_save), onClick = onCreate, enabled = !busy)
        }

        pendingRestore?.let { checkpoint ->
            Box(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)) {
                RestoreConfirmCard(
                    checkpoint = checkpoint,
                    changes = pendingRestoreChanges,
                    busy = busy,
                    onCancel = onCancelRestore,
                    onConfirm = onConfirmRestore,
                )
            }
        }

        when {
            listed == null -> Box(Modifier.fillMaxWidth().padding(vertical = 40.dp), contentAlignment = Alignment.Center) { Spinner(size = 20.dp) }

            listed.isEmpty() -> Box(Modifier.fillMaxWidth().padding(vertical = 40.dp), contentAlignment = Alignment.Center) {
                Text(stringResource(Res.string.git_no_checkpoints), style = typography.body, color = colors.fg)
            }

            else -> LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 16.dp)) {
                itemsIndexed(listed, key = { _, it -> it.id }) { index, checkpoint ->
                    CheckpointRow(
                        checkpoint = checkpoint,
                        first = index == 0,
                        last = index == listed.lastIndex,
                        expanded = expandedId == checkpoint.id,
                        changes = changes[checkpoint.id],
                        busy = busy,
                        onToggle = { onToggle(checkpoint) },
                        onRestore = { onRequestRestore(checkpoint) },
                    )
                }
            }
        }
    }
}

@Composable
private fun CheckpointRow(
    checkpoint: Checkpoint,
    first: Boolean,
    last: Boolean,
    expanded: Boolean,
    changes: List<CheckpointChange>?,
    busy: Boolean,
    onToggle: () -> Unit,
    onRestore: () -> Unit,
) {
    val motion = LocalRiffetMotion.current
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val chevron by animateFloatAsState(if (expanded) 90f else 0f, motion.spatial())

    Column(Modifier.fillMaxWidth().listCard(first, last).clickable(role = Role.Button, onClick = onToggle).padding(start = 16.dp, end = 12.dp, top = 12.dp, bottom = 12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Row(
                modifier = Modifier.weight(1f).padding(vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    RiffetIcons.ChevronRight,
                    contentDescription = null,
                    tint = colors.fg3,
                    modifier = Modifier.size(16.dp).graphicsLayer { rotationZ = chevron },
                )
                Spacer(Modifier.width(8.dp))
                Text(checkpoint.title, style = typography.body, color = colors.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            SettingsButton(stringResource(Res.string.git_restore), onClick = onRestore, enabled = !busy, danger = true)
        }
        val fileCount = gitFileCount(checkpoint.files.toInt())
        val excluded = checkpoint.excluded.takeIf { it.isNotEmpty() }?.let { stringResource(Res.string.git_excluded, it.size) }
        Text(
            text = buildString {
                formatDateTime(checkpoint.createdAt)?.let { append(it).append(" · ") }
                append(fileCount)
                if (excluded != null) append(" · ").append(excluded)
            },
            style = typography.caption,
            color = colors.fg3,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(start = 24.dp),
        )
        AnimatedVisibility(expanded, enter = motion.expandIn(), exit = motion.collapseOut()) {
            Column(Modifier.fillMaxWidth().padding(start = 24.dp, top = 6.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                val list = changes
                if (list == null) {
                    Spinner(size = 12.dp)
                } else if (list.isEmpty()) {
                    Text(stringResource(Res.string.git_same_as_worktree), style = typography.caption, color = colors.fg3)
                } else {
                    list.forEach { change ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                text = changeKindLabel(change.kind),
                                style = typography.caption,
                                color = changeKindTone(change.kind, colors.success, colors.danger, colors.warning),
                                maxLines = 1,
                                modifier = Modifier.width(36.dp),
                            )
                            Text(change.path, style = typography.monoSmall, color = colors.fg2, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
        }
    }
    if (!last) ListDivider(start = 40.dp)
}

@Composable
private fun RestoreConfirmCard(
    checkpoint: Checkpoint,
    changes: List<CheckpointChange>,
    busy: Boolean,
    onCancel: () -> Unit,
    onConfirm: () -> Unit,
) {
    val designMetrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val shape = RoundedCornerShape(LocalInterfaceStyle.current.groupRadius)

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(colors.dangerSoft)
            .padding(designMetrics.rowPadding),
    ) {
        Text(stringResource(Res.string.git_restore_title, checkpoint.title), style = typography.label, color = colors.fg)
        Spacer(Modifier.height(4.dp))
        Text(
            stringResource(Res.string.git_restore_body),
            style = typography.caption,
            color = colors.fg2,
        )
        Spacer(Modifier.height(8.dp))
        if (changes.isEmpty()) {
            Text(stringResource(Res.string.git_no_file_changes), style = typography.caption, color = colors.fg3)
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                changes.forEach { change ->
                    Column {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                text = changeKindLabel(change.kind),
                                style = typography.caption,
                                color = changeKindTone(change.kind, colors.success, colors.danger, colors.warning),
                                maxLines = 1,
                                modifier = Modifier.width(36.dp),
                            )
                            Text(change.path, style = typography.monoSmall, color = colors.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        Text(
                            text = "${change.beforeHash?.take(12) ?: "—"} → ${change.afterHash?.take(12) ?: "—"}",
                            style = typography.monoSmall,
                            color = colors.fg3,
                            maxLines = 1,
                            modifier = Modifier.padding(start = 36.dp),
                        )
                    }
                }
            }
        }
        Spacer(Modifier.height(10.dp))
        Row {
            SettingsButton(stringResource(Res.string.git_cancel), onClick = onCancel, enabled = !busy)
            Spacer(Modifier.width(8.dp))
            SettingsButton(stringResource(Res.string.git_confirm_restore), onClick = onConfirm, enabled = !busy, danger = true)
        }
    }
}

/* --------------------------------------------------------------------------------------------- */
/* Worktrees                                                                                      */
/* --------------------------------------------------------------------------------------------- */

@Composable
private fun WorktreesTab(
    worktrees: List<WorktreeInfo>?,
    busy: Boolean,
    branch: String,
    base: String,
    onBranchChange: (String) -> Unit,
    onBaseChange: (String) -> Unit,
    pendingRemove: WorktreeInfo?,
    onOpenWorktree: ((String) -> Unit)?,
    onCreate: () -> Unit,
    onRequestRemove: (WorktreeInfo) -> Unit,
    onCancelRemove: () -> Unit,
    onConfirmRemove: () -> Unit,
) {
    val designMetrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current

    val listed = worktrees
    Column(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            SettingsField(value = branch, onValueChange = onBranchChange, placeholder = stringResource(Res.string.git_new_branch), enabled = !busy)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.weight(1f)) {
                    SettingsField(value = base, onValueChange = onBaseChange, placeholder = stringResource(Res.string.git_base_optional), enabled = !busy)
                }
                Spacer(Modifier.width(8.dp))
                SettingsButton(stringResource(Res.string.git_create), onClick = onCreate, enabled = branch.isNotBlank() && !busy)
            }
        }

        pendingRemove?.let { target ->
            Box(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(LocalInterfaceStyle.current.groupRadius))
                        .background(colors.dangerSoft)
                        .padding(designMetrics.rowPadding),
                ) {
                    Text(stringResource(Res.string.git_remove_worktree_title), style = typography.label, color = colors.fg)
                    Spacer(Modifier.height(4.dp))
                    Text(stringResource(Res.string.git_remove_worktree_body), style = typography.caption, color = colors.fg2)
                    Spacer(Modifier.height(4.dp))
                    Text(tildePath(target.path), style = typography.monoSmall, color = colors.fg3, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Spacer(Modifier.height(10.dp))
                    Row {
                        SettingsButton(stringResource(Res.string.git_cancel), onClick = onCancelRemove, enabled = !busy)
                        Spacer(Modifier.width(8.dp))
                        SettingsButton(stringResource(Res.string.git_remove), onClick = onConfirmRemove, enabled = !busy, danger = true)
                    }
                }
            }
        }

        when {
            listed == null -> Box(Modifier.fillMaxWidth().padding(vertical = 40.dp), contentAlignment = Alignment.Center) { Spinner(size = 20.dp) }

            listed.isEmpty() -> Box(Modifier.fillMaxWidth().padding(vertical = 40.dp), contentAlignment = Alignment.Center) {
                Text(stringResource(Res.string.git_no_worktrees), style = typography.body, color = colors.fg3)
            }

            else -> LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 16.dp)) {
                itemsIndexed(listed, key = { _, it -> it.path }) { index, worktree ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .listCard(index == 0, index == listed.lastIndex)
                            .padding(start = 12.dp, end = 12.dp, top = 12.dp, bottom = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(
                            modifier = Modifier.size(32.dp).clip(CircleShape).background(colors.accentSoft),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(RiffetIcons.Branch, contentDescription = null, tint = colors.accent, modifier = Modifier.size(16.dp))
                        }
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(
                                    text = worktree.branch ?: stringResource(Res.string.git_detached_head),
                                    style = typography.bodySmall,
                                    color = colors.fg,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                                Spacer(Modifier.width(6.dp))
                                Text(
                                    text = worktree.head.take(8),
                                    style = typography.monoSmall,
                                    color = colors.fg3,
                                    maxLines = 1,
                                )
                            }
                            Text(
                                text = tildePath(worktree.path),
                                style = typography.monoSmall,
                                color = colors.fg3,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        if (onOpenWorktree != null && worktree.bare != true) {
                            SettingsButton(stringResource(Res.string.git_start_here), onClick = { onOpenWorktree(worktree.path) }, enabled = !busy)
                            Spacer(Modifier.width(6.dp))
                        }
                        if (worktree.bare != true) {
                            SettingsButton(stringResource(Res.string.git_remove), onClick = { onRequestRemove(worktree) }, enabled = !busy, danger = true)
                        }
                    }
                    if (index != listed.lastIndex) ListDivider(start = 56.dp)
                }
            }
        }
    }
}

/* --------------------------------------------------------------------------------------------- */
/* Helpers                                                                                        */
/* --------------------------------------------------------------------------------------------- */

@Composable
private fun changeKindLabel(kind: CheckpointChangeKind): String = when (kind) {
    CheckpointChangeKind.ADDED -> stringResource(Res.string.git_change_added)
    CheckpointChangeKind.MODIFIED -> stringResource(Res.string.git_change_modified)
    CheckpointChangeKind.DELETED -> stringResource(Res.string.git_change_deleted)
}

private fun changeKindTone(kind: CheckpointChangeKind, added: Color, deleted: Color, modified: Color): Color = when (kind) {
    CheckpointChangeKind.ADDED -> added
    CheckpointChangeKind.DELETED -> deleted
    CheckpointChangeKind.MODIFIED -> modified
}
