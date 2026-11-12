package riffet.ui.state

import riffet.shared.SessionDeletionPreview
import riffet.shared.sessionDeletion
import riffet.shared.ClientPerf
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.buffer
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlin.coroutines.CoroutineContext
import riffet.contracts.AppSettings
import riffet.contracts.Attachment
import riffet.contracts.AgentIds
import riffet.contracts.NativeBackendId
import riffet.contracts.NativeDeliveryState
import riffet.i18n.L10n
import riffet.contracts.NativeInteraction
import riffet.contracts.NativeSlashCatalog
import riffet.contracts.NativeInteractionResponse
import riffet.contracts.NativeInteractionResult
import riffet.contracts.NativeContext
import riffet.contracts.NativeHistoryState
import riffet.contracts.NativeStatus
import riffet.contracts.NativeStatusPhase
import riffet.contracts.OutputRate
import riffet.contracts.Project
import riffet.contracts.Run
import riffet.contracts.RunMetrics
import riffet.contracts.RunState
import riffet.contracts.ExternalSessionImport
import riffet.contracts.Session
import riffet.contracts.WorkbenchEvent
import riffet.cache.createLocalFiles
import riffet.cache.IndexHit
import riffet.cache.ListCache
import riffet.cache.TimelineCache
import riffet.cache.platformSyncWindow
import riffet.core.StoredSubagent
import riffet.core.TimelineItem
import riffet.shared.AppLog
import riffet.shared.SessionUpdate
import riffet.shared.PromptContextReference
import riffet.shared.fileReferences
import riffet.shared.sessionReferences
import riffet.shared.StreamConnection
import riffet.shared.RiffetApi
import riffet.shared.RiffetHttpException
import riffet.shared.RiffetUnauthenticatedException
import riffet.shared.NativeMessageInput
import riffet.shared.NativeSessionCreateInput
import riffet.shared.AttachmentRef
import riffet.ui.composer.newClientId
import riffet.ui.composer.NativeSessionCreationOutbox
import riffet.ui.composer.PendingSessionCreation
import riffet.ui.composer.NativeSendOutbox
import riffet.ui.composer.OutboxStore
import riffet.ui.composer.UploadableAttachment
import riffet.ui.composer.createOutboxStore
import riffet.ui.timeline.platformNowMillis
import riffet.shared.sessionBlob
import riffet.shared.sessionCatalog
import riffet.shared.agentSlashCatalog
import riffet.shared.stopNativeActivity

/**
 * The bridge from `shared`'s network layer and `core`'s projection into observable Compose state.
 *
 * ## What it mirrors
 *
 * The stream handling is a port of `apps/web/src/app/session/useNativeSession.ts`. The part that
 * matters is the `reset` branch: the server replays a full snapshot on **every** connection, so a
 * naive "reset replaces everything" throws away the reader's scroll position and every older page
 * they paged in. Scoped snapshots keep the resident prefix and replace the authoritative tail,
 * repairing gaps before publication. Older servers without `replaceFrom` retain the conservative
 * [NativeTimelineModel.continuedBy] fallback.
 *
 * ## Sending, queueing and answering
 *
 * The write half is also a port of the same file plus `apps/web/src/lib/api.ts`. Its one invariant
 * is the outbox (see `riffet.ui.composer.Outbox`): the request is persisted with its `commandId`
 * **before** the POST, removed only on a definitive answer, and kept when the result is unknown so
 * a retry is byte-identical and the server returns the original receipt.
 * [SessionComposer.withLocalOutbox] turns those kept entries into the `uncertain` runs the composer
 * offers to retry, and prunes them the moment a `runs` frame shows the server already has the
 * command.
 *
 * ## The device copy
 *
 * With a [cache], what the phone has seen outlives the process. Opening a conversation draws its
 * stored transcript first and dials after, naming the newest stored event, so the server's reset
 * carries only what is new and *extends* the stored transcript by the same rule a reconnect uses.
 * When too much happened for one reset the server sends its newest window instead, and the gap
 * between that window and the stored transcript is paged in ([fillGap]) rather than the stored part
 * being thrown away. Every change is written back, appended where it only extends. The lists are
 * stored too, and on each refresh the conversations that moved are brought up to date in the
 * background ([SessionLists]), so the next one opened is usually current before it is opened.
 *
 * ## How it is split
 *
 * This class keeps the stream: the subscription and its frames, history paging and the device copy
 * of the open transcript, which all share one model. Everything observable about the open
 * conversation lives in one [StoreState] behind a single reducer ([StateStore]); the public flows
 * are projections of it. A writer carries the epoch (which conversation) or dial (which
 * subscription) it started in and the reducer drops it once that is gone, which replaces the
 * per-feature staleness tokens. The lists
 * ([SessionLists]), the composer ([SessionComposer]), the CLI dialog ([SessionInteractions]) and the
 * child transcripts ([SessionSubagents]) are helpers it owns and delegates to.
 *
 * ## What it deliberately does not do
 *
 * It keeps exactly one live stream: selecting another session or calling [clear] cancels the
 * previous subscription first.
 *
 * @param stream the message source, defaulting to [RiffetApi.nativeStream] with the open
 *   transcript's newest event as its anchor. It is a function rather than a `NativeStreamSource`
 *   because that class is `internal` to `shared` and cannot be named in a public signature; it also
 *   makes the reset-vs-append decision testable without a socket.
 * @param outboxStore where a send is persisted between the POST and its answer. The default is the
 *   platform store (`SharedPreferences` on Android); tests pass an in-memory one.
 * @param background where frames are decoded and projected into the timeline. A long session's
 *   snapshot is thousands of events; projecting it on the UI thread is a dropped frame per chunk.
 *   Tests pass `EmptyCoroutineContext` to keep everything on their own dispatcher.
 * @param cache the device copy of transcripts and lists; null keeps everything in memory.
 * @param warmSessions how many recently left sessions stay in memory for an instant return (see
 *   [warm]); a desktop holds more than a phone.
 * @param syncProtocol v2 or v3 (docs/SYNC-V3.md), fixed for the store's life: [SyncProtocol.selected]
 *   is the one switch point. A v3 store routes the stream, paging, prefetch and the device copy
 *   through [SessionSync] and never calls the v2 stream, snapshot or history routes.
 * @param timelineCache the v3 device copy; a host whose windows share one [cache] passes one
 *   instance here too. Null with a [cache] creates one.
 */
class SessionStore(
    private val api: RiffetApi,
    private val scope: CoroutineScope,
    outboxStore: OutboxStore = createOutboxStore(api.baseUrl),
    private val background: CoroutineContext = Dispatchers.Default,
    creationOutbox: NativeSessionCreationOutbox? = null,
    timelineCache: TimelineCache? = null,
    listCache: ListCache? = null,
) {

    private val creations by lazy { creationOutbox ?: NativeSessionCreationOutbox(createLocalFiles(), api.baseUrl) }


    /**
     * The single state of the open conversation. Every public flow below is a projection of it, and
     * every writer (stream frames, HTTP answers, user actions) goes through its reducer carrying the
     * [StoreState.epoch] or [StoreState.dial] it started in; see [StoreState].
     */
    private val core = StateStore()

    val selected: StateFlow<Session?> = Projection(core.state) { it.selected }

    /**
     * True once the server has answered 401: this device's token was revoked or is not one it
     * issued. Nothing redials or re-polls after that — it would keep the phone awake retrying a
     * credential that will never work — and only a new pairing, which installs a new store, helps.
     */
    private val _unauthenticated = MutableStateFlow(false)
    val unauthenticated: StateFlow<Boolean> = _unauthenticated.asStateFlow()

    private val lists = SessionLists(
        api = api,
        scope = scope,
        background = background,
        cache = listCache,
        core = core,
        unauthenticated = _unauthenticated,
        signedOut = ::signedOut,
        syncPrefetch = { sync },
        onRemoved = { removed(it) },
    )
    val list: StateFlow<SessionListState> = lists.list

    private val _removedSessions = MutableSharedFlow<List<String>>(extraBufferCapacity = 8)

    /** Conversations deleted on the server, by this device or another: a page, window or route showing one closes. */
    val removedSessions: SharedFlow<List<String>> = _removedSessions.asSharedFlow()

    val timeline: StateFlow<List<TimelineItem>> = Projection(core.state, sameRef = true) { it.timeline }

    /** The open session, whether it has loaded and its rows, from one snapshot: combining the separate flows can pair a loaded flag with the rows from before it. */
    val openedTimeline: StateFlow<OpenedTimeline> = Projection(core.state) { OpenedTimeline(it.selected?.id, it.loaded, it.timeline) }
    val status: StateFlow<NativeStatus?> = Projection(core.state) { it.status }

    val runs: StateFlow<List<Run>> = Projection(core.state) { it.runs }

    /**
     * Follow-ups waiting for their turn ([messagePlace]): accepted ones, and while the session works,
     * ones still submitting, whose dock actions wait for the server ([inQueue]). A newly created
     * session's first prompt stays inline.
     */
    val queued: StateFlow<List<Run>> = Projection(core.state) { it.queued }

    /**
     * Whether the CLI is working, from its own status frames (the web's `working`). Runs are not
     * used for this: a run can settle without the transcript echo its delivery waits for, and a
     * stop button derived from it then stays up for good.
     */
    val working: StateFlow<Boolean> = Projection(core.state) { it.isWorking() }

    /** Sends whose HTTP result is unknown; the composer offers a same-request retry for these. */
    val uncertain: StateFlow<List<Run>> = Projection(core.state) { it.uncertain }

    /**
     * The model's rolling output speed, apart from [status] and [openSession] because it changes many
     * times a second while a turn streams. Null while disconnected: a rate cannot age without a stream.
     */
    val outputRate: StateFlow<OutputRate?> = Projection(core.state) { it.status?.outputRate }

    private val interactions = SessionInteractions(api = api, core = core)
    val interaction: StateFlow<NativeInteraction?> = Projection(core.state) { it.interaction }

    private val composer = SessionComposer(
        api = api,
        scope = scope,
        outbox = NativeSendOutbox(outboxStore),
        core = core,
        list = lists.list,
        interactions = interactions,
        defaultSteerTarget = ::defaultSteerTarget,
    )
    val sendState: StateFlow<ComposerSendState> = Projection(core.state) { it.send }

    val connection: StateFlow<RiffetConnectionState> = Projection(core.state) { it.connection }

    /**
     * The open session's live state as one atomic snapshot: [selected], [interaction], [queued],
     * [uncertain], [runs], [status] (without its output rate), [working], [connection], [sendState],
     * [history], [loadingHistory], [historyError], [cachedAt], [context], [loaded] and [subagents].
     * It is a projection of the single state, so every field belongs to the same moment.
     */
    val openSession: StateFlow<OpenSessionState> = Projection(core.state) { it.toOpenSession() }

    /**
     * Token speeds reported live by `metrics` frames, keyed by run id.
     *
     * The stream sends a `run` aggregate with each step, and the server also persists the settled
     * aggregate on the Run; this map is the live half, so a turn's speed appears while it is still
     * running instead of only after the next `runs` snapshot.
     */
    private val _liveMetrics = MutableStateFlow<Map<String, RunMetrics>>(emptyMap())
    val liveMetrics: StateFlow<Map<String, RunMetrics>> = _liveMetrics.asStateFlow()

    /**
     * Context-window occupancy, or null when the backend does not report it.
     *
     * The stream is the only source: there is no HTTP endpoint for this, and the server sends a
     * `context` frame on every connect. A backend that cannot measure its own window simply never
     * sends one, so null means "unknown", never "empty" — the meter must render nothing rather than
     * a ring at zero.
     */
    val context: StateFlow<NativeContext?> = Projection(core.state) { it.context }

    /** True once the open session has received its first `reset`; an empty transcript can be real. */
    val loaded: StateFlow<Boolean> = Projection(core.state) { it.loaded }

    /**
     * When the transcript on screen was last confirmed by the server, while it is still the stored
     * copy; null once this connection's reset has brought it up to date.
     */
    val cachedAt: StateFlow<Long?> = Projection(core.state) { it.cachedAt }

    /** Every list read, with the transitions since the one before; see [pollSessions]. */
    val activity: SharedFlow<SessionActivity> = lists.activity

    /** Where the older part of the transcript starts; the stream only sends its newest rows. */
    val history: StateFlow<NativeHistoryState?> = Projection(core.state) { it.history }

    /** The resident history window ends before the conversation's newest rows. */
    val hasNewerHistory: StateFlow<Boolean> = Projection(core.state) { it.hasNewerHistory }

    val loadingHistory: StateFlow<Boolean> = Projection(core.state) { it.loadingHistory }

    /** Set when an older page failed; reaching the top stops retrying until [retryHistory]. */
    val historyError: StateFlow<String?> = Projection(core.state) { it.historyError }

    private val timelines: TimelineCache? = timelineCache

    /** The open conversation's sync (docs/SYNC-V3.md): its lanes, their device copy, paging and jumps. */
    private val sync: SessionSync = SessionSync(
        api = api,
        scope = scope,
        background = background,
        core = core,
        cache = timelines,
        window = timelines?.window ?: platformSyncWindow,
        hooks = SyncHooks(
            pendingEntries = { composer.pendingEntries(it) },
            upsertEntries = { composer.upsertEntries(it) },
            applySession = { applySession(it) },
            signedOut = { signedOut() },
            unauthenticated = _unauthenticated,
            liveMetrics = _liveMetrics,
            activityStamp = { id -> lists.list.value.sessions.firstOrNull { it.id == id }?.activityStamp() },
            deleted = { id -> lists.removeLocally(listOf(id)) },
            conversationChanged = { find.close() },
        ),
    )

    /** Find within the open conversation (shared state machine); closes when another conversation opens. */
    val find: SessionFind = SessionFind(api, scope, sync)

    val subagents: StateFlow<List<StoredSubagent>> = Projection(core.state) { it.subagents }
    val loadingSubagent: StateFlow<String?> = sync.loadingLane
    val subagentError: StateFlow<String?> = sync.laneError

    /** Sync v3: the server does not speak it, so nothing syncs until the server is updated. Always false for v2. */
    val serverTooOld: StateFlow<Boolean> = sync.serverTooOld

    /** Sync v3: the open conversation's turns, for the outline and jumps past the window; null for v2. */
    val outline: StateFlow<SyncOutlineState?> = sync.outline

    /** Sync v3: rows whose text is a preview, by key, with the full row's size; see [expandRow]. */
    val truncatedRows: StateFlow<Map<String, Long>> = sync.truncated

    /** Sync v3: the open conversation's activities still in progress, including ones past the window. */
    val liveActivities: StateFlow<List<riffet.contracts.NativeActivity>> =
        sync.liveActivities

    /** Sync v3: replaces a truncated row's preview with its full content; false when it cannot be read. */
    @Throws(Exception::class)
    suspend fun expandRow(key: String): Boolean = sync.expandRow(key)

    /** Sync v3: shows the rows around [pos] (a row's `pos`, e.g. an outline turn's `startPos` or a search hit). */
    fun jumpTo(pos: Long) {
        sync.jumpTo(pos)
    }

    /** Sync v3: the rows after the newest one held, after paging or jumping away from the newest. */
    fun loadNewer() {
        sync.loadNewer()
    }

    /** Sync v3: back to the newest rows after paging or jumping away from them. */
    fun jumpToLatest() {
        sync.jumpToLatest()
    }

    /** [toolCallId]'s subagent lane, streamed while collected. */
    fun lane(toolCallId: String): Flow<LaneView> = sync.lane(toolCallId)

    /** The open session, from the single state. */
    private val openSessionId: String? get() = core.value.sessionId

    /**
     * Hints from a host that a conversation is about to be opened (the pointer rests on its row) or was
     * left for good. The sync reads a stored lane without projecting it, so there is nothing to draw ahead
     * or to drop; the hosts keep offering them.
     */
    fun preload(sessionId: String) = Unit
    fun cancelPreload(sessionId: String) = Unit
    fun forgetWarm(sessionId: String) = Unit

    init {
        // The web's `syncPending` effect (`useNativeSession.ts`): every change to the run list —
        // an optimistic send, the POST's answer, a `runs` frame — is reconciled into the timeline,
        // so a sent message shows at the end at once instead of waiting for the CLI to echo it
        // into its transcript (which, behind a running turn, can take minutes).
        scope.launch {
            core.state.map { it.runs }.distinctUntilChanged().collect { sync.runsChanged() }
        }
        // The composer's stop button follows this.
        scope.launch { working.collect { log("working $it") } }
        // Search is the least urgent work on the device: the index catches up only once saves have
        // paused, so a streaming turn or a session being opened never shares a moment with it.
        timelines?.let { stored ->
            scope.launch {
                indexQuietly { stored.indexMissing() }
                stored.indexChanges.collectLatest {
                    delay(INDEX_DELAY_MILLIS)
                    indexQuietly { stored.indexPending() }
                }
            }
        }
    }

    /** Messages on the device that match [query], newest first; see [TimelineCache.search]. */
    @Throws(Exception::class)
    suspend fun searchMessages(query: String, sessionId: String? = null): List<IndexHit> {
        if (query.isBlank()) return emptyList()
        return timelines?.search(query, sessionId = sessionId).orEmpty()
    }

    /** The index is derived data: a failed pass leaves it behind until the next change. */
    private suspend fun indexQuietly(block: suspend () -> Unit) {
        try {
            block()
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (_: Throwable) {
        }
    }

    /* --------------------------------------------------------------------------------------- */
    /* Lists: bootstrap, polling, notifications, metadata writes                                */
    /* --------------------------------------------------------------------------------------- */

    fun applySavedSettings(settings: AppSettings) = lists.applySavedSettings(settings)

    fun invalidateBackendCatalog() = lists.invalidateBackendCatalog()

    /** Loads the project and session lists: the stored copy at once, then the bootstrap endpoint. */
    fun refresh() {
        lists.refresh()
    }

    /**
     * Re-reads the session list after any requested bootstrap has succeeded, retrying it otherwise.
     * The cheap session read tells which conversations started,
     * finished or began waiting. The list follows it, the transitions go to [activity], and the
     * conversations that moved are brought onto the device so a notification opens on content.
     */
    @Throws(Exception::class)
    suspend fun pollSessions() = lists.pollSessions()

    /**
     * The last thing the agent said in [session], for a notification. A conversation that is not
     * open is first brought up to date on the device, so the answer is also there when it is opened.
     */
    @Throws(Exception::class)
    suspend fun latestReply(session: Session): String? {
        if (session.id == openSessionId) return latestReply(core.value.timeline)
        return lists.storedReply(session)
    }

    /** The dialog [sessionId]'s CLI is waiting on; the open conversation answers from its stream. */
    @Throws(Exception::class)
    suspend fun currentInteraction(sessionId: String): NativeInteraction? = interactions.currentInteraction(sessionId)

    /**
     * Answers [sessionId]'s dialog from outside its screen, e.g. a notification button: [action] on
     * the dialog [interactionId] as it was at [revision], with [selectedIds] for a question.
     */
    @Throws(Exception::class)
    suspend fun respondFor(
        sessionId: String,
        interactionId: String,
        revision: String,
        action: String,
        selectedIds: List<String>? = null,
    ): NativeInteractionResult = interactions.respondFor(sessionId, interactionId, revision, action, selectedIds)

    /**
     * Sends [text] to [sessionId] from outside its screen, e.g. a notification's reply field. The
     * outbox rule still holds: an unknown result is kept, and opening the conversation offers the
     * same-request retry. Throws when the server refused it or the result is unknown.
     */
    @Throws(Exception::class)
    suspend fun replyFor(sessionId: String, text: String) = composer.replyFor(sessionId, text)

    /** Shows a failed list action (pin, rename, archive) in the list's error strip. */
    fun reportListError(message: String) = lists.reportListError(message)

    /**
     * Binds a directory on the server host and returns the project for it — the web's
     * `startSessionInDirectory`, which is what lets "start a session" begin anywhere on the Mac
     * rather than only in a directory someone registered from a browser first.
     *
     * The server's `POST /api/projects` is idempotent per canonical path, so choosing a directory
     * that already has a project selects that project instead of creating a second one. An archived
     * one is restored, because the only reason to choose a directory here is to start a session in
     * it. The returned project is folded into the list before this returns, so the caller can select
     * it in the same frame rather than waiting for the next bootstrap.
     */
    @Throws(Exception::class)
    suspend fun openDirectory(path: String): Project = lists.openDirectory(path)

    /**
     * Writes session metadata (rename, pin, archive, tags) and folds the server's copy into the list
     * and, when it is the open one, into [selected]. Throws on failure; nothing is guessed locally.
     */
    @Throws(Exception::class)
    suspend fun updateSession(id: String, body: SessionUpdate): Session = lists.updateSession(id, body)

    /** Folds a server-returned [Session] into the list and the open session. */
    fun applySession(session: Session) = lists.applySession(session)

    /** The conversation is shown in the foreground; call again when its activity moves while it stays shown. */
    fun markSeen(id: String) = lists.markSeen(id)

    /** Mark all as seen, for every conversation this device lists. */
    @Throws(Exception::class)
    suspend fun markAllSeen() = lists.markAllSeen()

    /** Uploads a read time this device kept before the server had read state. */
    @Throws(Exception::class)
    suspend fun mergeSeen(id: String, activityAt: String) = lists.mergeSeen(id, activityAt)

    /** What deleting [id] would remove (its side chats), and why it cannot be deleted now. */
    @Throws(Exception::class)
    suspend fun deletionPreview(id: String): SessionDeletionPreview = try {
        api.sessionDeletion(id)
    } catch (gone: riffet.shared.RiffetHttpException) {
        // Deleted already (another device): it goes from this one too; the caller still hears why.
        if (gone.status == 410 && gone.code == "SESSION_DELETED") lists.removeLocally(listOf(id))
        throw gone
    }

    /**
     * Deletes [id] and the side chats in [sessionIds] (the preview the user confirmed). Throws on
     * failure, leaving everything as it was; on success every removed id goes from the list, the open
     * page and the device copy, and [removedSessions] says so.
     */
    @Throws(Exception::class)
    suspend fun deleteSession(id: String, sessionIds: List<String>): List<String> = lists.deleteSession(id, sessionIds)

    private fun removed(ids: List<String>) {
        val gone = ids.toSet()
        log("removed ${ids.joinToString(",") { it.take(8) }}")
        if (core.value.sessionId in gone) {
            // No write of the open lane follows: its rows are the server's no longer.
            sync.clear()
            core.update { state ->
                state.copy(
                    epoch = state.epoch + 1, dial = state.dial + 1, sessionId = null, selected = null,
                    timeline = emptyList(), loaded = false, connection = RiffetConnectionState.Idle,
                    status = null, interaction = null, subagents = emptyList(),
                ).withoutOutputRate().withoutOpenDeliveries()
            }
        }
        _removedSessions.tryEmit(ids)
        scope.launch(background) {
            for (pending in runCatching { creations.list() }.getOrDefault(emptyList())) if (pending.id in gone) runCatching { creations.remove(pending.id) }
            for (id in ids) runCatching { timelines?.forgetSession(id) }
        }
    }

    /**
     * The web's `createNative`: `POST /api/sessions` with an `initialMessage`, which creates the
     * conversation and submits its first turn atomically. The new session is added to the list.
     */
    @Throws(Exception::class)
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
    ): Session = lists.createSession(projectId, prompt, attachments, backendId, backendProfileId, model, mode, approval, context, agentId)

    /** [createSession] that also names the `device:<id>` tool groups the CLI starts with. */
    @Throws(Exception::class)
    suspend fun createSession(
        projectId: String,
        prompt: String,
        attachments: List<Attachment>,
        backendId: NativeBackendId?,
        backendProfileId: String?,
        model: String?,
        mode: String?,
        approval: String?,
        context: List<PromptContextReference>,
        agentId: String?,
        toolGroups: List<String>?,
        extensionsOff: List<String>? = null,
    ): Session = lists.createSession(projectId, prompt, attachments, backendId, backendProfileId, model, mode, approval, context, agentId, toolGroups, extensionsOff)

    /** Binds a provider conversation found on the server's machine; an already bound one comes back with `created` false. */
    @Throws(Exception::class)
    suspend fun importExternalSession(backendId: String, backendProfileId: String, nativeSessionId: String): ExternalSessionImport =
        lists.importExternalSession(backendId, backendProfileId, nativeSessionId)

    /** Takes a terminal hold back and folds the released session in; 409 `TERMINAL_STILL_RUNNING` unless [force]. */
    @Throws(Exception::class)
    suspend fun releaseTerminalHold(id: String, force: Boolean = false): Session = lists.releaseTerminalHold(id, force)

    @Throws(Exception::class)
    suspend fun promoteProject(id: String, name: String): Project = lists.promoteProject(id, name)

    /** Freeze and persist the exact first message and configuration before the request can leave. */
    @Throws(Exception::class)
    fun prepareCreation(
        projectId: String?,
        prompt: String,
        attachments: List<Attachment>,
        backendId: NativeBackendId?,
        backendProfileId: String?,
        model: String?,
        mode: String?,
        approval: String?,
        context: List<PromptContextReference> = emptyList(),
        agentId: String? = null,
    ): PendingSessionCreation = prepareCreation(projectId, prompt, attachments, backendId, backendProfileId, model, mode, approval, context, agentId, null)

    /** [prepareCreation] that also freezes the `device:<id>` tool groups the CLI starts with. */
    @Throws(Exception::class)
    fun prepareCreation(
        projectId: String?,
        prompt: String,
        attachments: List<Attachment>,
        backendId: NativeBackendId?,
        backendProfileId: String?,
        model: String?,
        mode: String?,
        approval: String?,
        context: List<PromptContextReference>,
        agentId: String?,
        toolGroups: List<String>?,
    ): PendingSessionCreation = prepareCreation(projectId, prompt, attachments, backendId, backendProfileId, model, mode, approval, context, agentId, toolGroups, null)

    /** [prepareCreation] that also freezes the `mcp:<name>` / `skill:<name>` entries the CLI starts without. */
    @Throws(Exception::class)
    fun prepareCreation(
        projectId: String?,
        prompt: String,
        attachments: List<Attachment>,
        backendId: NativeBackendId?,
        backendProfileId: String?,
        model: String?,
        mode: String?,
        approval: String?,
        context: List<PromptContextReference>,
        agentId: String?,
        toolGroups: List<String>?,
        extensionsOff: List<String>?,
    ): PendingSessionCreation {
        require(projectId == null || projectId.isNotBlank()) { "请选择项目" }
        require(projectId != null || backendId != NativeBackendId.CHAT) { "快速对话需要专属项目" }
        require(projectId != null || context.fileReferences().isNullOrEmpty()) { "无项目任务不能引用其他项目文件" }
        require(prompt.isNotBlank()) { "请输入任务内容" }
        return creations.persist(NativeSessionCreateInput(
            clientSessionId = newClientId(), projectId = projectId, projectless = if (projectId == null) true else null,
            backendId = backendId?.takeIf { agentId == null } ?: agentId?.let(AgentIds::builtin), agentId = agentId?.takeIf { AgentIds.builtin(it) == null },
            backendProfileId = backendProfileId, model = model?.takeIf { it.isNotBlank() },
            mode = mode?.takeIf { it.isNotBlank() }, approval = approval?.takeIf { it.isNotBlank() },
            toolGroups = toolGroups, extensionsOff = extensionsOff,
            initialMessage = NativeMessageInput(commandId = newClientId(), text = prompt,
                attachments = attachments.takeIf { it.isNotEmpty() }?.map { AttachmentRef(it.id) },
                context = context.fileReferences(),
                    references = context.sessionReferences()),
        ))
    }

    @Throws(Exception::class)
    fun pendingCreation(id: String): PendingSessionCreation? = creations.find(id)

    @Throws(Exception::class)
    fun pendingCreations(): List<PendingSessionCreation> = creations.list()

    /**
     * A server receipt updates the list but retains the request until the UI has durably cleared
     * the submitted draft. A crash between those steps must still retry the same task identity.
     */
    @Throws(Exception::class)
    suspend fun createPreparedSession(request: PendingSessionCreation): Session {
        creations.requirePending(request)
        return lists.createPreparedSession(request.body)
    }

    /** Call only after the UI has durably cleared its submitted draft and pending pointer. */
    @Throws(Exception::class)
    fun acknowledgePreparedCreation(id: String) = creations.remove(id)

    /** Stop tracking after an explicit user decision; this does not cancel any server-side task. */
    @Throws(Exception::class)
    fun discardPreparedCreation(id: String) = creations.remove(id)

    /* --------------------------------------------------------------------------------------- */
    /* Stream: select, dial, frames                                                             */
    /* --------------------------------------------------------------------------------------- */

    /** Opens a session and subscribes to its native stream, replacing any previous subscription. */
    fun select(session: Session) {
        if (openSessionId == session.id && sync.streaming(session.id)) {
            core.update { it.copy(selected = session, context = measuredContext(session, it.sessionId, it.context)) }
            // A new visit starts at the head even if an older page from the last visit is still in flight.
            sync.jumpToLatest()
            return
        }
        log("select ${session.id} state=${session.state}")
        sync.open(session.id, session)
    }

    /** Re-opens the current session's stream, e.g. after [RiffetConnectionState.Failed]. */
    fun retry() {
        log("retry ${openSessionId}")
        core.update { it.copy(historyRetries = 0) }
        openSessionId?.let { sync.open(it, null) }
    }

    /**
     * The app is back in front. A stream that is still live is left alone; one that died while the
     * phone slept is redialled now instead of waiting out the transport's backoff.
     */
    fun wake() {
        log("wake connection=${core.value.connection}")
        if (_unauthenticated.value) return
        when (core.value.connection) {
            RiffetConnectionState.Reconnecting, is RiffetConnectionState.Failed -> retry()
            else -> Unit
        }
        // Back in front after a while: the lists, and through them the prefetch, catch up too.
        if (platformNowMillis() - lists.refreshedAt > REFRESH_ON_WAKE_MILLIS) refresh()
    }

    /**
     * A lists push names separate session and project revisions; each list reads only when it moved.
     * Older servers omit the project revision, so the first push supplies their project snapshot.
     */
    fun listsChanged(data: String?) {
        val revision = data?.let { Regex("\"revision\"\\s*:\\s*(\\d+)").find(it)?.groupValues?.get(1)?.toLongOrNull() }
        val projects = data?.let { Regex("\"projects\"\\s*:\\s*(\\d+)").find(it)?.groupValues?.get(1)?.toLongOrNull() }
        lists.refreshProjects(projects)
        if (!lists.listsMoved(revision)) return
        scope.launch {
            try {
                lists.pollSessions()
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (_: Throwable) {
                // The fallback poll retries.
            }
        }
    }

    /** Suspend foreground streaming without discarding the visible transcript or its anchor. */
    fun pause() {
        flush()
        core.update { state ->
            state.copy(
                dial = state.dial + 1,
                connection = if (state.sessionId != null && !_unauthenticated.value) RiffetConnectionState.Reconnecting else state.connection,
            )
        }
        sync.pause()
        lists.cancelPrefetch()
    }

    /**
     * Back from the background where the server pushed every alert itself: the next list read is a
     * fresh baseline, so transitions from while away are not announced a second time.
     */
    fun forgetSessionStates() = lists.forgetStates()

    /** Writes the open transcript to the device now, e.g. as the app leaves the foreground. */
    fun flush() = sync.flush()

    /**
     * Freeze a final cache write before clear cancels store jobs. The host runs this captured
     * work in a short independent scope and closes the old cache only after it completes.
     */
    fun captureFinalFlush(): suspend () -> Unit {
        val writeList = lists.captureFinalFlush()
        val writeLanes = sync.captureFinalFlush()
        return { writeList(); writeLanes() }
    }

    /** Cancels the stream and drops every per-session value. The store returns to [Idle]. */
    fun clear() {
        log("clear")
        lists.clear()
        sync.clear()
        _liveMetrics.value = emptyMap()
        // A new epoch and dial, and nothing else carried over: not the transcript, the deliveries
        // (a created session's receipt included, which is store-level and only cleared here), the composer's state or the connection.
        core.update { StoreState(epoch = it.epoch + 1, dial = it.dial + 1) }
    }

    /** The server rejected this device's token; see [unauthenticated]. */
    private fun signedOut() {
        if (_unauthenticated.value) return
        log("unauthenticated: device token rejected")
        _unauthenticated.value = true
        core.update { state ->
            state.withoutOutputRate().copy(
                dial = state.dial + 1,
                connection = if (state.sessionId != null) RiffetConnectionState.Failed(UNAUTHENTICATED_REASON) else state.connection,
            )
        }
        sync.pause()
        lists.cancelPrefetch()
    }

    /* --------------------------------------------------------------------------------------- */
    /* History: older pages and gap repair                                                      */
    /* --------------------------------------------------------------------------------------- */

    /**
     * The web's `loadOlder`: fetches the page before the oldest event on screen and prepends it.
     *
     * Safe to call on every scroll frame: a no-op while a page is loading (a backing-off retry
     * counts), after the exposed failure until [retryHistory], and once the transcript's start is
     * reached. A failed page is retried here with a growing wait; only [HISTORY_PAGE_ATTEMPTS]
     * failures in a row set [StoreState.historyError], so a flaky moment never reaches the reader.
     */
    fun loadOlder() {
        sync.loadOlder()
    }

    fun retryHistory() {
        core.update { it.copy(historyError = null) }
        if (core.value.connection is RiffetConnectionState.Failed) retry() else loadOlder()
    }

    /**
     * Fetches the page before the oldest event of [toolCallId]'s transcript and prepends it.
     *
     * The web's `SubagentSession.loadEarlier` (`SubagentSession.tsx` ~115), including the parent's
     * guards: a no-op without a cursor, while a page is loading, after a failure, or once the child's
     * own start is reached. The child's history cursor rides the parent's route as `toolCallId`; the
     * page's `history` is stored on the *child* transcript, so the parent's paging is untouched.
     */
    fun loadOlderSubagent(toolCallId: String) = sync.loadOlderLane(toolCallId)

    /** Clears the child paging failure so the reader may retry the top of the page. */
    fun clearSubagentError() = sync.clearLaneError()

    /* --------------------------------------------------------------------------------------- */
    /* Composer: upload, send, queue, retry, answer                                             */
    /* --------------------------------------------------------------------------------------- */

    /**
     * Uploads one already-prepared attachment and returns the server's record.
     *
     * `picked.bytes` has already been downscaled by the platform picker (see
     * `rememberAttachmentPicker`), which is what keeps the base64 body far below the server's
     * 24 MiB attachment cap; the composer additionally rejects anything that still exceeds it.
     */
    @Throws(Exception::class)
    suspend fun uploadAttachment(picked: UploadableAttachment): Attachment = composer.uploadAttachment(picked)

    /** The `/` menu for [session]'s backend, in the project and profile it runs on. */
    @Throws(Exception::class)
    suspend fun slashCatalog(session: Session): NativeSlashCatalog =
        api.agentSlashCatalog(session.agent ?: AgentIds.wire(NativeBackendId.CURSOR), sessionId = session.id)

    /** Project-scoped upload, for the home composer that has no session yet. */
    @Throws(Exception::class)
    suspend fun uploadAttachment(picked: UploadableAttachment, projectId: String?): Attachment =
        composer.uploadAttachment(picked, projectId)

    /**
     * Sends a message, applying the running-task preference when a safe live target is available.
     *
     * Capability discovery may suspend before choosing the endpoint. The exact selected request
     * is persisted in the outbox before its POST, so a crash after writing to the socket leaves it
     * available for an identical retry.
     *
     * @return true only when the server returned a receipt, i.e. when the composer may clear the
     *   draft. An unknown result keeps the draft-clearing decision to the user via the uncertain row.
     */
    @Throws(Exception::class)
    suspend fun send(
        text: String,
        attachments: List<Attachment> = emptyList(),
        context: List<PromptContextReference> = emptyList(),
        interrupt: Boolean = false,
        onStored: (() -> Unit)? = null,
    ): Boolean = composer.send(text, attachments, context, interrupt, onStored)

    /** The selected intent remains visible even when the task temporarily cannot accept it. */
    fun prefersSteerWhileRunning(): Boolean =
        list.value.settings?.composerRunningBehavior == "steer" && core.value.isWorking()

    @Throws(Exception::class)
    suspend fun enqueue(text: String, attachments: List<Attachment>, context: List<PromptContextReference>, onStored: (() -> Unit)? = null): Boolean =
        composer.enqueue(text, attachments, context, onStored)

    private fun writableSteerTarget(): riffet.contracts.NativeTurnTarget? {
        val state = core.value
        val session = state.selected ?: return null
        val current = state.status ?: return null
        val target = current.activeTurn?.target() ?: return null
        val providerConnection = current.connection
        if (session.archivedAt != null || target.nativeSessionId.isBlank() || target.turnId.isBlank() ||
            state.sessionId != session.id || state.connection !is RiffetConnectionState.Live ||
            (providerConnection != null && providerConnection.state != "connected") || current.phase != NativeStatusPhase.BUSY || current.interaction != null || state.interaction != null ||
            target.nativeSessionId != session.nativeSessionId || state.uncertain.isNotEmpty()) return null
        return target
    }

    private suspend fun defaultSteerTarget(): riffet.contracts.NativeTurnTarget? {
        if (list.value.settings?.composerRunningBehavior != "steer") return null
        // With no current task this remains a normal send. A busy task never silently becomes queue.
        if (!core.value.isWorking()) return null
        val sessionId = core.value.selected?.id ?: return null
        val target = writableSteerTarget() ?: error(L10n.uiText("composer.error.steerUnavailable"))
        val supported = api.sessionCatalog(sessionId).capabilities.supportsSteer
        if (!supported || core.value.selected?.id != sessionId || writableSteerTarget() != target) {
            error(L10n.uiText("composer.error.steerUnavailable"))
        }
        return target
    }

    /** Binds this submission to the target the caller observed; never replaces it with a newer turn. */
    @Throws(Exception::class)
    suspend fun steer(
        text: String,
        attachments: List<Attachment>,
        context: List<PromptContextReference>,
        target: riffet.contracts.NativeTurnTarget,
    ): Boolean = composer.steer(text, attachments, context, target)

    @Throws(Exception::class)
    suspend fun steerQueued(run: Run, target: riffet.contracts.NativeTurnTarget): Boolean {
        val state = core.value
        val current = state.status
        if (state.connection !is RiffetConnectionState.Live || current?.phase != riffet.contracts.NativeStatusPhase.BUSY || current.interaction != null ||
            current.activeTurn?.target() != target || state.uncertain.isNotEmpty()) return false
        return composer.steerQueued(run, target)
    }

    /** Interrupts the running turn and promotes an already accepted queued run, keeping its keys. */
    @Throws(Exception::class)
    suspend fun sendQueuedNow(run: Run): Boolean = composer.sendQueuedNow(run)

    /** Stops the CLI's current turn, as the web's stop button does. */
    @Throws(Exception::class)
    suspend fun interrupt(): Boolean = composer.interrupt()

    @Throws(Exception::class)
    suspend fun interruptFor(sessionId: String): Boolean = composer.interruptFor(sessionId)

    /** Activities with a stop request out; their rows read "停止中" until the server reports otherwise. */
    val stoppingActivities: StateFlow<Set<String>> = Projection(core.state) { it.stoppingActivities }

    /**
     * Asks the server to stop a background task. The row turns to "停止中" at once; the server's later
     * state (`stopped`, or still `running` if the CLI refused) is what it finally shows. False when the
     * request failed, in which case the optimistic mark is taken back.
     */
    @Throws(Exception::class)
    suspend fun stopActivity(activityId: String): Boolean {
        val opened = core.value
        val sessionId = opened.sessionId ?: return false
        val epoch = opened.epoch
        if (activityId in opened.stoppingActivities) return true
        core.reduce(epoch) { it.copy(stoppingActivities = it.stoppingActivities + activityId) }
        return try {
            api.stopNativeActivity(sessionId, activityId)
            // The server's state is the answer; a CLI that refused leaves the task running, and the mark must not outlive that.
            scope.launch {
                delay(STOP_ACTIVITY_GRACE_MS)
                core.reduce(epoch) { it.copy(stoppingActivities = it.stoppingActivities - activityId) }
            }
            true
        } catch (cancellation: CancellationException) {
            core.reduce(epoch) { it.copy(stoppingActivities = it.stoppingActivities - activityId) }
            throw cancellation
        } catch (error: Throwable) {
            log("stop activity failed ${error::class.simpleName}: ${error.message}")
            core.reduce(epoch) { it.copy(stoppingActivities = it.stoppingActivities - activityId) }
            false
        }
    }

    /** The full text of an activity's preview, or null when it cannot be read. */
    @Throws(Exception::class)
    suspend fun sessionReferencePages(sessionId: String, snapshotRef: String): List<String> =
        withContext(Dispatchers.Default) { riffet.shared.sessionReferencePages(api.sessionBlob(sessionId, snapshotRef)) }

    @Throws(Exception::class)
    suspend fun activityText(blobRef: String): String? {
        val sessionId = core.value.sessionId ?: return null
        return try {
            api.sessionBlob(sessionId, blobRef)
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Throwable) {
            log("activity blob failed ${error::class.simpleName}: ${error.message}")
            null
        }
    }

    /** Cancels a run: removing a queued message, or stopping the one in flight. */
    @Throws(Exception::class)
    suspend fun cancelRun(run: Run): Boolean = composer.cancelRun(run)

    /**
     * The queue's "编辑": takes a queued message out of the queue and hands back its text and
     * attachments for the input. Null when the cancel failed, so the draft is never duplicated.
     */
    @Throws(Exception::class)
    suspend fun takeBackQueued(run: Run): QueuedDraft? = composer.takeBackQueued(run)

    /**
     * Retries an uncertain send with the *original* request. The body comes from the outbox, so the
     * `commandId` — and therefore the server's idempotency receipt — is unchanged. When the original
     * request cannot be found the retry is refused instead of being invented.
     */
    @Throws(Exception::class)
    suspend fun retryRun(run: Run): Boolean = composer.retryRun(run)

    @Throws(Exception::class)
    suspend fun checkRun(run: Run): riffet.shared.NativeRunRecovery? = composer.checkRun(run)

    @Throws(Exception::class)
    suspend fun continueRun(run: Run, queuedRunIds: List<String>): Boolean = composer.continueRun(run, queuedRunIds)

    /** Re-reads the run list, so the UI can reconcile an unknown result against the server. */
    @Throws(Exception::class)
    suspend fun refreshRuns() = composer.refreshRuns()

    /** Submits an answer to the CLI dialog and updates [interaction] from the result. */
    @Throws(Exception::class)
    suspend fun respondInteraction(response: NativeInteractionResponse): NativeInteractionResult =
        interactions.respondInteraction(response)

    /** Asks the server what the CLI is showing right now; used by the card's "同步". */
    @Throws(Exception::class)
    suspend fun syncInteraction(): NativeInteraction? = interactions.syncInteraction()

    /** Clears the composer's error/notice lines, e.g. when the user starts a new attempt. */
    fun clearComposerMessages() = composer.clearComposerMessages()
}

/** Older Droid meters cached a character estimate as measured occupancy; keep the transcript. */
internal fun measuredContext(selected: Session?, openSessionId: String?, value: NativeContext?): NativeContext? = value?.takeUnless {
    selected?.takeIf { session -> session.id == openSessionId }?.backendId == NativeBackendId.DROID &&
        it.limitKind != "compaction"
}

/** What moves when a conversation gets a new message; metadata edits leave it alone. */
internal fun Session.activityStamp(): String = lastActivityAt ?: updatedAt

/** How long a requested stop shows as pending before the server's own state for the activity is all that counts. */
private const val STOP_ACTIVITY_GRACE_MS = 20_000L

/** How long the transcript or the lists must be quiet before they are written to the device. */
internal const val SAVE_DELAY_MILLIS = 1_000L

internal fun log(message: String) = AppLog.log("store", message)

internal fun shortId(id: String?): String = id?.takeLast(8) ?: "-"

internal fun describeRun(run: Run): String {
    val native = run.native
    return "${shortId(run.id)}:${run.state}/${native?.delivery}/${native?.stage} msg=${native?.nativeMessageId != null}"
}

/** How long the device copy must sit still before the search index catches up with it. */
private const val INDEX_DELAY_MILLIS = 3_000L

/** Returning to the app after this long refreshes the lists, and so the prefetch. */
private const val REFRESH_ON_WAKE_MILLIS = 30_000L

/** What the connection and the list say once the server has rejected this device's token. */
internal val UNAUTHENTICATED_REASON: String get() = L10n.uiText("auth.unauthenticated")
