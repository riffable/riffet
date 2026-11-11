package riffet.i18n

import java.util.Locale

/**
 * The process locale, synchronized with the app's language choice by the Android host. Chinese reads as
 * `zh-Hans`; English as `en`; every other language keeps the source locale.
 */
internal actual fun platformLocale(): String = when (Locale.getDefault().language) {
    "zh" -> "zh-Hans"
    "en" -> "en"
    else -> "zh-Hans"
}
