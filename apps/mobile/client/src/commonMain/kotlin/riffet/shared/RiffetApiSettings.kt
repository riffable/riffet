package riffet.shared

import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpMethod
import kotlinx.coroutines.withContext
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.put
import riffet.contracts.AppSettings
import riffet.contracts.AppSettingsUpdate
import riffet.contracts.AuxiliaryModelOption
import riffet.contracts.AuxiliaryModelRef
import riffet.contracts.CapabilityReport
import riffet.contracts.CommandResult
import riffet.contracts.ConfigFile
import riffet.contracts.MachineReport
import riffet.contracts.ModelInfo
import riffet.contracts.NativeBackendId
import riffet.contracts.PushKeyInput
import riffet.contracts.PushKeyStatus
import riffet.contracts.QuickChatPreset
import riffet.contracts.RiffetJson
import riffet.contracts.ServiceMonitorSnapshot
import riffet.contracts.ThemeLibrary
import riffet.contracts.ThemeLibraryUpdate
import riffet.core.formatJson

// RiffetApi endpoints — settings, themes, configs, auxiliary models, backup and diagnostics. Transport and auth rules: see RiffetApi.kt.

/** Hands this app's log to the server, which keeps it on its machine for whoever is debugging. */
@Throws(Exception::class)
suspend fun RiffetApi.uploadClientLog(name: String, content: String): SavedClientLog =
    post("/api/client-logs", wireBody(ClientLogBody(name, content))).decode()

/** `GET /api/settings`. The workbench's stored settings; credentials report `hasApiKey` only. */
@Throws(Exception::class)
suspend fun RiffetApi.settings(): AppSettings = get("/api/settings").decode()

/**
 * `GET /api/themes`: the shared custom-theme library. The selected theme is a device preference
 * and is deliberately absent — this is what every device can paint, not what this one shows.
 */
@Throws(Exception::class)
suspend fun RiffetApi.themes(): ThemeLibrary = get("/api/themes").decode()

/**
 * `PUT /api/themes`: replaces the whole library. The editor reads a revision and sends it back,
 * so a concurrent edit fails with 409 instead of being silently overwritten. Phones only read.
 */
@Throws(Exception::class)
suspend fun RiffetApi.updateThemes(body: ThemeLibraryUpdate): ThemeLibrary =
    put("/api/themes", wireBody(body)).decode()

/** `PATCH /api/settings`. Never mix `cursorCli` with any other key; the server rejects that. */
@Throws(Exception::class)
suspend fun RiffetApi.updateSettings(body: AppSettingsUpdate): AppSettings =
    patch("/api/settings", wireBody(body)).decode()

/** `GET /api/cursor/capabilities`: CLI version, auth state, tmux and warnings. */
@Throws(Exception::class)
suspend fun RiffetApi.capabilities(): CapabilityReport = get("/api/cursor/capabilities").decode()

/** `GET /api/system/machine`: tmux and the tailnet, which no Agent plugin owns. */
@Throws(Exception::class)
suspend fun RiffetApi.machineReport(): MachineReport = get("/api/system/machine").decode()

/** `GET /api/system/monitor`: the service's load, request counts and process tree. */
@Throws(Exception::class)
suspend fun RiffetApi.serviceMonitor(): ServiceMonitorSnapshot = get("/api/system/monitor").decode()

/** Stops a process in the service's tree; the server refuses the server itself and outsiders. */
@Throws(Exception::class)
suspend fun RiffetApi.terminateServiceProcess(pid: Int) {
    post("/api/system/processes/$pid/terminate").discard()
}

/** `POST /api/cursor/command`: runs an allow-listed CLI operation and returns its output. */
@Throws(Exception::class)
suspend fun RiffetApi.command(
    operation: String,
    args: List<String> = emptyList(),
    projectId: String? = null,
): CommandResult = post(
    "/api/cursor/command",
    wireBody(CommandBody(operation = operation, args = args.ifEmpty { null }, projectId = projectId)),
).decode()

@Throws(Exception::class)
suspend fun RiffetApi.configs(projectId: String): List<ConfigFile> = get("/api/projects/${projectId.enc()}/configs").decode()

@Throws(Exception::class)
suspend fun RiffetApi.config(projectId: String, configId: String): ConfigFile =
    get("/api/projects/${projectId.enc()}/configs/${configId.enc()}").decode()

/** [kind] is `rules`, `skills` or `commands`; [path] is relative to that kind's directory. */
@Throws(Exception::class)
suspend fun RiffetApi.createConfig(projectId: String, kind: String, path: String, content: String): ConfigFile =
    post(
        "/api/projects/${projectId.enc()}/configs",
        buildJsonObject {
            put("kind", JsonPrimitive(kind))
            put("path", JsonPrimitive(path))
            put("content", JsonPrimitive(content))
        },
    ).decode()

/** Saves only when the file still has [expectedHash]; a concurrent edit answers 409. */
@Throws(Exception::class)
suspend fun RiffetApi.saveConfig(projectId: String, configId: String, content: String, expectedHash: String): ConfigFile =
    request(
        HttpMethod.Put,
        "/api/projects/${projectId.enc()}/configs/${configId.enc()}",
        body = buildJsonObject {
            put("content", JsonPrimitive(content))
            put("expectedHash", JsonPrimitive(expectedHash))
        },
    ).decode()

/** Every model an auxiliary purpose may use, across the backend profiles' gateways. */
@Throws(Exception::class)
suspend fun RiffetApi.auxiliaryModels(): List<AuxiliaryModelOption> {
    val response = get("/api/auxiliary-models").bodyAsText()
    return withContext(parseContext) {
        (RiffetJson.instance.parseToJsonElement(response) as? JsonObject)
            ?.get("models")
            ?.let { RiffetJson.instance.decodeFromJsonElement(ListSerializer(AuxiliaryModelOption.serializer()), it) }
            .orEmpty()
    }
}

/** A title the [ref] model would write for [message], to try a choice before saving it. */
@Throws(Exception::class)
suspend fun RiffetApi.previewTitle(ref: AuxiliaryModelRef, message: String?): String {
    val body = buildJsonObject {
        put("backendId", WireJson.encodeToJsonElement(NativeBackendId.serializer(), ref.backendId))
        put("profileId", JsonPrimitive(ref.profileId))
        put("model", JsonPrimitive(ref.model))
        if (message != null) put("message", JsonPrimitive(message))
    }
    val response = post("/api/auxiliary-models/title-preview", body).bodyAsText()
    val answer = withContext(parseContext) { RiffetJson.instance.parseToJsonElement(response) as? JsonObject }
    return (answer?.get("title") as? JsonPrimitive)?.content.orEmpty()
}

/** Tries a title or handoff model on explicit input, without changing settings or conversations. */
@Throws(Exception::class)
suspend fun RiffetApi.previewAuxiliaryModel(purpose: String, ref: AuxiliaryModelRef, message: String): String {
    val body = buildJsonObject {
        put("purpose", JsonPrimitive(purpose))
        put("backendId", WireJson.encodeToJsonElement(NativeBackendId.serializer(), ref.backendId))
        put("profileId", JsonPrimitive(ref.profileId))
        put("model", JsonPrimitive(ref.model))
        put("message", JsonPrimitive(message))
    }
    // Handoff generation has a two-minute model budget, longer than the ordinary API timeout.
    val response = request(HttpMethod.Post, "/api/auxiliary-models/preview", body = body, timeoutMillis = 135_000)
    val text = response.bodyAsText()
    val answer = withContext(parseContext) { RiffetJson.instance.parseToJsonElement(text) as? JsonObject }
    return (answer?.get("text") as? JsonPrimitive)?.content.orEmpty()
}

/**
 * `PATCH /api/settings` for quick chat only. The server merges per key, so only the supplied values
 * change. [presets] replaces the whole list; [resetPresets] sends the explicit JSON null that
 * restores the server's defaults, which a Kotlin `null` cannot express (it means "absent").
 */
@Throws(Exception::class)
suspend fun RiffetApi.updateQuickChat(
    retentionDays: Int? = null,
    openMode: String? = null,
    presets: List<QuickChatPreset>? = null,
    resetPresets: Boolean = false,
): AppSettings = patch(
    "/api/settings",
    buildJsonObject {
        put("quickChat", buildJsonObject {
            retentionDays?.let { put("retentionDays", JsonPrimitive(it)) }
            openMode?.let { put("openMode", JsonPrimitive(it)) }
            when {
                resetPresets -> put("presets", JsonNull)
                presets != null -> put("presets", WireJson.encodeToJsonElement(ListSerializer(QuickChatPreset.serializer()), presets))
            }
        })
    },
).decode()

/**
 * Sets the model for one auxiliary [purpose] (`title`, `handoff`), or clears it with null; the
 * server needs an explicit JSON null to clear, and leaves the other purposes as they are.
 */
@Throws(Exception::class)
suspend fun RiffetApi.setAuxiliaryModel(purpose: String, ref: AuxiliaryModelRef?): AppSettings =
    patch(
        "/api/settings",
        buildJsonObject {
            put("auxiliaryModels", buildJsonObject {
                put(purpose, ref?.let { WireJson.encodeToJsonElement(AuxiliaryModelRef.serializer(), it) } ?: JsonNull)
            })
        },
    ).decode()

/** `POST /api/system/backup`: an online snapshot of the state directory; the receipt as pretty JSON. */
@Throws(Exception::class)
suspend fun RiffetApi.backup(): String {
    val text = post("/api/system/backup").bodyAsText()
    return withContext(parseContext) { runCatching { formatJson(RiffetJson.instance.parseToJsonElement(text)) }.getOrDefault(text) }
}

/** The models the Cursor CLI on the server lists, for diagnostics. */
@Throws(Exception::class)
suspend fun RiffetApi.cursorModels(): List<ModelInfo> = get("/api/cursor/models").decode()

/** Reading the resolved server-side root never allocates a task directory. */
@Throws(Exception::class)
suspend fun RiffetApi.taskWorkspaceLocation(): TaskWorkspaceLocation = get("/api/task-workspaces/location").decode()

/** `GET /api/settings/push`: whether this server has an APNs key, never the key. Owner only. */
@Throws(Exception::class)
suspend fun RiffetApi.pushKey(): PushKeyStatus = get("/api/settings/push").decode()

/** `PUT /api/settings/push`: the server checks the key before keeping it. */
@Throws(Exception::class)
suspend fun RiffetApi.savePushKey(body: PushKeyInput): PushKeyStatus = put("/api/settings/push", wireBody(body)).decode()

@Throws(Exception::class)
suspend fun RiffetApi.removePushKey(): PushKeyStatus = delete("/api/settings/push").decode()
