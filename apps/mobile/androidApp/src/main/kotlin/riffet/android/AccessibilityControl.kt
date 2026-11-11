package riffet.android

import android.app.AppOpsManager
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.os.Build
import android.os.Process
import android.provider.Settings
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import riffet.shared.AccessibilityState
import riffet.shared.AppLog

/**
 * Where the accessibility service stands and, once `WRITE_SECURE_SETTINGS` was granted over adb,
 * how the app switches it itself (docs/DEVICES.md §4): the enabled-services list is edited the way
 * GKD does, keeping every other service in it.
 */
internal object AccessibilityControl {
    private const val TAG = "a11y"
    private const val RESTART_GAP_MILLIS = 1_000L
    private const val START_WAIT_MILLIS = 2_500L

    private val lock = Mutex()

    fun component(context: Context) = ComponentName(context, RiffetAccessibilityService::class.java)

    fun canWriteSecure(context: Context): Boolean =
        context.checkSelfPermission(android.Manifest.permission.WRITE_SECURE_SETTINGS) == PackageManager.PERMISSION_GRANTED

    fun state(context: Context): AccessibilityState = when {
        RiffetAccessibilityService.instance.value != null -> AccessibilityState.RUNNING
        RiffetAccessibilityService.enabled(context) -> AccessibilityState.NOT_RUNNING
        restricted(context) -> AccessibilityState.RESTRICTED
        else -> AccessibilityState.OFF
    }

    /** Screen calls can be routed here: the service runs, or this app can start it before the call. */
    fun reachable(context: Context): Boolean = when (state(context)) {
        AccessibilityState.RUNNING -> true
        AccessibilityState.NOT_RUNNING -> canWriteSecure(context)
        else -> false
    }

    /**
     * Android 13+ keeps a sideloaded app from turning on accessibility until 允许受限制的设置 in its
     * app info; the op's mode alone is not reliable (some systems leave it at default with an earlier
     * reject), so it also takes the install source. The op is not public API; unreadable means not restricted.
     */
    @Suppress("DEPRECATION")
    private fun restricted(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return false
        return runCatching {
            val ops = context.getSystemService(AppOpsManager::class.java)
            val mode = ops.unsafeCheckOpNoThrow("android:access_restricted_settings", Process.myUid(), context.packageName)
            if (mode == AppOpsManager.MODE_ALLOWED) return@runCatching false
            val source = context.packageManager.getInstallSourceInfo(context.packageName).packageSource
            source == PackageInstaller.PACKAGE_SOURCE_LOCAL_FILE || source == PackageInstaller.PACKAGE_SOURCE_DOWNLOADED_FILE
        }.getOrDefault(false)
    }

    /** Turns the service on; true once it runs. Already listed but not running is a restart. */
    suspend fun enable(context: Context): Boolean = lock.withLock {
        if (!canWriteSecure(context)) return false
        if (RiffetAccessibilityService.enabled(context)) {
            if (RiffetAccessibilityService.instance.value != null) return true
            return restartLocked(context)
        }
        write(context, listed = true) && started()
    }

    suspend fun restart(context: Context): Boolean = lock.withLock {
        if (!canWriteSecure(context)) return false
        restartLocked(context)
    }

    /** A screen call is about to run on a service that is listed but not bound: restart it first. */
    suspend fun heal(context: Context) {
        if (state(context) != AccessibilityState.NOT_RUNNING || !canWriteSecure(context)) return
        lock.withLock {
            // Another call may have restarted it while this one waited for the lock.
            if (state(context) == AccessibilityState.NOT_RUNNING) restartLocked(context)
        }
    }

    private suspend fun restartLocked(context: Context): Boolean {
        if (!write(context, listed = false)) return false
        delay(RESTART_GAP_MILLIS)
        return write(context, listed = true) && started()
    }

    private suspend fun started(): Boolean =
        withTimeoutOrNull(START_WAIT_MILLIS) { RiffetAccessibilityService.instance.first { it != null } } != null

    private fun write(context: Context, listed: Boolean): Boolean = try {
        val resolver = context.contentResolver
        val self = component(context)
        val others = Settings.Secure.getString(resolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES).orEmpty()
            .split(':').filter { it.isNotBlank() && ComponentName.unflattenFromString(it) != self }
        val next = if (listed) others + self.flattenToString() else others
        Settings.Secure.putString(resolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, next.joinToString(":"))
        if (listed) Settings.Secure.putInt(resolver, Settings.Secure.ACCESSIBILITY_ENABLED, 1)
        true
    } catch (failure: SecurityException) {
        AppLog.log(TAG, "settings write refused")
        false
    }
}
