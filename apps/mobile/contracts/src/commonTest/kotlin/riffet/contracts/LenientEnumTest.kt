package riffet.contracts

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The enums a status, a job and step metrics carry decode a spelling this build does not know to
 * `UNKNOWN` instead of failing the frame, and keep the wire names the server writes.
 */
class LenientEnumTest {
    private val json = RiffetJson.instance

    private fun status(phase: String, kind: String, rate: String, tokens: String, window: String) =
        """{"phase":"$phase","interaction":{"id":"i1","revision":"1","kind":"$kind","title":"Allow?"},""" +
            """"outputRate":{"state":"$rate","windowSeconds":10.0,"outputTokens":5,"tokensPerSecond":0.5,"tokens":"$tokens","window":"$window"}}"""

    @Test
    fun knownValuesKeepTheirWireNames() {
        val payload = status("busy", "permission", "live", "provider", "stream")
        val status = json.decodeFromString(NativeStatus.serializer(), payload)
        assertEquals(NativeStatusPhase.BUSY, status.phase)
        assertEquals(NativeInteractionKind.PERMISSION, status.interaction?.kind)
        assertEquals(OutputRateState.LIVE, status.outputRate?.state)
        assertEquals(RunMetricsTokenSource.PROVIDER, status.outputRate?.tokens)
        assertEquals(MetricsWindow.STREAM, status.outputRate?.window)
        assertEquals(json.parseToJsonElement(payload), json.encodeToJsonElement(NativeStatus.serializer(), status))
    }

    @Test
    fun aNewerServersValuesCostOnlyThemselves() {
        val status = json.decodeFromString(NativeStatus.serializer(), status("hibernating", "survey", "warming", "guessed", "wall"))
        assertEquals(NativeStatusPhase.UNKNOWN, status.phase)
        assertEquals(NativeInteractionKind.UNKNOWN, status.interaction?.kind)
        assertEquals(OutputRateState.UNKNOWN, status.outputRate?.state)
        assertEquals(RunMetricsTokenSource.UNKNOWN, status.outputRate?.tokens)
        assertEquals(MetricsWindow.UNKNOWN, status.outputRate?.window)

        val job = json.decodeFromString(NativeJob.serializer(), """{"toolCallId":"t1","title":"npm test","command":"npm test","status":"paused"}""")
        assertEquals(NativeJobStatus.UNKNOWN, job.status)

        val metrics = json.decodeFromString(StepMetrics.serializer(), """{"stepId":"s","outputTokens":1,"tokens":"guessed","durationMs":1,"window":"wall","live":true}""")
        assertEquals(MetricsTokenSource.UNKNOWN, metrics.tokens)
    }
}
