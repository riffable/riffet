package riffet.shared

import io.ktor.client.HttpClient
import io.ktor.client.plugins.HttpTimeoutConfig
import io.ktor.client.plugins.sse.sse
import io.ktor.client.plugins.timeout
import io.ktor.client.request.header
import io.ktor.http.HttpHeaders
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
import riffet.contracts.StatsStreamMessage
import riffet.contracts.RiffetJson
import kotlin.time.Duration.Companion.minutes

private const val TAG = "stats"

/**
 * How long `/api/stats/stream` may stay quiet before it is redialled.
 *
 * Unlike the native transcript, this stream has no heartbeat: silence means nothing changed.
 * The watchdog is only here for a socket that died without closing. Any frame, including a
 * `ping` if a future server sends one, resets it.
 */
private val STATS_SILENCE = 3.minutes

/** The live hint stream plus the connection that carries it. Collecting [messages] starts the dial. */
class StatsStreamSession(
    val messages: Flow<StatsStreamMessage>,
    val connection: StateFlow<StreamConnection>,
)

/**
 * `GET /api/stats/stream`, with the same reconnect loop as [NativeStreamSource]: the SSE plugin
 * does not retry (`maxReconnectionAttempts = 0`), and this loop does, with the shared backoff, until
 * the server rejects the device token. A frame is only a hint — the page refetches the dashboard
 * itself.
 */
class StatsStreamSource(
    private val http: HttpClient,
    private val url: String,
    private val tokenProvider: suspend () -> String?,
    private val config: RiffetClientConfig,
) {
    private val connection = MutableStateFlow<StreamConnection>(StreamConnection.Connecting)

    fun open(): StatsStreamSession = StatsStreamSession(messages = flow(), connection = connection.asStateFlow())

    private fun flow(): Flow<StatsStreamMessage> = flow {
        var attempt = 0
        while (true) {
            connection.value = if (attempt == 0) StreamConnection.Connecting else StreamConnection.Reconnecting(attempt)
            try {
                val token = tokenProvider()
                AppLog.log(TAG, "dial attempt=$attempt")
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
                ) {
                    val events = incoming.produceIn(this)
                    try {
                        var live = false
                        while (true) {
                            val received = withTimeoutOrNull(STATS_SILENCE) { events.receiveCatching() }
                            if (received == null) {
                                AppLog.log(TAG, "watchdog: silent, redialling")
                                break
                            }
                            val event = received.getOrNull()
                            if (event == null) {
                                AppLog.log(TAG, "closed by server")
                                break
                            }
                            if (!live) {
                                live = true
                                connection.value = StreamConnection.Live
                            }
                            decodeStatsFrame(event)?.let { emit(it) }
                        }
                    } finally {
                        events.cancel()
                    }
                }
                attempt = 0
            } catch (cancellation: CancellationException) {
                AppLog.log(TAG, "cancelled")
                throw cancellation
            } catch (error: Throwable) {
                if (error.isUnauthorized()) {
                    // The dashboard's own read reports the revoked token; redialling cannot fix it.
                    AppLog.log(TAG, "unauthenticated: device token rejected, not redialling")
                    return@flow
                }
                AppLog.log(TAG, "failed ${error::class.simpleName}: ${error.message}")
            }
            delay(config.retry.delayFor(attempt))
            attempt += 1
        }
    }
}

/** `ping` is liveness. Anything that is not `stats_changed` is ignored so a new frame type cannot kill the loop. */
fun decodeStatsFrame(event: ServerSentEvent): StatsStreamMessage? {
    if (event.event == NATIVE_STREAM_HEARTBEAT) return null
    val data = event.data?.takeIf { it.isNotBlank() } ?: return null
    val message = runCatching { RiffetJson.instance.decodeFromString(StatsStreamMessage.serializer(), data) }.getOrNull()
        ?: return null
    return message.takeIf { it.type == "stats_changed" }
}
