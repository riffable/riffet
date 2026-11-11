package riffet.shared

/*
 * The `jvm()` target is a test host, not a product; an in-memory preference is the same shape as
 * `Platform.jvm.kt`'s token store and lets a JVM test drive the theme state.
 */

private class JvmAppPreferences : AppPreferences {
    private var mode: ThemeMode = ThemeMode.SYSTEM

    override fun themeMode(): ThemeMode = mode

    override fun setThemeMode(mode: ThemeMode) {
        this.mode = mode
    }

    private val strings = mutableMapOf<String, String>()

    override fun string(key: String): String? = strings[key]

    override fun setString(key: String, value: String?) {
        if (value == null) strings.remove(key) else strings[key] = value
    }
}

actual fun createAppPreferences(): AppPreferences = JvmAppPreferences()
