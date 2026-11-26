package riffet.contracts

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

private val ThemeInterfaceStyles = setOf("riffet", "material3")

/** Styles the apps no longer have; a saved design may still carry their overrides, which are dropped on read. */
private val RetiredThemeInterfaceStyles = setOf("ios", "expressive", "miuix", "fluent")

/** Optional per-style design overrides, mirrored by packages/contracts/src/theme-design.ts. */
@Serializable(with = ThemeDesignSerializer::class)
data class ThemeDesign(
    val version: Int = 1,
    val tokens: ThemeDesignTokens? = null,
    val styles: Map<String, ThemeDesignTokens> = emptyMap(),
) {
    init {
        require(version == 1) { "design.version must be 1" }
        require(styles.keys.all { it in ThemeInterfaceStyles }) { "unknown design style" }
    }
}

@Serializable
data class ThemeDesignTokens(
    val typography: Map<String, ThemeTextStyle> = emptyMap(),
    val dimensions: Map<String, Double> = emptyMap(),
    val motion: Map<String, Double> = emptyMap(),
    val colors: ThemeDesignColors = ThemeDesignColors(),
    val variants: Map<String, String> = emptyMap(),
) {
    init { validate() }
    internal fun validate() {
        require(typography.keys.all { it in ThemeDesignLimits.textRoles }) { "unknown typography role" }
        typography.values.forEach { it.validate() }
        ThemeDesignLimits.checkNumbers(dimensions, ThemeDesignLimits.dimensions)
        ThemeDesignLimits.checkNumbers(motion, ThemeDesignLimits.motion)
        for ((lower, upper) in listOf("menuMinWidth" to "menuMaxWidth", "composerMinHeight" to "composerMaxHeight",
            "rowHeight" to "rowSubtitleHeight", "switchThumbSize" to "switchHeight", "switchHeight" to "switchWidth")) {
            val low = dimensions[lower]
            val high = dimensions[upper]
            require(low == null || high == null || low <= high) { "$lower must not exceed $upper" }
        }
        colors.validate()
        require(variants.all { (key, value) -> value in ThemeDesignLimits.variants[key].orEmpty() }) { "unknown design variant" }
    }
}

@Serializable
data class ThemeTextStyle(
    val size: Double? = null,
    val lineHeight: Double? = null,
    val weight: Int? = null,
    val letterSpacing: Double? = null,
    val family: String? = null,
) {
    init { validate() }
    internal fun validate() {
        require(size == null || size.isFinite() && size in 8.0..72.0) { "invalid text size" }
        require(lineHeight == null || lineHeight.isFinite() && lineHeight in 8.0..100.0) { "invalid line height" }
        require(weight == null || weight in 100..900) { "invalid font weight" }
        require(letterSpacing == null || letterSpacing.isFinite() && letterSpacing in -4.0..8.0) { "invalid letter spacing" }
        require(family == null || family in listOf("system", "sans", "serif", "mono")) { "unknown font family" }
        require(size == null || lineHeight == null || size <= lineHeight) { "size must not exceed lineHeight" }
    }
}

@Serializable
data class ThemeDesignColors(
    val light: Map<String, String> = emptyMap(),
    val dark: Map<String, String> = emptyMap(),
) {
    init { validate() }
    internal fun validate() {
        require(listOf(light, dark).all { mode ->
            mode.all { (key, value) -> key in ThemeDesignLimits.colorRoles && value.matches(ThemeDesignLimits.hex) }
        }) { "invalid design color" }
    }
}

/** Keep the outer wire forward compatible, but reject unknown/invalid keys inside this versioned schema. */
object ThemeDesignSerializer : KSerializer<ThemeDesign> {
    private val wire = ThemeDesignWire.serializer()
    private val strict = Json(RiffetJson.instance) { ignoreUnknownKeys = false }
    override val descriptor: SerialDescriptor = wire.descriptor
    override fun deserialize(decoder: Decoder): ThemeDesign {
        val json = decoder as? JsonDecoder ?: throw SerializationException("design must be JSON")
        val element = json.decodeJsonElement()
        checkPrimitives(element)
        val value = strict.decodeFromJsonElement(wire, element)
        value.tokens?.validate()
        value.styles.values.forEach { it.validate() }
        return ThemeDesign(value.version, value.tokens, value.styles.filterKeys { it !in RetiredThemeInterfaceStyles })
    }
    override fun serialize(encoder: Encoder, value: ThemeDesign) {
        require(value.version == 1 && value.styles.keys.all { it in ThemeInterfaceStyles })
        value.tokens?.validate()
        value.styles.values.forEach { it.validate() }
        encoder.encodeSerializableValue(wire, ThemeDesignWire(value.version, value.tokens, value.styles))
    }
    private fun checkPrimitives(element: JsonElement, numeric: Boolean = false) {
        if (element == JsonNull) throw SerializationException("design fields must be omitted rather than null")
        if (numeric && (element !is JsonPrimitive || element.isString)) throw SerializationException("design numbers must be JSON numbers")
        if (element is JsonObject) {
            for ((key, child) in element) {
                if (key == "dimensions" || key == "motion") {
                    if (child !is JsonObject) throw SerializationException("design numeric tokens must be objects")
                    child.values.forEach { checkPrimitives(it, numeric = true) }
                } else checkPrimitives(child, key in listOf("version", "size", "lineHeight", "weight", "letterSpacing"))
            }
        }
    }
}

@Serializable
private data class ThemeDesignWire(
    // Required on the wire, although programmatic constructors may use version = 1.
    val version: Int,
    val tokens: ThemeDesignTokens? = null,
    val styles: Map<String, ThemeDesignTokens> = emptyMap(),
)

private object ThemeDesignLimits {
    val textRoles = setOf("title", "body", "bodySmall", "label", "caption", "mono", "monoSmall", "largeTitle", "barTitle", "headline", "subhead", "footnote", "button", "buttonSmall", "input", "segmented", "menu", "dialogTitle", "dialogBody")
    val colorRoles = setOf("page", "groupedPage", "card", "floating", "press", "selected", "selectedContent", "disabledContent", "focus", "hairline", "shadow", "input", "navigation", "scrim", "primaryAction", "primaryActionContent", "secondaryAction", "secondaryActionContent", "switchThumb")
    val hex = Regex("^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")
    val dimensions = mapOf(
        "pageInset" to 0.0..128.0,
        "groupInset" to 0.0..128.0,
        "sectionGap" to 0.0..128.0,
        "rowPadding" to 0.0..128.0,
        "rowHeight" to 32.0..160.0,
        "rowSubtitleHeight" to 32.0..160.0,
        "iconSize" to 12.0..64.0,
        "smallIconSize" to 8.0..48.0,
        "iconSlot" to 16.0..80.0,
        "iconTileRadius" to 0.0..32.0,
        "controlHeight" to 48.0..160.0,
        "controlInset" to 0.0..128.0,
        "groupRadius" to 0.0..64.0,
        "menuRadius" to 0.0..64.0,
        "controlRadius" to 0.0..64.0,
        "rowRadius" to 0.0..64.0,
        "selectionRadius" to 0.0..64.0,
        "composerRadius" to 0.0..64.0,
        "barHeight" to 44.0..160.0,
        "tabBarHeight" to 44.0..160.0,
        "tabBarInset" to 0.0..128.0,
        "tabBarBottomInset" to 0.0..128.0,
        "drawerWidth" to 160.0..1024.0,
        "drawerMinGap" to 32.0..256.0,
        "menuMinWidth" to 120.0..1024.0,
        "menuMaxWidth" to 120.0..2048.0,
        "menuRowHeight" to 32.0..160.0,
        "menuGroupGap" to 0.0..128.0,
        "hairlineWidth" to 0.0..4.0,
        "focusWidth" to 0.0..8.0,
        "alertWidth" to 200.0..1024.0,
        "sheetMaxWidth" to 240.0..2048.0,
        "dialogInset" to 0.0..128.0,
        "inputMinHeight" to 44.0..512.0,
        "inputInset" to 0.0..128.0,
        "segmentedHeight" to 28.0..80.0,
        "switchWidth" to 32.0..100.0,
        "switchHeight" to 20.0..60.0,
        "switchThumbSize" to 12.0..56.0,
        "sliderTrackHeight" to 1.0..16.0,
        "sliderThumbSize" to 12.0..64.0,
        "sendButtonSize" to 24.0..80.0,
        "composerMinHeight" to 48.0..512.0,
        "composerMaxHeight" to 48.0..2048.0,
        "floatingShadowRadius" to 0.0..64.0,
        "floatingShadowLiftedRadius" to 0.0..96.0,
        "floatingShadowOffset" to -32.0..32.0,
        "floatingShadowSpread" to -32.0..32.0,
        "buttonIconSize" to 12.0..64.0,
        "contentMaxWidth" to 240.0..4096.0,
        "pageTitleGap" to 0.0..128.0,
    )
    val motion = mapOf(
        "short" to 0.0..2000.0,
        "medium" to 0.0..2000.0,
        "long" to 0.0..2000.0,
        "exit" to 0.0..2000.0,
        "pageEnter" to 0.0..2000.0,
        "pageExit" to 0.0..2000.0,
        "settleDamping" to 0.5..2.0,
        "settleStiffness" to 50.0..5000.0,
        "spatialDamping" to 0.5..2.0,
        "spatialStiffness" to 50.0..5000.0,
        "effectsStiffness" to 50.0..5000.0,
        "coveredPageShift" to 0.0..1.0,
        "coveredPageDim" to 0.0..1.0,
        "pressOpacity" to 0.1..1.0,
        "disabledOpacity" to 0.0..1.0,
        "floatingShadowOpacity" to 0.0..1.0,
        "popScale" to 0.0..1.0,
        "sharedAxisFraction" to 0.0..1.0,
    )
    val variants = mapOf(
        "settingsIcons" to setOf("plain", "tonal"),
        "navigation" to setOf("flat", "floating"),
        "homeTabs" to setOf("underline", "segmented"),
        "secondaryButtons" to setOf("plain", "tinted"),
    )
    fun checkNumbers(values: Map<String, Double>, bounds: Map<String, ClosedFloatingPointRange<Double>>) {
        require(values.all { (key, value) -> value.isFinite() && bounds[key]?.contains(value) == true }) { "unknown or out-of-range design number" }
    }
}
