package riffet.shared

import android.content.Context

/*
 * The Android side of [AppPreferences].
 *
 * A separate `SharedPreferences` file from the device-token store: this holds no credential, so it
 * does not share (and cannot be wiped by) the token store's `clear()`. `MODE_PRIVATE` is the whole
 * requirement — a theme choice is not a secret.
 */

private const val PREFERENCES_FILE = "riffet.preferences"
private const val THEME_KEY = "theme-mode"

private class AndroidAppPreferences(private val context: Context) : AppPreferences {
    private val preferences get() = context.getSharedPreferences(PREFERENCES_FILE, Context.MODE_PRIVATE)

    override fun themeMode(): ThemeMode {
        val stored = preferences.getString(THEME_KEY, null) ?: return ThemeMode.SYSTEM
        // A value written by a newer build must not crash an older one; fall back to the OS choice.
        return ThemeMode.entries.firstOrNull { it.name == stored } ?: ThemeMode.SYSTEM
    }

    override fun setThemeMode(mode: ThemeMode) {
        preferences.edit().putString(THEME_KEY, mode.name).apply()
    }

    override fun string(key: String): String? = preferences.getString(key, null)

    override fun setString(key: String, value: String?) {
        preferences.edit().apply { if (value == null) remove(key) else putString(key, value) }.apply()
    }
}

actual fun createAppPreferences(): AppPreferences = AndroidAppPreferences(RiffetAndroid.requireContext())
