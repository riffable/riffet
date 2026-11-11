package riffet.ui.state

import riffet.contracts.NativeInteraction
import riffet.contracts.NativeInteractionResponse
import riffet.contracts.NativeInteractionResult
import riffet.contracts.NativeInteractionResultStatus
import riffet.shared.RiffetApi
import riffet.i18n.L10n
import riffet.ui.composer.newClientId
import riffet.shared.nativeCurrentInteraction
import riffet.shared.nativeInteraction

/**
 * The CLI dialog behind [SessionStore.interaction]: answering it, from its card or from outside the
 * conversation, and asking the server what it shows now.
 *
 * HTTP observations belong to both the open conversation's epoch and the dialog/native context
 * observed at their start. The store's single writer advances that observation for complete content
 * changes and thread changes; the main lane also advances it for generation changes and resets.
 */
internal class SessionInteractions(
    private val api: RiffetApi,
    private val core: StateStore,
) {

    suspend fun currentInteraction(sessionId: String): NativeInteraction? =
        if (sessionId == core.value.sessionId) core.value.interaction ?: syncInteraction() else api.nativeCurrentInteraction(sessionId)

    suspend fun respondFor(
        sessionId: String,
        interactionId: String,
        revision: String,
        action: String,
        selectedIds: List<String>?,
    ): NativeInteractionResult {
        val response = NativeInteractionResponse(interactionId, revision, newClientId(), action, selectedIds)
        return if (core.value.sessionId == sessionId && core.value.selected?.id == sessionId) {
            respondInteraction(response)
        } else {
            api.nativeInteraction(sessionId, response)
        }
    }

    suspend fun respondInteraction(response: NativeInteractionResponse): NativeInteractionResult {
        val opened = core.value
        val session = opened.selected
            ?: return NativeInteractionResult(NativeInteractionResultStatus.UNCERTAIN, null, L10n.uiText("composer.error.sessionClosed"))
        val result = api.nativeInteraction(session.id, response)
        // `advanced` that still shows the same interaction id and revision is not evidence the
        // answer landed: the CLI redrew the same dialog. Report it as uncertain, like the web does.
        val next = result.interaction
        val normalised = if (
            result.status == NativeInteractionResultStatus.ADVANCED &&
            next?.id == response.interactionId &&
            next.revision == response.revision
        ) {
            result.copy(
                status = NativeInteractionResultStatus.UNCERTAIN,
                message = result.message ?: L10n.uiText("composer.error.interactionStillPending"),
            )
        } else {
            result
        }
        var observed = core.value
        val applied = core.tryUpdate { state ->
            observed = state
            if (!state.observes(opened)) return@tryUpdate null
            val current = state.interaction
            if (current != null &&
                (current.id != response.interactionId || current.revision != response.revision) &&
                normalised.interaction != current) return@tryUpdate null
            if (normalised.status == NativeInteractionResultStatus.UNCERTAIN) state else state.withInteraction(when {
                normalised.interaction != null -> normalised.interaction
                normalised.status == NativeInteractionResultStatus.COMPLETED -> null
                else -> state.interaction
            })
        }
        if (observed.epoch != opened.epoch || observed.sessionId != opened.sessionId) {
            return normalised.copy(
                status = NativeInteractionResultStatus.UNCERTAIN,
                interaction = null,
                message = L10n.uiText("composer.error.sessionSwitched"),
            )
        }
        // A rejected receipt must not lock a still-visible submitted card in SUCCESS. Keep it
        // recoverable, using the store's actual observation, not the stale POST's alleged next card.
        // If SSE already cleared/replaced that card, leave its receipt alone and never touch the new one.
        val current = observed.interaction
        return if (!applied && current?.id == response.interactionId && current.revision == response.revision) {
            normalised.copy(
                status = NativeInteractionResultStatus.UNCERTAIN,
                interaction = current,
                message = normalised.message ?: L10n.uiText("composer.error.interactionStillPending"),
            )
        } else {
            normalised
        }
    }

    suspend fun syncInteraction(): NativeInteraction? {
        val opened = core.value
        val sessionId = opened.sessionId ?: return null
        val current = api.nativeCurrentInteraction(sessionId)
        core.tryUpdate { state -> if (state.observes(opened)) state.withInteraction(current) else null }
        val observed = core.value
        return if (observed.epoch == opened.epoch && observed.sessionId == sessionId) observed.interaction else null
    }

    private fun StoreState.observes(opened: StoreState): Boolean =
        epoch == opened.epoch && sessionId == opened.sessionId && interactionObservation == opened.interactionObservation
}
