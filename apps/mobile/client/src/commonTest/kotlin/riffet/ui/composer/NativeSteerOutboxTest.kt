package riffet.ui.composer

import riffet.contracts.NativeTurnTarget
import riffet.contracts.SessionReferenceInput
import riffet.shared.NativeMessageInput
import kotlin.test.*

class NativeSteerOutboxTest {
    @Test fun `legacy intent survives and a conflicting v2 record cannot choose an endpoint`() {
        val legacy = OutboxJson.decode("""{"sessionId":"s","body":{"commandId":"c","text":"hello"},"createdAt":"now","interrupt":true}""")!!
        assertEquals(1, legacy.version)
        assertNull(legacy.steerTarget)
        assertTrue(legacy.interrupt)
        val references = listOf(SessionReferenceInput(kind = "session", sessionId = "source", fromRunId = "accepted-run"))
        val steer = OutboxEntry("s", NativeMessageInput("c", "guidance", references = references), "now", steerTarget = NativeTurnTarget("session", "turn"), version = 2)
        assertEquals(references, OutboxJson.decode(OutboxJson.encode(steer))!!.steerInput().references)
        val store = object : OutboxStore {
            override fun list(sessionId: String) = listOf(legacy, steer)
            override fun save(entry: OutboxEntry) = Unit
            override fun remove(sessionId: String, commandId: String) = Unit
        }
        val conflicted = NativeSendOutbox(store).find("s", "c")!!
        assertEquals(-1, conflicted.version)
        assertFailsWith<IllegalArgumentException> { conflicted.steerInput() }
    }
}
