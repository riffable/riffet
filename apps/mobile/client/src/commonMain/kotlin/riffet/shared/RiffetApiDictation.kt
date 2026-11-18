package riffet.shared

import io.ktor.client.plugins.websocket.DefaultClientWebSocketSession
import io.ktor.client.plugins.websocket.webSocket
import io.ktor.client.request.header
import io.ktor.http.HttpHeaders
import riffet.contracts.DICTATION_ROUTE

// RiffetApi endpoints — dictation (docs/VOICE.md §4). Transport and auth rules: see RiffetApi.kt.

/** `WS /api/dictation/ws` with the device token; [block] runs for the life of the socket. */
@Throws(Exception::class)
suspend fun RiffetApi.dictationSocket(block: suspend DefaultClientWebSocketSession.() -> Unit) {
    val token = readToken()
    val url = baseUrl.replaceFirst(Regex("^http"), "ws") + DICTATION_ROUTE
    http.webSocket(url, request = {
        if (!token.isNullOrEmpty()) header(HttpHeaders.Authorization, "Bearer $token")
        if (config.features.isNotEmpty()) header(FeaturesHeader, config.features.joinToString(","))
    }) { block() }
}
