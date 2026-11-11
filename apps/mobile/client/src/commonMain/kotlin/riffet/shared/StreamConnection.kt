package riffet.shared

import io.ktor.client.plugins.sse.SSEClientException
import io.ktor.http.HttpStatusCode

/** The server's named heartbeat (`event: ping`, every 15 s). It is liveness, not content. */
const val NATIVE_STREAM_HEARTBEAT = "ping"

/**
 * What a stream is doing, reported separately from what it carries.
 *
 * Without this a client can only infer the connection from message arrival, which cannot express
 * "the socket is open but silent, and we are about to dial again" — the exact state a phone spends
 * most of its backgrounded life in. There is deliberately no `Failed` here: a stream gives up only
 * when the server rejects the device token, and then it fails with [RiffetUnauthenticatedException],
 * so a failure is the caller's to decide (see `SessionSync`).
 */
sealed interface StreamConnection {
    /** Dialling, or reconnected with nothing received yet. */
    data object Connecting : StreamConnection

    /** Frames are arriving. */
    data object Live : StreamConnection

    /** The previous connection died and a new one is being attempted. */
    data class Reconnecting(val attempt: Int) : StreamConnection
}

/** A 401: either already typed, or the SSE plugin refusing a stream the server answered with one. */
internal fun Throwable.isUnauthorized(): Boolean =
    this is RiffetUnauthenticatedException ||
        (this is SSEClientException && response?.status == HttpStatusCode.Unauthorized)
