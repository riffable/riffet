package riffet.ui.timeline

import kotlinx.serialization.json.JsonObject
import riffet.core.SubagentTranscript
import riffet.core.TimelineItem
import riffet.core.toolView
import riffet.core.toolCallId
import riffet.i18n.L10n

/** The call's user-facing information, read only from that call in its parent transcript. */
data class SubagentTaskInfo(
    val title: String,
    val prompt: String?,
    val type: String?,
    /** The child's reported model, or the explicit spawn override when no child model is available. */
    val model: String?,
)

fun subagentTaskInfo(items: List<TimelineItem>, toolCallId: String): SubagentTaskInfo? =
    subagentTaskInfoWithTranscript(items, toolCallId, null)

/** Parent call fields win; the child frame fills gaps when an old parent call is outside the window. */
fun subagentTaskInfoWithTranscript(
    items: List<TimelineItem>,
    toolCallId: String,
    transcript: SubagentTranscript?,
): SubagentTaskInfo? {
    val item = items.firstOrNull { it.toolCallId() == toolCallId }
    if (item == null && transcript == null) return null
    val projected = item?.event
    val event = projected?.base
    val subagent = projected?.data?.get("subagent") as? JsonObject
    val input = event?.let { toolView(it).rawInput as? JsonObject }
    fun field(key: String): String? = (jsonText(subagent?.get(key)) ?: jsonText(input?.get(key)))
        ?.trim()?.takeIf { it.isNotEmpty() }

    val prompt = field("prompt") ?: transcript?.prompt?.trim()?.takeIf { it.isNotEmpty() }
    fun meaningful(value: String?): String? = value?.takeUnless {
        it.lowercase().filterNot { char -> char == '-' || char == '_' || char.isWhitespace() } in setOf("generalpurpose", "subagent")
    }
    val description = meaningful(field("description")) ?: meaningful(transcript?.title?.trim()?.takeIf { it.isNotEmpty() })
    val type = field("type") ?: field("subagent_type") ?: transcript?.subagentType?.trim()?.takeIf { it.isNotEmpty() }
    val title = description
        ?: meaningful(prompt?.lineSequence()?.firstOrNull { it.isNotBlank() }?.trim())
        ?: meaningful(type)
        ?: meaningful(jsonText(projected?.data?.get("title"))?.trim()?.takeIf { it.isNotEmpty() })
        ?: L10n.uiText("subagent.title")
    return SubagentTaskInfo(
        title = title,
        prompt = prompt,
        type = meaningful(type),
        // `transcript.model` comes from the child thread when the provider reported its actual
        // model. The spawning call is only a fallback, because it can request no override.
        model = transcript?.model?.trim()?.takeIf { it.isNotEmpty() } ?: field("model"),
    )
}

/** The prompt the spawning call carried, read from the parent transcript (the source of truth for it). */
fun subagentSpawningPrompt(items: List<TimelineItem>, toolCallId: String): String =
    subagentTaskInfo(items, toolCallId)?.prompt.orEmpty()
