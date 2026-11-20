package riffet.shared

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/**
 * The text size, on top of the system's own font scale. [key] is the stored id; the label is a
 * Compose resource resolved where it is shown, so the enum itself carries no interface copy.
 */
enum class TextSize(internal val key: String, val scale: Float) {
    SMALL("small", 0.9f),
    DEFAULT("default", 1f),
    LARGE("large", 1.1f),
    LARGER("larger", 1.2f),
}

/** How far apart the transcript's rows, paragraphs and edges sit. [key] is the stored id. */
enum class Spacing(internal val key: String, val scale: Float) {
    COMPACT("compact", 0.75f),
    DEFAULT("default", 1f),
    RELAXED("relaxed", 1.25f),
}

/** Stable renderer identifiers. Unknown/newer values fall back without destroying the saved id. */
enum class InterfaceStyle(val key: String) {
    /** The app's own style and the default (docs/design/system/android.md §10). */
    RIFFET("riffet"),
    MATERIAL3("material3"),
    EXPRESSIVE("expressive"),
    MIUIX("miuix"),
    FLUENT("fluent"),
    IOS("ios"),
}

/** Surface material is independent of layout/style and stored only on this device. */
enum class SurfaceMaterial(val key: String) {
    SOLID("solid"),
    FROSTED("frosted"),
    GLASS("glass"),
    LIQUID("liquid"),
}

/** One transition choice for every page and tab, stored only on this device. */
enum class PageAnimation(val key: String) {
    FADE("fade"),
    SLIDE("slide"),
    SCALE("scale"),
    NONE("none");

    companion object {
        val DEFAULT: PageAnimation = FADE
    }
}

/**
 * The reader's display choices, stored on this device like the theme. Reads are snapshot state, so a
 * change repaints every reader at once.
 */
@Stable
class DisplaySettings(private val preferences: AppPreferences?) {
    var pageAnimation: PageAnimation by mutableStateOf(
        PageAnimation.entries.firstOrNull { it.key == preferences?.string(PAGE_ANIMATION_KEY) } ?: PageAnimation.DEFAULT,
    )
        private set

    fun changePageAnimation(animation: PageAnimation) {
        preferences?.setString(PAGE_ANIMATION_KEY, animation.key)
        pageAnimation = animation
    }

    var surfaceMaterial: SurfaceMaterial by mutableStateOf(
        SurfaceMaterial.entries.firstOrNull { it.key == preferences?.string(SURFACE_MATERIAL_KEY) } ?: SurfaceMaterial.FROSTED,
    )
        private set

    var materialStrength: Float by mutableStateOf(
        preferences?.string(MATERIAL_STRENGTH_KEY)?.toFloatOrNull()?.takeIf { it.isFinite() }?.coerceIn(0f, 1f) ?: 0.5f,
    )
        private set

    fun changeSurfaceMaterial(material: SurfaceMaterial) {
        preferences?.setString(SURFACE_MATERIAL_KEY, material.key)
        surfaceMaterial = material
    }

    fun changeMaterialStrength(strength: Float) {
        if (!strength.isFinite()) return
        val normalized = strength.coerceIn(0f, 1f)
        preferences?.setString(MATERIAL_STRENGTH_KEY, normalized.toString())
        materialStrength = normalized
    }

    var amoled: Boolean by mutableStateOf(preferences?.string(AMOLED_KEY) == "true")
        private set

    fun changeAmoled(enabled: Boolean) {
        preferences?.setString(AMOLED_KEY, enabled.toString())
        amoled = enabled
    }

    var codeTheme: String by mutableStateOf(preferences?.string(CODE_THEME_KEY) ?: "auto")
        private set

    fun changeCodeTheme(id: String) {
        preferences?.setString(CODE_THEME_KEY, id)
        codeTheme = id
    }
    var interfaceStyle: InterfaceStyle by mutableStateOf(
        InterfaceStyle.entries.firstOrNull { it.key == preferences?.string(INTERFACE_STYLE_KEY) } ?: InterfaceStyle.RIFFET,
    )
        private set

    fun changeInterfaceStyle(style: InterfaceStyle) {
        preferences?.setString(INTERFACE_STYLE_KEY, style.key)
        interfaceStyle = style
    }

    var textSize: TextSize by mutableStateOf(
        preferences?.string(TEXT_SIZE_KEY)?.let { key -> TextSize.entries.firstOrNull { it.key == key } } ?: TextSize.DEFAULT,
    )
        private set

    var spacing: Spacing by mutableStateOf(
        preferences?.string(SPACING_KEY)?.let { key -> Spacing.entries.firstOrNull { it.key == key } } ?: Spacing.DEFAULT,
    )
        private set

    fun changeTextSize(size: TextSize) {
        textSize = size
        preferences?.setString(TEXT_SIZE_KEY, size.key)
    }

    fun changeSpacing(value: Spacing) {
        spacing = value
        preferences?.setString(SPACING_KEY, value.key)
    }

    /** The tab a launch opens (`HomeTab.key`); 新会话 until chosen. */
    var launchTab: String by mutableStateOf(preferences?.string(LAUNCH_TAB_KEY) ?: "new")
        private set

    fun changeLaunchTab(key: String) {
        preferences?.setString(LAUNCH_TAB_KEY, key)
        launchTab = key
    }

    companion object {
        internal const val LAUNCH_TAB_KEY = "display.launch-tab"
        internal const val PAGE_ANIMATION_KEY = "display.page-animation"
        internal const val INTERFACE_STYLE_KEY = "display.interface-style"
        internal const val SURFACE_MATERIAL_KEY = "display.surface-material"
        internal const val MATERIAL_STRENGTH_KEY = "display.material-strength"
        private const val AMOLED_KEY = "display.amoled"
        private const val CODE_THEME_KEY = "display.code-theme"
        private const val TEXT_SIZE_KEY = "display.text-size"
        private const val SPACING_KEY = "display.spacing"

        /**
         * What the transcript's spacing tokens read. They are plain getters used outside composition
         * too (the layout pass), so they cannot take a composition local; previews and tests keep
         * this unsaved default.
         */
        internal var active: DisplaySettings = DisplaySettings(null)
            private set

        /** The device's settings; the first read also makes them [active]. */
        val shared: DisplaySettings by lazy { DisplaySettings(createAppPreferences()).also { active = it } }
    }
}
