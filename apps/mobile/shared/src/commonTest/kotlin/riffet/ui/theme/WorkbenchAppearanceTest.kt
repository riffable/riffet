package riffet.ui.theme

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import riffet.contracts.DeviceCall
import riffet.contracts.DeviceCallOutcome
import riffet.contracts.DeviceCapability
import riffet.shared.AppPreferences
import riffet.shared.PreferenceKeys
import riffet.shared.ThemeMode
import riffet.shared.RiffetApi
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class WorkbenchAppearanceTest {
    @Test
    fun requiresTheCurrentForegroundPairingAtExecution() {
        val client = HttpClient(MockEngine { error("Appearance is local") })
        try {
            val original = RiffetApi(client, "http://127.0.0.1:9")
            val replacement = RiffetApi(client, original.baseUrl)
            var foreground = true
            var selected = original
            var applied = 0
            val appearance = WorkbenchAppearance({}) { api -> foreground && api === selected }
            appearance.bind(original) { applied++; DeviceCallOutcome.success() }
            val call = DeviceCall("call", "session", DeviceCapability.RIFFET_APPEARANCE, deadline = "", createdAt = "")

            assertTrue(appearance.execute(call, original).ok)
            foreground = false
            assertFalse(appearance.available)
            assertFalse(appearance.execute(call, original).ok)
            foreground = true
            selected = replacement
            assertFalse(appearance.available)
            assertFalse(appearance.execute(call, original).ok)
            assertFalse(appearance.execute(call, replacement).ok)
            assertEquals(1, applied)
        } finally {
            client.close()
        }
    }

    @Test
    fun validatesEveryFieldBeforeWritingAndRetainsUnspecifiedPreferences() {
        val preferences = object : AppPreferences {
            var mode = ThemeMode.DARK
            val storage = mutableMapOf(PreferenceKeys.THEME_ID to "riffet")

            override fun themeMode() = mode
            override fun setThemeMode(mode: ThemeMode) { this.mode = mode }
            override fun string(key: String) = storage[key]
            override fun setString(key: String, value: String?) {
                if (value == null) storage.remove(key) else storage[key] = value
            }
        }
        val invalid = buildJsonObject { put("themeId", "solarized"); put("mode", "unsupported") }
        val rejected = applyWorkbenchAppearance(
            invalid, preferences, builtinThemeEntries, null,
            { id -> preferences.setString(PreferenceKeys.THEME_ID, id) }, preferences::setThemeMode,
        )
        assertFalse(rejected.ok)
        assertEquals("riffet", preferences.string(PreferenceKeys.THEME_ID))
        val changed = applyWorkbenchAppearance(
            buildJsonObject { put("themeId", "solarized") }, preferences, builtinThemeEntries, null,
            { id -> preferences.setString(PreferenceKeys.THEME_ID, id) }, preferences::setThemeMode,
        )
        assertTrue(changed.ok)
        assertEquals("solarized", preferences.string(PreferenceKeys.THEME_ID))
        assertEquals(ThemeMode.DARK, preferences.themeMode())
    }
}
