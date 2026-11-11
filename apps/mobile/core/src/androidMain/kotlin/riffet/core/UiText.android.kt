package riffet.core

import java.util.Locale

/** The app's process locale; synchronized by the Android host, with Chinese as the fallback. */
internal actual fun platformUiLocale(): String = when (Locale.getDefault().language) {
    "zh" -> "zh-Hans"
    "en" -> "en"
    else -> "zh-Hans"
}
