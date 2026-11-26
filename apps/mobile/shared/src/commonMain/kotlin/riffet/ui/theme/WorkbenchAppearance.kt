package riffet.ui.theme

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import riffet.contracts.DeviceCall
import riffet.contracts.DeviceCallOutcome
import riffet.contracts.DeviceErrorCode
import riffet.shared.AppPreferences
import riffet.shared.DisplaySettings
import riffet.shared.InterfaceStyle
import riffet.shared.PreferenceKeys
import riffet.shared.RiffetApi
import riffet.shared.ThemeId
import riffet.shared.ThemeMode

/** The device channel may change preferences only through its own mounted Riffet workbench. */
class WorkbenchAppearance(
    private val availabilityChanged: () -> Unit,
    private val canUse: (RiffetApi) -> Boolean,
) {
    private class Target(val api: RiffetApi, val apply: (JsonObject) -> DeviceCallOutcome)
    private var target: Target? = null

    private val activeTarget: Target? get() = target?.takeIf { canUse(it.api) }
    val available: Boolean get() = activeTarget != null

    internal fun bind(api: RiffetApi, apply: (JsonObject) -> DeviceCallOutcome): () -> Unit {
        val connected = Target(api, apply)
        target = connected
        availabilityChanged()
        return {
            if (target === connected) {
                target = null
                availabilityChanged()
            }
        }
    }

    fun execute(call: DeviceCall, api: RiffetApi): DeviceCallOutcome {
        val active = activeTarget
        if (active == null || active.api !== api) {
            return DeviceCallOutcome.failure(DeviceErrorCode.CAPABILITY_MISSING, "This paired Riffet workbench is unavailable")
        }
        return active.apply(call.args)
    }
}

internal fun applyWorkbenchAppearance(
    arguments: JsonObject,
    preferences: AppPreferences,
    themes: List<ThemeEntry>,
    resources: AppearanceResourcesState?,
    onTheme: (String) -> Unit,
    onMode: (ThemeMode) -> Unit,
): DeviceCallOutcome {
    fun invalid() = DeviceCallOutcome.failure(DeviceErrorCode.FAILED, "Choose a theme or style supported by this Riffet workbench")
    fun value(key: String): String? = (arguments[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
    if (arguments.keys.any { it !in setOf("themeId", "mode", "interfaceStyle") }) return invalid()
    val theme = if ("themeId" in arguments) themes.firstOrNull { it.id == value("themeId") } ?: return invalid() else null
    val mode = if ("mode" in arguments) ThemeMode.entries.firstOrNull { it.name.lowercase() == value("mode") } ?: return invalid() else null
    val style = if ("interfaceStyle" in arguments) InterfaceStyle.entries.firstOrNull { it.key == value("interfaceStyle") } ?: return invalid() else null
    theme?.let { onTheme(it.id) }
    mode?.let(onMode)
    style?.let(DisplaySettings.shared::changeInterfaceStyle)

    val savedTheme = ThemeId.stored(preferences.string(PreferenceKeys.THEME_ID))
    val savedMode = preferences.themeMode()
    val savedStyle = InterfaceStyle.entries.firstOrNull { it.key == preferences.string(DisplaySettings.INTERFACE_STYLE_KEY) } ?: InterfaceStyle.RIFFET
    if ((theme != null && (savedTheme != theme.id || resources?.effective?.palette != null))
        || (mode != null && savedMode != mode) || (style != null && savedStyle != style)
    ) return DeviceCallOutcome.failure(DeviceErrorCode.FAILED, "The Riffet appearance preferences could not be read back")

    return DeviceCallOutcome.success(buildJsonObject {
        put("themeId", savedTheme)
        put("mode", savedMode.name.lowercase())
        put("interfaceStyle", savedStyle.key)
        val displayed = resources?.palette?.id?.takeIf { resources.effective.palette != null }
            ?: themes.firstOrNull { it.id == savedTheme }?.id ?: ThemeId.DEFAULT.id
        if (displayed != savedTheme) put("activePaletteId", displayed)
        putJsonArray("themes") {
            for (entry in themes) addJsonObject { put("id", entry.id); put("name", entry.name) }
        }
        putJsonArray("interfaceStyles") {
            for (entry in InterfaceStyle.entries) addJsonObject {
                put("id", entry.key)
                put("name", when (entry) {
                    InterfaceStyle.RIFFET -> "Riffet"
                    InterfaceStyle.MATERIAL3 -> "Material 3"
                })
            }
        }
    })
}
