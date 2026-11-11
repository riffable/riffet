package riffet.shared

import com.sun.net.httpserver.HttpServer
import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.io.OutputStream
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import kotlin.test.assertFailsWith
import riffet.contracts.*
import riffet.ui.composer.UploadableAttachment
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.time.Duration.Companion.milliseconds

/**
 * A revoked token over a real socket: the WebSocket handshake hides the 401, so the connection must
 * learn it from the REST endpoint and stop instead of redialling forever.
 */
class TerminalConnectionSocketTest {

    @Test
    fun themeChangeUpdatesAppearanceWithoutAnotherStateFrame() = runBlocking {
        val light = TerminalAppearance("#202020", "#fafafa")
        val dark = TerminalAppearance("#dedede", "#151515")
        val info = TerminalInfo(id = "t1", projectId = "p1", title = "shell", kind = TerminalKind.SHELL, state = TerminalState.RUNNING,
            persistent = true, epoch = 1, cols = 80, rows = 24, createdAt = "2026-01-01T00:00:00Z", ownerId = "phone", appearance = light)
        val server = TerminalFixture(listOf(TerminalServerMessage.State(info), TerminalServerMessage.Snapshot("", 0, 80, 24, "s")))
        val client = HttpClient(CIO) { installRiffetClient() }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val api = RiffetApi(client, server.baseUrl).also { it.terminalAppearance = light }
            val connection = TerminalConnection(api, "t1", "phone", scope, onOutput = { _, _ -> })
            connection.start()
            withTimeout(5_000) { connection.link.first { it == TerminalLink.Live } }
            api.terminalAppearance = dark
            connection.followAppearance()
            assertEquals(dark, withTimeout(5_000) { server.appearanceRequests.receive() })
            connection.close()
        } finally { scope.cancel(); client.close(); server.close() }
    }

    @Test
    fun explicitSnapshotsSetGridBeforeFeedAndRejectStaleDeltas() = runBlocking {
        val events = Channel<String>(Channel.UNLIMITED)
        val server = TerminalFixture(listOf(
            TerminalServerMessage.Snapshot("screen", 5, 90, 30, "stream-a"),
            TerminalServerMessage.Output("old", 4, "stream-a"),
            TerminalServerMessage.Output("foreign", 6, "stream-b"),
            TerminalServerMessage.Output("new", 6, "stream-a"),
        ))
        val client = HttpClient(CIO) { installRiffetClient() }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val connection = TerminalConnection(RiffetApi(client, server.baseUrl), "t1", "phone", scope,
                onOutput = { text, fresh -> events.trySend("$fresh:$text") },
                onSnapshotGrid = { cols, rows -> events.trySend("grid:$cols:$rows") },
            )
            connection.start()
            withTimeout(5_000) {
                assertEquals("grid:90:30", events.receive())
                assertEquals("true:screen", events.receive())
                assertEquals("false:new", events.receive())
            }
            connection.close()
        } finally { scope.cancel(); client.close(); server.close() }
    }

    @Test
    fun typingDuringUploadPreventsAttachmentPathInsertion() = runBlocking { assertAttachmentNotInserted(loseControl = false) }

    @Test
    fun losingLeaseDuringUploadPreventsAttachmentPathInsertion() = runBlocking { assertAttachmentNotInserted(loseControl = true) }

    private suspend fun assertAttachmentNotInserted(loseControl: Boolean) {
        val info = TerminalInfo(id = "t1", projectId = "p1", title = "shell", kind = TerminalKind.SHELL, state = TerminalState.RUNNING,
            persistent = true, epoch = 1, cols = 80, rows = 24, createdAt = "2026-01-01T00:00:00Z", ownerId = "phone")
        val server = TerminalFixture(listOf(TerminalServerMessage.State(info), TerminalServerMessage.Snapshot("", 0, 80, 24, "s")))
        val client = HttpClient(CIO) { installRiffetClient() }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val connection = TerminalConnection(RiffetApi(client, server.baseUrl), "t1", "phone", scope, onOutput = { _, _ -> })
            connection.start()
            withTimeout(5_000) { connection.link.first { it == TerminalLink.Live } }
            val lease = connection.acquirePasteLease()
            val image = object : UploadableAttachment {
                override val name = "paste.png"
                override val mimeType = "image/png"
                override val bytes = byteArrayOf(1, 2, 3)
                override val width: Int? = null
                override val height: Int? = null
            }
            val operation = scope.async { connection.pasteAttachments(listOf(image), "paste-1", lease) }
            withTimeout(5_000) { server.uploadStarted.first { it } }
            if (loseControl) {
                server.send(TerminalServerMessage.State(info.copy(ownerId = "other", epoch = 2)))
                withTimeout(5_000) { connection.info.first { it?.ownerId == "other" } }
            } else connection.sendInput("typed")
            server.uploadGate.countDown()
            assertFailsWith<IllegalStateException> { withTimeout(5_000) { operation.await() } }
            assertEquals(0, server.pasteCalls.get())
            connection.close()
        } finally { scope.cancel(); client.close(); server.close() }
    }

    @Test
    fun aRejectedTokenStopsTheTerminalRedialLoop() = runBlocking {
        val dials = AtomicInteger(0)
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/api/terminals/t1") { exchange ->
            if (exchange.requestURI.path.endsWith("/ws")) dials.incrementAndGet()
            val body = """{"error":{"code":"UNAUTHENTICATED","message":"revoked"}}""".toByteArray()
            exchange.responseHeaders.add("Content-Type", "application/json")
            exchange.sendResponseHeaders(401, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
            exchange.close()
        }
        server.start()

        val client = HttpClient(CIO) {
            installRiffetClient(RiffetClientConfig(retry = RetryPolicy(initialDelay = 50.milliseconds, maxDelay = 50.milliseconds, jitter = 0.0)))
        }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val api = RiffetApi(client, "http://127.0.0.1:${server.address.port}", tokenProvider = { "wkn_0123456789abcdef_revoked" })
            val connection = TerminalConnection(
                api = api, terminalId = "t1", clientId = "phone", scope = scope, onOutput = { _, _ -> },
                retry = RetryPolicy(initialDelay = 50.milliseconds, maxDelay = 50.milliseconds, jitter = 0.0),
            )
            connection.start()
            withTimeout(10_000) { connection.link.first { it == TerminalLink.Unauthenticated } }
            delay(300)
            assertEquals(1, dials.get(), "a rejected token must not be redialled")
        } finally {
            scope.cancel()
            client.close()
            server.stop(0)
        }
    }
}

/** A tiny real WS/HTTP peer; no terminal emulator or UI assertions. */
private class TerminalFixture(private val initial: List<TerminalServerMessage>) : AutoCloseable {
    private val listener = ServerSocket(0, 16, java.net.InetAddress.getByName("127.0.0.1"))
    private val sockets = CopyOnWriteArrayList<Socket>()
    val baseUrl = "http://127.0.0.1:${listener.localPort}"
    @Volatile private var websocket: OutputStream? = null
    val uploadStarted = MutableStateFlow(false)
    val uploadGate = CountDownLatch(1)
    val pasteCalls = AtomicInteger()
    val appearanceRequests = Channel<TerminalAppearance>(Channel.UNLIMITED)
    init {
        thread(isDaemon = true) {
            while (!listener.isClosed) {
                val socket = runCatching { listener.accept() }.getOrNull() ?: break
                sockets += socket
                thread(isDaemon = true) { runCatching { handle(socket) } }
            }
        }
    }
    private fun handle(socket: Socket) {
        val input = socket.getInputStream().bufferedReader()
        val request = input.readLine() ?: return
        val headers = linkedMapOf<String, String>()
        while (true) {
            val line = input.readLine() ?: return
            if (line.isEmpty()) break
            headers[line.substringBefore(':').lowercase()] = line.substringAfter(':').trim()
        }
        val output = socket.getOutputStream()
        if (headers["upgrade"]?.lowercase() == "websocket") {
            val key = headers.getValue("sec-websocket-key")
            val accept = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-1").digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").toByteArray()))
            output.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: $accept\r\n\r\n".toByteArray())
            output.flush()
            websocket = output
            initial.forEach(::send)
            return
        }
        val size = headers["content-length"]?.toInt() ?: 0
        val requestBody = buildString { repeat(size) { append(input.read().toChar()) } }
        val body = when {
            request.contains("/appearance ") -> {
                val appearance = RiffetJson.instance.decodeFromString(TerminalAppearance.serializer(), requestBody)
                appearanceRequests.trySend(appearance)
                val info = initial.filterIsInstance<TerminalServerMessage.State>().first().terminal
                RiffetJson.instance.encodeToString(TerminalInfo.serializer(), info.copy(appearance = appearance))
            }
            request.contains("/paste-attachments ") -> { pasteCalls.incrementAndGet(); """{"requestId":"paste-1","status":"completed"}""" }
            request.contains("/attachments ") -> {
                uploadStarted.value = true
                check(uploadGate.await(5, TimeUnit.SECONDS))
                """{"id":"a1","name":"paste.png","mimeType":"image/png","size":3,"path":"/attachments/a1.png"}"""
            }
            else -> "{}"
        }.toByteArray()
        output.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: ${body.size}\r\n\r\n".toByteArray())
        output.write(body)
        output.flush()
        socket.close()
    }
    fun send(message: TerminalServerMessage) {
        val output = checkNotNull(websocket)
        synchronized(output) { writeText(output, RiffetJson.instance.encodeToString(TerminalServerMessage.serializer(), message)) }
    }
    private fun writeText(output: OutputStream, text: String) {
        val bytes = text.toByteArray()
        output.write(0x81)
        if (bytes.size < 126) output.write(bytes.size) else {
            output.write(126); output.write(bytes.size shr 8); output.write(bytes.size and 255)
        }
        output.write(bytes)
        output.flush()
    }
    override fun close() {
        uploadGate.countDown()
        listener.close()
        sockets.forEach { runCatching { it.close() } }
    }
}
