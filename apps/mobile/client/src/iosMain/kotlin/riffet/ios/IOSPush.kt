package riffet.ios

import kotlinx.coroutines.CancellationException
import riffet.contracts.DevicePushRegistration
import riffet.contracts.DevicePushRoute
import riffet.contracts.DeviceReport
import riffet.contracts.NativeInteraction
import riffet.contracts.NativeInteractionResponse
import riffet.contracts.NativeInteractionResultStatus
import riffet.i18n.L10n
import riffet.shared.NativeMessageInput
import riffet.shared.RiffetApi
import riffet.shared.RiffetConnection
import riffet.shared.health
import riffet.shared.nativeCurrentInteraction
import riffet.shared.nativeInteraction
import riffet.shared.nativeSend
import riffet.shared.reportDevice
import riffet.shared.reportDeviceClearingPush
import riffet.shared.serverOrigin
import riffet.shared.session
import riffet.ui.composer.newClientId
import riffet.ui.interaction.carriesSelection
import riffet.ui.interaction.sanitizeOtherText
import riffet.ui.state.SessionStore

/**
 * What one paired server answered to this device's report. [route] is null from a server without
 * push; [serverId] (or, from an older server, [instanceId]) is the `server` its pushes name.
 */
class PushReport(val route: DevicePushRoute?, val serverId: String?, val instanceId: String?)

/**
 * Background push on the iPhone (docs/IOS.md): this device's APNs addresses, reported to each paired
 * server, and notification actions answered on the server that sent them. Each call opens a
 * short-lived connection to that server, so neither one switches the server that is open.
 */
class IOSPush(private val host: IOSHost) {

    /** `PUT /api/devices/me` on [origin]; [clearPush] sends `push: null`. Null when [origin] is not paired. */
    @Throws(Exception::class)
    suspend fun report(origin: String, appVersion: String, installationId: String, push: DevicePushRegistration?, clearPush: Boolean): PushReport? =
        withServer(origin) { api ->
            val report = DeviceReport("ios", appVersion, emptyList(), allowControl = false, installationId = installationId, push = push)
            val device = if (clearPush) api.reportDeviceClearingPush(report) else api.reportDevice(report)
            val health = try { api.health() } catch (cancellation: CancellationException) { throw cancellation } catch (_: Throwable) { null }
            PushReport(device.push, health?.serverId, health?.instanceId)
        }

    /**
     * A notification button's answer, as the push's `answers` spell it: [action] with [selectedIds],
     * and [text] as the 'Other' answer when the button is a text field. True once the server took
     * it; false when the dialog is no longer the one the notification showed or the result is unknown.
     */
    @Throws(Exception::class)
    suspend fun respond(origin: String, sessionId: String, interactionId: String, revision: String, action: String, selectedIds: List<String>?, text: String?): Boolean {
        val store = openStore(origin)
        val current = if (store != null) store.currentInteraction(sessionId) else withServer(origin) { it.nativeCurrentInteraction(sessionId) }
        if (current == null || current.id != interactionId || current.revision != revision) return false
        val request = pushResponse(current, action, selectedIds, text) ?: return false
        val result = if (store != null && request.otherText == null) {
            store.respondFor(sessionId, request.interactionId, request.revision, request.action, request.selectedIds)
        } else {
            withServer(origin) { it.nativeInteraction(sessionId, request) } ?: return false
        }
        if (store != null) host.poke()
        return result.status != NativeInteractionResultStatus.UNCERTAIN
    }

    /**
     * A finished conversation's reply field: the next message, as the conversation's own composer
     * sends it, against the [configRevision] the push carried.
     */
    @Throws(Exception::class)
    suspend fun reply(origin: String, sessionId: String, text: String, configRevision: Long?) {
        val prompt = text.trim()
        if (prompt.isEmpty()) return
        openStore(origin)?.let { store ->
            store.replyFor(sessionId, prompt)
            host.poke()
            return
        }
        withServer(origin) { api ->
            val revision = configRevision
                ?: api.session(sessionId)?.configRevision
                ?: error(L10n.uiText("composer.error.sessionMissing"))
            api.nativeSend(sessionId, NativeMessageInput(commandId = newClientId(), text = prompt, expectedConfigRevision = revision))
        } ?: error(L10n.uiText("connection.pairingRemoved"))
    }

    private suspend fun <T> withServer(origin: String, block: suspend (RiffetApi) -> T): T? {
        val connection = RiffetConnection(host.tokens, config = host.clientConfig)
        return try {
            connection.pairedApi(origin)?.let { block(it) }
        } finally { connection.close() }
    }

    /** The open store when it is [origin]'s, so the conversation on screen sees its own answer at once. */
    private fun openStore(origin: String): SessionStore? {
        val base = host.api?.baseUrl ?: return null
        return host.store.value?.takeIf { serverOrigin(base) == origin }
    }
}

/**
 * The request a notification button sends: the server's answer, when the dialog still has that
 * action. Typed text goes only to an action that carries a selection, of a dialog that takes it.
 */
internal fun pushResponse(interaction: NativeInteraction, action: String, selectedIds: List<String>?, text: String?): NativeInteractionResponse? {
    if (interaction.actions.none { it.id == action }) return null
    val base = NativeInteractionResponse(interactionId = interaction.id, revision = interaction.revision, requestId = newClientId(), action = action,
        selectedIds = selectedIds?.takeIf { it.isNotEmpty() })
    if (text == null) return base
    if (interaction.allowOther != true || !carriesSelection(interaction, action)) return null
    val other = sanitizeOtherText(text.trim()).takeIf { it.isNotBlank() } ?: return null
    return base.copy(otherText = other)
}
