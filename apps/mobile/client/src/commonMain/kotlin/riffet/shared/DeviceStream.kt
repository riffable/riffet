package riffet.shared

import io.ktor.client.HttpClient
import io.ktor.client.plugins.HttpTimeoutConfig
import io.ktor.client.plugins.sse.SSEClientException
import io.ktor.client.plugins.sse.sse
import io.ktor.client.plugins.timeout
import io.ktor.client.request.header
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.sse.ServerSentEvent
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.FlowCollector
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.produceIn
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.KSerializer
import riffet.contracts.DeviceCall
import riffet.contracts.DeviceCallCancel
import riffet.contracts.DeviceLease
import riffet.contracts.DeviceLeaseCancel
import riffet.contracts.RiffetJson
import riffet.contracts.RiffetNotice
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds

/** What `/api/devices/me/stream` sends (docs/DEVICES.md §3). [Heartbeat] marks the end of a dial's replay. */
sealed interface DeviceStreamEvent {
    data class Call(val call: DeviceCall) : DeviceStreamEvent
    data class Cancel(val callId: String) : DeviceStreamEvent
    data class Lease(val lease: DeviceLease) : DeviceStreamEvent
    data class LeaseCancel(val id: String) : DeviceStreamEvent

    /** A dial got its first frame; the replay of open calls and future leases follows. */
    data object Connected : DeviceStreamEvent

    /** The first `ping` of a connection; everything replayed on connect came before it. */
    data object Heartbeat : DeviceStreamEvent
}

/** The device stream plus its connection. Collecting [events] dials; [kick] cuts a backoff short. */
class DeviceStreamSession(
    val events: Flow<DeviceStreamEvent>,
    val connection: StateFlow<StreamConnection>,
    private val kicks: Channel<Unit>,
) {
    /** The network came back or the app came to the front: dial now instead of at the end of the backoff. */
    fun kick() {
        kicks.trySend(Unit)
    }
}

/**
 * `GET /api/devices/me/stream`. [beforeDial] runs before every dial (the device's `PUT
 * /api/devices/me`), so the server always holds a fresh report while the stream is open. Redials
 * forever with the shared backoff until the device token is rejected, like [StatsStreamSource].
 */
class DeviceStreamSource(
    private val http: HttpClient,
    private val url: String,
    private val tokenProvider: suspend () -> String?,
    private val config: RiffetClientConfig,
    private val beforeDial: suspend () -> Unit,
) {
    fun open(): DeviceStreamSession {
        val connection = MutableStateFlow<StreamConnection>(StreamConnection.Connecting)
        val kicks = Channel<Unit>(Channel.CONFLATED)
        val events = redialling("device", http, url, tokenProvider, config, connection, kicks, DEVICE_SILENCE, beforeDial, DeviceStreamEvent.Connected) { event, first ->
            decodeDeviceFrame(event, first)
        }
        return DeviceStreamSession(events, connection.asStateFlow(), kicks)
    }
}

/** What `/api/lists/stream` sends: [Changed] carries the frame's raw JSON (revisions per list), never list data. */
sealed interface ListsStreamEvent {
    data class Changed(val data: String) : ListsStreamEvent
    data class Notice(val notice: RiffetNotice) : ListsStreamEvent
}

/** The lists stream plus its connection. Collecting [events] dials; [kick] cuts a backoff short. */
class ListsStreamSession(val events: Flow<ListsStreamEvent>, val connection: StateFlow<StreamConnection>, private val kicks: Channel<Unit>) {
    fun kick() {
        kicks.trySend(Unit)
    }
}

class ListsStreamSource(
    private val http: HttpClient,
    private val url: String,
    private val tokenProvider: suspend () -> String?,
    private val config: RiffetClientConfig,
) {
    fun open(): ListsStreamSession {
        val connection = MutableStateFlow<StreamConnection>(StreamConnection.Connecting)
        val kicks = Channel<Unit>(Channel.CONFLATED)
        val events = redialling<ListsStreamEvent>("lists", http, url, tokenProvider, config, connection, kicks, DEVICE_SILENCE, beforeDial = {}, connected = null) { event, _ ->
            when (event.event) {
                "notice" -> decode(RiffetNotice.serializer(), event.data)?.let(ListsStreamEvent::Notice)
                "changed" -> ListsStreamEvent.Changed(event.data.orEmpty())
                else -> null
            }
        }
        return ListsStreamSession(events, connection.asStateFlow(), kicks)
    }
}

/** Both streams beat every 15 s; three missed beats is a dead socket. */
private val DEVICE_SILENCE: Duration = 45.seconds

/** Unknown events, and frames that do not decode, are skipped so a newer server cannot end the loop. */
fun decodeDeviceFrame(event: ServerSentEvent, firstHeartbeat: Boolean): DeviceStreamEvent? = when (event.event) {
    "call" -> decode(DeviceCall.serializer(), event.data)?.let(DeviceStreamEvent::Call)
    "cancel" -> decode(DeviceCallCancel.serializer(), event.data)?.let { DeviceStreamEvent.Cancel(it.callId) }
    "lease" -> decode(DeviceLease.serializer(), event.data)?.let(DeviceStreamEvent::Lease)
    "lease-cancel" -> decode(DeviceLeaseCancel.serializer(), event.data)?.let { DeviceStreamEvent.LeaseCancel(it.id) }
    NATIVE_STREAM_HEARTBEAT -> if (firstHeartbeat) DeviceStreamEvent.Heartbeat else null
    else -> null
}

private fun <T> decode(serializer: KSerializer<T>, data: String?): T? {
    val text = data?.takeIf { it.isNotBlank() } ?: return null
    return runCatching { RiffetJson.instance.decodeFromString(serializer, text) }.getOrNull()
}

/**
 * The reconnect loop the two streams share. [connected] is emitted on a dial's first frame; [decode]
 * gets each frame and whether it is the first heartbeat of this connection. A 401 from [beforeDial] or the dial ends the flow; any other failure
 * waits out [RiffetClientConfig.retry], which a [kicks] send cuts short.
 */
private fun <T : Any> redialling(
    tag: String,
    http: HttpClient,
    url: String,
    tokenProvider: suspend () -> String?,
    config: RiffetClientConfig,
    connection: MutableStateFlow<StreamConnection>,
    kicks: Channel<Unit>,
    silence: Duration,
    beforeDial: suspend () -> Unit,
    connected: T?,
    decode: (ServerSentEvent, Boolean) -> T?,
): Flow<T> = flow {
    var attempt = 0
    while (true) {
        connection.value = if (attempt == 0) StreamConnection.Connecting else StreamConnection.Reconnecting(attempt)
        // A kick that arrived while connected is stale once this dial starts.
        kicks.tryReceive()
        try {
            beforeDial()
            val token = tokenProvider()
            AppLog.log(tag, "dial attempt=$attempt")
            http.sse(
                urlString = url,
                request = {
                    timeout {
                        requestTimeoutMillis = HttpTimeoutConfig.INFINITE_TIMEOUT_MS
                        socketTimeoutMillis = HttpTimeoutConfig.INFINITE_TIMEOUT_MS
                    }
                    if (!token.isNullOrEmpty()) header(HttpHeaders.Authorization, "Bearer $token")
                    if (config.features.isNotEmpty()) header(FeaturesHeader, config.features.joinToString(","))
                },
                // The lists stream's heartbeat is a comment; without these the watchdog would fire.
                showCommentEvents = true,
            ) {
                val events = incoming.produceIn(this)
                try {
                    var live = false
                    var beat = false
                    while (true) {
                        val received = withTimeoutOrNull(silence) { events.receiveCatching() }
                        if (received == null) {
                            AppLog.log(tag, "watchdog: silent, redialling")
                            break
                        }
                        val event = received.getOrNull()
                        if (event == null) {
                            AppLog.log(tag, "closed by server")
                            break
                        }
                        if (!live) {
                            live = true
                            attempt = 0
                            connection.value = StreamConnection.Live
                            emitDecoded(connected)
                        }
                        val first = event.event == NATIVE_STREAM_HEARTBEAT && !beat
                        if (first) beat = true
                        emitDecoded(decode(event, first))
                    }
                } finally {
                    events.cancel()
                }
            }
        } catch (cancellation: CancellationException) {
            AppLog.log(tag, "cancelled")
            throw cancellation
        } catch (error: Throwable) {
            if (error.isUnauthorized()) {
                AppLog.log(tag, "unauthenticated: device token rejected, not redialling")
                return@flow
            }
            if (error.isNotFound()) {
                // A server from before the device channel; the next pairing or launch tries again.
                AppLog.log(tag, "route missing on this server, not redialling")
                return@flow
            }
            AppLog.log(tag, "failed ${error::class.simpleName}: ${error.message}")
        }
        withTimeoutOrNull(config.retry.delayFor(attempt)) { kicks.receive() }
        attempt += 1
    }
}

private fun Throwable.isNotFound(): Boolean =
    (this is RiffetHttpException && status == 404) ||
        (this is SSEClientException && response?.status == HttpStatusCode.NotFound)

private suspend fun <T : Any> FlowCollector<T>.emitDecoded(value: T?) {
    if (value != null) emit(value)
}
