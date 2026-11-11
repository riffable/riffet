package riffet.shared

import io.ktor.client.HttpClient
import io.ktor.client.plugins.HttpTimeoutConfig
import io.ktor.client.plugins.sse.SSEClientException
import io.ktor.client.plugins.sse.sse
import io.ktor.client.plugins.timeout
import io.ktor.client.request.header
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.sse.ServerSentEvent
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.produceIn
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import riffet.contracts.AgentIds
import riffet.contracts.ApiError
import riffet.contracts.RiffetJson
import riffet.contracts.SyncFrame
import riffet.contracts.SyncMode

private const val TAG = "sync"

/** The protocol this client speaks; a server reporting less in `/health` is too old for it. */
const val SYNC_PROTOCOL_VERSION = 3

/** Where a lane's rows stand: a dial names it, and the server sends what changed after [seq]. */
data class SyncCursor(val generation: String, val seq: Long)

/**
 * The server does not speak sync v3: `/health` reports an older protocol, or `/api/v3` is not a
 * route there. Nothing is retried; the app asks for the server to be updated (docs/SYNC-V3.md, 下线 v2).
 */
class SyncServerTooOldException : IllegalStateException("The Riffet server is too old for this app's sync protocol")

/** The server refused the lane for good (a missing conversation, say); redialling would only repeat it. */
class SyncRejectedException(val code: String?, message: String) : IllegalStateException(message)

/**
 * `GET /api/v3/sessions/:id/sync` for one lane (docs/SYNC-V3.md, 续传与缺口).
 *
 * Like [NativeStreamSource] it reconnects forever with backoff, ends only on a revoked token (or a
 * server that cannot speak v3), and drops a stream that has been silent past the watchdog. What it
 * adds is the lane's order: it keeps the generation and the highest lane seq it has passed on, and
 *
 *  - a dial names them (`generation` + `after`), so the server answers with a delta when it can;
 *  - a `rows` frame that does not start right after them is a gap, and the stream redials from them;
 *    one that ends at or before them is a replay and is dropped;
 *  - while a snapshot is arriving (after a snapshot hello or a `reset`), `rows` frames wait for its
 *    final part and are then checked against its `asOfSeq`;
 *  - a `reset` forgets the seq: until its snapshot is complete a dial asks for a fresh snapshot.
 *
 * It never asks for anything older than it holds: history is the caller's to page.
 *
 * The `ping` heartbeat is passed on as [SyncFrame.Unknown] with type `ping`: it tells the caller the
 * server has nothing more to send after a hello.
 *
 * @param url the dial for a cursor, null for a fresh snapshot.
 * @param tooOld asked when the dial is answered 404 without a code of the server's: true when the
 *   server cannot speak v3 (see [RiffetApi.serverSpeaksSync]).
 */
class SyncStream(
    private val http: HttpClient,
    private val url: (SyncCursor?) -> String,
    private val tokenProvider: suspend () -> String?,
    private val config: RiffetClientConfig,
    initial: SyncCursor?,
    private val tooOld: suspend () -> Boolean = { true },
) {
    private val _connection = MutableStateFlow<StreamConnection>(StreamConnection.Connecting)

    /** Connecting until a hello arrives, then live; reconnecting while a new dial is attempted. */
    val connection: StateFlow<StreamConnection> = _connection.asStateFlow()

    private val gate = SyncGate(initial)

    /** What the next dial resumes from; null asks for a snapshot. */
    val cursor: SyncCursor? get() = gate.cursor

    fun flow(): Flow<SyncFrame> = flow {
        var attempt = 0
        while (true) {
            _connection.value = if (attempt == 0) StreamConnection.Connecting else StreamConnection.Reconnecting(attempt)
            var progressed = false
            try {
                val token = tokenProvider()
                val target = url(gate.cursor)
                AppLog.log(TAG, "dial attempt=$attempt ${target.substringAfter("/api/")}")
                http.sse(
                    urlString = target,
                    request = {
                        timeout {
                            requestTimeoutMillis = HttpTimeoutConfig.INFINITE_TIMEOUT_MS
                            socketTimeoutMillis = HttpTimeoutConfig.INFINITE_TIMEOUT_MS
                        }
                        if (!token.isNullOrEmpty()) header(HttpHeaders.Authorization, "Bearer $token")
                        header(FeaturesHeader, (config.features + "session-references-v1").distinct().joinToString(","))
                    },
                ) {
                    val events = incoming.produceIn(this)
                    try {
                        gate.connected()
                        while (true) {
                            val received = withTimeoutOrNull(config.silenceTimeout) { events.receiveCatching() }
                            if (received == null) {
                                AppLog.log(TAG, "watchdog: silent for ${config.silenceTimeout}, redialling")
                                break
                            }
                            val event = received.getOrNull()
                            if (event == null) {
                                AppLog.log(TAG, "closed by server${received.exceptionOrNull()?.let { " (${it::class.simpleName}: ${it.message})" } ?: ""}")
                                break
                            }
                            val frame = decodeSyncFrame(event, AgentIds.PLUGIN_AGENTS_FEATURE in config.features) ?: continue
                            AppLog.detail(TAG) { "recv ${event.event ?: "message"} ${event.data?.length ?: 0}B -> ${frame::class.simpleName}" }
                            val verdict = gate.accept(frame)
                            if (verdict.live) _connection.value = StreamConnection.Live
                            if (verdict.progressed) progressed = true
                            verdict.frames.forEach { emit(it) }
                            verdict.redial?.let { reason ->
                                AppLog.log(TAG, "$reason, redialling from ${gate.cursor}")
                                break
                            }
                        }
                    } finally {
                        events.cancel()
                    }
                }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Throwable) {
                if (error.isUnauthorized()) {
                    AppLog.log(TAG, "unauthenticated: device token rejected, not redialling")
                    throw RiffetUnauthenticatedException(null, error.message ?: "Device token rejected")
                }
                if (error is SyncRejectedException || error is SyncServerTooOldException) throw error
                refusal(error)?.let { throw it }
                AppLog.log(TAG, "failed ${error::class.simpleName}: ${error.message}")
            }
            // A connection that delivered something chains; one that only found a gap backs off.
            if (progressed) attempt = 0
            val backoff = config.retry.delayFor(attempt)
            AppLog.log(TAG, "retry in $backoff")
            delay(backoff)
            attempt += 1
        }
    }

    /** A dial the server answered with a refusal that redialling cannot change, or null to retry. */
    private suspend fun refusal(error: Throwable): Throwable? {
        val response = (error as? SSEClientException)?.response ?: return null
        val status = response.status
        if (status != HttpStatusCode.NotFound && status.value !in REFUSED) return null
        val body = runCatching { response.bodyAsText() }.getOrNull()?.takeIf { it.isNotBlank() }
        val api = body?.let { runCatching { RiffetJson.instance.decodeFromString(ApiError.serializer(), it) }.getOrNull() }?.error
        // A route the server does not have answers NOT_FOUND (or nothing readable); a missing
        // conversation has its own code. `/health` settles the first.
        if (status == HttpStatusCode.NotFound && (api == null || api.code == "NOT_FOUND") && tooOld()) {
            AppLog.log(TAG, "server has no /api/v3")
            return SyncServerTooOldException()
        }
        AppLog.log(TAG, "refused http=${status.value} code=${api?.code}")
        return SyncRejectedException(api?.code, api?.message ?: status.description)
    }
}

/** Statuses that a redial cannot change: bad request, forbidden, gone, upgrade required. */
private val REFUSED = setOf(400, 403, 410, 426)

/** What [SyncGate.accept] made of one frame. */
internal class SyncVerdict(
    val frames: List<SyncFrame> = emptyList(),
    /** Why the connection must be dropped and dialled again from the gate's cursor. */
    val redial: String? = null,
    /** The frame proves the lane is being served (a hello, or a snapshot or rows that followed one). */
    val live: Boolean = false,
    /** The lane moved: a snapshot completed, rows were applied, or the server went quiet after a hello. */
    val progressed: Boolean = false,
)

/**
 * The order a lane's frames must keep, apart from the socket: one gate lives as long as its stream,
 * across redials, and its [cursor] is the next dial's. Pure, so the rules are tested without a socket.
 */
internal class SyncGate(initial: SyncCursor?) {
    private var generation: String? = initial?.generation
    private var held: Long? = initial?.seq

    /** A snapshot hello or a reset was seen and the snapshot's final part has not arrived. */
    private var awaitingSnapshot = false
    private val parked = ArrayList<SyncFrame.Rows>()

    val cursor: SyncCursor?
        get() {
            val generation = generation ?: return null
            val seq = held ?: return null
            return if (awaitingSnapshot) null else SyncCursor(generation, seq)
        }

    /** A new connection: nothing parked survives it, and an unfinished snapshot is asked for again. */
    fun connected() {
        parked.clear()
        if (awaitingSnapshot) {
            awaitingSnapshot = false
            held = null
        }
    }

    fun accept(frame: SyncFrame): SyncVerdict = when (frame) {
        is SyncFrame.Hello -> hello(frame.protocol, frame.generation, frame.mode == SyncMode.DELTA, frame)
        is SyncFrame.Snapshot -> snapshot(frame)
        is SyncFrame.Rows -> if (awaitingSnapshot) {
            if (frame.generation == generation) parked += frame
            SyncVerdict()
        } else rows(frame, released = false)
        is SyncFrame.Reset -> {
            generation = frame.generation
            held = null
            awaitingSnapshot = true
            parked.clear()
            SyncVerdict(listOf(frame))
        }
        is SyncFrame.Error -> {
            if (!frame.retryable) throw SyncRejectedException(frame.code, frame.message)
            SyncVerdict(redial = "server error ${frame.code}")
        }
        is SyncFrame.Unknown -> when (frame.type) {
            HEARTBEAT -> SyncVerdict(listOf(frame), progressed = true)
            // A hello this build cannot read loses its control state; its rows still chain.
            "hello" -> {
                val raw = frame.raw
                val generation = (raw["generation"] as? JsonPrimitive)?.contentOrNull
                if (generation == null) SyncVerdict(live = true)
                else hello(
                    protocol = (raw["protocol"] as? JsonPrimitive)?.contentOrNull?.toLongOrNull() ?: SYNC_PROTOCOL_VERSION.toLong(),
                    generation = generation,
                    delta = (raw["mode"] as? JsonPrimitive)?.contentOrNull == SyncMode.DELTA.wire,
                    frame = null,
                )
            }
            else -> SyncVerdict()
        }
        else -> SyncVerdict(listOf(frame))
    }

    private fun hello(protocol: Long, generation: String, delta: Boolean, frame: SyncFrame.Hello?): SyncVerdict {
        if (protocol < SYNC_PROTOCOL_VERSION) throw SyncServerTooOldException()
        val resumed = this.generation == generation && held != null
        if (delta && !resumed) {
            // A delta from a cursor this client does not hold cannot be applied.
            this.generation = null
            held = null
            return SyncVerdict(redial = "delta without a held cursor")
        }
        this.generation = generation
        if (!delta) {
            held = null
            awaitingSnapshot = true
            parked.clear()
        }
        return SyncVerdict(listOfNotNull(frame), live = true)
    }

    private fun snapshot(frame: SyncFrame.Snapshot): SyncVerdict {
        if (frame.generation != generation) {
            generation = null
            held = null
            awaitingSnapshot = false
            return SyncVerdict(redial = "snapshot of generation ${frame.generation}, expected $generation")
        }
        awaitingSnapshot = true
        if (!frame.final) return SyncVerdict(listOf(frame), live = true)
        awaitingSnapshot = false
        held = frame.asOfSeq
        val frames = mutableListOf<SyncFrame>(frame)
        val waiting = parked.toList()
        parked.clear()
        for (rows in waiting) {
            val verdict = rows(rows, released = true)
            frames += verdict.frames
            if (verdict.redial != null) return SyncVerdict(frames, verdict.redial, live = true, progressed = true)
        }
        return SyncVerdict(frames, live = true, progressed = true)
    }

    private fun rows(frame: SyncFrame.Rows, released: Boolean): SyncVerdict {
        val seq = held
        if (frame.generation != generation || seq == null) return SyncVerdict(redial = "rows of generation ${frame.generation} without its snapshot")
        if (frame.to <= seq) return SyncVerdict()
        if (frame.from != seq + 1) return SyncVerdict(redial = "gap: rows ${frame.from}..${frame.to} after $seq")
        held = frame.to
        return SyncVerdict(listOf(frame), live = !released, progressed = true)
    }
}

/** The server's named heartbeat on the sync stream. */
internal const val HEARTBEAT = "ping"

/**
 * One SSE event to a frame. The SSE `event:` is the frame type; a `data:` that does not repeat it as
 * `type` gets it from there. A frame that does not decode is [SyncFrame.Unknown], never a failed
 * stream; `ping` is [SyncFrame.Unknown] with type `ping`.
 */
fun decodeSyncFrame(event: ServerSentEvent, pluginAgents: Boolean = false): SyncFrame? {
    if (event.event == HEARTBEAT) return SyncFrame.Unknown(HEARTBEAT, JsonObject(emptyMap()))
    val data = event.data?.takeIf { it.isNotBlank() } ?: return null
    val raw = runCatching { RiffetJson.instance.parseToJsonElement(data) }.getOrNull() as? JsonObject ?: return null
    val type = (raw["type"] as? JsonPrimitive)?.contentOrNull
    val typed = if (type == null && event.event != null) JsonObject(raw + ("type" to JsonPrimitive(event.event))) else raw
    val element = if (pluginAgents && data.contains("ackendId")) AgentWire.lift(typed) else typed
    return try {
        RiffetJson.instance.decodeFromJsonElement(SyncFrame.serializer(), element)
    } catch (_: IllegalArgumentException) {
        SyncFrame.Unknown(type ?: event.event, element)
    }
}
