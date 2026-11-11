package riffet.shared

import io.ktor.client.statement.bodyAsChannel
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.utils.io.readLine
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import riffet.contracts.*

private fun shareSessionPath(id: String) = "/api/sessions/${id.enc()}/share"
private fun sharePath(id: String) = "/api/shares/${id.enc()}"

@Throws(Exception::class)
suspend fun RiffetApi.shareStatus(sessionId: String, fresh: Boolean = false): ShareStatus =
    get("${shareSessionPath(sessionId)}/status", if (fresh) listOf("fresh" to "true") else emptyList()).decode()

@Throws(Exception::class)
suspend fun RiffetApi.shares(): List<SessionShare> = get("/api/shares").decode()

@Throws(Exception::class)
suspend fun RiffetApi.shareTurns(sessionId: String): ShareTurnCatalog = get("${shareSessionPath(sessionId)}/turns").decode()

@Throws(Exception::class)
suspend fun RiffetApi.shareDraft(sessionId: String, body: ShareDraftRequest, onProgress: ((ShareDraftProgress) -> Unit)? = null): ShareDraft =
    shareDraftAt("${shareSessionPath(sessionId)}/draft", body, onProgress)

/** A local print snapshot needs no publishing account and cannot be published. */
@Throws(Exception::class)
suspend fun RiffetApi.sharePrintDraft(sessionId: String, body: ShareDraftRequest, onProgress: ((ShareDraftProgress) -> Unit)? = null): ShareDraft =
    shareDraftAt("${shareSessionPath(sessionId)}/print", body, onProgress)

private suspend fun RiffetApi.shareDraftAt(path: String, body: ShareDraftRequest, onProgress: ((ShareDraftProgress) -> Unit)?): ShareDraft =
    streamPost(path, wireBody(body)) { response ->
        if (!response.headers[HttpHeaders.ContentType].orEmpty().contains("application/x-ndjson", ignoreCase = true)) {
            RiffetJson.instance.decodeFromString<ShareDraft>(response.bodyAsText())
        } else {
            val channel = response.bodyAsChannel()
            try {
                var draft: ShareDraft? = null
                while (true) {
                    currentCoroutineContext().ensureActive()
                    val line = channel.readLine() ?: break
                    if (line.isBlank()) continue
                    val event = RiffetJson.instance.decodeFromString<ShareDraftEvent>(line)
                    when (event.type) {
                        "progress" -> event.progress?.let { onProgress?.invoke(it) }
                        "ready" -> draft = requireNotNull(event.draft) { "Share ready event is missing its draft" }
                        "error" -> throw RiffetHttpException(
                            500,
                            event.messageRef?.code ?: "SHARE_DRAFT_FAILED",
                            event.message ?: "Share preview failed",
                            params = event.messageRef?.params.orEmpty().mapValues { it.value.content },
                        )
                    }
                }
                draft ?: throw RiffetNetworkException("Share preview connection ended before ready", IllegalStateException("Missing share ready event"))
            } finally {
                channel.cancel(CancellationException("Share preview reader closed"))
            }
        }
    }

@Throws(Exception::class)
suspend fun RiffetApi.publishShare(sessionId: String, draftId: String, expiryDays: Int): SessionShare =
    post(shareSessionPath(sessionId), buildJsonObject { put("draftId", draftId); put("expiryDays", expiryDays) }).decode()

@Throws(Exception::class)
suspend fun RiffetApi.removeShare(id: String): SessionShare = delete(sharePath(id)).decode()

@Throws(Exception::class)
suspend fun RiffetApi.reconcileShare(id: String): SessionShare = post("${sharePath(id)}/reconcile").decode()

@Throws(Exception::class)
suspend fun RiffetApi.retryShare(id: String): SessionShare = post("${sharePath(id)}/retry").decode()

/** Native presentation uses the same server text references as the web shell. */
fun ShareBlocker.localizedMessage(): String = riffet.i18n.L10n.serverError(
    messageRef?.code ?: code, messageRef?.params.orEmpty().mapValues { it.value.content }, message,
)

fun SessionShare.localizedError(): String? = error?.let { message ->
    riffet.i18n.L10n.serverError(errorRef?.code, errorRef?.params.orEmpty().mapValues { it.value.content }, message)
}

fun ShareDraft.localizedWarnings(): List<String> = warnings.mapIndexed { index, message ->
    val ref = warningRefs?.getOrNull(index)
    riffet.i18n.L10n.serverError(ref?.code, ref?.params.orEmpty().mapValues { it.value.content }, message)
}
