package riffet.ui.git

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
 * The Git surface, ported from `apps/web/src/app/panels/GitPanel.tsx` (301 lines) with the phone's
 * own shape: three tabs, one view at a time, inline confirmation instead of a modal. The three views
 * are pages of a horizontal pager ([RiffetTabPager]), so the segment strip above them is only the
 * other half of the same selection: a sideways swipe changes tabs too, and a tap on the strip
 * scrolls the pager. A horizontal drag inside a page now belongs to the pager rather than to the
 * workbench's drawer gesture underneath it.
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
 * The per-line diff renderer is the transcript's own [DiffBlock]; nothing new is written for it.
 *
 * @param sessionId attached to a checkpoint created here, exactly as the web does. Null is fine:
 *   checkpoints are project-scoped.
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
    GitPanelTab.CHECKPOINTS -> "checkpoints"
    GitPanelTab.WORKTREES -> "worktrees"
}

/** `statusLetter` in GitPanel.tsx; `?` renders as `U` because "untracked" is what it means. */
internal fun gitStatusLetter(entry: GitEntry): String {
    val code = (if (entry.worktree != " ") entry.worktree else entry.index).trim().ifEmpty { " " }
    return when (code) {
        "?" -> "U"
        else -> code
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
    val colors = LocalRiffetColors.current
    val scope = rememberCoroutineScope()
    val controller = remember(api, projectId) { GitPanelController(api, projectId, scope, writeScope) }
    val state by controller.state.collectAsState()
    val tabLabels = mapOf(
        GitPanelTab.CHANGES to stringResource(Res.string.git_tab_changes),
        GitPanelTab.CHECKPOINTS to stringResource(Res.string.git_tab_checkpoints),
        GitPanelTab.WORKTREES to "Worktree",
    )

    var tab by remember(projectId) { mutableStateOf(GitPanelTab.CHANGES) }
    SnackbarNotice(state.notice, controller::consumeNotice)

    // Drafts the reader is typing stay here; the controller clears them only once a write is taken.
    var commitMessage by remember(projectId) { mutableStateOf("") }
    var checkpointTitle by remember(projectId) { mutableStateOf("") }
    var worktreeBranch by remember(projectId) { mutableStateOf("") }
    var worktreeBase by remember(projectId) { mutableStateOf("") }

    // The diff is a page over the tabs. The controller says which file is open; back and the edge
    // swipe pop the page here, which closes it there.
    val pages = remember(projectId) { riffet.ui.app.PageStack<GitEntry?>(null) }
    LaunchedEffect(controller, pages) {
        controller.state.map { it.diffEntry }.distinctUntilChanged().collect { entry ->
            when {
                entry == null -> if (pages.canPop) pages.pop()
                pages.current == null -> pages.push(entry)
                else -> pages.replace(entry)
            }
        }
    }
    LaunchedEffect(controller, pages) {
        snapshotFlow { pages.current }.collect { if (it == null) controller.closeDiff() }
    }

    LaunchedEffect(controller) { controller.refreshStatus() }
    LaunchedEffect(controller, tab) { controller.show(tab) }

    riffet.ui.app.PageLeaveGuard { !state.busy }
    riffet.ui.app.PageHost(pages, modifier) { page, back ->
        riffet.ui.app.PageLeaveGuard { !state.busy }
        val selected = page
        val busy = state.busy
        val title = if (selected != null) stringResource(Res.string.git_diff_title) else stringResource(Res.string.git_title, tabLabels.getValue(tab))
        Column(modifier = Modifier.fillMaxSize().pageBackground(pageColor())) {
            PageTopBar(title = title, onBack = { if (selected != null) back() else onBack() }) {
                if (selected == null) {
                    PageBarAction(
                        icon = RiffetIcons.Refresh,
                        description = stringResource(Res.string.git_refresh),
                        enabled = !busy,
                        onClick = { controller.refresh(tab) },
                    )
                }
            }

            Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)) {
                if (selected == null) {
                    SettingsSegmented(
                        options = GitPanelTab.entries.map { it.id to tabLabels.getValue(it) },
                        value = tab.id,
                        onSelect = { id -> GitPanelTab.entries.firstOrNull { it.id == id }?.let { tab = it } },
                    )
                }
            }

            state.error?.let {
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
            }

            val entry = selected
            riffet.ui.app.PageBody(Modifier.weight(1f).fillMaxWidth()) {
                if (entry != null) {
                    Column(Modifier.fillMaxSize()) {
                        DiffView(
                            entry = entry,
                            diff = state.diff,
                            loading = state.diffLoading,
                            busy = busy,
                            staged = state.diffStaged,
                            onOpenFile = onOpenFile,
                            onStage = { controller.stage(listOf(entry.path)) },
                            onUnstage = { controller.unstage(listOf(entry.path)) },
                        )
                    }
                } else {
                    // The three bodies are pages of one swipe container now: tapping a segment and swiping
                    // sideways change the same `tab`. The strip and the banners stay above the pager, so a
                    // swipe never carries the reader's error message away with the page.
                    key(projectId) {
                        RiffetTabPager(
                            selected = tab.ordinal,
                            onSelect = { page -> GitPanelTab.entries.getOrNull(page)?.let { tab = it } },
                            pageCount = GitPanelTab.entries.size,
                            modifier = Modifier.fillMaxSize(),
                        ) { page ->
                            when (GitPanelTab.entries[page]) {
                                GitPanelTab.CHANGES -> ChangesTab(
                                    status = state.status,
                                    statusLoaded = state.statusLoaded,
                                    busy = busy,
                                    commitMessage = commitMessage,
                                    onCommitMessageChange = { commitMessage = it },
                                    onOpenDiff = controller::openDiff,
                                    onStage = controller::stage,
                                    onUnstage = controller::unstage,
                                    onCommit = { controller.commit(commitMessage) { commitMessage = "" } },
                                )

                                GitPanelTab.CHECKPOINTS -> CheckpointsTab(
                                    checkpoints = state.checkpoints,
                                    busy = busy,
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
                                    busy = busy,
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
}

/* --------------------------------------------------------------------------------------------- */
/* Changes                                                                                        */
/* --------------------------------------------------------------------------------------------- */

@Composable
private fun ChangesTab(
    status: GitStatus?,
    statusLoaded: Boolean,
    busy: Boolean,
    commitMessage: String,
    onCommitMessageChange: (String) -> Unit,
    onOpenDiff: (GitEntry) -> Unit,
    onStage: (List<String>) -> Unit,
    onUnstage: (List<String>) -> Unit,
    onCommit: () -> Unit,
) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val entries = status?.entries ?: emptyList()
    val stagedCount = entries.count { gitStaged(it) }
    val unstagedCount = entries.count { gitUnstaged(it) }
    val allPaths = entries.map { it.path }
    val canCommit = commitMessage.isNotBlank() && stagedCount > 0 && !busy
    // `contracts` is a separate module, so a nullable property cannot be smart-cast after a null
    // check; read it into a local first.
    val added = status?.added
    val removed = status?.removed

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
                text = if (status == null) "" else if (entries.isEmpty()) stringResource(Res.string.git_no_changes) else stringResource(Res.string.git_file_count, entries.size),
                style = typography.caption,
                color = colors.fg3,
                maxLines = 1,
            )
            if (added != null && added > 0) {
                Spacer(Modifier.width(8.dp))
                Text("+$added", style = typography.monoSmall, color = colors.success, maxLines = 1)
            }
            if (removed != null && removed > 0) {
                Spacer(Modifier.width(6.dp))
                Text("−$removed", style = typography.monoSmall, color = colors.danger, maxLines = 1)
            }
        }

        if (entries.isNotEmpty()) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                SettingsButton(stringResource(Res.string.git_stage_all), onClick = { onStage(allPaths) }, enabled = unstagedCount > 0 && !busy)
                Spacer(Modifier.width(8.dp))
                SettingsButton(stringResource(Res.string.git_unstage_all), onClick = { onUnstage(allPaths) }, enabled = stagedCount > 0 && !busy)
            }
        }

        when {
            status == null && !statusLoaded -> Box(Modifier.fillMaxWidth().padding(vertical = 40.dp), contentAlignment = Alignment.Center) {
                Spinner(size = 20.dp)
            }

            status == null -> Box(Modifier.fillMaxWidth().padding(vertical = 40.dp), contentAlignment = Alignment.Center) {
                Text(stringResource(Res.string.git_not_repo), style = typography.body, color = colors.fg3)
            }

            entries.isEmpty() -> Box(Modifier.fillMaxWidth().padding(vertical = 40.dp), contentAlignment = Alignment.Center) {
                Text(stringResource(Res.string.git_clean), style = typography.body, color = colors.fg)
            }

            else -> LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 12.dp)) {
                itemsIndexed(entries, key = { _, it -> "${it.path}:${it.index}${it.worktree}" }) { index, entry ->
                    GitEntryRow(
                        entry = entry,
                        first = index == 0,
                        last = index == entries.lastIndex,
                        busy = busy,
                        onOpen = { onOpenDiff(entry) },
                        onStage = { onStage(listOf(entry.path)) },
                        onUnstage = { onUnstage(listOf(entry.path)) },
                    )
                }
            }
        }

        if (entries.isNotEmpty()) {
            Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                SettingsField(
                    value = commitMessage,
                    onValueChange = onCommitMessageChange,
                    placeholder = stringResource(Res.string.git_commit_placeholder),
                    enabled = !busy,
                )
                SettingsButton(
                    text = if (stagedCount > 0) stringResource(Res.string.git_commit_files, stagedCount) else stringResource(Res.string.git_commit),
                    onClick = onCommit,
                    enabled = canCommit,
                    primary = true,
                )
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
) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val staged = gitStaged(entry)
    val unstaged = gitUnstaged(entry)
    val directory = entry.path.substringBeforeLast('/', "")
    val letter = gitStatusLetter(entry)
    // Cross-module nullable properties do not smart-cast; read them once.
    val added = entry.added
    val removed = entry.removed
    val tone = when (letter) {
        "U", "A" -> colors.success
        "D" -> colors.danger
        "R" -> colors.accent
        else -> colors.warning
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .listCard(first, last)
            .clickable(onClick = onOpen)
            .height(60.dp)
            .padding(start = 12.dp, end = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier.size(32.dp).clip(CircleShape).background(tone.copy(alpha = 0.14f)),
            contentAlignment = Alignment.Center,
        ) {
            Text(text = letter, style = typography.label, color = tone, maxLines = 1)
        }
        Spacer(Modifier.width(12.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = fileBasename(entry.path),
                style = typography.bodySmall,
                color = colors.fg,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            val secondary = entry.originalPath?.let { "$it → ${entry.path}" } ?: directory
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
        if (unstaged) {
            SettingsButton(stringResource(Res.string.git_stage), onClick = onStage, enabled = !busy)
            Spacer(Modifier.width(4.dp))
        }
        if (staged) {
            SettingsButton(stringResource(Res.string.git_unstage), onClick = onUnstage, enabled = !busy)
            Spacer(Modifier.width(4.dp))
        }
    }
    if (!last) ListDivider(start = 56.dp)
}

private val ListCorner: androidx.compose.ui.unit.Dp
    @Composable get() = LocalInterfaceStyle.current.groupRadius

/** The rows of one list read as one card: only the first and last round their outer corners. */
@Composable
private fun Modifier.listCard(first: Boolean, last: Boolean): Modifier {
    val shape = RoundedCornerShape(
        topStart = if (first) ListCorner else 0.dp,
        topEnd = if (first) ListCorner else 0.dp,
        bottomStart = if (last) ListCorner else 0.dp,
        bottomEnd = if (last) ListCorner else 0.dp,
    )
    return clip(shape).background(cardColor())
}

@Composable
private fun ListDivider(start: androidx.compose.ui.unit.Dp) {
    val colors = LocalRiffetColors.current
    HorizontalDivider(color = colors.line, modifier = Modifier.background(cardColor()).padding(start = start))
}

@Composable
private fun DiffView(
    entry: GitEntry,
    diff: GitDiff?,
    loading: Boolean,
    busy: Boolean,
    staged: Boolean,
    onOpenFile: ((String, Int?) -> Unit)?,
    onStage: () -> Unit,
    onUnstage: () -> Unit,
) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val stagedNow = gitStaged(entry)
    val unstagedNow = gitUnstaged(entry)

    Column(Modifier.fillMaxSize()) {
        Text(
            text = tildePath(entry.path),
            style = typography.monoSmall,
            color = colors.fg2,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
        )
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (unstagedNow) SettingsButton(stringResource(Res.string.git_stage), onClick = onStage, enabled = !busy)
            if (unstagedNow && stagedNow) Spacer(Modifier.width(8.dp))
            if (stagedNow) SettingsButton(stringResource(Res.string.git_unstage_staged), onClick = onUnstage, enabled = !busy)
        }
        Spacer(Modifier.height(8.dp))
        when {
            loading -> Box(Modifier.fillMaxWidth().padding(vertical = 40.dp), contentAlignment = Alignment.Center) { Spinner(size = 20.dp) }
            diff == null -> Box(Modifier.fillMaxWidth().padding(vertical = 40.dp), contentAlignment = Alignment.Center) {
                Text(stringResource(Res.string.git_diff_failed), style = typography.body, color = colors.fg3)
            }
            else -> {
                Column(Modifier.weight(1f).fillMaxWidth().blurOnTap().verticalScroll(rememberScrollState()).padding(horizontal = 12.dp)) {
                    if (diff.binary) {
                        Text(stringResource(Res.string.git_binary), style = typography.caption, color = colors.fg3)
                        Spacer(Modifier.height(6.dp))
                        CodeBlock(text = diff.patch.ifBlank { stringResource(Res.string.git_binary) })
                    } else {
                        if (diff.truncated == true) {
                            // The server trimmed before/after; the reader must know the diff is partial.
                            SettingsMessageBanner(stringResource(Res.string.git_diff_truncated), SettingsNoticeKind.INFO)
                            Spacer(Modifier.height(8.dp))
                        }
                        DiffBlock(
                            path = null,
                            before = diff.before,
                            after = diff.after,
                            lineOffset = 0,
                            trailingLines = 0,
                            onOpenFile = { path, line -> onOpenFile?.invoke(path, line) },
                        )
                    }
                    Spacer(Modifier.height(16.dp))
                }
            }
        }
    }
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
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(stringResource(Res.string.git_no_checkpoints), style = typography.body, color = colors.fg)
                    Spacer(Modifier.height(2.dp))
                    Text(stringResource(Res.string.git_checkpoints_hint), style = typography.caption, color = colors.fg3)
                }
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
        val fileCount = stringResource(Res.string.git_file_count, checkpoint.files)
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
                        SettingsButton(stringResource(Res.string.git_confirm_remove), onClick = onConfirmRemove, enabled = !busy, danger = true)
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
