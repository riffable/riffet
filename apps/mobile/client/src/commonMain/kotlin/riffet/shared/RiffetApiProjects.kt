package riffet.shared

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import riffet.contracts.BrowseResult
import riffet.contracts.FolderFavorite
import riffet.contracts.FolderFavoritesResponse
import riffet.contracts.Project

// RiffetApi endpoints — projects, directories and folder favorites. Transport and auth rules: see RiffetApi.kt.

@Throws(Exception::class)
suspend fun RiffetApi.projects(): List<Project> = get("/api/projects").decode()

/**
 * `POST /api/projects`: binds a directory on the *server* host. The server canonicalizes the
 * path (symlinks, `..`) and returns the existing project when the directory is already
 * registered, so choosing an already-known directory is idempotent rather than an error.
 */
@Throws(Exception::class)
suspend fun RiffetApi.createProject(cwd: String, name: String? = null): Project =
    post("/api/projects", wireBody(CreateProjectBody(cwd = cwd, name = name))).decode()

/** `PATCH /api/projects/:id`. Only `archived` is used here: choosing an archived directory restores it. */
@Throws(Exception::class)
suspend fun RiffetApi.updateProject(id: String, archived: Boolean): Project =
    patch("/api/projects/${id.enc()}", wireBody(UpdateProjectBody(archived = archived))).decode()

/**
 * `POST /api/browse`: lists directories on the machine running the server, which is the only
 * machine whose filesystem matters — the phone picks a folder there, not on the phone.
 */
@Throws(Exception::class)
suspend fun RiffetApi.browse(path: String? = null): BrowseResult =
    post("/api/browse", wireBody(BrowseBody(path = path))).decode()

/**
 * `GET /api/folder-favorites`: the host's favorite folders, or with [projectId] that project's
 * files-panel favorites; in their saved order.
 */
@Throws(Exception::class)
suspend fun RiffetApi.folderFavorites(projectId: String? = null): List<FolderFavorite> =
    get("/api/folder-favorites", listOfNotNull(projectId?.let { "projectId" to it })).decode<FolderFavoritesResponse>().favorites

/** `POST /api/folder-favorites`: idempotent; [path] is absolute, or relative to [projectId]'s root. */
@Throws(Exception::class)
suspend fun RiffetApi.addFolderFavorite(path: String, projectId: String? = null, label: String? = null): FolderFavorite =
    post(
        "/api/folder-favorites",
        buildJsonObject {
            put("path", JsonPrimitive(path))
            if (projectId != null) put("projectId", JsonPrimitive(projectId))
            if (label != null) put("label", JsonPrimitive(label))
        },
    ).decode()

/** `PATCH /api/folder-favorites/:id`: an empty [label] clears it; [used] stamps `lastUsedAt`. */
@Throws(Exception::class)
suspend fun RiffetApi.updateFolderFavorite(id: String, label: String? = null, used: Boolean = false): FolderFavorite =
    patch(
        "/api/folder-favorites/${id.enc()}",
        buildJsonObject {
            if (label != null) put("label", if (label.isEmpty()) JsonNull else JsonPrimitive(label))
            if (used) put("used", JsonPrimitive(true))
        },
    ).decode()

/** `PUT /api/folder-favorites/order`: one scope's favorites in their new order. */
@Throws(Exception::class)
suspend fun RiffetApi.reorderFolderFavorites(ids: List<String>, projectId: String? = null): List<FolderFavorite> =
    put(
        "/api/folder-favorites/order",
        buildJsonObject {
            put("ids", JsonArray(ids.map(::JsonPrimitive)))
            if (projectId != null) put("projectId", JsonPrimitive(projectId))
        },
    ).decode<FolderFavoritesResponse>().favorites

@Throws(Exception::class)
suspend fun RiffetApi.removeFolderFavorite(id: String) {
    delete("/api/folder-favorites/${id.enc()}").discard()
}

/** `PATCH /api/projects/:id` with any of name, tags and archived; absent fields are left alone. */
@Throws(Exception::class)
suspend fun RiffetApi.updateProject(id: String, name: String?, tags: List<String>?, archived: Boolean?): Project =
    patch(
        "/api/projects/${id.enc()}",
        buildJsonObject {
            if (name != null) put("name", JsonPrimitive(name))
            if (tags != null) put("tags", JsonArray(tags.map(::JsonPrimitive)))
            if (archived != null) put("archived", JsonPrimitive(archived))
        },
    ).decode()

@Throws(Exception::class)
suspend fun RiffetApi.deleteProject(id: String) {
    delete("/api/projects/${id.enc()}").discard()
}

/** Gives a worktree of [projectId] a project of its own; without [path] the server cuts a fresh one. */
@Throws(Exception::class)
suspend fun RiffetApi.createWorktreeProject(projectId: String, path: String? = null, name: String? = null): Project =
    post(
        "/api/projects/${projectId.enc()}/worktree-projects",
        buildJsonObject {
            if (path != null) put("path", JsonPrimitive(path))
            if (name != null) put("name", JsonPrimitive(name))
        },
    ).decode()

/** Keeps the workspace and session identities, making its project selectable. */
@Throws(Exception::class)
suspend fun RiffetApi.promoteProject(id: String, name: String): riffet.contracts.Project =
    post("/api/projects/${id.enc()}/promote", kotlinx.serialization.json.buildJsonObject {
        put("name", kotlinx.serialization.json.JsonPrimitive(name))
    }).decode()
