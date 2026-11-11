package riffet.contracts

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonPrimitive

/** Native clients consume the sharing shell; the reading snapshot belongs to the shared web reader. */
@Serializable
data class ShareAppearanceRequest(
    val themeId: String,
    val mode: String,
    val themeRevision: String? = null,
    val uiFont: String? = null,
    val monoFont: String? = null,
    val background: String? = null,
)

@Serializable
data class ShareSelection(
    val mode: String,
    val count: Int? = null,
    val turnIds: List<String>? = null,
    val nativeChatId: String? = null,
)

@Serializable
data class ShareDraftRequest(val selection: ShareSelection? = null, val appearance: ShareAppearanceRequest? = null, val author: Boolean? = null)

@Serializable
data class SharePublisherInfo(val id: String, val label: String, val audience: String)

@Serializable
data class ShareCapability(
    val available: Boolean,
    val reason: String? = null,
    val message: String? = null,
    val username: String? = null,
    val profile: String? = null,
    val publisher: SharePublisherInfo? = null,
    /** The enabled publishers new shares can go to, in precedence order; only sent when there is more than one. */
    val publishers: List<SharePublisherInfo>? = null,
)

@Serializable
data class ShareTextRef(val code: String, val params: Map<String, JsonPrimitive>? = null)

@Serializable
data class SessionShare(
    val id: String,
    val sessionId: String,
    val title: String,
    val alias: String,
    val username: String,
    val state: String,
    val updatedAt: String,
    val profile: String? = null,
    val publisher: String? = null,
    val url: String? = null,
    val previewId: String? = null,
    val deploymentId: String? = null,
    val capturedAt: String? = null,
    val expiresAt: String? = null,
    val publishedHash: String? = null,
    val appearance: ShareAppearanceRequest? = null,
    val author: Boolean? = null,
    val operation: String? = null,
    val error: String? = null,
    val errorRef: ShareTextRef? = null,
)

@Serializable
data class ShareActions(val preview: Boolean, val publish: Boolean, val remove: Boolean, val reconcile: Boolean, val retry: Boolean)

@Serializable
data class ShareBlocker(val code: String, val message: String, val messageRef: ShareTextRef? = null)

@Serializable
data class ShareStatus(val capability: ShareCapability, val share: SessionShare?, val actions: ShareActions, val blocker: ShareBlocker? = null)

@Serializable
data class ShareTurn(val id: String, val text: String, val createdAt: String)

@Serializable
data class ShareTurnCatalog(val turns: List<ShareTurn>, val nativeChatId: String? = null)

@Serializable
data class ShareDraft(
    val id: String,
    val sessionId: String,
    val capturedAt: String,
    val previewUrl: String,
    val warnings: List<String>,
    val bytes: Long,
    val warningRefs: List<ShareTextRef>? = null,
    val appearance: ShareAppearanceRequest? = null,
    val author: Boolean? = null,
)

@Serializable
data class ShareDraftProgress(val stage: String)

/** Unknown event kinds are ignored by the transport, so newer progress events remain compatible. */
@Serializable
data class ShareDraftEvent(
    val type: String,
    val progress: ShareDraftProgress? = null,
    val draft: ShareDraft? = null,
    val message: String? = null,
    val messageRef: ShareTextRef? = null,
)
