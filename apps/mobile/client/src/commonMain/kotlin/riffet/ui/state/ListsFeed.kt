package riffet.ui.state

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import riffet.contracts.RiffetNotice
import riffet.shared.AppLog
import riffet.shared.ListsStreamEvent
import riffet.shared.ListsStreamSession
import riffet.shared.RiffetApi
import riffet.shared.StreamConnection
import riffet.shared.listsStream

/**
 * The push side of the lists (docs/LIST-SYNC.md & docs/SERVER-LINKS.md §5): `/api/lists/stream`
 * says which list moved and [store] reads only that one. `marks` revision changes go to [onMarks];
 * `notice` events to [onNotice]; `servers` events refresh linked servers and update per-peer
 * `/api/servers/<id>/lists/stream` subscriptions automatically.
 *
 * [active] false (the app is away and nothing keeps it running) holds reads back; the latest `changed`
 * is replayed by the next [kick] instead of reading in the background.
 */
class ListsFeed(
    private val api: RiffetApi,
    private val store: SessionStore,
    private val scope: CoroutineScope,
    private val active: () -> Boolean = { true },
    private val onMarks: suspend () -> Unit = {},
    private val onNotice: suspend (RiffetNotice) -> Unit = {},
) {
    private var session: ListsStreamSession? = null
    private var pending: String? = null
    private var marksRevision: Long? = null
    private val peerJobs = LinkedHashMap<String, Job>()
    private val peerSessions = LinkedHashMap<String, ListsStreamSession>()
    private val peerPending = LinkedHashMap<String, String>()

    /** Dials and serves the entry stream plus one stream per operable linked peer until cancelled. */
    suspend fun run() = coroutineScope {
        val stream = api.listsStream()
        session = stream
        launch {
            stream.connection.collect { store.setListsPushed(it == StreamConnection.Live) }
        }
        val peerWatcher = launch {
            store.list
                .map { state ->
                    state.servers
                        .filter { it.self != true && it.outbound && it.compatible }
                        .map { it.id }
                        .toSet()
                }
                .distinctUntilChanged()
                .collect { peerIds ->
                    for (id in peerJobs.keys.toList()) {
                        if (id !in peerIds) {
                            peerJobs.remove(id)?.cancel()
                            peerSessions.remove(id)
                            peerPending.remove(id)
                        }
                    }
                    for (id in peerIds) {
                        if (id !in peerJobs) {
                            peerJobs[id] = launch { runPeer(id) }
                        }
                    }
                }
        }
        try {
            stream.events.collect { event ->
                when (event) {
                    is ListsStreamEvent.Changed -> changed(event.data)
                    is ListsStreamEvent.Team -> store.replaceTeamMembers(event.members)
                    is ListsStreamEvent.Servers -> store.refreshServers()
                    is ListsStreamEvent.Notice -> try {
                        onNotice(event.notice)
                    } catch (cancellation: CancellationException) {
                        throw cancellation
                    } catch (error: Throwable) {
                        AppLog.log("lists", "notice failed ${error::class.simpleName}: ${error.message}")
                    }
                }
            }
        } finally {
            peerWatcher.cancel()
            for (job in peerJobs.values) job.cancel()
            peerJobs.clear()
            peerSessions.clear()
            peerPending.clear()
            if (session === stream) session = null
            store.setListsPushed(false)
        }
    }

    private suspend fun runPeer(serverId: String) {
        val peerStream = api.forServer(serverId).listsStream()
        peerSessions[serverId] = peerStream
        try {
            peerStream.events.collect { event ->
                if (event is ListsStreamEvent.Changed) peerChanged(serverId, event.data)
            }
        } finally {
            if (peerSessions[serverId] === peerStream) peerSessions.remove(serverId)
            peerPending.remove(serverId)
        }
    }

    /** The network came back or the app came to the front: redial now, and read what was held back. */
    fun kick() {
        session?.kick()
        pending?.takeIf { active() }?.let(::changed)
        for ((id, peerStream) in peerSessions.toList()) {
            peerStream.kick()
            peerPending[id]?.takeIf { active() }?.let { data -> peerChanged(id, data) }
        }
    }

    private fun changed(data: String) {
        if (!active()) {
            pending = data
            return
        }
        pending = null
        val marks = MARKS.find(data)?.groupValues?.get(1)?.toLongOrNull()
        if (marks != null && marks != marksRevision) {
            marksRevision = marks
            scope.launch {
                try {
                    onMarks()
                } catch (cancellation: CancellationException) {
                    throw cancellation
                } catch (error: Throwable) {
                    AppLog.log("lists", "marks read failed ${error::class.simpleName}: ${error.message}")
                }
            }
        }
        store.listsChanged(data)
    }

    private fun peerChanged(serverId: String, data: String) {
        if (!active()) {
            peerPending[serverId] = data
            return
        }
        peerPending.remove(serverId)
        store.peerListsChanged(serverId, data)
    }

    private companion object {
        val MARKS = Regex("\"marks\"\\s*:\\s*(\\d+)")
    }
}
