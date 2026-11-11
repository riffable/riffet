package riffet.ui.state

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.*
import io.ktor.http.content.TextContent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import riffet.cache.InMemoryLocalFiles
import riffet.cache.LocalFiles
import riffet.contracts.*
import riffet.shared.*
import riffet.ui.composer.NativeSessionCreationOutbox
import kotlin.coroutines.EmptyCoroutineContext
import kotlin.test.*

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class NativeSessionCreationRecoveryTest {
    private val server = "http://mac:8080"
    private val headers = headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString())

    @Test fun projectlessCreationRestoresFrozenTargetAndAppliesWorkspaceBeforeItsSession() = runTest {
        val files = InMemoryLocalFiles()
        val outbox = NativeSessionCreationOutbox(files, server)
        val seen = mutableListOf<NativeSessionCreateInput>()
        val workspace = Project("managed-task", "整理资料", "/tmp/tasks/2026-11-03/task-one", createdAt = "2026-11-03T00:00:00Z", updatedAt = "2026-11-03T00:00:00Z", system = "task-workspace")
        var loseResponse = true
        val http = HttpClient(MockEngine { request ->
            val raw = (request.body as TextContent).text
            assertFalse(raw.contains("\"projectId\""))
            val body = RiffetJson.instance.decodeFromString<NativeSessionCreateInput>(raw)
            assertEquals(true, body.projectless)
            seen += body
            val initial = requireNotNull(body.initialMessage)
            val receipt = NativeSessionCreateResult(
                Session(body.clientSessionId, workspace.id, SessionKind.NATIVE, "整理资料", tags = emptyList(), state = SessionState.IDLE,
                    backendId = body.backendId, model = body.model, mode = body.mode ?: "agent", createdAt = workspace.createdAt, updatedAt = workspace.updatedAt),
                Run("first-run", body.clientSessionId, initial.commandId, initial.text, RunState.COMPLETED,
                    createdAt = workspace.createdAt, updatedAt = workspace.updatedAt), workspace)
            if (loseResponse) { loseResponse = false; respond("", HttpStatusCode.ServiceUnavailable, headers) }
            else respond(RiffetJson.instance.encodeToString(receipt), headers = headers)
        }) { installRiffetClient() }
        fun newStore() = SessionStore(RiffetApi(http, server), CoroutineScope(UnconfinedTestDispatcher(testScheduler)), background = EmptyCoroutineContext, creationOutbox = outbox)
        val first = newStore()
        val prepared = first.prepareCreation(null, "整理资料", emptyList(), NativeBackendId.CODEX, "work", "gpt:effort=high", "agent", "ask")
        assertFailsWith<RiffetHttpException> { first.createPreparedSession(prepared) }
        first.clear()
        val restored = newStore()
        try {
            val pending = restored.pendingCreations().single()
            val session = restored.createPreparedSession(pending)
            assertEquals(workspace, restored.list.value.projects.single())
            assertEquals(workspace.id, session.projectId)
            assertEquals(listOf(prepared.body, prepared.body), seen)
            assertNotNull(restored.pendingCreation(prepared.id))
            restored.acknowledgePreparedCreation(prepared.id)
            assertTrue(restored.pendingCreations().isEmpty())
        } finally { restored.clear(); http.close() }
    }

    @Test fun acceptedCreationWithLostResponseSurvivesColdRestartAndReusesItsEntireBody() = runTest {
        val files = InMemoryLocalFiles()
        val seen = mutableListOf<NativeSessionCreateInput>()
        val receipts = mutableMapOf<String, NativeSessionCreateResult>()
        var loseResponse = true
        val http = HttpClient(MockEngine { request ->
            if (request.url.encodedPath == "/health") return@MockEngine respond(
                """{"ok":true,"protocol":{"version":3,"features":["session-references-v1"]}}""", headers = headers)
            assertEquals(HttpMethod.Post, request.method)
            assertEquals("/api/sessions", request.url.encodedPath)
            val body = RiffetJson.instance.decodeFromString<NativeSessionCreateInput>((request.body as TextContent).text)
            seen += body
            val receipt = receipts.getOrPut(body.clientSessionId) {
                val initial = requireNotNull(body.initialMessage)
                NativeSessionCreateResult(
                    Session(body.clientSessionId, requireNotNull(body.projectId), SessionKind.NATIVE, "Created once", tags = emptyList(), state = SessionState.IDLE,
                        backendId = body.backendId, backendProfileId = body.backendProfileId, model = body.model, mode = body.mode ?: "agent", approval = body.approval,
                        createdAt = "2026-10-15T08:00:00Z", updatedAt = "2026-10-15T08:00:00Z"),
                    Run("run-${initial.commandId}", body.clientSessionId, initial.commandId, initial.text, RunState.COMPLETED,
                        createdAt = "2026-10-15T08:00:00Z", updatedAt = "2026-10-15T08:00:00Z"))
            }
            if (loseResponse) {
                loseResponse = false
                respond("""{"error":{"code":"LOST_RESPONSE","message":"accepted but reply lost"}}""", HttpStatusCode.ServiceUnavailable, headers)
            } else respond(RiffetJson.instance.encodeToString(receipt), headers = headers)
        }) { installRiffetClient() }
        fun newStore() = SessionStore(RiffetApi(http, server), CoroutineScope(UnconfinedTestDispatcher(testScheduler)),
            background = EmptyCoroutineContext, creationOutbox = NativeSessionCreationOutbox(files, server))
        val first = newStore()
        try {
            val attachment = Attachment("image-one", "one.png", "image/png", 1024, "one.png")
            val prepared = first.prepareCreation("project-one", "  first line\nkeep second line  ", listOf(attachment), NativeBackendId.CODEX,
                "work-profile", "model-one", "agent", "ask", listOf(PromptContextReference("src/login.swift", 17),
                    PromptContextReference(kind = "session", sessionId = "source-session", fromRunId = "saved-run", title = "Design")))
            assertNotNull(first.pendingCreation(prepared.id))
            assertFailsWith<RiffetHttpException> { first.createPreparedSession(prepared) }
            first.clear()

            val restoredStore = newStore()
            try {
                val restored = assertNotNull(restoredStore.pendingCreation(prepared.id))
                assertEquals(prepared, restored)
                val created = restoredStore.createPreparedSession(restored)
                assertEquals(prepared.id, created.id)
                assertEquals(1, receipts.size, "the server must have accepted one client session, not two")
                assertEquals(2, seen.size)
                assertEquals(seen[0], seen[1], "model, context and attachments must be frozen along with the IDs")
                assertEquals("  first line\nkeep second line  ", seen.last().initialMessage?.text)
                assertEquals(listOf(AttachmentRef("image-one")), seen.last().initialMessage?.attachments)
                assertEquals(listOf(PromptContextReference("src/login.swift", 17)), seen.last().initialMessage?.context)
                assertEquals(listOf(SessionReferenceInput(kind = "session", sessionId = "source-session", fromRunId = "saved-run")), seen.last().initialMessage?.references)
                assertNotNull(restoredStore.pendingCreation(prepared.id), "a receipt alone must not close the draft-cleanup crash window")
                restoredStore.acknowledgePreparedCreation(prepared.id)
                assertNull(restoredStore.pendingCreation(prepared.id))
                assertEquals(listOf(created), restoredStore.list.value.sessions)
            } finally { restoredStore.clear() }
        } finally { first.clear(); http.close() }
    }

    @Test fun successfulReceiptWithoutDraftAcknowledgementSurvivesRestartAndCannotCreateASecondTask() = runTest {
        val files = InMemoryLocalFiles()
        val seen = mutableListOf<NativeSessionCreateInput>()
        val accepted = mutableMapOf<String, NativeSessionCreateResult>()
        val http = HttpClient(MockEngine { request ->
            val body = RiffetJson.instance.decodeFromString<NativeSessionCreateInput>((request.body as TextContent).text)
            seen += body
            val receipt = accepted.getOrPut(body.clientSessionId) {
                val initial = requireNotNull(body.initialMessage)
                NativeSessionCreateResult(
                    Session(body.clientSessionId, requireNotNull(body.projectId), SessionKind.NATIVE, "Accepted task", tags = emptyList(), state = SessionState.IDLE,
                        mode = "agent", createdAt = "2026-10-15T08:00:00Z", updatedAt = "2026-10-15T08:00:00Z"),
                    Run("run-${initial.commandId}", body.clientSessionId, initial.commandId, initial.text, RunState.COMPLETED,
                        createdAt = "2026-10-15T08:00:00Z", updatedAt = "2026-10-15T08:00:00Z"))
            }
            respond(RiffetJson.instance.encodeToString(receipt), headers = headers)
        }) { installRiffetClient() }
        fun newStore() = SessionStore(RiffetApi(http, server), CoroutineScope(UnconfinedTestDispatcher(testScheduler)),
            background = EmptyCoroutineContext, creationOutbox = NativeSessionCreationOutbox(files, server))
        val first = newStore()
        try {
            val original = first.prepareCreation("project-one", "the original task", emptyList(), NativeBackendId.CODEX,
                null, null, "agent", null)
            val firstResult = first.createPreparedSession(original)
            // Model a process kill after the success response, before Swift clears its draft.
            first.clear()
            val restarted = newStore()
            try {
                val recovered = assertNotNull(restarted.pendingCreation(original.id))
                val retried = restarted.createPreparedSession(recovered)
                assertEquals(firstResult.id, retried.id)
                assertEquals(1, accepted.size)
                assertEquals(listOf(original.body, original.body), seen)
                assertNotNull(restarted.pendingCreation(original.id))
                // Only the explicit post-draft-cleanup acknowledgement may remove the journal.
                restarted.acknowledgePreparedCreation(original.id)
                assertNull(newStore().pendingCreation(original.id))
            } finally { restarted.clear() }
        } finally { first.clear(); http.close() }
    }

    @Test fun acknowledgementFailureLeavesTheOriginalRequestAvailable() = runTest {
        val backing = InMemoryLocalFiles()
        val files = object : LocalFiles by backing { override fun delete(path: String) = Unit }
        val outbox = NativeSessionCreationOutbox(files, server)
        val pending = outbox.persist(NativeSessionCreateInput("saved-session", "project-one", initialMessage = NativeMessageInput("saved-command", "original")))
        val http = HttpClient(MockEngine { error("acknowledgement is a local operation") })
        val store = SessionStore(RiffetApi(http, server), CoroutineScope(UnconfinedTestDispatcher(testScheduler)),
            background = EmptyCoroutineContext, creationOutbox = outbox)
        try {
            assertFailsWith<IllegalStateException> { store.acknowledgePreparedCreation(pending.id) }
            assertEquals(pending, store.pendingCreation(pending.id))
        } finally { store.clear(); http.close() }
    }

    @Test fun rejectsAnotherServerOrAnEditedRetryBeforeSending() = runTest {
        val files = InMemoryLocalFiles()
        var posts = 0
        val http = HttpClient(MockEngine { posts++; error("must not send an altered prepared request") }) { installRiffetClient() }
        val outbox = NativeSessionCreationOutbox(files, server)
        val pending = outbox.persist(NativeSessionCreateInput("same-session", "project-one", initialMessage = NativeMessageInput("same-command", "original")))
        val store = SessionStore(RiffetApi(http, server), CoroutineScope(UnconfinedTestDispatcher(testScheduler)),
            background = EmptyCoroutineContext, creationOutbox = outbox)
        val other = NativeSessionCreationOutbox(files, "http://other:8080")
        try {
            assertNull(other.find(pending.id))
            assertFailsWith<IllegalArgumentException> { other.requirePending(pending) }
            val edited = pending.copy(body = pending.body.copy(initialMessage = NativeMessageInput("same-command", "edited")))
            assertFailsWith<IllegalStateException> { store.createPreparedSession(edited) }
            assertEquals(0, posts)
            assertEquals(pending, store.pendingCreation(pending.id))
            store.discardPreparedCreation(pending.id)
            assertNull(store.pendingCreation(pending.id))
        } finally { store.clear(); http.close() }
    }
}
