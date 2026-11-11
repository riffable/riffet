package riffet.shared

/*
 * Local UI preferences, separate from [DeviceTokenStore] on purpose.
 *
 * `DeviceTokenStore` is the paired-device credential: its token is sealed with a platform key and
 * kept out of backups, and its `clear()` is called when this device forgets a server. Appearance has nothing to do with a
 * server; storing it there would reset the reader's theme on every re-pair and blur a security
 * boundary ("what is a credential") with a cosmetic one. It is also not server state — the web
 * stores this per browser — so it must not become a settings API round trip.
 *
 * Declared as an interface plus an `expect` factory, like `Platform.kt`, because the Android
 * implementation needs a `Context` that must stay out of the common signature.
 */

/** Follow the OS, or force one appearance. Mirrors the web's `ThemeMode`. */
enum class ThemeMode {
    SYSTEM,
    LIGHT,
    DARK,
}

/**
 * One built-in palette's metadata. The id is the same string the web stores and the stylesheet keys
 * its blocks on (`[data-theme="<id>"]`), and the same one `riffet.theme.riffetTheme` resolves — so a
 * theme picked on either client means the same palette.
 *
 * This enum is *not* the selection type: the stored preference is a plain string, because the
 * picker also offers themes that arrive from the server's shared library and cannot be enumerated
 * here. The enum only supplies the built-ins' order and names, beside the generated colours
 * (`RiffetThemes`); their descriptions are Compose resources resolved by the picker.
 */
enum class ThemeId(val id: String, val label: String) {
    RIFFET("riffet", "Riffet"),
    SOLARIZED("solarized", "Solarized"),
    CATPPUCCIN("catppuccin", "Catppuccin"),
    ROSE_PINE("rose-pine", "Rosé Pine"),
    EVERFOREST("everforest", "Everforest"),
    KILN("kiln", "Kiln"),
    INK("ink", "Ink"),
    SEPIA("sepia", "Sepia"),
    MOSS("moss", "Moss"),
    SLATE("slate", "Slate"),
    PENCIL("pencil", "Pencil"),
    CELADON("celadon", "Celadon");

    companion object {
        val DEFAULT = RIFFET

        /** Stored ids that predate a rename keep the reader's choice; unknown ids are left alone. */
        fun stored(id: String?): String = when (id) {
            null -> DEFAULT.id
            "claude" -> KILN.id
            else -> id
        }
    }
}

/**
 * Persists a small set of UI preferences across launches. Deliberately synchronous: the value is
 * read before the first frame so a launch never flashes the wrong theme, which is the whole point
 * of remembering it.
 */
interface AppPreferences {
    fun themeMode(): ThemeMode
    fun setThemeMode(mode: ThemeMode)

    /** A plain string slot; `null` removes the key. */
    fun string(key: String): String?
    fun setString(key: String, value: String?)
}

/** The web's `KEYS.project` / `KEYS.session`: the workbench reopens where the reader left it. */
object PreferenceKeys {
    const val PROJECT = "last-project"
    const val SESSION = "last-session"
    const val SIDEBAR_LAYOUT = "sidebar-layout"
    /** Stored through the generic [AppPreferences.string] slot rather than a typed accessor: the
     *  id is opaque to the platform layer and an unknown value must degrade, not throw. */
    const val THEME_ID = "theme-id"
    /** The phones the last new conversation was given; device ids belong to one server, so this key is per server. */
    const val TOOL_GROUPS = "tool-groups-last"
}

expect fun createAppPreferences(): AppPreferences
