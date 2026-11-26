package riffet.ui.composer

import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import riffet.contracts.AgentIds
import riffet.contracts.AgentMember
import riffet.contracts.AgentMention
import riffet.contracts.NativeBackendId
import riffet.contracts.Session
import riffet.shared.ASSISTANT_BACKENDS
import riffet.shared.RiffetApi
import riffet.shared.backends
import riffet.shared.memberOf
import riffet.shared.sortTeamMembers
import riffet.ui.state.SessionStore

/** A team member the `@` menu offers, with the project it is bound to when it has one. */
class MentionMember(val member: AgentMember, val projectName: String?)

/** An Agent the `@` menu offers. */
class MentionAgent(val backendId: NativeBackendId, val label: String)

/**
 * What `@` can name in a conversation of a server with team members (mobile.md §9.12): the members other than the
 * conversation's own, and the Agents that can run. The text is the record: [named] reads who it calls when it is sent.
 */
class MentionTargets(val members: List<MentionMember>, val agents: List<MentionAgent>) {
    fun mentionOf(target: MentionMember): AgentMention = AgentMention(
        backendId = target.member.target?.backendId ?: AgentIds.wire(ASSISTANT_BACKENDS.first()),
        memberId = target.member.id,
        label = target.member.name,
    )

    fun mentionOf(target: MentionAgent): AgentMention = AgentMention(backendId = AgentIds.wire(target.backendId), label = target.label)

    /** The `@name` tokens the field deletes whole on backspace. */
    val tokens: List<String> = members.map { "@" + it.member.name } + agents.map { "@" + it.label }

    /**
     * Who [text] calls: every target whose `@name` stands in it as a word. Read from the text when it is sent, so a
     * draft that leaves the conversation and comes back still calls who it names. A member's name wins over an Agent
     * of the same label.
     */
    fun named(text: String): List<AgentMention> {
        val memberNames = members.mapTo(mutableSetOf()) { it.member.name }
        return members.filter { mentionedIn(text, it.member.name) }.map(::mentionOf) +
            agents.filter { it.label !in memberNames && mentionedIn(text, it.label) }.map(::mentionOf)
    }
}

/** `@name` at the start or after a space, and followed by the end, a space or punctuation. */
private fun mentionedIn(text: String, name: String): Boolean =
    Regex("(?:^|\\s)@" + Regex.escape(name) + "(?=$|[\\s,.;:!?，。；：！？、])").containsMatchIn(text)

/** The targets for [session]; null where `@` does not call anyone (no team members on the server, a quick chat). */
@Composable
internal fun rememberMentionTargets(api: RiffetApi?, store: SessionStore, session: Session): MentionTargets? {
    val list by store.list.collectAsState()
    val members = list.teamMembers ?: return null
    if (session.backendId == null || session.backendId == NativeBackendId.CHAT) return null
    val backends: State<List<riffet.contracts.NativeBackendCatalogEntry>> = produceState(emptyList(), api, list.backendRevision) {
        value = api?.let { client -> runCatching { client.backends() }.getOrDefault(emptyList()) }.orEmpty()
    }
    val own = memberOf(session, list.projects, members)
    return remember(members, backends.value, own?.id, list.projects) {
        MentionTargets(
            members = sortTeamMembers(members).filter { it.archivedAt == null && it.id != own?.id }.map { member ->
                MentionMember(member, member.takeIf { it.scope.kind == "project" }
                    ?.let { m -> list.projects.firstOrNull { it.id == m.scope.projectIds?.firstOrNull() }?.name })
            },
            agents = backends.value.filter { it.available && it.backendId != NativeBackendId.CHAT }
                .map { MentionAgent(it.backendId, it.label.ifBlank { it.backendId.name }) },
        )
    }
}

/**
 * A backspace that lands inside one of the inserted [tokens] (`@name`, with the space after it) takes the whole token
 * out. Best effort: only a single-character deletion with the caret collapsed is read this way.
 */
internal fun withMentionDeleted(old: TextFieldValue, next: TextFieldValue, tokens: List<String>): TextFieldValue {
    if (tokens.isEmpty() || next.text.length != old.text.length - 1 || !next.selection.collapsed || !old.selection.collapsed) return next
    val at = next.selection.start
    if (old.text.removeRange(at, at + 1) != next.text) return next
    for (token in tokens) {
        var from = old.text.indexOf(token)
        while (from >= 0) {
            val end = from + token.length
            if (at in from..end) {
                val cut = if (end < old.text.length && old.text[end] == ' ') end + 1 else end
                return TextFieldValue(old.text.removeRange(from, cut), TextRange(from))
            }
            from = old.text.indexOf(token, from + 1)
        }
    }
    return next
}
