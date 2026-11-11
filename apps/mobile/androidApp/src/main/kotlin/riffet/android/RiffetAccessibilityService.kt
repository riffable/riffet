package riffet.android

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.accessibilityservice.GestureDescription
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.view.Display
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import androidx.annotation.RequiresApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import riffet.shared.AppLog
import java.util.concurrent.atomic.AtomicInteger
import kotlin.coroutines.resume

/**
 * The T1 accessibility service (docs/DEVICES.md §4): reads the main display's windows, injects
 * gestures and takes screenshots for [ScreenActionGate], which is the only caller. It reports
 * nothing anywhere on its own; events only mark when the screen last changed. After Mika's
 * `ScreenAccessibility` (Apache-2.0, see NOTICE).
 */
class RiffetAccessibilityService : AccessibilityService() {

    override fun onServiceConnected() {
        super.onServiceConnected()
        // Many apps mark their result text as unimportant for accessibility; read those too, even
        // if the system kept an older copy of the service configuration.
        serviceInfo?.let { info ->
            if (info.flags and AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS == 0) {
                info.flags = info.flags or AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS
                serviceInfo = info
            }
        }
        _instance.value = this
        AppLog.log(TAG, "connected")
        RiffetDevice.accessibilityChanged()
    }

    override fun onUnbind(intent: Intent?): Boolean {
        clear()
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        clear()
        super.onDestroy()
    }

    private fun clear() {
        if (_instance.compareAndSet(this, null)) {
            AppLog.log(TAG, "disconnected")
            RiffetDevice.accessibilityChanged()
        }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        lastEventAt = SystemClock.uptimeMillis()
    }

    override fun onInterrupt() = Unit

    /** One gesture of one or more strokes on the main display; true when it completed. */
    suspend fun gesture(strokes: List<GestureDescription.StrokeDescription>): Boolean = suspendCancellableCoroutine { continuation ->
        val builder = GestureDescription.Builder()
        strokes.forEach(builder::addStroke)
        val callback = object : GestureResultCallback() {
            override fun onCompleted(gestureDescription: GestureDescription) {
                ownTouchEnded()
                if (continuation.isActive) continuation.resume(true)
            }

            override fun onCancelled(gestureDescription: GestureDescription) {
                ownTouchEnded()
                if (continuation.isActive) continuation.resume(false)
            }
        }
        ownTouches.incrementAndGet()
        if (!dispatchGesture(builder.build(), callback, null)) {
            ownTouches.decrementAndGet()
            if (continuation.isActive) continuation.resume(false)
        }
    }

    // ---- The owner's touches -------------------------------------------------------------------

    /**
     * Calls [onTouch] once when someone touches the screen while a control call runs (docs/DEVICES.md
     * §5): a 1 px overlay told of every touch outside itself. Touches while one of our gestures plays
     * and while the owner answers a confirmation ([ownerTurn]) are not counted. Returns the stop.
     */
    fun watchTouches(onTouch: () -> Unit): () -> Unit {
        val manager = getSystemService(WindowManager::class.java)
        val view = View(this)
        var added = false
        var fired = false
        view.setOnTouchListener { _, event ->
            if (event.actionMasked == MotionEvent.ACTION_OUTSIDE && ownTouches.get() == 0 && ownerTurns.get() == 0 && !fired) {
                fired = true
                onTouch()
            }
            false
        }
        val params = WindowManager.LayoutParams(
            1, 1, WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH,
            PixelFormat.TRANSPARENT,
        ).apply { gravity = Gravity.TOP or Gravity.START }
        main.post {
            added = runCatching { manager.addView(view, params) }.onFailure { AppLog.log(TAG, "touch watch unavailable") }.isSuccess
        }
        return { main.post { if (added) runCatching { manager.removeView(view) }; added = false } }
    }

    private fun ownTouchEnded() {
        // The system may report the injected touch a moment after the gesture completes.
        main.postDelayed({ ownTouches.decrementAndGet() }, OWN_TOUCH_GRACE_MILLIS)
    }

    suspend fun tap(x: Float, y: Float, holdMillis: Long): Boolean =
        gesture(listOf(GestureDescription.StrokeDescription(Path().apply { moveTo(x, y) }, 0, holdMillis.coerceAtLeast(1))))

    suspend fun swipe(fromX: Float, fromY: Float, toX: Float, toY: Float, durationMillis: Long): Boolean =
        gesture(listOf(GestureDescription.StrokeDescription(Path().apply { moveTo(fromX, fromY); lineTo(toX, toY) }, 0, durationMillis)))

    /** A screenshot of the main display, or why there is none. */
    sealed interface Shot {
        class Ok(val bitmap: Bitmap) : Shot
        data object Secure : Shot
        data class Failed(val message: String) : Shot
    }

    /** API 30+. Android allows one screenshot about every 333 ms; calls are spaced and retried once. */
    @RequiresApi(Build.VERSION_CODES.R)
    suspend fun screenshot(): Shot = shots.withLock {
        val wait = lastShotAt + SHOT_INTERVAL_MILLIS - SystemClock.uptimeMillis()
        if (wait > 0) delay(wait)
        var shot = shotOnce()
        if (shot is Shot.Failed && shot.message == INTERVAL_TOO_SHORT) {
            delay(SHOT_INTERVAL_MILLIS * 3)
            shot = shotOnce()
        }
        lastShotAt = SystemClock.uptimeMillis()
        shot
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private suspend fun shotOnce(): Shot = suspendCancellableCoroutine { continuation ->
        takeScreenshot(Display.DEFAULT_DISPLAY, mainExecutor, object : TakeScreenshotCallback {
            override fun onSuccess(result: ScreenshotResult) {
                val bitmap = runCatching {
                    result.hardwareBuffer.use { buffer ->
                        val hardware = Bitmap.wrapHardwareBuffer(buffer, result.colorSpace) ?: return@runCatching null
                        hardware.copy(Bitmap.Config.ARGB_8888, false).also { hardware.recycle() }
                    }
                }.getOrNull()
                if (continuation.isActive) continuation.resume(bitmap?.let(Shot::Ok) ?: Shot.Failed("The screenshot could not be read"))
            }

            override fun onFailure(errorCode: Int) {
                val secure = Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE && errorCode == ERROR_TAKE_SCREENSHOT_SECURE_WINDOW
                val shot = when {
                    secure -> Shot.Secure
                    errorCode == ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT -> Shot.Failed(INTERVAL_TOO_SHORT)
                    else -> Shot.Failed("Screenshot failed ($errorCode)")
                }
                if (continuation.isActive) continuation.resume(shot)
            }
        })
    }

    companion object {
        private const val TAG = "a11y"
        private const val SHOT_INTERVAL_MILLIS = 350L
        private const val INTERVAL_TOO_SHORT = "interval"
        private const val OWN_TOUCH_GRACE_MILLIS = 150L
        private const val OWNER_TURN_GRACE_MILLIS = 500L

        private val main = Handler(Looper.getMainLooper())

        /** Gestures of ours in flight or just ended. */
        private val ownTouches = AtomicInteger()

        /** Confirmations the owner is answering: their touches there are not a takeover. */
        private val ownerTurns = AtomicInteger()

        /** Runs [block] while the owner's touches are expected, such as a confirmation sheet. */
        suspend fun <T> ownerTurn(block: suspend () -> T): T {
            ownerTurns.incrementAndGet()
            try {
                return block()
            } finally {
                main.postDelayed({ ownerTurns.decrementAndGet() }, OWNER_TURN_GRACE_MILLIS)
            }
        }

        private val _instance = MutableStateFlow<RiffetAccessibilityService?>(null)

        /** The connected service, or null while it is off. */
        val instance: StateFlow<RiffetAccessibilityService?> = _instance.asStateFlow()

        /** `uptimeMillis` of the last accessibility event: the screen last changed then. */
        @Volatile
        var lastEventAt: Long = 0L
            private set

        private val shots = Mutex()

        @Volatile
        private var lastShotAt = 0L

        /** Turned on in the system settings, whether or not it is bound right now. */
        fun enabled(context: Context): Boolean {
            val component = ComponentName(context, RiffetAccessibilityService::class.java)
            val list = Settings.Secure.getString(context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES).orEmpty()
            return list.split(':').any { ComponentName.unflattenFromString(it) == component }
        }
    }
}
