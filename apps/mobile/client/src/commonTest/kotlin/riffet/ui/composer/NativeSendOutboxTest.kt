package riffet.ui.composer

import riffet.shared.NativeMessageInput
import riffet.shared.sessionReferences
import riffet.contracts.SessionReferenceInput
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The one non-UI piece worth protecting: the send outbox's idempotency guarantee.
 *
 * It is tested rather than left to the composer because a regression here is silent and expensive —
 * re-sending an uncertain message as a new command makes the agent run the same prompt twice, and
 * nothing in the UI would say so. The test is deliberately about the pure [NativeSendOutbox], not
 * about Compose.
 */
class NativeSendOutboxTest {

    @Test
    fun `an uncertain send stays retryable with one command id and is pruned once the server knows it`() {
        val outbox = NativeSendOutbox(InMemoryOutboxStore())
        val references = listOf(SessionReferenceInput(kind = "session", sessionId = "source-one", fromRunId = "previous-run"))
        val body = NativeMessageInput(commandId = "c1", text = "hello", references = references)

        // Persisted before the POST, and persisting twice cannot duplicate the key.
        outbox.persist(OutboxEntry("s1", body, "2024-01-01T00:00:00.000Z"))
        outbox.persist(OutboxEntry("s1", body, "2024-01-01T00:00:00.000Z"))
        assertEquals(1, outbox.entries("s1").size)

        // A retry reuses the original body, so the server returns its original receipt.
        assertEquals("hello", outbox.find("s1", "c1")?.body?.text)

        // A server run list without the command leaves the request retryable.
        assertEquals(1, outbox.reconcile("s1", setOf("other")).size)

        // A durable store has to round-trip the entry, or a relaunch loses the retry.
        val encoded = OutboxJson.encode(outbox.entries("s1").single())
        assertEquals("c1", OutboxJson.decode(encoded)?.body?.commandId)
        assertEquals(references, OutboxJson.decode(encoded)?.body?.references)
        val selected = riffet.shared.PromptContextReference(kind = "session", sessionId = "source-one", title = "Latest")
        val captured = selected.copy(fromRunId = "previous-run", title = "Saved")
        val restored = riffet.shared.mergeRestoredReferences(listOf(selected), listOf(captured))
        assertEquals(listOf(captured), restored)
        assertEquals(references, restored.sessionReferences())

        // Once the server knows the command, the retry affordance disappears: never re-sent.
        assertTrue(outbox.reconcile("s1", setOf("c1")).isEmpty())
        assertNull(outbox.find("s1", "c1"))

        // A corrupt persisted entry is dropped rather than allowed to break the composer.
        assertNull(OutboxJson.decode("{ not json"))
    }
}
