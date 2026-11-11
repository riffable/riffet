package riffet.android

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ActivityNotFoundException
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import riffet.ui.platform.ApprovalVerification
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import kotlinx.coroutines.CompletableDeferred
import riffet.shared.AppLog
import riffet.shared.AppLanguages
import riffet.shared.RiffetAndroid
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/** What the owner did with a request that needed them at the phone. */
internal sealed interface DeviceActionResult {
    data class Done(val text: String? = null, val uri: Uri? = null) : DeviceActionResult
    data object Denied : DeviceActionResult
    data class Failed(val message: String) : DeviceActionResult
}

/** The things only a visible Activity may do: read the clipboard, open the camera or picker, start another app. */
internal sealed interface DeviceAction {
    data object ReadClipboard : DeviceAction
    data class TakePhoto(val file: File) : DeviceAction
    data object PickPhoto : DeviceAction
    data class Launch(val intent: Intent) : DeviceAction

    /** An irreversible step or a pre-authorisation (docs/DEVICES.md §5), confirmed on [DeviceConfirmSheet]. */
    data class Confirm(val request: ConfirmRequest) : DeviceAction
}

/**
 * Requests waiting for [DeviceActionActivity]. In front, the Activity is started directly; in the
 * background Android blocks that (and clipboard reads), so a heads-up notification carries it, and
 * dismissing the notification is a refusal.
 */
internal object DeviceRequests {
    private class Pending(val action: DeviceAction, val result: CompletableDeferred<DeviceActionResult>)

    private val pending = ConcurrentHashMap<String, Pending>()

    /**
     * Suspends until the owner acted, refused, or the call's coroutine is cancelled (deadline, server
     * cancel). [direct]: the accessibility service is bound, which lets Riffet start the sheet from
     * the background; the notification is posted as well, for an owner not looking at the screen.
     */
    suspend fun await(context: Context, callId: String, action: DeviceAction, title: String, text: String?, timeoutMillis: Long?, direct: Boolean = false, localizeTitle: (() -> String)? = null): DeviceActionResult {
        val entry = Pending(action, CompletableDeferred())
        pending[callId] = entry
        val notifier = RiffetHost.notifier
        val titleForLanguage = {
            if (action is DeviceAction.Confirm) action.request.title(AppLanguages.localize(context))
            else localizeTitle?.invoke() ?: title
        }
        try {
            val activity = RiffetAndroid.currentActivity()
            val notifications = context.getSystemService(NotificationManager::class.java)?.areNotificationsEnabled() == true
            if (direct) {
                val started = runCatching { context.startActivity(intent(context, callId)) }.isSuccess
                if (notifications) notifier.deviceRequest(callId, titleForLanguage(), text, open(context, callId), deny(context, callId), timeoutMillis, localizeTitle = titleForLanguage)
                if (!started && !notifications) return DeviceActionResult.Failed("The confirmation could not be shown on the device")
            } else if (activity != null && !activity.isFinishing) {
                activity.startActivity(intent(context, callId))
            } else if (!notifications) {
                return DeviceActionResult.Failed("Riffet is in the background and its notifications are off, so the request cannot reach the owner")
            } else {
                notifier.deviceRequest(callId, titleForLanguage(), text, open(context, callId), deny(context, callId), timeoutMillis, localizeTitle = titleForLanguage)
            }
            return entry.result.await()
        } finally {
            pending.remove(callId, entry)
            notifier.cancelDeviceRequest(callId)
        }
    }

    fun action(callId: String): DeviceAction? = pending[callId]?.action

    fun complete(callId: String, result: DeviceActionResult) {
        pending[callId]?.result?.complete(result)
        RiffetHost.notifier.cancelDeviceRequest(callId)
    }

    private fun intent(context: Context, callId: String) = Intent(context, DeviceActionActivity::class.java)
        .setData(Uri.parse("riffet://device/$callId"))
        .putExtra(DeviceActionActivity.EXTRA_CALL, callId)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    private fun open(context: Context, callId: String): PendingIntent =
        PendingIntent.getActivity(context, callId.hashCode(), intent(context, callId), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

    private fun deny(context: Context, callId: String): PendingIntent = PendingIntent.getBroadcast(
        context,
        callId.hashCode(),
        Intent(context, DeviceReceiver::class.java).setAction(DeviceReceiver.ACTION_DENY).setData(Uri.parse("riffet://device/$callId")).putExtra(DeviceActionActivity.EXTRA_CALL, callId),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
}

/**
 * A transparent, recents-less Activity that does one [DeviceAction] for a waiting call and closes.
 * Being a visible window is what lets it read the clipboard (Android 10+) and start the camera,
 * the picker or another app without the background-start block.
 */
class DeviceActionActivity : RiffetLocalizedActivity() {
    private var callId: String? = null
    private var started = false
    private var photo: File? = null

    private val takePicture = registerForActivityResult(ActivityResultContracts.TakePicture()) { saved ->
        val file = photo
        finishWith(if (saved && file != null && file.length() > 0) DeviceActionResult.Done(uri = Uri.fromFile(file)) else DeviceActionResult.Denied)
    }

    private val pickPhoto = registerForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        finishWith(if (uri != null) DeviceActionResult.Done(uri = uri) else DeviceActionResult.Denied)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        started = savedInstanceState?.getBoolean(STATE_STARTED) == true
        photo = savedInstanceState?.getString(STATE_PHOTO)?.let(::File)
        callId = intent.getStringExtra(EXTRA_CALL)
        val action = callId?.let(DeviceRequests::action)
        if (action == null) {
            // The call ended (answered, cancelled, timed out) or the process restarted since.
            finish()
            return
        }
        if (started && action !is DeviceAction.Confirm) return
        when (action) {
            // Read once the window has focus; Android refuses a read before.
            DeviceAction.ReadClipboard -> Unit
            is DeviceAction.TakePhoto -> launch {
                photo = action.file
                takePicture.launch(FileProvider.getUriForFile(this, "$packageName.downloads", action.file))
            }
            DeviceAction.PickPhoto -> launch { pickPhoto.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }
            is DeviceAction.Launch -> launch {
                startActivity(action.intent)
                finishWith(DeviceActionResult.Done())
            }
            // Drawn again on recreation; nothing is started until the owner answers.
            is DeviceAction.Confirm -> confirm(action.request)
        }
    }

    private fun confirm(request: ConfirmRequest) {
        setContent {
            DeviceConfirmSheet(
                request = request,
                onAllow = {
                    lifecycleScope.launch {
                        // 确认操作前验证本人 covers these too: they let the Agent act.
                        if (ApprovalVerification.required && !ApprovalVerification.authenticate(request.title(this@DeviceActionActivity))) return@launch
                        finishWith(DeviceActionResult.Done())
                    }
                },
                onDeny = { finishWith(DeviceActionResult.Denied) },
            )
        }
    }

    // The biometric prompt attaches to the Activity in front.
    override fun onResume() {
        super.onResume()
        RiffetAndroid.attachActivity(this)
    }

    override fun onPause() {
        if (RiffetAndroid.currentActivity() === this) RiffetAndroid.attachActivity(null)
        super.onPause()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        val id = callId ?: return
        if (!hasFocus || started || DeviceRequests.action(id) != DeviceAction.ReadClipboard) return
        started = true
        val clipboard = getSystemService(ClipboardManager::class.java)
        val text = clipboard?.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(this)?.toString()
        finishWith(DeviceActionResult.Done(text = text))
    }

    private fun launch(block: () -> Unit) {
        started = true
        try {
            block()
        } catch (_: ActivityNotFoundException) {
            finishWith(DeviceActionResult.Failed("No app on this device can handle it"))
        } catch (failure: SecurityException) {
            finishWith(DeviceActionResult.Failed(failure.message ?: "Not permitted"))
        }
    }

    private fun finishWith(result: DeviceActionResult) {
        callId?.let { id ->
            AppLog.log("device", "action ${id.take(8)} ${result::class.simpleName}")
            DeviceRequests.complete(id, result)
        }
        finish()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putBoolean(STATE_STARTED, started)
        photo?.let { outState.putString(STATE_PHOTO, it.path) }
    }

    /** Leaving without acting (back, home) is a refusal, unless the camera or picker is what covered it. */
    override fun onDestroy() {
        if (isFinishing && !isChangingConfigurations) callId?.let { DeviceRequests.complete(it, DeviceActionResult.Denied) }
        super.onDestroy()
    }

    companion object {
        const val EXTRA_CALL = "riffet.device.call"
        private const val STATE_STARTED = "started"
        private const val STATE_PHOTO = "photo"
    }
}
