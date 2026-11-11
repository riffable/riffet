package riffet.shared

import io.ktor.client.HttpClient
import io.ktor.client.HttpClientConfig
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.defaultRequest
import io.ktor.client.plugins.sse.SSE
import io.ktor.client.plugins.websocket.WebSockets
import io.ktor.client.request.header
import io.ktor.http.HttpHeaders
import kotlin.random.Random
import kotlin.time.Duration
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds

/**
 * Everything about the transport that a phone may need to change without a new build.
 *
 * @property identityEncoding send `Accept-Encoding: identity` on every request. The server's
 *   `encodingFor` only wraps the long-lived native stream in a gzip encoder when the client
 *   advertises gzip, so this is the escape hatch for a phone whose network mangles gzip. Default
 *   true: the UI can flip it to false to re-enable compression.
 * @property silenceTimeout how long the native stream may go without any event before it is
 *   declared dead. The server's `event: ping` heartbeat is every 15 s, so this must be well above
 *   that and is deliberately three missed heartbeats.
 * @property retry the reconnect schedule. The plugin's own reconnection is disabled, so this is
 *   the only retry path and it never gives up.
 * @property features what this build understands beyond the base contract, sent as
 *   `X-Riffet-Features`. The server withholds the data behind an unlisted feature from clients
 *   that do not name it, so an older build never receives something it cannot render.
 */
class RiffetClientConfig(
    val identityEncoding: Boolean = true,
    val silenceTimeout: Duration = 45.seconds,
    val retry: RetryPolicy = RetryPolicy(),
    val features: List<String> = emptyList(),
)

/**
 * Exponential backoff with full jitter, capped. Bounded per-attempt, unbounded overall: the loop
 * that consumes this never stops, because a phone that leaves Wi-Fi and comes back must recover
 * without a tap.
 */
class RetryPolicy(
    val initialDelay: Duration = 1.seconds,
    val maxDelay: Duration = 30.seconds,
    /** Fraction of the delay that may be added or removed; the jitter avoids a fleet-wide thundering herd. */
    val jitter: Double = 0.25,
) {
    fun delayFor(attempt: Int): Duration {
        var millis = initialDelay.inWholeMilliseconds
        repeat(attempt.coerceIn(0, 20)) {
            millis = minOf(millis * 2, maxDelay.inWholeMilliseconds)
        }
        millis = millis.coerceIn(0, maxDelay.inWholeMilliseconds)
        if (jitter > 0) {
            val spread = (millis * jitter).toLong()
            if (spread > 0) millis = (millis + Random.nextLong(-spread, spread + 1)).coerceAtLeast(0)
        }
        return millis.milliseconds
    }
}

/**
 * The plugins every Riffet client shares. Kept separate from [createRiffetHttpClient] so a test can
 * install exactly this configuration on a mock-engine client instead of testing a look-alike.
 *
 * `maxReconnectionAttempts = 0` is load-bearing. Ktor's SSE plugin can reconnect on its own, but
 * its budget is bounded by that number; a phone must reconnect forever, so reconnection lives in
 * [NativeStreamSource] and this is pinned to off. The default is already 0 in Ktor 3.1.3, and it is
 * set explicitly so a future default change cannot silently split reconnection across two owners.
 */
fun HttpClientConfig<*>.installRiffetClient(config: RiffetClientConfig = RiffetClientConfig()) {
    expectSuccess = false
    install(SSE) {
        maxReconnectionAttempts = 0
    }
    // A paired server that changed address is reached at its new one; see [ServerRoutes].
    install(ServerRouting)
    // Installed so a request can opt out per call: OkHttp's default 10 s read timeout is shorter
    // than the stream's 15 s heartbeat, and cut every quiet stream into a reconnect.
    install(HttpTimeout) {
        connectTimeoutMillis = 10_000
    }
    // The terminal socket. The server never pings, so the client does: a link that died under a
    // Wi-Fi hand-off fails the next pong instead of looking open for minutes.
    install(WebSockets) {
        pingIntervalMillis = 15_000
    }
    if (config.identityEncoding) {
        // Sent as a default header rather than per call, so no endpoint can forget it.
        defaultRequest { header(HttpHeaders.AcceptEncoding, "identity") }
    }
}

/**
 * Creates the real client. With no engine argument Ktor resolves one from the platform artifacts
 * (`ktor-client-okhttp` on Android, `ktor-client-darwin` on iOS).
 */
fun createRiffetHttpClient(config: RiffetClientConfig = RiffetClientConfig()): HttpClient =
    HttpClient { installRiffetClient(config) }
