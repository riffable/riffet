package riffet.shared

import riffet.contracts.Session
import riffet.contracts.SessionReferenceInput
import riffet.contracts.Project
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import riffet.contracts.RiffetJson

/** Composer references share a rail; transport keeps files and sessions in separate fields. */
fun List<PromptContextReference>.fileReferences(): List<PromptContextReference>? =
    filter { it.kind != "session" }.takeIf { it.isNotEmpty() }

fun List<PromptContextReference>.sessionReferences(): List<SessionReferenceInput>? =
    filter { it.kind == "session" }.map { reference ->
        SessionReferenceInput(kind = "session", sessionId = requireNotNull(reference.sessionId), fromRunId = reference.fromRunId)
    }.takeIf { it.isNotEmpty() }

fun sessionReference(session: Session): PromptContextReference =
    PromptContextReference(kind = "session", sessionId = session.id, title = session.shownTitle)

/** Localize only Riffet's excerpt wrapper; saved messages and the captured blob stay untouched. */
fun sessionReferenceExcerpt(excerpt: String): String {
    if (riffet.i18n.L10n.locale == "en") return excerpt
    val request = "Request excerpt: "
    val answer = "Recent answer excerpt: "
    if (excerpt.startsWith(request)) {
        val body = excerpt.removePrefix(request)
        val boundary = body.indexOf("\n$answer")
        return if (boundary < 0) "提问节选：$body"
        else "提问节选：${body.substring(0, boundary)}\n最近回复节选：${body.substring(boundary + answer.length + 1)}"
    }
    return if (excerpt.startsWith(answer)) "最近回复节选：${excerpt.removePrefix(answer)}" else excerpt
}

/** Restoring a queued input retains its captured version, even when its source was selected again. */
fun mergeRestoredReferences(current: List<PromptContextReference>, restored: List<PromptContextReference>): List<PromptContextReference> =
    (restored + current).distinctBy { if (it.kind == "session") listOf("session", it.sessionId) else listOf("file", it.path, it.line) }

/** Search uses list metadata only; opening the picker never reads or resumes a source session. */
private fun referenceAgentName(session: Session): String = when (session.backendId) {
    riffet.contracts.NativeBackendId.CLAUDE -> "Claude"
    riffet.contracts.NativeBackendId.CODEX -> "Codex"
    riffet.contracts.NativeBackendId.CURSOR -> "Cursor"
    riffet.contracts.NativeBackendId.DSH -> "DSH"
    riffet.contracts.NativeBackendId.DROID -> "Droid"
    riffet.contracts.NativeBackendId.TRAEX -> "TRAE"
    riffet.contracts.NativeBackendId.PI -> "Pi"
    riffet.contracts.NativeBackendId.ANTIGRAVITY -> "Antigravity"
    riffet.contracts.NativeBackendId.CHAT -> "Chat"
    null -> session.agent.orEmpty()
}

fun rankedSessionReferences(sessions: List<Session>, projects: List<Project>, query: String, currentSessionId: String?, projectId: String?): List<Session> {
    val words = query.trim().lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }
    val names = projects.associate { it.id to it.name }
    fun label(session: Session) = "${session.shownTitle} ${names[session.projectId].orEmpty()} ${session.agentId ?: referenceAgentName(session)}".lowercase()
    return sessions.asSequence().filter { it.id != currentSessionId }
        .filter { session -> words.all { label(session).contains(it) } }
        .sortedWith(compareBy<Session> { if (words.isNotEmpty() && it.shownTitle.lowercase().contains(query.trim().lowercase())) 0 else 1 }
            .thenBy { if (it.archivedAt == null) 0 else 1 }
            .thenBy { if (it.projectId == projectId) 0 else 1 }
            .thenByDescending { it.lastActivityAt ?: it.createdAt })
        .take(10).toList()
}

/** Human-readable original messages from a saved reference blob, without exposing its transport JSON. */
fun sessionReferenceOriginal(raw: String): String {
    val root = RiffetJson.instance.parseToJsonElement(raw) as? JsonObject ?: return raw
    val messages = root["messages"] as? JsonArray ?: return raw
    return messages.mapNotNull { value ->
        val message = value as? JsonObject ?: return@mapNotNull null
        val text = (message["text"] as? JsonPrimitive)?.contentOrNull ?: return@mapNotNull null
        val role = (message["role"] as? JsonPrimitive)?.contentOrNull.orEmpty()
        val at = (message["at"] as? JsonPrimitive)?.contentOrNull.orEmpty()
        val label = if (riffet.i18n.L10n.locale == "en") {
            if (role == "user") "User" else "Assistant"
        } else if (role == "user") "用户" else "助手"
        "### $label $at\n\n$text"
    }.joinToString("\n\n")
}

/** Keep native text layout bounded, including a single large code block; no text is discarded. */
fun sessionReferencePages(raw: String): List<String> {
    val text = sessionReferenceOriginal(raw)
    val pages = mutableListOf<String>()
    var start = 0
    while (start < text.length) {
        var end = minOf(start + 32_000, text.length)
        if (end < text.length && text[end - 1].isHighSurrogate()) end--
        pages += text.substring(start, end)
        start = end
    }
    return pages.ifEmpty { listOf("") }
}
