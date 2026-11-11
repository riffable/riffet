package riffet.android

import android.app.Application
import android.content.res.Configuration
import android.os.Build
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import riffet.cache.createLogFiles
import riffet.shared.AppLog
import riffet.shared.AppLanguages
import riffet.shared.RiffetAndroid
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Captures the application context the platform seams need. This is the only place that hands
 * `shared` a `Context`, and it is the application context so it cannot outlive the process or leak
 * an Activity.
 */
class RiffetApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        RiffetAndroid.initialize(this, AppLanguages::localize)
        AppLanguages.initialize(this)
        CrashLog.install(this)
        RiffetHost.initialize(this)
        MainScope().launch {
            AppLanguages.changes.collectLatest {
                RiffetHost.notifier.refreshLanguage()
                DeviceNotices.refreshLanguage(this@RiffetApplication)
                // notify() is asynchronous. Catch recent posts after they become visible, while
                // still respecting notifications dismissed before this second pass.
                delay(1_000L)
                RiffetHost.notifier.refreshLanguage()
                DeviceNotices.refreshLanguage(this@RiffetApplication)
            }
        }
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        AppLanguages.refresh(this)
    }
}

/**
 * Writes an uncaught exception into [AppLog] before the process dies, so 导出日志 / 上传日志 carry
 * it with what led up to it (export redacts credentials). The system's handler still runs after it
 * and shows the usual crash dialog.
 */
private object CrashLog {
    fun install(application: Application) {
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        val version = runCatching { application.packageManager.getPackageInfo(application.packageName, 0).versionName }.getOrNull()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            try {
                record(thread, error, version)
            } catch (_: Throwable) {
                // The crash itself is what matters; a log that cannot be written must not hide it.
            }
            previous?.uncaughtException(thread, error)
        }
    }

    /**
     * Synchronous: the process is about to go. Lines still queued are written out first (the
     * export flushes [AppLog]'s queue under its lock), then the trace is appended straight to the
     * file [AppLog] writes, so it lands even if its writer is the thread that died.
     */
    private fun record(thread: Thread, error: Throwable, version: String?) {
        runCatching { runBlocking { withTimeoutOrNull(FLUSH_MILLIS) { AppLog.export() } } }
        val time = SimpleDateFormat("HH:mm:ss.SSS", Locale.ROOT).format(Date())
        val text = "$time [crash] uncaught on ${thread.name} version=$version android=${Build.VERSION.SDK_INT}\n" +
            error.stackTraceToString().trimEnd() + "\n"
        createLogFiles().append(CURRENT_LOG, text)
    }

    /** `AppLog`'s current file; the two must agree. */
    private const val CURRENT_LOG = "logs/current.log"
    private const val FLUSH_MILLIS = 1_500L
}
