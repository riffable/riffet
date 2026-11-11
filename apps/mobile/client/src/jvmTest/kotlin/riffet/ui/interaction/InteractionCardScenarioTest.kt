package riffet.ui.interaction

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import riffet.contracts.NativeInteraction
import riffet.contracts.NativeInteractionResponse
import riffet.contracts.NativeInteractionResultStatus
import riffet.contracts.RiffetJson

/** Runs the scenarios the web port runs too (`nativeInteractionCardState.test.ts`). */
class InteractionCardScenarioTest {
    private val json = RiffetJson.instance
    private val root = json.parseToJsonElement(File("fixtures/interaction-card/scenarios.json").readText()).jsonObject
    private val interactions = root.getValue("interactions").jsonObject.mapValues { json.decodeFromJsonElement(NativeInteraction.serializer(), it.value) }

    private fun draftOf(value: JsonElement) = value.jsonObject.let { draft ->
        InteractionDraft(
            revision = draft.getValue("revision").jsonPrimitive.content,
            selectedIds = draft.getValue("selectedIds").jsonArray.map { it.jsonPrimitive.content },
            otherText = draft.getValue("otherText").jsonPrimitive.content,
        )
    }

    private fun submissionOf(value: JsonObject) = InteractionSubmission(
        phase = SubmissionPhase.valueOf(value.getValue("phase").jsonPrimitive.content.uppercase()),
        interaction = interactions.getValue(value.getValue("interaction").jsonPrimitive.content),
        request = json.decodeFromJsonElement(NativeInteractionResponse.serializer(), value.getValue("request")),
        draft = draftOf(value.getValue("draft")),
    )

    private fun JsonObject.text(key: String) = get(key)?.jsonPrimitive?.contentOrNull

    private fun apply(state: InteractionCardState, step: JsonObject): InteractionCardState = when (val event = step.text("do")) {
        "none" -> state
        "interaction" -> state.interactionChanged(interactions.getValue(step.text("interaction")!!))
        "select" -> state.selectOption(step.text("id")!!)
        "other" -> state.changeOtherText(step.text("text")!!)
        "submit" -> state.submit(step.text("action")!!, step.text("requestId")!!) ?: state
        "retry" -> state.retry() ?: state
        "responded" -> state.responded(step.text("requestId")!!, NativeInteractionResultStatus.valueOf(step.text("status")!!.uppercase()), step.text("message"))
        "failed" -> state.failed(step.text("requestId")!!, step["status"]?.jsonPrimitive?.intOrNull, step.text("message"))
        "syncStarted" -> state.syncStarted()
        "syncFailed" -> state.syncFailed(step.text("message"))
        "synced" -> state.synced(step.text("fresh")?.let(interactions::getValue))
        else -> error("unknown event $event")
    }

    private fun check(where: String, state: InteractionCardState, expect: JsonObject) {
        for ((key, value) in expect) {
            val label = "$where: $key"
            fun bool() = value.jsonPrimitive.booleanOrNull
            fun text() = if (value is JsonNull) null else value.jsonPrimitive.content
            when (key) {
                "phase" -> assertEquals(text(), state.submission?.phase?.name?.lowercase(), label)
                "frozen" -> assertEquals(bool(), state.frozen, label)
                "busy" -> assertEquals(bool(), state.busy, label)
                "canRetry" -> assertEquals(bool(), state.canRetry, label)
                "canSync" -> assertEquals(bool(), state.canSync, label)
                "edited" -> assertEquals(bool(), state.edited, label)
                "storedDraft" -> assertEquals(bool(), state.storedDraft != null, label)
                "notice" -> assertEquals(text(), state.notice?.name?.lowercase(), label)
                "error" -> assertEquals(text(), state.error?.kind?.name?.lowercase(), label)
                "appliedRevision" -> assertEquals(text(), state.appliedRevision, label)
                "shownRevision" -> assertEquals(text(), state.shown.revision, label)
                "draft" -> assertEquals(draftOf(value), state.currentDraft, label)
                "request" -> assertEquals(json.decodeFromJsonElement(NativeInteractionResponse.serializer(), value), state.submission?.request, label)
                else -> error("$where: unknown expectation $key")
            }
        }
    }

    @Test
    fun everyScenario() {
        val scenarios = root.getValue("scenarios").jsonArray.map { it.jsonObject }
        assertTrue(scenarios.isNotEmpty())
        for (scenario in scenarios) {
            val name = scenario.text("name")!!
            val saved = scenario["saved"]?.jsonObject
            var state = restoreInteractionCard(
                interactions.getValue(scenario.text("interaction")!!),
                saved?.get("draft")?.let(::draftOf),
                saved?.get("submission")?.jsonObject?.let(::submissionOf),
            )
            scenario.getValue("steps").jsonArray.forEachIndexed { index, element ->
                val step = element.jsonObject
                state = apply(state, step)
                step["expect"]?.jsonObject?.let { check("$name, step ${index + 1} (${step.text("do")})", state, it) }
            }
        }
    }
}
