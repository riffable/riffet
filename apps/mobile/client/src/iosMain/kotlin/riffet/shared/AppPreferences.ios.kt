package riffet.shared

import platform.Foundation.NSUserDefaults

private class IosAppPreferences : AppPreferences {
    private val defaults get() = NSUserDefaults.standardUserDefaults

    override fun themeMode(): ThemeMode =
        ThemeMode.entries.firstOrNull { it.name == defaults.stringForKey(THEME_KEY) } ?: ThemeMode.SYSTEM

    override fun setThemeMode(mode: ThemeMode) = defaults.setObject(mode.name, forKey = THEME_KEY)
    override fun string(key: String): String? = defaults.stringForKey(PREFIX + key)
    override fun setString(key: String, value: String?) {
        if (value == null) defaults.removeObjectForKey(PREFIX + key)
        else defaults.setObject(value, forKey = PREFIX + key)
    }

    private companion object {
        const val THEME_KEY = "riffet.theme-mode"
        const val PREFIX = "riffet.pref."
    }
}

actual fun createAppPreferences(): AppPreferences = IosAppPreferences()
