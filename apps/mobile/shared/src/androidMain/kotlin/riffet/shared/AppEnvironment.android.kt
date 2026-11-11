package riffet.shared

import android.app.NotificationManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalWindowInfo

actual fun appBuildInfo(): AppBuildInfo {
    val context = RiffetAndroid.requireContext()
    @Suppress("DEPRECATION")
    val info = context.packageManager.getPackageInfo(context.packageName, 0)
    @Suppress("DEPRECATION")
    val code = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()
    return AppBuildInfo(
        info.versionName ?: context.getString(R.string.host_version_unknown),
        code.toString(),
        "Android ${Build.VERSION.RELEASE}",
    )
}

private fun notificationAccess(): NotificationAccess {
    val manager = RiffetAndroid.requireContext().getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    return if (manager.areNotificationsEnabled()) NotificationAccess.ALLOWED else NotificationAccess.BLOCKED
}

@Composable
actual fun rememberNotificationAccess(): NotificationAccess {
    val focused = LocalWindowInfo.current.isWindowFocused
    var value by remember { mutableStateOf(notificationAccess()) }
    LaunchedEffect(focused) { if (focused) value = notificationAccess() }
    return value
}

actual fun openNotificationSettings() {
    val context = RiffetAndroid.requireContext()
    context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
        .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
}

actual val appIconSupported = true

/**
 * Each icon is an `activity-alias` of `RiffetActivity` in `androidApp`'s manifest. The default one
 * keeps the old `MainActivity` name so existing home-screen pins still resolve.
 */
private fun AppIcon.component(context: Context) = ComponentName(
    context,
    if (this == AppIcon.BLUE) "riffet.android.MainActivity"
    else "riffet.android.AppIcon" + name.lowercase().replaceFirstChar(Char::uppercaseChar),
)

/** Only the default alias is enabled in the manifest, so any other one explicitly enabled is the current icon. */
actual fun currentAppIcon(): AppIcon {
    val context = RiffetAndroid.requireContext()
    val packageManager = context.packageManager
    return AppIcon.entries.firstOrNull { icon ->
        icon != AppIcon.BLUE &&
            packageManager.getComponentEnabledSetting(icon.component(context)) == PackageManager.COMPONENT_ENABLED_STATE_ENABLED
    } ?: AppIcon.BLUE
}

/** Enables the new alias before disabling the rest, so the app never has no launcher entry. */
actual fun setAppIcon(icon: AppIcon) {
    val context = RiffetAndroid.requireContext()
    val packageManager = context.packageManager
    packageManager.setComponentEnabledSetting(
        icon.component(context),
        PackageManager.COMPONENT_ENABLED_STATE_ENABLED,
        PackageManager.DONT_KILL_APP,
    )
    AppIcon.entries.filter { it != icon }.forEach { other ->
        packageManager.setComponentEnabledSetting(
            other.component(context),
            PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
            PackageManager.DONT_KILL_APP,
        )
    }
}
