package riffet.theme

import androidx.compose.ui.graphics.Color

/**
 * Reads the hex colours the theme library stores: `#rrggbb`, or `#rrggbbaa` in CSS byte order.
 *
 * Compose packs a colour as ARGB, so the alpha byte moves to the front here rather than at every
 * call site. Anything unreadable returns null — a custom theme with one broken colour falls back to
 * the default theme instead of painting a half-empty interface.
 */
internal object RiffetColorParsing {
    fun parse(value: String?): Color? {
        val hex = value?.trim()?.removePrefix("#") ?: return null
        if (hex.length != 6 && hex.length != 8) return null
        val digits = hex.toLongOrNull(16) ?: return null
        if (hex.length == 6) return Color((0xFF000000L or digits).toInt())
        val alpha = (digits and 0xFF).toInt()
        val rgb = (digits ushr 8).toInt()
        return Color((alpha shl 24) or rgb)
    }
}
