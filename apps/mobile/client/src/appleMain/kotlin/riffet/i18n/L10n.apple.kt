package riffet.i18n

import platform.Foundation.NSBundle

/**
 * The localization the app bundle runs in, which the app's own language setting decides. The macOS
 * app restarts on a switch; on iOS the bundle's preferred localizations change with the app
 * language, so each call reads the current value.
 */
internal actual fun platformLocale(): String {
    val preferred = NSBundle.mainBundle.preferredLocalizations.firstOrNull() as? String
    return if (preferred == "en" || preferred?.startsWith("en-") == true) "en" else "zh-Hans"
}
