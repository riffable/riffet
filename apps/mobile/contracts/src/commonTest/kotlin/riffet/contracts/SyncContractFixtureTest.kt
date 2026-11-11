package riffet.contracts

import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs

/**
 * Decodes the v3 sync fixtures of `scripts/gen-timeline-fixtures.ts`: `max` and `min` must decode to
 * known variants and encode back without losing a field, `future` must decode with whatever this
 * build does not know turned into `Unknown`.
 */
class SyncContractFixtureTest {

    private val json = RiffetJson.instance
    private val future = SYNC_FUTURE_FIXTURES.toMap()

    @Test
    fun maxAndMinDecodeToKnownVariantsAndKeepTheirFields() {
        val lost = (SYNC_MAX_FIXTURES + SYNC_MIN_FIXTURES).flatMap { (name, payload) ->
            val wire = json.parseToJsonElement(payload)
            val value = json.decodeFromJsonElement(serializerFor(name), wire)
            assertFalse(hasUnknown(value), "$name decoded to Unknown")
            lostFields(wire, json.encodeToJsonElement(serializerFor(name), value), name)
        }
        assertEquals(emptyList(), lost.filter { path -> UNMODELLED_FIELDS.none { it in path } })
    }

    @Test
    fun futureFieldsAreIgnored() {
        val lost = SYNC_MAX_FIXTURES.flatMap { (name, payload) ->
            val value = json.decodeFromString(serializerFor(name), future.getValue(name))
            assertFalse(hasUnknown(value), "$name decoded to Unknown")
            lostFields(json.parseToJsonElement(payload), json.encodeToJsonElement(serializerFor(name), value), name)
        }
        assertEquals(emptyList(), lost.filter { path -> UNMODELLED_FIELDS.none { it in path } })
    }

    @Test
    fun futureKindsTypesAndValuesBecomeUnknown() {
        val payload = future.getValue("row:unknown-kind")
        val row = json.decodeFromString(TimelineRow.serializer(), payload)
        assertEquals("canvas", assertIs<TimelineRow.Body.Unknown>(row.body).kind)
        assertEquals("canvas:1", row.key)
        assertEquals(json.parseToJsonElement(payload), json.encodeToJsonElement(TimelineRow.serializer(), row))
        assertEquals("presence", assertIs<SyncFrame.Unknown>(frame("frame:unknown-type")).type)

        val bodies = assertIs<SyncFrame.Rows>(frame("frame:unknown-values")).upserts.map { it.body }
        assertEquals(TimelineRow.Pending.UNKNOWN, assertIs<TimelineRow.Body.User>(bodies[0]).pending)
        assertEquals(TimelineRow.Phase.UNKNOWN, assertIs<TimelineRow.Body.Assistant>(bodies[1]).phase)
        assertEquals(TimelineRow.ReasoningChannel.UNKNOWN, assertIs<TimelineRow.Body.Thought>(bodies[2]).channel)
        assertEquals(TimelineRow.Tone.UNKNOWN, assertIs<TimelineRow.Body.Status>(bodies[3]).tone)
        val task = assertIs<TimelineRow.Body.TaskNotification>(bodies[4])
        assertEquals(TimelineRow.TaskNotificationStatus.UNKNOWN, task.status)
        assertEquals(TimelineRow.TaskNotificationResult.Status.UNKNOWN, task.jobResult?.status)
        // A job status this build does not know is the job's own `unknown`; the row stays.
        assertEquals(NativeJobStatus.UNKNOWN, assertIs<TimelineRow.Body.Tool>(bodies[5]).job?.status)
        assertEquals("canvas", assertIs<TimelineRow.Body.Unknown>(bodies[6]).kind)

        assertEquals(TurnOutlineV3.Status.UNKNOWN, assertIs<SyncFrame.Outline>(frame("frame:outline-unknown-status")).turns.single().status)
        assertEquals(SyncFrame.Reset.Reason.UNKNOWN, assertIs<SyncFrame.Reset>(frame("frame:reset-unknown-reason")).reason)
        assertEquals(SyncMode.UNKNOWN, json.decodeFromString(TimelineChanges.serializer(), future.getValue("changes:unknown-mode")).mode)
    }

    private fun frame(name: String): SyncFrame = json.decodeFromString(SyncFrame.serializer(), future.getValue(name))

    @Suppress("UNCHECKED_CAST")
    private fun serializerFor(name: String): KSerializer<Any> = when (name.substringBefore(':')) {
        "frame" -> SyncFrame.serializer()
        "row" -> TimelineRow.serializer()
        "page" -> TimelinePage.serializer()
        "changes" -> TimelineChanges.serializer()
        else -> error("no serializer for $name")
    } as KSerializer<Any>

    private fun hasUnknown(value: Any): Boolean = value is SyncFrame.Unknown || when (value) {
        is TimelineRow -> listOf(value)
        is SyncFrame.Snapshot -> value.rows
        is SyncFrame.Rows -> value.upserts
        is TimelinePage -> value.rows
        is TimelineChanges -> value.rows
        else -> emptyList()
    }.any { it.body is TimelineRow.Body.Unknown }
}

/** Paths present in [wire] that are absent or different in [back]; numbers compare by value. */
internal fun lostFields(wire: JsonElement, back: JsonElement?, path: String): List<String> = when (wire) {
    is JsonObject -> wire.flatMap { (key, value) -> lostFields(value, (back as? JsonObject)?.get(key), "$path.$key") }
    is JsonArray -> wire.flatMapIndexed { index, value -> lostFields(value, (back as? JsonArray)?.getOrNull(index), "$path[$index]") }
    is JsonNull -> emptyList()
    is JsonPrimitive -> {
        val other = back as? JsonPrimitive
        val same = other != null && if (wire.isString) other.isString && other.content == wire.content
        else !other.isString && (wire.doubleOrNull?.let { it == other.doubleOrNull } ?: (wire.content == other.content))
        if (same) emptyList() else listOf(path)
    }
}

/** Fields of the TS contract the phone does not model, matched anywhere in a path. Keep this short and explained. */
internal val UNMODELLED_FIELDS = listOf(
    // Server-side dispatch bookkeeping on `NativeRunDetails`; neither client reads them.
    ".native.expectsTurnOutcome",
    ".native.slashCommand",
    ".native.checkpointAttempted",
    // Server-side launch and binding bookkeeping on `Session`; neither client reads them.
    ".session.previousNativeSessionIds",
    ".session.quickExitCount",
    ".session.nativeRuntime",
    ".session.configPending",
)
