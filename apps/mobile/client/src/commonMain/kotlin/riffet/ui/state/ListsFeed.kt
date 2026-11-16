package riffet.ui.state

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import riffet.contracts.RiffetNotice
import riffet.shared.AppLog
import riffet.shared.ListsStreamEvent
import riffet.shared.ListsStreamSession
import riffet.shared.RiffetApi
import riffet.shared.StreamConnection
import riffet.shared.listsStream

/**
 * The push side of the lists (docs/LIST-SYNC.md): `/api/lists/stream` says which list moved and
 * [store] reads only that one. `marks` revision changes go to [onMarks]; `notice` events to [onNotice].
 * While the stream is live the store's polling relaxes ([SessionStore.listsPushed]).
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

    /** Dials and serves the stream until cancelled. */
    suspend fun run() = coroutineScope {
        val stream = api.listsStream()
        session = stream
        launch {
            stream.connection.collect { store.setListsPushed(it == StreamConnection.Live) }
        }
        try {
            stream.events.collect { event ->
                when (event) {
                    is ListsStreamEvent.Changed -> changed(event.data)
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
            if (session === stream) session = null
            store.setListsPushed(false)
        }
    }

    /** The network came back or the app came to the front: redial now, and read what was held back. */
    fun kick() {
        session?.kick()
        pending?.takeIf { active() }?.let(::changed)
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

    private companion object {
        val MARKS = Regex("\"marks\"\\s*:\\s*(\\d+)")
    }
}
