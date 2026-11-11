package riffet.shared

import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

data class AppBuildInfo(val version: String, val build: String, val platform: String)
enum class NotificationAccess { ALLOWED, BLOCKED, UNSUPPORTED }

expect fun appBuildInfo(): AppBuildInfo
@Composable
expect fun rememberNotificationAccess(): NotificationAccess
expect fun openNotificationSettings()

/** The launcher icon variants `scripts/gen-brand.ts` generates, keyed by its ids; [BLUE] is the default. */
enum class AppIcon(val id: String, val accent: Color) {
    BLUE("blue", Color(0xFF5B8CFF)),
    PURPLE("purple", Color(0xFFA78BFA)),
    MAGENTA("magenta", Color(0xFFE879F9)),
    PINK("pink", Color(0xFFF472B6)),
    RED("red", Color(0xFFF87171)),
    ORANGE("orange", Color(0xFFF5A142)),
    YELLOW("yellow", Color(0xFFFACC15)),
    LIME("lime", Color(0xFFA3E635)),
    GREEN("green", Color(0xFF3FCF8E)),
    CYAN("cyan", Color(0xFF22D3EE)),
    GRAPHITE("graphite", Color(0xFF9AA0A8)),
    WHITE("white", Color(0xFFF4F4F2)),
}

expect val appIconSupported: Boolean
expect fun currentAppIcon(): AppIcon
expect fun setAppIcon(icon: AppIcon)
