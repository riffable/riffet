package riffet.ui.git

import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.RowScope
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import kotlinx.coroutines.flow.combine
import riffet.contracts.BranchInfo
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.rememberUpdatedState
import riffet.ui.design.ChipButton
import riffet.ui.design.ChipItem
import riffet.ui.design.ChipRow
import riffet.ui.design.ConfirmDialog
import riffet.ui.design.GroupRow
import riffet.ui.design.RiffetCheckbox
import androidx.compose.foundation.layout.heightIn
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.SpanStyle
import riffet.ui.settings.EditPage
import riffet.ui.settings.PageBanner
import riffet.ui.settings.SettingsActionRow
import riffet.ui.settings.SettingsFootnote
import riffet.ui.settings.SettingsGroup
import riffet.ui.settings.SettingsPage
import riffet.ui.settings.SettingsValueRow
import riffet.ui.app.LocalPageActive
import riffet.ui.app.PageStack
import riffet.ui.theme.rememberVisualHostResumed
import riffet.ui.design.AlertDialog
import riffet.ui.design.RiffetIconButton
import riffet.ui.design.RiffetTextButton
import riffet.ui.pickers.RiffetDropdownMenu
import riffet.ui.pickers.RiffetMenuItem
import riffet.ui.design.EmptyState
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.app.pageColor
import riffet.ui.app.cardColor
import riffet.ui.app.pageBackground
import riffet.ui.app.coverSystemBars
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

/** A page over the tabs: a commit, a file's diff, or the detail and new pages of the checkpoint and worktree lists. */
internal sealed interface GitPage {
    data object Tabs : GitPage
    data class Commit(val hash: String) : GitPage
    data class Diff(val target: GitDiffTarget) : GitPage
    data class Checkpoint(val id: String) : GitPage
    data class Worktree(val path: String) : GitPage
    data object NewWorktree : GitPage
}

/** A one-field question asked in a dialog; the answer starts a write. */
internal sealed interface GitPrompt {
    data object NewCheckpoint : GitPrompt
    data object NewBranch : GitPrompt
    data object CheckOutRemote : GitPrompt
    data class BranchFrom(val hash: String) : GitPrompt
}

/** What the branch can publish: pull when behind, push when it has commits to give (or no upstream yet). */
private class GitPublish(val behind: Boolean, val canPush: Boolean, val remotes: List<String>, val choose: Boolean)

private fun gitPublish(branch: BranchInfo?): GitPublish {
    if (branch == null) return GitPublish(false, false, emptyList(), false)
    val canPush = branch.head != null && branch.remotes.isNotEmpty() && (branch.upstream == null || branch.ahead > 0)
    // No upstream and several remotes (none of them origin): the reader picks where to publish.
    val choose = branch.upstream == null && branch.remotes.size > 1 && "origin" !in branch.remotes
    return GitPublish(branch.behind > 0, canPush, branch.remotes, choose)
}

/** `main ↑2 ↓1`: the branch with what it is ahead of and behind its upstream. */
private fun gitBranchLine(status: GitStatus?, branch: BranchInfo?): String? {
    val name = status?.branch ?: return null
    val added = status.added
    val removed = status.removed
    return buildString {
        append(name)
        if (branch != null && branch.ahead > 0) append(" ↑").append(branch.ahead)
        if (branch != null && branch.behind > 0) append(" ↓").append(branch.behind)
        if (added != null && added > 0) append("  +").append(added)
        if (removed != null && removed > 0) append(" −").append(removed)
    }
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

    // The draft the reader is typing stays here; the controller clears it only once a write is taken.
    var commitMessage by remember(projectId) { mutableStateOf("") }
    var prompt by remember(projectId) { mutableStateOf<GitPrompt?>(null) }

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
        val gitBars = riffet.ui.app.systemBarsPadding(includeDisplayCutout = false)
        when (page) {
            is GitPage.Checkpoint -> GitCheckpointPage(page.id, state, controller, back)

            is GitPage.Worktree -> GitWorktreePage(page.path, state, controller, onOpenWorktree, back)

            is GitPage.NewWorktree -> GitNewWorktreePage(state, controller, back)

            // The page's colour reaches under the system bars, as RiffetPageScaffold's does; otherwise the pane it
            // was opened from shows through above and below it. The content keeps to the safe area.
            else -> Column(Modifier.fillMaxSize().coverSystemBars(gitBars).pageBackground(pageColor()).padding(gitBars)) {
            val title = when (page) {
                is GitPage.Commit -> page.hash.take(8)
                is GitPage.Diff -> page.target.title ?: stringResource(Res.string.git_diff_title)
                // The selected tab already names the view; the bar names the tool.
                else -> "Git"
            }
            PageTopBar(
                title = title,
                onBack = { if (page is GitPage.Tabs) onBack() else back() },
                subtitle = if (page is GitPage.Tabs) gitBranchLine(state.status, state.branch) else null,
            ) {
                when (page) {
                    is GitPage.Tabs -> GitTabActions(
                        tab = tab,
                        state = state,
                        busy = busy,
                        controller = controller,
                        history = history,
                        onPrompt = { prompt = it },
                        onNewWorktree = { pages.push(GitPage.NewWorktree) },
                    )

                    is GitPage.Commit -> {
                        val hash = historyState.detail?.takeIf { it.hash == page.hash }?.hash
                        if (hash != null) GitCommitActions(hash, busy) { prompt = GitPrompt.BranchFrom(hash) }
                    }

                    else -> Unit
                }
            }

            if (page is GitPage.Tabs) {
                riffet.ui.design.ViewTabs(
                    labels = GitPanelTab.entries.map { tabLabels.getValue(it) },
                    selected = GitPanelTab.entries.indexOf(tab),
                    onSelect = { index -> tab = GitPanelTab.entries[index] },
                )
                Spacer(Modifier.height(designMetrics.controlInset / 2))
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
                        onOpenDiff = { path -> controller.openCommitDiff(page.hash, path) },
                    )

                    // The tabs are pages of one swipe container: tapping a segment and swiping
                    // sideways change the same `tab`. The strip and the banners stay above the
                    // pager, so a swipe never carries the reader's error message away with the page.
                    else -> key(projectId) {
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
                                    onCheckOutRemote = { prompt = GitPrompt.CheckOutRemote },
                                )

                                GitPanelTab.CHECKPOINTS -> CheckpointsTab(
                                    checkpoints = state.checkpoints,
                                    onOpen = { pages.push(GitPage.Checkpoint(it.id)) },
                                    onNew = { prompt = GitPrompt.NewCheckpoint },
                                )

                                GitPanelTab.WORKTREES -> WorktreesTab(
                                    worktrees = state.worktrees,
                                    onOpen = { pages.push(GitPage.Worktree(it.path)) },
                                    onNew = { pages.push(GitPage.NewWorktree) },
                                )
                            }
                        }
                    }
                }
            }
            }
        }
    }

    when (val asked = prompt) {
        null -> Unit

        GitPrompt.NewCheckpoint -> GitTextPrompt(
            title = stringResource(Res.string.gitp_new_checkpoint),
            placeholder = stringResource(Res.string.git_checkpoint_placeholder),
            confirm = stringResource(Res.string.git_save),
            required = false,
            onConfirm = { prompt = null; controller.createCheckpoint(it, sessionId) },
            onDismiss = { prompt = null },
        )

        GitPrompt.NewBranch -> GitTextPrompt(
            title = stringResource(Res.string.gitp_new_branch),
            placeholder = stringResource(Res.string.git_branch_name),
            confirm = stringResource(Res.string.git_create_switch),
            onConfirm = { prompt = null; history.createBranch(it) },
            onDismiss = { prompt = null },
        )

        GitPrompt.CheckOutRemote -> GitTextPrompt(
            title = stringResource(Res.string.gitp_checkout_remote_title),
            placeholder = stringResource(Res.string.git_remote_branch),
            confirm = stringResource(Res.string.git_check_out),
            onConfirm = { prompt = null; history.checkOutRemote(it) },
            onDismiss = { prompt = null },
        )

        is GitPrompt.BranchFrom -> GitTextPrompt(
            title = stringResource(Res.string.gitp_new_branch),
            placeholder = stringResource(Res.string.git_branch_name),
            confirm = stringResource(Res.string.git_create_switch),
            onConfirm = { prompt = null; history.createBranch(it, base = asked.hash) },
            onDismiss = { prompt = null },
        )
    }

    state.confirmDiscard?.let { path ->
        if (pageActive) riffet.ui.app.PageBackHandler { controller.cancelPermanentDiscard() }
        ConfirmDialog(
            title = stringResource(Res.string.git_discard_title, fileBasename(path)),
            message = stringResource(Res.string.git_discard_body),
            confirmLabel = stringResource(Res.string.git_discard),
            danger = true,
            onConfirm = controller::confirmPermanentDiscard,
            onDismiss = controller::cancelPermanentDiscard,
        )
    }
}

/** The bar's tools for a tab: the add action of the list below, then the low-frequency ones in the menu. */
@Composable
private fun RowScope.GitTabActions(
    tab: GitPanelTab,
    state: GitPanelState,
    busy: Boolean,
    controller: GitPanelController,
    history: GitHistoryController,
    onPrompt: (GitPrompt) -> Unit,
    onNewWorktree: () -> Unit,
) {
    val publish = gitPublish(state.branch)
    val entries = state.status?.entries ?: emptyList()
    val allPaths = entries.map { it.path }
    val working = state.shownScope == GitScope.UNCOMMITTED
    val canStage = working && !busy && entries.any { gitUnstaged(it) }
    val canUnstage = working && !busy && entries.any { gitStaged(it) }
    when (tab) {
        GitPanelTab.CHANGES -> Unit
        GitPanelTab.HISTORY -> PageBarAction(RiffetIcons.Plus, stringResource(Res.string.gitp_new_branch), { onPrompt(GitPrompt.NewBranch) }, enabled = !busy)
        GitPanelTab.CHECKPOINTS -> PageBarAction(RiffetIcons.Plus, stringResource(Res.string.gitp_new_checkpoint), { onPrompt(GitPrompt.NewCheckpoint) }, enabled = !busy)
        GitPanelTab.WORKTREES -> PageBarAction(RiffetIcons.Plus, stringResource(Res.string.gitp_new_worktree), onNewWorktree, enabled = !busy)
    }
    if (busy) riffet.ui.app.PageBarProgress()
    riffet.ui.app.PageMoreAction { close ->
        if (tab == GitPanelTab.CHANGES) {
            RiffetMenuItem(text = stringResource(Res.string.git_stage_all), enabled = canStage, onClick = { close(); controller.stage(allPaths) })
            RiffetMenuItem(text = stringResource(Res.string.git_unstage_all), enabled = canUnstage, onClick = { close(); controller.unstage(allPaths) })
            if (publish.behind) RiffetMenuItem(text = stringResource(Res.string.git_pull), enabled = !busy, onClick = { close(); controller.pull() })
            if (publish.canPush && !publish.choose) RiffetMenuItem(text = stringResource(Res.string.git_push), enabled = !busy, onClick = { close(); controller.push() })
            if (publish.canPush && publish.choose) publish.remotes.forEach { remote ->
                RiffetMenuItem(text = stringResource(Res.string.gitp_push_to_remote, remote), enabled = !busy, onClick = { close(); controller.push(remote) })
            }
        }
        if (tab == GitPanelTab.CHANGES || tab == GitPanelTab.HISTORY) {
            RiffetMenuItem(text = stringResource(Res.string.git_fetch), enabled = !busy, onClick = { close(); history.fetch() })
        }
        if (tab == GitPanelTab.HISTORY) {
            RiffetMenuItem(text = stringResource(Res.string.git_checkout_remote), enabled = !busy, onClick = { close(); onPrompt(GitPrompt.CheckOutRemote) })
        }
        RiffetMenuItem(text = stringResource(Res.string.git_refresh), enabled = !busy, onClick = {
            close()
            controller.refresh(tab)
            if (tab == GitPanelTab.HISTORY) history.reload()
        })
    }
}

/** A commit page's tools: Copy Hash and a branch starting at it. */
@Composable
private fun RowScope.GitCommitActions(hash: String, busy: Boolean, onNewBranch: () -> Unit) {
    val clipboard = LocalClipboardManager.current
    riffet.ui.app.PageMoreAction { close ->
        RiffetMenuItem(text = stringResource(Res.string.git_copy_hash), onClick = { close(); clipboard.setText(AnnotatedString(hash)) })
        RiffetMenuItem(text = stringResource(Res.string.git_new_branch_here), enabled = !busy, onClick = { close(); onNewBranch() })
    }
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
    val canCommit = commitMessage.isNotBlank() && stagedCount > 0 && !busy
    val working = scope == GitScope.UNCOMMITTED
    var filter by remember { mutableStateOf("all") }
    var scopeMenu by remember { mutableStateOf(false) }
    val visible = remember(entries, filter) {
        when (filter) {
            "staged" -> entries.filter { gitStaged(it) }
            "unstaged" -> entries.filter { gitUnstaged(it) }
            else -> entries
        }
    }
    val scoped = state.scoped?.takeIf { it.scope == scope }
    val hasScopes = status != null && (state.turn != null || status.base != null)
    val showChips = status != null && (hasScopes || (working && entries.isNotEmpty()))
    val scopeLabel = when (scope) {
        GitScope.UNCOMMITTED -> stringResource(Res.string.git_scope_uncommitted)
        GitScope.TURN -> stringResource(Res.string.git_scope_turn)
        GitScope.BRANCH -> stringResource(Res.string.git_scope_branch)
    }

    Column(Modifier.fillMaxSize()) {
        if (showChips) ChipRow(
            items = if (working && entries.isNotEmpty()) listOf(
                ChipItem("all", stringResource(Res.string.git_history_all), entries.size),
                ChipItem("staged", stringResource(Res.string.git_diff_staged), stagedCount),
                ChipItem("unstaged", stringResource(Res.string.git_diff_unstaged), unstagedCount),
            ) else emptyList(),
            selected = filter,
            onSelect = { filter = it },
            leading = if (hasScopes) ({
                Box {
                    ChipButton(label = scopeLabel, active = !working, onClick = { scopeMenu = true })
                    RiffetDropdownMenu(expanded = scopeMenu, onDismissRequest = { scopeMenu = false }) {
                        RiffetMenuItem(onClick = { scopeMenu = false; controller.selectScope(GitScope.UNCOMMITTED) }, selected = working, showCheck = true) { Text(stringResource(Res.string.git_scope_uncommitted), style = typography.body, color = colors.fg) }
                        if (state.turn != null) RiffetMenuItem(onClick = { scopeMenu = false; controller.selectScope(GitScope.TURN) }, selected = scope == GitScope.TURN, showCheck = true) { Text(stringResource(Res.string.git_scope_turn), style = typography.body, color = colors.fg) }
                        if (status?.base != null) RiffetMenuItem(onClick = { scopeMenu = false; controller.selectScope(GitScope.BRANCH) }, selected = scope == GitScope.BRANCH, showCheck = true) { Text(stringResource(Res.string.git_scope_branch), style = typography.body, color = colors.fg) }
                    }
                }
            }) else null,
        )

        when {
            status == null && !state.statusLoaded -> CenteredBox { Spinner(size = 20.dp) }

            status == null -> CenteredBox { Text(stringResource(Res.string.git_not_repo), style = typography.body, color = colors.fg3) }

            working && entries.isEmpty() -> CenteredBox { Text(stringResource(Res.string.git_clean), style = typography.body, color = colors.fg) }

            working && visible.isEmpty() -> CenteredBox { Text(stringResource(Res.string.gitp_no_files), style = typography.body, color = colors.fg3) }

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
                val shownEntries = if (working) visible.take(state.shownRows) else emptyList()
                val shownFiles = if (working) emptyList() else scoped?.files.orEmpty().take(state.shownRows)
                val listed = if (working) visible.size else scoped?.files?.size ?: 0
                val total = scoped?.total
                LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 12.dp)) {
                    itemsIndexed(shownEntries, key = { _, it -> "e:${it.path}:${it.index}${it.worktree}" }, contentType = { _, _ -> "row" }) { index, entry ->
                        GitEntryRow(
                            entry = entry,
                            first = index == 0,
                            last = index == shownEntries.lastIndex && shownEntries.size == visible.size,
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
                    modifier = Modifier.fillMaxWidth(),
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
        // One control per row: checked when everything of the file is staged; a half-staged file
        // reads unchecked and stages the rest.
        trailing = {
            RiffetCheckbox(
                checked = gitStaged(entry) && !gitUnstaged(entry),
                onCheckedChange = { on -> if (on) onStage() else onUnstage() },
                enabled = !busy,
            )
        },
    )
}

/**
 * One changed file. [copyable] and [onDiscard] feed the row's long-press menu; a null [onOpen] is
 * a row with no diff (a folder). [trailing] is the row's one control.
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

    val metrics = LocalInterfaceStyle.current.metrics
    Box {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .listCard(first, last)
                .combinedClickable(enabled = onOpen != null || hasMenu, role = Role.Button, onClick = { onOpen?.invoke() }, onLongClick = if (hasMenu) ({ menu = true }) else null)
                .heightIn(min = metrics.controlHeight + metrics.controlInset * 2 / 3)
                .padding(start = metrics.rowPadding, end = metrics.controlInset / 3),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(metrics.controlInset),
        ) {
            // The status as a coloured letter in a fixed column, as Git clients list it; no badge.
            Box(Modifier.width(metrics.smallIconSize), contentAlignment = Alignment.Center) {
                if (folder) Icon(RiffetIcons.Folder, contentDescription = null, tint = tone, modifier = Modifier.size(metrics.smallIconSize * 0.85f))
                else Text(text = letter, style = typography.monoSmall, color = tone, maxLines = 1)
            }
            Column(modifier = Modifier.weight(1f).padding(vertical = metrics.controlInset / 3)) {
                Text(text = name, style = typography.bodySmall, color = colors.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                val secondary = originalPath?.let { "$it → $path" } ?: directory
                if (secondary.isNotEmpty()) {
                    Text(secondary, style = typography.caption, color = colors.fg3, maxLines = 1, overflow = TextOverflow.StartEllipsis)
                }
            }
            val stats = buildAnnotatedString {
                if (added != null && added > 0) withStyle(SpanStyle(color = colors.success)) { append("+$added") }
                if (removed != null && removed > 0) {
                    if (length > 0) append(" ")
                    withStyle(SpanStyle(color = colors.danger)) { append("−$removed") }
                }
            }
            if (stats.isNotEmpty()) Text(stats, style = typography.caption.copy(fontFeatureSettings = "tnum"), maxLines = 1)
            trailing()
        }
        if (hasMenu) RiffetDropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            if (copyable) RiffetMenuItem(text = stringResource(Res.string.git_copy_path), onClick = { menu = false; clipboard.setText(AnnotatedString(path)) })
            if (onDiscard != null) RiffetMenuItem(text = stringResource(Res.string.git_discard), danger = true, onClick = { menu = false; onDiscard() })
        }
    }
    if (!last) ListDivider(start = LocalInterfaceStyle.current.metrics.let { it.rowPadding + it.smallIconSize + it.controlInset })
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
/* Checkpoints and worktrees                                                                      */
/* --------------------------------------------------------------------------------------------- */

/** A list row that opens a page: a mark, a title, one line under it and the chevron. */
@Composable
private fun GitListRow(
    first: Boolean,
    last: Boolean,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    title: String,
    subtitle: String,
    monoSubtitle: Boolean,
    onClick: () -> Unit,
) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .listCard(first, last)
            .clickable(role = Role.Button, onClick = onClick)
            .height(60.dp)
            .padding(start = 12.dp, end = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier.size(32.dp).clip(CircleShape).background(colors.accentSoft),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, contentDescription = null, tint = colors.accent, modifier = Modifier.size(16.dp))
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(title, style = typography.bodySmall, color = colors.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(subtitle, style = if (monoSubtitle) typography.monoSmall else typography.caption, color = colors.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Spacer(Modifier.width(8.dp))
        Icon(RiffetIcons.ChevronRight, contentDescription = null, tint = colors.fg3, modifier = Modifier.size(16.dp))
    }
    if (!last) ListDivider(start = LocalInterfaceStyle.current.metrics.let { it.rowPadding + it.smallIconSize + it.controlInset })
}

@Composable
private fun CheckpointsTab(checkpoints: List<Checkpoint>?, onOpen: (Checkpoint) -> Unit, onNew: () -> Unit) {
    when {
        checkpoints == null -> CenteredBox { Spinner(size = 20.dp) }

        checkpoints.isEmpty() -> EmptyState(stringResource(Res.string.git_no_checkpoints), actions = { RiffetTextButton(onClick = onNew) { Text(stringResource(Res.string.gitp_new_checkpoint)) } })

        else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 16.dp)) {
            itemsIndexed(checkpoints, key = { _, it -> it.id }) { index, checkpoint ->
                val fileCount = gitFileCount(checkpoint.files.toInt())
                val excluded = checkpoint.excluded.takeIf { it.isNotEmpty() }?.let { stringResource(Res.string.git_excluded, it.size) }
                GitListRow(
                    first = index == 0,
                    last = index == checkpoints.lastIndex,
                    icon = RiffetIcons.Archive,
                    title = checkpoint.title,
                    subtitle = buildString {
                        formatDateTime(checkpoint.createdAt)?.let { append(it).append(" · ") }
                        append(fileCount)
                        if (excluded != null) append(" · ").append(excluded)
                    },
                    monoSubtitle = false,
                    onClick = { onOpen(checkpoint) },
                )
            }
        }
    }
}

@Composable
private fun WorktreesTab(worktrees: List<WorktreeInfo>?, onOpen: (WorktreeInfo) -> Unit, onNew: () -> Unit) {
    when {
        worktrees == null -> CenteredBox { Spinner(size = 20.dp) }

        worktrees.isEmpty() -> EmptyState(stringResource(Res.string.git_no_worktrees), actions = { RiffetTextButton(onClick = onNew) { Text(stringResource(Res.string.gitp_new_worktree)) } })

        else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 16.dp)) {
            itemsIndexed(worktrees, key = { _, it -> it.path }) { index, worktree ->
                GitListRow(
                    first = index == 0,
                    last = index == worktrees.lastIndex,
                    icon = RiffetIcons.Branch,
                    title = worktree.branch ?: stringResource(Res.string.git_detached_head),
                    subtitle = tildePath(worktree.path),
                    monoSubtitle = true,
                    onClick = { onOpen(worktree) },
                )
            }
        }
    }
}

/** The error of the last write, where the reader is looking when it happens. */
@Composable
private fun ColumnScope.GitErrorBanner(message: String?) {
    if (message != null) PageBanner(message, SettingsNoticeKind.ERROR)
}

/** A confirmation whose back press closes the dialog, not the page under it. */
@Composable
private fun GitConfirm(title: String, message: String?, confirmLabel: String, enabled: Boolean = true, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    if (LocalPageActive.current) riffet.ui.app.PageBackHandler { onDismiss() }
    ConfirmDialog(title = title, confirmLabel = confirmLabel, onConfirm = onConfirm, onDismiss = onDismiss, message = message, danger = true, enabled = enabled)
}

/** A checkpoint: what it holds, what a restore would change, and Restore at the bottom. */
@Composable
private fun GitCheckpointPage(id: String, state: GitPanelState, controller: GitPanelController, onBack: () -> Unit) {
    val checkpoint = state.checkpoints?.firstOrNull { it.id == id }
    val changes = state.changesByCheckpoint[id]
    val latest by rememberUpdatedState(state)
    val missing = checkpoint == null && state.checkpoints != null
    LaunchedEffect(missing) { if (missing) onBack() }
    // The list a restore is guarded by is read here, so the reader sees what the confirmation covers.
    LaunchedEffect(id, checkpoint != null, changes == null) {
        val target = checkpoint
        if (target != null && changes == null && latest.expandedCheckpoint != id) controller.toggleCheckpoint(target)
    }
    DisposableEffect(id) {
        onDispose {
            val open = latest.checkpoints?.firstOrNull { it.id == id }
            if (open != null && latest.expandedCheckpoint == id) controller.toggleCheckpoint(open)
        }
    }

    SettingsPage(title = checkpoint?.title ?: "", onBack = onBack, actions = { if (state.busy) riffet.ui.app.PageBarProgress() }) {
        GitErrorBanner(state.error)
        if (checkpoint != null) {
            SettingsGroup(title = "") {
                formatDateTime(checkpoint.createdAt)?.let { SettingsValueRow(stringResource(Res.string.gitp_created), it) }
                SettingsValueRow(stringResource(Res.string.gitp_files), gitFileCount(checkpoint.files.toInt()))
                if (checkpoint.excluded.isNotEmpty()) SettingsValueRow(stringResource(Res.string.gitp_excluded_label), "${checkpoint.excluded.size}")
            }
            SettingsGroup(title = stringResource(Res.string.gitp_changes_on_restore)) {
                when {
                    changes == null -> Box(Modifier.fillMaxWidth().padding(vertical = 16.dp), contentAlignment = Alignment.Center) { Spinner(size = 18.dp) }

                    changes.isEmpty() -> GroupRow(title = stringResource(Res.string.git_same_as_worktree))

                    else -> changes.take(GitChangeListCap).forEach { change ->
                        GroupRow(
                            title = fileBasename(change.path),
                            subtitle = change.path.substringBeforeLast('/', "").ifEmpty { null },
                            value = changeKindLabel(change.kind),
                        )
                    }
                }
            }
            if (changes != null && changes.size > GitChangeListCap) {
                SettingsFootnote(stringResource(Res.string.git_more_files, changes.size - GitChangeListCap))
            }
            SettingsGroup(title = "") {
                SettingsActionRow(
                    title = stringResource(Res.string.git_restore),
                    danger = true,
                    enabled = !state.busy && changes != null,
                    onClick = { controller.requestRestore(checkpoint) },
                )
            }
            state.pendingRestore?.takeIf { it.id == id }?.let { pending ->
                GitConfirm(
                    title = stringResource(Res.string.git_restore_title, pending.title),
                    message = stringResource(Res.string.git_restore_body),
                    confirmLabel = stringResource(Res.string.git_confirm_restore),
                    enabled = !state.busy,
                    onConfirm = controller::confirmRestore,
                    onDismiss = controller::cancelRestore,
                )
            }
        }
    }
}

private const val GitChangeListCap = 100

/** A worktree: where it is, Start here, and Remove at the bottom. */
@Composable
private fun GitWorktreePage(
    path: String,
    state: GitPanelState,
    controller: GitPanelController,
    onOpenWorktree: ((String) -> Unit)?,
    onBack: () -> Unit,
) {
    val worktree = state.worktrees?.firstOrNull { it.path == path }
    val missing = worktree == null && state.worktrees != null
    LaunchedEffect(missing) { if (missing) onBack() }
    var confirm by remember { mutableStateOf(false) }
    val detached = stringResource(Res.string.git_detached_head)

    SettingsPage(title = worktree?.let { it.branch ?: detached } ?: "", onBack = onBack, actions = { if (state.busy) riffet.ui.app.PageBarProgress() }) {
        GitErrorBanner(state.error)
        if (worktree != null) {
            SettingsGroup(title = "") {
                SettingsValueRow(stringResource(Res.string.gitp_branch), worktree.branch ?: detached, mono = true)
                SettingsValueRow(stringResource(Res.string.git_head), worktree.head.take(8), mono = true)
                SettingsValueRow(stringResource(Res.string.gitp_path), tildePath(worktree.path), mono = true)
            }
            if (onOpenWorktree != null && worktree.bare != true) SettingsGroup(title = "") {
                SettingsActionRow(title = stringResource(Res.string.git_start_here), enabled = !state.busy, onClick = { onOpenWorktree(worktree.path) })
            }
            if (worktree.bare != true) SettingsGroup(title = "") {
                SettingsActionRow(title = stringResource(Res.string.gitp_remove_worktree), danger = true, enabled = !state.busy, onClick = { confirm = true })
            }
            if (confirm) GitConfirm(
                title = stringResource(Res.string.gitp_remove_worktree_title, worktree.branch ?: detached),
                message = stringResource(Res.string.git_remove_worktree_body),
                confirmLabel = stringResource(Res.string.git_remove),
                onConfirm = { confirm = false; controller.requestRemove(worktree); controller.confirmRemove() },
                onDismiss = { confirm = false },
            )
        }
    }
}

/** A new worktree: the branch it is on and, optionally, what it starts from. */
@Composable
private fun GitNewWorktreePage(state: GitPanelState, controller: GitPanelController, onBack: () -> Unit) {
    val metrics = LocalInterfaceStyle.current.metrics
    var branch by remember { mutableStateOf("") }
    var base by remember { mutableStateOf("") }
    // The create call reports success while it is still busy refreshing the list, so the guard
    // would refuse an ordinary back; leave as a confirmed save instead.
    val pageBack = riffet.ui.app.LocalPageBack.current
    EditPage(
        title = stringResource(Res.string.gitp_new_worktree),
        onBack = onBack,
        dirty = branch.isNotBlank() || base.isNotBlank(),
        busy = state.busy,
        canSave = branch.isNotBlank(),
        saveLabel = stringResource(Res.string.git_create),
        onSave = { controller.createWorktree(branch, base) { pageBack?.leaveConfirmed() ?: onBack() } },
    ) {
        GitErrorBanner(state.error)
        SettingsGroup(title = stringResource(Res.string.git_new_branch)) {
            riffet.ui.design.GroupField(value = branch, onValueChange = { branch = it }, enabled = !state.busy, mono = true)
        }
        SettingsGroup(title = stringResource(Res.string.git_base_optional)) {
            riffet.ui.design.GroupField(value = base, onValueChange = { base = it }, enabled = !state.busy, mono = true)
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
