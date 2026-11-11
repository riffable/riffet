package riffet.ui.state

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.encodeToString
import riffet.contracts.*
import riffet.shared.*
import kotlin.coroutines.EmptyCoroutineContext
import kotlin.test.*

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class QueuedDraftRecoveryTest {
    private val headers = headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString())
    private val queued = Run("run-one", "session-one", "command-one", "fallback", RunState.QUEUED,
        native = NativeRunDetails(
            input = NativeRunInput("original queued text", listOf("attachment-one", "attachment-two"), listOf(NativeRunContextReference("src/login.swift", 17))),
            config = NativeRunConfig(mode = "agent"), fingerprint = "original", delivery = NativeDeliveryState.QUEUED, attempt = 1, configRevision = 0),
        createdAt = "2026-10-15T08:00:00Z", updatedAt = "2026-10-15T08:00:00Z")
    private val session = Session("session-one", "project-one", SessionKind.NATIVE, "Task", tags = emptyList(), state = SessionState.RUNNING,
        mode = "agent", createdAt = "2026-10-15T08:00:00Z", updatedAt = "2026-10-15T08:00:00Z")

    @Test fun metadataFailureNeverCancelsTheAcceptedQueueEntry() = runTest {
        val requests = mutableListOf<String>()
        val http = HttpClient(MockEngine { request ->
            requests += request.url.encodedPath
            if (request.url.encodedPath.contains("attachment-two")) respond("""{"error":{"code":"READ_FAILED","message":"offline"}}""", HttpStatusCode.ServiceUnavailable, headers)
            else respond("""{"id":"attachment-one","name":"one.png","mimeType":"image/png","size":10,"path":"one.png"}""", headers = headers)
        }) { installRiffetClient() }
        val store = SessionStore(RiffetApi(http, "http://mac:8080"), CoroutineScope(UnconfinedTestDispatcher(testScheduler)),
            background = EmptyCoroutineContext)
        try {
            store.select(session)
            assertFailsWith<RiffetHttpException> { store.takeBackQueued(queued) }
            // Opening the conversation also dials its sync stream; only the draft's requests count here.
            assertEquals(listOf("/api/attachments/attachment-one/metadata", "/api/attachments/attachment-two/metadata"), requests.filter { it.startsWith("/api/attachments/") || it.endsWith("/cancel") })
            assertFalse(requests.any { it.endsWith("/cancel") })
        } finally { store.clear(); http.close() }
    }

    @Test fun resolvesAllAttachmentsBeforeCancellingAndPreservesContext() = runTest {
        val requests = mutableListOf<String>()
        val http = HttpClient(MockEngine { request ->
            val path = request.url.encodedPath; requests += path
            val json = if (path.endsWith("/cancel")) RiffetJson.instance.encodeToString(queued.copy(state = RunState.CANCELLED))
            else {
                val id = if (path.contains("attachment-one")) "attachment-one" else "attachment-two"
                """{"id":"$id","name":"$id.png","mimeType":"image/png","size":10,"path":"$id.png"}"""
            }
            respond(json, headers = headers)
        }) { installRiffetClient() }
        val store = SessionStore(RiffetApi(http, "http://mac:8080"), CoroutineScope(UnconfinedTestDispatcher(testScheduler)),
            background = EmptyCoroutineContext)
        try {
            store.select(session)
            val restored = assertNotNull(store.takeBackQueued(queued))
            assertEquals("original queued text", restored.text)
            assertEquals(listOf("attachment-one", "attachment-two"), restored.attachments.map { it.id })
            assertEquals(listOf(PromptContextReference("src/login.swift", 17)), restored.context)
            assertEquals(listOf("/api/attachments/attachment-one/metadata", "/api/attachments/attachment-two/metadata", "/api/sessions/session-one/native/runs/run-one/cancel"), requests.filter { it.startsWith("/api/attachments/") || it.endsWith("/cancel") })
        } finally { store.clear(); http.close() }
    }

    @Test fun aSendStillSubmittingWaitsInTheDockOnlyWhileWorkingAndCannotBeActedOn() = runTest {
        val submitting = queued.copy(id = "command-two", commandId = "command-two",
            native = queued.native!!.copy(fingerprint = "client-pending", stage = HTTP_PENDING))
        val busy = StoreState(sessionId = "session-one", status = NativeStatus(NativeStatusPhase.BUSY))
            .withDeliveries(mapOf("command-two" to Delivery(submitting)))
        assertEquals(listOf(submitting), busy.queued)
        // The session going idle moves it to the transcript without any delivery changing.
        assertEquals(emptyList(), busy.copy(status = NativeStatus(NativeStatusPhase.IDLE)).queued)

        val requests = mutableListOf<String>()
        val http = HttpClient(MockEngine { request ->
            requests += request.url.encodedPath
            respond("""{"error":{"code":"RUN_NOT_FOUND","message":"no run"}}""", HttpStatusCode.NotFound, headers)
        }) { installRiffetClient() }
        val store = SessionStore(RiffetApi(http, "http://mac:8080"), CoroutineScope(UnconfinedTestDispatcher(testScheduler)),
            background = EmptyCoroutineContext)
        try {
            store.select(session)
            // The server has no run by this id yet: nothing is read, cancelled or sent for it.
            assertNull(store.takeBackQueued(submitting))
            assertFalse(store.cancelRun(submitting))
            assertFalse(store.sendQueuedNow(submitting))
            assertEquals(emptyList(), requests.filter { it.startsWith("/api/attachments/") || it.contains("/native/runs/") })
        } finally { store.clear(); http.close() }
    }
}
