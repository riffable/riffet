package riffet.core

import platform.Foundation.NSBundle

/** The localization the app bundle runs in; `en` or `en-…` reads as English, everything else as `zh-Hans`. */
internal actual fun platformUiLocale(): String {
    val preferred = NSBundle.mainBundle.preferredLocalizations.firstOrNull() as? String
    return if (preferred == "en" || preferred?.startsWith("en-") == true) "en" else "zh-Hans"
}
