package riffet.contracts

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/* Ported from packages/contracts/src/index.ts: filesystem, git, checkpoint and settings types. */

@Serializable
data class FileEntry(
    val path: String,
    val name: String,
    val kind: FileEntryKind,
    val size: Long? = null,
    val modifiedAt: String? = null,
)

@Serializable
enum class FileEntryKind {
    @SerialName("file") FILE,
    @SerialName("directory") DIRECTORY,
}

@Serializable
data class FilePreview(
    val path: String,
    val content: String,
    val hash: String,
    val size: Long,
    val binary: Boolean,
    val truncated: Boolean,
    val image: FilePreviewImage? = null,
    val render: FilePreviewRender? = null,
)

@Serializable
data class FilePreviewRender(val kind: String)

@Serializable
data class FilePreviewImage(val mimeType: String)

@Serializable
data class SearchHit(
    val path: String,
    val line: Long,
    val text: String,
)

/** `added`/`removed` count lines against HEAD; both are absent for binary or uncounted files. */
@Serializable
data class GitEntry(
    val path: String,
    val originalPath: String? = null,
    val index: String,
    val worktree: String,
    val added: Long? = null,
    val removed: Long? = null,
)

@Serializable
data class GitStatus(
    val branch: String,
    val entries: List<GitEntry>,
    val root: String,
    val added: Long? = null,
    val removed: Long? = null,
)

@Serializable
data class GitDiff(
    val path: String,
    val before: String,
    val after: String,
    val patch: String,
    val binary: Boolean,
    val truncated: Boolean? = null,
)

@Serializable
data class Checkpoint(
    val id: String,
    val projectId: String,
    val sessionId: String? = null,
    /** The turn this checkpoint was taken before, for the per-turn checkpoints of a conversation. */
    val runId: String? = null,
    val title: String,
    val createdAt: String,
    val files: Long,
    val excluded: List<String>,
)

@Serializable
data class CheckpointChange(
    val path: String,
    val kind: CheckpointChangeKind,
    val beforeHash: String? = null,
    val afterHash: String? = null,
)

@Serializable
enum class CheckpointChangeKind {
    @SerialName("added") ADDED,
    @SerialName("modified") MODIFIED,
    @SerialName("deleted") DELETED,
}

@Serializable
data class WorktreeInfo(
    val path: String,
    val branch: String? = null,
    val head: String,
    val bare: Boolean? = null,
    val current: Boolean? = null,
    val managed: Boolean? = null,
    val createdAt: String? = null,
)

@Serializable
data class ConfigFile(
    val id: String,
    val label: String,
    val path: String,
    val scope: ConfigScope,
    val kind: ConfigKind,
    val exists: Boolean,
    val content: String? = null,
    val hash: String? = null,
)

@Serializable
enum class ConfigScope {
    @SerialName("project") PROJECT,
    @SerialName("user") USER,
}

@Serializable
enum class ConfigKind {
    @SerialName("rules") RULES,
    @SerialName("skills") SKILLS,
    @SerialName("commands") COMMANDS,
    @SerialName("mcp") MCP,
    @SerialName("hooks") HOOKS,
    @SerialName("cli") CLI,
    @SerialName("worktrees") WORKTREES,
}

/* --------------------------------------------------------------------------------------------- */
/* Bootstrap and settings, as returned by `GET /api/bootstrap` and `GET /api/settings`.           */
/* --------------------------------------------------------------------------------------------- */

@Serializable
data class Bootstrap(
    val projects: List<Project>,
    val sessions: List<Session>,
    val terminals: List<TerminalInfo>,
    val settings: AppSettings,
    /** Present for cookie-authenticated browsers; a Bearer client never uses it. */
    val csrfToken: String? = null,
    /** Absent from a server that predates 个人资料. */
    val owner: OwnerInfo? = null,
    /** The server's protocol features; absent from one that predates them. */
    val protocol: BootstrapProtocol? = null,
)

@Serializable
data class BootstrapProtocol(val version: Int = 0, val features: List<String> = emptyList())

@Serializable
data class AppSettings(
    val taskWorkspaceRoot: String? = null,
    val editorCommand: String? = null,
    val defaultModel: String? = null,
    val defaultMode: String? = null,
    val notifications: Boolean? = null,
    val allowOutsideRead: Boolean? = null,
    val cursorCli: CursorCliSettings? = null,
    val defaultBackendId: NativeBackendId? = null,
    val nativeBackendDefaults: Map<NativeBackendId, NativeBackendDefaults>? = null,
    /** `newline` (default: Enter breaks the line, Cmd+Enter sends) or `send`. Account-wide. */
    val composerEnterBehavior: String? = null,
    /** `queue` (default) or `steer` for ordinary sends while a task runs. Account-wide. */
    val composerRunningBehavior: String? = null,
    /** Shows send later beside the composer's send button. Off unless set. */
    val composerSendLater: Boolean? = null,
    /** The gateway model for each side job (titles, handoff summaries); a missing purpose uses none. */
    val auxiliaryModels: AuxiliaryModels? = null,
    /** Minutes an unused conversation CLI may sit idle before the server stops it; null is 360, 0 never. */
    val idleReclaimMinutes: Int? = null,
    /** Most conversation CLIs kept running; past it the least recently used idle ones stop. null is 24, 0 no limit. */
    val maxLiveAgents: Int? = null,
    /** Quick chat retention, open mode and presets; null means the server's defaults. */
    val quickChat: QuickChatSettings? = null,
    /** [defaultBackendId] and the plugin entries of [nativeBackendDefaults], for ids the enum cannot hold; see [AgentIds]. */
    val defaultAgentId: String? = null,
    val agentDefaults: Map<String, NativeBackendDefaults>? = null,
) {
    /** The Agent new sessions start on, built-in or a plugin's; null when none was chosen. */
    val defaultAgent: String? get() = defaultAgentId ?: defaultBackendId?.let(AgentIds::wire)

    /** What was saved for an Agent, whichever kind it is. */
    fun defaultsFor(agent: String): NativeBackendDefaults? =
        agentDefaults?.get(agent) ?: AgentIds.builtin(agent)?.let { nativeBackendDefaults?.get(it) }
}

/** One model per side job: [title] writes conversation titles, [handoff] the summary a handoff opens with, [chat] starts new quick chats, [summary] the canvas's turn summaries. */
@Serializable
data class AuxiliaryModels(
    val title: AuxiliaryModelRef? = null,
    val handoff: AuxiliaryModelRef? = null,
    val chat: AuxiliaryModelRef? = null,
    val summary: AuxiliaryModelRef? = null,
)

/**
 * A quick chat preset, shown as a chat mode (`preset:<id>`). [id] is server-validated
 * (`[a-z0-9-]{1,32}`), [name] is at most 20 characters and [prompt] at most 4000.
 */
@Serializable
data class QuickChatPreset(val id: String, val name: String, val prompt: String)

/**
 * Quick chat settings. [retentionDays] null is 7, 0 never, and the server caps it at 365.
 * [openMode] is `sheet` (default) or `page`; [presets] is the effective list the server always
 * returns, with null only from a server that predates presets.
 */
@Serializable
data class QuickChatSettings(
    val retentionDays: Int? = null,
    val openMode: String? = null,
    val presets: List<QuickChatPreset>? = null,
)

/** A model behind one backend profile's gateway, as `AppSettings.auxiliaryModels` stores it. */
@Serializable
data class AuxiliaryModelRef(val backendId: NativeBackendId, val profileId: String, val model: String)

/** One choice for an auxiliary model, with the profile it is listed under. */
@Serializable
data class AuxiliaryModelOption(val backendId: NativeBackendId, val profileId: String, val model: String, val profileName: String)

/** `GET /api/projects/:id/archive?check=1`: what a ZIP of [name] would hold. */
@Serializable
data class ArchiveInfo(val name: String, val files: Long, val bytes: Long)

@Serializable
data class CursorCliSettings(
    val executable: String? = null,
    val configDir: String? = null,
    val apiEndpoint: String? = null,
    val agentEndpoint: String? = null,
    val disableAutoUpdate: Boolean? = null,
    /** Read-only status of the server-saved key. */
    val hasApiKey: Boolean? = null,
)

@Serializable
data class NativeBackendDefaults(
    val profileId: String? = null,
    val model: String? = null,
    val mode: String? = null,
    val approval: String? = null,
)

/** `GET /api/sessions/:id/native/models` returns the CLI's own model list. */
@Serializable
data class NativeModelOption(
    val value: String,
    val name: String,
)

/* --------------------------------------------------------------------------------------------- */
/* Publishing: branch state, push, pull request and worktree merge.                               */
/* --------------------------------------------------------------------------------------------- */

/** `upstream` is absent until the branch is first pushed; `ahead`/`behind` then count against it. */
@Serializable
data class BranchInfo(
    val branch: String,
    val head: String? = null,
    val upstream: String? = null,
    val ahead: Long = 0,
    val behind: Long = 0,
    val remotes: List<String> = emptyList(),
)

@Serializable
data class PushResult(val branch: BranchInfo, val output: String = "")

/** [strategy] is `merge` or `squash`. */
@Serializable
data class MergeResult(
    val merged: Boolean,
    val strategy: String,
    val branch: String,
    val into: String,
    val head: String? = null,
    val commits: Long = 0,
    val removedWorktree: Boolean? = null,
)

/** [state] is `pending`, `success`, `failure`, `neutral` or `skipped`. */
@Serializable
data class PullRequestCheck(val name: String, val state: String, val url: String? = null)

/** [state] is `none` when the repository runs no checks on the pull request; otherwise a check state. */
@Serializable
data class PullRequestChecks(val state: String = "none", val items: List<PullRequestCheck> = emptyList())

/** [state] is `OPEN`, `CLOSED` or `MERGED`. */
@Serializable
data class PullRequestInfo(
    val number: Long,
    val url: String,
    val title: String,
    val state: String,
    val isDraft: Boolean = false,
    val headRefName: String,
    val baseRefName: String,
    val mergeable: String? = null,
    val reviewDecision: String? = null,
    val checks: PullRequestChecks = PullRequestChecks(),
)

/** `pullRequest` is null when the branch has none yet. */
@Serializable
data class PullRequestStatus(val branch: BranchInfo, val pullRequest: PullRequestInfo? = null)
