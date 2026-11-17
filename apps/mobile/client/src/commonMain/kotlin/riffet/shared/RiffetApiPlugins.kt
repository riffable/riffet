package riffet.shared

import io.ktor.client.request.forms.MultiPartFormDataContent
import io.ktor.client.request.forms.formData
import io.ktor.http.Headers
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.encodeURLQueryComponent
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.decodeFromJsonElement

/** Management calls target this API's service and use its bearer token, including multipart upload. */
@Throws(Exception::class)
suspend fun RiffetApi.updatePlugin(id: String, update: PluginUpdate): PluginDescriptor =
    patch("/api/integrations/" + id.enc(), wireBody(update)).decode()

@Throws(Exception::class)
suspend fun RiffetApi.selectPluginVersion(id: String, version: String): PluginDescriptor =
    post("/api/integrations/" + id.enc() + "/versions/" + version.enc() + "/select").decode()

@Throws(Exception::class)
suspend fun RiffetApi.uninstallPluginVersion(id: String, version: String): List<PluginDescriptor> =
    delete("/api/integrations/" + id.enc() + "/versions/" + version.enc()).decode<PluginsResponse>().integrations

@Throws(Exception::class)
suspend fun RiffetApi.uninstallPlugin(id: String, source: String? = null, path: String? = null): List<PluginDescriptor> {
    val query = listOfNotNull(
        source?.let { "source=" + it.encodeURLQueryComponent() },
        path?.let { "path=" + it.encodeURLQueryComponent() },
    ).joinToString("&")
    return delete("/api/integrations/" + id.enc() + if (query.isEmpty()) "" else "?$query").decode<PluginsResponse>().integrations
}

@Throws(Exception::class)
suspend fun RiffetApi.unlinkDevelopmentPlugin(id: String): List<PluginDescriptor> =
    delete("/api/integrations/development/" + id.enc()).decode<PluginsResponse>().integrations

@Throws(Exception::class)
suspend fun RiffetApi.deletePluginData(id: String): List<PluginDescriptor> =
    delete("/api/integrations/" + id.enc() + "/data").decode<PluginsResponse>().integrations

@Throws(Exception::class)
suspend fun RiffetApi.installPluginPackage(bytes: ByteArray, fileName: String, grant: List<String>, trusted: Boolean = false): PluginInstallationResult {
    require(bytes.size <= 32 * 1024 * 1024) { "Package exceeds 32 MB" }
    val name = fileName.replace(Regex("[^a-zA-Z0-9._-]"), "_").take(128).ifEmpty { "plugin.tgz" }
    val body = MultiPartFormDataContent(formData {
        append("package", bytes, Headers.build {
            append(HttpHeaders.ContentType, "application/gzip")
            append(HttpHeaders.ContentDisposition, "filename=\"" + name + "\"")
        })
        append("grant", WireJson.encodeToString(kotlinx.serialization.serializer<List<String>>(), grant))
        append("trusted", trusted.toString())
    })
    return try {
        PluginInstallationResult(plugin = request(HttpMethod.Post, "/api/integrations/install", timeoutMillis = 120_000, multipart = body).decode())
    } catch (error: RiffetHttpException) {
        if (error.code !in setOf("PLUGIN_GRANT_REQUIRED", "PLUGIN_TRUST_REQUIRED") || error.details == null) throw error
        PluginInstallationResult(grant = WireJson.decodeFromJsonElement<PluginGrantRequired>(error.details))
    }
}

/** One plugin of the public index as the server lists it; text maps are keyed by locale. */
@Serializable
data class PluginMarketEntry(
    /** The source listing it. */
    val sourceId: String = PLUGIN_SOURCE_BUILTIN,
    /** Installed on this server: the selected version, and whether it came from this source. */
    val installed: PluginMarketInstalled? = null,
    /** With `installed.sameSource`: this entry is newer than the installed version and runs here. */
    val update: Boolean = false,
    val id: String,
    val vendor: String,
    val title: Map<String, String>? = null,
    val description: Map<String, String>? = null,
    val version: String,
    val date: String? = null,
    val size: Long? = null,
    val license: String? = null,
    val source: String? = null,
    val page: String? = null,
    val readme: String? = null,
    val contributes: List<String> = emptyList(),
    val capabilities: List<String> = emptyList(),
    val modelSources: List<PluginGrantModelSource>? = null,
    val executables: List<String>? = null,
    val trustedRequired: Boolean? = null,
    /** False when no release runs on this server. */
    val compatible: Boolean,
)

@Serializable
data class PluginMarketInstalled(val version: String, val sameSource: Boolean = false)

/** The id of the public plugin index, the source every server starts with. */
const val PLUGIN_SOURCE_BUILTIN = "riffet"

/** A plugin index the server reads; a failed read leaves the others listed. */
@Serializable
data class PluginSource(
    val id: String,
    val url: String,
    val name: String? = null,
    val builtin: Boolean = false,
    val fixed: Boolean = false,
    val enabled: Boolean = true,
    val plugins: Int? = null,
    val error: String? = null,
)

@Serializable
data class PluginMarketList(
    val plugins: List<PluginMarketEntry> = emptyList(),
    val sources: List<PluginSource> = emptyList(),
    val trustedAllowed: Boolean = false,
)

@Throws(Exception::class)
suspend fun RiffetApi.marketPlugins(refresh: Boolean = false): PluginMarketList =
    get("/api/integrations/market", if (refresh) listOf("refresh" to "1") else emptyList(), timeoutMillis = 30_000).decode()

/** Reads the index once and saves it; an address that cannot be read is refused. */
@Throws(Exception::class)
suspend fun RiffetApi.addPluginSource(url: String): PluginMarketList =
    post("/api/integrations/sources", kotlinx.serialization.json.buildJsonObject { put("url", kotlinx.serialization.json.JsonPrimitive(url)) }).decode()

@Throws(Exception::class)
suspend fun RiffetApi.setPluginSourceEnabled(id: String, enabled: Boolean): PluginMarketList =
    patch("/api/integrations/sources/" + id.enc(), kotlinx.serialization.json.buildJsonObject { put("enabled", kotlinx.serialization.json.JsonPrimitive(enabled)) }).decode()

@Throws(Exception::class)
suspend fun RiffetApi.removePluginSource(id: String): PluginMarketList =
    delete("/api/integrations/sources/" + id.enc()).decode()

/** A release of a plugin index before it is installed: the grant request, and the source it came from. */
@Serializable
data class PluginMarketOffer(
    val id: String,
    val version: String,
    val sourceId: String = PLUGIN_SOURCE_BUILTIN,
    val capabilities: List<String> = emptyList(),
    val trustedRequired: Boolean = false,
    val trustedAllowed: Boolean = false,
    val modelSources: List<PluginGrantModelSource>? = null,
    val executables: List<String>? = null,
) {
    val grant: PluginGrantRequired get() = PluginGrantRequired(id, version, capabilities, trustedRequired, trustedAllowed, modelSources, executables)
}

/** A release in the public plugin index, before it is installed; it has the shape of a grant request so one sheet confirms both. */
@Throws(Exception::class)
suspend fun RiffetApi.marketPluginOffer(id: String, version: String? = null, source: String? = null): PluginMarketOffer =
    get("/api/integrations/market/" + id.enc(), listOfNotNull(version?.let { "version" to it }, source?.let { "source" to it }), timeoutMillis = 30_000).decode()

/** The server downloads the release from the plugin index and installs it only if its content is what the index lists. */
@Throws(Exception::class)
suspend fun RiffetApi.installMarketPlugin(id: String, version: String, source: String, grant: List<String>, trusted: Boolean = false): PluginInstallationResult {
    val body = kotlinx.serialization.json.buildJsonObject {
        put("market", kotlinx.serialization.json.buildJsonObject {
            put("source", kotlinx.serialization.json.JsonPrimitive(source))
            put("id", kotlinx.serialization.json.JsonPrimitive(id))
            put("version", kotlinx.serialization.json.JsonPrimitive(version))
        })
        put("grant", kotlinx.serialization.json.JsonArray(grant.map { kotlinx.serialization.json.JsonPrimitive(it) }))
        put("trusted", kotlinx.serialization.json.JsonPrimitive(trusted))
    }
    return try {
        PluginInstallationResult(plugin = request(HttpMethod.Post, "/api/integrations/install", body = body, timeoutMillis = 180_000).decode())
    } catch (error: RiffetHttpException) {
        if (error.code !in setOf("PLUGIN_GRANT_REQUIRED", "PLUGIN_TRUST_REQUIRED") || error.details == null) throw error
        PluginInstallationResult(grant = WireJson.decodeFromJsonElement<PluginGrantRequired>(error.details))
    }
}

@Throws(Exception::class)
suspend fun RiffetApi.pluginInventory(): PluginsResponse = get("/api/integrations").decode()

@Throws(Exception::class)
suspend fun RiffetApi.setPluginRecovery(enabled: Boolean): PluginsResponse =
    post("/api/integrations/recovery", kotlinx.serialization.json.buildJsonObject { put("enabled", kotlinx.serialization.json.JsonPrimitive(enabled)) }).decode()

@Throws(Exception::class)
suspend fun RiffetApi.reloadPlugin(id: String): PluginDescriptor =
    post("/api/integrations/" + id.enc() + "/reload").decode()

@Throws(Exception::class)
suspend fun RiffetApi.pluginDiagnostics(id: String): List<PluginDiagnostic> = post("/api/integrations/" + id.enc() + "/diagnostics").decode()


@Throws(Exception::class)
suspend fun RiffetApi.activatePluginView(id: String, viewId: String): PluginDescriptor =
    post("/api/integrations/" + id.enc() + "/activate", kotlinx.serialization.json.buildJsonObject {
        put("kind", kotlinx.serialization.json.JsonPrimitive("view"))
        put("id", kotlinx.serialization.json.JsonPrimitive(viewId))
    }).decode()

@Throws(Exception::class)
suspend fun RiffetApi.pluginLogs(id: String): PluginLogsResponse = get("/api/integrations/" + id.enc() + "/logs").decode()

/** The plugin's own page in [locale] (docs/PLUGIN_ARCHITECTURE.md「插件页」). */
@Throws(Exception::class)
suspend fun RiffetApi.pluginPage(id: String, locale: String): PluginPageResponse =
    get("/api/integrations/" + id.enc() + "/page?locale=" + locale.encodeURLQueryComponent()).decode()

/** Saves one of the page's values and answers with the page read again; `null` clears it. */
@Throws(Exception::class)
suspend fun RiffetApi.setPluginPageText(id: String, key: String, value: String?, locale: String): PluginPageResponse =
    changePluginPage(id, locale, "set", kotlinx.serialization.json.buildJsonObject { put("key", kotlinx.serialization.json.JsonPrimitive(key)); put("value", value?.let { kotlinx.serialization.json.JsonPrimitive(it) } ?: kotlinx.serialization.json.JsonNull) })

@Throws(Exception::class)
suspend fun RiffetApi.setPluginPageToggle(id: String, key: String, on: Boolean, locale: String): PluginPageResponse =
    changePluginPage(id, locale, "set", kotlinx.serialization.json.buildJsonObject { put("key", kotlinx.serialization.json.JsonPrimitive(key)); put("value", kotlinx.serialization.json.JsonPrimitive(on)) })

@Throws(Exception::class)
suspend fun RiffetApi.setPluginPageList(id: String, key: String, values: List<String>, locale: String): PluginPageResponse =
    changePluginPage(id, locale, "set", kotlinx.serialization.json.buildJsonObject { put("key", kotlinx.serialization.json.JsonPrimitive(key)); put("value", kotlinx.serialization.json.JsonArray(values.map { kotlinx.serialization.json.JsonPrimitive(it) })) })

/** One of the page's buttons. */
@Throws(Exception::class)
suspend fun RiffetApi.runPluginPageAction(id: String, action: String, item: String?, locale: String): PluginPageResponse =
    changePluginPage(id, locale, "run", kotlinx.serialization.json.buildJsonObject { put("action", kotlinx.serialization.json.JsonPrimitive(action)); item?.let { put("item", kotlinx.serialization.json.JsonPrimitive(it)) } })

private suspend fun RiffetApi.changePluginPage(id: String, locale: String, kind: String, change: kotlinx.serialization.json.JsonObject): PluginPageResponse =
    post("/api/integrations/" + id.enc() + "/page", kotlinx.serialization.json.buildJsonObject { put("locale", kotlinx.serialization.json.JsonPrimitive(locale)); put(kind, change) }).decode()

/** The package's README in [locale], or the nearest one; null when it has none. */
@Throws(Exception::class)
suspend fun RiffetApi.pluginReadme(id: String, locale: String): PluginReadmeResponse =
    get("/api/integrations/" + id.enc() + "/readme?locale=" + locale.encodeURLQueryComponent()).decode()
