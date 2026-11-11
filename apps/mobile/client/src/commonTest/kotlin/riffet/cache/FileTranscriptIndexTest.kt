package riffet.cache

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class FileTranscriptIndexTest {
    private val entry = IndexEntry(17, IndexRole.ASSISTANT, "本地缓存 restores the reading position", "2026-10-15T08:00:00Z")

    @Test fun reopensSearchAndPreservesScrollTarget() {
        val files = InMemoryLocalFiles()
        FileTranscriptIndex(files, "http://mac:8080").replace("session/one", listOf(entry))
        val restored = FileTranscriptIndex(files, "http://mac:8080")
        assertEquals(setOf("session/one"), restored.sessions())
        val hit = restored.search("缓存 reading", 10).single()
        assertEquals(17, hit.sequence)
        assertEquals("session/one", hit.sessionId)
    }

    @Test fun serverNamespacesDoNotLeakAndForgetIsDurable() {
        val files = InMemoryLocalFiles()
        val index = FileTranscriptIndex(files, "http://one:8080")
        index.replace("same-session", listOf(entry))
        assertTrue(FileTranscriptIndex(files, "http://two:8080").search("缓存", 10).isEmpty())
        index.forget("same-session")
        assertTrue(FileTranscriptIndex(files, "http://one:8080").sessions().isEmpty())
    }

    @Test fun corruptFileDoesNotHideOtherSessions() {
        val files = InMemoryLocalFiles()
        val index = FileTranscriptIndex(files, "http://mac:8080")
        index.replace("good", listOf(entry))
        val root = "search/${safeName("http://mac:8080")}"
        files.write("$root/broken.json", "{partial")
        assertEquals(setOf("good"), FileTranscriptIndex(files, "http://mac:8080").sessions())
    }
}
