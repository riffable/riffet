package riffet.ui.state

import android.os.Build
import android.os.Trace

actual fun traceBegin(name: String) = Trace.beginSection(name)

actual fun traceEnd() = Trace.endSection()

actual fun traceAsyncBegin(name: String, cookie: Int) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) Trace.beginAsyncSection(name, cookie)
}

actual fun traceAsyncEnd(name: String, cookie: Int) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) Trace.endAsyncSection(name, cookie)
}

// `adb shell setprop log.tag.RiffetLifecycle DEBUG`, then restart the app.
private const val LIFECYCLE_TAG = "RiffetLifecycle"
private val lifecycleTracing by lazy { android.util.Log.isLoggable(LIFECYCLE_TAG, android.util.Log.DEBUG) }

actual fun lifecycleTraceEnabled(): Boolean = lifecycleTracing

actual fun lifecycleTrace(message: String) { android.util.Log.d(LIFECYCLE_TAG, message) }
