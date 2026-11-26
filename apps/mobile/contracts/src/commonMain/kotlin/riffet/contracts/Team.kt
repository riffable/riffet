package riffet.contracts

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/* Ported from packages/contracts/src/team.ts: standing team members (docs/TEAM.md). */

/** The member migrated from the single 个人助理; it cannot be deleted. */
const val DEFAULT_AGENT_MEMBER_ID = "default"

/** The protocol feature a server with team members declares. */
const val TEAM_MEMBERS_FEATURE = "team-members"

/** [kind] is `emoji` (with [value]) or `image` (with [url], served under `/api/team/members/:id/avatar`). */
@Serializable
data class AgentMemberAvatar(val kind: String, val value: String? = null, val url: String? = null)

/** [kind] is `global`, `personal` or `project`; [projectIds] are the bound projects of a `project` member. */
@Serializable
data class AgentMemberScope(val kind: String, val projectIds: List<String>? = null)

@Serializable
data class AgentMemberTarget(
    /** A wire id, kept as a string so a member on an Agent this client does not know still decodes. */
    val backendId: String? = null,
    val profileId: String? = null,
    val model: String? = null,
    val permissionMode: String? = null,
)

@Serializable
data class AgentMemberCapabilities(
    val workspace: Boolean = false,
    val taskBoard: Boolean = false,
    val delegations: Boolean = false,
    val memberCalls: Boolean = false,
    val externalTools: Boolean = false,
    val workbenchAdmin: Boolean = false,
)

@Serializable
data class AgentMemberMemorySettings(val consolidation: Boolean = true)

@Serializable
data class AgentMemberBudget(val dailyRuns: Int = 0)

/**
 * A standing team member. [sessionMode] is `continuous` (one main conversation, [mainSessionId]) or `fresh`
 * (a new conversation each time). [projectId] is its own system project for `personal`/`global` members and the
 * first bound project for `project` ones.
 */
@Serializable
data class AgentMember(
    val id: String,
    val name: String,
    val avatar: AgentMemberAvatar? = null,
    val description: String? = null,
    val scope: AgentMemberScope,
    val sessionMode: String,
    val target: AgentMemberTarget? = null,
    val capabilities: AgentMemberCapabilities = AgentMemberCapabilities(),
    val memory: AgentMemberMemorySettings = AgentMemberMemorySettings(),
    val budget: AgentMemberBudget = AgentMemberBudget(),
    val projectId: String,
    val mainSessionId: String? = null,
    val pinned: Boolean? = null,
    val archivedAt: String? = null,
    val createdAt: String,
    val updatedAt: String,
) {
    val isDefault: Boolean get() = id == DEFAULT_AGENT_MEMBER_ID
    val continuous: Boolean get() = sessionMode == "continuous"
}

@Serializable
data class AgentMemberList(val members: List<AgentMember> = emptyList())

/** `{ kind: 'emoji', value }`: the only avatar input the phone sends. */
@Serializable
data class AgentMemberAvatarInput(val kind: String, val value: String)

/** `POST /api/team/members`: what the phone's 新建成员 page fills in; the rest takes the scope's defaults. */
@Serializable
data class AgentMemberCreate(
    val name: String,
    val avatar: AgentMemberAvatarInput? = null,
    val instructions: String? = null,
    val scope: AgentMemberScope,
    val sessionMode: String? = null,
    val target: AgentMemberTarget? = null,
)

/** `PATCH /api/team/members/:id`: each field given replaces its own. */
@Serializable
data class AgentMemberUpdate(
    val pinned: Boolean? = null,
    val archived: Boolean? = null,
    /** An object of [AgentMemberTarget]'s fields, a JSON `null` in one clearing it. */
    val target: JsonElement? = null,
)
