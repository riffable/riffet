package riffet.shared

import androidx.compose.runtime.Composable

actual fun appBuildInfo() = AppBuildInfo("开发环境", "JVM", "桌面")
@Composable
actual fun rememberNotificationAccess() = NotificationAccess.UNSUPPORTED
actual fun openNotificationSettings() = Unit
actual val appIconSupported = false
actual fun currentAppIcon() = AppIcon.BLUE
actual fun setAppIcon(icon: AppIcon) = Unit
