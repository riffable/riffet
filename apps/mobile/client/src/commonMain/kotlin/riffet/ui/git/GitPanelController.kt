package riffet.ui.git

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import riffet.contracts.Checkpoint
import riffet.contracts.CheckpointChange
import riffet.contracts.GitDiff
import riffet.contracts.GitEntry
import riffet.contracts.GitStatus
import riffet.contracts.WorktreeInfo
import riffet.shared.CreateCheckpointRequest
import riffet.shared.CreateWorktreeRequest
import riffet.shared.RiffetApi
import riffet.shared.RiffetHttpException
import riffet.ui.files.gitStaged
import riffet.shared.checkpointChanges
import riffet.shared.checkpoints
import riffet.shared.commit
import riffet.shared.createCheckpoint
import riffet.shared.createWorktree
import riffet.shared.gitDiff
import riffet.shared.gitStatus
import riffet.i18n.L10n
import riffet.shared.removeWorktree
import riffet.shared.restoreCheckpoint
import riffet.shared.stage
import riffet.shared.unstage
import riffet.shared.worktrees

/** The Git panel's three views; each list is read the first time its view is shown. */
enum class GitPanelTab { CHANGES, CHECKPOINTS, WORKTREES }

/** Everything the Git panel renders; see [GitPanelController]. */
data class GitPanelState(
    val status: GitStatus? = null,
    val statusLoaded: Boolean = false,
    /** True while a write (or a restore preview) is in flight; every write control waits on it. */
    val busy: Boolean = false,
    val error: String? = null,
    val notice: String? = null,
    /** The file whose diff is open, or null while the tab list shows. */
    val diffEntry: GitEntry? = null,
    /** Whether the open diff is the index's (staged) side. */
    val diffStaged: Boolean = false,
    val diff: GitDiff? = null,
    val diffLoading: Boolean = false,
    val checkpoints: List<Checkpoint>? = null,
    val expandedCheckpoint: String? = null,
    val changesByCheckpoint: Map<String, List<CheckpointChange>> = emptyMap(),
    /** The checkpoint awaiting confirmation, with the change list the reader is confirming. */
    val pendingRestore: Checkpoint? = null,
    val pendingRestoreChanges: List<CheckpointChange> = emptyList(),
    val worktrees: List<WorktreeInfo>? = null,
    val pendingRemove: WorktreeInfo? = null,
)

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
    private val scope: CoroutineScope,
    private val writeScope: CoroutineScope,
) {
    private val _state = MutableStateFlow(GitPanelState())
    val state: StateFlow<GitPanelState> = _state.asStateFlow()

    private var diffRequest = 0L

    /** Bumped each time a diff opens over the tab list; a replaced diff keeps its visit. */
    private var diffVisit = 0L

    fun clearMessages() {
        _state.update { it.copy(error = null, notice = null) }
    }

    fun consumeNotice(message: String) {
        _state.update { if (it.notice == message) it.copy(notice = null) else it }
    }

    @Throws(Exception::class)
    suspend fun refreshStatus() {
        try {
            val status = api.gitStatus(projectId)
            _state.update { it.copy(status = status) }
        } catch (failure: Throwable) {
            _state.update { it.copy(status = null, error = gitError(failure, L10n.uiText("git.statusReadFailed"))) }
        } finally {
            _state.update { it.copy(statusLoaded = true) }
        }
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
            GitPanelTab.CHANGES -> Unit
        }
    }

    /** The refresh action: clears the messages and re-reads [tab]'s list. */
    fun refresh(tab: GitPanelTab) {
        scope.launch {
            clearMessages()
            when (tab) {
                GitPanelTab.CHANGES -> refreshStatus()
                GitPanelTab.CHECKPOINTS -> refreshCheckpoints()
                GitPanelTab.WORKTREES -> refreshWorktrees()
            }
        }
    }

    /* ------------------------------------------------------------------------------------------- */
    /* Changes                                                                                      */
    /* ------------------------------------------------------------------------------------------- */

    fun openDiff(entry: GitEntry) {
        scope.launch { loadDiff(entry) }
    }

    /** The diff page went away (back, swipe); a diff still loading for it is dropped. */
    fun closeDiff() {
        _state.update { if (it.diffEntry == null) it else it.copy(diffEntry = null) }
    }

    private suspend fun loadDiff(entry: GitEntry) {
        if (_state.value.diffEntry == null) ++diffVisit
        val visit = diffVisit
        val request = ++diffRequest
        val staged = gitStaged(entry) && entry.worktree == " "
        _state.update { it.copy(diffEntry = entry, diffStaged = staged, diff = null, diffLoading = true) }
        fun showing() = request == diffRequest && diffVisit == visit && _state.value.diffEntry?.path == entry.path
        try {
            val result = api.gitDiff(projectId, entry.path, staged)
            if (showing()) _state.update { it.copy(diff = result) }
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (failure: Throwable) {
            if (showing()) _state.update { it.copy(error = gitError(failure, L10n.uiText("git.diffReadFailed")), diffEntry = null) }
        } finally {
            if (request == diffRequest) _state.update { it.copy(diffLoading = false) }
        }
    }

    // Re-reads the open diff after a stage/unstage so its header reflects the new index state.
    private suspend fun reloadOpenDiff(refreshed: GitStatus) {
        val current = _state.value.diffEntry ?: return
        val updated = refreshed.entries.firstOrNull { it.path == current.path }
        if (updated != null) loadDiff(updated) else _state.update { it.copy(diffEntry = null, diff = null) }
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
            val refreshed = api.gitStatus(projectId)
            val stillUnstaged = refreshed.entries.filter { it.path in paths && !gitStaged(it) }
            val notice = if (stillUnstaged.isEmpty()) {
                L10n.uiText("git.staged", paths.size)
            } else {
                L10n.uiText("git.stagedRemaining", stillUnstaged.size)
            }
            _state.update { it.copy(status = refreshed, statusLoaded = true, notice = notice) }
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
            val refreshed = api.gitStatus(projectId)
            val stillStaged = refreshed.entries.filter { it.path in paths && gitStaged(it) }
            val notice = if (stillStaged.isEmpty()) {
                L10n.uiText("git.unstaged", paths.size)
            } else {
                L10n.uiText("git.unstagedRemaining", stillStaged.size)
            }
            _state.update { it.copy(status = refreshed, statusLoaded = true, notice = notice) }
            reloadOpenDiff(refreshed)
        } catch (failure: Throwable) {
            _state.update { it.copy(error = gitError(failure, L10n.uiText("git.unstageFailed"))) }
        } finally {
            _state.update { it.copy(busy = false) }
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
                val refreshed = api.gitStatus(projectId)
                val remaining = refreshed.entries.count { gitStaged(it) }
                // `commit` returns no receipt, so the index is the only evidence. An empty index is
                // reported as a commit; a non-empty one is reported for what it is, not as success.
                val notice = if (remaining == 0) {
                    L10n.uiText("git.committed")
                } else {
                    L10n.uiText("git.commitRemaining", remaining)
                }
                _state.update { it.copy(status = refreshed, statusLoaded = true, notice = notice) }
            } catch (failure: Throwable) {
                _state.update { it.copy(error = gitError(failure, L10n.uiText("git.commitFailed"))) }
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
                        diffEntry = null,
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

private fun gitError(error: Throwable, fallback: String): String {
    val detail = error.message?.takeIf { it.isNotBlank() }
    return if (detail != null && detail != fallback) L10n.uiText("git.errorWithDetail", fallback, detail) else fallback
}
