package riffet.shared

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.headersOf
import io.ktor.utils.io.ByteChannel
import io.ktor.utils.io.writeStringUtf8
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.yield
import riffet.contracts.ShareDraftRequest
import riffet.contracts.ShareDraftProgress
import riffet.contracts.ShareSelection
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertTrue

class RiffetApiSharesTest {
    private val draft = """{"id":"d1","sessionId":"a/b","capturedAt":"2026-10-29T00:00:00Z","previewUrl":"/api/shares/drafts/d1/files/index.html","warnings":[],"bytes":20}"""
    private val headers = headersOf(HttpHeaders.ContentType, "application/x-ndjson")

    @Test
    fun fragmentedLinesHeartbeatsAndFinalLineKeepTheirContract() = runTest {
        for (kind in listOf("draft", "print")) {
            assertDraftStreamContract(kind)
        }
    }

    private suspend fun assertDraftStreamContract(kind: String) = coroutineScope {
        val body = ByteChannel(autoFlush = true)
        val seen = mutableListOf<String>()
        val client = HttpClient(MockEngine { request ->
            assertEquals("Bearer device-secret", request.headers[HttpHeaders.Authorization])
            assertEquals("application/x-ndjson", request.headers[HttpHeaders.Accept])
            assertEquals("/api/sessions/a%2Fb/share/$kind", request.url.encodedPath)
            respond(body, headers = headers)
        }) { installRiffetClient() }
        val result = async {
            val api = RiffetApi(client, "http://localhost", { "device-secret" })
            val request = ShareDraftRequest(ShareSelection("all"))
            val progress: (ShareDraftProgress) -> Unit = { seen += it.stage }
            if (kind == "print") api.sharePrintDraft("a/b", request, progress) else api.shareDraft("a/b", request, progress)
        }
        launch {
            body.writeStringUtf8("\n{\"type\":\"prog")
            yield()
            body.writeStringUtf8("ress\",\"progress\":{\"stage\":\"history\"}}\r\n\n{\"type\":\"heartbeat\"}\n")
            yield()
            body.writeStringUtf8("{\"type\":\"ready\",\"draft\":$draft}")
            body.close()
        }
        assertEquals("d1", result.await().id)
        assertEquals(listOf("history"), seen)
        client.close()
    }

    @Test
    fun eofAndErrorDoNotReturnDraft() = runTest {
        val eofClient = HttpClient(MockEngine { respond("\n", headers = headers) }) { installRiffetClient() }
        assertFailsWith<RiffetNetworkException> {
            RiffetApi(eofClient, "http://localhost").shareDraft("s", ShareDraftRequest())
        }
        eofClient.close()

        val errors = listOf(
            Triple("""{"type":"error","message":"History unavailable"}""", "SHARE_DRAFT_FAILED", emptyMap()),
            Triple(
                """{"type":"error","message":"Switch to the publishing account","messageRef":{"code":"SHARE_ACCOUNT_CHANGED","params":{"username":"alice","attempt":3}}}""",
                "SHARE_ACCOUNT_CHANGED",
                mapOf("username" to "alice", "attempt" to "3"),
            ),
        )
        for ((payload, code, params) in errors) {
            val client = HttpClient(MockEngine { respond(payload, headers = headers) }) { installRiffetClient() }
            val error = assertFailsWith<RiffetException> { RiffetApi(client, "http://localhost").shareDraft("s", ShareDraftRequest()) }
            assertIs<RiffetHttpException>(error)
            assertEquals(code, error.code)
            assertEquals(params, error.params)
            client.close()
        }
    }

    @Test
    fun jsonFallbackStillDecodes() = runTest {
        val client = HttpClient(MockEngine { respond(draft, headers = headersOf(HttpHeaders.ContentType, "application/json")) }) { installRiffetClient() }
        assertEquals("d1", RiffetApi(client, "http://localhost").shareDraft("s", ShareDraftRequest()).id)
        client.close()
    }

    @Test
    fun cancellingDraftClosesResponseAndPropagatesCancellation() = runTest {
        val body = ByteChannel(autoFlush = true)
        val started = CompletableDeferred<Unit>()
        val client = HttpClient(MockEngine { respond(body, headers = headers) }) { installRiffetClient() }
        val result = async {
            RiffetApi(client, "http://localhost").shareDraft("s", ShareDraftRequest()) { started.complete(Unit) }
        }
        body.writeStringUtf8("""{"type":"progress","progress":{"stage":"history"}}""" + "\n")
        started.await()
        result.cancel()
        assertFailsWith<CancellationException> { result.await() }
        assertTrue(body.isClosedForRead)
        client.close()
    }
}
