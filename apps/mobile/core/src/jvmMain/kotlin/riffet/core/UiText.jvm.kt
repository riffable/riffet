package riffet.core

import java.util.Locale

/** The JVM's default locale; Chinese reads as `zh-Hans`, English as `en`, anything else keeps the source locale. */
internal actual fun platformUiLocale(): String = when (Locale.getDefault().language) {
    "zh" -> "zh-Hans"
    "en" -> "en"
    else -> "zh-Hans"
}
