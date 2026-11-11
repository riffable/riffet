package riffet.i18n

import java.util.Locale

/**
 * The `jvm()` target is a test host and the desktop client; it follows the JVM's default locale.
 * Chinese (any script) reads as `zh-Hans`; English as `en`; every other language keeps the source
 * locale.
 */
internal actual fun platformLocale(): String = when (Locale.getDefault().language) {
    "zh" -> "zh-Hans"
    "en" -> "en"
    else -> "zh-Hans"
}
