package riffet.android

import android.Manifest
import android.app.NotificationManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.net.Uri
import android.os.Build
import android.os.CancellationSignal
import android.os.Looper
import android.provider.AlarmClock
import android.provider.MediaStore
import android.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import riffet.contracts.DeviceCall
import riffet.contracts.DeviceCallOutcome
import riffet.contracts.DeviceCapability
import riffet.contracts.DeviceErrorCode
import riffet.contracts.DeviceFileUpload
import riffet.shared.DeviceCapabilityState
import riffet.shared.DeviceControl
import riffet.shared.DeviceExecutor
import riffet.shared.DevicePermission
import riffet.shared.RiffetAndroid
import riffet.shared.RiffetApi
import riffet.shared.uploadDeviceCallFile
import java.io.ByteArrayOutputStream
import java.io.File
import java.time.Instant
import kotlin.coroutines.resume

/**
 * The T0 capabilities on Android (docs/DEVICES.md §3, §4). Reached only through `DeviceGate`, which
 * has already checked the switch, the capability and the deadline.
 *
 * Android blocks background Activity starts and background clipboard reads, so a call that needs a
 * window (clipboard read from the background, photo, link, alarm) goes through [DeviceRequests]: in
 * front it opens at once, otherwise it waits for a tap on a heads-up notification.
 */
internal class AndroidDeviceExecutor(private val rawContext: Context) : DeviceExecutor {
    private val context get() = riffet.shared.AppLanguages.localize(rawContext)
    private val screen = ScreenActionGate(context)

    /** T1 only while the switch is on: the report sent when it goes off leaves screen control out. */
    override fun capabilities(): List<String> =
        DeviceCapabilities.states(context).filter { it.usable }.map { it.id } + if (DeviceControl.allowed.value) screen.capabilities() else emptyList()

    override fun screenLocked(): Boolean = screen.locked().also { if (it) DeviceNotices.locked(context) }

    override suspend fun execute(call: DeviceCall, api: RiffetApi): DeviceCallOutcome = when (call.capability) {
        in DeviceCapability.T1 -> {
            // Listed as enabled but not bound (killed, or switched off and on by the system): bring it back first.
            AccessibilityControl.heal(context)
            screen.execute(call, api)
        }
        DeviceCapability.NOTIFY -> notify(call)
        DeviceCapability.CLIPBOARD_WRITE -> clipboardWrite(call)
        DeviceCapability.CLIPBOARD_READ -> clipboardRead(call)
        DeviceCapability.LOCATION -> location()
        DeviceCapability.PHOTO -> photo(call, api)
        DeviceCapability.OPEN_URL -> openUrl(call)
        DeviceCapability.ALARM -> alarm(call)
        else -> DeviceCallOutcome.failure(DeviceErrorCode.CAPABILITY_MISSING, "${call.capability} is not supported on Android")
    }

    private fun DeviceCall.string(key: String): String? = (args[key] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }
    private fun DeviceCall.int(key: String): Int? = (args[key] as? JsonPrimitive)?.intOrNull
    private fun invalid(message: String) = DeviceCallOutcome.failure(DeviceErrorCode.FAILED, message)
    private fun timeLeft(call: DeviceCall): Long? = runCatching { Instant.parse(call.deadline).toEpochMilli() - System.currentTimeMillis() }.getOrNull()
    private fun sessionTitle(call: DeviceCall): String? =
        RiffetHost.store.value?.list?.value?.sessions?.firstOrNull { it.id == call.sessionId }?.title

    private fun notify(call: DeviceCall): DeviceCallOutcome {
        val body = call.string("body") ?: return invalid("body is required")
        val origin = RiffetHost.currentOrigin ?: return invalid("Not connected")
        RiffetHost.notifier.agentMessage("call-${call.callId}", call.sessionId, call.string("title"), body.take(BODY_LIMIT), sessionTitle(call), origin)
        return DeviceCallOutcome.success()
    }

    private suspend fun clipboardWrite(call: DeviceCall): DeviceCallOutcome {
        val text = (call.args["text"] as? JsonPrimitive)?.contentOrNull ?: return invalid("text is required")
        withContext(Dispatchers.Main) {
            context.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("Riffet", text))
        }
        return DeviceCallOutcome.success()
    }

    /** In front with focus it is read at once; otherwise only a tap on the notification can give the read a window. */
    private suspend fun clipboardRead(call: DeviceCall): DeviceCallOutcome {
        val focused = withContext(Dispatchers.Main) { RiffetAndroid.currentActivity()?.hasWindowFocus() == true }
        val text = if (focused) {
            withContext(Dispatchers.Main) {
                context.getSystemService(ClipboardManager::class.java).primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(context)?.toString()
            }
        } else {
            when (val result = request(call, DeviceAction.ReadClipboard, Titles.clipboard)) {
                is DeviceActionResult.Done -> result.text
                else -> return result.outcome()
            }
        }
        return DeviceCallOutcome.success(buildJsonObject { text?.let { put("text", JsonPrimitive(it)) } })
    }

    @Suppress("MissingPermission")
    private suspend fun location(): DeviceCallOutcome {
        val manager = context.getSystemService(LocationManager::class.java) ?: return invalid("No location service")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && !manager.isLocationEnabled) return invalid("Location is turned off on this device")
        // Without 始终允许, Android only hands out a fix while the app is in front or its
        // location-typed service runs (RiffetSyncService adds the type once location is allowed).
        val inFront = withContext(Dispatchers.Main) { RiffetAndroid.currentActivity() != null }
        val background = Build.VERSION.SDK_INT < Build.VERSION_CODES.Q ||
            context.checkSelfPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED
        if (!inFront && !background && !RiffetSyncService.locationTyped) {
            return invalid("Android gives Riffet a location only while it is in front or its connection service is running")
        }
        val providers = buildList {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) add(LocationManager.FUSED_PROVIDER)
            add(LocationManager.GPS_PROVIDER)
            add(LocationManager.NETWORK_PROVIDER)
        }.filter { runCatching { manager.isProviderEnabled(it) }.getOrDefault(false) }
        if (providers.isEmpty()) return invalid("No location provider is enabled")
        return try {
            val last = providers.mapNotNull { runCatching { manager.getLastKnownLocation(it) }.getOrNull() }.maxByOrNull { it.time }
            val fresh = last?.takeIf { System.currentTimeMillis() - it.time < FRESH_FIX_MILLIS }
            val fix = fresh ?: withTimeoutOrNull(FIX_TIMEOUT_MILLIS) { current(manager, providers.first()) } ?: last
                ?: return invalid("No location fix")
            DeviceCallOutcome.success(
                buildJsonObject {
                    put("latitude", JsonPrimitive(fix.latitude))
                    put("longitude", JsonPrimitive(fix.longitude))
                    if (fix.hasAccuracy()) put("accuracyMeters", JsonPrimitive(fix.accuracy.toDouble()))
                    put("capturedAt", JsonPrimitive(Instant.ofEpochMilli(fix.time).toString()))
                },
            )
        } catch (failure: SecurityException) {
            DeviceCallOutcome.failure(DeviceErrorCode.DENIED, failure.message ?: "Location permission is not granted")
        }
    }

    @Suppress("MissingPermission", "DEPRECATION")
    private suspend fun current(manager: LocationManager, provider: String): Location? = withContext(Dispatchers.Main) {
        suspendCancellableCoroutine { continuation ->
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val signal = CancellationSignal()
                continuation.invokeOnCancellation { signal.cancel() }
                manager.getCurrentLocation(provider, signal, context.mainExecutor) { fix -> if (continuation.isActive) continuation.resume(fix) }
            } else {
                val listener = LocationListener { fix -> if (continuation.isActive) continuation.resume(fix) }
                continuation.invokeOnCancellation { manager.removeUpdates(listener) }
                manager.requestSingleUpdate(provider, listener, Looper.getMainLooper())
            }
        }
    }

    private suspend fun photo(call: DeviceCall, api: RiffetApi): DeviceCallOutcome {
        val gallery = call.string("source") == "gallery"
        val action = if (gallery) {
            DeviceAction.PickPhoto
        } else {
            if (context.checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                return invalid("Camera permission is not granted on this device; source \"gallery\" still works")
            }
            val dir = File(context.cacheDir, "device").apply { mkdirs() }
            DeviceAction.TakePhoto(File(dir, "photo-${call.callId.take(16)}.jpg"))
        }
        val uri = when (val result = request(call, action, if (gallery) Titles.pickPhoto else Titles.takePhoto)) {
            is DeviceActionResult.Done -> result.uri ?: return DeviceCallOutcome.failure(DeviceErrorCode.DENIED)
            else -> return result.outcome()
        }
        try {
            val upload = withContext(Dispatchers.IO) { encode(uri) } ?: return invalid("Could not read the photo")
            val file = api.uploadDeviceCallFile(call.callId, upload)
            return DeviceCallOutcome.success(buildJsonObject { put("fileIds", buildJsonArray { add(JsonPrimitive(file.fileId)) }) })
        } finally {
            (action as? DeviceAction.TakePhoto)?.file?.delete()
        }
    }

    /** The photo as the server's attachment body; past [PHOTO_MAX_EDGE] or [PHOTO_MAX_BYTES] it is re-encoded smaller. */
    private fun encode(uri: Uri): DeviceFileUpload? {
        val resolver = context.contentResolver
        val bytes = resolver.openInputStream(uri)?.use { it.readBytes() } ?: return null
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        val width = bounds.outWidth.takeIf { it > 0 }
        val height = bounds.outHeight.takeIf { it > 0 }
        val mime = (if (uri.scheme == "file") null else resolver.getType(uri)) ?: bounds.outMimeType ?: "image/jpeg"
        val edge = maxOf(width ?: 0, height ?: 0)
        if (bytes.size <= PHOTO_MAX_BYTES && edge <= PHOTO_MAX_EDGE) {
            return DeviceFileUpload(name(mime), mime, Base64.encodeToString(bytes, Base64.NO_WRAP), width, height)
        }
        var sample = 1
        while (edge / (sample * 2) >= PHOTO_MAX_EDGE) sample *= 2
        val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
        val scale = minOf(1f, PHOTO_MAX_EDGE.toFloat() / maxOf(bitmap.width, bitmap.height))
        val scaled = if (scale < 1f) Bitmap.createScaledBitmap(bitmap, (bitmap.width * scale).toInt(), (bitmap.height * scale).toInt(), true) else bitmap
        val out = ByteArrayOutputStream()
        scaled.compress(Bitmap.CompressFormat.JPEG, 88, out)
        return DeviceFileUpload(name("image/jpeg"), "image/jpeg", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP), scaled.width, scaled.height)
    }

    private fun name(mime: String): String {
        val extension = when (mime) {
            "image/png" -> "png"
            "image/webp" -> "webp"
            "image/heic", "image/heif" -> "heic"
            else -> "jpg"
        }
        return "photo-${System.currentTimeMillis()}.$extension"
    }

    private suspend fun openUrl(call: DeviceCall): DeviceCallOutcome {
        val raw = call.string("url") ?: return invalid("url is required")
        val uri = Uri.parse(raw.trim())
        val scheme = uri.scheme?.lowercase() ?: return invalid("url needs a scheme")
        if (scheme in BLOCKED_SCHEMES) return invalid("$scheme: links are not opened")
        val intent = Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return launch(call, intent, Titles.openUrl, raw)
    }

    private suspend fun alarm(call: DeviceCall): DeviceCallOutcome {
        val hour = call.int("hour")?.takeIf { it in 0..23 } ?: return invalid("hour must be 0–23")
        val minute = call.int("minute")?.takeIf { it in 0..59 } ?: return invalid("minute must be 0–59")
        val intent = Intent(AlarmClock.ACTION_SET_ALARM)
            .putExtra(AlarmClock.EXTRA_HOUR, hour)
            .putExtra(AlarmClock.EXTRA_MINUTES, minute)
            .putExtra(AlarmClock.EXTRA_SKIP_UI, true)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        call.string("label")?.let { intent.putExtra(AlarmClock.EXTRA_MESSAGE, it) }
        return launch(call, intent, Titles.alarm, "%02d:%02d".format(hour, minute))
    }

    /** Started at once from the front; from the background only a tap may start another app. */
    private suspend fun launch(call: DeviceCall, intent: Intent, title: Int, text: String): DeviceCallOutcome {
        val started = withContext(Dispatchers.Main) {
            val activity = RiffetAndroid.currentActivity() ?: return@withContext null
            try {
                activity.startActivity(intent)
                DeviceCallOutcome.success()
            } catch (_: android.content.ActivityNotFoundException) {
                invalid("No app on this device can handle it")
            }
        }
        if (started != null) return started
        return when (val result = request(call, DeviceAction.Launch(intent), title, text)) {
            is DeviceActionResult.Done -> DeviceCallOutcome.success()
            else -> result.outcome()
        }
    }

    private suspend fun request(call: DeviceCall, action: DeviceAction, title: Int, text: String? = null): DeviceActionResult =
        DeviceRequests.await(context, call.callId, action, context.getString(title), text ?: sessionTitle(call), timeLeft(call),
            localizeTitle = { context.getString(title) })

    private fun DeviceActionResult.outcome(): DeviceCallOutcome = when (this) {
        is DeviceActionResult.Done -> DeviceCallOutcome.success()
        DeviceActionResult.Denied -> DeviceCallOutcome.failure(DeviceErrorCode.DENIED, "The owner declined on the device")
        is DeviceActionResult.Failed -> invalid(message)
    }

    /** Notification titles; the host's own strings. */
    private object Titles {
        val clipboard = riffet.shared.R.string.host_device_request_clipboard
        val takePhoto = riffet.shared.R.string.host_device_request_photo
        val pickPhoto = riffet.shared.R.string.host_device_request_pick_photo
        val openUrl = riffet.shared.R.string.host_device_request_open_url
        val alarm = riffet.shared.R.string.host_device_request_alarm
    }

    private companion object {
        const val BODY_LIMIT = 2000
        const val FRESH_FIX_MILLIS = 60_000L
        const val FIX_TIMEOUT_MILLIS = 20_000L
        const val PHOTO_MAX_EDGE = 4096
        const val PHOTO_MAX_BYTES = 12 * 1024 * 1024
        val BLOCKED_SCHEMES = setOf("file", "content", "intent", "javascript", "data", "android-app")
    }
}

/** What each T0 capability needs here, read fresh each time; the gate and the settings page share it. */
internal object DeviceCapabilities {
    fun states(context: Context): List<DeviceCapabilityState> {
        val notifications = context.getSystemService(NotificationManager::class.java)?.areNotificationsEnabled() == true
        val location = granted(context, Manifest.permission.ACCESS_FINE_LOCATION) || granted(context, Manifest.permission.ACCESS_COARSE_LOCATION)
        val hasCamera = context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY) &&
            Intent(MediaStore.ACTION_IMAGE_CAPTURE).resolveActivity(context.packageManager) != null
        val camera = hasCamera && granted(context, Manifest.permission.CAMERA)
        val alarm = Intent(AlarmClock.ACTION_SET_ALARM).resolveActivity(context.packageManager) != null
        return listOf(
            DeviceCapabilityState(DeviceCapability.NOTIFY, notifications, DevicePermission.NOTIFICATIONS.takeUnless { notifications }),
            DeviceCapabilityState(DeviceCapability.CLIPBOARD_READ, true),
            DeviceCapabilityState(DeviceCapability.CLIPBOARD_WRITE, true),
            DeviceCapabilityState(DeviceCapability.LOCATION, location, DevicePermission.LOCATION.takeUnless { location }),
            // The picker needs no permission, so photos are always possible; the camera is the extra.
            DeviceCapabilityState(DeviceCapability.PHOTO, true, DevicePermission.CAMERA.takeIf { hasCamera && !camera }),
            DeviceCapabilityState(DeviceCapability.OPEN_URL, true),
            DeviceCapabilityState(DeviceCapability.ALARM, alarm),
        )
    }

    fun granted(context: Context, permission: String) = context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED
}
