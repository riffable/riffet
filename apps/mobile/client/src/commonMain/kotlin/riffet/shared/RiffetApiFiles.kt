package riffet.shared

import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.request
import io.ktor.client.statement.bodyAsChannel
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.contentLength
import io.ktor.utils.io.readAvailable
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import riffet.contracts.ArchiveInfo
import riffet.contracts.Attachment
import riffet.contracts.FileEntry
import riffet.contracts.FilePreview
import riffet.contracts.FileVersion
import riffet.contracts.SearchHit
import riffet.i18n.L10n

// RiffetApi endpoints — project files, previews, downloads and attachments. Transport and auth rules: see RiffetApi.kt.

@Throws(Exception::class)
suspend fun RiffetApi.files(
    projectId: String,
    path: String = "",
    limit: Int? = null,
    offset: Int? = null,
): List<FileEntry> = get(
    "/api/projects/${projectId.enc()}/files",
    buildList {
        add("path" to path)
        if (limit != null) add("limit" to limit.toString())
        if (offset != null) add("offset" to offset.toString())
    },
).decode()

/** `workspace.find` returns `FileEntry[]`; api.ts's `FileSearchResult` union is stale. */
@Throws(Exception::class)
suspend fun RiffetApi.find(projectId: String, query: String): List<FileEntry> =
    get("/api/projects/${projectId.enc()}/find", listOf("q" to query)).decode()

@Throws(Exception::class)
suspend fun RiffetApi.search(projectId: String, query: String): List<SearchHit> =
    get("/api/projects/${projectId.enc()}/search", listOf("q" to query)).decode()

@Throws(Exception::class)
suspend fun RiffetApi.preview(projectId: String, path: String): FilePreview =
    get("/api/projects/${projectId.enc()}/file", listOf("path" to path)).decode()

/**
 * Writes [content] over a text file, only if it is still the version [expectedHash] names (the
 * `hash` of the preview the edit started from); otherwise the server refuses with 409
 * `FILE_CHANGED` and nothing is written. Line endings and a byte-order mark stay as the file had
 * them. Needs the `file-write-v1` protocol feature.
 */
@Throws(Exception::class)
suspend fun RiffetApi.saveFile(projectId: String, path: String, content: String, expectedHash: String): FileVersion =
    put("/api/projects/${projectId.enc()}/file", buildJsonObject {
        put("path", path); put("content", content); put("expectedHash", expectedHash)
    }).decode()

/** The server-prepared interactive HTML; authentication stays in the HTTP client. */
@Throws(Exception::class)
suspend fun RiffetApi.visualization(projectId: String, path: String, scheme: String): String {
    require(scheme == "light" || scheme == "dark") { "Visualization scheme must be light or dark" }
    return get(
        "/api/projects/${projectId.enc()}/file/raw",
        listOf("path" to path, "render" to "visualize", "scheme" to scheme),
    ).bodyAsText()
}

/**
 * The address a project HTML file is served at as a site: the server answers the authenticated
 * request with a redirect to a tokenised path, which is returned unfollowed so the device
 * credential never reaches the WebView. The result resolves against the address actually reached.
 */
@Throws(Exception::class)
suspend fun RiffetApi.fileSiteUrl(projectId: String, path: String, page: String? = null): String {
    // `page`, relative to the folder of `path`, reopens another page of the site rooted there.
    val response = getRedirect("/api/projects/${projectId.enc()}/file/raw", listOf("path" to path, "render" to "site") + listOfNotNull(page?.let { "page" to it }))
    val location = response.headers[HttpHeaders.Location]
    if (response.status.value !in 300..399 || location.isNullOrEmpty()) throw RiffetNetworkException("The page could not be opened", IllegalStateException("No redirect location"))
    return resolveLocation(response.request.url.toString(), location)
}

/** A self-contained, server-generated preview. Credentials never enter the rendered document. */
@Throws(Exception::class)
suspend fun RiffetApi.renderedPreview(
    projectId: String,
    path: String,
    scheme: String,
    color: String,
    background: String,
    line: String,
    accent: String,
): String = get(
    "/api/projects/${projectId.enc()}/file/raw",
    listOf("path" to path, "render" to "preview", "scheme" to scheme,
        "color" to color, "background" to background, "line" to line, "accent" to accent),
).bodyAsText()

/**
 * The file as stored, named the way the server's `Content-Disposition` names it, written to the
 * [DownloadWriter] that [open] returns for that name and type as the body arrives.
 *
 * The server does not cap this body, so it is never held whole: only one read buffer is in
 * memory at a time. [onProgress] is called as it arrives, with the bytes so far and the server's
 * declared length (null when it declared none) — a download whose size the reader cannot see is
 * the one thing a progress notification cannot fake.
 */
@Throws(Exception::class)
suspend fun RiffetApi.downloadFile(
    projectId: String,
    path: String,
    onProgress: ((received: Long, total: Long?) -> Unit)? = null,
    open: suspend (name: String, mimeType: String?) -> DownloadWriter,
): DownloadedFile = streamGet("/api/projects/${projectId.enc()}/file/raw", listOf("path" to path, "download" to "1")) { response ->
    val name = response.headers[HttpHeaders.ContentDisposition]?.let(::dispositionFileName)
        ?: path.substringAfterLast('/').ifEmpty { "download" }
    val mimeType = response.headers[HttpHeaders.ContentType]?.substringBefore(';')?.trim()
    val size = response.copyBody(open(name, mimeType), onProgress)
    DownloadedFile(name, mimeType, size)
}

/** An uploaded attachment, using the same bounded streaming download as project files. */
@Throws(Exception::class)
suspend fun RiffetApi.downloadAttachment(
    attachmentId: String,
    suggestedName: String,
    onProgress: ((received: Long, total: Long?) -> Unit)? = null,
    open: suspend (name: String, mimeType: String?) -> DownloadWriter,
): DownloadedFile = streamGet("/api/attachments/${attachmentId.enc()}", emptyList()) { response ->
    val name = response.headers[HttpHeaders.ContentDisposition]?.let(::dispositionFileName)
        ?: suggestedName.ifEmpty { L10n.uiText("downloads.attachmentFallback") }
    val mimeType = response.headers[HttpHeaders.ContentType]?.substringBefore(';')?.trim()
    DownloadedFile(name, mimeType, response.copyBody(open(name, mimeType), onProgress))
}

/** A file a team member left in its `files/` folder (docs/TEAM.md), with the same bounded streaming download. */
@Throws(Exception::class)
suspend fun RiffetApi.downloadMemberFile(
    memberId: String,
    path: String,
    onProgress: ((received: Long, total: Long?) -> Unit)? = null,
    open: suspend (name: String, mimeType: String?) -> DownloadWriter,
): DownloadedFile = streamGet("/api/team/members/${memberId.enc()}/file", listOf("path" to path)) { response ->
    val name = response.headers[HttpHeaders.ContentDisposition]?.let(::dispositionFileName)
        ?: path.substringAfterLast('/').ifEmpty { "download" }
    val mimeType = response.headers[HttpHeaders.ContentType]?.substringBefore(';')?.trim()
        ?.takeUnless { it == "application/octet-stream" }
    DownloadedFile(name, mimeType, response.copyBody(open(name, mimeType), onProgress))
}

/** Copies the body into [writer] one read at a time, reporting as it goes; returns the byte count. */
private suspend fun HttpResponse.copyBody(writer: DownloadWriter, onProgress: ((Long, Long?) -> Unit)?): Long {
    val total = contentLength()
    val channel = bodyAsChannel()
    val buffer = ByteArray(8 * 1024)
    var received = 0L
    onProgress?.invoke(0L, total)
    while (true) {
        val read = channel.readAvailable(buffer, 0, buffer.size)
        if (read < 0) break
        if (read == 0) continue
        writer.write(buffer, 0, read)
        received += read
        onProgress?.invoke(received, total)
    }
    return received
}

@Throws(Exception::class)
suspend fun RiffetApi.attachmentMetadata(attachmentId: String): Attachment =
    get("/api/attachments/${attachmentId.enc()}/metadata").decode()

@Throws(Exception::class)
suspend fun RiffetApi.uploadAttachment(projectId: String?, body: UploadAttachmentRequest): Attachment {
    val target = targetServerId ?: projectId?.let(locator::serverOf)
    return forServer(target).post(projectId?.let { "/api/projects/${it.enc()}/attachments" } ?: "/api/attachments", wireBody(body))
        .decode<Attachment>()
        .also { locator.locateOne(it.id, target) }
}

@Throws(Exception::class)
suspend fun RiffetApi.archiveInfo(projectId: String, path: String): ArchiveInfo =
    get("/api/projects/${projectId.enc()}/archive", listOf("path" to path, "check" to "1")).decode()

/** [location] against [base], dot segments removed (RFC 3986 §5.2); the server answers with `../` paths. */
internal fun resolveLocation(base: String, location: String): String {
    if (Regex("^[a-zA-Z][a-zA-Z0-9+.-]*:").containsMatchIn(location)) return location
    val origin = Regex("^[a-zA-Z][a-zA-Z0-9+.-]*://[^/?#]*").find(base)?.value ?: return location
    val basePath = base.removePrefix(origin).substringBefore('#').substringBefore('?')
    val tail = location.indexOfFirst { it == '?' || it == '#' }.let { if (it < 0) "" else location.substring(it) }
    val ref = if (tail.isEmpty()) location else location.substring(0, location.length - tail.length)
    val merged = if (ref.startsWith("/")) ref else basePath.substringBeforeLast('/', "") + "/" + ref
    val out = ArrayList<String>()
    val segments = merged.split('/')
    segments.forEachIndexed { index, segment ->
        when (segment) {
            "." -> {}
            ".." -> { if (out.size > 1) out.removeAt(out.lastIndex) }
            else -> if (segment.isNotEmpty() || index == segments.lastIndex || out.isEmpty()) out.add(segment)
        }
    }
    val last = segments.last()
    if (last == "." || last == "..") out.add("")
    return origin + out.joinToString("/") + tail
}
