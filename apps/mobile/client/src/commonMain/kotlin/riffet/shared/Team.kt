package riffet.shared

import io.ktor.http.encodeURLParameter
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import riffet.contracts.AgentMember
import riffet.contracts.AgentMemberCreate
import riffet.contracts.AgentMemberUpdate
import riffet.contracts.AssistantDelegation
import riffet.contracts.AssistantDelegations
import riffet.contracts.AssistantInstructions
import riffet.contracts.AssistantInstructionsUpdate
import riffet.contracts.AssistantMemory
import riffet.contracts.AssistantSettingsUpdate
import riffet.contracts.Project
import riffet.contracts.Session
import riffet.contracts.SessionState
import riffet.ui.sessionlist.activityAt
import riffet.ui.sessionlist.isUnread

/* Team members (docs/TEAM.md): the `/api/team/…` routes and what the 团队 tab derives from the lists. */

/** One file the member left in its `files/` folder. */
@Serializable
data class AgentMemberFile(val path: String, val size: Long = 0, val modifiedAt: String)

@Serializable
private data class AgentMemberFiles(val files: List<AgentMemberFile> = emptyList())

/** `POST /api/team/members`. */
@Throws(Exception::class)
suspend fun RiffetApi.createTeamMember(input: AgentMemberCreate): AgentMember = post("/api/team/members", wireBody(input)).decode()

@Throws(Exception::class)
suspend fun RiffetApi.setTeamMemberPinned(id: String, pinned: Boolean): AgentMember =
    patch("/api/team/members/${id.enc()}", wireBody(AgentMemberUpdate(pinned = pinned))).decode()

/** Stops its background runs and takes it off the list; memory and conversations stay. */
@Throws(Exception::class)
suspend fun RiffetApi.archiveTeamMember(id: String): AgentMember =
    patch("/api/team/members/${id.enc()}", wireBody(AgentMemberUpdate(archived = true))).decode()

/** The Agent, provider and model the member's composer started a conversation with, so every device opens on them. */
@Throws(Exception::class)
suspend fun RiffetApi.rememberMemberTarget(id: String, backendId: String, profileId: String?, model: String?): AgentMember =
    patch("/api/team/members/${id.enc()}", wireBody(AgentMemberUpdate(target = buildJsonObject {
        put("backendId", JsonPrimitive(backendId))
        put("profileId", profileId?.let(::JsonPrimitive) ?: JsonNull)
        put("model", model?.takeIf { it.isNotBlank() }?.let(::JsonPrimitive) ?: JsonNull)
    }))).decode()

/** The default member cannot be deleted; the server answers 4xx for it. */
@Throws(Exception::class)
suspend fun RiffetApi.deleteTeamMember(id: String) {
    delete("/api/team/members/${id.enc()}")
}

/** `GET /api/team/members/:id/instructions`: the member's `AGENTS.md`. */
@Throws(Exception::class)
suspend fun RiffetApi.memberInstructions(id: String): AssistantInstructions = get("/api/team/members/${id.enc()}/instructions").decode()

/** A null [text] restores Riffet's own. */
@Throws(Exception::class)
suspend fun RiffetApi.saveMemberInstructions(id: String, text: String?): AssistantInstructions =
    put("/api/team/members/${id.enc()}/instructions", wireBody(AssistantInstructionsUpdate(AssistantSettingsUpdate.clearable(text)))).decode()

@Throws(Exception::class)
suspend fun RiffetApi.memberMemory(id: String): AssistantMemory = get("/api/team/members/${id.enc()}/memory").decode()

@Throws(Exception::class)
suspend fun RiffetApi.memberFiles(id: String): List<AgentMemberFile> =
    get("/api/team/members/${id.enc()}/files").decode<AgentMemberFiles>().files

/** A file's absolute URL, for a download that sends the same credentials. */
fun RiffetApi.memberFileUrl(id: String, path: String): String = "$baseUrl/api/team/members/${id.enc()}/file?path=${path.encodeURLParameter()}"

/** An image avatar's absolute URL; null for an emoji or no avatar. */
fun RiffetApi.memberAvatarUrl(member: AgentMember): String? =
    member.avatar?.takeIf { it.kind == "image" }?.url?.let { if (it.startsWith("http")) it else "$baseUrl$it" }

/** The member's delegations; one whose capabilities leave delegations off answers an empty list. */
@Throws(Exception::class)
suspend fun RiffetApi.memberDelegations(id: String): List<AssistantDelegation> =
    get("/api/team/members/${id.enc()}/delegations").decode<AssistantDelegations>().delegations

/* ---------------------------------------------------------------------------------------------- */
/* Derived from the lists                                                                         */
/* ---------------------------------------------------------------------------------------------- */

/** The web sidebar's order: pinned, then the default member, then by creation; it does not follow activity. */
fun sortTeamMembers(members: List<AgentMember>): List<AgentMember> = members
    .filter { it.archivedAt == null }
    .sortedWith(compareBy<AgentMember>({ it.pinned != true }, { !it.isDefault }, { it.createdAt }))

/**
 * The member's conversations, newest activity first: the ones it owns, and for a member with its own project the
 * conversations there that nobody else owns. Background runs and archived ones are left out.
 */
fun memberSessions(member: AgentMember, sessions: List<Session>): List<Session> = sessions
    .filter { session ->
        session.archivedAt == null && session.origin?.kind != "assistant" && (
            session.agentMemberId == member.id ||
                member.scope.kind != "project" && session.agentMemberId == null && session.origin?.kind != "call" && session.projectId == member.projectId
            )
    }
    .sortedByDescending(::activityAt)

/**
 * A `continuous` member's main conversation: the one it names, else its project's, else its newest that no one
 * called it into. Null for a `fresh` member, or when none is open (archived or deleted counts as none).
 */
fun memberMain(member: AgentMember, projects: List<Project>, sessions: List<Session>): Session? {
    if (!member.continuous) return null
    val owned = memberSessions(member, sessions)
    val named = member.mainSessionId ?: projects.firstOrNull { it.id == member.projectId }?.mainSessionId
    return named?.let { id -> owned.firstOrNull { it.id == id } } ?: owned.firstOrNull { it.origin?.kind != "call" }
}

/** What a member's row in the 团队 list shows on its right: one mark, the most urgent. */
enum class MemberRowMark { NONE, WAITING, RUNNING, UNREAD }

/** The conversation a member's row speaks for and its mark: waiting on you, running, unread, else the main or newest. */
data class MemberRowState(val session: Session?, val mark: MemberRowMark)

fun memberRowState(member: AgentMember, projects: List<Project>, sessions: List<Session>): MemberRowState {
    val owned = memberSessions(member, sessions)
    owned.firstOrNull { it.state == SessionState.WAITING }?.let { return MemberRowState(it, MemberRowMark.WAITING) }
    owned.firstOrNull { it.state == SessionState.RUNNING || it.state == SessionState.STARTING || it.state == SessionState.CANCELLING }
        ?.let { return MemberRowState(it, MemberRowMark.RUNNING) }
    owned.firstOrNull(::isUnread)?.let { return MemberRowState(it, MemberRowMark.UNREAD) }
    return MemberRowState(memberMain(member, projects, sessions) ?: owned.firstOrNull(), MemberRowMark.NONE)
}

/** Conversations blocked on the reader, by the tab that lists them: 任务's own, and the team members'. */
data class WaitingCounts(val tasks: Int, val team: Int)

/**
 * [WaitingCounts] for the tab badges. With a [team] (the server has members) a member's conversations are counted
 * under 团队, as 任务 leaves them out: those it opened, and the older ones in a member's project that carry no member.
 */
fun waitingCounts(sessions: List<Session>, projects: List<Project>, team: Boolean): WaitingCounts {
    val memberProjects = if (team) projects.filter { it.isAssistant }.mapTo(HashSet()) { it.id } else emptySet()
    var tasks = 0
    var members = 0
    for (session in sessions) {
        if (session.state != SessionState.WAITING || session.archivedAt != null) continue
        if (team && (session.agentMemberId != null || session.projectId in memberProjects)) members++ else tasks++
    }
    return WaitingCounts(tasks, members)
}

/**
 * The member a conversation belongs to: the one it names, else the owner of its standing project. Null for an
 * ordinary conversation.
 */
fun memberOf(session: Session, projects: List<Project>, members: List<AgentMember>): AgentMember? {
    session.agentMemberId?.let { id -> return members.firstOrNull { it.id == id } }
    val project = projects.firstOrNull { it.id == session.projectId } ?: return null
    if (!project.isAssistant) return null
    return project.agentMemberId?.let { id -> members.firstOrNull { it.id == id } }
        ?: members.firstOrNull { it.scope.kind != "project" && it.projectId == project.id }
        ?: members.firstOrNull { it.isDefault }
}

/** The member that called this conversation into being (`origin.kind == "call"`), when the caller is one. */
fun callerMember(session: Session, sessions: List<Session>, projects: List<Project>, members: List<AgentMember>): AgentMember? {
    if (session.origin?.kind != "call") return null
    val caller = session.origin?.sessionId?.let { id -> sessions.firstOrNull { it.id == id } } ?: return null
    return memberOf(caller, projects, members)
}
