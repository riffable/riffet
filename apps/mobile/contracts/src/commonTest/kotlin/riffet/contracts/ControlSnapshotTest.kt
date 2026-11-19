package riffet.contracts

import kotlinx.serialization.encodeToString
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** `SessionControlSnapshot` and the turn statuses the dispatch control plane added. */
class ControlSnapshotTest {
    private val json = RiffetJson.instance

    @Test
    fun controlFrameRoundTripsAndHelloCarriesTheSnapshot() {
        val snapshot = SessionControlSnapshot(
            revision = 3,
            runtime = "ready",
            activeTurn = ActiveTurnState(turnId = "turn-1", phase = "running", canStop = true, canSteer = false),
            inbox = listOf(
                InboxEntry(
                    id = "run-1",
                    commandId = "cmd-1",
                    kind = "message",
                    placement = "sending",
                    status = "sending",
                    prompt = NativeRunInput("hello", emptyList(), emptyList()),
                    createdAt = "2026-01-01T00:00:00.000Z",
                    updatedAt = "2026-01-01T00:00:00.000Z",
                    actions = emptyList(),
                ),
            ),
            capabilities = SessionControlCapabilities(canStop = true, canSteer = false, canSendNow = false),
            activity = NativeActivitySummary(compacting = true, background = 2),
        )
        val frame = SyncFrame.Control(snapshot)
        val encoded = json.encodeToString(SyncFrame.serializer(), frame)
        assertTrue(encoded.contains("\"type\":\"control\""))
        assertEquals(frame, json.decodeFromString(SyncFrame.serializer(), encoded))

        val hello = SYNC_MIN_FIXTURES.first { it.first == "frame:hello" }.second
        assertNull(assertIs<SyncFrame.Hello>(json.decodeFromString(SyncFrame.serializer(), hello)).control)
        val withControl = hello.dropLast(1) +
            ""","control":{"revision":7,"runtime":"ready","inbox":[],"capabilities":{"canStop":true,"canSteer":false,"canSendNow":false},"activity":{"compacting":true,"background":1}}}"""
        val decoded = assertIs<SyncFrame.Hello>(json.decodeFromString(SyncFrame.serializer(), withControl))
        assertEquals(7L, decoded.control?.revision)
        assertEquals(true, decoded.control?.activity?.compacting)
        assertEquals(decoded, json.decodeFromString(SyncFrame.serializer(), json.encodeToString(SyncFrame.serializer(), decoded)))
    }

    @Test
    fun turnStatusDecodesInterruptedAndOutcomeUnknown() {
        assertEquals(TurnOutlineV3.Status.INTERRUPTED, outline("interrupted").status)
        assertEquals(TurnOutlineV3.Status.OUTCOME_UNKNOWN, outline("outcome_unknown").status)
        val interrupted = outline("interrupted")
        val encoded = json.encodeToString(TurnOutlineV3.serializer(), interrupted)
        assertTrue(encoded.contains("\"status\":\"interrupted\""))
        assertEquals(interrupted, json.decodeFromString(TurnOutlineV3.serializer(), encoded))
    }

    private fun outline(status: String): TurnOutlineV3 =
        json.decodeFromString(TurnOutlineV3.serializer(), """{"turn":"t","turnId":"t","startPos":0,"status":"$status","at":"2026-01-01T00:00:00.000Z","rows":1}""")
}
