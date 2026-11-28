package riffet.shared

import io.ktor.http.HttpMethod
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.put
import riffet.contracts.ExtensionActionRequest
import riffet.contracts.ExtensionActionResult
import riffet.contracts.ExtensionContext
import riffet.contracts.ExtensionDetail
import riffet.contracts.ExtensionDocument
import riffet.contracts.ExtensionInventory
import riffet.contracts.ExtensionManagementCapabilities
import riffet.contracts.ExtensionRuntimeReport
import riffet.contracts.LoadedExtensions
import riffet.contracts.ModelInfo
import riffet.contracts.NativeBackendCatalogEntry
import riffet.contracts.NativeBackendId
import riffet.contracts.NativeBackendModelProbeResponse
import riffet.contracts.NativeBackendProfileSettings
import riffet.contracts.NativeBackendProfileSettingsUpdate
import riffet.contracts.NativeBackendProfilesResponse
import riffet.contracts.NativeBackendUsage
import riffet.contracts.NativeSlashCatalog

// RiffetApi endpoints — native backends: profiles, catalogs, usage, slash commands and extensions. Transport and auth rules: see RiffetApi.kt.

/** `GET /api/backends`: every CLI the workbench knows, with its profiles and model catalog. */
@Throws(Exception::class)
suspend fun RiffetApi.backends(): List<NativeBackendCatalogEntry> = backends(recheckMissing = false)

/** `GET /api/backends?recheck=1`: re-probes missing CLIs when opening an agent picker. */
@Throws(Exception::class)
suspend fun RiffetApi.backends(recheckMissing: Boolean): List<NativeBackendCatalogEntry> =
    get("/api/backends", if (recheckMissing) listOf("recheck" to "1") else emptyList()).decode()

/** `GET /api/backends/:id/profiles`: the saved profiles of one CLI. */
@Throws(Exception::class)
suspend fun RiffetApi.backendProfiles(backendId: NativeBackendId): NativeBackendProfilesResponse =
    get("/api/backends/${backendId.wire()}/profiles").decode()

/** `GET /api/backends/:id/command-observation`: `unsupported`, `inactive`, `untrusted` or `active`. */
@Throws(Exception::class)
suspend fun RiffetApi.commandObservation(backendId: NativeBackendId): String =
    get("/api/backends/${backendId.wire()}/command-observation").decode<JsonObject>().observationState()

/** `POST /api/backends/:id/command-observation/trust`: answers like [commandObservation]. */
@Throws(Exception::class)
suspend fun RiffetApi.trustCommandObservation(backendId: NativeBackendId): String =
    post("/api/backends/${backendId.wire()}/command-observation/trust", buildJsonObject {}).decode<JsonObject>().observationState()

private fun JsonObject.observationState(): String = this["state"]?.jsonPrimitive?.contentOrNull ?: "unsupported"

/**
 * `POST /api/backends/:id/profiles`. The server answers with the whole list rather than the row,
 * so the row is picked out of it; a list that does not contain the submitted [id] is a protocol
 * failure and throws instead of returning a stale object (the web client throws here too).
 */
@Throws(Exception::class)
suspend fun RiffetApi.createBackendProfile(
    backendId: NativeBackendId,
    id: String,
    body: NativeBackendProfileSettingsUpdate,
): NativeBackendProfileSettings {
    val fields = WireJson.encodeToJsonElement(body) as JsonObject
    val payload = buildJsonObject {
        put("id", JsonPrimitive(id))
        fields.forEach { (name, value) -> put(name, value) }
    }
    val response: NativeBackendProfilesResponse =
        post("/api/backends/${backendId.wire()}/profiles", payload).decode()
    return response.profiles.find { it.id == id } ?: missingProfileReceipt()
}

/** `PATCH /api/backends/:id/profiles/:profileId`; same whole-list reply and same receipt check. */
@Throws(Exception::class)
suspend fun RiffetApi.updateBackendProfile(
    backendId: NativeBackendId,
    profileId: String,
    body: NativeBackendProfileSettingsUpdate,
): NativeBackendProfileSettings {
    val response: NativeBackendProfilesResponse =
        patch("/api/backends/${backendId.wire()}/profiles/${profileId.enc()}", wireBody(body)).decode()
    return response.profiles.find { it.id == profileId } ?: missingProfileReceipt()
}

/** `DELETE /api/backends/:id/profiles/:profileId`. Returns the list with the profile removed. */
@Throws(Exception::class)
suspend fun RiffetApi.deleteBackendProfile(
    backendId: NativeBackendId,
    profileId: String,
): NativeBackendProfilesResponse =
    delete("/api/backends/${backendId.wire()}/profiles/${profileId.enc()}").decode()

/**
 * `POST /api/backends/:id/model-probe`. Interrogates a gateway with **unsaved** form values —
 * the typed key included — and persists nothing.
 */
@Throws(Exception::class)
suspend fun RiffetApi.probeBackendModels(
    backendId: NativeBackendId,
    body: ProbeBackendModelsBody,
): List<ModelInfo> =
    post("/api/backends/${backendId.wire()}/model-probe", wireBody(body))
        .decode<NativeBackendModelProbeResponse>().models

/** `GET /api/integrations`: the plugins as last detected, in precedence order. */
@Throws(Exception::class)
suspend fun RiffetApi.plugins(): List<PluginDescriptor> =
    get("/api/integrations").decode<PluginsResponse>().integrations

/** `POST /api/integrations/refresh`: re-runs detection, then answers like [plugins]. */
@Throws(Exception::class)
suspend fun RiffetApi.refreshPlugins(): List<PluginDescriptor> =
    post("/api/integrations/refresh", buildJsonObject {}).decode<PluginsResponse>().integrations

/** `PATCH /api/integrations`: the share publisher new shares use; a null [id] clears it (sent as an explicit `null`). */
@Throws(Exception::class)
suspend fun RiffetApi.setDefaultSharePublisher(id: String?): List<PluginDescriptor> =
    patch("/api/integrations", buildJsonObject { put("defaultSharePublisher", id?.let(::JsonPrimitive) ?: JsonNull) })
        .decode<PluginsResponse>().integrations

/** `POST /api/integrations/:id/actions/:action`. A device-code login answers [ActionStep.ShowCode]. */
@Throws(Exception::class)
suspend fun RiffetApi.runPluginAction(id: String, action: String): ActionStep =
    post("/api/integrations/${id.enc()}/actions/${action.enc()}", buildJsonObject {}).decode()

/** `POST /api/integrations/:id/flows/:flowId/poll`: one poll of a device-code login. */
@Throws(Exception::class)
suspend fun RiffetApi.pollPluginFlow(id: String, flowId: String): ActionStep =
    post("/api/integrations/${id.enc()}/flows/${flowId.enc()}/poll", buildJsonObject {}).decode()

/**
 * `GET /api/backends/:id/catalog`. [allModels] asks for every model the backend reports rather
 * than the profile's curated subset, which is what the settings page needs.
 */
@Throws(Exception::class)
suspend fun RiffetApi.backendCatalog(
    backendId: NativeBackendId,
    profileId: String? = null,
    projectId: String? = null,
    allModels: Boolean = false,
    global: Boolean = false,
): NativeBackendCatalogEntry = agentCatalog(backendId.wire(), profileId, projectId, allModels, global)

/**
 * `GET /api/backends/:id/usage`: account quota and per-model load, read live. A [sessionId] pins
 * the profile and project the session runs on.
 */
@Throws(Exception::class)
suspend fun RiffetApi.backendUsage(
    backendId: NativeBackendId,
    projectId: String? = null,
    profileId: String? = null,
    sessionId: String? = null,
    global: Boolean = false,
): NativeBackendUsage = agentUsage(backendId.wire(), projectId, profileId, sessionId, global)

/**
 * `GET /api/backends/:id/slash`: the `/` menu for a backend in a project, or in the project and
 * profile a [sessionId] runs on.
 */
@Throws(Exception::class)
suspend fun RiffetApi.slashCatalog(
    backendId: NativeBackendId,
    projectId: String? = null,
    profileId: String? = null,
    sessionId: String? = null,
    global: Boolean = false,
): NativeSlashCatalog = agentSlashCatalog(backendId.wire(), projectId, profileId, sessionId, global)

private fun extensionPath(context: ExtensionContext, suffix: String = ""): String =
    "/api/backends/${context.backendId.wire()}/extensions$suffix"

private fun extensionQuery(context: ExtensionContext): List<Pair<String, String>> =
    listOf("profileId" to context.profileId) + listOfNotNull(context.projectId?.let { "projectId" to it })

/** `GET /api/backends/:id/loaded-extensions`: the MCP servers and skills a launch in the project loads; the first read may take several seconds. */
@Throws(Exception::class)
suspend fun RiffetApi.loadedExtensions(backendId: NativeBackendId, profileId: String?, projectId: String): LoadedExtensions =
    get("/api/backends/${backendId.wire()}/loaded-extensions", listOfNotNull(profileId?.let { "profileId" to it }, "projectId" to projectId), 30_000).decode()

@Throws(Exception::class)
suspend fun RiffetApi.extensions(context: ExtensionContext): ExtensionInventory = get(extensionPath(context), extensionQuery(context), 30_000).decode()

@Throws(Exception::class)
suspend fun RiffetApi.extension(context: ExtensionContext, itemId: String): ExtensionDetail = get(extensionPath(context, "/${itemId.enc()}"), extensionQuery(context), 30_000).decode()

@Throws(Exception::class)
suspend fun RiffetApi.extensionDocument(context: ExtensionContext, documentId: String): ExtensionDocument = get(extensionPath(context, "/documents/${documentId.enc()}"), extensionQuery(context)).decode()

@Throws(Exception::class)
suspend fun RiffetApi.saveExtensionDocument(context: ExtensionContext, documentId: String, content: String, expectedHash: String): ExtensionDocument =
    request(HttpMethod.Put, extensionPath(context, "/documents/${documentId.enc()}"), extensionQuery(context), buildJsonObject {
        put("content", content)
        put("expectedHash", expectedHash)
    }).decode()

@Throws(Exception::class)
suspend fun RiffetApi.createExtensionDocument(context: ExtensionContext, targetId: String, path: String, content: String): ExtensionDocument =
    request(HttpMethod.Post, extensionPath(context, "/documents"), extensionQuery(context), buildJsonObject {
        put("targetId", targetId)
        put("path", path)
        put("content", content)
    }).decode()

@Throws(Exception::class)
suspend fun RiffetApi.extensionCapabilities(context: ExtensionContext): ExtensionManagementCapabilities = get(extensionPath(context, "/capabilities"), extensionQuery(context), 30_000).decode()

@Throws(Exception::class)
suspend fun RiffetApi.extensionRuntime(context: ExtensionContext): ExtensionRuntimeReport = get(extensionPath(context, "/runtime"), extensionQuery(context), 30_000).decode()

@Throws(Exception::class)
suspend fun RiffetApi.extensionAction(context: ExtensionContext, input: ExtensionActionRequest): ExtensionActionResult =
    request(HttpMethod.Post, extensionPath(context, "/actions"), extensionQuery(context), WireJson.encodeToJsonElement(ExtensionActionRequest.serializer(), input), timeoutMillis = 240_000).decode()

/**
 * The web client treats a submitted profile that is absent from the whole-list reply as a failure
 * rather than falling back to its local copy, so an unconfirmed save is never shown as saved.
 */
private fun missingProfileReceipt(): Nothing =
    throw IllegalStateException("Provider was submitted but the receipt did not contain the saved profile")
