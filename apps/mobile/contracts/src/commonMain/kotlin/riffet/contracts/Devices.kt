package riffet.contracts

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/*
 * The device channel (docs/DEVICES.md §3): what a phone reports about itself, the calls and leases
 * the server sends down `/api/devices/me/stream`, and what goes back. Ported from
 * packages/contracts; open sets (capabilities, error codes, tool groups) stay strings so a newer
 * server's value never fails decoding.
 */

/** Capability ids. T0 needs nothing beyond ordinary app permissions; T1 needs the accessibility service. */
object DeviceCapability {
    const val NOTIFY = "notify"
    const val CLIPBOARD_READ = "clipboard.read"
    const val CLIPBOARD_WRITE = "clipboard.write"
    const val LOCATION = "location"
    const val PHOTO = "photo"
    const val OPEN_URL = "open_url"
    const val ALARM = "alarm"

    const val SCREEN_OBSERVE = "screen.observe"
    const val SCREEN_ACT = "screen.act"
    const val APP_LAUNCH = "app.launch"
    const val RIFFET_APPEARANCE = "riffet.appearance"

    val T0: List<String> = listOf(NOTIFY, CLIPBOARD_READ, CLIPBOARD_WRITE, LOCATION, PHOTO, OPEN_URL, ALARM)
    val T1: List<String> = listOf(SCREEN_OBSERVE, SCREEN_ACT, APP_LAUNCH)
}

/** The codes a failed call carries; the server adds `DEVICE_UNREACHABLE` and `DEVICE_TIMEOUT` itself. */
object DeviceErrorCode {
    const val NOT_ALLOWED = "DEVICE_NOT_ALLOWED"
    const val CAPABILITY_MISSING = "DEVICE_CAPABILITY_MISSING"
    const val DENIED = "DEVICE_DENIED"
    const val TIMEOUT = "DEVICE_TIMEOUT"
    const val UNREACHABLE = "DEVICE_UNREACHABLE"

    /** The device tried and could not: bad arguments, no fix, no app to handle it. [DeviceCallOutcome.message] says which. */
    const val FAILED = "DEVICE_FAILED"

    /** The screen is locked or off; the owner has to unlock it first. */
    const val LOCKED = "DEVICE_LOCKED"

    /** Only the owner may do this (paying); the screen was handed to them with a notification. */
    const val HANDOFF_REQUIRED = "DEVICE_HANDOFF_REQUIRED"

    /** The owner pressed stop; control calls are refused for a minute. */
    const val STOPPED = "DEVICE_STOPPED"
}

/**
 * `PUT /api/devices/me`, sent before each dial of the device stream and whenever any part changes.
 * [installationId] is random and kept on the device, so pairing again replaces the earlier record.
 */
@Serializable
data class DeviceReport(
    val platform: String,
    val appVersion: String,
    val capabilities: List<String>,
    val allowControl: Boolean,
    val installationId: String? = null,
    /** Absent leaves the saved registration as it is; an explicit `null` on the wire removes it. */
    val push: DevicePushRegistration? = null,
)

/**
 * An Apple device's APNs addresses. [topic] is the app's bundle id and [environment] `production` or
 * `sandbox`; the two Live Activity tokens start the summary activity and update the running one.
 */
@Serializable
data class DevicePushRegistration(
    val token: String,
    val topic: String,
    val environment: String,
    val activityStartToken: String? = null,
    val activityToken: String? = null,
)

/**
 * `DeviceInfo.push`: how the server reaches this device in the background. [route] is `direct` or
 * `none`; [reason] (`no_key`, `no_token`, `failed`) says why not, with [detail] for `failed`.
 */
@Serializable
data class DevicePushRoute(
    val route: String,
    val reason: String? = null,
    val detail: String? = null,
)

/** `event: call`. [deadline] and [createdAt] are ISO instants; [args] is the capability's own object. */
@Serializable
data class DeviceCall(
    val callId: String,
    val sessionId: String,
    val capability: String,
    val args: JsonObject = JsonObject(emptyMap()),
    val deadline: String,
    val createdAt: String,
)

/** `event: cancel`: the call timed out or was withdrawn. */
@Serializable
data class DeviceCallCancel(val callId: String)

/** `event: lease`: be connected at [at] (ISO); the device wakes itself about a minute earlier. */
@Serializable
data class DeviceLease(
    val id: String,
    val sessionId: String,
    val at: String,
    val reason: String = "",
)

/** `event: lease-cancel`. */
@Serializable
data class DeviceLeaseCancel(val id: String)

/**
 * `POST /api/devices/me/calls/:callId/result`: `{ok: true, result}` or `{ok: false, code, message?}`.
 * Encoded with `explicitNulls = false`, so the absent half is left out.
 */
@Serializable
data class DeviceCallOutcome(
    val ok: Boolean,
    val result: JsonObject? = null,
    val code: String? = null,
    val message: String? = null,
) {
    companion object {
        fun success(result: JsonObject = JsonObject(emptyMap())) = DeviceCallOutcome(ok = true, result = result)
        fun failure(code: String, message: String? = null) = DeviceCallOutcome(ok = false, code = code, message = message)
    }
}

/** `POST /api/devices/me/calls/:callId/files`, the same body as `POST /api/attachments`. */
@Serializable
data class DeviceFileUpload(
    val name: String,
    val mimeType: String,
    val dataBase64: String,
    val width: Int? = null,
    val height: Int? = null,
)

/** A file attached to a call's result, named in `result.fileIds`. */
@Serializable
data class DeviceFile(val fileId: String, val name: String? = null, val mimeType: String? = null, val size: Long? = null)

/**
 * `GET /api/devices/me/adb`: whether the server's own adb can reach this phone. [state] is open:
 * [DeviceAdbState] lists the known values and anything else is treated as not reachable.
 */
@Serializable
data class DeviceAdbStatus(val state: String)

object DeviceAdbState {
    const val READY = "ready"
    /** The phone is listed but has not accepted this computer's USB debugging key. */
    const val UNAUTHORIZED = "unauthorized"
    const val ABSENT = "absent"
    const val NO_ADB = "no-adb"
}

/** `POST /api/devices/me/adb/grant`: the server runs `pm grant` for [packageName]. Not a registered contract. */
@Serializable
data class DeviceAdbGrantRequest(val packageName: String)

/** [restrictedSettings] is `allowed` or `unsupported` (an older Android has no such setting). */
@Serializable
data class DeviceAdbGrant(val restrictedSettings: String)

/** `event: notice` on `/api/lists/stream`: something an agent (or a wake-up that could not run) wants shown. */
@Serializable
data class RiffetNotice(
    val id: String,
    val sessionId: String,
    val title: String? = null,
    val body: String,
    val createdAt: String,
    /** `agent` or `wakeup`. */
    val source: String = "agent",
)
