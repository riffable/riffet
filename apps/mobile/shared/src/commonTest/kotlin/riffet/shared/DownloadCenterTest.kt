package riffet.shared

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.ktor.utils.io.ByteChannel
import io.ktor.utils.io.writeFully
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.builtins.ListSerializer
import riffet.contracts.RiffetJson
import kotlin.test.Test
import kotlin.test.assertEquals

class DownloadCenterTest {
    private class MemoryPreferences : AppPreferences {
        val values = mutableMapOf<String, String>()
        override fun themeMode() = ThemeMode.SYSTEM
        override fun setThemeMode(mode: ThemeMode) = Unit
        override fun string(key: String): String? = values[key]
        override fun setString(key: String, value: String?) {
            if (value == null) values.remove(key) else values[key] = value
        }
    }

    private fun item(id: String, state: DownloadState) = DownloadItem(
        id = id,
        projectId = "p",
        path = "src/$id.txt",
        name = "$id.txt",
        state = state,
        startedAt = 1L,
    )

    private fun stored(vararg items: DownloadItem) = MemoryPreferences().apply {
        values["downloads"] = RiffetJson.instance.encodeToString(ListSerializer(DownloadItem.serializer()), items.toList())
    }

    @Test
    fun `a download still running when the process died comes back as failed`() {
        val center = DownloadCenter(stored(item("a", DownloadState.RUNNING), item("b", DownloadState.SAVED)))
        val items = center.items.value
        assertEquals(listOf(DownloadState.FAILED, DownloadState.SAVED), items.map { it.state })
        assertEquals(INTERRUPTED_DOWNLOAD_ERROR, items.first().error)
    }

    @Test
    fun `removing and clearing are written through`() {
        val preferences = stored(
            item("a", DownloadState.SAVED),
            item("b", DownloadState.FAILED),
            item("c", DownloadState.CANCELLED),
        )
        DownloadCenter(preferences).remove("a")
        assertEquals(listOf("b", "c"), DownloadCenter(preferences).items.value.map { it.id })

        DownloadCenter(preferences).clearFinished()
        assertEquals(emptyList(), DownloadCenter(preferences).items.value)
    }

    @Test
    fun `an unreadable history starts empty`() {
        val preferences = MemoryPreferences().apply { values["downloads"] = "not json" }
        assertEquals(emptyList(), DownloadCenter(preferences).items.value)
    }

    /** Every request hangs until cancelled; [cancelled] completes once the first one has been. */
    private class HangingServer {
        val requests = Channel<Unit>(Channel.UNLIMITED)
        val cancelled = CompletableDeferred<Unit>()
        val api = RiffetApi(
            HttpClient(
                MockEngine {
                    requests.send(Unit)
                    try {
                        awaitCancellation()
                    } finally {
                        cancelled.complete(Unit)
                    }
                },
            ) { installRiffetClient() },
            "http://127.0.0.1:9",
        )
    }

    @Test
    fun `a cancelled download is marked cancelled`() = runTest {
        val server = HangingServer()
        val center = DownloadCenter(null)
        center.start(server.api, "p", "a.txt")
        withContext(Dispatchers.Default) {
            withTimeout(5_000) {
                server.requests.receive()
                center.cancel(center.items.value.single().id)
                assertEquals(DownloadState.CANCELLED, center.items.first { it.single().state != DownloadState.RUNNING }.single().state)
            }
        }
    }

    @Test
    fun `a download retried right after its cancel is not finished by the cancelled run`() = runTest {
        val server = HangingServer()
        val center = DownloadCenter(null)
        center.start(server.api, "p", "a.txt")
        withContext(Dispatchers.Default) {
            withTimeout(5_000) {
                server.requests.receive()
                val id = center.items.value.single().id
                center.cancel(id)
                center.start(server.api, "p", "a.txt")
                server.cancelled.await()
                server.requests.receive()
                // The cancelled run's completion lands after its request ends; give it the time to.
                delay(200)
                val row = center.items.value.single()
                assertEquals(DownloadState.RUNNING, row.state)
                center.start(server.api, "p", "a.txt")
                assertEquals(row, center.items.value.single(), "the retried run is the one running")
                center.cancel(id)
                assertEquals(DownloadState.CANCELLED, center.items.first { it.single().state != DownloadState.RUNNING }.single().state)
            }
        }
    }

    @Test
    fun `deleting a saved file removes its durable record only after success`() = runTest {
        val saved = item("a", DownloadState.SAVED)
        val preferences = stored(saved)
        val called = CompletableDeferred<DownloadItem>()
        val center = DownloadCenter(preferences) { target -> called.complete(target); true }
        center.deleteFile(saved)
        withContext(Dispatchers.Default) {
            withTimeout(5_000) {
                assertEquals(saved, called.await())
                center.items.first { it.isEmpty() }
                // Persistence follows the state update on the deletion worker.
                while (DownloadCenter(preferences).items.value.isNotEmpty()) delay(10)
            }
        }
    }

    @Test
    fun `a deletion in flight reserves the file and ignores a duplicate delete`() = runTest {
        val server = HangingServer()
        val saved = item("p\u0000a.txt", DownloadState.SAVED).copy(path = "a.txt")
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val center = DownloadCenter(stored(saved)) { entered.complete(Unit); release.await(); true }
        center.deleteFile(saved)
        withContext(Dispatchers.Default) {
            withTimeout(5_000) {
                entered.await()
                center.deleteFile(saved)
                center.start(server.api, "p", "a.txt")
                assertEquals(saved, center.items.value.single())
                kotlin.test.assertTrue(server.requests.tryReceive().isFailure)
                release.complete(Unit)
                center.items.first { it.isEmpty() }
            }
        }
    }

    @Test
    fun `a stale delete confirmation cannot delete a restarted download`() = runTest {
        val server = HangingServer()
        val saved = item("p\u0000a.txt", DownloadState.SAVED).copy(path = "a.txt")
        val deleted = CompletableDeferred<Unit>()
        val center = DownloadCenter(stored(saved)) { deleted.complete(Unit); true }
        center.start(server.api, "p", "a.txt")
        center.deleteFile(saved)
        withContext(Dispatchers.Default) {
            withTimeout(5_000) {
                server.requests.receive()
                delay(100)
                kotlin.test.assertFalse(deleted.isCompleted, "a stale confirmation must not touch the saved file")
                assertEquals(DownloadState.RUNNING, center.items.value.first { it.id == saved.id }.state)
                // The earlier file keeps a row of its own, so it can still be deleted.
                assertEquals(saved.copy(id = "${saved.id}\u0000${saved.startedAt}"), center.items.value.single { it.id != saved.id })
                center.cancel(saved.id)
                server.cancelled.await()
            }
        }
    }

    /** A destination in memory that records how the download ended. */
    private class MemorySink : DownloadSink {
        val chunks = mutableListOf<ByteArray>()
        val firstWrite = CompletableDeferred<Unit>()
        val committed = CompletableDeferred<Unit>()
        val discarded = CompletableDeferred<Unit>()
        override suspend fun write(bytes: ByteArray, offset: Int, length: Int) {
            chunks += bytes.copyOfRange(offset, offset + length)
            firstWrite.complete(Unit)
        }
        override suspend fun commit(): SavedDownload {
            committed.complete(Unit)
            return SavedDownload(location = "memory", mimeType = "application/octet-stream")
        }
        override suspend fun discard() {
            discarded.complete(Unit)
        }
    }

    @Test
    fun `attachment download survives a failed attempt and a restored retry`() = runTest {
        val body = byteArrayOf(0x50, 0x4b, 0, 0xff.toByte())
        val preferences = MemoryPreferences()
        val sink = MemorySink()
        val paths = mutableListOf<String>()
        val client = HttpClient(MockEngine { request ->
            paths += request.url.encodedPath
            if (paths.size == 1) respond("unavailable", HttpStatusCode.ServiceUnavailable)
            else respond(body, HttpStatusCode.OK, headersOf(
                HttpHeaders.ContentType to listOf("application/zip"),
                HttpHeaders.ContentDisposition to listOf("attachment; filename*=UTF-8''archive.zip"),
            ))
        }) { installRiffetClient() }
        val api = RiffetApi(client, "http://127.0.0.1:9")
        val center = DownloadCenter(preferences, openSink = { _, _ -> sink })
        // Failure feedback is emitted after persistence, unlike the earlier StateFlow update.
        val failure = async(start = CoroutineStart.UNDISPATCHED) { center.events.first { it.item.state == DownloadState.FAILED } }
        center.startAttachment(api, "archive-id", "archive.zip")
        withContext(Dispatchers.Default) {
            withTimeout(5_000) { failure.await() }
            val restored = DownloadCenter(preferences, openSink = { _, _ -> sink })
            assertEquals("archive-id", restored.items.value.single().attachmentId)
            restored.retry(api, restored.items.value.single())
            val row = withTimeout(5_000) { restored.items.first { it.single().state == DownloadState.SAVED }.single() }
            assertEquals("archive.zip", row.name)
            assertEquals(body.size.toLong(), row.received)
            assertEquals(listOf("/api/attachments/archive-id", "/api/attachments/archive-id"), paths)
            assertEquals(body.toList(), sink.chunks.flatMap { it.toList() })
        }
        client.close()
    }

    @Test
    fun `a finished download is streamed into its sink and committed`() = runTest {
        val body = ByteArray(40 * 1024) { (it % 251).toByte() }
        val sink = MemorySink()
        val api = RiffetApi(HttpClient(MockEngine { respond(body, HttpStatusCode.OK) }) { installRiffetClient() }, "http://127.0.0.1:9")
        val center = DownloadCenter(null, openSink = { _, _ -> sink })
        center.start(api, "p", "blob.bin")
        val row = withContext(Dispatchers.Default) {
            withTimeout(5_000) { center.items.first { it.single().state != DownloadState.RUNNING }.single() }
        }
        assertEquals(DownloadState.SAVED, row.state)
        assertEquals(body.size.toLong(), row.received)
        assertEquals("memory", row.location)
        kotlin.test.assertTrue(sink.committed.isCompleted)
        kotlin.test.assertFalse(sink.discarded.isCompleted)
        kotlin.test.assertTrue(body.contentEquals(sink.chunks.fold(ByteArray(0)) { all, chunk -> all + chunk }))
    }

    @Test
    fun `a download cancelled mid-body discards what it wrote`() = runTest {
        val channel = ByteChannel()
        val sink = MemorySink()
        val api = RiffetApi(
            HttpClient(MockEngine { respond(channel, HttpStatusCode.OK, headersOf(HttpHeaders.ContentLength, "100000")) }) { installRiffetClient() },
            "http://127.0.0.1:9",
        )
        val center = DownloadCenter(null, openSink = { _, _ -> sink })
        center.start(api, "p", "blob.bin")
        withContext(Dispatchers.Default) {
            withTimeout(5_000) {
                channel.writeFully(ByteArray(1024))
                channel.flush()
                sink.firstWrite.await()
                center.cancel(center.items.value.single().id)
                sink.discarded.await()
                assertEquals(DownloadState.CANCELLED, center.items.first { it.single().state != DownloadState.RUNNING }.single().state)
            }
        }
        kotlin.test.assertFalse(sink.committed.isCompleted)
        channel.cancel(null)
    }

    @Test
    fun `a failed or unverified deletion keeps its durable file handle`() = runTest {
        for (failure in listOf(null, IllegalStateException("unlink was not confirmed"))) {
            val saved = item("a", DownloadState.SAVED).copy(
                location = "Downloads/Riffet/a.txt",
                uri = "content://media/external/downloads/123",
            )
            val preferences = stored(saved)
            val center = DownloadCenter(preferences, deleteSaved = {
                if (failure != null) throw failure
                false
            })
            center.deleteFile(saved)
            withContext(Dispatchers.Default) {
                withTimeout(5_000) {
                    val row = center.items.first { it.single().error != null }.single()
                    assertEquals(saved, row.copy(error = null))
                    if (failure != null) assertEquals(failure.message, row.error)
                    // The file handle must survive process restart after either kind of failure.
                    while (DownloadCenter(preferences).items.value.single().error == null) delay(10)
                    assertEquals(row, DownloadCenter(preferences).items.value.single())
                }
            }
        }
    }

    @Test
    fun `cancelling file access preserves the download and allows a later authorized deletion`() = runTest {
        val saved = item("a", DownloadState.SAVED).copy(
            location = "下载/Riffet/a.txt",
            uri = "content://media/external/downloads/123",
            error = "previous deletion failed",
        )
        val preferences = stored(saved)
        var attempts = 0
        val center = DownloadCenter(preferences, deleteSaved = {
            if (++attempts == 1) throw CancellationException("file access cancelled")
            true
        })
        center.deleteFile(saved)
        withContext(Dispatchers.Default) {
            withTimeout(5_000) {
                val retained = center.items.first { it.single().error == null }.single()
                assertEquals(saved.copy(error = null), retained)
                while (DownloadCenter(preferences).items.value.single().error != null) delay(10)
                assertEquals(retained, DownloadCenter(preferences).items.value.single())
                // Wait for the cancelled attempt's reservation to be released before retrying.
                while (center.items.value.isNotEmpty()) {
                    center.deleteFile(retained)
                    delay(10)
                }
                assertEquals(2, attempts)
            }
        }
    }
}
