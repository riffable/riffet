package riffet.shared

import io.ktor.client.plugins.websocket.DefaultClientWebSocketSession
import io.ktor.client.plugins.websocket.webSocket
import io.ktor.client.request.header
import io.ktor.client.request.url
import io.ktor.http.HttpHeaders
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import riffet.contracts.TerminalAppearance
import riffet.contracts.TERMINAL_PROTOCOL
import riffet.contracts.TerminalInfo

// RiffetApi endpoints — terminals: shells and the live socket. Transport and auth rules: see RiffetApi.kt.

@Throws(Exception::class)
suspend fun RiffetApi.terminal(id: String): TerminalInfo = get("/api/terminals/${id.enc()}").decode()

/** A new persistent shell in the project's directory. */
@Throws(Exception::class)
suspend fun RiffetApi.createShellTerminal(projectId: String, title: String? = null): TerminalInfo =
    post("/api/terminals", buildJsonObject {
        put("projectId", projectId)
        put("kind", "shell")
        title?.let { put("title", it) }
    }).decode()

/** This device's theme for the pane; the server may answer with a relaunched terminal of the same conversation. */
@Throws(Exception::class)
suspend fun RiffetApi.setTerminalAppearance(id: String, appearance: TerminalAppearance): TerminalInfo =
    post("/api/terminals/${id.enc()}/appearance", buildJsonObject {
        put("foreground", appearance.foreground)
        put("background", appearance.background)
    }).decode()

/** Stops the terminal's process; the server keeps the record as `exited`. */
@Throws(Exception::class)
suspend fun RiffetApi.closeTerminal(id: String): TerminalInfo = delete("/api/terminals/${id.enc()}").decode()

/** SIGINT to the pane's process, as the web's 中断 button does. */
@Throws(Exception::class)
suspend fun RiffetApi.interruptTerminal(id: String): TerminalInfo = post("/api/terminals/${id.enc()}/interrupt").decode()

/**
 * `WS /api/terminals/:id/ws` with the device token. The server's frames are JSON text
 * ([riffet.contracts.TerminalServerMessage]); [block] runs for the life of the socket.
 */
@Throws(Exception::class)
suspend fun RiffetApi.terminalSocket(id: String, block: suspend DefaultClientWebSocketSession.() -> Unit) {
    val token = readToken()
    val url = baseUrl.replaceFirst(Regex("^http"), "ws") + "/api/terminals/${id.enc()}/ws?protocol=$TERMINAL_PROTOCOL"
    http.webSocket(url, request = {
        if (!token.isNullOrEmpty()) header(HttpHeaders.Authorization, "Bearer $token")
        if (config.features.isNotEmpty()) header(FeaturesHeader, config.features.joinToString(","))
    }) { block() }
}

@Throws(Exception::class)
suspend fun RiffetApi.terminals(): List<TerminalInfo> = get("/api/terminals").decode()

/** [sessionsIfChanged] for `GET /api/terminals`. */
@Throws(Exception::class)
suspend fun RiffetApi.terminalsIfChanged(etag: String?): ConditionalList<TerminalInfo> = conditionalList("/api/terminals", etag)

/** Receipt for a terminal paste. Unknown must never be retried automatically. */
@kotlinx.serialization.Serializable
data class TerminalPasteReceipt(val requestId: String, val status: String)

@Throws(Exception::class)
suspend fun RiffetApi.pasteTerminalAttachments(
    id: String, clientId: String, epoch: Long, requestId: String, attachmentIds: List<String>, text: String? = null,
): TerminalPasteReceipt = post("/api/terminals/${id.enc()}/paste-attachments", buildJsonObject {
    put("clientId", clientId)
    put("epoch", epoch)
    put("requestId", requestId)
    text?.let { put("text", it) }
    put("attachmentIds", kotlinx.serialization.json.JsonArray(attachmentIds.map { kotlinx.serialization.json.JsonPrimitive(it) }))
}).decode()
