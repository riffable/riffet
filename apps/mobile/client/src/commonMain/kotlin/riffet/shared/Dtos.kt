package riffet.shared

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.descriptors.element
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import riffet.contracts.DevicePushRoute
import riffet.contracts.Run
import riffet.contracts.NativeTurnTarget
import riffet.contracts.NativeBackendId
import riffet.contracts.NativeHistoryState
import riffet.contracts.NativeWorkbenchEvent
import riffet.contracts.RiffetJson

/*
 * Request bodies and response envelopes that packages/contracts does not declare.
 *
 * contracts/ is owned by another change and is not modified. These types are client-side transport
 * shapes, exactly as `apps/web/src/lib/api.ts` declares its own `NativeMessageInput`,
 * `NativeSessionCreateInput`, `Bootstrap` re-export and pairing responses locally.
 */

/**
 * Request bodies must include values that equal their default. `RiffetJson` leaves
 * `encodeDefaults` at kotlinx's default of false, so a `kind = "native"` default would be dropped
 * from the JSON and `POST /api/sessions` would answer `INVALID_SESSION_KIND`. Response decoding
 * keeps using `RiffetJson` unchanged.
 */
val WireJson: Json = Json(RiffetJson.instance) { encodeDefaults = true }

@Serializable
data class AttachmentRef(val id: String)

/** A composer reference; files use path/line, sessions are serialized through NativeMessageInput.references. */
@Serializable
data class PromptContextReference(
    val path: String = "",
    val line: Long? = null,
    val kind: String? = null,
    val sessionId: String? = null,
    val fromRunId: String? = null,
    val title: String? = null,
)

@Serializable
data class NativeMessageInput(
    val commandId: String,
    val text: String,
    val attachments: List<AttachmentRef>? = null,
    val context: List<PromptContextReference>? = null,
    val expectedConfigRevision: Long? = null,
    val stop: NativeStopRequest? = null,
    val references: List<riffet.contracts.SessionReferenceInput>? = null,
)

@Serializable
data class NativeStopRequest(
    val requestId: String,
    val nativeSessionId: String,
    val turnId: String? = null,
    val terminalId: String? = null,
    val terminalEpoch: Long? = null,
)

@Serializable
data class NativeRunRecovery(val run: Run, val canContinue: Boolean, val queuedRunIds: List<String>)

@Serializable
data class NativeSteerInput(
    val commandId: String,
    val text: String,
    val target: NativeTurnTarget,
    val attachments: List<AttachmentRef>? = null,
    val context: List<PromptContextReference>? = null,
    val references: List<riffet.contracts.SessionReferenceInput>? = null,
)

@Serializable
data class NativeQueuedSteerInput(val commandId: String, val target: NativeTurnTarget)

/**
 * `POST /api/sessions` with `initialMessage` is the atomic "create and submit" call; without it the
 * body creates an empty conversation. `kind` is required by the route, hence the non-null default
 * that [WireJson] guarantees is written.
 */
@Serializable
data class NativeSessionCreateInput(
    val clientSessionId: String,
    val projectId: String? = null,
    val projectless: Boolean? = null,
    val kind: String = "native",
    val backendId: NativeBackendId? = null,
    val backendProfileId: String? = null,
    val title: String? = null,
    val model: String? = null,
    val mode: String? = null,
    val approval: String? = null,
    /** `device:<id>` groups the CLI is launched with; absent or empty is none, and the server drops a device that is no longer paired. */
    val toolGroups: List<String>? = null,
    val initialMessage: NativeMessageInput? = null,
    /** A plugin Agent's raw id, which [backendId] cannot hold; the client puts it back on the wire (see `AgentWire`). */
    val agentId: String? = null,
    /** `mcp:<name>` / `skill:<name>` switched off for the new conversation. */
    val extensionsOff: List<String>? = null,
)

@Serializable
data class NativeSessionCreateResult(val session: riffet.contracts.Session, val run: riffet.contracts.Run, val project: riffet.contracts.Project? = null)

@Serializable
data class TaskWorkspaceLocation(val path: String, val source: String, val available: Boolean, val error: String? = null)

@Serializable
data class SessionUpdate(
    val title: String? = null,
    val tags: List<String>? = null,
    val archived: Boolean? = null,
    val pinned: Boolean? = null,
    /** The full list replaces the conversation's; it applies the next time the CLI launches. */
    val toolGroups: List<String>? = null,
    /** `mcp:<name>` / `skill:<name>` entries; the full list replaces the conversation's and applies the next time the CLI launches. */
    val extensionsOff: List<String>? = null,
)

/** `session-delete-v1`: what deleting a conversation removes, for its confirmation. */
@Serializable
data class SessionDeletionPreview(
    /** The conversation and its side chats, root first; the deletion is sent the same set. */
    val sessionIds: List<String>,
    /** Set while it cannot be deleted; [ApiProblem.code] names the text. */
    val blocker: ApiProblem? = null,
    val effects: SessionDeletionEffects = SessionDeletionEffects(),
)

@Serializable
data class SessionDeletionEffects(val discussions: Int = 0, val schedules: Int = 0)

/** A server error carried inside a successful answer, worded like a thrown one. */
@Serializable
data class ApiProblem(val code: String, val message: String = "", val params: Map<String, JsonPrimitive> = emptyMap()) {
    /** The text in the interface language. */
    val text: String get() = riffet.i18n.L10n.serverError(code, params.mapValues { it.value.content }, message)
}

@Serializable
data class SessionDeletionReceipt(val sessionIds: List<String>, val deletedAt: String? = null)

@Serializable
data class SessionDeletionRequest(val sessionIds: List<String>)

@Serializable
data class CreateCheckpointRequest(val sessionId: String? = null, val title: String? = null)

@Serializable
data class ModelBody(val model: String)

@Serializable
data class ModeBody(val mode: String)

@Serializable
data class ApprovalBody(val approval: String)

@Serializable
data class KeysBody(val keys: List<String>)

/** `POST /api/client-logs`. */
@Serializable
data class ClientLogBody(val name: String, val content: String)

/** Where the server kept an uploaded log, on its own machine. */
@Serializable
data class SavedClientLog(val path: String, val bytes: Long)

/** The only outcome `POST …/native/runs/:id/resolve` accepts, per app.ts. */
@Serializable
data class ResolveRunBody(val outcome: String = "continue", val queuedRunIds: List<String>)

@Serializable
data class PairingCodeRequest(val name: String? = null)

@Serializable
data class PairDeviceRequest(val code: String, val name: String)

@Serializable
data class PairingCodeResponse(
    val code: String,
    val expiresAt: Long,
    /** SVG markup of the QR that carries [payload]; the device code is never in it. */
    val qr: String,
    val hosts: List<String>,
    val port: Int,
    /** The scheme a client must dial; a TLS front door reports `https`. */
    val scheme: String = "http",
    /** True when the server only listens on loopback, so the code is useful on this machine only. */
    val localOnly: Boolean = false,
    /** The exact JSON string `qr` encodes, for a client to draw its own QR; absent from older servers. */
    val payload: String? = null,
)

/**
 * `DeviceInfo`, as `GET /api/devices` and `PUT /api/devices/me` return it (docs/DEVICES.md §3); a
 * server before the device channel sends only the first four fields. The plaintext device token is
 * only ever in [IssuedDevice.token].
 */
@Serializable
data class PublicDevice(
    val id: String,
    val name: String,
    val createdAt: String,
    val lastSeenAt: String? = null,
    val platform: String? = null,
    val appVersion: String? = null,
    /** Whether the device's stream is open now. */
    val online: Boolean = false,
    val capabilities: List<String> = emptyList(),
    val allowControl: Boolean = false,
    /** Absent from a server without background push. */
    val push: DevicePushRoute? = null,
)

@Serializable
data class DevicesResponse(val devices: List<PublicDevice>)

@Serializable
data class IssuedDevice(val device: PublicDevice, val token: String)

/** `{ ok: true }` bodies, kept as an explicit flag rather than decoded and discarded. */
@Serializable
data class OkResponse(val ok: Boolean = false)

/*
 * Request bodies for the write endpoints. They live here, next to the response shapes, so a change to
 * one side of a route is visible beside the other.
 */

/** The server takes the bytes as base64; the client is responsible for keeping them small. */
@Serializable
data class UploadAttachmentRequest(
    val name: String,
    val mimeType: String,
    val dataBase64: String,
    val width: Long? = null,
    val height: Long? = null,
)

@Serializable
data class PathsBody(val paths: List<String>)

@Serializable
data class PathBody(val path: String)

@Serializable
data class CommitBody(val message: String)

@Serializable
data class RestoreBody(val expectedChanges: List<riffet.contracts.CheckpointChange>)

@Serializable
data class CreateWorktreeRequest(val branch: String, val path: String? = null, val base: String? = null)

/*
 * Project request bodies. `POST /api/projects` and `PATCH /api/projects/:id` exist for the web's
 * project sidebar; the phone needs them for the one thing it could not do before — bind a directory
 * that is not registered yet and start a session in it.
 */

/** `POST /api/projects`: `name` defaults to the folder's own name on the server. */
@Serializable
data class CreateProjectBody(val cwd: String, val name: String? = null)

/** `PATCH /api/projects/:id`: the directory picker only ever restores an archived project. */
@Serializable
data class UpdateProjectBody(val archived: Boolean)

/** `POST /api/browse`: an absent `path` means the server host's home directory. */
@Serializable
data class BrowseBody(val path: String? = null)


/*
 * Settings request bodies that `packages/contracts` does not declare because the web client builds
 * them inline in `api.ts`.
 */

/** `POST /api/backends/:id/model-probe`: unsaved form values, persisted nowhere. */
@Serializable
data class ProbeBackendModelsBody(
    val apiEndpoint: String? = null,
    val apiKey: String? = null,
    val profileId: String? = null,
    val modelSource: String? = null,
    val apiProtocol: String? = null,
)

/*
 * Built-in plugins from packages/contracts/src/plugin-management.ts (docs/PLUGIN_ARCHITECTURE.md). Clients
 * render them from these descriptors alone. Their enum-like values (`enablement`, `state`, `kind`,
 * `backends`, `overridable`) stay strings, so a value a newer server adds cannot fail the list.
 */

/** `GET /api/integrations`, in precedence order. */
@Serializable
data class PluginsResponse(val integrations: List<PluginDescriptor> = emptyList(), val recovery: Boolean = false)

@Serializable
data class PluginDescriptor(
    val id: String,
    val vendor: String = "",
    val name: String = "",
    val enabled: Boolean = false,
    val active: Boolean? = null,
    val activation: PluginActivationState? = null,
    val execution: PluginExecution? = null,
    /** `auto`, `on` or `off`. */
    val enablement: String = "auto",
    val status: PluginStatus? = null,
    val settings: List<PluginField> = emptyList(),
    val configRevision: String? = null,
    val installed: InstalledPluginInfo? = null,
    val stopping: PluginStopping? = null,
    val rejected: Boolean = false,
    /** Empty while the plugin is off. */
    val actions: List<PluginAction> = emptyList(),
    val contributes: PluginContributions = PluginContributions(),
    val version: String? = null,
    /** BCP-47 tag -> text. */
    val title: Map<String, String>? = null,
    val description: Map<String, String>? = null,
    /** `builtin`, `development` or `installed`. */
    val source: String? = null,
    /** A saved local development link that can be explicitly removed. */
    val developmentLinked: Boolean = false,
    /** Canonical directory identifying this development management target. */
    val developmentPath: String? = null,
    val requires: List<PluginRequirement>? = null,
    /** What the package declares statically, read without running its code; absent on an older server. */
    val declared: PluginDeclarations? = null,
    /** Per entry, whether the package's `hostApi` ranges match this host; a client skips an entry whose `ok` is false. */
    val compatibility: PluginCompatibility? = null,
    /** A development or installed package's web entry, a script served at `/api/integrations/<id>/files/<path>`; [WebEntry.integrity] is `sha256-<hex>`. */
    val webEntry: WebEntry? = null,
    /** What the package holds; absent for built-in plugins. */
    val capabilities: List<String>? = null,
    /** With `process.exec`: the commands the package runs on this machine, outside the sandbox. */
    val executables: List<String>? = null,
)

@Serializable
data class WebEntry(val path: String, val integrity: String? = null)

/** `packages/contracts/src/plugin-packages.ts`; an entry is absent when the package has no such entry. */
@Serializable
data class PluginCompatibility(val server: PluginEntryCompatibility? = null, val web: PluginEntryCompatibility? = null)

@Serializable
data class PluginEntryCompatibility(val range: String = "", val ok: Boolean = true)

/**
 * `packages/contracts/src/plugins.ts`. A client ignores a contribution kind it does not know, and
 * keeps [locations], [clients] and [instances] as strings so a value a newer server adds cannot
 * fail the list.
 */
@Serializable
data class PluginDeclarations(
    val modelSources: List<PluginModelSourceDeclaration>? = null,
    val sharePublisher: PluginPublisherDeclaration? = null,
    val actions: List<PluginAction>? = null,
    val appearance: PluginAppearanceDeclaration? = null,
    val views: List<ViewDeclaration>? = null,
    val commands: List<CommandDeclaration>? = null,
    val tasks: List<TaskProviderDeclaration>? = null,
    val agentBackends: List<AgentBackendDeclaration>? = null,
    val agentTools: List<AgentToolsDeclaration>? = null,
    /** The plugin builds a page of its own ([PluginPage]); [PluginPageDeclaration.title] names its tab. */
    val page: PluginPageDeclaration? = null,
)

@Serializable
data class PluginPageDeclaration(val title: Map<String, String>? = null)

/*
 * A plugin's own page (packages/contracts/src/plugin-page.ts, docs/PLUGIN_ARCHITECTURE.md「插件页」): built by the
 * plugin while it is on, drawn by the client. [PluginPageItem.kind] stays a string and an item of an unknown kind is
 * skipped, so a newer server cannot break the page.
 */
@Serializable
data class PluginPageResponse(val page: PluginPage = PluginPage(), val message: String? = null)

@Serializable
data class PluginPage(val sections: List<PluginPageSection> = emptyList(), val refreshMs: Int? = null)

@Serializable
data class PluginPageSection(val id: String, val title: String? = null, val footer: String? = null, val items: List<PluginPageItem> = emptyList())

/** One item; which fields apply depends on [kind]: `choice`, `toggle`, `text`, `list`, `row` or `buttons`. */
@Serializable
data class PluginPageItem(
    val kind: String,
    val key: String? = null,
    val id: String? = null,
    val label: String = "",
    val value: String? = null,
    val on: Boolean = false,
    val values: List<String> = emptyList(),
    val detail: String? = null,
    val placeholder: String? = null,
    val secret: Boolean = false,
    val set: Boolean = false,
    val options: List<PluginPageOption> = emptyList(),
    val buttons: List<PluginPageButton> = emptyList(),
)

@Serializable
data class PluginPageOption(val value: String, val label: String, val detail: String? = null, val disabled: Boolean = false, val button: PluginPageButton? = null)

@Serializable
data class PluginPageButton(
    val action: String,
    val label: String,
    val item: String? = null,
    val destructive: Boolean = false,
    val confirm: String? = null,
    val confirmDetail: String? = null,
    val disabled: Boolean = false,
)

@Serializable
data class PluginReadmeResponse(val readme: String? = null)

/** Tools an Agent can be given through Riffet MCP (docs/BROWSER.md §2); [id] is the `ToolGroupId` a conversation keeps in `toolGroups`. */
@Serializable
data class AgentToolsDeclaration(
    val id: String,
    val title: Map<String, String> = emptyMap(),
    val description: Map<String, String>? = null,
    val toolPrefix: String = "",
    val icon: ViewIcon? = null,
)

/** An Agent a plugin provides, listed while the plugin is off; [id] is the persisted backend id. */
@Serializable
data class AgentBackendDeclaration(
    val id: String,
    val title: Map<String, String> = emptyMap(),
    val icon: ViewIcon? = null,
)

/** [id] is `<pluginId>/<name>`; [title] is BCP-47 tag -> text. */
@Serializable
data class ViewDeclaration(
    val id: String,
    val title: Map<String, String> = emptyMap(),
    val icon: ViewIcon? = null,
    /** `session-view`, `sidebar`, `panel`, `main` or `navigation`. */
    val locations: List<String> = emptyList(),
    val defaultLocation: String? = null,
    /** `web` or `macos`. */
    val clients: List<String> = emptyList(),
    /** `single`, `per-session` or `per-project`. */
    val instances: String = "single",
    @SerialName("when") val whenCondition: PluginCondition? = null,
    /** Drawn by the host from this declaration instead of plugin code; a client without a renderer for [ViewRenderer.kind] does not show the view. */
    val renderer: ViewRenderer? = null,
    val requires: List<String> = emptyList(),
)

/** `kind` is `tasks` today; [provider] is a task provider of the same plugin. */
@Serializable
data class ViewRenderer(
    val kind: String,
    val provider: String = "",
    val items: List<DeclaredViewItem> = emptyList(),
    val fields: List<DeclaredViewField> = emptyList(),
    val actions: List<DeclaredViewItem> = emptyList(),
    val command: String = "",
    val submit: Map<String, String>? = null,
)
@Serializable
data class DeclaredViewItem(val id: String, val title: Map<String, String> = emptyMap(), val description: Map<String, String>? = null, val command: String? = null, val args: Map<String, JsonPrimitive> = emptyMap()) {
    fun argumentValues(): Map<String, String> = args.mapValues { it.value.content }
}
@Serializable
data class DeclaredViewField(val key: String = "", val label: Map<String, String> = emptyMap(), val value: Map<String, String> = emptyMap(), val kind: String = "text", val options: List<String> = emptyList(), val required: Boolean = false, val default: JsonPrimitive? = null) {
    fun initialValue(): String = default?.content ?: if (kind == "boolean") "false" else if (kind == "choice") options.firstOrNull().orEmpty() else ""
}
@Serializable
data class PluginExecution(val location: String = "server", val mode: String = "isolated", val platform: String = "")
@Serializable
data class PluginActivationState(val events: List<String> = emptyList(), val state: String = "idle", val trigger: String? = null, val durationMs: Double? = null, val activatedAt: String? = null, val failedPhase: String? = null)
@Serializable
data class PluginLogEntry(val pluginId: String, val version: String? = null, val generation: Int = 0, val at: String = "", val level: String = "info", val phase: String = "", val message: String = "")
@Serializable
data class PluginLogsResponse(val logs: List<PluginLogEntry> = emptyList())

/** A provider of project tasks (docs/TASKS.md); [projectType] is what a view's `when.projectType` is matched against. */
@Serializable
data class TaskProviderDeclaration(val id: String, val title: Map<String, String> = emptyMap(), val projectType: String? = null)

/** [svg] is a path inside the package; [sfSymbol] is for the Mac. */
@Serializable
data class ViewIcon(val svg: String? = null, val sfSymbol: String? = null)

/** Structured visibility rule: decides whether something is offered and grants no permission. */
@Serializable
data class PluginCondition(
    val hasProject: Boolean? = null,
    val hasSession: Boolean? = null,
    val projectType: String? = null,
    val capability: String? = null,
)

/** [scope] is `global`, `project` or `session`, `project` when absent; [params] are the values a run takes. */
@Serializable
data class CommandDeclaration(
    val id: String,
    val title: Map<String, String> = emptyMap(),
    @SerialName("when") val whenCondition: PluginCondition? = null,
    val keybinding: String? = null,
    val scope: String? = null,
    val params: List<TaskParamField>? = null,
)

/** Another plugin this one builds on; an [optional] one only adds to it. */
@Serializable
data class PluginRequirement(val id: String, val optional: Boolean = false)

/** [state] is `ready`, `attention` or `unavailable`. */
@Serializable
data class PluginStatus(val state: String, val message: String? = null)

/** A setting; [kind] is `text` or `secret`. A secret's value never leaves the server, [set] says whether one is saved. */
@Serializable
data class PluginField(
    val key: String,
    val label: String,
    val kind: String = "text",
    val value: String? = null,
    val set: Boolean? = null,
)

/** [kind] is `run` or `device-flow`. */
@Serializable
data class PluginAction(val id: String, val label: String, val kind: String = "run")

@Serializable
data class PluginContributions(
    val modelSources: List<ModelSourceDescriptor> = emptyList(),
    val sharePublisher: SharePublisherDescriptor? = null,
)

@Serializable
data class SharePublisherDescriptor(val label: String, val audience: String)

/** A model source a profile can pick; [id] is what the profile saves as its `modelSource`. */
@Serializable
data class ModelSourceDescriptor(
    val id: String,
    val role: String? = null,
    val usage: Boolean? = null,
    val label: String,
    /** Backend wire ids (`claude`, `codex`). */
    val backends: List<String> = emptyList(),
    /** Gateway protocols the source serves; null from a server that predates it, which matches by [backends]. */
    val protocols: List<String>? = null,
    val defaultEndpoint: String? = null,
    /** The profile fields that may override the source's own (`apiEndpoint`, `apiKey`); a client hides the others. */
    val overridable: List<String> = listOf("apiEndpoint", "apiKey"),
    /** The id of the providing plugin's action that signs in to this source. */
    val loginAction: String? = null,
    val hint: ModelSourceHint? = null,
)

@Serializable
data class ModelSourceHint(val text: String, val command: String? = null)

/**
 * One step of a plugin action, discriminated by `kind`. [ShowCode] starts a device-code
 * login: show the code, then poll the flow every [ShowCode.intervalMs] (longer after [SlowDown])
 * until another step arrives. A `kind` this build does not know, or a step it cannot read, is
 * [Unknown] rather than a failure.
 */
@Serializable(with = ActionStepSerializer::class)
sealed interface ActionStep {
    data object Done : ActionStep

    /** [expiresAt] is epoch milliseconds. [qrSvg] encodes [verificationUri]. */
    @Serializable
    data class ShowCode(
        val flowId: String,
        val userCode: String? = null,
        val verificationUri: String,
        val qrSvg: String? = null,
        val intervalMs: Long,
        val expiresAt: Long,
    ) : ActionStep

    data object Pending : ActionStep

    data object SlowDown : ActionStep

    @Serializable
    data class Failed(val message: String) : ActionStep

    @Serializable
    data class Hint(val text: String, val command: String? = null) : ActionStep

    data class Unknown(val kind: String?, val raw: JsonObject) : ActionStep
}

internal object ActionStepSerializer : KSerializer<ActionStep> {
    override val descriptor = buildClassSerialDescriptor("riffet.shared.ActionStep") { element<String>("kind") }

    override fun deserialize(decoder: Decoder): ActionStep {
        val json = decoder as? JsonDecoder ?: throw SerializationException("ActionStep must be decoded from JSON")
        val element = json.decodeJsonElement() as? JsonObject ?: throw SerializationException("ActionStep must be a JSON object")
        val kind = (element["kind"] as? JsonPrimitive)?.contentOrNull
        val step = try {
            when (kind) {
                "done" -> ActionStep.Done
                "show-code" -> json.json.decodeFromJsonElement(ActionStep.ShowCode.serializer(), element)
                "pending" -> ActionStep.Pending
                "slow_down" -> ActionStep.SlowDown
                "failed" -> json.json.decodeFromJsonElement(ActionStep.Failed.serializer(), element)
                "hint" -> json.json.decodeFromJsonElement(ActionStep.Hint.serializer(), element)
                else -> null
            }
        } catch (e: SerializationException) {
            null
        }
        return step ?: ActionStep.Unknown(kind, element)
    }

    override fun serialize(encoder: Encoder, value: ActionStep) {
        val json = encoder as? JsonEncoder ?: throw SerializationException("ActionStep must be encoded to JSON")
        val (kind, fields) = when (value) {
            ActionStep.Done -> "done" to null
            is ActionStep.ShowCode -> "show-code" to json.json.encodeToJsonElement(ActionStep.ShowCode.serializer(), value)
            ActionStep.Pending -> "pending" to null
            ActionStep.SlowDown -> "slow_down" to null
            is ActionStep.Failed -> "failed" to json.json.encodeToJsonElement(ActionStep.Failed.serializer(), value)
            is ActionStep.Hint -> "hint" to json.json.encodeToJsonElement(ActionStep.Hint.serializer(), value)
            is ActionStep.Unknown -> return json.encodeJsonElement(value.raw)
        }
        json.encodeJsonElement(JsonObject(mapOf("kind" to JsonPrimitive(kind)) + (fields?.jsonObject ?: emptyMap())))
    }
}

/** `POST /api/cursor/command`. */
@Serializable
data class CommandBody(
    val operation: String,
    val args: List<String>? = null,
    val projectId: String? = null,
)

/*
 * Orchestration, publishing and search. The response shapes (Automation, AutomationRun, AttemptGroup,
 * BranchInfo, PullRequestStatus, MergeResult, ...) are in contracts; these are the request bodies and
 * the envelopes api.ts declares locally.
 */

/**
 * `POST /api/automations` and `PATCH /api/automations/:id`. A create needs [name] and [prompt] (a
 * follow-up needs [prompt], [followUp] and a `once` trigger); an update sends only what changes, and
 * an absent [target] keeps the automation's own. [triggers] replaces the whole list.
 */
@Serializable
data class AutomationBody(
    val name: String? = null,
    val prompt: String? = null,
    val target: riffet.contracts.LaunchTarget? = null,
    val projectId: String? = null,
    val isolate: Boolean? = null,
    val triggers: List<riffet.contracts.AutomationTrigger>? = null,
    val delivery: String? = null,
    val catchUp: String? = null,
    val enabled: Boolean? = null,
    val followUp: FollowUpRef? = null,
    val attachments: List<AttachmentRef>? = null,
    val context: List<PromptContextReference>? = null,
    val references: List<riffet.contracts.SessionReferenceInput>? = null,
    /** A client-made id a retried create is deduplicated by. */
    val id: String? = null,
)

@Serializable
data class FollowUpRef(val sessionId: String)

/**
 * `POST /api/automations/:id/run`. [clientSessionId] and [commandId] are the idempotency pair: a retry
 * with the same pair returns what the first request did.
 */
@Serializable
data class RunAutomationBody(val projectId: String? = null, val clientSessionId: String? = null, val commandId: String? = null)

@Serializable
data class ForkSessionBody(
    val clientSessionId: String,
    val commandId: String,
    val runId: String? = null,
    val target: riffet.contracts.LaunchTarget? = null,
    val isolate: Boolean = false,
    val note: String? = null,
)

@Serializable
data class HandoffSessionBody(
    val clientSessionId: String,
    val commandId: String,
    val target: riffet.contracts.LaunchTarget,
    val note: String? = null,
    /** The whole first message, as edited from a [riffet.contracts.HandoffDraft]; the server then ignores [note]. */
    val text: String? = null,
)

@Serializable
data class HandoffDraftBody(val target: riffet.contracts.LaunchTarget, val goal: String? = null)

@Serializable
data class SendReviewBody(
    val commandId: String,
    val comments: List<riffet.contracts.ReviewComment>,
    val note: String? = null,
)

/** `POST /api/projects/:id/attempts`: [requestId] makes a retried launch return the first group. */
@Serializable
data class CreateAttemptsBody(
    val prompt: String,
    val targets: List<riffet.contracts.LaunchTarget>,
    val base: String? = null,
    val requestId: String? = null,
    val attachments: List<riffet.contracts.Attachment> = emptyList(),
    val context: List<PromptContextReference> = emptyList(),
)

@Serializable
data class CreateAttemptsResult(val group: riffet.contracts.AttemptGroup, val warnings: List<String> = emptyList())

@Serializable
data class AttemptComparisonResult(
    val group: riffet.contracts.AttemptGroup,
    val attempts: List<riffet.contracts.AttemptComparison> = emptyList(),
)

/** How a worktree branch comes back: [strategy] is `merge` or `squash`, absent for the server's default. */
@Serializable
data class MergeBody(
    val strategy: String? = null,
    val message: String? = null,
    val commitPending: String? = null,
    val removeWorktree: Boolean = false,
)

/** `POST /api/attempts/:id/adopt`: merges the chosen attempt's branch back. */
@Serializable
data class AdoptAttemptBody(
    val sessionId: String,
    val strategy: String? = null,
    val message: String? = null,
    val commitPending: String? = null,
    val removeWorktree: Boolean = false,
    /** What happens to the other attempts: `keep`, `archive` or `remove` (archive and remove worktrees). */
    val cleanup: String? = null,
)

@Serializable
data class AddAttemptBody(val target: riffet.contracts.LaunchTarget)

@Serializable
data class AddAttemptResult(val group: riffet.contracts.AttemptGroup)

@Serializable
data class DiscardAttemptBody(val sessionId: String, val removeWorktree: Boolean = false)

@Serializable
data class DiscardAttemptResult(val group: riffet.contracts.AttemptGroup, val warnings: List<String> = emptyList())

@Serializable
data class AdoptAttemptResult(val group: riffet.contracts.AttemptGroup, val merge: riffet.contracts.MergeResult, val warnings: List<String> = emptyList())

@Serializable
data class PushBody(val remote: String? = null)

@Serializable
data class CreatePullRequestBody(
    val title: String? = null,
    val body: String? = null,
    val base: String? = null,
    val draft: Boolean? = null,
    val remote: String? = null,
)

/** One conversation search result; [snippet] is a window of the matched text, not the whole message. */
@Serializable
data class MessageSearchHit(
    val sessionId: String,
    val projectId: String,
    val sessionTitle: String = "",
    val archived: Boolean = false,
    val backendId: NativeBackendId? = null,
    val messageId: String,
    /** `user`, `assistant` or `tool`. */
    val kind: String,
    val at: String,
    val snippet: String,
    /** Present for a question: the client turns it into that turn's timeline row key. */
    val runId: String? = null,
)

/** [pending] counts conversations whose transcript is not indexed yet; ask again while it is above zero. */
@Serializable
data class MessageSearchResult(
    val query: String = "",
    val hits: List<MessageSearchHit> = emptyList(),
    val pending: Long = 0,
)

/** `POST /api/native/prewarm`: [state] says what the server did, [reason] why it skipped. */
@Serializable
data class PrewarmBody(
    val projectId: String,
    val backendId: NativeBackendId? = null,
    val backendProfileId: String? = null,
    val model: String? = null,
    val mode: String? = null,
    val approval: String? = null,
    /** A plugin Agent's raw id, which [backendId] cannot hold (see `AgentWire`). */
    val agentId: String? = null,
)

@Serializable
data class PrewarmResult(val state: String, val reason: String? = null)


@Serializable
data class InstalledPluginVersion(val version: String, val source: String = "", val integrity: String = "", val capabilities: List<String> = emptyList(), val selected: Boolean = false, val trusted: Boolean = false)
@Serializable
data class InstalledPluginInfo(val versions: List<InstalledPluginVersion> = emptyList(), val selected: String = "", val hasData: Boolean = false, val dataVersion: Int? = null, val backups: List<String> = emptyList())
@Serializable
data class PluginStopping(val running: Int = 0, val version: String? = null)
@Serializable
data class PluginGrantRequired(
    val id: String,
    val version: String,
    val capabilities: List<String> = emptyList(),
    val trustedRequired: Boolean = false,
    val trustedAllowed: Boolean = false,
    val modelSources: List<PluginGrantModelSource>? = null,
    val executables: List<String>? = null,
)
/** A model source a package declares, with the only hosts it may send requests and the profile's key to besides an address the user typed. No hosts: not limited. */
@Serializable
data class PluginGrantModelSource(val id: String, val hosts: List<String>? = null)
@Serializable
data class PluginModelSourceDeclaration(val id: String, val title: Map<String, String> = emptyMap(), val hosts: List<String>? = null)
@Serializable
data class PluginUpdate(val enablement: String? = null, val settings: Map<String, String?>? = null, val force: Boolean? = null, val configRevision: String? = null)
data class PluginInstallationResult(val plugin: PluginDescriptor? = null, val grant: PluginGrantRequired? = null)

@Serializable
data class NamedPluginContribution(val id: String, val title: Map<String, String> = emptyMap())
@Serializable
data class PluginPublisherDeclaration(val title: Map<String, String> = emptyMap())
@Serializable
data class PluginAppearanceDeclaration(val palettes: List<NamedPluginContribution> = emptyList(), val fonts: List<NamedPluginContribution> = emptyList(), val backgrounds: List<NamedPluginContribution> = emptyList(), val presets: List<NamedPluginContribution> = emptyList())

@Serializable
data class PluginDiagnostic(val id: String, val label: String = "", val status: String = "warn", val detail: String = "", val fix: String? = null)
