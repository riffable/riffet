package riffet.ui.state

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import riffet.cache.MAIN_LANE
import riffet.contracts.LaneFind
import riffet.contracts.LaneFindHit
import riffet.contracts.SyncLane
import riffet.contracts.TimelineRow
import riffet.shared.RiffetApi
import riffet.shared.RiffetHttpException
import riffet.shared.syncFind

/** Where the reader should look: the [nth] (0-based) occurrence of the needle in row [key]. */
data class FindTarget(
    val key: String,
    val pos: Long,
    val nth: Int,
    /** Grows with every selection, so the UI highlights again even when the target is the same. */
    val request: Long,
)

/** Find within the open conversation; see [SessionFind]. */
data class FindState(
    val open: Boolean = false,
    val query: String = "",
    /** The lower-cased query the rows are searched for; empty while the query is blank. */
    val needle: String = "",
    /** Occurrences in the conversation: the server's total, or the held rows' when [partial]. */
    val total: Long = 0,
    /** The selected occurrence among [hits]' occurrences, in `pos` order; -1 for none. */
    val current: Int = -1,
    val hits: List<LaneFindHit> = emptyList(),
    val loading: Boolean = false,
    /** The server could not be asked: [hits] cover only the rows held. */
    val partial: Boolean = false,
    /** The server stopped listing rows: [total] counts more than [hits] hold. */
    val truncated: Boolean = false,
    val target: FindTarget? = null,
)

/** Where a new query starts: a lane place, or the row at the reader's place, looked up when the answer arrives. */
private sealed interface Reading {
    data class At(val pos: Long) : Reading
    data class Row(val key: String) : Reading
}

private const val TYPE_DEBOUNCE_MILLIS = 200L
private const val LIVE_DEBOUNCE_MILLIS = 1_000L

/**
 * Find within one conversation, shared by every client: the query, the server's hits
 * (`GET /api/v3/sessions/:id/find`), stepping through occurrences, and loading the window around a
 * hit that is not held ([SessionSync.jumpTo]). The UI draws [state], and on a new [FindTarget] scrolls
 * to its row and highlights the nth occurrence of [FindState.needle] in the rendered text (the whole
 * row when it cannot be located). A server without the route, or a failure, falls back to the held
 * rows ([FindState.partial]).
 */
class SessionFind internal constructor(
    private val api: RiffetApi,
    private val scope: CoroutineScope,
    private val sync: SessionSync,
) {
    private val _state = MutableStateFlow(FindState())
    val state: StateFlow<FindState> = _state.asStateFlow()

    private var lane: SyncLane = MAIN_LANE
    private var job: Job? = null
    private var pendingFromReader = false
    private var requests = 0L

    init {
        // The stream added rows: ask again, and stay on the occurrence the reader is at.
        scope.launch {
            sync.head.drop(1).collect {
                val state = _state.value
                if (state.open && state.needle.isNotEmpty() && lane == MAIN_LANE && !pendingFromReader) schedule(LIVE_DEBOUNCE_MILLIS, null)
            }
        }
    }

    /** Starts find; [readingPos] is the `pos` of the row at the reader's place, where results begin. */
    fun open(readingPos: Long?) = open(readingPos, MAIN_LANE)

    fun open(readingPos: Long?, lane: String) {
        job?.cancel()
        pendingFromReader = false
        this.lane = lane
        _state.value = FindState(open = true)
    }

    /** Debounced; the first hit at or after [readingPos] (else the first) is selected when the result arrives. */
    fun setQuery(query: String, readingPos: Long?) = query(query, Reading.At(readingPos ?: 0L))

    /** As [setQuery], from the row with [readingKey]: the row at the top of the view, for a UI that knows its rows by key. */
    fun setQueryFrom(query: String, readingKey: String?) = query(query, readingKey?.let { Reading.Row(it) } ?: Reading.At(0L))

    private fun query(query: String, reading: Reading) {
        val state = _state.value
        if (!state.open) return
        val needle = if (query.isBlank()) "" else query.lowercase()
        job?.cancel()
        if (needle.isEmpty()) {
            pendingFromReader = false
            _state.value = FindState(open = true, query = query)
            return
        }
        _state.update { it.copy(query = query, needle = needle, loading = true) }
        pendingFromReader = true
        schedule(TYPE_DEBOUNCE_MILLIS, reading)
    }

    fun next() = step(1)

    fun previous() = step(-1)

    fun close() {
        job?.cancel()
        job = null
        pendingFromReader = false
        _state.value = FindState()
    }

    private fun step(direction: Int) {
        val state = _state.value
        val all = state.hits.sumOf { it.count }.toInt()
        // The hits are still the last query's until the new one is answered, and the answer selects
        // the first occurrence from the reader by itself: a step now would land on the old query's.
        if (!state.open || all == 0 || pendingFromReader) return
        val next = when {
            state.current >= 0 -> (state.current + direction + all) % all
            // The selection's row no longer holds it (a streamed or expanded row changed): continue from its place.
            state.target != null -> {
                val pos = state.target.pos
                if (direction > 0) state.hits.indexOfFirst { it.pos >= pos }.let { at -> if (at < 0) 0 else state.hits.take(at).sumOf { it.count }.toInt() }
                else state.hits.indexOfLast { it.pos < pos }.let { at -> if (at < 0) all - 1 else state.hits.take(at + 1).sumOf { it.count }.toInt() - 1 }
            }
            direction > 0 -> 0
            else -> all - 1
        }
        select(next)
    }

    /** [current] becomes the selection and the target, loading its row's window when it is not held. */
    private fun select(current: Int) {
        val located = locate(_state.value.hits, current) ?: return
        val request = ++requests
        _state.update { it.copy(current = current, target = FindTarget(located.first.key, located.first.pos, located.second, request)) }
        scope.launch {
            val held = lane != MAIN_LANE || sync.withHeld { _, _, rows -> rows.row(located.first.key) != null } == true
            if (!held && _state.value.target?.request == request) sync.jumpTo(located.first.pos)
        }
    }

    /** [reading] selects the first occurrence from there; null keeps the selection on its key and nth. */
    private fun schedule(delayMillis: Long, reading: Reading?) {
        job?.cancel()
        val kept = _state.value.takeIf { reading == null }?.let { s -> s.target?.takeIf { s.current >= 0 } }
        job = scope.launch {
            delay(delayMillis)
            val needle = _state.value.needle
            if (needle.isEmpty()) return@launch
            _state.update { it.copy(loading = true) }
            val (result, partial) = fetch(needle)
            if (_state.value.needle != needle) return@launch
            pendingFromReader = false
            val hits = result.hits
            val all = hits.sumOf { it.count }.toInt()
            _state.update { it.copy(total = result.total, hits = hits, truncated = result.truncated == true, partial = partial, loading = false) }
            if (kept != null) {
                val at = hits.indexOfFirst { it.key == kept.key }.takeIf { it >= 0 }
                if (at != null && kept.nth < hits[at].count) {
                    val current = hits.take(at).sumOf { it.count }.toInt() + kept.nth
                    _state.update { it.copy(current = current) }
                    return@launch
                }
            }
            if (all == 0) {
                _state.update { it.copy(current = -1, target = null) }
                return@launch
            }
            // A refresh while nothing is selected only recounts: the reader is not moved by the stream.
            if (reading == null && kept == null) return@launch
            val from = when (reading) {
                is Reading.At -> reading.pos
                // A row the window no longer holds (paged away meanwhile) starts from the top.
                is Reading.Row -> sync.withHeld { _, _, rows -> rows.row(reading.key)?.pos } ?: 0L
                null -> kept?.pos ?: 0L
            }
            val first = hits.indexOfFirst { it.pos >= from }.takeIf { it >= 0 } ?: 0
            // The kept selection is gone from its row: nothing is selected, and a step continues from its place.
            if (kept != null) _state.update { it.copy(current = -1) }
            else select(hits.take(first).sumOf { it.count }.toInt())
        }
    }

    /** The server's answer, or the held rows' with `partial`. */
    private suspend fun fetch(needle: String): Pair<LaneFind, Boolean> {
        val query = _state.value.query
        for (attempt in 0..1) {
            val held = sync.withHeld { id, generation, _ -> id to generation }
            val id = held?.first
            val generation = held?.second
            if (id == null || generation == null) break
            try {
                return api.syncFind(id, lane, generation, query) to false
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: RiffetHttpException) {
                // A stale generation is retried once with the window's current one.
                if (error.status == 409 && error.code == "SYNC_GENERATION_CHANGED" && attempt == 0) continue
                break
            } catch (error: Throwable) {
                break
            }
        }
        return held(needle) to true
    }

    private suspend fun held(needle: String): LaneFind {
        val hits = if (lane != MAIN_LANE) emptyList() else sync.withHeld { _, _, window ->
            window.list.mapNotNull { row ->
                val count = occurrences(rowText(row), needle)
                if (count == 0) null else LaneFindHit(row.key, row.pos, row.turn, count.toLong())
            }
        }.orEmpty()
        return LaneFind(generation = "", headSeq = 0, total = hits.sumOf { it.count }, hits = hits)
    }

    private fun rowText(row: TimelineRow): String = when (val body = row.body) {
        is TimelineRow.Body.User -> body.text
        is TimelineRow.Body.Assistant -> body.text
        is TimelineRow.Body.Thought -> body.text
        is TimelineRow.Body.Status -> listOfNotNull(body.text, body.detail).joinToString("\n")
        is TimelineRow.Body.Tool -> listOfNotNull(body.job?.title, body.job?.command, body.activity?.title, body.subagent?.title).joinToString("\n")
        is TimelineRow.Body.TaskNotification -> listOfNotNull(body.title, body.command, body.detail).joinToString("\n")
        else -> ""
    }.lowercase()

    private fun occurrences(text: String, needle: String): Int {
        var count = 0
        var from = 0
        while (true) {
            val at = text.indexOf(needle, from)
            if (at < 0) return count
            count += 1
            from = at + needle.length
        }
    }

    /** The hit holding occurrence [current] (counted over [hits] in order) and its index in that row. */
    private fun locate(hits: List<LaneFindHit>, current: Int): Pair<LaneFindHit, Int>? {
        var rest = current
        for (hit in hits) {
            if (rest < hit.count) return hit to rest
            rest -= hit.count.toInt()
        }
        return null
    }
}
