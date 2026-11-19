package riffet.sync

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.headersOf
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import riffet.cache.InMemoryLocalFiles
import riffet.cache.LocalFiles
import riffet.cache.SyncWindow
import riffet.cache.TimelineCache
import riffet.cache.TimelineSnapshot
import riffet.contracts.NativeInteraction
import riffet.contracts.NativeInteractionAction
import riffet.contracts.NativeInteractionKind
import riffet.contracts.NativeInteractionOption
import riffet.contracts.NativeInteractionResponse
import riffet.contracts.NativeInteractionResultStatus
import riffet.contracts.NativeStatusPhase
import riffet.contracts.Session
import riffet.contracts.TimelineRow
import riffet.contracts.RiffetJson
import riffet.core.PENDING_ROW_POS
import riffet.core.TimelineItem
import riffet.ui.composer.InMemoryOutboxStore
import riffet.ui.composer.OutboxEntry
import riffet.ui.composer.NativeSessionCreationOutbox
import riffet.ui.state.SERVER_TOO_OLD_REASON
import riffet.ui.state.SessionStore
import riffet.ui.state.RiffetConnectionState
import riffet.ui.state.SessionInteractions
import riffet.ui.state.StateStore
import riffet.ui.state.messageRecovery
import riffet.shared.NativeMessageInput
import riffet.shared.RiffetApi
import riffet.shared.installRiffetClient

/**
 * A v3 [SessionStore] against a fake server: what the existing screens read (timeline, status, runs,
 * history, connection) comes from the lane's frames, the device copy resumes the stream, and the v2
 * routes are never called.
 */
class SessionSyncTest {
    private val servers = mutableListOf<FakeServer>()
    private val scopes = mutableListOf<CoroutineScope>()
    private val session: Session = RiffetJson.instance.decodeFromString(Session.serializer(), SESSION_JSON)

    private fun serve(route: (FakeRequest) -> FakeResponse) = FakeServer { request ->
        if (request.path == "/health") json(HEALTH_V3) else route(request)
    }.also { servers += it }

    private fun store(server: FakeServer, cache: TimelineCache? = null, outbox: InMemoryOutboxStore = InMemoryOutboxStore()): SessionStore {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default).also { scopes += it }
        return SessionStore(
            api = server.api,
            scope = scope,
            outboxStore = outbox,
            creationOutbox = NativeSessionCreationOutbox(InMemoryLocalFiles(), server.api.baseUrl),
            timelineCache = cache,
        )
    }

    @AfterTest
    fun tearDown() {
        scopes.forEach { it.cancel() }
        servers.forEach { it.close() }
    }

    private fun FakeServer.v2Calls() = requests.filter { "/native/" in it.path || it.path.endsWith("/stream") }

    @Test
    fun aColdOpenDrawsTheSnapshotItsRowsAndItsControlState(): Unit = runBlocking {
        val server = serve { request ->
            when (request.path) {
                "/api/v3/sessions/s1/sync" -> sseOpen(
                    hello("g1", runs = "[${runJson("r1", "c1", state = "completed")}]"),
                    snapshot("g1", 2, userRow("user:c1", 1, 1, "hi", runId = "r1"), row("a1", 2, 2, "answer")),
                    status("busy"),
                    rows("g1", 3, 3, row("a1", 2, 3, "answer more")),
                )
                else -> json("""{"error":{"code":"NOT_FOUND","message":"no"}}""", 404)
            }
        }
        val store = store(server)
        store.select(session)
        val timeline = withTimeout(5_000) { store.timeline.first { (it.lastOrNull() as? TimelineItem.Assistant)?.text == "answer more" } }
        assertEquals(listOf("user:c1", "a1"), timeline.map { it.key })
        assertEquals("r1", assertIs<TimelineItem.User>(timeline[0]).run?.id)
        withTimeout(5_000) { store.status.first { it?.phase == NativeStatusPhase.BUSY } }
        withTimeout(5_000) { store.connection.first { it is RiffetConnectionState.Live } }
        assertNull(store.cachedAt.value)
        assertTrue(store.loaded.value)
        assertEquals(emptyList(), server.v2Calls())
    }

    @Test
    fun helloControlBeatsABusyQueueGuessAndALowerRevision(): Unit = runBlocking {
        val server = serve { request ->
            when (request.path) {
                "/api/v3/sessions/s1/sync" -> sseOpen(
                    hello(
                        "g1",
                        phase = "busy",
                        runs = "[${runJson("r1", "c1", state = "queued")}]",
                        control = controlSnapshotJson(revision = 5, placement = "sending"),
                    ),
                    controlFrame(controlSnapshotJson(revision = 4, runtime = "failed", placement = "queued", actions = """["send_now"]""", canStop = true, active = true)),
                    status("idle"),
                )
                else -> json("""{"error":{"code":"NOT_FOUND","message":"no"}}""", 404)
            }
        }
        val store = store(server)
        store.select(session)
        withTimeout(5_000) { store.status.first { it?.phase == NativeStatusPhase.IDLE } }
        assertEquals(5L, store.control.value?.revision)
        assertEquals("ready", store.control.value?.runtime)
        assertNull(store.control.value?.activeTurn)
        assertEquals(emptyList(), store.queued.value)
        assertEquals(emptyList(), store.actionsForQueued("r1", "c1"))
    }

    @Test
    fun aLaterControlRevisionReplacesTheHelloSnapshot(): Unit = runBlocking {
        val server = serve { request ->
            when (request.path) {
                "/api/v3/sessions/s1/sync" -> sseOpen(
                    hello("g1", phase = "busy", runs = "[${runJson("r1", "c1", state = "queued")}]"),
                    controlFrame(controlSnapshotJson(revision = 1, placement = "queued", actions = """["edit","cancel"]""", active = true, canStop = true)),
                    controlFrame(controlSnapshotJson(revision = 2, placement = "sending")),
                    status("idle"),
                )
                else -> json("""{"error":{"code":"NOT_FOUND","message":"no"}}""", 404)
            }
        }
        val store = store(server)
        store.select(session)
        withTimeout(5_000) { store.status.first { it?.phase == NativeStatusPhase.IDLE } }
        assertEquals(2L, store.control.value?.revision)
        assertEquals("sending", store.control.value?.inbox?.single()?.placement)
        assertEquals(emptyList(), store.queued.value)
    }

    @Test
    fun theDeviceCopyIsDrawnFirstAndResumedFromThenPagedUp(): Unit = runBlocking {
        val server = serve { request ->
            when {
                request.path == "/api/v3/sessions/s1/sync" && request.query["after"] == "5" && request.query["generation"] == "g1" ->
                    sseOpen(hello("g1", mode = "delta", headSeq = 6), rows("g1", 6, 6, row("c", 3, 6, "new")))
                request.path == "/api/v3/sessions/s1/timeline" && request.query["before"] == "1" ->
                    json("""{"generation":"g1","rows":[${row("z", 0, 1, "oldest")}],"hasBefore":false,"hasAfter":true}""")
                else -> json("""{"error":{"code":"UNEXPECTED","message":"${request.path} ${request.query}"}}""", 400)
            }
        }
        val cache = TimelineCache(InMemoryLocalFiles(), server.api.baseUrl)
        val held = listOf(row("a", 1, 4), row("b", 2, 5)).map { RiffetJson.instance.decodeFromString(TimelineRow.serializer(), it) }
        cache.save(TimelineSnapshot("s1", generation = "g1", lastSeq = 5, hasBefore = true, rows = held))
        val store = store(server, cache)
        store.select(session)
        // Drawn from the device before the server answers, marked as the stored copy until it does.
        val resumed = withTimeout(5_000) { store.timeline.first { it.size == 3 } }
        assertEquals(listOf("a", "b", "c"), resumed.map { it.key })
        withTimeout(5_000) { store.cachedAt.first { it == null } }
        assertEquals(true, store.history.value?.hasMore)

        store.loadOlder()
        val paged = withTimeout(5_000) { store.timeline.first { it.size == 4 } }
        assertEquals("z", paged.first().key)
        withTimeout(5_000) { store.history.first { it?.hasMore == false } }

        store.flush()
        withTimeout(5_000) {
            while (cache.meta("s1")?.lastSeq != 6L || cache.meta("s1")?.rows != 4) delay(20)
        }
        assertEquals(emptyList(), server.v2Calls())
    }

    @Test
    fun aLegacyCursorAheadOfItsAnswerRefreshesTheWholeWindow(): Unit = runBlocking {
        val server = serve { request ->
            when {
                request.path == "/api/v3/sessions/s1/sync" && request.query["after"] == null ->
                    sseOpen(
                        hello("g1", headSeq = 3),
                        snapshot("g1", 3, row("old", 1, 2), row("answer", 2, 3, "final reply", extra = ",\"phase\":\"final_answer\"")),
                    )
                else -> json("""{"error":{"code":"UNEXPECTED","message":"${request.path} ${request.query}"}}""", 400)
            }
        }
        val files = InMemoryLocalFiles()
        val cache = TimelineCache(files, server.api.baseUrl)
        val old = RiffetJson.instance.decodeFromString(TimelineRow.serializer(), row("old", 1, 2))
        cache.save(TimelineSnapshot("s1", generation = "g1", lastSeq = 3, hasBefore = false, rows = listOf(old)))
        val meta = assertNotNull(cache.meta("s1")).copy(version = 1)
        val path = "servers/${riffet.cache.safeName(server.api.baseUrl)}/v3/${riffet.cache.safeName("s1")}.meta"
        files.write(path, RiffetJson.instance.encodeToString(riffet.cache.TimelineMeta.serializer(), meta))

        val store = store(server, TimelineCache(files, server.api.baseUrl))
        store.select(session)
        val answer = withTimeout(5_000) { store.timeline.first { it.lastOrNull()?.key == "answer" } }
        assertEquals("final reply", assertIs<TimelineItem.Assistant>(answer.last()).text)
        assertNull(server.dials().first().query["after"])
    }

    @Test
    fun aCancelledFlushCannotLoseTheAnswerBeforeTheNextFlush(): Unit = runBlocking {
        val server = serve { request ->
            when (request.path) {
                "/api/v3/sessions/s1/sync" -> sseOpen(
                    hello("g1", mode = "delta", headSeq = 2),
                    rows("g1", 2, 2, row("answer", 2, 2, "final reply", extra = ",\"phase\":\"final_answer\"")),
                )
                else -> json("""{"error":{"code":"UNEXPECTED","message":"${request.path}"}}""", 400)
            }
        }
        val backing = InMemoryLocalFiles()
        val appendEntered = java.util.concurrent.CountDownLatch(1)
        val releaseAppend = java.util.concurrent.CountDownLatch(1)
        val failFirstAppend = java.util.concurrent.atomic.AtomicBoolean(true)
        val files = object : LocalFiles by backing {
            override fun append(path: String, text: String) {
                if (failFirstAppend.compareAndSet(true, false)) {
                    appendEntered.countDown()
                    releaseAppend.await()
                    throw IllegalStateException("interrupted append")
                }
                backing.append(path, text)
            }
        }
        val cache = TimelineCache(files, server.api.baseUrl)
        val old = RiffetJson.instance.decodeFromString(TimelineRow.serializer(), row("old", 1, 1))
        cache.save(TimelineSnapshot("s1", generation = "g1", lastSeq = 1, hasBefore = false, rows = listOf(old)))
        val store = store(server, cache)
        try {
            store.select(session)
            withTimeout(5_000) { store.timeline.first { it.lastOrNull()?.key == "answer" } }
            store.flush()
            assertTrue(withContext(Dispatchers.IO) { appendEntered.await(5, java.util.concurrent.TimeUnit.SECONDS) })
            store.flush()
            delay(100)
        } finally {
            releaseAppend.countDown()
        }
        withTimeout(5_000) {
            while (cache.meta("s1")?.lastSeq != 2L) delay(20)
        }
        val stored = assertNotNull(cache.load("s1"))
        assertEquals("final reply", assertIs<TimelineRow.Body.Assistant>(stored.rows.last().body).text)
    }

    @Test
    fun returningToLatestRestoresACappedWindowAndRejectsAnOvertakenOlderPage(): Unit = runBlocking {
        for (reopen in listOf(false, true)) {
            val pageEntered = CompletableDeferred<Unit>()
            val releasePage = java.util.concurrent.CountDownLatch(1)
            val dials = java.util.concurrent.atomic.AtomicInteger()
            val server = serve { request ->
                when {
                    request.path.endsWith("/sync") -> if (dials.incrementAndGet() == 1) {
                        sseOpen(hello("g1"), snapshot("g1", 5, row("c", 3, 3), row("d", 4, 4), row("e", 5, 5), hasBefore = true))
                    } else {
                        sseOpen(hello("g1"), snapshot("g1", 6, row("d", 4, 4), row("e", 5, 5), row("f", 6, 6), hasBefore = true))
                    }
                    request.query["before"] == "3" ->
                        json("""{"generation":"g1","rows":[${row("a", 1, 1)},${row("b", 2, 2)}],"hasBefore":true,"hasAfter":true}""")
                    request.query["before"] == "1" -> {
                        pageEntered.complete(Unit)
                        releasePage.await()
                        json("""{"generation":"g1","rows":[${row("z", 0, 1)}],"hasBefore":false,"hasAfter":true}""")
                    }
                    else -> json("""{"error":{"code":"UNEXPECTED","message":"${request.path} ${request.query}"}}""", 400)
                }
            }
            val cache = TimelineCache(InMemoryLocalFiles(), server.api.baseUrl, window = SyncWindow(rows = 3, bytes = 1_048_576))
            val store = store(server, cache)
            try {
                store.select(session)
                withTimeout(5_000) { store.timeline.first { it.lastOrNull()?.key == "e" } }
                store.loadOlder()
                withTimeout(5_000) { store.hasNewerHistory.first { it } }
                assertEquals(listOf("a", "b", "c"), store.timeline.value.map { it.key }, "reopen=$reopen")
                withTimeout(5_000) { store.loadingHistory.first { !it } }
                store.flush()
                assertNull(cache.meta("s1")?.lastSeq, "An older window must not resume at the stream's head")
                assertTrue(assertNotNull(cache.load("s1")).meta.hasAfter)

                store.loadOlder()
                withTimeout(5_000) { pageEntered.await() }
                if (reopen) store.select(session) else store.jumpToLatest()
                withTimeout(5_000) { store.timeline.first { it.lastOrNull()?.key == "f" } }
                withTimeout(5_000) { store.hasNewerHistory.first { !it } }
                releasePage.countDown()
                store.flush()
                withTimeout(5_000) {
                    while (cache.meta("s1")?.lastSeq != 6L) delay(20)
                }
                assertFalse(assertNotNull(cache.load("s1")).meta.hasAfter)
                assertEquals(listOf("d", "e", "f"), store.timeline.value.map { it.key }, "reopen=$reopen")
                assertTrue(server.dials().last().query["after"] == null, "Returning to latest needs a new snapshot")
                assertEquals(2, dials.get(), "reopen=$reopen")
                assertEquals(emptyList(), server.v2Calls())
            } finally {
                releasePage.countDown()
            }
        }
    }

    @Test
    fun reopeningWhileAnOlderPageIsInFlightKeepsTheNewestRows(): Unit = runBlocking {
        val pageEntered = CompletableDeferred<Unit>()
        val releasePage = java.util.concurrent.CountDownLatch(1)
        val dials = java.util.concurrent.atomic.AtomicInteger()
        val server = serve { request ->
            when {
                request.path.endsWith("/sync") -> {
                    dials.incrementAndGet()
                    sseOpen(hello("g1"), snapshot("g1", 3, row("a", 1, 1), row("b", 2, 2), row("c", 3, 3), hasBefore = true))
                }
                request.query["before"] == "1" -> {
                    pageEntered.complete(Unit)
                    releasePage.await()
                    json("""{"generation":"g1","rows":[${row("z", 0, 1)}],"hasBefore":false,"hasAfter":true}""")
                }
                else -> json("""{"error":{"code":"UNEXPECTED","message":"${request.path} ${request.query}"}}""", 400)
            }
        }
        val cache = TimelineCache(InMemoryLocalFiles(), server.api.baseUrl, window = SyncWindow(rows = 3, bytes = 1_048_576))
        val store = store(server, cache)
        try {
            store.select(session)
            withTimeout(5_000) { store.timeline.first { it.lastOrNull()?.key == "c" } }
            store.loadOlder()
            withTimeout(5_000) { pageEntered.await() }
            store.select(session)
            releasePage.countDown()
            withTimeout(5_000) { store.loadingHistory.first { !it } }
            delay(50)
            assertEquals(listOf("a", "b", "c"), store.timeline.value.map { it.key })
            assertEquals(false, store.hasNewerHistory.value)
            assertEquals(1, dials.get())
        } finally {
            releasePage.countDown()
        }
    }

    @Test
    fun aServerWithoutV3IsReportedAsTooOld(): Unit = runBlocking {
        val server = FakeServer { request ->
            when (request.path) {
                "/health" -> json("""{"ok":true,"protocol":{"version":2,"features":["list-etag"]}}""")
                else -> json("""{"error":{"code":"NOT_FOUND","message":"Route not found"}}""", 404)
            }
        }.also { servers += it }
        val store = store(server)
        store.select(session)
        withTimeout(5_000) { store.serverTooOld.first { it } }
        assertEquals(RiffetConnectionState.Failed(SERVER_TOO_OLD_REASON), withTimeout(5_000) { store.connection.first { it is RiffetConnectionState.Failed } })
        assertEquals(emptyList(), server.v2Calls())
    }

    @Test
    fun aCompletedSendOutsideTheSnapshotOnlyAppearsOnItsHistoryPage(): Unit = runBlocking {
        val outbox = InMemoryOutboxStore().apply {
            save(OutboxEntry("s1", NativeMessageInput("lost", "retry me"), "2026-10-25T00:00:01.500Z"))
        }
        val command = runJson("old", "command", state = "completed", delivery = "input_sent")
        val pending = runJson("new", "current", state = "running", delivery = "dispatching", at = "2026-10-25T00:00:05Z")
        val steer = runJson("steer", "guidance", state = "running", delivery = "dispatching", at = "2026-10-25T00:00:03.500Z", intent = "steer")
        val uncertain = runJson("retry", "unconfirmed", state = "interrupted", delivery = "uncertain", at = "2026-10-25T00:00:02.500Z")
        val server = serve { request ->
            when {
                request.path.endsWith("/sync") -> sseOpen(
                    hello("g1", runs = "[$command,$pending,$uncertain,$steer]"),
                    snapshot("g1", 3, row("answer", 3, 3, lastAt = "2026-10-25T00:00:03.800Z"), hasBefore = true),
                    rows("g1", 4, 4, row("latest", 4, 4)),
                )
                request.query["before"] == "3" -> json("""{"generation":"g1","rows":[${userRow("user:command", 1, 1, "/summarize", runId = "old")},${row("compressed", 2, 2, lastAt = "2026-10-25T00:00:02.800Z")}],"hasBefore":false,"hasAfter":true}""")
                else -> json("{}", 404)
            }
        }
        val cache = TimelineCache(InMemoryLocalFiles(), server.api.baseUrl, window = SyncWindow(rows = 3, bytes = 1_048_576))
        val store = store(server, cache, outbox)
        store.select(session)
        val latest = withTimeout(5_000) { store.timeline.first { items -> items.any { it.key == "latest" } } }
        assertEquals(listOf("user:lost", "user:guidance", "answer", "latest", "user:current"), latest.map { it.key })
        val recovered = assertIs<TimelineItem.User>(latest.first())
        assertTrue(messageRecovery(assertNotNull(recovered.run)).canRetry)
        store.loadOlder()
        val history = withTimeout(5_000) { store.timeline.first { items -> items.any { it.key == "compressed" } } }
        assertEquals(listOf("user:command", "user:lost", "user:unconfirmed", "compressed", "user:guidance", "answer"), history.map { it.key })
        store.jumpToLatest()
        val returned = withTimeout(5_000) { store.timeline.first { items -> items.any { it.key == "latest" } } }
        assertEquals(latest.map { it.key }, returned.map { it.key })
    }

    @Test
    fun aSendWithoutARowIsDrawnUntilTheServerRowWithItsKeyReplacesIt(): Unit = runBlocking {
        val server = serve { request ->
            when (request.path) {
                "/api/v3/sessions/s1/sync" -> sseOpen(
                    hello("g1", runs = "[${runJson("r2", "c2", state = "running", delivery = "dispatching")}]"),
                    snapshot("g1", 1, row("a1", 1, 1, "earlier")),
                    ping,
                )
                else -> json("""{"error":{"code":"NOT_FOUND","message":"no"}}""", 404)
            }
        }
        val store = store(server)
        store.select(session)
        val local = withTimeout(5_000) { store.timeline.first { it.size == 2 } }
        val pending = assertIs<TimelineItem.User>(local[1])
        assertEquals("user:c2", pending.key)
        assertEquals("r2", pending.run?.id)
        assertEquals("pending:r2", pending.event.projectionKey)

        val echoed = serve { request ->
            when (request.path) {
                "/api/v3/sessions/s1/sync" -> sseOpen(
                    hello("g1", runs = "[${runJson("r2", "c2", state = "running", delivery = "dispatching")}]"),
                    snapshot("g1", 1, row("a1", 1, 1, "earlier")),
                    rows("g1", 2, 2, userRow("user:c2", PENDING_ROW_POS, 2, "hi r2", runId = "r2", pending = "preparing")),
                    rows("g1", 3, 3, row("a2", 2, 3, "answer")),
                )
                else -> json("""{"error":{"code":"NOT_FOUND","message":"no"}}""", 404)
            }
        }
        val next = store(echoed)
        next.select(session)
        val timeline = withTimeout(5_000) { next.timeline.first { items -> items.any { it.key == "a2" } } }
        assertEquals(listOf("a1", "a2", "user:c2"), timeline.map { it.key })
        assertEquals("user:c2", timeline.last().event.projectionKey)
        assertEquals("r2", assertIs<TimelineItem.User>(timeline.last()).run?.id)
    }

    @Test
    fun aResetKeepsTheRowsOnScreenUntilItsSnapshotReplacesThem(): Unit = runBlocking {
        val server = serve { request ->
            when (request.path) {
                "/api/v3/sessions/s1/sync" -> sseOpen(
                    hello("g1"),
                    snapshot("g1", 1, row("a1", 1, 1, "earlier")),
                    reset("g2"),
                    snapshot("g2", 1, row("b1", 1, 1, "rebuilt")),
                )
                else -> json("""{"error":{"code":"NOT_FOUND","message":"no"}}""", 404)
            }
        }
        val store = store(server)
        store.select(session)
        val rebuilt = withTimeout(5_000) { store.timeline.first { it.firstOrNull()?.key == "b1" } }
        assertEquals(listOf("b1"), rebuilt.map { it.key })
        assertEquals("g2", store.history.value?.generation)
    }

    @Test
    fun overtakenHttpObservationsDoNotSettleOrReplaceAStillPendingProtocolRequest(): Unit = runBlocking {
        val pending = NativeInteraction(id = "A", revision = "R", kind = NativeInteractionKind.PERMISSION, title = "Approve",
            options = listOf(NativeInteractionOption("one", "One", false)),
            actions = listOf(NativeInteractionAction("approve", "Approve")), transport = "protocol")
        val changed = pending.copy(options = listOf(NativeInteractionOption("one", "One", true)))
        val opened = session.copy(nativeSessionId = "T1")
        for (mutation in listOf("content", "content ABA", "thread ABA")) {
            for (get in listOf(false, true)) {
                val core = StateStore().also { store ->
                    store.update { it.copy(epoch = 7, dial = 1, sessionId = opened.id, selected = opened).withInteraction(pending) }
                }
                val client = HttpClient(MockEngine {
                    when (mutation) {
                        "thread ABA" -> {
                            core.replaceSelected(opened.copy(nativeSessionId = "T2"))
                            core.replaceSelected(opened)
                        }
                        else -> {
                            core.reduceDial(1) { it.withInteraction(changed) }
                            if (mutation == "content ABA") core.reduceDial(1) { it.withInteraction(pending) }
                        }
                    }
                    respond(if (get) "null" else """{"status":"completed"}""",
                        headers = headersOf(HttpHeaders.ContentType, "application/json"))
                }) { installRiffetClient() }
                try {
                    val transport = SessionInteractions(RiffetApi(client, "http://localhost"), core)
                    val current = if (mutation == "content") changed else pending
                    if (get) assertEquals(current, transport.syncInteraction(), mutation)
                    else {
                        val result = transport.respondInteraction(NativeInteractionResponse("A", "R", "request-one", "approve"))
                        assertEquals(NativeInteractionResultStatus.UNCERTAIN, result.status, mutation)
                        assertEquals(current, result.interaction, "must return the store's observation, not an alleged fresh card")
                    }
                    assertEquals(current, core.value.interaction, mutation)
                    assertEquals(current, core.value.status?.interaction, mutation)
                    assertEquals(7, core.value.epoch)
                    assertEquals(1, core.value.dial)
                } finally { client.close() }
            }
        }
    }

    @Test
    fun nativeContextFramesFenceHttpButRepeatedHelloAndTheLiveStreamRemainValid(): Unit = runBlocking {
        val pending = NativeInteraction(id = "A", revision = "R", kind = NativeInteractionKind.PERMISSION, title = "Approve",
            actions = listOf(NativeInteractionAction("approve", "Approve")), transport = "protocol")
        val interaction = RiffetJson.instance.encodeToString(NativeInteraction.serializer(), pending)
        val opened = session.copy(nativeSessionId = "T1")
        val sessionJson = RiffetJson.instance.encodeToString(Session.serializer(), opened)
        fun greeting(generation: String) = hello(generation, phase = "attention", interaction = interaction)
            .let { (event, data) -> event to data.replace(SESSION_JSON, sessionJson) }
        for (change in listOf("same hello", "generation", "reset", "same generation reset", "thread")) {
            for (get in if (change == "same hello") listOf(false) else listOf(false, true)) {
                val entered = CompletableDeferred<Unit>()
                val release = java.util.concurrent.CountDownLatch(1)
                val dials = java.util.concurrent.atomic.AtomicInteger()
                val generation = if (change == "generation" || change == "reset") "g2" else "g1"
                val frames = when (change) {
                    "thread" -> arrayOf("session" to """{"session":${RiffetJson.instance.encodeToString(Session.serializer(), opened.copy(nativeSessionId = "T2"))}}""")
                    "reset", "same generation reset" -> arrayOf(reset(generation))
                    else -> arrayOf(greeting(generation), greeting(generation))
                }
                val server = serve { request ->
                    when (request.path) {
                        "/api/v3/sessions/s1/sync" -> if (dials.incrementAndGet() == 1) {
                            sseOpen(greeting("g1"), snapshot("g1", 1, row("initial", 1, 1)))
                        } else {
                            // The frames after the fence must still be handled by this same SSE.
                            sseOpen(*frames, "interaction" to """{"interaction":$interaction}""",
                                snapshot(generation, 2, row("after-context", 1, 2)),
                                rows(generation, 3, 3, row("still-live", 2, 3)))
                        }
                        "/api/sessions/s1/native/interaction" -> {
                            entered.complete(Unit)
                            release.await()
                            json(if (get) "null" else """{"status":"completed"}""")
                        }
                        else -> error("Unexpected request: ${request.path}")
                    }
                }
                val store = store(server)
                try {
                    store.select(opened)
                    withTimeout(5_000) { store.timeline.first { it.singleOrNull()?.key == "initial" } }
                    val epoch = store.openSession.value.epoch
                    val post = if (get) null else async { store.respondInteraction(NativeInteractionResponse("A", "R", "request-one", "approve")) }
                    val read = if (get) async { store.syncInteraction() } else null
                    withTimeout(5_000) { entered.await() }
                    store.retry()
                    withTimeout(5_000) { store.timeline.first { it.any { item -> item.key == "still-live" } } }
                    release.countDown()
                    if (post != null) assertEquals(if (change == "same hello") NativeInteractionResultStatus.COMPLETED else NativeInteractionResultStatus.UNCERTAIN,
                        withTimeout(5_000) { post.await() }.status, change)
                    if (read != null) assertEquals(pending, withTimeout(5_000) { read.await() }, change)
                    assertEquals(if (change == "same hello") null else pending, store.interaction.value, change)
                    assertEquals(store.interaction.value, store.status.value?.interaction, change)
                    assertEquals(epoch, store.openSession.value.epoch, change)
                    assertEquals(2, dials.get(), "observation changes must not invalidate or redial the live stream")
                } finally {
                    release.countDown()
                    store.clear()
                }
            }
        }
    }

    private companion object {
        const val HEALTH_V3 = """{"ok":true,"version":"1.0.0","protocol":{"version":3,"features":["sync-v3"]}}"""
    }
}
