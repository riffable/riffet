package riffet.shared

import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import riffet.contracts.Mark
import riffet.contracts.MarkCreateRequest
import riffet.contracts.MarkListPage
import riffet.contracts.MarkListQuery
import riffet.contracts.MarkLocation
import riffet.contracts.MarkPrompt

// RiffetApi endpoints — saved replies (收藏). Transport and auth rules: see RiffetApi.kt.

@Throws(Exception::class)
suspend fun RiffetApi.marks(query: MarkListQuery = MarkListQuery()): MarkListPage =
    get("/api/marks", query.pairs()).decode()

/**
 * [marks] under the server's marks revision, which every list read shares: [etag] from any
 * earlier read answers 304 (items null) until a mark changes anywhere.
 */
@Throws(Exception::class)
suspend fun RiffetApi.marksIfChanged(query: MarkListQuery, etag: String?): ConditionalList<Mark> {
    val response = request(HttpMethod.Get, "/api/marks", query.pairs(), ifNoneMatch = etag)
    val next = response.headers[HttpHeaders.ETag]
    if (response.status == HttpStatusCode.NotModified) return ConditionalList(null, next ?: etag)
    return ConditionalList(response.decode<MarkListPage>().marks, next)
}

/** Idempotent on the client-generated id; the same message again answers with the existing mark. */
@Throws(Exception::class)
suspend fun RiffetApi.createMark(body: MarkCreateRequest): Mark = post("/api/marks", wireBody(body)).decode()

/** `PATCH /api/marks/:id`: an empty [note] clears it; a null field stays as it is. */
@Throws(Exception::class)
suspend fun RiffetApi.updateMark(id: String, note: String? = null, color: String? = null): Mark =
    patch(
        "/api/marks/${id.enc()}",
        buildJsonObject {
            if (note != null) put("note", if (note.isEmpty()) JsonNull else JsonPrimitive(note))
            if (color != null) put("color", JsonPrimitive(color))
        },
    ).decode()

/** Deleting what is already gone succeeds. */
@Throws(Exception::class)
suspend fun RiffetApi.deleteMarks(ids: List<String>) {
    when (ids.size) {
        0 -> return
        1 -> delete("/api/marks/${ids[0].enc()}").discard()
        else -> post("/api/marks/delete", buildJsonObject { put("ids", JsonArray(ids.map(::JsonPrimitive))) }).discard()
    }
}

@Throws(Exception::class)
suspend fun RiffetApi.locateMark(id: String): MarkLocation = get("/api/marks/${id.enc()}/locate").decode()

/** The question that started a saved answer; null when the server does not know it. */
@Throws(Exception::class)
suspend fun RiffetApi.markPrompt(id: String): String? = get("/api/marks/${id.enc()}/prompt").decode<MarkPrompt>().text

private fun MarkListQuery.pairs(): List<Pair<String, String>> = buildList {
    add("limit" to limit.toString())
    sessionId?.let { add("sessionId" to it) }
    projectId?.let { add("projectId" to it) }
    kinds.forEach { add("kind" to it) }
    state?.let { add("state" to it) }
    q?.trim()?.takeIf { it.isNotEmpty() }?.let { add("q" to it) }
    cursor?.let { add("cursor" to it) }
}
