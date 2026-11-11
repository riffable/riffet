package riffet.shared

import io.ktor.client.request.url
import io.ktor.client.statement.bodyAsText
import io.ktor.http.encodeURLParameter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.put
import riffet.contracts.NativeBackendCatalogEntry
import riffet.contracts.NativeBackendId
import riffet.contracts.NativeInteraction
import riffet.contracts.NativeInteractionResponse
import riffet.contracts.NativeInteractionResult
import riffet.contracts.NativeModelOption
import riffet.contracts.RiffetJson
import riffet.contracts.Run
import riffet.contracts.Session
import riffet.contracts.TerminalInfo

// RiffetApi endpoints — sessions: the list, the native conversation stream and transcript, runs, interactions and per-session config. Transport and auth rules: see RiffetApi.kt.

/** The web client has no `session(id)`; the server has no `GET /api/sessions/:id` route either. */
@Throws(Exception::class)
suspend fun RiffetApi.session(id: String): Session? = sessions().firstOrNull { it.id == id }

@Throws(Exception::class)
suspend fun RiffetApi.sessions(): List<Session> = get("/api/sessions").decode()

/**
 * `GET /api/sessions` with `If-None-Match`: [ConditionalList.items] is null when the server
 * answered 304, i.e. the list still is the one [etag] named. Older servers send no ETag, so the
 * list is then always returned in full.
 */
@Throws(Exception::class)
suspend fun RiffetApi.sessionsIfChanged(etag: String?): ConditionalList<Session> = conditionalList("/api/sessions", etag)

@Throws(Exception::class)
suspend fun RiffetApi.createSession(body: NativeSessionCreateInput): NativeSessionCreateResult {
    requireReferenceProtocol(body.initialMessage?.references?.isNotEmpty() == true)
    return post("/api/sessions", wireBody(body)).decode()
}

@Throws(Exception::class)
suspend fun RiffetApi.updateSession(id: String, body: SessionUpdate): Session =
    patch("/api/sessions/${id.enc()}", wireBody(body)).decode()

/** `session-delete-v1`: what deleting [id] would remove; a deleted id answers 410 `SESSION_DELETED`. */
@Throws(Exception::class)
suspend fun RiffetApi.sessionDeletion(id: String): SessionDeletionPreview =
    get("/api/sessions/${id.enc()}/deletion").decode()

/** Deletes [id] with its side chats; [sessionIds] is the set the user confirmed, refused (409) when it changed. */
@Throws(Exception::class)
suspend fun RiffetApi.deleteSession(id: String, sessionIds: List<String>): SessionDeletionReceipt =
    delete("/api/sessions/${id.enc()}", wireBody(SessionDeletionRequest(sessionIds))).decode()

@Throws(Exception::class)
suspend fun RiffetApi.nativeSend(id: String, body: NativeMessageInput): Run {
    requireReferenceProtocol(body.references?.isNotEmpty() == true)
    return post("/api/sessions/${id.enc()}/native/send", wireBody(body)).decode()
}

@Throws(Exception::class)
suspend fun RiffetApi.steerQueuedNativeRun(id: String, sourceRunId: String, body: NativeQueuedSteerInput): Run =
    post("/api/sessions/${id.enc()}/native/runs/${sourceRunId.enc()}/steer", wireBody(body)).decode()

@Throws(Exception::class)
suspend fun RiffetApi.nativeSteer(id: String, body: NativeSteerInput): Run {
    requireReferenceProtocol(body.references?.isNotEmpty() == true)
    return post("/api/sessions/${id.enc()}/native/steer", wireBody(body)).decode()
}

@Throws(Exception::class)
suspend fun RiffetApi.nativeInterruptAndSend(id: String, body: NativeMessageInput): Run {
    requireReferenceProtocol(body.references?.isNotEmpty() == true)
    return post("/api/sessions/${id.enc()}/native/interrupt-and-send", wireBody(body)).decode()
}

/** Interrupts whatever the session's CLI is doing, as the web's stop button does. */
@Throws(Exception::class)
suspend fun RiffetApi.interruptSession(id: String, stop: NativeStopRequest) {
    post("/api/sessions/${id.enc()}/cancel", wireBody(stop))
}

/**
 * Asks the server to stop a system activity (a background task). The server answers with the new
 * state through the stream; the request alone does not make it `stopped`.
 */
@Throws(Exception::class)
suspend fun RiffetApi.stopNativeActivity(id: String, activityId: String) {
    post("/api/sessions/${id.enc()}/native/activities/${activityId.enc()}/stop").discard()
}

/** The full text behind an activity's preview (`NativeActivity.blobRef`), fetched when asked for. */
@Throws(Exception::class)
suspend fun RiffetApi.sessionBlob(id: String, blobRef: String): String =
    get("/api/sessions/${id.enc()}/blobs/${blobRef.enc()}").bodyAsText()

@Throws(Exception::class)
suspend fun RiffetApi.cancelNativeRun(id: String, runId: String): Run =
    post("/api/sessions/${id.enc()}/native/runs/${runId.enc()}/cancel").decode()

@Throws(Exception::class)
suspend fun RiffetApi.resolveNativeRun(id: String, runId: String, queuedRunIds: List<String>): Run =
    post("/api/sessions/${id.enc()}/native/runs/${runId.enc()}/resolve", wireBody(ResolveRunBody(queuedRunIds = queuedRunIds))).decode()

@Throws(Exception::class)
suspend fun RiffetApi.checkNativeRun(id: String, runId: String): NativeRunRecovery =
    post("/api/sessions/${id.enc()}/native/runs/${runId.enc()}/check").decode()

@Throws(Exception::class)
suspend fun RiffetApi.runByCommand(id: String, commandId: String): Run? =
    get("/api/sessions/${id.enc()}/runs", listOf("commandId" to commandId)).decode<List<Run>>().singleOrNull()

@Throws(Exception::class)
suspend fun RiffetApi.sendQueuedNativeRunNow(id: String, runId: String, stop: NativeStopRequest): Run =
    post("/api/sessions/${id.enc()}/native/runs/${runId.enc()}/send-now", buildJsonObject { put("stop", WireJson.encodeToJsonElement(stop)) }).decode()

/** Returns `null` (a literal JSON `null`) when no dialog is waiting. */
@Throws(Exception::class)
suspend fun RiffetApi.nativeCurrentInteraction(id: String): NativeInteraction? =
    get("/api/sessions/${id.enc()}/native/interaction").decode()

@Throws(Exception::class)
suspend fun RiffetApi.nativeInteraction(id: String, response: NativeInteractionResponse): NativeInteractionResult =
    post("/api/sessions/${id.enc()}/native/interaction", wireBody(response)).decode()

/** Extends an outstanding protocol request; the returned revision/expiry is authoritative. */
@Throws(Exception::class)
suspend fun RiffetApi.nativeExtendInteraction(id: String, interactionId: String): NativeInteraction =
    post("/api/sessions/${id.enc()}/native/interaction/extend", wireBody(mapOf("interactionId" to interactionId))).decode()

/** Session-scoped capabilities can differ from the backend's default catalog. */
@Throws(Exception::class)
suspend fun RiffetApi.sessionCatalog(id: String): NativeBackendCatalogEntry =
    get("/api/sessions/${id.enc()}/native/catalog").decode()

@Throws(Exception::class)
suspend fun RiffetApi.nativeModels(id: String): List<NativeModelOption> =
    get("/api/sessions/${id.enc()}/native/models").decode()

@Throws(Exception::class)
suspend fun RiffetApi.nativeRuntimeAction(id: String, action: String, revision: String) {
    post("/api/sessions/${id.enc()}/native/runtime-control", buildJsonObject {
        put("action", action)
        put("revision", revision)
    })
}

@Throws(Exception::class)
suspend fun RiffetApi.nativeSetModel(id: String, model: String): Session =
    post("/api/sessions/${id.enc()}/native/model", wireBody(ModelBody(model))).decode()

/** Continues the conversation on another provider listed in its catalog's `continuations`, with one of its models. */
@Throws(Exception::class)
suspend fun RiffetApi.nativeSwitchProfile(id: String, backendProfileId: String, model: String): Session =
    post("/api/sessions/${id.enc()}/native/configure", buildJsonObject {
        put("backendProfileId", backendProfileId)
        put("model", model)
    }).decode()

@Throws(Exception::class)
suspend fun RiffetApi.nativeSetMode(id: String, mode: String): Session =
    post("/api/sessions/${id.enc()}/native/mode", wireBody(ModeBody(mode))).decode()

@Throws(Exception::class)
suspend fun RiffetApi.nativeSetApproval(id: String, approval: String): Session =
    post("/api/sessions/${id.enc()}/native/approval", wireBody(ApprovalBody(approval))).decode()

@Throws(Exception::class)
suspend fun RiffetApi.nativeKeys(id: String, keys: List<String>) {
    post("/api/sessions/${id.enc()}/native/keys", wireBody(KeysBody(keys))).discard()
}

@Throws(Exception::class)
suspend fun RiffetApi.runs(id: String): List<Run> = get("/api/sessions/${id.enc()}/runs").decode()

/**
 * `POST /api/sessions/:id/start`: reopens the conversation's CLI (after it exited, or to apply
 * changed launch settings). The server answers with the terminal, or with the session and its
 * terminal.
 */
@Throws(Exception::class)
suspend fun RiffetApi.startSession(id: String): StartSessionResult {
    return startSessionRequest(id, null, null)
}

@Throws(Exception::class)
suspend fun RiffetApi.restartSession(id: String, fingerprint: String, address: String): StartSessionResult = startSessionRequest(id, fingerprint, address)

private suspend fun RiffetApi.startSessionRequest(id: String, fingerprint: String?, address: String?): StartSessionResult {
    val response = post("/api/sessions/${id.enc()}/start", buildJsonObject {
        fingerprint?.let { put("restartFingerprint", it) }
        address?.let { put("restartAddress", it) }
    }).bodyAsText()
    return withContext(Dispatchers.Default) {
        val body = RiffetJson.instance.parseToJsonElement(response) as? JsonObject
            ?: return@withContext StartSessionResult(null, null)
        if (body.containsKey("session")) {
            StartSessionResult(
                session = RiffetJson.instance.decodeFromJsonElement(Session.serializer(), body.getValue("session")),
                terminal = body["terminal"]?.takeIf { it is JsonObject }?.let { RiffetJson.instance.decodeFromJsonElement(TerminalInfo.serializer(), it) },
            )
        } else {
            StartSessionResult(null, RiffetJson.instance.decodeFromJsonElement(TerminalInfo.serializer(), body))
        }
    }
}

/** A Cursor conversation that opens on the CLI's own session picker (the web's 继续历史会话). */
@Throws(Exception::class)
suspend fun RiffetApi.createResumePickerSession(projectId: String, backendId: NativeBackendId, profileId: String?, approval: String?): Session =
    post(
        "/api/sessions",
        buildJsonObject {
            put("projectId", JsonPrimitive(projectId))
            put("kind", JsonPrimitive("native"))
            put("backendId", WireJson.encodeToJsonElement(NativeBackendId.serializer(), backendId))
            if (profileId != null) put("backendProfileId", JsonPrimitive(profileId))
            put("title", JsonPrimitive("Untitled"))
            put("mode", JsonPrimitive("agent"))
            put("resumePicker", JsonPrimitive(true))
            if (approval != null) put("approval", JsonPrimitive(approval))
        },
    ).decode()

/** Searches conversations across every project; for file contents see [search]. */
@Throws(Exception::class)
suspend fun RiffetApi.searchMessages(query: String, limit: Int = 50, sessionId: String? = null): MessageSearchResult =
    get("/api/search/messages", buildList {
        add("q" to query)
        add("limit" to limit.toString())
        if (sessionId != null) add("sessionId" to sessionId)
    }).decode()

/** Warms a CLI for [body]'s project so the first message starts faster; the server may skip it. */
@Throws(Exception::class)
suspend fun RiffetApi.prewarm(body: PrewarmBody): PrewarmResult =
    post("/api/native/prewarm", wireBody(body)).decode()

/** The `riffet-export-v1` JSON document of one conversation, as text, ready to be saved to a file. */
@Throws(Exception::class)
suspend fun RiffetApi.exportSession(sessionId: String): String =
    get("/api/sessions/${sessionId.enc()}/export").bodyAsText()

/** A newer composer must never send references to an older server that would drop them. */
private suspend fun RiffetApi.requireReferenceProtocol(hasReferences: Boolean) {
    // Compatibility errors are thrown by the server before any send side effect. Health is
    // consulted only for actual references so legacy send requests retain their behavior.
    if (hasReferences && health().protocol?.features?.contains("session-references-v1") != true) {
        throw RiffetHttpException(409, "SESSION_REFERENCES_UNSUPPORTED", "服务器不支持会话引用")
    }
}
