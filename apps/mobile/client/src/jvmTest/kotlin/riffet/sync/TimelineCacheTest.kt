package riffet.sync

import kotlinx.coroutines.runBlocking
import kotlin.coroutines.EmptyCoroutineContext
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import riffet.cache.InMemoryLocalFiles
import riffet.cache.SyncWindow
import riffet.cache.TimelineCache
import riffet.cache.TimelineMeta
import riffet.cache.TimelineSnapshot
import riffet.cache.safeName
import riffet.contracts.TimelineRow
import riffet.contracts.RiffetJson

/** The v3 device copy (docs/SYNC-V3.md, 预算): replay log round-trip, torn writes, window caps and LRU. */
class TimelineCacheTest {
    private val url = "http://mac:4317"
    private val files = InMemoryLocalFiles()
    private var clock = 0L

    private fun cache(window: SyncWindow = SyncWindow.MAC, budget: Long = 64L * 1024 * 1024) =
        TimelineCache(files, url, io = EmptyCoroutineContext, now = { ++clock }, window = window, budgetBytes = budget)

    private fun decoded(json: String): TimelineRow = RiffetJson.instance.decodeFromString(TimelineRow.serializer(), json)

    private fun log(sessionId: String) = "servers/${safeName(url)}/v3/${safeName(sessionId)}.log"
    private fun meta(sessionId: String) = "servers/${safeName(url)}/v3/${safeName(sessionId)}.meta"

    @Test
    fun savesAppendWhatMovedAndReplayToTheWindow(): Unit = runBlocking {
        val cache = cache()
        val a = decoded(row("a", 1, 1))
        val b = decoded(row("b", 2, 2))
        val c = decoded(row("c", 3, 3))
        cache.save(TimelineSnapshot("s1", generation = "g1", lastSeq = 3, hasBefore = true, rows = listOf(a, b, c)))
        val b2 = decoded(row("b", 2, 4, text = "b2"))
        cache.save(TimelineSnapshot("s1", generation = "g1", lastSeq = 4, hasBefore = true, rows = listOf(a, b2), changed = setOf("b"), deleted = setOf("c")))
        assertEquals(5, files.read(log("s1"))!!.lines().count { it.isNotBlank() })
        val stored = assertNotNull(TimelineCache(files, url, io = EmptyCoroutineContext).load("s1"))
        assertEquals(listOf(a, b2), stored.rows)
        assertEquals(4L, stored.meta.lastSeq)
        assertTrue(stored.meta.hasBefore)
    }

    @Test
    fun aTornWriteKeepsTheRowsButNotTheSeq(): Unit = runBlocking {
        val cache = cache()
        cache.save(TimelineSnapshot("s1", generation = "g1", lastSeq = 2, hasBefore = false, rows = listOf(decoded(row("a", 1, 1)), decoded(row("b", 2, 2)))))
        files.append(log("s1"), """{"row":{"key":"c","pos":3""")
        val stored = assertNotNull(TimelineCache(files, url, io = EmptyCoroutineContext).load("s1"))
        assertEquals(listOf("a", "b"), stored.rows.map { it.key })
        assertNull(stored.meta.lastSeq)
    }

    @Test
    fun aCursorAheadOfTheStoredRowsForcesASnapshot(): Unit = runBlocking {
        val cache = cache()
        val a = decoded(row("a", 1, 1))
        val b = decoded(row("b", 2, 2))
        cache.save(TimelineSnapshot("s1", generation = "g1", lastSeq = 2, hasBefore = false, rows = listOf(a, b)))
        val advanced = assertNotNull(cache.meta("s1")).copy(lastSeq = 3, rows = 3)
        files.write(meta("s1"), RiffetJson.instance.encodeToString(TimelineMeta.serializer(), advanced))

        val stored = assertNotNull(cache().load("s1"))
        assertEquals(listOf("a", "b"), stored.rows.map { it.key })
        assertNull(stored.meta.lastSeq)
    }

    @Test
    fun versionOneRowsRemainVisibleButDoNotResumeFromAnUntrustedCursor(): Unit = runBlocking {
        val cache = cache()
        val answer = decoded(row("answer", 1, 7, text = "saved reply"))
        cache.save(TimelineSnapshot("s1", generation = "g1", lastSeq = 7, hasBefore = false, rows = listOf(answer)))
        val oldMeta = assertNotNull(cache.meta("s1")).copy(version = 1)
        files.write(meta("s1"), RiffetJson.instance.encodeToString(TimelineMeta.serializer(), oldMeta))

        val stored = assertNotNull(cache().load("s1"))
        assertEquals(listOf(answer), stored.rows)
        assertEquals(2, stored.meta.version)
        assertNull(stored.meta.lastSeq)
    }

    @Test
    fun aLaneIsCappedToTheWindowNewestFirst(): Unit = runBlocking {
        val cache = cache(SyncWindow(rows = 3, bytes = 1L shl 20))
        cache.save(TimelineSnapshot("s1", generation = "g1", lastSeq = 5, hasBefore = false, rows = (1L..5L).map { decoded(row("r$it", it, it)) }))
        val stored = assertNotNull(cache.load("s1"))
        assertEquals(listOf("r3", "r4", "r5"), stored.rows.map { it.key })
        assertTrue(stored.meta.hasBefore)

        val long = (1L..5L).map { decoded(row("r$it", it, it, text = "x".repeat(300))) }
        // A log line is `{"row":…}` and a newline: room for two of them.
        val line = RiffetJson.instance.encodeToString(TimelineRow.serializer(), long[0]).length + 9L
        val bytes = cache(SyncWindow(rows = 100, bytes = 2 * line + 5))
        bytes.save(TimelineSnapshot("s2", generation = "g1", lastSeq = 5, hasBefore = false, rows = long))
        assertEquals(listOf("r4", "r5"), assertNotNull(bytes.load("s2")).rows.map { it.key })
    }

    @Test
    fun theLeastRecentlyReadLaneGoesFirst(): Unit = runBlocking {
        val one = (1L..3L).map { decoded(row("r$it", it, it, text = "y".repeat(200))) }
        val size = RiffetJson.instance.encodeToString(TimelineRow.serializer(), one[0]).length + 10
        // Room for two lanes of three rows each.
        val cache = cache(budget = 2L * 3 * size + 50)
        for (id in listOf("s1", "s2")) cache.save(TimelineSnapshot(id, generation = "g1", lastSeq = 3, hasBefore = false, rows = one))
        assertNotNull(cache.load("s1"))
        cache.save(TimelineSnapshot("s3", generation = "g1", lastSeq = 3, hasBefore = false, rows = one))
        assertNull(cache.meta("s2"))
        assertNotNull(cache.meta("s1"))
        assertNotNull(cache.meta("s3"))
    }
}
