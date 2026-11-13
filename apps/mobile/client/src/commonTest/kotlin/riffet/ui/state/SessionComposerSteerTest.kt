package riffet.ui.state

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.*
import io.ktor.http.content.TextContent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.*
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import riffet.contracts.*
import riffet.shared.*
import riffet.ui.composer.*
import kotlin.test.*

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class SessionComposerSteerTest {
    private val stamp = "2026-10-16T00:00:00Z"
    private val target = NativeTurnTarget("original-session", "original-turn")
    private val stopCatalog = """{"backendId":"codex","label":"Codex","available":true,"capabilities":{"backendId":"codex","label":"Codex","interactionTransport":"protocol","supportsResume":true,"supportsInterrupt":true,"supportsHistory":true,"supportsModelSelection":false,"supportsModeSelection":false,"supportsPermissionSelection":false,"supportsTargetedStop":true,"supportsRecovery":true}}"""
    private fun session(id: String = "s") = Session(id = id, projectId = "p", kind = SessionKind.NATIVE, title = "test", tags = emptyList(), state = SessionState.RUNNING, mode = "agent", configRevision = 22, nativeSessionId = "original-session", createdAt = stamp, updatedAt = stamp)
    private fun accepted(id: String, failed: Boolean = false) = Run(id = id, commandId = id, sessionId = "s", prompt = "adjust", state = if (failed) RunState.FAILED else RunState.RUNNING,
        native = NativeRunDetails(input = NativeRunInput("adjust", emptyList(), emptyList()), config = NativeRunConfig(mode = "agent"), fingerprint = "f", delivery = if (failed) NativeDeliveryState.FAILED else NativeDeliveryState.INPUT_SENT, attempt = 1, configRevision = 0, intent = "steer", nativeSessionId = target.nativeSessionId, nativeTurnId = target.turnId), createdAt = stamp, updatedAt = stamp)

    @Test fun `a terminal-bound writer is live only while it has a terminal that is not offline`() {
        val session = session().copy(terminalId = "terminal")
        val starting = NativeStatus(NativeStatusPhase.STARTING, connection = NativeProviderConnection("reconnecting"))
        assertTrue(nativeConversationLive(session, starting, true))
        assertFalse(nativeConversationLive(session.copy(terminalId = null), starting, true))
        assertFalse(nativeConversationLive(session, starting.copy(phase = NativeStatusPhase.OFFLINE), true))
        assertTrue(nativeConversationLive(session.copy(terminalId = null), starting, false))
    }

    @Test fun `stop is pending before its response refuses duplicates and releases on failure`() = runTest {
        val response = CompletableDeferred<Unit>()
        val requested = CompletableDeferred<Unit>()
        var posts = 0
        var fails = true
        val client = HttpClient(MockEngine { request ->
            if (request.method == HttpMethod.Get) return@MockEngine respond(stopCatalog, headers = headersOf(HttpHeaders.ContentType, "application/json"))
            posts++
            requested.complete(Unit)
            response.await()
            if (fails) respond("""{"error":{"code":"STOP_FAILED","message":"cannot stop"}}""", HttpStatusCode.Conflict, headersOf(HttpHeaders.ContentType, "application/json"))
            else respond("{}", HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
        }) { installRiffetClient() }
        try {
            val api = RiffetApi(client, "http://localhost")
            val core = openCore(session(), listOf(accepted("running")))
            val composer = SessionComposer(api, backgroundScope, NativeSendOutbox(InMemoryOutboxStore()), core, MutableStateFlow(SessionListState()), SessionInteractions(api, core))
            val stop = async { composer.interrupt() }
            runCurrent()
            assertTrue(core.value.send.interrupting)
            requested.await()
            assertEquals(SessionState.RUNNING, core.value.selected?.state)
            assertEquals(RunState.RUNNING, core.value.runs.single().state)
            assertFalse(composer.interrupt())
            assertEquals(1, posts)
            response.complete(Unit)
            assertFalse(stop.await())
            assertFalse(core.value.send.interrupting)
            assertNotNull(core.value.send.error)
            fails = false
            assertTrue(composer.interrupt(), "a failed request must not leave the composer locked")
            assertFalse(core.value.send.interrupting)
            assertNull(core.value.send.error)
            assertEquals(2, posts)
        } finally { client.close() }
    }

    @Test fun `stop uses the current terminal epoch instead of the original run epoch`() = runTest {
        val requests = mutableListOf<String>()
        val stoppedSession = session().copy(terminalId = "terminal")
        val historicalRun = accepted("running").copy(native = accepted("running").native!!.copy(
            terminalId = "terminal", terminalEpoch = 1, nativeSessionId = target.nativeSessionId))
        val core = openCore(stoppedSession, listOf(historicalRun))
        core.update { it.copy(status = NativeStatus(NativeStatusPhase.BUSY,
            activeTurn = NativeActiveTurn(target.nativeSessionId, target.turnId))) }
        val client = HttpClient(MockEngine { request ->
            when {
                request.url.encodedPath.endsWith("/catalog") -> respond(stopCatalog, headers = headersOf(HttpHeaders.ContentType, "application/json"))
                request.url.encodedPath == "/api/terminals/terminal" -> respond("""{"id":"terminal","projectId":"p","sessionId":"s","title":"Codex","kind":"native","state":"running","persistent":true,"epoch":9,"cols":80,"rows":24,"createdAt":"2026-10-16T00:00:00Z"}""", headers = headersOf(HttpHeaders.ContentType, "application/json"))
                else -> {
                    requests += (request.body as TextContent).text
                    respond("{}", HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
                }
            }
        }) { installRiffetClient() }
        try {
            val api = RiffetApi(client, "http://localhost")
            val composer = SessionComposer(api, backgroundScope, NativeSendOutbox(InMemoryOutboxStore()), core,
                MutableStateFlow(SessionListState()), SessionInteractions(api, core))
            assertTrue(composer.interrupt())
            val stop = RiffetJson.instance.parseToJsonElement(requests.single()).jsonObject
            assertEquals(9L, stop.getValue("terminalEpoch").jsonPrimitive.long)
            assertEquals(target.turnId, stop.getValue("turnId").jsonPrimitive.content)
        } finally { client.close() }
    }

    @Test fun `a stop response from a previous conversation cannot clear the new stop or show its error`() = runTest {
        val firstResponse = CompletableDeferred<Unit>()
        val secondResponse = CompletableDeferred<Unit>()
        val client = HttpClient(MockEngine { request ->
            if (request.method == HttpMethod.Get) return@MockEngine respond(stopCatalog, headers = headersOf(HttpHeaders.ContentType, "application/json"))
            if (request.url.encodedPath.contains("/sessions/s/")) {
                firstResponse.await()
                respond("""{"error":{"code":"STOP_FAILED","message":"old stop failed"}}""", HttpStatusCode.Conflict, headersOf(HttpHeaders.ContentType, "application/json"))
            } else {
                secondResponse.await()
                respond("{}", HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
            }
        }) { installRiffetClient() }
        try {
            val api = RiffetApi(client, "http://localhost")
            val core = openCore(session(), emptyList())
            val composer = SessionComposer(api, backgroundScope, NativeSendOutbox(InMemoryOutboxStore()), core, MutableStateFlow(SessionListState()), SessionInteractions(api, core))
            val first = async { composer.interrupt() }
            runCurrent()
            core.update { it.copy(epoch = it.epoch + 1, sessionId = "other", selected = session("other"), send = ComposerSendState()) }
            val second = async { composer.interrupt() }
            runCurrent()
            firstResponse.complete(Unit)
            assertFalse(first.await())
            assertTrue(core.value.send.interrupting)
            assertNull(core.value.send.error)
            secondResponse.complete(Unit)
            assertTrue(second.await())
            assertFalse(core.value.send.interrupting)
            assertNull(core.value.send.error)
        } finally { client.close() }
    }

    @Test fun `checking an unknown submission never resends and exact absence keeps its durable identity`() = runTest {
        var posts = 0
        var checks = 0
        var acceptedNow = false
        val core = openCore(session(), emptyList())
        val outbox = NativeSendOutbox(InMemoryOutboxStore())
        val client = HttpClient(MockEngine { request ->
            if (request.url.encodedPath.endsWith("/catalog")) return@MockEngine respond(stopCatalog, headers = headersOf(HttpHeaders.ContentType, "application/json"))
            val command = outbox.entries("s").firstOrNull()?.body?.commandId ?: core.value.runs.single().commandId
            when {
                request.method == HttpMethod.Get -> {
                    assertEquals(command, request.url.parameters["commandId"])
                    val runs = if (acceptedNow) listOf(accepted(command).copy(native = accepted(command).native!!.copy(delivery = NativeDeliveryState.OBSERVED))) else emptyList()
                    respond(RiffetJson.instance.encodeToString(runs), HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
                }
                request.url.encodedPath.endsWith("/check") -> {
                    checks++
                    val run = accepted(command).copy(native = accepted(command).native!!.copy(delivery = NativeDeliveryState.OBSERVED))
                    respond(RiffetJson.instance.encodeToString(NativeRunRecovery(run, false, emptyList())), HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
                }
                else -> { posts++; error("response lost") }
            }
        }) { installRiffetClient() }
        try {
            val api = RiffetApi(client, "http://localhost")
            val composer = SessionComposer(api, CoroutineScope(UnconfinedTestDispatcher(testScheduler)), outbox, core, MutableStateFlow(SessionListState()), SessionInteractions(api, core))
            assertTrue(composer.send("hello", emptyList(), emptyList(), false), "durably saved content is no longer a sendable draft")
            val original = outbox.entries("s").single()
            val unknown = core.value.runs.single()
            assertNull(composer.checkRun(unknown))
            assertEquals(original, outbox.entries("s").single())
            assertEquals(1, posts)
            assertEquals(0, checks)
            acceptedNow = true
            assertNotNull(composer.checkRun(unknown))
            assertTrue(outbox.entries("s").isEmpty())
            assertEquals(NativeDeliveryState.OBSERVED, core.value.runs.single().native?.delivery)
            assertEquals(1, posts)
            assertEquals(1, checks)
        } finally { client.close() }
    }

    @Test fun `an unconfirmed stop retains its exact target and request across composer reconstruction`() = runTest {
        val requests = mutableListOf<String>()
        val durable = InMemoryOutboxStore()
        val core = openCore(session(), listOf(accepted("running")))
        val client = HttpClient(MockEngine { request ->
            if (request.method == HttpMethod.Get) return@MockEngine respond(stopCatalog, headers = headersOf(HttpHeaders.ContentType, "application/json"))
            requests += (request.body as TextContent).text
            if (requests.size == 1) respond("""{"error":{"code":"NATIVE_STOP_UNCONFIRMED","message":"still stopping"}}""", HttpStatusCode.Conflict, headersOf(HttpHeaders.ContentType, "application/json"))
            else respond("{}", HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
        }) { installRiffetClient() }
        try {
            val api = RiffetApi(client, "http://localhost")
            fun composer() = SessionComposer(api, CoroutineScope(UnconfinedTestDispatcher(testScheduler)), NativeSendOutbox(durable), core, MutableStateFlow(SessionListState()), SessionInteractions(api, core))
            assertFalse(composer().interrupt())
            assertNotNull(NativeSendOutbox(durable).pendingStop("s"))
            assertTrue(NativeSendOutbox(durable).entries("s").isEmpty(), "stop operations are not user messages")
            assertTrue(composer().interrupt())
            assertEquals(requests[0], requests[1])
            assertNull(NativeSendOutbox(durable).pendingStop("s"))
        } finally { client.close() }
    }

    @Test fun `an unconfirmed stop reuses its receipt after the terminal epoch changes`() = runTest {
        val requests = mutableListOf<String>()
        val durable = InMemoryOutboxStore()
        val core = openCore(session().copy(terminalId = "terminal"), listOf(accepted("running")))
        core.update { it.copy(status = NativeStatus(NativeStatusPhase.BUSY,
            activeTurn = NativeActiveTurn(target.nativeSessionId, target.turnId))) }
        var terminalEpoch = 1
        var terminalReads = 0
        val client = HttpClient(MockEngine { request ->
            when {
                request.url.encodedPath.endsWith("/catalog") -> respond(stopCatalog, headers = headersOf(HttpHeaders.ContentType, "application/json"))
                request.url.encodedPath == "/api/terminals/terminal" -> {
                    terminalReads++
                    respond("""{"id":"terminal","projectId":"p","sessionId":"s","title":"Codex","kind":"native","state":"running","persistent":true,"epoch":$terminalEpoch,"cols":80,"rows":24,"createdAt":"2026-10-16T00:00:00Z"}""", headers = headersOf(HttpHeaders.ContentType, "application/json"))
                }
                else -> {
                    requests += (request.body as TextContent).text
                    if (requests.size == 1) respond("""{"error":{"code":"NATIVE_STOP_UNCONFIRMED","message":"still stopping"}}""", HttpStatusCode.Conflict, headersOf(HttpHeaders.ContentType, "application/json"))
                    else respond("{}", HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
                }
            }
        }) { installRiffetClient() }
        try {
            val api = RiffetApi(client, "http://localhost")
            fun composer() = SessionComposer(api, CoroutineScope(UnconfinedTestDispatcher(testScheduler)), NativeSendOutbox(durable), core,
                MutableStateFlow(SessionListState()), SessionInteractions(api, core))
            assertFalse(composer().interrupt())
            terminalEpoch = 9
            assertTrue(composer().interrupt())
            assertEquals(requests[0], requests[1])
            assertEquals(1, terminalReads)
        } finally { client.close() }
    }

    @Test fun `switching sessions during terminal lookup does not send the old stop`() = runTest {
        val terminalRequested = CompletableDeferred<Unit>()
        val terminalResponse = CompletableDeferred<Unit>()
        val core = openCore(session().copy(terminalId = "terminal"), listOf(accepted("running")))
        var posts = 0
        val client = HttpClient(MockEngine { request ->
            when {
                request.url.encodedPath == "/api/terminals/terminal" -> {
                    terminalRequested.complete(Unit)
                    terminalResponse.await()
                    respond("""{"id":"terminal","projectId":"p","sessionId":"s","title":"Codex","kind":"native","state":"running","persistent":true,"epoch":9,"cols":80,"rows":24,"createdAt":"2026-10-16T00:00:00Z"}""", headers = headersOf(HttpHeaders.ContentType, "application/json"))
                }
                request.url.encodedPath.endsWith("/catalog") -> respond(stopCatalog, headers = headersOf(HttpHeaders.ContentType, "application/json"))
                else -> { posts++; respond("{}", HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json")) }
            }
        }) { installRiffetClient() }
        try {
            val api = RiffetApi(client, "http://localhost")
            val outbox = NativeSendOutbox(InMemoryOutboxStore())
            val composer = SessionComposer(api, backgroundScope, outbox, core, MutableStateFlow(SessionListState()), SessionInteractions(api, core))
            val stopping = async { composer.interrupt() }
            terminalRequested.await()
            core.update { it.copy(epoch = it.epoch + 1, sessionId = "other", selected = session("other"), send = ComposerSendState()) }
            terminalResponse.complete(Unit)
            assertFalse(stopping.await())
            assertEquals(0, posts)
            assertNull(outbox.pendingStop("s"))
        } finally {
            terminalResponse.complete(Unit)
            client.close()
        }
    }

    @Test fun `stop and send unconfirmed before acceptance retains the exact replacement and stop identity`() = runTest {
        val requests = mutableListOf<Pair<String, String>>()
        val core = openCore(session(), emptyList())
        val outbox = NativeSendOutbox(InMemoryOutboxStore())
        val client = HttpClient(MockEngine { request ->
            if (request.method == HttpMethod.Get) return@MockEngine respond(stopCatalog, headers = headersOf(HttpHeaders.ContentType, "application/json"))
            requests += request.url.encodedPath to (request.body as TextContent).text
            if (requests.size == 1) respond("""{"error":{"code":"NATIVE_STOP_UNCONFIRMED","message":"still stopping"}}""", HttpStatusCode.Conflict, headersOf(HttpHeaders.ContentType, "application/json"))
            else {
                val command = RiffetJson.instance.parseToJsonElement(requests.last().second).jsonObject.getValue("commandId").jsonPrimitive.content
                val run = accepted(command).copy(native = accepted(command).native!!.copy(intent = null))
                respond(RiffetJson.instance.encodeToString(run), HttpStatusCode.Accepted, headersOf(HttpHeaders.ContentType, "application/json"))
            }
        }) { installRiffetClient() }
        try {
            val api = RiffetApi(client, "http://localhost")
            val composer = SessionComposer(api, CoroutineScope(UnconfinedTestDispatcher(testScheduler)), outbox, core, MutableStateFlow(SessionListState()), SessionInteractions(api, core))
            assertTrue(composer.send("replacement", emptyList(), emptyList(), true))
            val entry = outbox.entries("s").single()
            assertEquals("original-session", assertNotNull(entry.body.stop).nativeSessionId)
            assertEquals(HTTP_UNKNOWN, core.value.runs.single().native?.stage)
            assertFalse(canRestoreUnsentMessage(core.value.runs.single()))
            core.update { it.copy(selected = session().copy(nativeSessionId = "later-session", configRevision = 100)) }
            assertTrue(composer.retryRun(core.value.runs.single()))
            assertEquals(requests[0], requests[1])
            assertTrue(outbox.entries("s").isEmpty())
        } finally { client.close() }
    }

    @Test fun `a delivered provider failure accepts the submission and cannot restore another sendable copy`() = runTest {
        for (mode in listOf("direct", "retry", "stream")) {
            val lostResponse = mode == "retry"
            var posts = 0
            var reads = 0
            val core = openCore(session(), emptyList())
            val outbox = NativeSendOutbox(InMemoryOutboxStore())
            val client = HttpClient(MockEngine { request ->
                if (request.method == HttpMethod.Get) { reads++; error("must not read delivered attachments") }
                posts++
                if (lostResponse && posts == 1) error("response lost")
                val command = RiffetJson.instance.parseToJsonElement((request.body as TextContent).text).jsonObject["commandId"]!!.jsonPrimitive.content
                val failed = accepted(command, failed = true)
                // Server time deliberately predates the local optimistic request; clock skew
                // cannot make a receipt older than a client-only placeholder.
                val delivered = failed.copy(error = "provider capacity exceeded", native = failed.native!!.copy(
                    stage = "provider_failed", nativeMessageId = "receipt", timings = mapOf("providerAcceptedAt" to 1.0),
                    input = NativeRunInput("adjust", listOf("already-sent-file"), emptyList())))
                if (mode == "stream") {
                    core.update { it.upsertRun(delivered) }
                    outbox.reconcile("s", setOf(command))
                    error("POST response lost after stream receipt")
                }
                respond(RiffetJson.instance.encodeToString(delivered), HttpStatusCode.Accepted, headersOf(HttpHeaders.ContentType, "application/json"))
            }) { installRiffetClient() }
            try {
                val api = RiffetApi(client, "http://localhost")
                val composer = SessionComposer(api, CoroutineScope(UnconfinedTestDispatcher(testScheduler)), outbox, core, MutableStateFlow(SessionListState()), SessionInteractions(api, core))
                val submitted = composer.steer("adjust", emptyList(), emptyList(), target)
                if (lostResponse) {
                    assertTrue(submitted, "persisted unknown submission owns the content")
                    assertTrue(composer.retryRun(core.value.runs.single()))
                } else assertTrue(submitted, "delivery was accepted even though execution failed")
                assertTrue(outbox.entries("s").isEmpty())
                assertEquals("provider capacity exceeded", core.value.send.error)
                assertEquals("provider_failed", core.value.runs.single().native?.stage)
                assertNull(composer.takeBackQueued(core.value.runs.single()))
                assertEquals(0, reads, "an already-delivered run is refused before attachment or source-queue side effects")
                assertEquals(if (lostResponse) 2 else 1, posts)
            } finally { client.close() }
        }
    }

    @Test fun `an explicitly rejected unsent steer remains recoverable as a draft`() = runTest {
        val client = HttpClient(MockEngine { request ->
            val command = RiffetJson.instance.parseToJsonElement((request.body as TextContent).text).jsonObject["commandId"]!!.jsonPrimitive.content
            val rejected = accepted(command, failed = true)
            respond(RiffetJson.instance.encodeToString(rejected.copy(error = "target ended before write", native = rejected.native!!.copy(stage = "steer_rejected"))),
                HttpStatusCode.Accepted, headersOf(HttpHeaders.ContentType, "application/json"))
        }) { installRiffetClient() }
        try {
            val api = RiffetApi(client, "http://localhost")
            val core = openCore(session(), emptyList())
            val composer = SessionComposer(api, CoroutineScope(UnconfinedTestDispatcher(testScheduler)), NativeSendOutbox(InMemoryOutboxStore()), core, MutableStateFlow(SessionListState()), SessionInteractions(api, core))
            assertFalse(composer.steer("adjust", emptyList(), emptyList(), target))
            assertEquals("adjust", assertNotNull(composer.takeBackQueued(core.value.runs.single())).text)
        } finally { client.close() }
    }

    @Test fun `unknown steer rejected on exact retry remains durable and recoverable without another POST`() = runTest {
        val posts = mutableListOf<Pair<String, String>>()
        val attachment = Attachment("a", "context.txt", "text/plain", 12, "/a")
        val client = HttpClient(MockEngine { request ->
            if (request.method == HttpMethod.Get) {
                respond(RiffetJson.instance.encodeToString(attachment), HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
            } else {
                posts += request.url.encodedPath to (request.body as TextContent).text
                if (posts.size == 1) error("response lost")
                respond("""{"error":{"code":"STEER_TARGET_CHANGED","message":"original turn ended"}}""", HttpStatusCode.Conflict, headersOf(HttpHeaders.ContentType, "application/json"))
            }
        }) { installRiffetClient() }
        val api = RiffetApi(client, "http://localhost")
        val core = openCore(session(), emptyList())
        val outbox = NativeSendOutbox(InMemoryOutboxStore())
        val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
        val composer = SessionComposer(api, scope, outbox, core, MutableStateFlow(SessionListState()), SessionInteractions(api, core))
        assertTrue(composer.steer("old guidance", listOf(attachment), listOf(PromptContextReference("src/main.kt", 7)), target))
        core.update { it.copy(selected = session().copy(nativeSessionId = "new-session", configRevision = 50)) }
        assertFalse(composer.retryRun(core.value.runs.single()))
        assertEquals(2, posts.size)
        assertEquals(posts[0], posts[1], "retry keeps the exact endpoint, command id, payload and target")
        assertEquals("/api/sessions/s/native/steer", posts[1].first)
        val saved = outbox.entries("s").single()
        assertNotNull(saved.failure)
        assertEquals(target, saved.steerTarget)
        assertEquals("old guidance", saved.body.text)
        val restoredRuns = composer.withLocalOutbox(emptyList())
        assertEquals(RunState.FAILED, restoredRuns.single().state)
        assertEquals(OUTBOX_FAILURE, restoredRuns.single().native?.stage)
        assertFalse(composer.retryRun(restoredRuns.single()))
        assertEquals(2, posts.size, "an explicitly rejected entry cannot be posted again")
        val draft = composer.takeBackQueued(restoredRuns.single())!!
        assertEquals("old guidance", draft.text)
        assertEquals(listOf(attachment), draft.attachments)
        assertEquals(listOf(PromptContextReference("src/main.kt", 7)), draft.context)
        assertTrue(outbox.entries("s").isEmpty())
        client.close()
    }

    @Test fun `the source draft transfers only after durable storage and rejection keeps that stored content`() = runTest {
        var transferred = 0
        var posts = 0
        val core = openCore(session(), emptyList())
        val outbox = NativeSendOutbox(InMemoryOutboxStore())
        val client = HttpClient(MockEngine {
            posts++
            assertEquals(1, transferred, "source ownership transfers before the POST")
            respond("""{"error":{"code":"INVALID_NATIVE_INPUT","message":"input rejected"}}""", HttpStatusCode.BadRequest, headersOf(HttpHeaders.ContentType, "application/json"))
        }) { installRiffetClient() }
        try {
            val api = RiffetApi(client, "http://localhost")
            val composer = SessionComposer(api, CoroutineScope(UnconfinedTestDispatcher(testScheduler)), outbox, core, MutableStateFlow(SessionListState()), SessionInteractions(api, core))
            assertFalse(composer.send("persist first", emptyList(), emptyList(), false) {
                assertEquals("persist first", outbox.entries("s").single().body.text)
                transferred++
            })
            assertEquals(1, transferred)
            assertEquals(1, posts)
            val rejected = core.value.runs.single()
            assertTrue(canRestoreUnsentMessage(rejected))
            assertEquals("persist first", assertNotNull(composer.takeBackQueued(rejected)).text)
            assertTrue(outbox.entries("s").isEmpty())
            val broken = NativeSendOutbox(object : OutboxStore {
                override fun list(sessionId: String): List<OutboxEntry> = emptyList()
                override fun save(entry: OutboxEntry) { error("disk full") }
                override fun remove(sessionId: String, commandId: String) = Unit
            })
            val failedSave = SessionComposer(api, CoroutineScope(UnconfinedTestDispatcher(testScheduler)), broken, core, MutableStateFlow(SessionListState()), SessionInteractions(api, core))
            assertFalse(failedSave.send("keep draft", emptyList(), emptyList(), false) { transferred++ })
            assertEquals(1, transferred, "storage failure must keep the source draft")
            assertEquals(1, posts, "storage failure must not submit")
        } finally { client.close() }
    }

    @Test fun `an unknown ordinary message rejected on exact retry keeps all content recoverable`() = runTest {
        var posts = 0
        val attachment = Attachment("file", "note.txt", "text/plain", 1, "/file")
        val core = openCore(session(), emptyList())
        val outbox = NativeSendOutbox(InMemoryOutboxStore())
        val client = HttpClient(MockEngine { request ->
            if (request.method == HttpMethod.Get) return@MockEngine respond(RiffetJson.instance.encodeToString(attachment), headers = headersOf(HttpHeaders.ContentType, "application/json"))
            posts++
            if (posts == 1) error("response lost")
            respond("""{"error":{"code":"INVALID_NATIVE_INPUT","message":"input rejected"}}""", HttpStatusCode.BadRequest, headersOf(HttpHeaders.ContentType, "application/json"))
        }) { installRiffetClient() }
        try {
            val api = RiffetApi(client, "http://localhost")
            val composer = SessionComposer(api, CoroutineScope(UnconfinedTestDispatcher(testScheduler)), outbox, core, MutableStateFlow(SessionListState()), SessionInteractions(api, core))
            assertTrue(composer.send("keep me", listOf(attachment), listOf(PromptContextReference("source.kt", 5)), false))
            assertFalse(composer.retryRun(core.value.runs.single()))
            val rejected = core.value.runs.single()
            assertTrue(canRestoreUnsentMessage(rejected))
            val draft = assertNotNull(composer.takeBackQueued(rejected))
            assertEquals("keep me", draft.text)
            assertEquals(listOf(attachment), draft.attachments)
            assertEquals(listOf(PromptContextReference("source.kt", 5)), draft.context)
            assertTrue(outbox.entries("s").isEmpty())
            assertEquals(2, posts, "restoring rejected content must not send a third request")
        } finally { client.close() }
    }

    @Test fun `unknown outbox versions and missing targets restore as failures without network calls`() = runTest {
        var calls = 0
        val client = HttpClient(MockEngine { calls++; error("must not send") }) { installRiffetClient() }
        val api = RiffetApi(client, "http://localhost")
        val core = openCore(session(), emptyList())
        val outbox = NativeSendOutbox(InMemoryOutboxStore())
        outbox.persist(OutboxEntry("s", NativeMessageInput("future", "future record"), stamp, version = 99))
        val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
        val composer = SessionComposer(api, scope, outbox, core, MutableStateFlow(SessionListState()), SessionInteractions(api, core))
        val restored = composer.withLocalOutbox(emptyList())
        assertEquals(1, restored.size)
        for (run in restored) {
            assertEquals(RunState.FAILED, run.state)
            assertFalse(composer.retryRun(run))
            assertNotNull(composer.takeBackQueued(run))
        }
        assertEquals(0, calls)
    }

    @Test fun `queued conversion persists source and exact endpoint while unknown then settles source on retry`() = runTest {
        val requests = mutableListOf<Pair<String, String>>()
        val client = HttpClient(MockEngine { request ->
            requests += request.url.encodedPath to (request.body as TextContent).text
            if (requests.size == 1) error("response lost")
            val command = RiffetJson.instance.parseToJsonElement(requests.last().second).jsonObject["commandId"]!!.jsonPrimitive.content
            respond(RiffetJson.instance.encodeToString(accepted(command)), HttpStatusCode.Accepted, headersOf(HttpHeaders.ContentType, "application/json"))
        }) { installRiffetClient() }
        val api = RiffetApi(client, "http://localhost")
        val source = accepted("source").copy(state = RunState.QUEUED, native = accepted("source").native!!.copy(intent = null, delivery = NativeDeliveryState.QUEUED, input = NativeRunInput("original queued text", listOf("file-a"), listOf(NativeRunContextReference("src/a.kt", 7)))))
        val core = openCore(session(), listOf(source))
        val outbox = NativeSendOutbox(InMemoryOutboxStore())
        val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
        val composer = SessionComposer(api, scope, outbox, core, MutableStateFlow(SessionListState()), SessionInteractions(api, core))
        assertTrue(composer.steerQueued(source, target))
        val saved = outbox.entries("s").single()
        assertEquals("source", saved.sourceRunId)
        assertNotEquals(source.commandId, saved.body.commandId)
        assertEquals("original queued text", saved.body.text)
        assertEquals(listOf(AttachmentRef("file-a")), saved.body.attachments)
        assertEquals(listOf(PromptContextReference("src/a.kt", 7)), saved.body.context)
        assertFalse(composer.sendQueuedNow(source))
        assertFalse(composer.cancelRun(source))
        assertEquals(1, requests.size)
        core.update { it.copy(selected = session().copy(configRevision = 300, nativeSessionId = "new-session")) }
        val unknown = core.value.runs.first { it.commandId == saved.body.commandId }
        assertTrue(composer.retryRun(unknown))
        assertEquals(requests[0], requests[1])
        assertEquals("/api/sessions/s/native/runs/source/steer", requests[0].first)
        val wire = RiffetJson.instance.parseToJsonElement(requests[0].second).jsonObject
        assertEquals(setOf("commandId", "target"), wire.keys)
        assertEquals(target.turnId, wire["target"]!!.jsonObject["turnId"]!!.jsonPrimitive.content)
        assertEquals(RunState.CANCELLED, core.value.runs.first { it.id == "source" }.state)
        assertTrue(outbox.entries("s").isEmpty())
        client.close()
    }

    @Test fun `recovering a rejected queued conversion must cancel its still queued source first`() = runTest {
        val source = accepted("source").copy(state = RunState.QUEUED, native = accepted("source").native!!.copy(intent = null, delivery = NativeDeliveryState.QUEUED,
            input = NativeRunInput("original queued text", emptyList(), listOf(NativeRunContextReference("src/a.kt", 7)))))
        val requests = mutableListOf<String>()
        var cancelFails = true
        val client = HttpClient(MockEngine { request ->
            val path = request.url.encodedPath
            requests += path
            when {
                path.endsWith("/steer") -> respond("""{"error":{"code":"STEER_TARGET_CHANGED","message":"turn ended"}}""", HttpStatusCode.Conflict, headersOf(HttpHeaders.ContentType, "application/json"))
                path.endsWith("/cancel") && cancelFails -> respond("""{"error":{"code":"CANCEL_FAILED","message":"cannot cancel"}}""", HttpStatusCode.Conflict, headersOf(HttpHeaders.ContentType, "application/json"))
                path.endsWith("/cancel") -> respond(RiffetJson.instance.encodeToString(source.copy(state = RunState.CANCELLED, native = source.native!!.copy(delivery = NativeDeliveryState.CANCELLED))), HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
                else -> respond(RiffetJson.instance.encodeToString(listOf(source)), HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
            }
        }) { installRiffetClient() }
        val api = RiffetApi(client, "http://localhost")
        val core = openCore(session(), listOf(source))
        val outbox = NativeSendOutbox(InMemoryOutboxStore())
        val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
        val composer = SessionComposer(api, scope, outbox, core, MutableStateFlow(SessionListState()), SessionInteractions(api, core))
        assertFalse(composer.steerQueued(source, target))
        val failed = core.value.runs.first { it.native?.intent == "steer" }
        assertNull(composer.takeBackQueued(failed), "cannot restore another sendable copy while cancellation failed")
        assertEquals(RunState.QUEUED, core.value.runs.first { it.id == source.id }.state)
        assertEquals(1, outbox.entries("s").size, "failure must retain the original recovery snapshot")
        cancelFails = false
        val draft = assertNotNull(composer.takeBackQueued(failed))
        assertEquals("original queued text", draft.text)
        assertEquals(listOf(PromptContextReference("src/a.kt", 7)), draft.context)
        assertEquals(RunState.CANCELLED, core.value.runs.first { it.id == source.id }.state)
        assertTrue(outbox.entries("s").isEmpty())
        assertEquals(1, requests.count { it.endsWith("/steer") }, "recovery cannot submit a second conversion")
        client.close()
    }

}

/** A store state with [session] open and [runs] tracked, as the composer sees it mid-conversation. */
private fun openCore(session: Session, runs: List<Run>): StateStore = StateStore().also { core ->
    core.update { it.copy(sessionId = session.id, selected = session).withDeliveries(runs.associate { run -> run.key() to Delivery(run) }) }
}
