package riffet.shared

import androidx.compose.runtime.Composable
import platform.Foundation.NSBundle

actual fun appBuildInfo(): AppBuildInfo {
    val bundle = NSBundle.mainBundle
    return AppBuildInfo(
        bundle.objectForInfoDictionaryKey("CFBundleShortVersionString") as? String ?: "未知",
        bundle.objectForInfoDictionaryKey("CFBundleVersion") as? String ?: "未知",
        "iOS",
    )
}
@Composable
actual fun rememberNotificationAccess() = NotificationAccess.UNSUPPORTED
actual fun openNotificationSettings() = Unit
actual val appIconSupported = false
actual fun currentAppIcon() = AppIcon.BLUE
actual fun setAppIcon(icon: AppIcon) = Unit
