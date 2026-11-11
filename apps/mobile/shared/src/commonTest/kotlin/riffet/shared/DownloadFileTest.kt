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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * `downloadFile`'s streaming path: the bytes it hands to the writer and the progress it reports.
 *
 * This is the loop every download goes through and the reason it can show a percentage at all — it
 * reads the body in chunks instead of `bodyAsBytes`. The callback's exact sequence depends on how
 * the engine chunks the body, so the assertions are on the contract: bytes intact, name and type
 * from the headers, and a monotonically growing count that starts at zero and ends at the total.
 */
class DownloadFileTest {
    @Test
    fun `downloads a binary attachment with its server filename and byte progress`() = runTest {
        val body = byteArrayOf(0x50, 0x4b, 0, 0xff.toByte())
        var path: String? = null
        val engine = MockEngine { request ->
            path = request.url.encodedPath
            respond(body, HttpStatusCode.OK, headersOf(
                HttpHeaders.ContentType to listOf("application/zip"),
                HttpHeaders.ContentLength to listOf(body.size.toString()),
                HttpHeaders.ContentDisposition to listOf("attachment; filename*=UTF-8''archive.zip"),
            ))
        }
        val written = Collected()
        val progress = mutableListOf<Pair<Long, Long?>>()
        val file = api(engine).downloadAttachment("archive-id", "附件", { received, total -> progress += received to total }, written::open)
        assertEquals("/api/attachments/archive-id", path)
        assertEquals("archive.zip", file.name)
        assertEquals("archive.zip" to "application/zip", written.opened)
        assertTrue(body.contentEquals(written.bytes))
        assertEquals(body.size.toLong() to body.size.toLong(), progress.last())
    }


    /** The same client configuration the app builds, so the test exercises the real stack. */
    private fun api(engine: MockEngine) = RiffetApi(HttpClient(engine) { installRiffetClient() }, "http://127.0.0.1:9")

    /** Collects what the download writes, with the name and type it was opened under. */
    private class Collected {
        var opened: Pair<String, String?>? = null
        private val chunks = mutableListOf<ByteArray>()
        val bytes: ByteArray get() = chunks.fold(ByteArray(0)) { all, chunk -> all + chunk }
        fun open(name: String, mimeType: String?): DownloadWriter {
            opened = name to mimeType
            return DownloadWriter { bytes, offset, length -> chunks += bytes.copyOfRange(offset, offset + length) }
        }
    }

    @Test
    fun `reports progress while it assembles the body`() = runTest {
        val body = ByteArray(64 * 1024) { (it % 251).toByte() }
        var path: String? = null
        val engine = MockEngine { request ->
            path = request.url.encodedPath + "?" + request.url.encodedQuery
            respond(
                content = body,
                status = HttpStatusCode.OK,
                headers = headersOf(
                    HttpHeaders.ContentLength to listOf(body.size.toString()),
                    HttpHeaders.ContentType to listOf("text/plain; charset=utf-8"),
                    HttpHeaders.ContentDisposition to listOf("attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A.txt"),
                ),
            )
        }

        val progress = mutableListOf<Pair<Long, Long?>>()
        val written = Collected()
        val file = api(engine).downloadFile("project-1", "docs/report.txt", onProgress = { received, total ->
            progress += received to total
        }, open = written::open)

        assertEquals("报告.txt", file.name, "the name comes from the Content-Disposition, not the path")
        assertEquals("text/plain", file.mimeType)
        assertEquals("报告.txt" to "text/plain", written.opened, "the destination is opened under the same name and type")
        assertEquals(body.size.toLong(), file.size)
        assertTrue(body.contentEquals(written.bytes), "the body must survive the chunked read")

        assertTrue(progress.isNotEmpty(), "a download the reader can watch has to report")
        assertEquals(0L, progress.first().first, "the first report is zero bytes")
        assertEquals(body.size.toLong(), progress.last().first)
        assertTrue(progress.all { it.second == body.size.toLong() }, "the declared length is passed through")
        assertEquals(progress.map { it.first }.sorted(), progress.map { it.first }, "bytes only ever grow")
        assertTrue(path!!.contains("download=1"), "the download flag reaches the server: $path")
    }

    @Test
    fun `progress arrives while the body is still on the wire`() = runTest {
        // The server sends half and holds the rest until the app reports that half. A client that
        // buffers the whole body before reading it never reports, and the download never ends.
        val body = ByteArray(32 * 1024) { (it % 251).toByte() }
        val half = body.size / 2
        val channel = ByteChannel()
        val halfReported = CompletableDeferred<Unit>()
        val engine = MockEngine {
            respond(
                content = channel,
                status = HttpStatusCode.OK,
                headers = headersOf(HttpHeaders.ContentLength to listOf(body.size.toString())),
            )
        }
        backgroundScope.launch {
            channel.writeFully(body, 0, half)
            channel.flush()
            halfReported.await()
            channel.writeFully(body, half, body.size)
            channel.flushAndClose()
        }

        // The engine works on real threads, so the deadline has to be real time, not the test's clock.
        val written = Collected()
        withContext(Dispatchers.Default.limitedParallelism(1)) {
            withTimeout(10_000) {
                api(engine).downloadFile("project-1", "blob.bin", onProgress = { received, total ->
                    if (received in half until body.size && total == body.size.toLong()) halfReported.complete(Unit)
                }, open = written::open)
            }
        }

        assertTrue(halfReported.isCompleted)
        assertTrue(body.contentEquals(written.bytes))
    }

}
