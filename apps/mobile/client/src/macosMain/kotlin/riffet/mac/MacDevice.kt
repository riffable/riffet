package riffet.mac

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import platform.Foundation.NSData
import riffet.contracts.DeviceCall
import riffet.contracts.DeviceCallOutcome
import riffet.contracts.DeviceCapability
import riffet.contracts.DeviceErrorCode
import riffet.contracts.DeviceFileUpload
import riffet.contracts.DeviceLease
import riffet.contracts.DeviceReport
import riffet.shared.AppLog
import riffet.shared.DeviceCallJournal
import riffet.shared.DeviceChannel
import riffet.shared.DeviceControl
import riffet.shared.DeviceExecutor
import riffet.shared.DeviceGate
import riffet.shared.DeviceLeaseScheduler
import riffet.shared.ForegroundAppearance
import riffet.shared.RiffetApi
import riffet.shared.RiffetHttpException
import riffet.shared.createAppPreferences
import riffet.shared.deviceIdOf
import riffet.shared.reportDevice
import riffet.shared.uploadDeviceCallFile
import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi

/*
 * The Mac as a device (docs/DEVICES.md「实现（Mac，T0）」). The app implements [MacDeviceActions] in
 * Swift; [MacDevice] decides when a call may reach it. Swift never sees a protocol envelope: it gets the
 * call's few typed arguments and answers through one [MacActionReply].
 */

/** One window as `window.capture` lists it; sizes are in points. */
class MacWindow(val id: Long, val app: String, val title: String, val width: Int, val height: Int, val onScreen: Boolean)

internal sealed interface MacOutcome {
    data object Done : MacOutcome
    data class Text(val value: String?) : MacOutcome
    data class Windows(val list: List<MacWindow>) : MacOutcome
    class Image(val bytes: NSData, val mimeType: String, val width: Int, val height: Int) : MacOutcome
    data class Failed(val message: String) : MacOutcome
}

/** The one answer to one action. Swift calls exactly one method, once; later calls are ignored. */
class MacActionReply internal constructor() {
    internal val outcome = CompletableDeferred<MacOutcome>()

    fun done() { outcome.complete(MacOutcome.Done) }
    fun text(value: String?) { outcome.complete(MacOutcome.Text(value)) }
    fun windows(list: List<MacWindow>) { outcome.complete(MacOutcome.Windows(list)) }
    fun image(bytes: NSData, mimeType: String, width: Int, height: Int) { outcome.complete(MacOutcome.Image(bytes, mimeType, width, height)) }

    /** Could not, or does not do this (`DEVICE_FAILED`); [message] tells the agent which. */
    fun failed(message: String) { outcome.complete(MacOutcome.Failed(message)) }
}

/**
 * What the Mac does for the agent, implemented in Swift without `suspend` (like [SecretStore]). Each
 * method starts the work and returns; it answers through [MacActionReply], on any thread. [cancel] stops
 * the work for a call the server withdrew or whose deadline passed; a reply after that is ignored.
 */
interface MacDeviceActions {
    /** Device capability ids usable now: permission granted, preference on. Ignores the control switch. */
    fun capabilities(): List<String>

    fun notify(callId: String, sessionId: String, title: String?, body: String, reply: MacActionReply)
    fun clipboardRead(callId: String, reply: MacActionReply)
    fun clipboardWrite(callId: String, text: String, reply: MacActionReply)
    fun openUrl(callId: String, url: String, reply: MacActionReply)
    fun listWindows(callId: String, reply: MacActionReply)

    /**
     * One window as an image. [attempt] counts up while the server refuses the previous one as too
     * large; Swift answers each with a smaller encoding and [MacActionReply.failed] once none is left.
     */
    fun captureWindow(callId: String, windowId: Long, attempt: Int, reply: MacActionReply)

    fun cancel(callId: String)

    /** Stops every action in progress, before returning: the control switch was turned off. */
    fun cancelAll()
}

private object NoLeases : DeviceLeaseScheduler {
    override fun schedule(lease: DeviceLease) = Unit
    override fun cancel(id: String) = Unit
    override fun held(): Set<String> = emptySet()
}

/**
 * The Mac's only device stream and report writer. `PUT /api/devices/me` replaces the capability list,
 * so `riffet.appearance` (served while the main window is in front, switch in [ForegroundAppearance])
 * and the T0 capabilities (served whenever connected, switch [controlAllowed]) are reported together
 * from here. [ForegroundAppearance] only says whether appearance is usable.
 *
 * Everything runs on the host's main-thread scope, so the state read by the channel's callbacks is
 * never raced.
 */
class MacDevice internal constructor(private val scope: CoroutineScope, private val appearance: ForegroundAppearance) {
    private class Target(val api: RiffetApi, val authorized: () -> Boolean)

    /** What is served right now. [capabilities] is what is reported; the channel reads it, it is not recomputed per call. */
    private class State(
        val pairId: String?,
        val control: Boolean,
        val appearance: DeviceExecutor?,
        val capabilities: List<String>,
    ) {
        val allow get() = control || appearance != null
        fun withoutControl() = State(pairId, false, appearance, capabilities.filter { it == DeviceCapability.RIFFET_APPEARANCE })
    }

    private val preferences by lazy { createAppPreferences() }
    private val journal by lazy { DeviceCallJournal(preferences) }
    private var actions: MacDeviceActions? = null
    private var appVersion = ""
    private var target: Target? = null
    private var supervisor: Job? = null
    /** The supervisor [clear] cancelled, kept so the next [install] opens its stream only after this one closed. */
    private var retiring: Job? = null
    private var channel: DeviceChannel? = null
    private var state = State(null, false, null, emptyList())
    private val wakes = Channel<Unit>(Channel.CONFLATED)

    init {
        appearance.hosted = ::wake
    }

    fun configure(appVersion: String, actions: MacDeviceActions) {
        this.appVersion = appVersion
        this.actions = actions
        wake()
    }

    fun install(api: RiffetApi, authorized: () -> Boolean) {
        val selected = Target(api, authorized)
        target = selected
        val previous = supervisor ?: retiring
        previous?.cancel()
        retiring = null
        supervisor = scope.launch {
            previous?.join()
            supervise(selected)
        }
    }

    fun clear() {
        target = null
        supervisor?.let { it.cancel(); retiring = it }
        supervisor = null
        actions?.cancelAll()
        channel = null
        state = State(null, false, null, emptyList())
    }

    /** Permissions or preferences changed (Swift calls this), or the appearance conditions did. */
    fun refresh() = wake()

    fun kick() {
        channel?.kick()
        wake()
    }

    private fun wake() {
        wakes.trySend(Unit)
    }

    /** The control switch for [api]'s pairing; false for any other server. */
    suspend fun controlAllowed(api: RiffetApi): Boolean {
        val selected = target?.takeIf { it.api === api && it.authorized() } ?: return false
        val id = api.readToken()?.let(::deviceIdOf) ?: return false
        return target === selected && id in controlIds()
    }

    /** Turning it on must follow the owner's verification, which the app does before calling. */
    suspend fun setControlAllowed(api: RiffetApi, enabled: Boolean): Boolean {
        val selected = target?.takeIf { it.api === api && it.authorized() } ?: return false
        val id = api.readToken()?.let(::deviceIdOf) ?: return false
        if (target !== selected) return false
        val ids = controlIds()
        val next = if (enabled) ids + id else ids - id
        if (next != ids) preferences.setString(CONTROL_KEY, next.joinToString(",").ifEmpty { null })
        // Off takes hold for calls already on their way, before the loop gets to run.
        if (!enabled && state.pairId == id) {
            state = state.withoutControl()
            actions?.cancelAll()
        }
        wake()
        return enabled
    }

    private fun controlIds(): Set<String> = preferences.string(CONTROL_KEY)?.split(',')?.filter { it.isNotEmpty() }?.toSet().orEmpty()

    private suspend fun snapshot(selected: Target): State {
        val id = selected.api.readToken()?.let(::deviceIdOf)
        val live = id != null && selected.authorized()
        val control = live && id in controlIds()
        val usableAppearance = if (live) appearance.usableExecutor() else null
        val t0 = if (control) actions?.capabilities().orEmpty().filter { it in T0 } else emptyList()
        val capabilities = t0 + listOfNotNull(usableAppearance?.let { DeviceCapability.RIFFET_APPEARANCE })
        return State(id, control, usableAppearance, capabilities)
    }

    /**
     * Opens the stream while either switch lets a call through, closes it when neither does, and
     * otherwise just re-reports. The stream is restarted when the pairing changes or the control switch
     * goes off, which also stops the calls it was running.
     */
    private suspend fun supervise(selected: Target) = coroutineScope {
        var serving: Job? = null
        var servingPair: String? = null
        var listened = false
        var control = false
        try {
            while (true) {
                if (serving?.isActive == false) serving = null
                val next = snapshot(selected)
                if (serving != null && (!next.allow || next.pairId != servingPair || (control && !next.control))) {
                    serving.cancelAndJoin()
                    serving = null
                }
                state = next
                control = next.control
                if (next.allow) {
                    if (serving == null) {
                        servingPair = next.pairId
                        listened = true
                        serving = launch {
                            try {
                                serve(selected)
                            } catch (cancellation: CancellationException) {
                                throw cancellation
                            } catch (failure: Throwable) {
                                AppLog.log("device", "mac stream ended ${failure::class.simpleName}: ${failure.message}")
                            }
                        }
                    } else {
                        channel?.reportIfChanged()
                    }
                } else if (listened) {
                    // A report that did not arrive is sent again on the next wake.
                    listened = !reportOff(selected)
                }
                wakes.receive()
            }
        } finally {
            serving?.cancel()
        }
    }

    private suspend fun serve(selected: Target) = coroutineScope {
        val router = Router(selected)
        val gate = DeviceGate(selected.api, router, journal, this, allowed = { state.allow })
        val next = DeviceChannel(
            selected.api, router, gate, NoLeases, platform = "mac", appVersion = appVersion,
            allowed = { state.allow }, installationId = { DeviceControl.installationId },
        )
        channel = next
        try {
            next.run()
        } finally {
            if (channel === next) channel = null
        }
    }

    /** Tells the server once that nothing is served, so its tools fail early instead of waiting out a deadline. */
    private suspend fun reportOff(selected: Target): Boolean =
        try {
            selected.api.reportDevice(DeviceReport("mac", appVersion, emptyList(), allowControl = false, installationId = DeviceControl.installationId))
            true
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (failure: Throwable) {
            AppLog.log("device", "mac report off failed ${failure::class.simpleName}")
            false
        }

    /**
     * Routes a call the gate let through. The gate has already checked [State.allow] and that the
     * capability is reported; T0 is checked again here against the stored switch, so no T0 call reaches
     * [MacDeviceActions] unless the switch for this pairing is on right now.
     */
    private inner class Router(private val selected: Target) : DeviceExecutor {
        override fun capabilities(): List<String> = state.capabilities

        override suspend fun execute(call: DeviceCall, api: RiffetApi): DeviceCallOutcome {
            if (call.capability == DeviceCapability.RIFFET_APPEARANCE) {
                return state.appearance?.execute(call, api) ?: refused("This Riffet workbench does not allow appearance calls")
            }
            val id = api.readToken()?.let(::deviceIdOf)
            val current = state
            val actions = actions
            if (actions == null || !current.control || id == null || id != current.pairId || id !in controlIds() || !selected.authorized()) {
                return refused("This Mac does not allow Agent control")
            }
            return t0(call, api, actions)
        }

        private fun refused(message: String) = DeviceCallOutcome.failure(DeviceErrorCode.NOT_ALLOWED, message)
    }

    private fun DeviceCall.string(key: String): String? = (args[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull?.takeIf { it.isNotBlank() }

    private fun invalid(message: String) = DeviceCallOutcome.failure(DeviceErrorCode.FAILED, message)

    private suspend fun t0(call: DeviceCall, api: RiffetApi, actions: MacDeviceActions): DeviceCallOutcome = when (call.capability) {
        DeviceCapability.NOTIFY -> {
            val body = call.string("body")
            if (body == null) invalid("body is required") else answer(call, actions) { actions.notify(call.callId, call.sessionId, call.string("title"), body, it) }
        }
        DeviceCapability.CLIPBOARD_READ -> answer(call, actions) { actions.clipboardRead(call.callId, it) }
        DeviceCapability.CLIPBOARD_WRITE -> {
            // Text may be empty (clearing the clipboard to nothing is still a write), so no blank check.
            val text = (call.args["text"] as? JsonPrimitive)?.takeIf { it.isString }?.content
            if (text == null) invalid("text is required") else answer(call, actions) { actions.clipboardWrite(call.callId, text, it) }
        }
        DeviceCapability.OPEN_URL -> {
            val url = call.string("url")
            if (url == null) invalid("url is required") else answer(call, actions) { actions.openUrl(call.callId, url.trim(), it) }
        }
        DeviceCapability.WINDOW_CAPTURE -> window(call, api, actions)
        else -> DeviceCallOutcome.failure(DeviceErrorCode.CAPABILITY_MISSING, "${call.capability} is not available on this device")
    }

    private suspend fun window(call: DeviceCall, api: RiffetApi, actions: MacDeviceActions): DeviceCallOutcome {
        if ((call.args["list"] as? JsonPrimitive)?.booleanOrNull == true) return answer(call, actions) { actions.listWindows(call.callId, it) }
        val windowId = (call.args["windowId"] as? JsonPrimitive)?.longOrNull?.takeIf { it in 1..UInt.MAX_VALUE.toLong() }
            ?: return invalid("windowId must be a window id")
        var attempt = 0
        while (true) {
            val outcome = await(call, actions) { actions.captureWindow(call.callId, windowId, attempt, it) }
            if (outcome !is MacOutcome.Image) return outcome(outcome)
            try {
                val file = api.uploadDeviceCallFile(call.callId, upload(outcome))
                return DeviceCallOutcome.success(buildJsonObject { put("fileIds", buildJsonArray { add(JsonPrimitive(file.fileId)) }) })
            } catch (failure: RiffetHttpException) {
                // The server's size limit is its own; a smaller encoding is asked for until it takes one.
                if (failure.status != 413) throw failure
                attempt++
            }
        }
    }

    @OptIn(ExperimentalEncodingApi::class)
    private fun upload(image: MacOutcome.Image): DeviceFileUpload {
        val extension = if (image.mimeType == "image/png") "png" else "jpg"
        return DeviceFileUpload("window.$extension", image.mimeType, Base64.encode(byteArrayFromData(image.bytes)), image.width, image.height)
    }

    private suspend fun answer(call: DeviceCall, actions: MacDeviceActions, start: (MacActionReply) -> Unit): DeviceCallOutcome =
        outcome(await(call, actions, start))

    /** Starts [start] and waits for its reply; a cancelled wait tells Swift to stop. */
    private suspend fun await(call: DeviceCall, actions: MacDeviceActions, start: (MacActionReply) -> Unit): MacOutcome {
        val reply = MacActionReply()
        start(reply)
        try {
            return reply.outcome.await()
        } catch (cancellation: CancellationException) {
            actions.cancel(call.callId)
            throw cancellation
        }
    }

    private fun outcome(result: MacOutcome): DeviceCallOutcome = when (result) {
        MacOutcome.Done -> DeviceCallOutcome.success()
        is MacOutcome.Text -> DeviceCallOutcome.success(buildJsonObject { result.value?.let { put("text", it) } })
        is MacOutcome.Windows -> DeviceCallOutcome.success(buildJsonObject {
            put("windows", buildJsonArray {
                result.list.forEach { window ->
                    add(buildJsonObject {
                        put("id", window.id)
                        put("app", window.app)
                        put("title", window.title)
                        put("width", window.width)
                        put("height", window.height)
                        put("onScreen", window.onScreen)
                    })
                }
            })
        })
        is MacOutcome.Image -> invalid("An image was not expected")
        is MacOutcome.Failed -> invalid(result.message)
    }

    private companion object {
        const val CONTROL_KEY = "mac.device-control.allowed-devices"
        val T0 = setOf(
            DeviceCapability.NOTIFY, DeviceCapability.CLIPBOARD_READ, DeviceCapability.CLIPBOARD_WRITE,
            DeviceCapability.OPEN_URL, DeviceCapability.WINDOW_CAPTURE,
        )
    }
}
