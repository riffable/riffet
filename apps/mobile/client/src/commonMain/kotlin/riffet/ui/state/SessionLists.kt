package riffet.ui.state

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.coroutines.CoroutineContext
import riffet.cache.ListCache
import riffet.contracts.AgentIds
import riffet.contracts.AgentMember
import riffet.contracts.TEAM_MEMBERS_FEATURE
import riffet.contracts.AppSettings
import riffet.contracts.Attachment
import riffet.contracts.NativeBackendId
import riffet.contracts.Project
import riffet.contracts.ExternalSessionImport
import riffet.contracts.Session
import riffet.contracts.SessionKind
import riffet.contracts.SessionState
import riffet.shared.PromptContextReference
import riffet.shared.fileReferences
import riffet.shared.sessionReferences
import riffet.shared.AttachmentRef
import riffet.shared.NativeMessageInput
import riffet.shared.NativeSessionCreateInput
import riffet.shared.NativeSessionCreateResult
import riffet.shared.SessionUpdate
import riffet.shared.RiffetApi
import riffet.shared.RiffetHttpException
import riffet.shared.RiffetNetworkException
import riffet.shared.RiffetUnauthenticatedException
import riffet.shared.deleteSession
import riffet.shared.sessionDeletion
import riffet.ui.composer.newClientId
import riffet.ui.timeline.platformNowMillis
import riffet.shared.createProject
import riffet.i18n.L10n
import riffet.shared.createSession
import riffet.shared.importExternalSession
import riffet.shared.releaseTerminalHold
import riffet.shared.promoteProject
import riffet.shared.projects
import riffet.shared.sessionsIfChanged
import riffet.shared.sessionsSince
import riffet.shared.updateProject
import riffet.shared.updateSession
import riffet.shared.markAllSessionsSeen
import riffet.shared.markSessionSeen
import riffet.ui.sessionlist.activityAt
import riffet.ui.sessionlist.isUnread

/**
 * The project and session lists behind [SessionStore.list]: the bootstrap read, the cheap polling
 * read and its transitions, the lists' device copy, the background prefetch of conversations that
 * moved, and the metadata writes whose answers are folded back into the lists.
 *
 * [core] is the store's state: the open conversation is kept by its stream, and a prefetch
 * overtaken by a selection (a different epoch) must not write over it. A list entry newer than the
 * open session reaches [StoreState.selected] through it.
 */
internal class SessionLists(
    private val api: RiffetApi,
    private val scope: CoroutineScope,
    private val background: CoroutineContext,
    private val cache: ListCache?,
    private val core: StateStore,
    private val unauthenticated: StateFlow<Boolean>,
    private val signedOut: () -> Unit,
    /** The conversations' device copy: prefetch and stored replies go to it. */
    private val syncPrefetch: () -> SyncPrefetch? = { null },
    /** Conversations the server deleted (here or on another device): their page, stream and device copy go. */
    private val onRemoved: (List<String>) -> Unit = {},
) {

    private fun openSessionId(): String? = core.value.sessionId
    private fun streamToken(): Int = core.value.epoch

    private val _list = MutableStateFlow(SessionListState())
    val list: StateFlow<SessionListState> = _list.asStateFlow()

    private val _activity = MutableSharedFlow<SessionActivity>(extraBufferCapacity = 8)
    val activity: SharedFlow<SessionActivity> = _activity.asSharedFlow()

    private var listSaveJob: Job? = null
    private var prefetchJob: Job? = null
    private var refreshJob: Job? = null
    private var projectRefreshJob: Job? = null
    private var bootstrapSucceeded = false

    var refreshedAt = 0L
        private set

    /** Each session's state at the last list read; null until the first, which has nothing to compare. */
    private var knownStates: Map<String, SessionState>? = null

    /** List reads started, and the newest one applied: an answer overtaken by a newer one is dropped. */
    private var listReads = 0
    private var listApplied = 0
    private var settingsWrites = 0L
    private var projectReads = 0L
    private var projectApplied = 0L
    private var projectWrites = 0L
    private var projectsRevision: Long? = null
    private var projectsRevisionLoaded = false
    private var requestedProjectsRevision: Long? = null
    private var workItemRefreshJob: Job? = null
    private var workItemReads = 0L
    private var workItemApplied = 0L
    private var workItemsRevision: Long? = null
    private var workItemsRevisionLoaded = false
    private var requestedWorkItemsRevision: Long? = null

    /** The validator of the last session list read, sent as `If-None-Match` by the next one. */
    private var sessionsEtag: String? = null

    /** The server answers `GET /api/sessions?since=` (protocol feature `list-delta`), from the last bootstrap. */
    private var listDelta = false

    /**
     * Whether a lists `changed` push naming [revision] (null from an older server) is news: false
     * when the list held already is that revision, so no read is needed.
     */
    fun listsMoved(revision: Long?): Boolean = revision == null || sessionsEtag != "W/\"$revision\""

    /** Project metadata has its own revision: conversation activity must not re-read projects. */
    fun refreshProjects(revision: Long?) {
        if (unauthenticated.value || projectsRevisionLoaded && (revision == null || revision == projectsRevision)) return
        if (projectRefreshJob?.isActive == true && requestedProjectsRevision == revision) return
        projectRefreshJob?.cancel()
        requestedProjectsRevision = revision
        val job = scope.launch(start = CoroutineStart.LAZY) {
            // A bootstrap owns the initial project snapshot; do not race it with another read.
            refreshJob?.takeIf { it.isActive }?.join()
            if (unauthenticated.value) return@launch
            // The bootstrap may have read this very revision.
            if (revision != null && projectsRevisionLoaded && revision == projectsRevision) return@launch
            val read = ++projectReads
            val writesAtStart = projectWrites
            try {
                val projects = withContext(background) { api.projects() }
                if (read != projectReads || read <= projectApplied || writesAtStart != projectWrites) return@launch
                projectApplied = read
                projectsRevision = revision
                projectsRevisionLoaded = true
                _list.update { it.copy(projects = projects) }
                scheduleListSave()
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Throwable) {
                if (error is RiffetUnauthenticatedException) signedOut()
                // Keep the applied revision: the next push retries this failed read.
            }
        }
        projectRefreshJob = job
        job.start()
    }

    /** Task summaries have their own revision; an older server never pushes one, so this is not called for it. */
    fun refreshWorkItems(revision: Long?) {
        if (unauthenticated.value || revision == null || workItemsRevisionLoaded && revision == workItemsRevision) return
        if (workItemRefreshJob?.isActive == true && requestedWorkItemsRevision == revision) return
        workItemRefreshJob?.cancel()
        requestedWorkItemsRevision = revision
        val job = scope.launch(start = CoroutineStart.LAZY) {
            refreshJob?.takeIf { it.isActive }?.join()
            if (unauthenticated.value) return@launch
            if (workItemsRevisionLoaded && revision == workItemsRevision) return@launch
            val read = ++workItemReads
            try {
                val items = withContext(background) { api.workItemSummaries() }
                if (read != workItemReads || read <= workItemApplied) return@launch
                workItemApplied = read
                workItemsRevision = revision
                workItemsRevisionLoaded = true
                _list.update { it.copy(workItems = items) }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Throwable) {
                if (error is RiffetUnauthenticatedException) signedOut()
            }
        }
        workItemRefreshJob = job
        job.start()
    }

    fun applySavedSettings(settings: AppSettings) {
        settingsWrites++
        _list.update { it.copy(settings = settings) }
        scheduleListSave()
    }

    fun invalidateBackendCatalog() {
        _list.update { it.copy(backendRevision = it.backendRevision + 1) }
    }

    fun refresh() {
        if (!unauthenticated.value) startRefresh()
    }

    /** Wake, manual refresh and recovery share the same bootstrap while it is in flight. */
    private fun startRefresh(): Job {
        refreshJob?.takeIf { it.isActive }?.let { return it }
        // Publish the job before starting: restoring a cache can immediately wake a list collector.
        val job = scope.launch(start = CoroutineStart.LAZY) {
            if (!list.value.loaded) restoreList()
            _list.update { it.copy(loading = true, error = null, unreachable = false) }
            try {
                val read = ++listReads
                val writesAtStart = settingsWrites
                val workItemRead = ++workItemReads
                val projectRead = ++projectReads
                val projectWritesAtStart = projectWrites
                // Decoding the whole list took the caller's (main) thread for tens of milliseconds.
                val bootstrap = withContext(background) { api.bootstrap() }
                bootstrapSucceeded = true
                refreshedAt = platformNowMillis()
                val fresh = read > listApplied
                if (fresh) listApplied = read
                val freshProjects = projectRead == projectReads && projectRead > projectApplied && projectWritesAtStart == projectWrites
                if (freshProjects) projectApplied = projectRead
                val freshWorkItems = bootstrap.workItemSummaries != null && workItemRead == workItemReads && workItemRead > workItemApplied
                if (freshWorkItems) workItemApplied = workItemRead
                listDelta = bootstrap.protocol?.features?.contains(LIST_DELTA_FEATURE) == true
                bootstrap.revisions?.let { revisions ->
                    if (fresh) sessionsEtag = "W/\"${revisions.sessions}\""
                    if (freshProjects) {
                        projectsRevision = revisions.projects
                        projectsRevisionLoaded = true
                    }
                    if (freshWorkItems) {
                        workItemsRevision = revisions.workItems
                        workItemsRevisionLoaded = revisions.workItems != null
                    }
                }
                lateinit var sessions: List<Session>
                lateinit var held: List<Session>
                _list.update { state ->
                    held = state.sessions
                    sessions = if (fresh) reconcileSessions(state.sessions, bootstrap.sessions) else state.sessions
                    SessionListState(
                        projects = if (freshProjects) bootstrap.projects else state.projects,
                        sessions = sessions,
                        settings = if (writesAtStart == settingsWrites) bootstrap.settings else state.settings,
                        backendRevision = state.backendRevision,
                        loading = false,
                        loaded = true,
                        canDeleteSessions = bootstrap.protocol?.features?.contains(DELETE_FEATURE) == true,
                        workItems = if (freshWorkItems) bootstrap.workItemSummaries else state.workItems,
                        teamMembers = bootstrap.teamMembers?.filter { it.archivedAt == null }
                            ?: state.teamMembers.takeIf { bootstrap.protocol?.features?.contains(TEAM_MEMBERS_FEATURE) == true },
                    )
                }
                scheduleListSave()
                if (fresh) confirmRemoved(held, sessions)
                if (fresh) observeSessions(sessions)
                prefetch(sessions)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Throwable) {
                if (error is RiffetUnauthenticatedException) signedOut()
                _list.update {
                    it.copy(
                        loading = false,
                        loaded = true,
                        error = if (error is RiffetUnauthenticatedException) UNAUTHENTICATED_REASON else error.message ?: L10n.uiText("sessionList.loadFailed"),
                        unreachable = error is RiffetNetworkException,
                    )
                }
            }
        }
        refreshJob = job
        job.start()
        return job
    }

    suspend fun pollSessions() {
        if (unauthenticated.value) return
        // A cache (or an unsuccessful refresh) is loaded UI state, not a network bootstrap.
        // Until projects and defaults have arrived, retry that full read at the poll's cadence.
        // A store with a device copy bootstraps on its first poll too: a session-only read landing first would mark
        // the list loaded with no projects and keep the copy from being restored, and the new-session page would
        // show its setup steps until the bootstrap answered (a flash on every launch).
        // Plain session-only callers without a copy that never requested bootstrap keep their existing behavior.
        if (!bootstrapSucceeded && (refreshJob != null || cache != null)) {
            startRefresh().join()
            return
        }
        // A read dropped because a local write overtook it is repeated at once, not at the next push.
        repeat(2) { if (readSessions()) return }
    }

    /** One session list read; false when its answer was dropped for being overtaken. */
    private suspend fun readSessions(): Boolean {
        val since = if (listDelta) sessionsEtag?.let(::etagRevision) else null
        if (since != null) return readSessionDelta(since)
        val read = ++listReads
        val answer = try {
            withContext(background) { api.sessionsIfChanged(sessionsEtag) }
        } catch (unauthenticated: RiffetUnauthenticatedException) {
            signedOut()
            throw unauthenticated
        }
        // 304: the server's list still is the revision this one was read at; nothing to fold in.
        val polled = answer.items ?: return true
        if (read < listApplied) return false
        sessionsEtag = answer.etag
        listApplied = read
        lateinit var sessions: List<Session>
        lateinit var held: List<Session>
        _list.update { state ->
            held = state.sessions
            sessions = reconcileSessions(state.sessions, polled)
            state.copy(sessions = sessions, loaded = true)
        }
        confirmRemoved(held, sessions)
        applyPolled(sessions)
        return true
    }

    /**
     * `?since=<revision>`: only the sessions that changed. A `full` answer is the whole list, merged
     * as a plain read is; otherwise they replace their older copies, `removed` ids are dropped (after
     * the server confirms they are deleted) and the list is put back in the server's order.
     */
    private suspend fun readSessionDelta(since: Long): Boolean {
        val read = ++listReads
        val answer = try {
            withContext(background) { api.sessionsSince(since, sessionsEtag) }
        } catch (unauthenticated: RiffetUnauthenticatedException) {
            signedOut()
            throw unauthenticated
        } ?: return true
        val delta = answer.delta
        // An answer older than the list held (one that crossed a newer read or a bootstrap) would move the list back.
        val heldRevision = sessionsEtag?.let(::etagRevision)
        if (read < listApplied || delta.full != true && heldRevision != null && delta.revision < heldRevision) return false
        sessionsEtag = answer.etag
        listApplied = read
        val removed = delta.removed.orEmpty()
        if (delta.full != true && delta.sessions.isEmpty() && removed.isEmpty()) return true
        lateinit var sessions: List<Session>
        lateinit var held: List<Session>
        _list.update { state ->
            held = state.sessions
            sessions = if (delta.full == true) reconcileSessions(state.sessions, delta.sessions) else mergeDelta(state.sessions, delta.sessions, removed)
            state.copy(sessions = sessions, loaded = true)
        }
        if (delta.full == true) confirmRemoved(held, sessions) else confirmGone(removed.filter { id -> held.any { it.id == id } })
        applyPolled(sessions)
        return true
    }

    private fun mergeDelta(held: List<Session>, changed: List<Session>, removed: List<String>): List<Session> {
        val byId = held.associateBy { it.id }
        val gone = removed.toHashSet()
        val replaced = changed.filter { it.id !in gone }.map { session -> byId[session.id]?.takeIf { it.updatedAt > session.updatedAt } ?: session }
        val replacedIds = replaced.mapTo(HashSet()) { it.id }
        return (held.filter { it.id !in gone && it.id !in replacedIds } + replaced).sortedByDescending { it.lastActivityAt ?: it.createdAt }
    }

    /** What follows a list read that changed the list: the open session, the device copy and alerts. */
    private fun applyPolled(sessions: List<Session>) {
        // The open session's stream sends its own `session` frames; a list read only wins when it
        // is newer, or it would put back a state the stream has already moved past.
        core.value.selected?.let { open ->
            sessions.firstOrNull { it.id == open.id && it.updatedAt > open.updatedAt }?.let {
                if (it.state != open.state) log("poll replaces selected ${open.state}@${open.updatedAt} -> ${it.state}@${it.updatedAt}")
                core.update { s -> if (s.selected?.id == it.id && s.selected.updatedAt < it.updatedAt) s.copy(selected = it) else s }
            }
        }
        scheduleListSave()
        val moved = observeSessions(sessions)
        log("poll n=${sessions.size} active=${sessions.count { it.state.active }} moved=${moved.joinToString(",") { "${shortId(it.session.id)}:${it.session.state}" }}")
        // Only the conversations that just moved are fetched (a notification opens on them); the
        // rest wait for the next full refresh. Fetching every running one on every read kept the
        // device copy busy enough to hold up opening a session.
        moved.takeIf { it.isNotEmpty() }?.let { prefetch(it.map { alert -> alert.session }) }
    }

    /**
     * [incoming] as the list to show, except where the list already holds a session in a newer state:
     * a stream `session` frame applied while the read was in flight is newer than the read's answer.
     */
    private fun reconcileSessions(held: List<Session>, incoming: List<Session>): List<Session> {
        val byId = held.associateBy { it.id }
        return incoming.map { session -> byId[session.id]?.takeIf { it.updatedAt > session.updatedAt } ?: session }
    }

    /**
     * The next list read only sets the baseline: whatever moved before it raises no alert. It reads
     * in full (no etag, or a 304 would leave no baseline) and a read already in flight is dropped.
     */
    fun forgetStates() {
        knownStates = null
        sessionsEtag = null
        listApplied = ++listReads
    }

    private fun observeSessions(sessions: List<Session>): List<SessionAlert> {
        val alerts = knownStates?.let { sessionAlerts(it, sessions) }.orEmpty()
        knownStates = sessions.associate { it.id to it.state }
        _activity.tryEmit(SessionActivity(sessions, alerts))
        return alerts
    }

    /** [SessionStore.latestReply] for a conversation that is not open: from the device copy. */
    suspend fun storedReply(session: Session): String? {
        return syncPrefetch()?.storedReply(session)
    }

    private suspend fun restoreList() {
        val stored = cache?.let { runCatching { it.loadList() }.getOrNull() } ?: return
        if (list.value.loaded) return
        _list.value = SessionListState(
            projects = stored.projects,
            sessions = stored.sessions,
            settings = stored.settings,
            loaded = true,
            cachedAt = stored.savedAt,
            teamMembers = stored.teamMembers,
        )
    }

    /** Capture the last list without depending on the soon-to-be-cancelled store scope. */
    internal fun captureFinalFlush(): suspend () -> Unit {
        val cache = cache ?: return {}
        listSaveJob?.cancel()
        listSaveJob = null
        val state = list.value
        if (state.cachedAt != null || (!state.loaded && state.projects.isEmpty() && state.sessions.isEmpty())) return {}
        return { runCatching { cache.saveList(state.projects, state.sessions, state.settings, state.teamMembers) }; Unit }
    }

    private fun scheduleListSave() {
        val cache = cache ?: return
        listSaveJob?.cancel()
        listSaveJob = scope.launch {
            delay(SAVE_DELAY_MILLIS)
            val state = list.value
            if (state.cachedAt != null) return@launch
            runCatching { cache.saveList(state.projects, state.sessions, state.settings, state.teamMembers) }
        }
    }

    /**
     * Brings the stored transcripts of recently active conversations up to date, one at a time.
     *
     * A conversation is fetched only when its activity stamp moved since it was stored, and with
     * the stored newest event as the anchor, so an unchanged conversation costs nothing and a
     * changed one only its new events. The open conversation is skipped: its stream keeps it.
     */
    private fun prefetch(sessions: List<Session>) {
        val sync = syncPrefetch() ?: return
        if (prefetchJob?.isActive == true) return
        val candidates = sessions
            .filter { it.kind == SessionKind.NATIVE && it.archivedAt == null }
            .sortedByDescending { it.activityStamp() }
            .take(PREFETCH_SESSIONS)
        prefetchJob = scope.launch {
            for (session in candidates) {
                if (session.id == openSessionId()) continue
                try {
                    if (sync.storedActivity(session.id) != session.activityStamp()) sync.prefetch(session)
                } catch (cancellation: CancellationException) {
                    throw cancellation
                } catch (_: Throwable) {
                    // One unreachable conversation must not stop the others; the next refresh retries.
                }
            }
        }
    }

    fun reportListError(message: String) {
        _list.update { it.copy(error = message, unreachable = false) }
    }

    suspend fun openDirectory(path: String): Project {
        var project = api.createProject(cwd = path)
        if (project.archivedAt != null) project = api.updateProject(project.id, archived = false)
        projectWrites++
        _list.update { state ->
            state.copy(projects = state.projects.filterNot { it.id == project.id } + project)
        }
        scheduleListSave()
        return project
    }

    suspend fun promoteProject(id: String, name: String): Project {
        val project = api.promoteProject(id, name)
        projectWrites++
        _list.update { state -> state.copy(projects = state.projects.filterNot { it.id == project.id } + project) }
        scheduleListSave()
        return project
    }

    /**
     * Deletes [id] with the side chats the user confirmed ([sessionIds], from [SessionStore.deletionPreview]).
     * A 410 means it is gone already (a lost answer, another device): the same outcome.
     */
    suspend fun deleteSession(id: String, sessionIds: List<String>): List<String> {
        val removed = try {
            api.deleteSession(id, sessionIds).sessionIds
        } catch (gone: RiffetHttpException) {
            if (gone.status != 410 || gone.code != SESSION_DELETED) throw gone
            sessionIds
        }
        removeLocally(removed)
        return removed
    }

    /** Removes [ids] now; a list read already in flight from before is dropped, so it cannot put them back. */
    fun removeLocally(ids: List<String>) {
        if (ids.isEmpty()) return
        val gone = ids.toSet()
        listApplied = ++listReads
        sessionsEtag = null
        _list.update { state -> state.copy(sessions = state.sessions.filterNot { it.id in gone }) }
        knownStates = knownStates?.minus(gone)
        scheduleListSave()
        onRemoved(ids)
    }

    /**
     * Conversations a fresh server list no longer has. Missing alone is not proof (a backup restored on
     * the server, a list this client is not shown): only the server's 410 lets the device copy go.
     */
    private fun confirmRemoved(held: List<Session>, fresh: List<Session>) {
        val present = fresh.mapTo(HashSet()) { it.id }
        confirmGone(held.map { it.id }.filterNot { it in present })
    }

    private fun confirmGone(missing: List<String>) {
        if (missing.isEmpty() || !list.value.canDeleteSessions) return
        scope.launch {
            val deleted = missing.filter { id ->
                try {
                    withContext(background) { api.sessionDeletion(id) }
                    false
                } catch (cancellation: CancellationException) {
                    throw cancellation
                } catch (error: RiffetHttpException) {
                    error.status == 410 && error.code == SESSION_DELETED
                } catch (_: Throwable) {
                    false
                }
            }
            if (deleted.isNotEmpty()) onRemoved(deleted)
        }
    }

    suspend fun updateSession(id: String, body: SessionUpdate): Session {
        val updated = api.updateSession(id, body)
        applySession(updated)
        return updated
    }

    fun applySession(session: Session) {
        _list.update { state ->
            val index = state.sessions.indexOfFirst { it.id == session.id }
            val sessions = if (index < 0) listOf(session) + state.sessions else state.sessions.toMutableList().also { it[index] = session }
            state.copy(sessions = sessions)
        }
        core.value.selected?.takeIf { it.id == session.id }?.let { open ->
            if (open.state != session.state) log("selected ${open.state} -> ${session.state}@${session.updatedAt}")
            core.replaceSelected(session)
        }
        scheduleListSave()
    }

    private val seenReports = mutableMapOf<String, Job>()
    private val seenAgain = mutableSetOf<String>()

    /** The open copy when it is this conversation (its stream is the freshest), else the list's. */
    private fun knownSession(id: String): Session? =
        core.value.selected?.takeIf { it.id == id } ?: _list.value.sessions.firstOrNull { it.id == id }

    /**
     * The conversation is shown in the foreground: report its activity as seen. Called again as
     * activity arrives while it stays shown; reports are coalesced per conversation, and nothing is
     * sent while nothing is unread or the server has no read state.
     */
    fun markSeen(id: String) {
        if (seenReports[id]?.isActive == true) { seenAgain += id; return }
        if (knownSession(id)?.let(::isUnread) != true) return
        seenReports[id] = scope.launch {
            do {
                seenAgain -= id
                delay(SEEN_REPORT_DELAY_MS)
                val latest = knownSession(id)?.takeIf(::isUnread) ?: continue
                try {
                    applySeen(withContext(background) { api.markSessionSeen(id, activityAt(latest)) })
                } catch (cancellation: CancellationException) {
                    throw cancellation
                } catch (error: Throwable) {
                    log("mark seen $id failed: ${error.message}")
                }
            } while (id in seenAgain)
            seenReports -= id
        }
    }

    /** Reports a read time kept on this device before the server had read state; the server never moves it back. */
    suspend fun mergeSeen(id: String, activityAt: String) {
        applySeen(withContext(background) { api.markSessionSeen(id, activityAt) })
    }

    /**
     * A seen report's answer. A stream frame may have landed while it was in flight; over a newer
     * copy only the read time is taken, so a stale running state cannot replace a later idle one.
     */
    private fun applySeen(seen: Session) {
        val held = knownSession(seen.id)
        applySession(
            if (held == null || seen.updatedAt >= held.updatedAt) seen
            else held.copy(seenActivityAt = seen.seenActivityAt ?: held.seenActivityAt),
        )
    }

    /** Mark all as seen; the next list read carries the server's values. */
    suspend fun markAllSeen() {
        withContext(background) { api.markAllSessionsSeen() }
        _list.update { state -> state.copy(sessions = state.sessions.map { if (isUnread(it)) it.copy(seenActivityAt = activityAt(it)) else it }) }
        scheduleListSave()
    }

    suspend fun createSession(
        projectId: String,
        prompt: String,
        attachments: List<Attachment>,
        backendId: NativeBackendId?,
        backendProfileId: String?,
        model: String?,
        mode: String?,
        approval: String?,
        context: List<PromptContextReference> = emptyList(),
        agentId: String? = null,
        toolGroups: List<String>? = null,
        extensionsOff: List<String>? = null,
        agentMemberId: String? = null,
    ): Session {
        val text = prompt.trim()
        // The server names a conversation after its first human message (see `session-title.ts`), so
        // this request carries no title at all: sending one would make the phone's own truncation the
        // conversation's name while the web gets the server's, and the transcript rule would rename it
        // again later.
        val result = api.createSession(
            NativeSessionCreateInput(
                clientSessionId = newClientId(),
                projectId = projectId,
                backendId = backendId?.takeIf { agentId == null } ?: agentId?.let(AgentIds::builtin),
                agentId = agentId?.takeIf { AgentIds.builtin(it) == null },
                backendProfileId = backendProfileId,
                model = model?.takeIf { it.isNotBlank() },
                mode = mode?.takeIf { it.isNotBlank() },
                approval = approval?.takeIf { it.isNotBlank() },
                toolGroups = toolGroups,
                extensionsOff = extensionsOff,
                agentMemberId = agentMemberId,
                initialMessage = NativeMessageInput(
                    commandId = newClientId(),
                    text = text,
                    attachments = attachments.takeIf { it.isNotEmpty() }?.map { AttachmentRef(it.id) },
                    context = context.fileReferences(),
                    references = context.sessionReferences(),
                ),
            ),
        )
        result.project?.let { project ->
            projectWrites++
            _list.update { state -> state.copy(projects = state.projects.filterNot { it.id == project.id } + project) }
            scheduleListSave()
        }
        applySession(result.session)
        core.addCreated(result.run)
        return result.session
    }

    /** Folds a member the server answered with (created, pinned, archived) into the list; an archived one leaves it. */
    fun applyTeamMember(member: AgentMember) {
        _list.update { state ->
            val held = state.teamMembers.orEmpty().filterNot { it.id == member.id }
            state.copy(teamMembers = if (member.archivedAt == null) held + member else held)
        }
        scheduleListSave()
    }

    fun replaceTeamMembers(members: List<AgentMember>) {
        _list.update { state -> state.copy(teamMembers = members.filter { it.archivedAt == null }) }
        scheduleListSave()
    }

    fun removeTeamMember(id: String) {
        _list.update { state -> state.copy(teamMembers = state.teamMembers?.filterNot { it.id == id }) }
        scheduleListSave()
    }

    /** Imports a provider conversation and folds the session, and the project it may have created, into the list. */
    suspend fun importExternalSession(backendId: String, backendProfileId: String, nativeSessionId: String): ExternalSessionImport {
        val result = api.importExternalSession(backendId, backendProfileId, nativeSessionId)
        if (_list.value.projects.none { it.id == result.session.projectId }) {
            val projectRead = ++projectReads
            projectWrites++
            val projects = runCatching { api.projects() }.getOrNull()
            if (projects != null) {
                projectApplied = maxOf(projectApplied, projectRead)
                _list.update { it.copy(projects = projects) }
            }
        }
        applySession(result.session)
        return result
    }

    suspend fun releaseTerminalHold(id: String, force: Boolean): Session {
        val session = api.releaseTerminalHold(id, force)
        applySession(session)
        return session
    }

    suspend fun createPreparedSession(body: NativeSessionCreateInput): Session {
        val result = api.createSession(body)
        check(body.projectless != true || result.project?.id == result.session.projectId) { "The task receipt does not contain its workspace" }
        result.project?.let { project ->
            projectWrites++
            _list.update { state -> state.copy(projects = state.projects.filterNot { it.id == project.id } + project) }
            scheduleListSave()
        }
        applySession(result.session)
        core.addCreated(result.run)
        return result.session
    }

    fun cancelPrefetch() {
        prefetchJob?.cancel()
    }

    /** [SessionStore.clear]'s share: no prefetch outlives it, and the next read has nothing to compare. */
    fun clear() {
        projectRefreshJob?.cancel()
        projectRefreshJob = null
        projectReads++
        projectsRevision = null
        projectsRevisionLoaded = false
        workItemRefreshJob?.cancel()
        workItemRefreshJob = null
        workItemReads++
        workItemsRevision = null
        workItemsRevisionLoaded = false
        prefetchJob?.cancel()
        prefetchJob = null
        knownStates = null
        sessionsEtag = null
    }
}

private const val DELETE_FEATURE = "session-delete-v1"
private const val LIST_DELTA_FEATURE = "list-delta"

/** The revision an ETag `W/"<revision>"` names; null for any other validator. */
private fun etagRevision(etag: String): Long? = etag.removePrefix("W/").trim('"').toLongOrNull()
private const val SESSION_DELETED = "SESSION_DELETED"

/** How many of the most recently active conversations a refresh brings up to date. */
private const val PREFETCH_SESSIONS = 8

/** The newest events projected to find a conversation's last reply; a reply is never older than its turn. */
private const val REPLY_EVENTS = 200

/** Activity streams in many small steps; one report per second keeps up with a reader without a request per step. */
private const val SEEN_REPORT_DELAY_MS = 1_000L
