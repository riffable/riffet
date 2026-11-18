package riffet.sync

import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import kotlin.concurrent.thread
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds
import riffet.shared.RetryPolicy
import riffet.shared.RiffetApi
import riffet.shared.RiffetClientConfig
import riffet.shared.installRiffetClient

/** One request the fake server received. */
internal class FakeRequest(val path: String, val query: Map<String, String>, val headers: Map<String, String>)

internal sealed interface FakeResponse {
    class Json(val body: String, val status: Int = 200) : FakeResponse

    /** An SSE body; [open] keeps the connection up after it, as a live server does between frames. */
    class Sse(val text: String, val open: Boolean) : FakeResponse
}

/**
 * A Riffet server on the loopback interface, answering each request with [route]: a real socket, so
 * the client's own engine (CIO) and its SSE plugin run exactly as they do against the server.
 */
internal class FakeServer(private val route: (FakeRequest) -> FakeResponse) : AutoCloseable {
    private val socket = ServerSocket(0, 50, InetAddress.getLoopbackAddress())
    private val closed = CountDownLatch(1)
    private val connections = CopyOnWriteArrayList<Socket>()
    val requests = CopyOnWriteArrayList<FakeRequest>()
    val config = RiffetClientConfig(silenceTimeout = 5.seconds, retry = RetryPolicy(initialDelay = 1.milliseconds, maxDelay = 2.milliseconds, jitter = 0.0))
    val http = HttpClient(CIO) { installRiffetClient(config) }
    val api = RiffetApi(http, "http://127.0.0.1:${socket.localPort}", config = config)

    init {
        thread(isDaemon = true, name = "fake-riffet") {
            while (!socket.isClosed) {
                val connection = runCatching { socket.accept() }.getOrNull() ?: break
                connections += connection
                thread(isDaemon = true) { serve(connection) }
            }
        }
    }

    fun dials(): List<FakeRequest> = requests.filter { it.path.endsWith("/sync") }

    private fun serve(connection: Socket) {
        runCatching {
            // HTTP headers are byte-oriented; this also lets Content-Length count body bytes exactly.
            val reader = BufferedReader(InputStreamReader(connection.getInputStream(), Charsets.ISO_8859_1))
            val target = reader.readLine()?.split(' ')?.getOrNull(1) ?: return
            val headers = LinkedHashMap<String, String>()
            while (true) {
                val line = reader.readLine() ?: break
                if (line.isEmpty()) break
                val colon = line.indexOf(':')
                if (colon > 0) headers[line.substring(0, colon).trim().lowercase()] = line.substring(colon + 1).trim()
            }
            // Closing a socket with an unread POST body can reset it before CIO reads the response.
            var remaining = headers["content-length"]?.toIntOrNull() ?: 0
            val body = CharArray(1024)
            while (remaining > 0) {
                val read = reader.read(body, 0, minOf(body.size, remaining))
                if (read < 0) return
                remaining -= read
            }
            val path = target.substringBefore('?')
            val query = target.substringAfter('?', "").split('&').filter { it.isNotEmpty() }.associate { pair ->
                URLDecoder.decode(pair.substringBefore('='), "UTF-8") to URLDecoder.decode(pair.substringAfter('=', ""), "UTF-8")
            }
            val request = FakeRequest(path, query, headers)
            requests += request
            val out = connection.getOutputStream()
            when (val response = route(request)) {
                is FakeResponse.Json -> {
                    val body = response.body.toByteArray()
                    out.head("${response.status} ${if (response.status == 200) "OK" else "Error"}", "application/json", body.size)
                    out.write(body)
                    out.flush()
                }
                is FakeResponse.Sse -> {
                    out.head("200 OK", "text/event-stream", null)
                    out.write(response.text.toByteArray())
                    out.flush()
                    if (response.open) closed.await()
                }
            }
        }
        runCatching { connection.close() }
    }

    private fun OutputStream.head(status: String, type: String, length: Int?) {
        val head = buildString {
            append("HTTP/1.1 $status\r\nContent-Type: $type\r\nConnection: close\r\n")
            if (length != null) append("Content-Length: $length\r\n")
            append("\r\n")
        }
        write(head.toByteArray())
    }

    override fun close() {
        closed.countDown()
        runCatching { socket.close() }
        connections.forEach { runCatching { it.close() } }
        http.close()
    }
}

/** An SSE body of [frames] (`event` to `data`); the server ends the stream after it. */
internal fun sse(vararg frames: Pair<String, String>) = FakeResponse.Sse(sseText(frames), open = false)

/** An SSE body of [frames], after which the stream stays open. */
internal fun sseOpen(vararg frames: Pair<String, String>) = FakeResponse.Sse(sseText(frames), open = true)

private fun sseText(frames: Array<out Pair<String, String>>) = frames.joinToString("") { (event, data) -> "event: $event\ndata: $data\n\n" }

internal fun json(body: String, status: Int = 200) = FakeResponse.Json(body, status)

internal const val SESSION_JSON =
    """{"id":"s1","projectId":"p1","kind":"native","title":"t","tags":[],"state":"idle","mode":"agent","createdAt":"2026-10-25T00:00:00Z","updatedAt":"2026-10-25T00:00:00Z"}"""

internal fun hello(
    generation: String,
    mode: String = "snapshot",
    headSeq: Long = 0,
    phase: String = "idle",
    runs: String = "[]",
    interaction: String = "null",
    turns: String = "[]",
): Pair<String, String> = "hello" to
    """{"type":"hello","protocol":3,"lane":"main","generation":"$generation","headSeq":$headSeq,"mode":"$mode","session":$SESSION_JSON,""" +
    """"status":{"phase":"$phase"},"interaction":$interaction,"runs":$runs,"activities":[],"outline":{"turnCount":${if (turns == "[]") 0 else 1},"turns":$turns}}"""

internal fun row(key: String, pos: Long, seq: Long, text: String = key, kind: String = "assistant", extra: String = "", runId: String? = null, lastAt: String = "2026-10-25T00:00:0${pos % 10}Z"): String =
    """{"key":"$key","pos":$pos,"turn":"run:r1","seq":$seq,"rev":1,${runId?.let { "\"runId\":\"$it\"," } ?: ""}""" +
        """"event":{"type":"agent_message_chunk","data":{},"createdAt":"2026-10-25T00:00:0${pos % 10}Z","lastAt":"$lastAt","sourceIds":["n-$key"]},""" +
        """"kind":"$kind","text":"$text"$extra}"""

internal fun userRow(key: String, pos: Long, seq: Long, text: String, runId: String? = null, pending: String? = null): String =
    row(key, pos, seq, text, kind = "user", extra = ""","attachments":[]${pending?.let { ",\"pending\":\"$it\"" } ?: ""}""", runId = runId)

internal fun snapshot(generation: String, asOfSeq: Long, vararg rows: String, part: Int = 0, final: Boolean = true, hasBefore: Boolean = false): Pair<String, String> =
    "snapshot" to """{"type":"snapshot","generation":"$generation","asOfSeq":$asOfSeq,"part":$part,"final":$final,"rows":[${rows.joinToString(",")}],"hasBefore":$hasBefore}"""

internal fun rows(generation: String, from: Long, to: Long, vararg upserts: String, deletes: List<String> = emptyList()): Pair<String, String> =
    "rows" to """{"type":"rows","generation":"$generation","from":$from,"to":$to,"upserts":[${upserts.joinToString(",")}],"deletes":[${deletes.joinToString(",") { "\"$it\"" }}]}"""

internal fun reset(generation: String): Pair<String, String> = "reset" to """{"type":"reset","generation":"$generation","reason":"rebuilt"}"""

internal fun status(phase: String): Pair<String, String> = "status" to """{"type":"status","status":{"phase":"$phase"}}"""

internal fun runJson(id: String, commandId: String, state: String = "running", delivery: String = "observed", at: String = "2026-10-25T00:00:00Z", intent: String? = null): String =
    """{"id":"$id","sessionId":"s1","commandId":"$commandId","prompt":"hi $id","state":"$state","createdAt":"$at","updatedAt":"$at",""" +
        """"native":{${intent?.let { "\"intent\":\"$it\"," } ?: ""}"input":{"text":"hi","attachmentIds":[],"context":[]},"config":{"mode":"agent"},"fingerprint":"f","delivery":"$delivery","attempt":1,"configRevision":1}}"""

internal val ping: Pair<String, String> = "ping" to "{}"
