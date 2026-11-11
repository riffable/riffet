package riffet.ui.design

import androidx.compose.runtime.Immutable
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import riffet.contracts.ThemeDesign
import riffet.contracts.ThemeTextStyle
import riffet.shared.InterfaceStyle

/** Resolved dimensions are device-independent; minimum hit regions stay accessible. */
@Immutable
internal class DesignMetrics internal constructor(private val values: Map<String, Double>, private val overrides: Set<String> = emptySet()) {
    /** Native components keep their own scale unless the theme explicitly replaces a role. */
    fun isOverridden(key: String): Boolean = key in overrides
    val pageInset: Dp get() = values.getValue("pageInset").toFloat().dp
    val groupInset: Dp get() = values.getValue("groupInset").toFloat().dp
    val sectionGap: Dp get() = values.getValue("sectionGap").toFloat().dp
    val rowPadding: Dp get() = values.getValue("rowPadding").toFloat().dp
    val rowHeight: Dp get() = values.getValue("rowHeight").toFloat().dp
    val rowSubtitleHeight: Dp get() = values.getValue("rowSubtitleHeight").toFloat().dp
    val iconSize: Dp get() = values.getValue("iconSize").toFloat().dp
    val smallIconSize: Dp get() = values.getValue("smallIconSize").toFloat().dp
    val iconSlot: Dp get() = values.getValue("iconSlot").toFloat().dp
    val iconTileRadius: Dp get() = values.getValue("iconTileRadius").toFloat().dp
    val controlHeight: Dp get() = values.getValue("controlHeight").toFloat().dp
    val buttonHeight: Dp get() = (controlHeight - 8.dp).coerceAtLeast(32.dp)
    val inlineControlHeight: Dp get() = (controlHeight - 16.dp).coerceAtLeast(28.dp)
    val controlInset: Dp get() = values.getValue("controlInset").toFloat().dp
    val groupRadius: Dp get() = values.getValue("groupRadius").toFloat().dp
    val menuRadius: Dp get() = values.getValue("menuRadius").toFloat().dp
    val controlRadius: Dp get() = values.getValue("controlRadius").toFloat().dp
    val rowRadius: Dp get() = values.getValue("rowRadius").toFloat().dp
    val selectionRadius: Dp get() = values.getValue("selectionRadius").toFloat().dp
    val composerRadius: Dp get() = values.getValue("composerRadius").toFloat().dp
    val barHeight: Dp get() = values.getValue("barHeight").toFloat().dp
    val tabBarHeight: Dp get() = values.getValue("tabBarHeight").toFloat().dp
    val tabBarInset: Dp get() = values.getValue("tabBarInset").toFloat().dp
    val tabBarBottomInset: Dp get() = values.getValue("tabBarBottomInset").toFloat().dp
    val drawerWidth: Dp get() = values.getValue("drawerWidth").toFloat().dp
    val drawerMinGap: Dp get() = values.getValue("drawerMinGap").toFloat().dp
    val menuMinWidth: Dp get() = values.getValue("menuMinWidth").toFloat().dp
    val menuMaxWidth: Dp get() = values.getValue("menuMaxWidth").toFloat().dp
    val menuRowHeight: Dp get() = values.getValue("menuRowHeight").toFloat().dp
    val menuGroupGap: Dp get() = values.getValue("menuGroupGap").toFloat().dp
    val hairlineWidth: Dp get() = values.getValue("hairlineWidth").toFloat().dp
    val focusWidth: Dp get() = values.getValue("focusWidth").toFloat().dp
    val alertWidth: Dp get() = values.getValue("alertWidth").toFloat().dp
    val sheetMaxWidth: Dp get() = values.getValue("sheetMaxWidth").toFloat().dp
    val dialogInset: Dp get() = values.getValue("dialogInset").toFloat().dp
    val inputMinHeight: Dp get() = values.getValue("inputMinHeight").toFloat().dp
    val inputInset: Dp get() = values.getValue("inputInset").toFloat().dp
    val segmentedHeight: Dp get() = values.getValue("segmentedHeight").toFloat().dp
    val switchWidth: Dp get() = values.getValue("switchWidth").toFloat().dp
    val switchHeight: Dp get() = values.getValue("switchHeight").toFloat().dp
    val switchThumbSize: Dp get() = values.getValue("switchThumbSize").toFloat().dp
    val sliderTrackHeight: Dp get() = values.getValue("sliderTrackHeight").toFloat().dp
    val sliderThumbSize: Dp get() = values.getValue("sliderThumbSize").toFloat().dp
    val sendButtonSize: Dp get() = values.getValue("sendButtonSize").toFloat().dp
    val composerMinHeight: Dp get() = values.getValue("composerMinHeight").toFloat().dp
    val composerMaxHeight: Dp get() = values.getValue("composerMaxHeight").toFloat().dp
    val floatingShadowRadius: Dp get() = values.getValue("floatingShadowRadius").toFloat().dp
    val floatingShadowLiftedRadius: Dp get() = values.getValue("floatingShadowLiftedRadius").toFloat().dp
    val floatingShadowOffset: Dp get() = values.getValue("floatingShadowOffset").toFloat().dp
    val floatingShadowSpread: Dp get() = values.getValue("floatingShadowSpread").toFloat().dp
    val buttonIconSize: Dp get() = values.getValue("buttonIconSize").toFloat().dp
    val contentMaxWidth: Dp get() = values.getValue("contentMaxWidth").toFloat().dp
    val pageTitleGap: Dp get() = values.getValue("pageTitleGap").toFloat().dp
}
internal enum class SettingsIconPresentation(val key: String) { PLAIN("plain"), TONAL("tonal") }
internal enum class NavigationPresentation(val key: String) { FLAT("flat"), FLOATING("floating") }
internal enum class HomeTabPresentation(val key: String) { UNDERLINE("underline"), SEGMENTED("segmented") }
internal enum class SecondaryButtonPresentation(val key: String) { PLAIN("plain"), TONAL("tinted") }

@Immutable
internal data class DesignVariants(
    val settingsIcons: SettingsIconPresentation,
    val navigation: NavigationPresentation,
    val homeTabs: HomeTabPresentation,
    val secondaryButtons: SecondaryButtonPresentation,
)
internal data class ResolvedDesign(
    val metrics: DesignMetrics, val variants: DesignVariants, val preset: ThemePreset,
    val typography: Map<String, ThemeTextStyle>, val colors: Map<String, String>, val motion: Map<String, Double>,
)
/** Per-composition resolution. No process-global mutable theme or style. */
internal fun resolveDesign(style: InterfaceStyle, design: ThemeDesign?, dark: Boolean): ResolvedDesign {
    val preset = themePreset(style)
    val layers = if (design?.version == 1) listOfNotNull(design.tokens, design.styles[style.key]) else emptyList()
    val dimensions = (BaseDesignDimensions + preset.dimensions).toMutableMap()
    val typography = mutableMapOf<String, ThemeTextStyle>()
    val colors = mutableMapOf<String, String>()
    val motion = preset.motion.toMutableMap()
    var variants = preset.variants
    for (layer in layers) {
        layer.dimensions.forEach { (key, value) ->
            if (key in dimensions && value.isFinite()) dimensions[key] = value
        }
        layer.typography.forEach { (role, next) ->
            val previous = typography[role]
            typography[role] = ThemeTextStyle(
                size = next.size ?: previous?.size,
                lineHeight = (next.lineHeight ?: previous?.lineHeight)?.coerceAtLeast(next.size ?: previous?.size ?: 8.0),
                weight = next.weight ?: previous?.weight, letterSpacing = next.letterSpacing ?: previous?.letterSpacing,
                family = next.family ?: previous?.family,
            )
        }
        colors.putAll(if (dark) layer.colors.dark else layer.colors.light)
        motion.putAll(layer.motion.filterValues { it.isFinite() })
        // Wire values enter the typed render model here; unknown keys/values retain the prior layer.
        layer.variants.forEach { (key, value) ->
            variants = when (key) {
                "settingsIcons" -> SettingsIconPresentation.entries.firstOrNull { it.key == value }
                    ?.let { variants.copy(settingsIcons = it) } ?: variants
                "navigation" -> NavigationPresentation.entries.firstOrNull { it.key == value }
                    ?.let { variants.copy(navigation = it) } ?: variants
                "homeTabs" -> HomeTabPresentation.entries.firstOrNull { it.key == value }
                    ?.let { variants.copy(homeTabs = it) } ?: variants
                "secondaryButtons" -> SecondaryButtonPresentation.entries.firstOrNull { it.key == value }
                    ?.let { variants.copy(secondaryButtons = it) } ?: variants
                else -> variants
            }
        }
    }
    dimensions["controlHeight"] = dimensions.getValue("controlHeight").coerceAtLeast(48.0)
    dimensions["menuRowHeight"] = maxOf(dimensions.getValue("menuRowHeight"), dimensions.getValue("controlHeight"))
    dimensions["rowHeight"] = maxOf(dimensions.getValue("rowHeight"), dimensions.getValue("controlHeight"))
    dimensions["rowSubtitleHeight"] = maxOf(dimensions.getValue("rowSubtitleHeight"), dimensions.getValue("rowHeight"))
    dimensions["inputMinHeight"] = maxOf(dimensions.getValue("inputMinHeight"), dimensions.getValue("controlHeight"))
    dimensions["menuMaxWidth"] = dimensions.getValue("menuMaxWidth").coerceAtLeast(dimensions.getValue("menuMinWidth"))
    dimensions["composerMaxHeight"] = dimensions.getValue("composerMaxHeight").coerceAtLeast(dimensions.getValue("composerMinHeight"))
    dimensions["switchHeight"] = dimensions.getValue("switchHeight").coerceAtLeast(12.0)
    dimensions["switchWidth"] = dimensions.getValue("switchWidth").coerceAtLeast(dimensions.getValue("switchHeight"))
    dimensions["switchThumbSize"] = dimensions.getValue("switchThumbSize").coerceIn(8.0, dimensions.getValue("switchHeight") - 4.0)
    return ResolvedDesign(DesignMetrics(dimensions.toMap(), layers.flatMap { it.dimensions.keys }.toSet()),
        variants, preset, typography.toMap(), colors.toMap(), motion.toMap())
}
