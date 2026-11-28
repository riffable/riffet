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
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.coroutines.CoroutineContext
import riffet.cache.ListCache
import riffet.contracts.AgentIds
import riffet.contracts.AgentMember
import riffet.contracts.AppSettings
import riffet.contracts.Attachment
import riffet.contracts.ExternalSessionImport
import riffet.contracts.LinkedServerStatus
import riffet.contracts.NativeBackendId
import riffet.contracts.Project
import riffet.contracts.ServerInfo
import riffet.contracts.Session
import riffet.contracts.SessionKind
import riffet.contracts.SessionState
import riffet.contracts.TEAM_MEMBERS_FEATURE
import riffet.contracts.WorkItemSummary
import riffet.i18n.L10n
import riffet.shared.AttachmentRef
import riffet.shared.NativeMessageInput
import riffet.shared.NativeSessionCreateInput
import riffet.shared.PromptContextReference
import riffet.shared.RiffetApi
import riffet.shared.RiffetHttpException
import riffet.shared.RiffetNetworkException
import riffet.shared.RiffetUnauthenticatedException
import riffet.shared.SessionUpdate
import riffet.shared.createProject
import riffet.shared.createSession
import riffet.shared.deleteSession
import riffet.shared.fileReferences
import riffet.shared.importExternalSession
import riffet.shared.markAllSessionsSeen
import riffet.shared.markSessionSeen
import riffet.shared.projects
import riffet.shared.promoteProject
import riffet.shared.releaseTerminalHold
import riffet.shared.sessionDeletion
import riffet.shared.sessionReferences
import riffet.shared.sessionsIfChanged
import riffet.shared.sessionsSince
import riffet.shared.updateProject
import riffet.shared.updateSession
import riffet.ui.composer.newClientId
import riffet.ui.sessionlist.activityAt
import riffet.ui.sessionlist.isUnread
import riffet.ui.timeline.platformNowMillis

/**
 * The project and session lists behind [SessionStore.list]: the bootstrap read, the cheap polling
 * read and its transitions, linked-server list merging (`docs/SERVER-LINKS.md §5`), the lists'
 * device copy, background prefetch of conversations that moved, and metadata writes folded back
 * into the lists.
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

    private class PeerList(
        val serverId: String,
        val api: RiffetApi,
        val cache: ListCache?,
    ) {
        var projects: List<Project> = emptyList()
        var sessions: List<Session> = emptyList()
        var loaded: Boolean = false
        var bootstrapSucceeded: Boolean = false
        var status: LinkedServerStatus = LinkedServerStatus.LOADING
        var sessionsEtag: String? = null
        var listDelta: Boolean = false
        var projectsRevision: Long? = null
        var projectsRevisionLoaded: Boolean = false
        var requestedProjectsRevision: Long? = null
        var listReads = 0
        var listApplied = 0
        var projectReads = 0L
        var projectApplied = 0L
        var projectWrites = 0L
        var refreshJob: Job? = null
        var projectRefreshJob: Job? = null
        var saveJob: Job? = null
        var retired: Boolean = false
    }

    private fun openSessionId(): String? = core.value.sessionId

    private val _list = MutableStateFlow(SessionListState())
    val list: StateFlow<SessionListState> = _list.asStateFlow()

    private val _activity = MutableSharedFlow<SessionActivity>(extraBufferCapacity = 8)
    val activity: SharedFlow<SessionActivity> = _activity.asSharedFlow()

    // Entry server's own state; merged with [peers] into [_list] by [publishMerged].
    private var entryProjects: List<Project> = emptyList()
    private var entrySessions: List<Session> = emptyList()
    private var entrySettings: AppSettings? = null
    private var entryBackendRevision: Long = 0L
    private var entryLoading: Boolean = false
    private var entryLoaded: Boolean = false
    private var entryError: String? = null
    private var entryUnreachable: Boolean = false
    private var entryCachedAt: Long? = null
    private var entryCanDeleteSessions: Boolean = false
    private var entryWorkItems: List<WorkItemSummary>? = null
    private var entryTeamMembers: List<AgentMember>? = null
    private var selfServerId: String? = null
    private var servers: List<ServerInfo> = emptyList()

    private val peers = LinkedHashMap<String, PeerList>()

    private var listSaveJob: Job? = null
    private var prefetchJob: Job? = null
    private var refreshJob: Job? = null
    private var projectRefreshJob: Job? = null
    private var serversRefreshJob: Job? = null
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

    /** Rebuilds the merged [SessionListState] from entry + all loaded linked peers and updates [api.locator]. */
    private fun publishMerged() {
        val peerProjects = ArrayList<Project>()
        val peerSessions = ArrayList<Session>()
        val linkedStatus = LinkedHashMap<String, LinkedServerStatus>()
        for (peer in peers.values) {
            linkedStatus[peer.serverId] = peer.status
            if (!peer.loaded) continue
            // Linked peer's own system projects (assistant, quick-chat, task-workspace) stay in its own workbench.
            val systemIds = peer.projects.filter { it.system != null }.mapTo(HashSet()) { it.id }
            val keptProjects = if (systemIds.isEmpty()) peer.projects else peer.projects.filterNot { it.id in systemIds }
            val keptSessions = if (systemIds.isEmpty()) peer.sessions else peer.sessions.filterNot { it.projectId in systemIds }
            api.locator.locate(keptProjects.map { it.id }, peer.serverId)
            api.locator.locate(keptSessions.map { it.id }, peer.serverId)
            api.locator.locate(keptSessions.mapNotNull { it.origin?.groupId }, peer.serverId)
            peerProjects.addAll(keptProjects)
            peerSessions.addAll(keptSessions)
        }
        val mergedProjects = if (peerProjects.isEmpty()) entryProjects else entryProjects + peerProjects
        val mergedSessions = if (peerSessions.isEmpty()) {
            entrySessions
        } else {
            (entrySessions + peerSessions).sortedByDescending { it.lastActivityAt ?: it.createdAt }
        }
        _list.value = SessionListState(
            projects = mergedProjects,
            sessions = mergedSessions,
            settings = entrySettings,
            backendRevision = entryBackendRevision,
            loading = entryLoading,
            loaded = entryLoaded,
            error = entryError,
            unreachable = entryUnreachable,
            cachedAt = entryCachedAt,
            canDeleteSessions = entryCanDeleteSessions,
            workItems = entryWorkItems,
            teamMembers = entryTeamMembers,
            selfServerId = selfServerId,
            servers = servers,
            linkedStatus = linkedStatus,
            objectServers = api.locator.snapshot(),
        )
    }

    /**
     * Opens a list holder for each linked server this entry may operate and whose protocol it speaks,
     * and closes any that were removed, unlinked, or lost outbound permission.
     */
    private fun adoptServers(nextServers: List<ServerInfo>, explicitSelfId: String? = null) {
        selfServerId = explicitSelfId ?: nextServers.firstOrNull { it.self == true }?.id ?: selfServerId
        servers = nextServers
        val wanted = nextServers
            .filter { it.self != true && it.outbound && it.compatible }
            .associateBy { it.id }
        val listed = nextServers.mapTo(HashSet()) { it.id }
        for (id in peers.keys.toList()) {
            if (id !in wanted) closePeer(id, forgetCache = id !in listed)
        }
        for ((id, info) in wanted) {
            val existing = peers[id]
            if (existing == null) {
                val peer = PeerList(id, api.forServer(id), cache?.forPeer(id))
                if (!info.online) peer.status = LinkedServerStatus.OFFLINE
                peers[id] = peer
                startPeerRefresh(peer)
            } else if (!info.online) {
                existing.status = LinkedServerStatus.OFFLINE
            } else if (existing.status == LinkedServerStatus.OFFLINE || !existing.bootstrapSucceeded) {
                startPeerRefresh(existing)
            }
        }
        publishMerged()
    }

    private fun closePeer(serverId: String, forgetCache: Boolean) {
        val peer = peers.remove(serverId) ?: return
        peer.retired = true
        peer.refreshJob?.cancel()
        peer.projectRefreshJob?.cancel()
        peer.saveJob?.cancel()
        api.locator.forgetServer(serverId)
        if (forgetCache) {
            peer.cache?.let { target -> scope.launch { runCatching { target.clear() } } }
        }
    }

    /** Re-reads `GET /api/servers` after the entry lists stream announces a `servers` event. */
    fun refreshServers() {
        if (unauthenticated.value) return
        if (serversRefreshJob?.isActive == true) return
        serversRefreshJob = scope.launch {
            try {
                val next = withContext(background) { api.servers() }
                adoptServers(next)
                scheduleListSave()
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Throwable) {
                if (error is RiffetUnauthenticatedException) signedOut()
            }
        }
    }

    private fun startPeerRefresh(peer: PeerList): Job {
        peer.refreshJob?.takeIf { it.isActive }?.let { return it }
        val job = scope.launch(start = CoroutineStart.LAZY) {
            if (!peer.loaded) restorePeerList(peer)
            if (peer.retired) return@launch
            peer.status = LinkedServerStatus.LOADING
            publishMerged()
            try {
                val read = ++peer.listReads
                val projectRead = ++peer.projectReads
                val projectWritesAtStart = peer.projectWrites
                val bootstrap = withContext(background) { peer.api.bootstrap() }
                if (peer.retired || peers[peer.serverId] !== peer) return@launch
                peer.bootstrapSucceeded = true
                peer.status = LinkedServerStatus.FRESH
                val fresh = read > peer.listApplied
                if (fresh) peer.listApplied = read
                val freshProjects = projectRead == peer.projectReads && projectRead > peer.projectApplied && projectWritesAtStart == peer.projectWrites
                if (freshProjects) peer.projectApplied = projectRead
                peer.listDelta = bootstrap.protocol?.features?.contains(LIST_DELTA_FEATURE) == true
                bootstrap.revisions?.let { revisions ->
                    if (fresh) peer.sessionsEtag = "W/\"${revisions.sessions}\""
                    if (freshProjects) {
                        peer.projectsRevision = revisions.projects
                        peer.projectsRevisionLoaded = true
                    }
                }
                val held = peer.sessions
                if (freshProjects) peer.projects = bootstrap.projects
                if (fresh) peer.sessions = reconcileSessions(peer.sessions, bootstrap.sessions)
                peer.loaded = true
                publishMerged()
                schedulePeerSave(peer)
                if (fresh) {
                    confirmRemoved(held, peer.sessions, peer.api)
                    observeSessions(_list.value.sessions)
                }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Throwable) {
                if (error is RiffetUnauthenticatedException) signedOut()
                if (peer.retired || peers[peer.serverId] !== peer) return@launch
                peer.status = LinkedServerStatus.OFFLINE
                publishMerged()
            }
        }
        peer.refreshJob = job
        job.start()
        return job
    }

    private suspend fun restorePeerList(peer: PeerList) {
        val stored = peer.cache?.let { runCatching { it.loadList() }.getOrNull() } ?: return
        if (peer.loaded || peer.retired) return
        peer.projects = stored.projects
        peer.sessions = stored.sessions
        peer.loaded = true
        publishMerged()
    }

    private fun schedulePeerSave(peer: PeerList) {
        val peerCache = peer.cache ?: return
        if (peer.retired) return
        peer.saveJob?.cancel()
        peer.saveJob = scope.launch {
            delay(SAVE_DELAY_MILLIS)
            if (peer.retired || !peer.bootstrapSucceeded) return@launch
            runCatching { peerCache.saveList(peer.projects, peer.sessions, settings = null) }
        }
    }

    fun peerListsChanged(serverId: String, data: String?) {
        if (unauthenticated.value) return
        val peer = peers[serverId] ?: return
        val revision = data?.let { REVISION_PATTERN.find(it)?.groupValues?.get(1)?.toLongOrNull() }
        val projects = data?.let { PROJECTS_PATTERN.find(it)?.groupValues?.get(1)?.toLongOrNull() }
        refreshPeerProjects(peer, projects)
        if (revision != null && peer.sessionsEtag == "W/\"$revision\"") return
        scope.launch {
            try {
                pollPeerSessions(peer)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (_: Throwable) {
                // Fallback poll retries.
            }
        }
    }

    private fun refreshPeerProjects(peer: PeerList, revision: Long?) {
        if (unauthenticated.value || peer.retired) return
        if (peer.projectsRevisionLoaded && (revision == null || revision == peer.projectsRevision)) return
        if (peer.projectRefreshJob?.isActive == true && peer.requestedProjectsRevision == revision) return
        peer.projectRefreshJob?.cancel()
        peer.requestedProjectsRevision = revision
        val job = scope.launch(start = CoroutineStart.LAZY) {
            peer.refreshJob?.takeIf { it.isActive }?.join()
            if (unauthenticated.value || peer.retired) return@launch
            if (revision != null && peer.projectsRevisionLoaded && revision == peer.projectsRevision) return@launch
            val read = ++peer.projectReads
            val writesAtStart = peer.projectWrites
            try {
                val projects = withContext(background) { peer.api.projects() }
                if (peer.retired || read != peer.projectReads || read <= peer.projectApplied || writesAtStart != peer.projectWrites) return@launch
                peer.projectApplied = read
                peer.projectsRevision = revision
                peer.projectsRevisionLoaded = true
                peer.projects = projects
                publishMerged()
                schedulePeerSave(peer)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Throwable) {
                if (error is RiffetUnauthenticatedException) signedOut()
            }
        }
        peer.projectRefreshJob = job
        job.start()
    }

    private suspend fun pollPeerSessions(peer: PeerList) {
        if (unauthenticated.value || peer.retired) return
        if (!peer.bootstrapSucceeded) {
            startPeerRefresh(peer).join()
            return
        }
        repeat(2) { if (readPeerSessions(peer)) return }
    }

    private suspend fun readPeerSessions(peer: PeerList): Boolean {
        val since = if (peer.listDelta) peer.sessionsEtag?.let(::etagRevision) else null
        if (since != null) return readPeerSessionDelta(peer, since)
        val read = ++peer.listReads
        val answer = try {
            withContext(background) { peer.api.sessionsIfChanged(peer.sessionsEtag) }
        } catch (unauthenticated: RiffetUnauthenticatedException) {
            signedOut()
            throw unauthenticated
        } catch (error: Throwable) {
            if (error !is CancellationException && !peer.retired) {
                peer.status = LinkedServerStatus.OFFLINE
                publishMerged()
            }
            return true
        }
        if (peer.retired) return true
        peer.status = LinkedServerStatus.FRESH
        val polled = answer.items ?: run {
            publishMerged()
            return true
        }
        if (read < peer.listApplied) return false
        peer.sessionsEtag = answer.etag
        peer.listApplied = read
        val held = peer.sessions
        peer.sessions = reconcileSessions(peer.sessions, polled)
        peer.loaded = true
        publishMerged()
        confirmRemoved(held, peer.sessions, peer.api)
        applyPeerPolled(peer)
        return true
    }

    private suspend fun readPeerSessionDelta(peer: PeerList, since: Long): Boolean {
        val read = ++peer.listReads
        val answer = try {
            withContext(background) { peer.api.sessionsSince(since, peer.sessionsEtag) }
        } catch (unauthenticated: RiffetUnauthenticatedException) {
            signedOut()
            throw unauthenticated
        } catch (error: Throwable) {
            if (error !is CancellationException && !peer.retired) {
                peer.status = LinkedServerStatus.OFFLINE
                publishMerged()
            }
            return true
        } ?: run {
            if (!peer.retired) {
                peer.status = LinkedServerStatus.FRESH
                publishMerged()
            }
            return true
        }
        if (peer.retired) return true
        peer.status = LinkedServerStatus.FRESH
        val delta = answer.delta
        val heldRevision = peer.sessionsEtag?.let(::etagRevision)
        if (read < peer.listApplied || delta.full != true && heldRevision != null && delta.revision < heldRevision) return false
        peer.sessionsEtag = answer.etag
        peer.listApplied = read
        val removed = delta.removed.orEmpty()
        if (delta.full != true && delta.sessions.isEmpty() && removed.isEmpty()) {
            publishMerged()
            return true
        }
        val held = peer.sessions
        peer.sessions = if (delta.full == true) reconcileSessions(peer.sessions, delta.sessions) else mergeDelta(peer.sessions, delta.sessions, removed)
        peer.loaded = true
        publishMerged()
        if (delta.full == true) confirmRemoved(held, peer.sessions, peer.api) else confirmGone(removed.filter { id -> held.any { it.id == id } }, peer.api)
        applyPeerPolled(peer)
        return true
    }

    private fun applyPeerPolled(peer: PeerList) {
        core.value.selected?.let { open ->
            peer.sessions.firstOrNull { it.id == open.id && it.updatedAt > open.updatedAt }?.let {
                if (it.state != open.state) log("peer poll replaces selected ${open.state}@${open.updatedAt} -> ${it.state}@${it.updatedAt}")
                core.update { s -> if (s.selected?.id == it.id && s.selected.updatedAt < it.updatedAt) s.copy(selected = it) else s }
            }
        }
        schedulePeerSave(peer)
        observeSessions(_list.value.sessions)
    }

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
                entryProjects = projects
                publishMerged()
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
                entryWorkItems = items
                publishMerged()
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
        entrySettings = settings
        publishMerged()
        scheduleListSave()
    }

    fun invalidateBackendCatalog() {
        entryBackendRevision++
        publishMerged()
    }

    fun refresh() {
        if (!unauthenticated.value) startRefresh()
    }

    /** Wake, manual refresh and recovery share the same bootstrap while it is in flight. */
    private fun startRefresh(): Job {
        refreshJob?.takeIf { it.isActive }?.let { return it }
        // Publish the job before starting: restoring a cache can immediately wake a list collector.
        val job = scope.launch(start = CoroutineStart.LAZY) {
            if (!entryLoaded) restoreList()
            entryLoading = true
            entryError = null
            entryUnreachable = false
            publishMerged()
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
                val held = entrySessions
                if (freshProjects) entryProjects = bootstrap.projects
                if (fresh) entrySessions = reconcileSessions(entrySessions, bootstrap.sessions)
                if (writesAtStart == settingsWrites) entrySettings = bootstrap.settings
                entryLoading = false
                entryLoaded = true
                entryCachedAt = null
                entryCanDeleteSessions = bootstrap.protocol?.features?.contains(DELETE_FEATURE) == true
                if (freshWorkItems) entryWorkItems = bootstrap.workItemSummaries
                entryTeamMembers = bootstrap.teamMembers?.filter { it.archivedAt == null }
                    ?: entryTeamMembers.takeIf { bootstrap.protocol?.features?.contains(TEAM_MEMBERS_FEATURE) == true }
                adoptServers(bootstrap.servers.orEmpty(), bootstrap.serverId)
                // Re-refresh already-open peers on manual refresh too so stale peer lists recover.
                for (peer in peers.values) {
                    if (peer.bootstrapSucceeded) startPeerRefresh(peer)
                }
                scheduleListSave()
                if (fresh) confirmRemoved(held, entrySessions, api)
                if (fresh) observeSessions(_list.value.sessions)
                prefetch(entrySessions)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Throwable) {
                if (error is RiffetUnauthenticatedException) signedOut()
                entryLoading = false
                entryLoaded = true
                entryError = if (error is RiffetUnauthenticatedException) UNAUTHENTICATED_REASON else error.message ?: L10n.uiText("sessionList.loadFailed")
                entryUnreachable = error is RiffetNetworkException
                publishMerged()
            }
        }
        refreshJob = job
        job.start()
        return job
    }

    suspend fun pollSessions() {
        if (unauthenticated.value) return
        if (!bootstrapSucceeded && (refreshJob != null || cache != null)) {
            startRefresh().join()
            return
        }
        // A read dropped because a local write overtook it is repeated at once, not at the next push.
        for (attempt in 0 until 2) {
            if (readSessions()) break
        }
        for (peer in peers.values.toList()) {
            if (peer.status != LinkedServerStatus.OFFLINE) {
                runCatching { pollPeerSessions(peer) }.onFailure { if (it is CancellationException) throw it }
            }
        }
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
        val held = entrySessions
        entrySessions = reconcileSessions(entrySessions, polled)
        entryLoaded = true
        publishMerged()
        confirmRemoved(held, entrySessions, api)
        applyPolled(entrySessions)
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
        val held = entrySessions
        entrySessions = if (delta.full == true) reconcileSessions(entrySessions, delta.sessions) else mergeDelta(entrySessions, delta.sessions, removed)
        entryLoaded = true
        publishMerged()
        if (delta.full == true) confirmRemoved(held, entrySessions, api) else confirmGone(removed.filter { id -> held.any { it.id == id } }, api)
        applyPolled(entrySessions)
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
        val merged = _list.value.sessions
        val moved = observeSessions(merged)
        log("poll n=${merged.size} active=${merged.count { it.state.active }} moved=${moved.joinToString(",") { "${shortId(it.session.id)}:${it.session.state}" }}")
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
        if (entryLoaded) return
        entryProjects = stored.projects
        entrySessions = stored.sessions
        entrySettings = stored.settings
        entryLoaded = true
        entryCachedAt = stored.savedAt
        entryTeamMembers = stored.teamMembers
        selfServerId = stored.serverId
        if (!stored.servers.isNullOrEmpty()) {
            adoptServers(stored.servers, stored.serverId)
        } else {
            publishMerged()
        }
    }

    /** Capture the last list without depending on the soon-to-be-cancelled store scope. */
    internal fun captureFinalFlush(): suspend () -> Unit {
        val writes = ArrayList<suspend () -> Unit>()
        cache?.let { entryCache ->
            listSaveJob?.cancel()
            listSaveJob = null
            if (entryCachedAt == null && (entryLoaded || entryProjects.isNotEmpty() || entrySessions.isNotEmpty())) {
                val p = entryProjects
                val s = entrySessions
                val cfg = entrySettings
                val tm = entryTeamMembers
                val sid = selfServerId
                val srvs = servers.takeIf { it.isNotEmpty() }
                writes.add { runCatching { entryCache.saveList(p, s, cfg, tm, sid, srvs) } }
            }
        }
        for (peer in peers.values) {
            val peerCache = peer.cache ?: continue
            peer.saveJob?.cancel()
            peer.saveJob = null
            if (peer.bootstrapSucceeded) {
                val p = peer.projects
                val s = peer.sessions
                writes.add { runCatching { peerCache.saveList(p, s, settings = null) } }
            }
        }
        return { for (write in writes) write() }
    }

    private fun scheduleListSave() {
        val cache = cache ?: return
        listSaveJob?.cancel()
        listSaveJob = scope.launch {
            delay(SAVE_DELAY_MILLIS)
            if (entryCachedAt != null) return@launch
            runCatching {
                cache.saveList(
                    entryProjects,
                    entrySessions,
                    entrySettings,
                    entryTeamMembers,
                    selfServerId,
                    servers.takeIf { it.isNotEmpty() },
                )
            }
        }
    }

    /**
     * Brings the stored transcripts of recently active conversations up to date, one at a time.
     */
    private fun prefetch(sessions: List<Session>) {
        val sync = syncPrefetch() ?: return
        if (prefetchJob?.isActive == true) return
        val candidates = sessions
            .filter { session ->
                session.kind == SessionKind.NATIVE && session.archivedAt == null &&
                    api.locator.serverOf(session.id)?.let { peers[it]?.status != LinkedServerStatus.OFFLINE } != false
            }
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
        entryError = message
        entryUnreachable = false
        publishMerged()
    }

    suspend fun openDirectory(path: String, serverId: String? = null): Project {
        val target = serverId?.takeIf { it.isNotEmpty() }
        val targetApi = api.forServer(target)
        var project = targetApi.createProject(cwd = path)
        if (project.archivedAt != null) project = targetApi.updateProject(project.id, archived = false)
        if (target != null) {
            api.locator.locateOne(project.id, target)
            peers[target]?.let { peer ->
                peer.projectWrites++
                peer.projects = peer.projects.filterNot { it.id == project.id } + project
                peer.loaded = true
                schedulePeerSave(peer)
            }
        } else {
            projectWrites++
            entryProjects = entryProjects.filterNot { it.id == project.id } + project
            scheduleListSave()
        }
        publishMerged()
        return project
    }

    suspend fun promoteProject(id: String, name: String): Project {
        val target = api.locator.serverOf(id)
        val project = api.promoteProject(id, name)
        if (target != null) {
            api.locator.locateOne(project.id, target)
            peers[target]?.let { peer ->
                peer.projectWrites++
                peer.projects = peer.projects.filterNot { it.id == project.id } + project
                schedulePeerSave(peer)
            }
        } else {
            projectWrites++
            entryProjects = entryProjects.filterNot { it.id == project.id } + project
            scheduleListSave()
        }
        publishMerged()
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
        entrySessions = entrySessions.filterNot { it.id in gone }
        for (peer in peers.values) {
            if (peer.sessions.any { it.id in gone }) {
                peer.listApplied = ++peer.listReads
                peer.sessionsEtag = null
                peer.sessions = peer.sessions.filterNot { it.id in gone }
                schedulePeerSave(peer)
            }
        }
        knownStates = knownStates?.minus(gone)
        publishMerged()
        scheduleListSave()
        onRemoved(ids)
    }

    private fun confirmRemoved(held: List<Session>, fresh: List<Session>, targetApi: RiffetApi) {
        val present = fresh.mapTo(HashSet()) { it.id }
        confirmGone(held.map { it.id }.filterNot { it in present }, targetApi)
    }

    private fun confirmGone(missing: List<String>, targetApi: RiffetApi) {
        if (missing.isEmpty() || !entryCanDeleteSessions) return
        scope.launch {
            val deleted = missing.filter { id ->
                try {
                    withContext(background) { targetApi.sessionDeletion(id) }
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

    fun applySession(session: Session, serverId: String? = null) {
        val owner = serverId?.takeIf { it.isNotEmpty() }
            ?: api.locator.serverOf(session.id)
            ?: api.locator.serverOf(session.projectId)
        if (owner != null) {
            api.locator.locateOne(session.id, owner)
            peers[owner]?.let { peer ->
                val index = peer.sessions.indexOfFirst { it.id == session.id }
                peer.sessions = if (index < 0) listOf(session) + peer.sessions else peer.sessions.toMutableList().also { it[index] = session }
                peer.loaded = true
                schedulePeerSave(peer)
            }
        } else {
            val index = entrySessions.indexOfFirst { it.id == session.id }
            entrySessions = if (index < 0) listOf(session) + entrySessions else entrySessions.toMutableList().also { it[index] = session }
            scheduleListSave()
        }
        publishMerged()
        core.value.selected?.takeIf { it.id == session.id }?.let { open ->
            if (open.state != session.state) log("selected ${open.state} -> ${session.state}@${session.updatedAt}")
            core.replaceSelected(session)
        }
    }

    private val seenReports = mutableMapOf<String, Job>()
    private val seenAgain = mutableSetOf<String>()

    /** The open copy when it is this conversation (its stream is the freshest), else the list's. */
    private fun knownSession(id: String): Session? =
        core.value.selected?.takeIf { it.id == id } ?: _list.value.sessions.firstOrNull { it.id == id }

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

    private fun applySeen(seen: Session) {
        val held = knownSession(seen.id)
        applySession(
            if (held == null || seen.updatedAt >= held.updatedAt) seen
            else held.copy(seenActivityAt = seen.seenActivityAt ?: held.seenActivityAt),
        )
    }

    /** Mark all as seen across the entry server and every reachable linked peer. */
    suspend fun markAllSeen() {
        withContext(background) { api.markAllSessionsSeen() }
        entrySessions = entrySessions.map { if (isUnread(it)) it.copy(seenActivityAt = activityAt(it)) else it }
        for (peer in peers.values.toList()) {
            if (peer.status == LinkedServerStatus.OFFLINE) continue
            try {
                withContext(background) { peer.api.markAllSessionsSeen() }
                peer.sessions = peer.sessions.map { if (isUnread(it)) it.copy(seenActivityAt = activityAt(it)) else it }
                schedulePeerSave(peer)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (_: Throwable) {
                // One unreachable peer does not undo the entry server's mark-all-seen.
            }
        }
        publishMerged()
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
        serverId: String? = null,
    ): Session {
        val text = prompt.trim()
        val target = serverId?.takeIf { it.isNotEmpty() } ?: api.locator.serverOf(projectId)
        val result = api.forServer(target).createSession(
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
        foldCreated(result, target)
        return result.session
    }

    private fun foldCreated(result: riffet.shared.NativeSessionCreateResult, target: String?) {
        if (target != null) {
            api.locator.locateOne(result.session.id, target)
            result.project?.let { project ->
                api.locator.locateOne(project.id, target)
                peers[target]?.let { peer ->
                    peer.projectWrites++
                    peer.projects = peer.projects.filterNot { it.id == project.id } + project
                    schedulePeerSave(peer)
                }
            }
        } else {
            result.project?.let { project ->
                projectWrites++
                entryProjects = entryProjects.filterNot { it.id == project.id } + project
                scheduleListSave()
            }
        }
        applySession(result.session, target)
        core.addCreated(result.run)
    }

    /** Folds a member the server answered with (created, pinned, archived) into the list; an archived one leaves it. */
    fun applyTeamMember(member: AgentMember) {
        val held = entryTeamMembers.orEmpty().filterNot { it.id == member.id }
        entryTeamMembers = if (member.archivedAt == null) held + member else held
        publishMerged()
        scheduleListSave()
    }

    fun replaceTeamMembers(members: List<AgentMember>) {
        entryTeamMembers = members.filter { it.archivedAt == null }
        publishMerged()
        scheduleListSave()
    }

    fun removeTeamMember(id: String) {
        entryTeamMembers = entryTeamMembers?.filterNot { it.id == id }
        publishMerged()
        scheduleListSave()
    }

    /** Imports a provider conversation and folds the session, and the project it may have created, into the list. */
    suspend fun importExternalSession(backendId: String, backendProfileId: String, nativeSessionId: String, serverId: String? = null): ExternalSessionImport {
        val target = serverId?.takeIf { it.isNotEmpty() }
        val targetApi = api.forServer(target)
        val result = targetApi.importExternalSession(backendId, backendProfileId, nativeSessionId)
        if (target != null) {
            api.locator.locateOne(result.session.id, target)
            api.locator.locateOne(result.session.projectId, target)
            peers[target]?.let { peer ->
                if (peer.projects.none { it.id == result.session.projectId }) {
                    val projectRead = ++peer.projectReads
                    peer.projectWrites++
                    val projects = runCatching { targetApi.projects() }.getOrNull()
                    if (projects != null) {
                        peer.projectApplied = maxOf(peer.projectApplied, projectRead)
                        peer.projects = projects
                    }
                }
            }
        } else if (entryProjects.none { it.id == result.session.projectId }) {
            val projectRead = ++projectReads
            projectWrites++
            val projects = runCatching { api.projects() }.getOrNull()
            if (projects != null) {
                projectApplied = maxOf(projectApplied, projectRead)
                entryProjects = projects
            }
        }
        applySession(result.session, target)
        return result
    }

    suspend fun releaseTerminalHold(id: String, force: Boolean): Session {
        val session = api.releaseTerminalHold(id, force)
        applySession(session)
        return session
    }

    suspend fun createPreparedSession(body: NativeSessionCreateInput, serverId: String? = null): Session {
        val target = serverId?.takeIf { it.isNotEmpty() } ?: body.projectId?.let(api.locator::serverOf)
        val result = api.forServer(target).createSession(body)
        check(body.projectless != true || result.project?.id == result.session.projectId) { "The task receipt does not contain its workspace" }
        foldCreated(result, target)
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
        serversRefreshJob?.cancel()
        serversRefreshJob = null
        for (peer in peers.values) {
            peer.retired = true
            peer.refreshJob?.cancel()
            peer.projectRefreshJob?.cancel()
            peer.saveJob?.cancel()
        }
        peers.clear()
        api.locator.clear()
        prefetchJob?.cancel()
        prefetchJob = null
        knownStates = null
        sessionsEtag = null
    }
}

private const val DELETE_FEATURE = "session-delete-v1"
private const val LIST_DELTA_FEATURE = "list-delta"
private val REVISION_PATTERN = Regex("\"revision\"\\s*:\\s*(\\d+)")
private val PROJECTS_PATTERN = Regex("\"projects\"\\s*:\\s*(\\d+)")

/** The revision an ETag `W/"<revision>"` names; null for any other validator. */
private fun etagRevision(etag: String): Long? = etag.removePrefix("W/").trim('"').toLongOrNull()
private const val SESSION_DELETED = "SESSION_DELETED"

/** How many of the most recently active conversations a refresh brings up to date. */
private const val PREFETCH_SESSIONS = 8

/** Activity streams in many small steps; one report per second keeps up with a reader without a request per step. */
private const val SEEN_REPORT_DELAY_MS = 1_000L
