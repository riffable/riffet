package riffet.ui.git

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.withContext
import riffet.shared.gitPatchChunks
import riffet.contracts.BranchInfo
import riffet.contracts.Checkpoint
import riffet.contracts.CheckpointChange
import riffet.contracts.CheckpointChangeKind
import riffet.contracts.GitDiff
import riffet.contracts.GitEntry
import riffet.contracts.GitLineChange
import riffet.contracts.GitStatus
import riffet.contracts.WorktreeInfo
import riffet.shared.CreateCheckpointRequest
import riffet.shared.CreateWorktreeRequest
import riffet.shared.RiffetApi
import riffet.shared.RiffetHttpException
import riffet.ui.files.gitStaged
import riffet.ui.files.gitUnstaged
import riffet.shared.checkpointChanges
import riffet.shared.checkpoints
import riffet.shared.commit
import riffet.shared.createCheckpoint
import riffet.shared.createWorktree
import riffet.shared.gitBranch
import riffet.shared.gitCompare
import riffet.shared.gitDiff
import riffet.shared.gitDiscard
import riffet.shared.gitLines
import riffet.shared.gitPull
import riffet.shared.gitPush
import riffet.shared.gitStatus
import riffet.shared.gitStatusStream
import riffet.shared.sessionCheckpoints
import riffet.i18n.L10n
import riffet.shared.removeWorktree
import riffet.shared.restoreCheckpoint
import riffet.shared.stage
import riffet.shared.unstage
import riffet.shared.worktrees

/** The Git panel's views; each list is read the first time its view is shown. */
enum class GitPanelTab { CHANGES, HISTORY, CHECKPOINTS, WORKTREES }

/** One row of a rendered patch: a hunk header, a line, or the actions of the changed run that starts below. */
sealed interface GitPatchRow {
    data class Hunk(val text: String) : GitPatchRow
    data class Line(val sign: Char, val text: String) : GitPatchRow
    data class Actions(val change: GitLineChange) : GitPatchRow
}

/** The patch's rows; when [editable], each changed run gets its actions in front of it. */
internal fun patchRows(patch: String, editable: Boolean): List<GitPatchRow> {
    val chunks = if (editable) gitPatchChunks(patch).associate { it.patchLine to it.change } else emptyMap()
    val rows = mutableListOf<GitPatchRow>()
    var inHunk = false
    // The patch ends with a newline; the empty piece after it is not a line.
    val lines = patch.split('\n').let { if (it.lastOrNull() == "") it.dropLast(1) else it }
    lines.forEachIndexed { index, line ->
        if (line.startsWith("@@")) {
            inHunk = true
            rows += GitPatchRow.Hunk(line)
            return@forEachIndexed
        }
        if (!inHunk) return@forEachIndexed
        chunks[index]?.let { rows += GitPatchRow.Actions(it) }
        rows += when {
            line.startsWith("+") -> GitPatchRow.Line('+', line.drop(1))
            line.startsWith("-") -> GitPatchRow.Line('-', line.drop(1))
            line.startsWith("\\") -> GitPatchRow.Line('\\', line)
            else -> GitPatchRow.Line(' ', line.drop(1))
        }
    }
    return rows
}

/** What the Changes list compares the working tree with. */
enum class GitScope { UNCOMMITTED, TURN, BRANCH }

/**
 * A file's diff on show. [entry] is set for the working tree's own list, the only diffs whose lines
 * can be staged; [base] is `checkpoint:<id>` or the branch's base, [commit] a commit's own change.
 */
data class GitDiffTarget(
    val path: String,
    val entry: GitEntry? = null,
    val base: String? = null,
    val commit: String? = null,
    val title: String? = null,
)

/** One row of a This Turn or Branch list; [letter] is the A/M/D/R status. */
data class GitScopedFile(val path: String, val letter: String, val added: Long?, val removed: Long?)

/** [total] is set when the server listed fewer files than changed. */
data class GitScopedList(
    val scope: GitScope,
    val files: List<GitScopedFile> = emptyList(),
    val total: Long? = null,
    val base: String? = null,
    val ref: String? = null,
)

/** A discard that can be taken back: [backup] is null when nothing could be saved first. [id] makes each one distinct. */
data class GitDiscarded(val id: Long, val backup: Checkpoint?)

/** Rows of the Changes list shown before "N more files"; each step shows this many more. */
const val GIT_ROWS_SHOWN = 300
const val GIT_ROWS_STEP = 1000

/** Everything the Git panel renders; see [GitPanelController]. */
data class GitPanelState(
    val status: GitStatus? = null,
    val statusLoaded: Boolean = false,
    /** True while a write (or a restore preview) is in flight; every write control waits on it. */
    val busy: Boolean = false,
    val error: String? = null,
    val notice: String? = null,
    /** The file whose diff is open, or null while the tab list shows. */
    val diffTarget: GitDiffTarget? = null,
    /** Whether the open diff is the index's (staged) side. */
    val diffStaged: Boolean = false,
    val diff: GitDiff? = null,
    /** [diff]'s patch laid out as rows, prepared off the main thread when the diff arrives. */
    val diffRows: List<GitPatchRow>? = null,
    val diffLoading: Boolean = false,
    val checkpoints: List<Checkpoint>? = null,
    val expandedCheckpoint: String? = null,
    val changesByCheckpoint: Map<String, List<CheckpointChange>> = emptyMap(),
    /** The checkpoint awaiting confirmation, with the change list the reader is confirming. */
    val pendingRestore: Checkpoint? = null,
    val pendingRestoreChanges: List<CheckpointChange> = emptyList(),
    val worktrees: List<WorktreeInfo>? = null,
    val pendingRemove: WorktreeInfo? = null,
    val changesScope: GitScope = GitScope.UNCOMMITTED,
    /** The newest checkpoint of the conversation: where its current turn started. */
    val turn: Checkpoint? = null,
    val scoped: GitScopedList? = null,
    val scopedFailed: Boolean = false,
    val shownRows: Int = GIT_ROWS_SHOWN,
    val branch: BranchInfo? = null,
    val discarded: GitDiscarded? = null,
    /** The file whose discard the server could not back up, awaiting the reader's word. */
    val confirmDiscard: String? = null,
) {
    /** The scope the list actually shows: a scope that no longer applies falls back to the working tree. */
    val shownScope: GitScope
        get() = when {
            changesScope == GitScope.TURN && turn != null -> GitScope.TURN
            changesScope == GitScope.BRANCH && status?.base != null -> GitScope.BRANCH
            else -> GitScope.UNCOMMITTED
        }
}

/**
 * The Git panel's reads and writes for one project, ported from `apps/web/src/app/panels/GitPanel.tsx`.
 *
 * Two things in the web original are load-bearing and are kept exactly:
 *
 *  1. **Writes report what was observed.** `stage`/`unstage`/`commit`/`createCheckpoint`/
 *     `createWorktree`/`removeWorktree` return no payload, so "success" is never assumed from the
 *     absence of an exception. Each write is followed by a re-read, and the notice says what the
 *     re-read actually shows.
 *  2. **Checkpoint restore is guarded by the reviewed change list.** `restoreCheckpoint` takes the
 *     `expectedChanges` the reader was looking at. The server compares them with the current tree
 *     and answers `CHECKPOINT_CONFLICT` (409) if it moved on. On that answer this re-reads and
 *     re-presents the changes, so a stale confirmation cannot overwrite work the reader never saw.
 *
 * @param scope where reads run; it ends with the panel.
 * @param writeScope where stage, commit, checkpoint and worktree writes run. It must outlive the
 *   panel: a commit or a restore cancelled because the page went away has an unknown outcome on the
 *   server.
 */
class GitPanelController(
    private val api: RiffetApi,
    private val projectId: String,
    private val sessionId: String?,
    private val scope: CoroutineScope,
    private val writeScope: CoroutineScope,
) {
    private val _state = MutableStateFlow(GitPanelState())
    val state: StateFlow<GitPanelState> = _state.asStateFlow()

    private var diffRequest = 0L

    /** Bumped each time a diff opens over the tab list; a replaced diff keeps its visit. */
    private var diffVisit = 0L
    private var discards = 0L
    private var scopedRunning = false
    private var scopedDirty = false
    private var scopedForce = false
    private var branchRunning = false
    private var branchDirty = false

    fun clearMessages() {
        _state.update { it.copy(error = null, notice = null) }
    }

    fun consumeNotice(message: String) {
        _state.update { if (it.notice == message) it.copy(notice = null) else it }
    }

    fun consumeDiscarded(discarded: GitDiscarded) {
        _state.update { if (it.discarded == discarded) it.copy(discarded = null) else it }
    }

    /** Puts [status] on show and re-reads whatever else the working tree decides (the turn, a scoped list). */
    private fun applyStatus(status: GitStatus, force: Boolean = false) {
        _state.update { it.copy(status = status, statusLoaded = true) }
        refreshScoped(force)
    }

    // Reads the status again even while a stream is open: the server answers from what it last saw otherwise.
    private suspend fun readStatus(): GitStatus = api.gitStatus(projectId, fresh = true)

    @Throws(Exception::class)
    suspend fun refreshStatus() {
        try {
            applyStatus(readStatus(), force = true)
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (failure: Throwable) {
            _state.update { it.copy(status = null, error = gitError(failure, L10n.uiText("git.statusReadFailed"))) }
        } finally {
            _state.update { it.copy(statusLoaded = true) }
        }
        refreshBranch()
    }

    /** Follows the project's status while the panel is on screen; ends with the flow, which the manual refresh then replaces. */
    suspend fun watchStatus() {
        try {
            api.gitStatusStream(projectId).collect {
                applyStatus(it)
                requestBranch()
            }
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (_: Throwable) {
        }
    }

    // Conflated: a read in flight is never cancelled; one more runs after it when something changed meanwhile.
    private fun requestBranch() {
        if (branchRunning) {
            branchDirty = true
            return
        }
        branchRunning = true
        scope.launch {
            try {
                do {
                    branchDirty = false
                    refreshBranch()
                } while (branchDirty)
            } finally {
                branchRunning = false
            }
        }
    }

    private suspend fun refreshBranch() {
        val branch = try {
            api.gitBranch(projectId)
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (_: Throwable) {
            null
        }
        _state.update { it.copy(branch = branch) }
    }

    @Throws(Exception::class)
    suspend fun refreshCheckpoints() {
        try {
            val checkpoints = api.checkpoints(projectId)
            _state.update { it.copy(checkpoints = checkpoints) }
        } catch (failure: Throwable) {
            _state.update { it.copy(checkpoints = emptyList(), error = gitError(failure, L10n.uiText("git.checkpointsReadFailed"))) }
        }
    }

    @Throws(Exception::class)
    suspend fun refreshWorktrees() {
        try {
            val worktrees = api.worktrees(projectId)
            _state.update { it.copy(worktrees = worktrees) }
        } catch (failure: Throwable) {
            _state.update { it.copy(worktrees = emptyList(), error = gitError(failure, L10n.uiText("git.worktreesReadFailed"))) }
        }
    }

    /** Reads [tab]'s list the first time it is shown; the changes are read when the panel opens. */
    @Throws(Exception::class)
    suspend fun show(tab: GitPanelTab) {
        when (tab) {
            GitPanelTab.CHECKPOINTS -> if (_state.value.checkpoints == null) refreshCheckpoints()
            GitPanelTab.WORKTREES -> if (_state.value.worktrees == null) refreshWorktrees()
            GitPanelTab.CHANGES, GitPanelTab.HISTORY -> Unit
        }
    }

    /** The refresh action: clears the messages and re-reads [tab]'s list. */
    fun refresh(tab: GitPanelTab) {
        scope.launch {
            clearMessages()
            when (tab) {
                GitPanelTab.CHANGES, GitPanelTab.HISTORY -> refreshStatus()
                GitPanelTab.CHECKPOINTS -> refreshCheckpoints()
                GitPanelTab.WORKTREES -> refreshWorktrees()
            }
        }
    }

    /* ------------------------------------------------------------------------------------------- */
    /* Scopes                                                                                       */
    /* ------------------------------------------------------------------------------------------- */

    fun selectScope(next: GitScope) {
        _state.update { it.copy(changesScope = next, shownRows = GIT_ROWS_SHOWN, scoped = null, scopedFailed = false) }
        refreshScoped(force = true)
    }

    fun showMoreRows() {
        _state.update { it.copy(shownRows = it.shownRows + GIT_ROWS_STEP) }
    }

    /**
     * The list of the shown scope follows the tree. Conflated: a read in flight is never cancelled, so
     * a slow one still finishes under constant edits; one more runs after it when something changed
     * meanwhile. The conversation's turn (its newest checkpoint) is read again only when it is unknown,
     * when the turn list is the one on show, or when [force]d.
     */
    private fun refreshScoped(force: Boolean = false) {
        if (force) scopedForce = true
        if (scopedRunning) {
            scopedDirty = true
            return
        }
        scopedRunning = true
        scope.launch {
            try {
                do {
                    scopedDirty = false
                    val forced = scopedForce
                    scopedForce = false
                    readScoped(forced)
                } while (scopedDirty)
            } finally {
                scopedRunning = false
            }
        }
    }

    private suspend fun readScoped(forced: Boolean) {
        val before = _state.value
        if (sessionId != null && (forced || before.turn == null || before.changesScope == GitScope.TURN)) {
            val turn = try {
                api.sessionCheckpoints(sessionId).firstOrNull()
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (_: Throwable) {
                null
            }
            _state.update { it.copy(turn = turn) }
        }
        val current = _state.value
        val shown = current.shownScope
        if (shown == GitScope.UNCOMMITTED) {
            _state.update { if (it.scoped == null && !it.scopedFailed) it else it.copy(scoped = null, scopedFailed = false) }
            return
        }
        try {
            val list = when (shown) {
                GitScope.TURN -> GitScopedList(
                    scope = shown,
                    files = api.checkpointChanges(projectId, current.turn!!.id).map { change ->
                        GitScopedFile(change.path, change.kind.letter(), null, null)
                    },
                    base = "checkpoint:${current.turn.id}",
                )
                else -> api.gitCompare(projectId).let { result ->
                    GitScopedList(
                        scope = shown,
                        files = result.files.map { GitScopedFile(it.path, it.status, it.added, it.removed) },
                        total = result.filesTotal,
                        base = result.base,
                        ref = result.ref,
                    )
                }
            }
            _state.update { it.copy(scoped = list, scopedFailed = false) }
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (failure: Throwable) {
            _state.update { it.copy(scoped = null, scopedFailed = true, error = gitError(failure, L10n.uiText("git.compareFailed"))) }
        }
    }

    /* ------------------------------------------------------------------------------------------- */
    /* Changes                                                                                      */
    /* ------------------------------------------------------------------------------------------- */

    fun openDiff(entry: GitEntry) {
        scope.launch { loadDiff(GitDiffTarget(entry.path, entry = entry), gitStaged(entry) && entry.worktree == " ", keep = false) }
    }

    fun openDiff(file: GitScopedFile) {
        val list = _state.value.scoped ?: return
        scope.launch { loadDiff(GitDiffTarget(file.path, base = list.base, title = list.ref), staged = false, keep = false) }
    }

    /** A file of a commit, read-only. */
    fun openCommitDiff(hash: String, path: String) {
        scope.launch { loadDiff(GitDiffTarget(path, commit = hash), staged = false, keep = false) }
    }

    /** Shows the other side of a file that has both staged and unstaged changes. */
    fun showDiffSide(staged: Boolean) {
        val target = _state.value.diffTarget ?: return
        if (_state.value.diffStaged == staged) return
        scope.launch { loadDiff(target, staged, keep = false) }
    }

    /** The diff page went away (back, swipe); a diff still loading for it is dropped. */
    fun closeDiff() {
        _state.update { if (it.diffTarget == null) it else it.copy(diffTarget = null) }
    }

    // [keep]: a reload of the diff on show keeps what it shows until the new one arrives, so its scroll position stays.
    private suspend fun loadDiff(target: GitDiffTarget, staged: Boolean, keep: Boolean) {
        if (_state.value.diffTarget == null) ++diffVisit
        val visit = diffVisit
        val request = ++diffRequest
        _state.update { it.copy(diffTarget = target, diffStaged = staged, diff = if (keep) it.diff else null, diffRows = if (keep) it.diffRows else null, diffLoading = true) }
        fun showing() = request == diffRequest && diffVisit == visit && _state.value.diffTarget?.path == target.path
        try {
            val result = api.gitDiff(projectId, target.path, staged, base = target.base, commit = target.commit)
            // Only the working tree's own diff carries a version, and only it can be applied by line.
            val editable = target.entry != null && target.base == null && target.commit == null &&
                result.version != null && !result.binary && result.truncated != true
            val rows = withContext(Dispatchers.Default) { patchRows(result.patch, editable) }
            if (showing()) _state.update { it.copy(diff = result, diffRows = rows) }
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (failure: Throwable) {
            if (showing()) _state.update { it.copy(error = gitError(failure, L10n.uiText("git.diffReadFailed")), diffTarget = null) }
        } finally {
            if (request == diffRequest) _state.update { it.copy(diffLoading = false) }
        }
    }

    // Re-reads the open diff after a write so it reflects the new index and tree; a file with nothing left closes it.
    private suspend fun reloadOpenDiff(refreshed: GitStatus) {
        val current = _state.value
        val target = current.diffTarget ?: return
        if (target.entry == null) return
        val updated = refreshed.entries.firstOrNull { it.path == target.path }
        val side = when {
            updated == null -> null
            current.diffStaged && gitStaged(updated) -> true
            !current.diffStaged && gitUnstaged(updated) -> false
            gitUnstaged(updated) -> false
            gitStaged(updated) -> true
            else -> null
        }
        if (updated == null || side == null) {
            _state.update { it.copy(diffTarget = null, diff = null) }
            return
        }
        loadDiff(target.copy(entry = updated), side, keep = true)
        val diff = _state.value.diff
        if (diff != null && !diff.binary && diff.before == diff.after) _state.update { it.copy(diffTarget = null, diff = null) }
    }

    fun stage(paths: List<String>) {
        writeScope.launch { stagePaths(paths) }
    }

    fun unstage(paths: List<String>) {
        writeScope.launch { unstagePaths(paths) }
    }

    private suspend fun stagePaths(paths: List<String>) {
        if (paths.isEmpty()) return
        _state.update { it.copy(busy = true, error = null, notice = null) }
        try {
            api.stage(projectId, paths)
            val refreshed = readStatus()
            val stillUnstaged = refreshed.entries.any { it.path in paths && !gitStaged(it) }
            applyStatus(refreshed)
            if (stillUnstaged) _state.update { it.copy(notice = L10n.uiText("git.stagedRemaining")) }
            reloadOpenDiff(refreshed)
        } catch (failure: Throwable) {
            _state.update { it.copy(error = gitError(failure, L10n.uiText("git.stageFailed"))) }
        } finally {
            _state.update { it.copy(busy = false) }
        }
    }

    private suspend fun unstagePaths(paths: List<String>) {
        if (paths.isEmpty()) return
        _state.update { it.copy(busy = true, error = null, notice = null) }
        try {
            api.unstage(projectId, paths)
            val refreshed = readStatus()
            val stillStaged = refreshed.entries.any { it.path in paths && gitStaged(it) }
            applyStatus(refreshed)
            if (stillStaged) _state.update { it.copy(notice = L10n.uiText("git.unstagedRemaining")) }
            reloadOpenDiff(refreshed)
        } catch (failure: Throwable) {
            _state.update { it.copy(error = gitError(failure, L10n.uiText("git.unstageFailed"))) }
        } finally {
            _state.update { it.copy(busy = false) }
        }
    }

    /* Discard and line-level writes */

    fun discard(path: String) {
        writeScope.launch { discardPath(path, permanent = false) }
    }

    /** The reader agreed to discard a file the server could not back up first. */
    fun confirmPermanentDiscard() {
        val path = _state.value.confirmDiscard ?: return
        _state.update { it.copy(confirmDiscard = null) }
        writeScope.launch { discardPath(path, permanent = true) }
    }

    fun cancelPermanentDiscard() {
        _state.update { it.copy(confirmDiscard = null) }
    }

    private fun showDiscarded(backup: Checkpoint?) {
        _state.update { it.copy(discarded = GitDiscarded(++discards, backup), notice = null) }
    }

    private suspend fun discardPath(path: String, permanent: Boolean) {
        _state.update { it.copy(busy = true, error = null, notice = null) }
        try {
            val result = api.gitDiscard(projectId, listOf(path), permanent)
            showDiscarded(result.backup)
            applyStatus(result.status)
            reloadOpenDiff(result.status)
        } catch (failure: Throwable) {
            if ((failure as? RiffetHttpException)?.code == "DISCARD_UNRECOVERABLE" && !permanent) {
                _state.update { it.copy(confirmDiscard = path) }
            } else {
                _state.update { it.copy(error = gitError(failure, L10n.uiText("git.discardFailed"))) }
            }
        } finally {
            _state.update { it.copy(busy = false) }
        }
    }

    /** Puts back what a discard threw away by restoring the checkpoint saved before it. */
    fun undoDiscard(backup: Checkpoint) {
        writeScope.launch {
            _state.update { it.copy(busy = true, error = null, notice = null) }
            try {
                api.restoreCheckpoint(projectId, backup.id, api.checkpointChanges(projectId, backup.id))
                val refreshed = readStatus()
                applyStatus(refreshed)
                _state.update { it.copy(notice = L10n.uiText("git.restored")) }
                reloadOpenDiff(refreshed)
            } catch (failure: Throwable) {
                _state.update { it.copy(error = gitError(failure, L10n.uiText("git.undoFailed"))) }
            } finally {
                _state.update { it.copy(busy = false) }
            }
        }
    }

    /** Stages, unstages or discards one changed block of the open diff; [action] is `stage`, `unstage` or `discard`. */
    fun applyChunk(action: String, change: GitLineChange) {
        val current = _state.value
        val target = current.diffTarget ?: return
        val version = current.diff?.version ?: return
        if (current.busy) return
        writeScope.launch {
            _state.update { it.copy(busy = true, error = null, notice = null) }
            try {
                val refreshed = try {
                    val result = api.gitLines(projectId, target.path, action, listOf(change), version)
                    if (action == "discard") showDiscarded(result.backup)
                    result.status
                } catch (failure: Throwable) {
                    // The agent, or another window, got to the file first: show what is there now instead.
                    if ((failure as? RiffetHttpException)?.code != "GIT_DIFF_STALE") throw failure
                    _state.update { it.copy(notice = L10n.uiText("git.diffStale")) }
                    readStatus()
                }
                applyStatus(refreshed)
                reloadOpenDiff(refreshed)
            } catch (failure: Throwable) {
                _state.update { it.copy(error = gitError(failure, L10n.uiText("git.lineFailed"))) }
            } finally {
                _state.update { it.copy(busy = false) }
            }
        }
    }

    /** Commits the index with [message]; [onSent] runs once the server has taken it, before the re-read. */
    fun commit(message: String, onSent: () -> Unit = {}) {
        writeScope.launch {
            val text = message.trim()
            val current = _state.value
            val staged = current.status?.entries?.count { gitStaged(it) } ?: 0
            if (text.isEmpty() || staged == 0 || current.busy) return@launch
            _state.update { it.copy(busy = true, error = null, notice = null) }
            try {
                api.commit(projectId, text)
                onSent()
                val refreshed = readStatus()
                val remaining = refreshed.entries.count { gitStaged(it) }
                // `commit` returns no receipt, so the index is the only evidence. An empty index is
                // reported as a commit; a non-empty one is reported for what it is, not as success.
                val notice = if (remaining == 0) L10n.uiText("git.committed") else L10n.uiText("git.commitRemaining")
                applyStatus(refreshed)
                _state.update { it.copy(notice = notice) }
                refreshBranch()
            } catch (failure: Throwable) {
                _state.update { it.copy(error = gitError(failure, L10n.uiText("git.commitFailed"))) }
            } finally {
                _state.update { it.copy(busy = false) }
            }
        }
    }

    /* Publishing */

    fun pull() {
        writeScope.launch {
            _state.update { it.copy(busy = true, error = null, notice = null) }
            try {
                val result = api.gitPull(projectId)
                _state.update { it.copy(branch = result.branch) }
                applyStatus(result.status)
            } catch (failure: Throwable) {
                _state.update { it.copy(error = gitError(failure, L10n.uiText("git.pullFailed"))) }
            } finally {
                _state.update { it.copy(busy = false) }
            }
        }
    }

    /** Pushes the current branch; without [remote] the server picks the branch's own or the only one. */
    fun push(remote: String? = null) {
        writeScope.launch {
            _state.update { it.copy(busy = true, error = null, notice = null) }
            try {
                val result = api.gitPush(projectId, remote)
                _state.update { it.copy(branch = result.branch) }
            } catch (failure: Throwable) {
                _state.update { it.copy(error = gitError(failure, L10n.uiText("git.pushFailed"))) }
            } finally {
                _state.update { it.copy(busy = false) }
            }
        }
    }

    /* ------------------------------------------------------------------------------------------- */
    /* Checkpoints                                                                                  */
    /* ------------------------------------------------------------------------------------------- */

    /**
     * Saves the working tree as a checkpoint titled [title] (blank for the server's own title),
     * attached to [sessionId] exactly as the web does. [onSent] runs once the server has taken it.
     */
    fun createCheckpoint(title: String, sessionId: String?, onSent: () -> Unit = {}) {
        writeScope.launch {
            _state.update { it.copy(busy = true, error = null, notice = null) }
            try {
                api.createCheckpoint(
                    projectId,
                    CreateCheckpointRequest(sessionId = sessionId, title = title.trim().takeIf { it.isNotEmpty() }),
                )
                onSent()
                val before = _state.value.checkpoints?.size ?: 0
                val refreshed = api.checkpoints(projectId)
                val notice = if (refreshed.size > before) {
                    L10n.uiText("git.checkpointSaved")
                } else {
                    L10n.uiText("git.checkpointMissing")
                }
                _state.update { it.copy(checkpoints = refreshed, notice = notice) }
            } catch (failure: Throwable) {
                _state.update { it.copy(error = gitError(failure, L10n.uiText("git.checkpointCreateFailed"))) }
            } finally {
                _state.update { it.copy(busy = false) }
            }
        }
    }

    /** Expands or collapses [checkpoint]; its change list is read the first time it opens. */
    fun toggleCheckpoint(checkpoint: Checkpoint) {
        if (_state.value.expandedCheckpoint == checkpoint.id) {
            _state.update { it.copy(expandedCheckpoint = null) }
            return
        }
        _state.update { it.copy(expandedCheckpoint = checkpoint.id) }
        if (_state.value.changesByCheckpoint[checkpoint.id] != null) return
        scope.launch {
            clearMessages()
            try {
                val list = api.checkpointChanges(projectId, checkpoint.id)
                _state.update { it.copy(changesByCheckpoint = it.changesByCheckpoint + (checkpoint.id to list)) }
            } catch (failure: Throwable) {
                _state.update { it.copy(error = gitError(failure, L10n.uiText("git.checkpointContentsFailed"))) }
            }
        }
    }

    /** Presents the changes a restore of [checkpoint] would make, for the reader to confirm. */
    fun requestRestore(checkpoint: Checkpoint) {
        scope.launch {
            _state.update { it.copy(busy = true, error = null, notice = null) }
            try {
                val list = _state.value.changesByCheckpoint[checkpoint.id]
                    ?: api.checkpointChanges(projectId, checkpoint.id)
                _state.update {
                    it.copy(
                        changesByCheckpoint = it.changesByCheckpoint + (checkpoint.id to list),
                        expandedCheckpoint = checkpoint.id,
                        pendingRestoreChanges = list,
                        pendingRestore = checkpoint,
                    )
                }
            } catch (failure: Throwable) {
                _state.update { it.copy(error = gitError(failure, L10n.uiText("git.checkpointContentsFailed"))) }
            } finally {
                _state.update { it.copy(busy = false) }
            }
        }
    }

    fun cancelRestore() {
        _state.update { it.copy(pendingRestore = null, pendingRestoreChanges = emptyList()) }
    }

    /** Restores the pending checkpoint, guarded by the change list the reader confirmed. */
    fun confirmRestore() {
        val current = _state.value
        val checkpoint = current.pendingRestore ?: return
        val expected = current.pendingRestoreChanges
        writeScope.launch {
            _state.update { it.copy(busy = true, error = null, notice = null) }
            try {
                api.restoreCheckpoint(projectId, checkpoint.id, expected)
                _state.update {
                    it.copy(
                        notice = L10n.uiText("git.restored"),
                        expandedCheckpoint = null,
                        changesByCheckpoint = it.changesByCheckpoint - checkpoint.id,
                        pendingRestore = null,
                        pendingRestoreChanges = emptyList(),
                        diffTarget = null,
                        diff = null,
                    )
                }
                refreshStatus()
                refreshCheckpoints()
            } catch (failure: Throwable) {
                when ((failure as? RiffetHttpException)?.code) {
                    "CHECKPOINT_CONFLICT" -> {
                        _state.update {
                            it.copy(error = L10n.uiText("git.restoreConflict"))
                        }
                        // The server's whole point is that a stale list must not be replayed.
                        // Re-read and re-present, so the reader reviews the changes restore would now
                        // make before confirming again.
                        val fresh = runCatching { api.checkpointChanges(projectId, checkpoint.id) }.getOrNull()
                        _state.update {
                            if (fresh != null) {
                                it.copy(
                                    changesByCheckpoint = it.changesByCheckpoint + (checkpoint.id to fresh),
                                    pendingRestoreChanges = fresh,
                                    pendingRestore = checkpoint,
                                )
                            } else {
                                it.copy(pendingRestore = null, pendingRestoreChanges = emptyList())
                            }
                        }
                        refreshStatus()
                    }
                    "CHECKPOINT_EXCLUDED_CHANGES" -> _state.update {
                        it.copy(
                            error = gitError(failure, L10n.uiText("git.restoreExcluded")),
                            pendingRestore = null,
                            pendingRestoreChanges = emptyList(),
                        )
                    }
                    else -> _state.update {
                        it.copy(error = gitError(failure, L10n.uiText("git.restoreRefused")), pendingRestore = null, pendingRestoreChanges = emptyList())
                    }
                }
            } finally {
                _state.update { it.copy(busy = false) }
            }
        }
    }

    /* ------------------------------------------------------------------------------------------- */
    /* Worktrees                                                                                    */
    /* ------------------------------------------------------------------------------------------- */

    /** Creates a worktree on [branch] (from [base], blank for HEAD); [onSent] runs once the server has taken it. */
    fun createWorktree(branch: String, base: String, onSent: () -> Unit = {}) {
        val name = branch.trim()
        if (name.isEmpty()) return
        writeScope.launch {
            _state.update { it.copy(busy = true, error = null, notice = null) }
            try {
                api.createWorktree(projectId, CreateWorktreeRequest(branch = name, base = base.trim().takeIf { it.isNotEmpty() }))
                onSent()
                val before = _state.value.worktrees?.size ?: 0
                val refreshed = api.worktrees(projectId)
                val notice = if (refreshed.size > before) {
                    L10n.uiText("git.worktreeCreated")
                } else {
                    L10n.uiText("git.worktreeMissing")
                }
                _state.update { it.copy(worktrees = refreshed, notice = notice) }
            } catch (failure: Throwable) {
                _state.update { it.copy(error = gitError(failure, L10n.uiText("git.worktreeCreateFailed"))) }
            } finally {
                _state.update { it.copy(busy = false) }
            }
        }
    }

    fun requestRemove(worktree: WorktreeInfo) {
        _state.update { it.copy(pendingRemove = worktree) }
    }

    fun cancelRemove() {
        _state.update { it.copy(pendingRemove = null) }
    }

    fun confirmRemove() {
        val target = _state.value.pendingRemove ?: return
        writeScope.launch {
            _state.update { it.copy(busy = true, error = null, notice = null) }
            try {
                api.removeWorktree(projectId, target.path)
                val refreshed = api.worktrees(projectId)
                val gone = refreshed.none { it.path == target.path }
                val notice = if (gone) {
                    L10n.uiText("git.worktreeRemoved")
                } else {
                    L10n.uiText("git.worktreeStillListed")
                }
                _state.update { it.copy(worktrees = refreshed, notice = notice) }
            } catch (failure: Throwable) {
                // Removal is guarded server-side: uncommitted files, unpushed commits and an unsafe
                // path all refuse. Surface the refusal.
                _state.update { it.copy(error = gitError(failure, L10n.uiText("git.worktreeRemoveFailed"))) }
            } finally {
                _state.update { it.copy(pendingRemove = null, busy = false) }
            }
        }
    }
}

internal fun gitError(error: Throwable, fallback: String): String {
    when ((error as? RiffetHttpException)?.code) {
        "GIT_SWITCH_BLOCKED" -> return L10n.uiText("git.switchBlocked")
        "GIT_PULL_DIVERGED" -> return L10n.uiText("git.pullDiverged")
    }
    val detail = error.message?.takeIf { it.isNotBlank() }
    return if (detail != null && detail != fallback) L10n.uiText("git.errorWithDetail", fallback, detail) else fallback
}

private fun CheckpointChangeKind.letter(): String = when (this) {
    CheckpointChangeKind.ADDED -> "A"
    CheckpointChangeKind.MODIFIED -> "M"
    CheckpointChangeKind.DELETED -> "D"
}
