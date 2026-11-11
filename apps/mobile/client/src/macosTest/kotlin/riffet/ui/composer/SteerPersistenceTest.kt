package riffet.ui.composer

import platform.Foundation.NSUUID
import riffet.contracts.NativeTurnTarget
import riffet.shared.NativeMessageInput
import kotlin.test.*

/** Uses unique session ids; never opens a real session or touches an existing outbox record. */
class SteerPersistenceTest {
    @Test fun v2RequestsRemainOriginBoundAcrossStoreRecreationAndInvisibleToLegacyLocation() {
        val session = "steer-test-${NSUUID().UUIDString}"
        val server = "http://steer-${NSUUID().UUIDString}.local:8077"
        val target = NativeTurnTarget("original-chat", "original-turn")
        val entry = OutboxEntry(session, NativeMessageInput("command", "keep this guidance"), "now", steerTarget = target, version = 2)
        val first = createOutboxStore(server)
        try {
            first.save(entry)
            assertEquals(listOf(entry), createOutboxStore(server).list(session))
            assertEquals(listOf(entry), createOutboxStore("$server/path").list(session), "scope follows stable origin")
            assertTrue(createOutboxStore(server.replace(":8077", ":8078")).list(session).isEmpty(), "another origin cannot replay this entry")
            assertTrue(createOutboxStore().list(session).isEmpty(), "legacy unscoped storage cannot see v2 entries")
        } finally { first.remove(session, "command") }
    }
}
