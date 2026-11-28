package riffet.shared

import io.ktor.http.encodeURLParameter
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.Serializable
import riffet.cache.SyncWindow
import riffet.contracts.SyncLane
import riffet.contracts.LaneFind
import riffet.contracts.SyncOutline
import riffet.contracts.TimelineChanges
import riffet.contracts.TimelinePage

/*
 * Sync protocol v3 (docs/SYNC-V3.md, 传输): the lane stream, and the pages, changes and outline the
 * client asks for over HTTP. Sending, steering, dialogs and stopping are unchanged.
 */

/** `GET /health`'s protocol: the version and features the server speaks. */
@Serializable
data class HealthProtocol(val version: Int, val features: List<String> = emptyList())

@Serializable
data class RiffetHealth(
    val ok: Boolean = false,
    val version: String? = null,
    val protocol: HealthProtocol? = null,
    /** The running server process; older servers' pushes name their server by it. */
    val instanceId: String? = null,
    /** Stable across restarts; push payloads name their server by it. */
    val serverId: String? = null,
)

/** `GET /health`, the one public endpoint that names the server's protocol. */
@Throws(Exception::class)
suspend fun RiffetApi.health(): RiffetHealth = get("/health").decode()

/**
 * Whether the server speaks sync v3: false only when `/health` says it speaks less, or has no
 * protocol at all (a server from before sync v3 still reports version 2). Null when it cannot be asked.
 */
suspend fun RiffetApi.serverSpeaksSync(): Boolean? = try {
    (health().protocol?.version ?: 0) >= SYNC_PROTOCOL_VERSION
} catch (cancellation: CancellationException) {
    throw cancellation
} catch (_: Throwable) {
    null
}

/**
 * `GET /api/v3/sessions/:id/sync` for [lane], resuming from [initial]; see [SyncStream]. [window]
 * sizes the snapshots it asks for.
 */
fun RiffetApi.syncStream(id: String, lane: SyncLane, window: SyncWindow, initial: SyncCursor?): SyncStream {
    val base = buildString {
        append(resolveUrl("/api/v3/sessions/${id.enc()}/sync"))
        append("?lane=${lane.encodeURLParameter()}")
        window.snapshotBytes?.let { append("&budget=$it") }
        window.snapshotRows?.let { append("&rows=$it") }
    }
    return SyncStream(
        http = http,
        url = { cursor ->
            if (cursor == null) base else "$base&generation=${cursor.generation.encodeURLParameter()}&after=${cursor.seq}"
        },
        tokenProvider = tokenProvider,
        config = config,
        initial = initial,
        tooOld = { serverSpeaksSync() != true },
    )
}

/** Which end of [RiffetApi.syncTimeline] a page is read from. */
enum class TimelineAnchor(internal val wire: String) {
    /** The rows before a position: paging up. */
    BEFORE("before"),

    /** The rows from a position on: paging down while away from the newest rows. */
    FROM("from"),

    /** The rows around a position: a jump to a turn or a search hit. */
    AROUND("around"),
}

/** `GET /api/v3/sessions/:id/timeline`: one page of [lane] at [pos], sized by [window]. */
@Throws(Exception::class)
suspend fun RiffetApi.syncTimeline(
    id: String,
    lane: SyncLane,
    generation: String,
    anchor: TimelineAnchor,
    pos: Long,
    window: SyncWindow,
): TimelinePage = get(
    "/api/v3/sessions/${id.enc()}/timeline",
    buildList {
        add("lane" to lane)
        add("generation" to generation)
        add(anchor.wire to pos.toString())
        window.pageBytes?.let { add("budget" to it.toString()) }
        window.pageRows?.let { add("rows" to it.toString()) }
    },
).decode()

/**
 * `GET /api/v3/sessions/:id/timeline/changes`: what changed in [lane] after [after] of
 * [generation], or a snapshot when that is not a delta any more. Without a cursor it is a snapshot.
 */
@Throws(Exception::class)
suspend fun RiffetApi.syncChanges(id: String, lane: SyncLane, cursor: SyncCursor?, window: SyncWindow): TimelineChanges = get(
    "/api/v3/sessions/${id.enc()}/timeline/changes",
    buildList {
        add("lane" to lane)
        if (cursor != null) {
            add("generation" to cursor.generation)
            add("after" to cursor.seq.toString())
        }
        window.snapshotBytes?.let { add("budget" to it.toString()) }
    },
).decode()

/** `GET /api/v3/sessions/:id/outline`: every turn of [lane], for the outline and jumps past the window. */
@Throws(Exception::class)
suspend fun RiffetApi.syncOutline(id: String, lane: SyncLane, generation: String): SyncOutline = get(
    "/api/v3/sessions/${id.enc()}/outline",
    listOf("lane" to lane, "generation" to generation),
).decode()

/**
 * `GET /api/v3/sessions/:id/find`: the rows of [lane] holding [query] (case-insensitive), by `pos`.
 * 409 `SYNC_GENERATION_CHANGED` when [generation] is stale; 404 from a server without the route.
 */
@Throws(Exception::class)
suspend fun RiffetApi.syncFind(id: String, lane: SyncLane, generation: String, query: String): LaneFind = get(
    "/api/v3/sessions/${id.enc()}/find",
    listOf("lane" to lane, "generation" to generation, "q" to query),
).decode()
