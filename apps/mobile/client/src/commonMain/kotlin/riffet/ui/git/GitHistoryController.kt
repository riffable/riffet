package riffet.ui.git

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import riffet.contracts.GitCommit
import riffet.contracts.GitCommitDetail
import riffet.contracts.GitRefs
import riffet.i18n.L10n
import riffet.shared.RiffetApi
import riffet.shared.gitCommit
import riffet.shared.gitFetch
import riffet.shared.gitLog
import riffet.shared.gitRefs
import riffet.shared.gitSwitch
import riffet.shared.GitGraphRow
import riffet.shared.layoutGitGraph

/** Commits listed per request; the next page is read when the reader scrolls near the end. */
const val GIT_LOG_PAGE = 150

/** Remote branches the branch menu lists; beyond it a name is typed. */
const val GIT_REMOTES_IN_MENU = 30

data class GitHistoryState(
    val commits: List<GitCommit> = emptyList(),
    /** One graph row per commit, laid out once for the whole list. */
    val rows: List<GitGraphRow> = emptyList(),
    val more: Boolean = false,
    val loaded: Boolean = false,
    val loadingMore: Boolean = false,
    /** Every branch rather than the current one. */
    val all: Boolean = false,
    val refs: GitRefs? = null,
    /** A fetch or a branch switch is in flight. */
    val busy: Boolean = false,
    val error: String? = null,
    /** The commit whose page is open. */
    val openCommit: String? = null,
    val detail: GitCommitDetail? = null,
)

/**
 * The History tab's reads and writes for one project: the commit list, the branch menu and one
 * commit's detail. Ported from `apps/web/src/app/panels/HistorySection.tsx`.
 *
 * @param afterWrite runs once a fetch or a switch has changed the repository, so the panel's own
 *   status follows.
 */
class GitHistoryController(
    private val api: RiffetApi,
    private val projectId: String,
    private val scope: CoroutineScope,
    private val writeScope: CoroutineScope,
    private val afterWrite: suspend () -> Unit,
) {
    private val _state = MutableStateFlow(GitHistoryState())
    val state: StateFlow<GitHistoryState> = _state.asStateFlow()
    private var logRequest = 0L
    private var refsKey: String? = null
    private var refsRunning = false
    private var refsDirty = false
    private var detailRequest = 0L

    fun clearError() {
        _state.update { it.copy(error = null) }
    }

    /** Reads the refs and the first page of the log. */
    @Throws(Exception::class)
    suspend fun load() {
        val request = ++logRequest
        val all = _state.value.all
        try {
            val refs = runCatching { api.gitRefs(projectId) }.getOrNull()
            refsKey = refs?.let(::refsKeyOf)
            val log = api.gitLog(projectId, all = all, skip = 0)
            if (request != logRequest) return
            _state.update {
                it.copy(
                    commits = log.commits,
                    rows = layoutGitGraph(log.commits),
                    more = log.more,
                    loaded = true,
                    loadingMore = false,
                    refs = refs ?: it.refs,
                )
            }
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (failure: Throwable) {
            if (request != logRequest) return
            _state.update { it.copy(loaded = true, loadingMore = false, error = gitError(failure, L10n.uiText("git.logFailed"))) }
        }
    }

    private fun refsKeyOf(refs: GitRefs): String =
        refs.head + "|" + refs.branches.joinToString(",") { it.hash } + "|" + refs.remoteCount + "|" + refs.tags.size

    /**
     * The repository's status changed (a commit, a pull, a push, a switch elsewhere): when the refs
     * moved, the log is read again from its first page. Does nothing until the tab has been shown.
     * Conflated: a read in flight finishes, and one more follows if status changed meanwhile.
     */
    fun statusChanged() {
        if (!_state.value.loaded) return
        if (refsRunning) {
            refsDirty = true
            return
        }
        refsRunning = true
        scope.launch {
            try {
                do {
                    refsDirty = false
                    val refs = try {
                        api.gitRefs(projectId)
                    } catch (cancellation: CancellationException) {
                        throw cancellation
                    } catch (_: Throwable) {
                        null
                    } ?: continue
                    if (refsKeyOf(refs) != refsKey) load() else _state.update { it.copy(refs = refs) }
                } while (refsDirty)
            } finally {
                refsRunning = false
            }
        }
    }

    /** Reads the first time the tab is shown. */
    @Throws(Exception::class)
    suspend fun show() {
        if (!_state.value.loaded) load()
    }

    fun reload() {
        scope.launch {
            clearError()
            load()
        }
    }

    fun setAll(all: Boolean) {
        if (_state.value.all == all) return
        _state.update { it.copy(all = all, loaded = false, commits = emptyList(), rows = emptyList(), more = false) }
        scope.launch { load() }
    }

    /** The next page, read when the list scrolls near its end. */
    fun loadMore() {
        val current = _state.value
        if (!current.more || current.loadingMore || !current.loaded) return
        val request = logRequest
        _state.update { it.copy(loadingMore = true) }
        scope.launch {
            try {
                val log = api.gitLog(projectId, all = current.all, skip = current.commits.size)
                if (request != logRequest) return@launch
                _state.update {
                    // Only onto the list the page was asked for; a reload or a switch in between made it stale.
                    if (it.commits.size != current.commits.size) return@update it.copy(loadingMore = false)
                    // The history moved while paging by offset: a commit can come around twice.
                    val listed = it.commits.mapTo(HashSet()) { commit -> commit.hash }
                    val commits = it.commits + log.commits.filter { commit -> commit.hash !in listed }
                    it.copy(commits = commits, rows = layoutGitGraph(commits), more = log.more, loadingMore = false)
                }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (failure: Throwable) {
                if (request != logRequest) return@launch
                _state.update { it.copy(more = false, loadingMore = false, error = gitError(failure, L10n.uiText("git.logFailed"))) }
            }
        }
    }

    fun fetch() {
        write(L10n.uiText("git.fetchFailed")) { api.gitFetch(projectId) }
    }

    fun switchTo(branch: String) {
        write(L10n.uiText("git.switchFailed")) { api.gitSwitch(projectId, branch = branch) }
    }

    /** Checks `origin/name` out as a local branch. */
    fun checkOutRemote(remote: String) {
        val name = remote.trim()
        if (name.isNotEmpty()) write(L10n.uiText("git.switchFailed")) { api.gitSwitch(projectId, remote = name) }
    }

    /** Creates and switches to [branch], from [base] (a commit) or HEAD. */
    fun createBranch(branch: String, base: String? = null) {
        val name = branch.trim()
        if (name.isEmpty()) return
        write(L10n.uiText("git.switchFailed"), closeCommit = base != null) { api.gitSwitch(projectId, branch = name, create = true, base = base) }
    }

    // A switch or a fetch changes what the log and the refs show; both are read again afterwards.
    private fun write(failure: String, closeCommit: Boolean = false, action: suspend () -> GitRefs) {
        if (_state.value.busy) return
        _state.update { it.copy(busy = true, error = null) }
        writeScope.launch {
            try {
                val refs = action()
                _state.update { it.copy(refs = refs, openCommit = if (closeCommit) null else it.openCommit, detail = if (closeCommit) null else it.detail) }
                afterWrite()
                load()
            } catch (error: Throwable) {
                _state.update { it.copy(error = gitError(error, failure)) }
            } finally {
                _state.update { it.copy(busy = false) }
            }
        }
    }

    fun openCommit(hash: String) {
        val request = ++detailRequest
        _state.update { it.copy(openCommit = hash, detail = null) }
        scope.launch {
            try {
                val detail = api.gitCommit(projectId, hash)
                if (request == detailRequest) _state.update { it.copy(detail = detail) }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (failure: Throwable) {
                if (request == detailRequest) {
                    _state.update { it.copy(openCommit = null, error = gitError(failure, L10n.uiText("git.commitReadFailed"))) }
                }
            }
        }
    }

    /** The commit page went away (back, swipe). */
    fun closeCommit() {
        detailRequest++
        _state.update { if (it.openCommit == null) it else it.copy(openCommit = null, detail = null) }
    }
}
