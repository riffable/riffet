package riffet.shared

import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.snapshots.Snapshot
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import riffet.contracts.*
import riffet.ui.theme.*

@OptIn(ExperimentalCoroutinesApi::class)
class DisplaySettingsTest {
    @Test
    fun appearanceSelectionPreservesUnavailableReferencesAndIsolatesAccounts() {
        val preferences = MemoryPreferences(mutableMapOf())
        val state = AppearanceResourcesState(preferences, "appearance.selection|account-a")
        val asset = AppearanceAsset("/api/appearance/assets/riffet.paper/" + "a".repeat(64), "a".repeat(64), 1, "image/png")
        val background = AppearanceBackground("riffet.paper/paper", "riffet.paper", mapOf("en" to "Paper"), asset, listOf("workbench"))
        val catalog = AppearanceCatalog(1, "revision", backgrounds = listOf(background),
            presets = listOf(AppearancePreset("riffet.paper/preset", "riffet.paper", emptyMap(), background = background.id)))
        state.select(AppearanceSlot.PRESET, "riffet.paper/preset")
        assertEquals(background, catalog.resolve(state.selection).background)
        state.select(AppearanceSlot.BACKGROUND, "default")
        assertEquals(null, catalog.resolve(state.selection).background)
        state.select(AppearanceSlot.BACKGROUND, background.id)
        val restored = AppearanceResourcesState(preferences, "appearance.selection|account-a")
        assertEquals(null, catalog.copy(backgrounds = emptyList()).resolve(restored.selection).background)
        assertEquals(background.id, restored.selection.background)
        assertEquals(background, catalog.resolve(restored.selection).background)
        assertEquals(AppearanceSelection(), AppearanceResourcesState(preferences, "appearance.selection|account-b").selection)
        restored.select(AppearanceSlot.PRESET, "default")
        assertEquals(AppearanceSelection(), AppearanceResourcesState(preferences, "appearance.selection|account-a").selection)
    }

    @Test
    fun compressedFontPreflightRejectsOversizedOutputBeforeNativeAllocation() {
        val header = ByteArray(50)
        fun u32(offset: Int, value: Long) { for (i in 0..3) header[offset + i] = (value shr (24 - i * 8)).toByte() }
        u32(0, 0x774F4632L); u32(4, 0x00010000L); u32(8, header.size.toLong())
        header[13] = 1; u32(16, APPEARANCE_MAX_EXPANDED_FONT_BYTES + 1); u32(20, 1)
        header[48] = 0; header[49] = 1
        assertFailsWith<IllegalArgumentException> { validateWoff2(header) }
        assertFailsWith<IllegalArgumentException> { validateWoff2(ByteArray(0)) }
    }
    @Test
    fun styleAndPageAnimationChangesAreObservablePersistedAndIndependentOfOtherPreferences() = runTest {
        val stored = mutableMapOf("theme-id" to "catppuccin", "display.text-size" to "large", "icon-pack" to "tabler")
        val preferences = MemoryPreferences(stored)
        val settings = DisplaySettings(preferences)
        assertEquals(PageAnimation.FADE, settings.pageAnimation)
        val observed = mutableListOf<InterfaceStyle>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            snapshotFlow { settings.interfaceStyle }.collect { observed.add(it) }
        }
        settings.changeInterfaceStyle(InterfaceStyle.IOS)
        Snapshot.sendApplyNotifications()
        runCurrent()
        assertEquals(listOf(InterfaceStyle.MATERIAL3, InterfaceStyle.IOS), observed)
        assertEquals(InterfaceStyle.IOS, DisplaySettings(preferences).interfaceStyle)
        assertEquals(TextSize.LARGE, DisplaySettings(preferences).textSize)
        assertEquals(mapOf("theme-id" to "catppuccin", "display.text-size" to "large", "icon-pack" to "tabler", DisplaySettings.INTERFACE_STYLE_KEY to "ios"), stored)
        val observedAnimations = mutableListOf<PageAnimation>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            snapshotFlow { settings.pageAnimation }.collect { observedAnimations.add(it) }
        }
        for (animation in PageAnimation.entries) {
            settings.changePageAnimation(animation)
            Snapshot.sendApplyNotifications()
            runCurrent()
            assertEquals(animation, DisplaySettings(preferences).pageAnimation)
            assertEquals(animation.key, stored[DisplaySettings.PAGE_ANIMATION_KEY])
            assertEquals(InterfaceStyle.IOS, DisplaySettings(preferences).interfaceStyle)
        }
        assertEquals(PageAnimation.entries.toList(), observedAnimations)
        settings.changeAmoled(true)
        for (style in listOf(InterfaceStyle.EXPRESSIVE, InterfaceStyle.MIUIX, InterfaceStyle.FLUENT)) {
            settings.changeInterfaceStyle(style)
            val restored = DisplaySettings(preferences)
            assertEquals(style, restored.interfaceStyle)
            assertEquals(PageAnimation.NONE, restored.pageAnimation)
            assertEquals(true, restored.amoled)
            assertEquals(TextSize.LARGE, restored.textSize)
            assertEquals("catppuccin", stored["theme-id"])
            assertEquals("tabler", stored["icon-pack"])
        }
    }

    @Test
    fun materialPreferencesArePersistedWithoutChangingStylePaletteOrIcons() = runTest {
        val stored = mutableMapOf(
            "theme-id" to "catppuccin", "icon-pack" to "tabler", "display.text-size" to "large",
            DisplaySettings.INTERFACE_STYLE_KEY to "miuix", "display.amoled" to "true",
        )
        val preferences = MemoryPreferences(stored)
        val settings = DisplaySettings(preferences)
        val observed = mutableListOf<SurfaceMaterial>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            snapshotFlow { settings.surfaceMaterial }.collect { observed.add(it) }
        }
        settings.changeMaterialStrength(0.8f)
        for (material in SurfaceMaterial.entries) {
            settings.changeSurfaceMaterial(material)
            Snapshot.sendApplyNotifications()
            runCurrent()
            val restored = DisplaySettings(preferences)
            assertEquals(material, restored.surfaceMaterial)
            assertEquals(0.8f, restored.materialStrength)
            assertEquals(InterfaceStyle.MIUIX, restored.interfaceStyle)
            assertEquals(true, restored.amoled)
            assertEquals(TextSize.LARGE, restored.textSize)
            assertEquals("catppuccin", stored["theme-id"])
            assertEquals("tabler", stored["icon-pack"])
        }
        assertEquals(listOf(SurfaceMaterial.FROSTED) + SurfaceMaterial.entries, observed)
        settings.changeMaterialStrength(2f)
        assertEquals(1f, DisplaySettings(preferences).materialStrength)
        val saved = stored.toMap()
        settings.changeMaterialStrength(Float.NaN)
        settings.changeMaterialStrength(Float.NEGATIVE_INFINITY)
        assertEquals(saved, stored)
        assertEquals(1f, settings.materialStrength)
    }

    @Test
    fun anUnknownStyleFallsBackWithoutErasingItsStoredValueUntilTheUserChooses() {
        val stored = mutableMapOf(
            DisplaySettings.INTERFACE_STYLE_KEY to "future-style",
            DisplaySettings.SURFACE_MATERIAL_KEY to "future-material",
            DisplaySettings.MATERIAL_STRENGTH_KEY to "NaN",
            DisplaySettings.PAGE_ANIMATION_KEY to "future-animation",
        )
        val preferences = MemoryPreferences(stored)
        val settings = DisplaySettings(preferences)
        assertEquals(InterfaceStyle.MATERIAL3, settings.interfaceStyle)
        assertEquals(SurfaceMaterial.FROSTED, settings.surfaceMaterial)
        assertEquals(0.5f, settings.materialStrength)
        assertEquals(PageAnimation.FADE, settings.pageAnimation)
        assertEquals("future-style", stored[DisplaySettings.INTERFACE_STYLE_KEY])
        assertEquals("future-material", stored[DisplaySettings.SURFACE_MATERIAL_KEY])
        assertEquals("NaN", stored[DisplaySettings.MATERIAL_STRENGTH_KEY])
        assertEquals("future-animation", stored[DisplaySettings.PAGE_ANIMATION_KEY])
        settings.changeInterfaceStyle(InterfaceStyle.MATERIAL3)
        assertEquals("material3", stored[DisplaySettings.INTERFACE_STYLE_KEY])
        assertEquals(InterfaceStyle.MATERIAL3, DisplaySettings(preferences).interfaceStyle)
        assertEquals("future-material", stored[DisplaySettings.SURFACE_MATERIAL_KEY])
        settings.changeSurfaceMaterial(SurfaceMaterial.SOLID)
        settings.changeMaterialStrength(0.7f)
        assertEquals("solid", stored[DisplaySettings.SURFACE_MATERIAL_KEY])
        assertEquals(0.7f, DisplaySettings(preferences).materialStrength)
        assertEquals("future-animation", stored[DisplaySettings.PAGE_ANIMATION_KEY])
        settings.changePageAnimation(PageAnimation.FADE)
        assertEquals("fade", stored[DisplaySettings.PAGE_ANIMATION_KEY])
        assertEquals(PageAnimation.FADE, DisplaySettings(preferences).pageAnimation)
    }

    private class MemoryPreferences(private val stored: MutableMap<String, String>) : AppPreferences {
        override fun themeMode() = ThemeMode.SYSTEM
        override fun setThemeMode(mode: ThemeMode) = Unit
        override fun string(key: String) = stored[key]
        override fun setString(key: String, value: String?) {
            if (value == null) stored.remove(key) else stored[key] = value
        }
    }
}
