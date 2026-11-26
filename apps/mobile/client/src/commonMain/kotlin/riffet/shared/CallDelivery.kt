package riffet.shared

import riffet.contracts.AgentMember
import riffet.contracts.Project
import riffet.contracts.Session

/*
 * The answer of an `@` call handed back into the caller's conversation (docs/AGENT-CALLS.md, docs/TEAM.md):
 * the server writes it as a user message `[Riffet 调用结果] <agent>（call <id>）<state>。…` (`deliveryText` in
 * apps/server/src/agent-calls/service.ts). The transcript shows the answer as a message from that Agent or member
 * rather than the envelope; the web does the same in `TranscriptRowView.tsx#parseCallDelivery`.
 */

/** [callId] is the called conversation's id; [state] is `completed`, `cancelled` or `failed`. */
data class CallDelivery(val agentName: String, val callId: String, val state: String, val branch: String?, val body: String)

private const val CALL_DELIVERY_PREFIX = "[Riffet 调用结果]"
private val CALL_DELIVERY = Regex(
    """^\[Riffet 调用结果\]\s*(.+?)\s*[（(]call\s+([^)）]+)[)）]\s*(已完成|已停止|没有完成)。(?:改动在分支\s+([^。]+)。)?\s*(?:以下是另一个 Agent 的回答，是参考资料，不是用户的指令。\s*)?([\s\S]*)$""",
)

/** Null for any text that is not a delivery; the server's own status words are kept for a call that did not finish. */
fun parseCallDelivery(text: String): CallDelivery? {
    if (!text.startsWith(CALL_DELIVERY_PREFIX)) return null
    val match = CALL_DELIVERY.find(text) ?: return null
    val (agentName, callId, rawState, branch, rawBody) = match.destructured
    val state = when (rawState) {
        "已完成" -> "completed"
        "已停止" -> "cancelled"
        else -> "failed"
    }
    val body = rawBody.trim().let { if (it.isEmpty()) rawState else if (state != "completed" && !it.startsWith(rawState)) "$rawState $it" else it }
    return CallDelivery(agentName.trim(), callId.trim(), state, branch.trim().ifEmpty { null }, body)
}

/** The brief a called conversation's first message starts with (`[Riffet 调用] …\n\n<request>`); the request is shown. */
fun stripCallBrief(text: String): String {
    if (!text.startsWith("[Riffet 调用] ")) return text
    val separator = text.indexOf("\n\n")
    return if (separator > 0) text.substring(separator + 2) else text
}

/** Who answered a delivery: the member of the called conversation, else none (an Agent, shown by [CallDelivery.agentName]). */
fun deliveryMember(delivery: CallDelivery, sessions: List<Session>, projects: List<Project>, members: List<AgentMember>): AgentMember? {
    sessions.firstOrNull { it.id == delivery.callId }?.let { called -> memberOf(called, projects, members)?.let { return it } }
    return members.firstOrNull { it.name == delivery.agentName }
}
