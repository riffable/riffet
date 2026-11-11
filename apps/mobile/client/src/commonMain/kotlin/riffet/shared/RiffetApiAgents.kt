package riffet.shared

import riffet.contracts.NativeBackendCatalogEntry
import riffet.contracts.NativeBackendUsage
import riffet.contracts.NativeSlashCatalog

// RiffetApi endpoints — an Agent named by its raw id, so the macOS app can reach a plugin's Agent
// (docs/design/plugin-system.md §5.1). The `backendCatalog`, `backendUsage` and `slashCatalog`
// overloads over `NativeBackendId` forward here. Transport and auth rules: see RiffetApi.kt.

/** `GET /api/backends/:id/catalog` for any Agent id, built in or a plugin's. */
@Throws(Exception::class)
suspend fun RiffetApi.agentCatalog(
    agentId: String,
    profileId: String? = null,
    projectId: String? = null,
    allModels: Boolean = false,
    global: Boolean = false,
): NativeBackendCatalogEntry = get(
    "/api/backends/${agentId.enc()}/catalog",
    buildList {
        require(!global || projectId == null) { "Global catalog cannot select a project" }
        if (global) add("scope" to "global")
        if (profileId != null) add("profileId" to profileId)
        if (projectId != null) add("projectId" to projectId)
        if (allModels) add("allModels" to "1")
    },
).decode()

/** `GET /api/backends/:id/usage` for any Agent id. */
@Throws(Exception::class)
suspend fun RiffetApi.agentUsage(
    agentId: String,
    projectId: String? = null,
    profileId: String? = null,
    sessionId: String? = null,
    global: Boolean = false,
): NativeBackendUsage = get("/api/backends/${agentId.enc()}/usage", scopeQuery(projectId, profileId, sessionId, global)).decode()

/** `GET /api/backends/:id/slash` for any Agent id. */
@Throws(Exception::class)
suspend fun RiffetApi.agentSlashCatalog(
    agentId: String,
    projectId: String? = null,
    profileId: String? = null,
    sessionId: String? = null,
    global: Boolean = false,
): NativeSlashCatalog = get("/api/backends/${agentId.enc()}/slash", scopeQuery(projectId, profileId, sessionId, global)).decode()

private fun scopeQuery(projectId: String?, profileId: String?, sessionId: String?, global: Boolean): List<Pair<String, String>> = buildList {
    require(!global || projectId == null && sessionId == null) { "Global scope cannot select a project or session" }
    if (global) add("scope" to "global")
    if (projectId != null) add("projectId" to projectId)
    if (profileId != null) add("profileId" to profileId)
    if (sessionId != null) add("sessionId" to sessionId)
}
