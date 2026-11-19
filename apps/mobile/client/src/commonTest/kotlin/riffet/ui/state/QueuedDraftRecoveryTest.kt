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

    @Test
    fun aControlSnapshotQueuesOnlyInboxEntriesPlacedThere() {
        val submitting = queued.copy(
            id = "command-two", commandId = "command-two", prompt = "next",
            native = queued.native!!.copy(fingerprint = "client-pending", stage = HTTP_PENDING),
            createdAt = "2026-10-15T08:00:01Z",
        )
        val sending = snapshot(placement = "sending", id = "command-first", commandId = "command-first")
        val first = submitting.copy(id = "command-first", commandId = "command-first", prompt = "hello")
        val direct = StoreState(sessionId = "session-one", status = NativeStatus(NativeStatusPhase.BUSY), control = sending)
            .withDeliveries(mapOf(first.key() to Delivery(first)))
        // A brand-new session's first message is `sending`. A busy status must not put it in the dock.
        assertEquals(emptyList(), direct.queued)
        assertEquals(false, direct.canStop)
        assertEquals(emptyList(), direct.actionsForQueued("command-first", "command-first"))
        assertNull(StoreState().actionsForQueued("command-first", "command-first"))
        assertNull(StoreState().canStop)

        val queuedSnapshot = snapshot(
            placement = "queued", id = queued.id, commandId = queued.commandId,
            actions = listOf("send_now", "steer", "edit", "cancel"), active = true,
        )
        val dock = StoreState(sessionId = "session-one", status = NativeStatus(NativeStatusPhase.BUSY), control = queuedSnapshot)
            .withDeliveries(mapOf(queued.key() to Delivery(queued), submitting.key() to Delivery(submitting)))
        assertEquals(listOf(queued.id, submitting.id), dock.queued.map { it.id })
        assertEquals(listOf("send_now", "steer", "edit", "cancel"), dock.actionsForQueued(queued.id, queued.commandId))
        assertEquals(emptyList(), dock.actionsForQueued(submitting.id, submitting.commandId))
        assertEquals(true, dock.canStop)
        assertEquals(true, dock.canSteer)
        assertTrue(allowsQueuedAction(queuedSnapshot, queued.id, queued.commandId, "send_now"))

        val both = direct.withDeliveries(mapOf(first.key() to Delivery(first), submitting.key() to Delivery(submitting)))
        val held = sending.copy(held = NativeQueueHold(NativeQueueHoldReason.WORKSPACE))
        // The inbox already names the first message, so only the unclaimed copy still submitting stays.
        assertEquals(listOf(submitting.id), both.copy(control = held).queued.map { it.id })
        val claimed = sending.copy(activeTurn = ActiveTurnState(phase = "running", canStop = true, canSteer = true))
        assertEquals(listOf(submitting.id), both.copy(control = claimed).queued.map { it.id })

        val unseen = snapshot(placement = "queued", id = "run-x", commandId = "cmd-x", actions = listOf("cancel"))
        val synthetic = StoreState(sessionId = "session-one", control = unseen).queued.single()
        assertEquals("run-x", synthetic.id)
        assertEquals("control-inbox", synthetic.native?.fingerprint)
    }

    private fun entry(id: String, commandId: String, placement: String, actions: List<String> = emptyList()) = InboxEntry(
        id = id, commandId = commandId, kind = "message", placement = placement, status = placement,
        prompt = NativeRunInput("hello", emptyList(), emptyList()),
        createdAt = "2026-10-15T08:00:00Z", updatedAt = "2026-10-15T08:00:00Z", actions = actions,
    )

    private fun snapshot(
        placement: String,
        id: String,
        commandId: String,
        actions: List<String> = emptyList(),
        active: Boolean = false,
    ) = SessionControlSnapshot(
        revision = 1,
        runtime = "ready",
        activeTurn = if (active) ActiveTurnState(phase = "running", canStop = true, canSteer = true) else null,
        inbox = listOf(entry(id, commandId, placement, actions)),
        capabilities = SessionControlCapabilities(canStop = active, canSteer = active, canSendNow = "send_now" in actions),
        activity = NativeActivitySummary(),
    )
}
