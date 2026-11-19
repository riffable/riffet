package riffet.contracts

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject

/*
 * Settings and native-backend DTOs ported from `packages/contracts/src/index.ts`, which is the
 * authoritative source of the wire types. Additive: nothing here changes an existing type.
 *
 * The same rules as `Models.kt` apply: a TS `?` is a nullable Kotlin field with `= null`, a field
 * the server always sends stays non-null, and `@SerialName` covers every renamed key.
 *
 * One place TS is richer than a plain nullable Kotlin field: `NativeBackendProfileSettingsUpdate`
 * types `apiKey`, `enabledModels` and `modelInputModalities` (and `CursorCliSettingsUpdate` its
 * `apiKey` and `enabledModels`) as `X | null` *and* optional, and the server distinguishes the
 * three states (absent leaves the stored value alone, JSON `null` clears it, a value sets it). The
 * shared [RiffetJson] drops nulls, so a plain `String?`/`List?` could not send the clearing `null`;
 * those fields are therefore [JsonElement], where the default `null` means "absent" and `JsonNull`
 * means "clear". Use [PatchValue.key], [PatchValue.list] and [PatchValue.modalities] to build them
 * rather than assigning them directly.
 */

/** A native model's configurable control. `type` is always `select` on today's server. */
@Serializable
data class ModelConfigOption(
    val id: String,
    val name: String,
    val description: String? = null,
    val category: String? = null,
    val type: String,
    val currentValue: String,
    val options: List<ModelConfigOptionValue> = emptyList(),
)

@Serializable
data class ModelConfigOptionValue(
    val value: String,
    val name: String,
    val description: String? = null,
)

@Serializable
data class NativeModelVariant(
    val value: String,
    val name: String,
)

@Serializable
data class ModelInfo(
    val value: String,
    val name: String,
    val configOptions: List<ModelConfigOption> = emptyList(),
    /** Exact CLI-listed variants behind the generated controls. */
    val nativeVariants: List<NativeModelVariant>? = null,
    /** Provider-declared context/input token limit; absent when the catalog declares none. */
    val contextWindow: Long? = null,
    /** Provider-declared identities, including selectors saved before a rename. */
    val aliases: List<String>? = null,
)

/** One metered usage window, as the share of it already used. */
@Serializable
data class UsageWindow(
    val usedPercent: Int = 0,
    /** Length of the window (300 is five hours, 10080 a week). */
    val windowMinutes: Int? = null,
    /** ISO time the window resets. */
    val resetsAt: String? = null,
)

@Serializable
data class ModelQuota(
    val usedPercent: Int = 0,
    val windowMinutes: Int? = null,
    val resetsAt: String? = null,
    val remaining: Int? = null,
    val limit: Int? = null,
    val depleted: Boolean = false,
)

/** A daily soft quota; exhaustion lowers request priority instead of disabling the model. */
@Serializable
data class ModelDailyQuota(
    val usedPercent: Int = 0,
    val windowMinutes: Int? = null,
    val resetsAt: String? = null,
    val remaining: Double,
    val limit: Double,
    val depleted: Boolean = false,
)

/** A model's live standing at its provider; every field is absent when the provider did not report it. */
@Serializable
data class ModelStatus(
    /** Above 100 means requests wait in the provider's queue. */
    val loadPercent: Int? = null,
    val quota: ModelQuota? = null,
    val quotaLimited: Boolean? = null,
    val dailyQuotaKey: String? = null,
    val dailyQuota: ModelDailyQuota? = null,
)

@Serializable
data class UsageCredits(val balance: Double? = null, val unlimited: Boolean = false)

@Serializable
data class AccountUsage(
    val plan: String? = null,
    val windows: List<UsageWindow> = emptyList(),
    val credits: UsageCredits? = null,
    val limitReached: Boolean = false,
)

/** `GET /api/backends/:id/usage`: account quota, and per-model status keyed by [ModelInfo.value]. */
@Serializable
data class NativeBackendUsage(
    val account: AccountUsage? = null,
    val models: Map<String, ModelStatus> = emptyMap(),
    val fetchedAt: String? = null,
)

@Serializable
data class NativeBackendOption(
    val id: String,
    val label: String,
    /** The name a toolbar shows when [label] would not fit beside the model. */
    val shortLabel: String? = null,
    val description: String? = null,
)

/** Public profile metadata. Runtime secrets and provider-specific settings stay on the server. */
@Serializable
data class NativeBackendProfile(
    val id: String,
    val backendId: NativeBackendId,
    val name: String,
    val description: String? = null,
    val isDefault: Boolean? = null,
    val agentId: String? = null,
) {
    val agent: String get() = agentId ?: AgentIds.wire(backendId)
}

/** Safe editable profile fields. Credentials are write-only; responses report only `hasApiKey`. */
@Serializable
data class NativeBackendProfileSettings(
    val id: String,
    val backendId: NativeBackendId,
    val name: String,
    val description: String? = null,
    val isDefault: Boolean? = null,
    val executable: String? = null,
    val configDir: String? = null,
    val sourceDir: String? = null,
    val apiEndpoint: String? = null,
    val agentEndpoint: String? = null,
    val disableAutoUpdate: Boolean? = null,
    val defaultModel: String? = null,
    val hasApiKey: Boolean? = null,
    /**
     * Model ids offered in session pickers. `null` means the whole catalog — a freshly configured
     * endpoint is usable before anyone curates it — while an empty list is an explicit empty
     * selection. The two are not interchangeable.
     */
    val enabledModels: List<String>? = null,
    /**
     * Input types per model id, for the ids a user had to answer for. DSH matches a model by exact
     * id against its own catalog and treats an unknown id as text-only, replacing every image with
     * a text placeholder before the request leaves; a gateway serves ids DSH has never heard of, so
     * this is the only way to say one takes images. An absent entry keeps the backend's own answer.
     */
    val modelInputModalities: Map<String, List<String>>? = null,
    /**
     * Context window in tokens per model id, for the ids whose gateway does not say. Claude Code is
     * the consumer: a window of 1M or more is what offers a model's 1M variant. A declaration
     * replaces the gateway's figure; an absent entry keeps it.
     */
    val modelContextWindows: Map<String, Long>? = null,
    /** Named model gateway; absent profiles keep the CLI's own login or explicit endpoint. */
    val modelSource: String? = null,
    /** Wire API a custom provider speaks; absent keeps the backend's own default. */
    val apiProtocol: String? = null,
)

/**
 * A PATCH body for one provider profile.
 *
 * Every field defaults to "absent": the server leaves the stored value alone. `apiKey`,
 * `enabledModels` and `modelInputModalities` additionally accept JSON `null`, which drops the stored
 * credential, restores the uncurated full catalog, or drops every declaration; build those with
 * [PatchValue].
 */
@Serializable
data class NativeBackendProfileSettingsUpdate(
    val name: String? = null,
    val description: String? = null,
    val executable: String? = null,
    val configDir: String? = null,
    val sourceDir: String? = null,
    val apiEndpoint: String? = null,
    val agentEndpoint: String? = null,
    val disableAutoUpdate: Boolean? = null,
    val defaultModel: String? = null,
    /** `null` (the default) leaves the list alone; [PatchValue.list] with `null` restores all. */
    val enabledModels: JsonElement? = null,
    /**
     * `null` (the default) leaves the declarations alone; [PatchValue.modalities] with `null` drops
     * every one of them, which is the only value that restores the backend's own answer.
     */
    val modelInputModalities: JsonElement? = null,
    /** `null` (the default) leaves the declarations alone; [PatchValue.contextWindows] with `null` drops them all. */
    val modelContextWindows: JsonElement? = null,
    /** `null` (the default) leaves the stored key alone; `JsonNull` drops it. */
    val apiKey: JsonElement? = null,
    /** Absent preserves the source; [PatchValue.key] with `null` returns to CLI/custom login. */
    val modelSource: JsonElement? = null,
    /** Absent preserves the protocol; [PatchValue.key] with `null` restores the default API. */
    val apiProtocol: JsonElement? = null,
)

@Serializable
data class NativeBackendProfilesResponse(
    val profiles: List<NativeBackendProfileSettings> = emptyList(),
    val defaultProfileId: String? = null,
)

/** `POST /api/backends/:id/model-probe` answers with the models a gateway currently serves. */
@Serializable
data class NativeBackendModelProbeResponse(
    val models: List<ModelInfo> = emptyList(),
)

@Serializable
data class NativeBackendSlashCommand(
    val name: String,
    val description: String? = null,
    val hint: String? = null,
)

@Serializable
enum class NativeInteractionTransport {
    @SerialName("terminal") TERMINAL,
    @SerialName("protocol") PROTOCOL,
    @SerialName("both") BOTH,
    @SerialName("none") NONE,
}

@Serializable
data class NativeBackendCapabilities(
    val backendId: NativeBackendId,
    val label: String,
    val modes: List<NativeBackendOption> = emptyList(),
    val permissions: List<NativeBackendOption> = emptyList(),
    val interactionTransport: NativeInteractionTransport,
    val supportsResume: Boolean,
    val supportsInterrupt: Boolean,
    val supportsHistory: Boolean,
    val supportsModelSelection: Boolean,
    val supportsModeSelection: Boolean,
    val supportsPermissionSelection: Boolean,
    val supportsTerminal: Boolean? = null,
    /** This conversation can accept messages only while its native terminal runs. */
    val requiresLiveTerminal: Boolean? = null,
    val supportsPrewarm: Boolean? = null,
    /** The backend can take a brand-new session's first user message as a launch argument. */
    val supportsInitialPromptArgs: Boolean? = null,
    val slashCommands: List<NativeBackendSlashCommand>? = null,
    /** Leading slash command (without `/`) that triggers manual context compaction; null when unsupported. */
    val compactCommand: String? = null,
    /** A skill named mid-message is invoked, not only one that opens the message. */
    val inlineSkills: Boolean? = null,
    val supportsSteer: Boolean = false,
    val supportsRecovery: Boolean? = null,
    val supportsTargetedStop: Boolean? = null,
    /** Gateway protocols a model source must serve to be offered; null from a server that predates it. */
    val consumesProtocols: List<String>? = null,
    val agentId: String? = null,
    val supportsSessionReferences: Boolean? = null,
    /** The CLI can be launched with Riffet's tool groups (docs/DEVICES.md §2); Cursor and the quick chat cannot. */
    val supportsRiffetTools: Boolean = false,
    /** Which installed extensions a conversation can switch off; null when neither. */
    val extensionToggles: ExtensionToggles? = null,
) {
    val agent: String get() = agentId ?: AgentIds.wire(backendId)
}

/** One entry of the composer's `/` menu. */
@Serializable
data class NativeSlashItem(
    val name: String,
    val description: String? = null,
    val hint: String? = null,
    /** `command` only works as the message's first token; `skill` may also be named mid-message. */
    val kind: String = "command",
    val path: String? = null,
) {
    val isSkill: Boolean get() = kind == "skill"
}

/** `GET /api/backends/:id/slash`: built-in commands plus the skills the backend discovers. */
@Serializable
data class NativeSlashCatalog(
    val items: List<NativeSlashItem> = emptyList(),
    val inlineSkills: Boolean = false,
    val reason: String? = null,
)

@Serializable
data class NativeBackendCatalogEntry(
    val backendId: NativeBackendId,
    val label: String,
    val available: Boolean,
    val reason: String? = null,
    val profiles: List<NativeBackendProfile> = emptyList(),
    val capabilities: NativeBackendCapabilities,
    val models: List<ModelInfo> = emptyList(),
    val defaultModel: String? = null,
    /** The Agent is installed but its account is not signed in; [reason] may say more. */
    val needsLogin: Boolean? = null,
    val agentId: String? = null,
    /**
     * Only on a conversation's catalog: other providers that keep conversations where this one does,
     * so it continues on them in place (`nativeSwitchProfile`). Empty from a server that predates it.
     */
    val continuations: List<NativeProfileContinuation> = emptyList(),
) {
    /** The Agent's wire id, built-in or a plugin's. */
    val agent: String get() = agentId ?: AgentIds.wire(backendId)
}

@Serializable
data class NativeProfileContinuation(
    val profile: NativeBackendProfile,
    val models: List<ModelInfo> = emptyList(),
)

@Serializable
data class TailscaleCapability(
    val present: Boolean,
    val loggedIn: Boolean? = null,
    val ip: String? = null,
    val version: String? = null,
    val message: String,
)

/** `GET /api/system/machine`: what the machine offers every Agent; there while any Agent plugin is off. */
@Serializable
data class MachineReport(
    val tmux: Boolean,
    val tailscale: TailscaleCapability,
    val warnings: List<String> = emptyList(),
    val checkedAt: String,
)

@Serializable
data class CapabilityReport(
    val cliPath: String,
    val cliVersion: String? = null,
    val authenticated: Boolean,
    val authMessage: String? = null,
    val tmux: Boolean,
    val nativePersistence: String,
    val models: List<String> = emptyList(),
    val tailscale: TailscaleCapability,
    val checkedAt: String,
    val warnings: List<String> = emptyList(),
)

/*
 * `GET /api/system/monitor`: the running service at a glance. Seconds and milliseconds are
 * [Double] because the server may send them unrounded; byte sizes and counters are whole numbers.
 * `kind` stays a string so a process kind added later does not fail the whole snapshot.
 */

/** A process in the service's tree. `kind` is `server`, `tmux`, `agent` or `child`. */
@Serializable
data class ServiceProcess(
    val pid: Int,
    val ppid: Int,
    val kind: String,
    val name: String,
    /** Truncated, with arguments that look like secrets masked. */
    val command: String,
    /** Share of one core, as `ps` reports it. */
    val cpuPercent: Double,
    val rssBytes: Long,
    val elapsedSec: Double,
    val terminalId: String? = null,
    val sessionId: String? = null,
    val sessionTitle: String? = null,
    val backendId: NativeBackendId? = null,
    /** Only processes in the service's own tree other than the server itself. */
    val canTerminate: Boolean = false,
)

/** A 10-second bucket of the service's own load. `errors` are the 5xx part of `requests`. */
@Serializable
data class ServiceMonitorSample(
    val at: Long,
    val cpuPercent: Double,
    val rssBytes: Long,
    val heapUsedBytes: Long,
    val requests: Long,
    val errors: Long,
    /** 0 when the bucket had no requests. */
    val avgMs: Double,
    val loopLagMs: Double,
    val load1: Double,
)

@Serializable
data class ServiceRouteStat(
    val method: String,
    val route: String,
    val count: Long,
    val errors: Long,
    val avgMs: Double,
    val p95Ms: Double,
)

@Serializable
data class ServiceMonitorProcess(
    val pid: Int,
    val version: String,
    val nodeVersion: String,
    val platform: String,
    val arch: String,
    val startedAt: String,
    val uptimeSec: Double,
    val cpuPercent: Double,
    val rssBytes: Long,
    val heapUsedBytes: Long,
    val heapTotalBytes: Long,
    val externalBytes: Long,
)

@Serializable
data class ServiceMonitorHost(
    val hostname: String,
    val cpuModel: String,
    val cpuCount: Int,
    /** 1, 5 and 15 minutes. */
    val loadAvg: List<Double>,
    val totalMemBytes: Long,
    val freeMemBytes: Long,
    val uptimeSec: Double,
)

@Serializable
data class ServiceEventLoop(
    val p50Ms: Double,
    val p99Ms: Double,
    val maxMs: Double,
    val utilization: Double,
    val stalls: Long,
    val lastStallAt: String? = null,
    val recentLagMs: Double,
)

@Serializable
data class ServiceStatusCounts(
    @SerialName("2xx") val status2xx: Long = 0,
    @SerialName("3xx") val status3xx: Long = 0,
    @SerialName("4xx") val status4xx: Long = 0,
    @SerialName("5xx") val status5xx: Long = 0,
)

/** Since the service started; long-lived streams count as connections, not requests. */
@Serializable
data class ServiceRequestStats(
    val total: Long,
    val inFlight: Int,
    val perMinute: Double,
    val avgMs: Double,
    val p95Ms: Double,
    val byStatus: ServiceStatusCounts,
    val topRoutes: List<ServiceRouteStat> = emptyList(),
)

@Serializable
data class ServiceConnections(val eventStreams: Int, val terminalSockets: Int)

@Serializable
data class ServiceTerminalCounts(val total: Int, val live: Int)

@Serializable
data class ServiceSessionCounts(val total: Int, val running: Int, val waiting: Int)

@Serializable
data class ServiceMonitorSnapshot(
    val generatedAt: String,
    val process: ServiceMonitorProcess,
    val host: ServiceMonitorHost,
    val eventLoop: ServiceEventLoop,
    val requests: ServiceRequestStats,
    val connections: ServiceConnections,
    val terminals: ServiceTerminalCounts,
    val sessions: ServiceSessionCounts,
    /** Oldest first, at most the last 30 minutes. */
    val series: List<ServiceMonitorSample> = emptyList(),
    val processes: List<ServiceProcess> = emptyList(),
    /** Clients that reported in the last six hours, most recent first. */
    val clients: List<ClientMetrics> = emptyList(),
    /** Absent on servers that predate the memory-based reclaimer. */
    val agentProcesses: AgentProcessReport? = null,
)

/** What the conversation-CLI reclaimer saw on its last pass. `pressure` is `normal`, `warning` or `critical`; 0 for a limit means none. */
@Serializable
data class AgentProcessReport(
    val checkedAt: String,
    val idleMinutes: Int = 0,
    val memoryLimitBytes: Long = 0,
    val memoryBytes: Long = 0,
    val pressure: String = "normal",
    val agents: List<AgentProcessUsage> = emptyList(),
)

/** One conversation's CLI. `retainedBy` names why it is kept (`turn`, `interaction`, `background`, `subscribed`, `terminal-held`, `launching`, `unobserved`, `not-resumable`); `reclaimAt` is when it stops if nothing changes. */
@Serializable
data class AgentProcessUsage(
    val sessionId: String,
    val terminalId: String? = null,
    val rssBytes: Long = 0,
    val lastUsedAt: String,
    val retainedBy: List<String> = emptyList(),
    val reclaimAt: String? = null,
)

/*
 * `ConfigFile`, `AppSettings`, `CursorCliSettings` and `NativeBackendDefaults` already live in
 * `Files.kt`; they are not redeclared here. This file adds what was missing and the update-side
 * types they do not have.
 */

/** `POST /api/cursor/command`: a CLI invocation's exit code and captured output. */
@Serializable
data class CommandResult(
    val code: Int? = null,
    val stdout: String,
    val stderr: String,
    val timedOut: Boolean? = null,
    val truncated: Boolean? = null,
)

/**
 * `CursorCliSettings` without its read-only field, plus a write-only key. `apiKey` is `JsonElement`
 * for the same three-state reason as [NativeBackendProfileSettingsUpdate.apiKey].
 */
@Serializable
data class CursorCliSettingsUpdate(
    val executable: String? = null,
    val configDir: String? = null,
    val apiEndpoint: String? = null,
    val agentEndpoint: String? = null,
    val disableAutoUpdate: Boolean? = null,
    val apiKey: JsonElement? = null,
)

/**
 * `PATCH /api/settings`. The server rejects mixing `cursorCli` with any other key, so send it alone.
 */
@Serializable
data class AppSettingsUpdate(
    val taskWorkspaceRoot: String? = null,
    val editorCommand: String? = null,
    val defaultModel: String? = null,
    val defaultMode: String? = null,
    val notifications: Boolean? = null,
    val allowOutsideRead: Boolean? = null,
    val defaultBackendId: NativeBackendId? = null,
    val nativeBackendDefaults: Map<NativeBackendId, NativeBackendDefaults>? = null,
    val cursorCli: CursorCliSettingsUpdate? = null,
    val composerEnterBehavior: String? = null,
    val composerRunningBehavior: String? = null,
    val composerSendLater: Boolean? = null,
    val idleReclaimMinutes: Int? = null,
    val maxAgentMemoryMb: Int? = null,
    val quickChat: QuickChatSettings? = null,
    /** Carry a plugin Agent where [defaultBackendId] and [nativeBackendDefaults] cannot; the client folds them into those keys. */
    val defaultAgentId: String? = null,
    val agentDefaults: Map<String, NativeBackendDefaults>? = null,
    val sidebarPinned: List<String>? = null,
)

/**
 * The two fields of a settings PATCH that carry a third state besides "a value": JSON `null`, which
 * clears the stored credential or restores the uncurated catalog. A Kotlin `null` on those fields
 * means "absent", so these builders are the only correct way to produce the clearing `null`.
 */
object PatchValue {
    /** A write-only API key, or `null` to drop the stored one. */
    fun key(value: String?): JsonElement = if (value == null) JsonNull else JsonPrimitive(value)

    /** A curated model list, or `null` to restore the whole catalog. */
    fun list(value: List<String>?): JsonElement =
        if (value == null) JsonNull else buildJsonArray { value.forEach { add(JsonPrimitive(it)) } }

    /** Declared input types per model id, or `null` to drop every declaration. */
    fun modalities(value: Map<String, List<String>>?): JsonElement =
        if (value == null) JsonNull else buildJsonObject {
            value.forEach { (id, types) -> put(id, buildJsonArray { types.forEach { add(JsonPrimitive(it)) } }) }
        }

    /** Declared context windows in tokens per model id, or `null` to drop every declaration. */
    fun contextWindows(value: Map<String, Long>?): JsonElement =
        if (value == null) JsonNull else buildJsonObject { value.forEach { (id, tokens) -> put(id, JsonPrimitive(tokens)) } }
}

/** `GET|PUT|DELETE /api/settings/push`: the APNs auth key this server pushes with. The key itself is never returned. */
@Serializable
data class PushKeyStatus(
    val configured: Boolean,
    val keyId: String? = null,
    val teamId: String? = null,
    /** `ok` or `invalid`. */
    val status: String? = null,
    val detail: String? = null,
)

/** `PUT /api/settings/push`: [key] is the `.p8` file's PEM text. */
@Serializable
data class PushKeyInput(val keyId: String, val teamId: String, val key: String)
