package riffet.sync

import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import riffet.cache.SyncWindow
import riffet.contracts.NativeStatusPhase
import riffet.contracts.SyncFrame
import riffet.contracts.TimelineRow
import riffet.shared.SyncCursor
import riffet.shared.SyncServerTooOldException
import riffet.shared.RiffetUnauthenticatedException
import riffet.shared.syncStream

/** The lane order rules of `GET /api/v3/sessions/:id/sync` (docs/SYNC-V3.md, 续传与缺口) against a fake server. */
class SyncStreamTest {
    private val servers = mutableListOf<FakeServer>()

    private fun serve(route: (FakeRequest) -> FakeResponse) = FakeServer(route).also { servers += it }

    @AfterTest
    fun closeServers() = servers.forEach { it.close() }

    private fun stream(server: FakeServer, initial: SyncCursor? = null) =
        server.api.syncStream("s1", "main", SyncWindow.PHONE, initial)

    @Test
    fun coldDialTakesASnapshotThenRowsThatFollowIt(): Unit = runBlocking {
        val server = serve { request ->
            if (request.query["after"] == null) sseOpen(
                hello("g1"),
                // A rows frame that overtakes the final part waits for it, then is checked against asOfSeq.
                snapshot("g1", 4, row("a", 1, 3), final = false),
                rows("g1", 5, 5, row("b", 2, 5)),
                snapshot("g1", 4, row("c", 3, 4), part = 1),
                rows("g1", 6, 6, row("b", 2, 6, text = "b2")),
            ) else error("unexpected resume")
        }
        val stream = stream(server)
        val frames = withTimeout(5_000) { stream.flow().take(5).toList() }
        assertEquals(listOf("Hello", "Snapshot", "Snapshot", "Rows", "Rows"), frames.map { it::class.simpleName })
        assertEquals(listOf(5L, 6L), frames.filterIsInstance<SyncFrame.Rows>().map { it.to })
        assertEquals(SyncCursor("g1", 6), stream.cursor)
        val dial = server.dials().single()
        assertNull(dial.query["generation"])
        assertEquals("main", dial.query["lane"])
    }

    @Test
    fun resumeNamesTheHeldCursorAndAcceptsTheDelta(): Unit = runBlocking {
        val server = serve { sseOpen(hello("g1", mode = "delta", headSeq = 7), rows("g1", 6, 7, row("a", 1, 7))) }
        val stream = stream(server, SyncCursor("g1", 5))
        val frames = withTimeout(5_000) { stream.flow().take(2).toList() }
        assertIs<SyncFrame.Rows>(frames[1])
        val dial = server.dials().single()
        assertEquals("g1", dial.query["generation"])
        assertEquals("5", dial.query["after"])
        assertEquals(SyncCursor("g1", 7), stream.cursor)
    }

    @Test
    fun aGapRedialsFromWhatIsHeldAndAReplayIsDropped(): Unit = runBlocking {
        var dial = 0
        val server = serve {
            dial += 1
            if (dial == 1) sse(
                hello("g1", mode = "delta", headSeq = 9),
                rows("g1", 4, 5, row("old", 1, 5)), // replay: ends at what is held
                rows("g1", 8, 9, row("a", 2, 9)), // gap: 6 and 7 are missing
            ) else sseOpen(hello("g1", mode = "delta", headSeq = 9), rows("g1", 6, 9, row("a", 2, 9)))
        }
        val stream = stream(server, SyncCursor("g1", 5))
        val frames = withTimeout(5_000) { stream.flow().take(3).toList() }
        assertEquals(listOf("Hello", "Hello", "Rows"), frames.map { it::class.simpleName })
        assertEquals(6L, (frames[2] as SyncFrame.Rows).from)
        assertEquals(listOf("5", "5"), server.dials().map { it.query["after"] })
    }

    @Test
    fun aResetForgetsTheSeqUntilItsSnapshotCompletes(): Unit = runBlocking {
        var dial = 0
        val server = serve { request ->
            dial += 1
            when (dial) {
                1 -> sse(hello("g1", mode = "delta", headSeq = 5), reset("g2"))
                else -> {
                    // The reset left no resumable cursor: the redial asks for a snapshot.
                    assertNull(request.query["after"])
                    sseOpen(hello("g2"), snapshot("g2", 3, row("a", 1, 3)))
                }
            }
        }
        val stream = stream(server, SyncCursor("g1", 5))
        val frames = withTimeout(5_000) { stream.flow().take(4).toList() }
        assertEquals(listOf("Hello", "Reset", "Hello", "Snapshot"), frames.map { it::class.simpleName })
        assertEquals(SyncCursor("g2", 3), stream.cursor)
    }

    @Test
    fun controlFramesPassAndFutureValuesCostOnlyThemselves(): Unit = runBlocking {
        val server = serve {
            sseOpen(
                hello("g1", phase = "hibernating", runs = "[${runJson("r1", "c1", state = "paused")},${runJson("r2", "c2")}]"),
                "future" to """{"type":"future","x":1}""",
                status("busy"),
                snapshot("g1", 2, row("a", 1, 1), row("b", 2, 2, kind = "hologram")),
                ping,
            )
        }
        val frames = withTimeout(5_000) { stream(server).flow().take(4).toList() }
        val hello = assertIs<SyncFrame.Hello>(frames[0])
        assertEquals(NativeStatusPhase.UNKNOWN, hello.status.phase)
        assertEquals(listOf("r2"), hello.runs.map { it.id })
        assertEquals(NativeStatusPhase.BUSY, assertIs<SyncFrame.Status>(frames[1]).status.phase)
        val snapshot = assertIs<SyncFrame.Snapshot>(frames[2])
        assertIs<TimelineRow.Body.Unknown>(snapshot.rows[1].body)
        assertEquals("ping", assertIs<SyncFrame.Unknown>(frames[3]).type)
    }

    @Test
    fun aServerWithoutV3IsTooOld() = runBlocking {
        val server = serve { request ->
            when (request.path) {
                "/health" -> json("""{"ok":true,"protocol":{"version":2,"features":["list-etag"]}}""")
                else -> json("""{"error":{"code":"NOT_FOUND","message":"Route not found"}}""", 404)
            }
        }
        assertFailsWith<SyncServerTooOldException> { withTimeout(5_000) { stream(server).flow().toList() } }
        Unit
    }

    @Test
    fun aRevokedTokenEndsTheStream(): Unit = runBlocking {
        val server = serve { json("""{"error":{"code":"UNAUTHENTICATED","message":"no"}}""", 401) }
        assertFailsWith<RiffetUnauthenticatedException> { withTimeout(5_000) { stream(server).flow().toList() } }
        assertTrue(server.dials().size == 1)
    }
}
