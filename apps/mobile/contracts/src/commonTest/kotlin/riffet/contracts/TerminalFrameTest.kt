package riffet.contracts

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * The terminal WebSocket handler on the server reads `message.type` before anything else and
 * answers `INVALID_MESSAGE` when it is missing. These tests exist because the first version of the
 * hand-written serializers dropped the discriminator on encode: `Claim("c")` became
 * `{"clientId":"c"}` and every claim, keystroke and resize would have failed at runtime while the
 * native-stream tests stayed green.
 */
class TerminalFrameTest {

    private val json = RiffetJson.instance

    @Test
    fun `every terminal client variant keeps its discriminator across a round trip`() {
        val samples: List<Pair<String, TerminalClientMessage>> = listOf(
            "claim" to TerminalClientMessage.Claim(clientId = "c1"),
            "input" to TerminalClientMessage.Input(clientId = "c1", epoch = 3, data = "ls\n"),
            "resize" to TerminalClientMessage.Resize(clientId = "c1", epoch = 3, cols = 120, rows = 40),
            "release" to TerminalClientMessage.Release(clientId = "c1", epoch = 3),
            "ack" to TerminalClientMessage.Ack(chars = TERMINAL_ACK_CHARS.toLong()),
            "paste" to TerminalClientMessage.Paste(clientId = "c1", epoch = 3, data = "a\nb"),
        )
        for ((name, sample) in samples) {
            val encoded = json.encodeToString(TerminalClientMessage.serializer(), sample)
            assertTrue(encoded.contains("\"type\":\"$name\""), "$name lost its type: $encoded")
            val decoded = json.decodeFromString(TerminalClientMessage.serializer(), encoded)
            assertEquals(sample::class, decoded::class, encoded)
            assertEquals(sample, decoded, encoded)
        }
    }

    @Test
    fun `every terminal server variant keeps its discriminator across a round trip`() {
        val terminal = TerminalInfo(
            id = "t1",
            projectId = "p1",
            title = "shell",
            kind = TerminalKind.SHELL,
            state = TerminalState.RUNNING,
            persistent = true,
            epoch = 1,
            cols = 80,
            rows = 24,
            createdAt = "2026-01-01T00:00:00Z",
            appearance = TerminalAppearance("#252525", "#fafafa"),
        )
        val samples: List<Pair<String, TerminalServerMessage>> = listOf(
            "output" to TerminalServerMessage.Output(data = "hi", sequence = 4),
            "snapshot" to TerminalServerMessage.Snapshot(data = "screen", sequence = 5, cols = 100, rows = 40, streamId = "runtime-1"),
            "state" to TerminalServerMessage.State(terminal = terminal),
            "error" to TerminalServerMessage.Error(code = "E", message = "boom"),
            "exit" to TerminalServerMessage.Exit(exitCode = 1),
            "exit" to TerminalServerMessage.Exit(),
        )
        for ((name, sample) in samples) {
            val encoded = json.encodeToString(TerminalServerMessage.serializer(), sample)
            assertTrue(encoded.contains("\"type\":\"$name\""), "$name lost its type: $encoded")
            val decoded = json.decodeFromString(TerminalServerMessage.serializer(), encoded)
            assertEquals(sample::class, decoded::class, encoded)
            assertEquals(sample, decoded, encoded)
        }
    }

    @Test
    fun `history preserves physical cell metadata and accepts legacy responses`() {
        val physical = TerminalHistory(version = "3:512:80:cells-v1", text = "row  \n   \n", cols = 80)
        val encoded = json.encodeToString(TerminalHistory.serializer(), physical)
        assertEquals(physical, json.decodeFromString(TerminalHistory.serializer(), encoded))
        val legacy = json.decodeFromString(TerminalHistory.serializer(), """{"version":"3:512","text":"old"}""")
        assertEquals(null, legacy.cols)
    }

}
