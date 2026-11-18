package riffet.cache

import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.IO
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import riffet.contracts.NativeContext
import riffet.contracts.RiffetJson
import riffet.contracts.SyncLane
import riffet.contracts.SyncOutline
import riffet.contracts.TimelineRow
import riffet.core.TimelineItem
import riffet.core.timelineItem
import riffet.core.toolView
import riffet.ui.state.traced
import riffet.ui.timeline.platformNowMillis

/** The lane every conversation has; a subagent's is `sub:<toolCallId>`. */
const val MAIN_LANE: SyncLane = "main"

/**
 * What the device holds of one lane besides its rows: the [generation] and lane seq ([lastSeq]) a
 * dial resumes from, and what the conversation's screen draws before the server answers.
 */
@Serializable
data class TimelineMeta(
    val version: Int = TIMELINE_FORMAT,
    val sessionId: String,
    val lane: SyncLane = MAIN_LANE,
    val generation: String,
    /** The lane seq the rows are current to; null when they cannot be resumed from (a torn write). */
    val lastSeq: Long? = null,
    /** Older rows exist on the server. */
    val hasBefore: Boolean = false,
    val rows: Int = 0,
    /** Lines in the log; a replay that reads any other number cannot vouch for [lastSeq]. */
    val ops: Int = 0,
    val logBytes: Long = 0,
    /** The log's size when it was last rewritten whole; appends past twice this compact it. */
    val compactBytes: Long = 0,
    val activity: String? = null,
    val context: NativeContext? = null,
    val outline: SyncOutline? = null,
    /** When the rows were last confirmed by the server, in epoch milliseconds. */
    val syncedAt: Long,
    val accessedAt: Long,
    /** An older cache without this flag can vouch for the latest page only with a resume cursor. */
    val hasAfter: Boolean = lastSeq == null,
)

/** [sizes] holds each row's wire size (its JSON), read off its log line, so the window need not encode it again. */
class CachedTimeline(val meta: TimelineMeta, val rows: List<TimelineRow>, internal val sizes: List<Int>? = null)

/**
 * One lane to store. [rows] is the whole window in `pos` order; [changed] and [deleted] name what
 * moved since the previous save of the same generation, so the log only grows by them. A null
 * [changed] rewrites the log.
 */
class TimelineSnapshot(
    val sessionId: String,
    val lane: SyncLane = MAIN_LANE,
    val generation: String,
    val lastSeq: Long?,
    val hasBefore: Boolean,
    val rows: List<TimelineRow>,
    val changed: Set<String>? = null,
    val deleted: Set<String> = emptySet(),
    val context: NativeContext? = null,
    val activity: String? = null,
    val outline: SyncOutline? = null,
    /** False for rows that were not just confirmed by the server; the previous `syncedAt` stays. */
    val synced: Boolean = true,
    /** Wire sizes (each row's JSON) by key, as the window measured them; a row without one is encoded to measure it. */
    internal val sizes: Map<String, Int>? = null,
    val hasAfter: Boolean = false,
)

/**
 * The device copy of sync v3 lanes (docs/SYNC-V3.md, 预算): per lane its generation, lane seq and
 * window of rows, capped at [window], and 64 MiB in total, least recently read evicted first.
 *
 * `servers/<server>/v3/<lane>.log` is a replay log, one line per change: an upserted row or a deleted
 * key. Rows change in place (a streaming answer is the same row many times), so saves append only
 * what moved and the log is rewritten whole once it is mostly superseded. `<lane>.meta` is written
 * after it; a process killed in between leaves more lines than the meta counts, and the replay then
 * keeps the rows but forgets [TimelineMeta.lastSeq], so the next dial asks for a snapshot instead of
 * resuming from a seq the rows may not reach.
 *
 * Like [TranscriptCache] it is disposable: anything that does not read is dropped. With an [index],
 * the main lanes are searchable; a save marks the session and [indexPending] catches up outside the lock.
 */
class TimelineCache(
    private val files: LocalFiles,
    serverUrl: String,
    private val io: CoroutineContext = Dispatchers.IO,
    private val now: () -> Long = ::platformNowMillis,
    val window: SyncWindow = platformSyncWindow,
    private val budgetBytes: Long = DEFAULT_BUDGET_BYTES,
    private val index: TranscriptIndex? = null,
    /** The previous store must finish its last writes before this instance reads any metadata. */
    private val previousWrites: Job? = null,
) {
    private val root = "servers/${safeName(serverUrl.trimEnd('/').lowercase())}/v3"
    private val mutex = Mutex()
    private var metas: MutableMap<String, TimelineMeta>? = null

    /** Lanes whose `accessedAt` moved by a read but is not on disk yet; the next save writes them. */
    private val touched = mutableSetOf<String>()

    /** Conversations deleted on the server: a save still in flight for one writes nothing. */
    private val deleted = mutableSetOf<String>()

    private val indexMutex = Mutex()
    private var indexClosed = false
    private val pending = mutableMapOf<String, Long>()
    private var changes = 0L
    private val _indexChanges = MutableStateFlow(0L)

    /** Moves whenever the index falls behind; a caller runs [indexPending] once it settles. */
    val indexChanges: StateFlow<Long> = _indexChanges.asStateFlow()

    suspend fun load(sessionId: String, lane: SyncLane = MAIN_LANE): CachedTimeline? = locked { traced("riffet.cache.load") { read(sessionId, lane) } }

    suspend fun meta(sessionId: String, lane: SyncLane = MAIN_LANE): TimelineMeta? = locked { metas()[laneKey(sessionId, lane)] }

    suspend fun save(snapshot: TimelineSnapshot) = locked { traced("riffet.cache.save") { write(snapshot) } }

    private fun write(snapshot: TimelineSnapshot) {
        if (snapshot.sessionId in deleted) return
        val key = laneKey(snapshot.sessionId, snapshot.lane)
        val previous = metas()[key]
        val time = now()
        val known = snapshot.sizes
        val lines = Lines()
        val rows = capped(snapshot.rows, lines) { row -> known?.get(row.key)?.let { it + LINE_FRAME } }
        val trimmed = rows.size < snapshot.rows.size
        val changed = snapshot.changed
        var appended: String? = null
        var appendedOps = 0
        if (previous != null && previous.version == TIMELINE_FORMAT && previous.generation == snapshot.generation && changed != null && !trimmed) {
            val byKey = HashMap<String, String>(rows.size)
            for (row in rows) if (row.key in changed) byKey[row.key] = lines.line(row)
            appended = buildString {
                for (line in byKey.values) append(line).also { appendedOps += 1 }
                for (deleted in snapshot.deleted) if (deleted !in byKey) {
                    append(RiffetJson.instance.encodeToString(TimelineOp.serializer(), TimelineOp(delete = deleted))).append('\n')
                    appendedOps += 1
                }
            }
            val grown = previous.logBytes + appended.length
            // Mostly superseded lines: rewrite it whole rather than replay them on every open.
            if (grown > 2 * previous.compactBytes + COMPACT_SLACK_BYTES || previous.ops + appendedOps > 3 * rows.size + COMPACT_SLACK_OPS) appended = null
        }
        val path = logPath(key)
        val ops: Int
        val logBytes: Long
        val compactBytes: Long
        if (appended != null && previous != null) {
            if (appended.isNotEmpty()) files.append(path, appended)
            ops = previous.ops + appendedOps
            logBytes = previous.logBytes + appended.length
            compactBytes = previous.compactBytes
        } else {
            val text = lines.text(rows)
            files.write(path, text)
            ops = rows.size
            logBytes = text.length.toLong()
            compactBytes = logBytes
        }
        val meta = TimelineMeta(
            sessionId = snapshot.sessionId,
            lane = snapshot.lane,
            generation = snapshot.generation,
            lastSeq = snapshot.lastSeq,
            hasBefore = snapshot.hasBefore || trimmed,
            hasAfter = snapshot.hasAfter,
            rows = rows.size,
            ops = ops,
            logBytes = logBytes,
            compactBytes = compactBytes,
            activity = snapshot.activity ?: previous?.activity,
            context = snapshot.context ?: previous?.context.takeIf { previous?.generation == snapshot.generation },
            outline = snapshot.outline ?: previous?.outline.takeIf { previous?.generation == snapshot.generation },
            syncedAt = if (snapshot.synced || previous == null) time else previous.syncedAt,
            accessedAt = time,
        )
        writeMeta(key, meta)
        if (snapshot.lane == MAIN_LANE && (appended == null || appended.isNotEmpty())) markPending(snapshot.sessionId)
        evict(keep = key)
        writeTouched()
    }

    /** Drops one lane, e.g. a generation the server replaced: its rows can never be resumed. */
    suspend fun forget(sessionId: String, lane: SyncLane = MAIN_LANE) = locked { forgetLocked(laneKey(sessionId, lane)) }

    /** A conversation deleted on the server: every lane of it, and (on the next index pass) its search entries. */
    suspend fun forgetSession(sessionId: String) = locked {
        deleted += sessionId
        metas().filterValues { it.sessionId == sessionId }.keys.toList().forEach(::forgetLocked)
        markPending(sessionId)
    }

    /** Drops everything stored for this server. */
    suspend fun clear() = locked {
        files.deleteTree(root)
        metas = mutableMapOf()
        touched.clear()
        if (index != null) {
            pending.clear()
            pending[CLEAR_INDEX] = ++changes
            _indexChanges.value = changes
        }
    }

    /** The newest stored messages matching [query]; empty without an index. */
    suspend fun search(query: String, limit: Int = SEARCH_LIMIT, sessionId: String? = null): List<IndexHit> {
        val index = index ?: return emptyList()
        return indexed { withContext(io) { runCatching { index.search(query, limit, sessionId) }.getOrNull().orEmpty() } } ?: emptyList()
    }

    /** Marks the stored main lanes the index does not know; [indexPending] then fills them in. */
    suspend fun indexMissing() {
        val index = index ?: return
        val known = indexed { withContext(io) { runCatching { index.sessions() }.getOrNull() } } ?: return
        locked { metas().values.filter { it.lane == MAIN_LANE && it.sessionId !in known }.forEach { markPending(it.sessionId) } }
    }

    /** Brings the index up to the stored main lanes, one at a time; only reading a log takes the cache's lock. */
    suspend fun indexPending() {
        val index = index ?: return
        while (true) {
            val (id, change, log) = locked {
                val (id, change) = pending.entries.firstOrNull()?.toPair() ?: return@locked null
                val key = laneKey(id, MAIN_LANE)
                Triple(id, change, if (id != CLEAR_INDEX && metas()[key] != null) files.read(logPath(key)) else null)
            } ?: return
            // Decoded outside the cache's lock: a long log takes a while, and opening a session waits on that lock.
            val rows = log?.let { withContext(io) { replay(it).rows } }
            indexed {
                withContext(io) {
                    runCatching {
                        when {
                            id == CLEAR_INDEX -> index.clear()
                            rows == null -> index.forget(id)
                            else -> index.replace(id, rowIndexEntries(id, rows))
                        }
                    }
                }
            } ?: return
            locked { if (pending[id] == change) pending.remove(id) }
        }
    }

    /** Closes the index once any pass in flight is done. */
    suspend fun close() {
        previousWrites?.join()
        val index = index ?: return
        indexMutex.withLock {
            if (indexClosed) return@withLock
            indexClosed = true
            withContext(io) { runCatching { index.close() } }
        }
    }

    private suspend fun <T> indexed(block: suspend () -> T): T? {
        previousWrites?.join()
        return indexMutex.withLock { if (indexClosed) null else block() }
    }

    private fun read(sessionId: String, lane: SyncLane): CachedTimeline? {
        val key = laneKey(sessionId, lane)
        val meta = metas()[key] ?: return null
        val text = files.read(logPath(key))
        if (text == null) {
            forgetLocked(key)
            return null
        }
        val replayed = replay(text)
        if (replayed.rows.isEmpty() && meta.rows > 0) {
            forgetLocked(key)
            return null
        }
        val lines = Lines(replayed.lines)
        val rows = capped(replayed.rows, lines) { row -> lines.length(row) }
        // An interrupted append can leave a well-formed log and a newer meta. Its operation
        // count still matches, but the stored row count does not; that cursor must not skip rows.
        val exact = meta.version == TIMELINE_FORMAT && replayed.clean && replayed.ops == meta.ops && rows.size == meta.rows
        val trimmed = rows.size < replayed.rows.size
        val read = if (!exact || trimmed) {
            // Rewritten clean; a replay the meta cannot vouch for keeps its rows but not its seq.
            val rewritten = lines.text(rows)
            files.write(logPath(key), rewritten)
            meta.copy(
                version = TIMELINE_FORMAT,
                lastSeq = meta.lastSeq.takeIf { exact },
                hasBefore = meta.hasBefore || trimmed,
                rows = rows.size,
                ops = rows.size,
                logBytes = rewritten.length.toLong(),
                compactBytes = rewritten.length.toLong(),
                accessedAt = now(),
            ).also { writeMeta(key, it) }
        } else {
            meta.copy(accessedAt = now()).also {
                metas()[key] = it
                touched += key
            }
        }
        return CachedTimeline(read, rows, rows.map { row -> lines.length(row) - LINE_FRAME })
    }

    /**
     * The newest rows within [window], in `pos` order. [size] is a row's log line length when it is
     * already known (the log it was read from, or the window's measure), so only the rows without
     * one are encoded, into [lines]; the others are encoded only if they are written.
     */
    private fun capped(rows: List<TimelineRow>, lines: Lines, size: (TimelineRow) -> Int?): List<TimelineRow> {
        val ordered = if (rows.zipWithNext().all { (a, b) -> a.pos <= b.pos }) rows else rows.sortedBy { it.pos }
        var count = 0
        var bytes = 0L
        var first = ordered.size
        for (position in ordered.indices.reversed()) {
            val row = ordered[position]
            val length = size(row) ?: lines.length(row)
            if (count > 0 && (count >= window.rows || bytes + length > window.bytes)) break
            count += 1
            bytes += length
            first = position
        }
        return ordered.subList(first, ordered.size)
    }

    private fun markPending(sessionId: String) {
        if (index == null) return
        pending[sessionId] = ++changes
        _indexChanges.value = changes
    }

    private suspend fun <T> locked(block: () -> T): T {
        previousWrites?.join()
        return mutex.withLock { withContext(io) { block() } }
    }

    private fun metas(): MutableMap<String, TimelineMeta> {
        metas?.let { return it }
        val loaded = mutableMapOf<String, TimelineMeta>()
        for (name in files.list(root)) {
            if (!name.endsWith(META_SUFFIX)) continue
            val path = "$root/$name"
            val meta = files.read(path)?.let { text -> runCatching { RiffetJson.instance.decodeFromString(TimelineMeta.serializer(), text) }.getOrNull() }
            val key = meta?.let { laneKey(it.sessionId, it.lane) }
            if (meta == null || meta.version !in 1..TIMELINE_FORMAT || metaPath(key!!) != path) {
                files.delete(path)
                files.delete(path.removeSuffix(META_SUFFIX) + LOG_SUFFIX)
                continue
            }
            loaded[key] = meta
        }
        metas = loaded
        return loaded
    }

    private fun writeMeta(key: String, meta: TimelineMeta) {
        files.write(metaPath(key), RiffetJson.instance.encodeToString(TimelineMeta.serializer(), meta))
        metas()[key] = meta
        touched -= key
    }

    private fun writeTouched() {
        if (touched.isEmpty()) return
        for (key in touched.toList()) metas()[key]?.let { writeMeta(key, it) }
        touched.clear()
    }

    private fun forgetLocked(key: String) {
        val meta = metas().remove(key)
        files.delete(logPath(key))
        files.delete(metaPath(key))
        touched -= key
        if (meta?.lane == MAIN_LANE) markPending(meta.sessionId)
    }

    private fun evict(keep: String) {
        val all = metas()
        var total = all.values.sumOf { it.logBytes }
        if (total <= budgetBytes && all.size <= MAX_LANES) return
        for ((key, meta) in all.entries.sortedBy { it.value.accessedAt }.map { it.key to it.value }) {
            if (total <= budgetBytes && all.size <= MAX_LANES) break
            if (key == keep) continue
            total -= meta.logBytes
            forgetLocked(key)
        }
    }

    private fun logPath(key: String) = "$root/$key$LOG_SUFFIX"
    private fun metaPath(key: String) = "$root/$key$META_SUFFIX"
}

/** One line of a lane's log: a row as it now stands, or a key that left the lane. */
@Serializable
private class TimelineOp(val row: TimelineRow? = null, val delete: String? = null)

/** [lines] is each row's line as the log holds it, without its newline: rewriting or measuring it needs no encode. */
private class Replay(val rows: List<TimelineRow>, val lines: Map<String, String>, val ops: Int, val clean: Boolean)

/** The rows a log leaves, in `pos` order; a torn or unreadable line ends it. */
private fun replay(text: String): Replay {
    val rows = LinkedHashMap<String, TimelineRow>()
    val lines = HashMap<String, String>()
    var ops = 0
    var clean = true
    for (line in text.lineSequence()) {
        if (line.isBlank()) continue
        val op = runCatching { RiffetJson.instance.decodeFromString(TimelineOp.serializer(), line) }.getOrNull()
        if (op == null) {
            clean = false
            break
        }
        ops += 1
        op.row?.let {
            rows[it.key] = it
            lines[it.key] = line
        }
        op.delete?.let {
            rows.remove(it)
            lines.remove(it)
        }
    }
    return Replay(rows.values.sortedBy { it.pos }, lines, ops, clean)
}

/** Log lines by row key: the ones read from the log ([known], without their newline), others encoded once asked for. */
private class Lines(private val known: Map<String, String> = emptyMap()) {
    private val encoded = HashMap<String, String>()

    fun line(row: TimelineRow): String = known[row.key]?.let { it + "\n" } ?: encoded.getOrPut(row.key) {
        RiffetJson.instance.encodeToString(TimelineOp.serializer(), TimelineOp(row = row)) + "\n"
    }

    /** [line]'s length, without building it for a known one. */
    fun length(row: TimelineRow): Int = known[row.key]?.let { it.length + 1 } ?: line(row).length

    fun text(rows: List<TimelineRow>): String = buildString { for (row in rows) append(line(row)) }
}

/** What a log line adds to a row's wire size: `{"row":` before it, `}` and the newline after. */
private const val LINE_FRAME = 9

/** The searchable messages of a lane's rows; a row's `pos` is the scroll target. */
private fun rowIndexEntries(sessionId: String, rows: List<TimelineRow>): List<IndexEntry> = rows.mapNotNull { row ->
    val item = timelineItem(row, sessionId) ?: return@mapNotNull null
    val (role, text) = when (item) {
        is TimelineItem.User -> IndexRole.USER to item.text
        is TimelineItem.Assistant -> IndexRole.ASSISTANT to item.text
        is TimelineItem.Tool -> IndexRole.TOOL to toolView(item.event.base).title
        else -> return@mapNotNull null
    }
    if (text.isBlank()) null else IndexEntry(row.pos, role, text, item.event.createdAt)
}

/** A lane's file name: readable, collision-free, and the main lane's is its session's. */
private fun laneKey(sessionId: String, lane: SyncLane): String = safeName(if (lane == MAIN_LANE) sessionId else "$sessionId#$lane")

// Version 1 could persist a cursor ahead of its rows after a cancelled overlapping write.
// Keep its rows for offline display, but force a fresh snapshot before trusting its cursor.
private const val TIMELINE_FORMAT = 2
private const val LOG_SUFFIX = ".log"
private const val META_SUFFIX = ".meta"
private const val MAX_LANES = 300
private const val SEARCH_LIMIT = 60

/** A pending index entry that is not a session: clear the index. */
private const val CLEAR_INDEX = "\u0000clear"

/** Appends a log may take beyond twice its last compacted size, or beyond three lines a row. */
private const val COMPACT_SLACK_BYTES = 256L * 1024
private const val COMPACT_SLACK_OPS = 64

/** docs/SYNC-V3.md: the Kotlin clients keep 64 MiB of lanes. */
private const val DEFAULT_BUDGET_BYTES = 64L * 1024 * 1024
