package riffet.shared

import io.ktor.client.request.forms.MultiPartFormDataContent
import io.ktor.client.request.forms.formData
import io.ktor.http.Headers
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.encodeURLQueryComponent
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
