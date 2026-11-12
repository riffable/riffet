package riffet.shared

import riffet.contracts.DeviceAdbGrant
import riffet.contracts.DeviceAdbGrantRequest
import riffet.contracts.DeviceAdbState
import riffet.contracts.DeviceAdbStatus
import riffet.contracts.DeviceCallOutcome
import riffet.contracts.DeviceFile
import riffet.contracts.DeviceFileUpload
import riffet.contracts.DeviceReport
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

/*
 * This device's side of the device channel (docs/DEVICES.md §3). Every route here takes the device
 * token only; a browser session cannot reach them.
 */

/** `PUT /api/devices/me`: what this device can do right now and whether it may be called at all. */
@Throws(Exception::class)
suspend fun RiffetApi.reportDevice(report: DeviceReport): PublicDevice =
    put("/api/devices/me", wireBody(report)).decode()

/** [reportDevice] that also removes the saved push registration: `push` is an explicit `null`. */
@Throws(Exception::class)
suspend fun RiffetApi.reportDeviceClearingPush(report: DeviceReport): PublicDevice =
    put("/api/devices/me", JsonObject(wireBody(report.copy(push = null)).jsonObject + ("push" to JsonNull))).decode()

/**
 * `POST /api/devices/me/calls/:callId/result`. Idempotent per call on the server, so a retry after a
 * lost response is safe; the receipt is not needed and is discarded.
 */
@Throws(Exception::class)
suspend fun RiffetApi.postDeviceCallResult(callId: String, outcome: DeviceCallOutcome) {
    post("/api/devices/me/calls/${callId.enc()}/result", wireBody(outcome)).discard()
}

/** `POST /api/devices/me/calls/:callId/files`, before the result that names the returned id. */
@Throws(Exception::class)
suspend fun RiffetApi.uploadDeviceCallFile(callId: String, file: DeviceFileUpload): DeviceFile =
    post("/api/devices/me/calls/${callId.enc()}/files", wireBody(file)).decode()

/** `GET /api/devices/me/adb`: an older server has no such route (404), which reads as no adb. */
@Throws(Exception::class)
suspend fun RiffetApi.deviceAdbStatus(packageName: String): DeviceAdbStatus =
    try {
        get("/api/devices/me/adb", listOf("package" to packageName)).decode()
    } catch (failure: RiffetHttpException) {
        if (failure.status == 404) DeviceAdbStatus(DeviceAdbState.ABSENT) else throw failure
    }

/**
 * `POST /api/devices/me/adb/grant`: grants `WRITE_SECURE_SETTINGS` over the server's adb. Fails with
 * 409 `ADB_UNAVAILABLE`, or 409 `ADB_GRANT_FAILED` whose [RiffetHttpException.serverMessage] is adb's first output line.
 */
@Throws(Exception::class)
suspend fun RiffetApi.grantDeviceAdb(packageName: String): DeviceAdbGrant =
    post("/api/devices/me/adb/grant", wireBody(DeviceAdbGrantRequest(packageName))).decode()

/** `GET /api/devices/me/stream`, redialled with the shared backoff; see [DeviceStreamSource]. */
fun RiffetApi.deviceStream(beforeDial: suspend () -> Unit): DeviceStreamSession = DeviceStreamSource(
    http = http,
    url = "$baseUrl/api/devices/me/stream",
    tokenProvider = tokenProvider,
    config = config,
    beforeDial = beforeDial,
).open()

/** The `notice` events of `/api/lists/stream`; its `changed` hints are ignored here. */
fun RiffetApi.noticeStream(): NoticeStreamSession = NoticeStreamSource(
    http = http,
    url = "$baseUrl/api/lists/stream",
    tokenProvider = tokenProvider,
    config = config,
).open()
