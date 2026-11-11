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
import kotlin.test.assertFalse
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class NativeFeaturesTest {
    @Test
    fun `first read in a snapshot loads preferences and later changes remain observable and saved`() = runTest {
        val stored = mutableMapOf(NativeFeature.BACKGROUND_WATCH.key to "false")
        val preferences = object : AppPreferences {
            override fun themeMode() = ThemeMode.SYSTEM
            override fun setThemeMode(mode: ThemeMode) = Unit
            override fun string(key: String) = stored[key]
            override fun setString(key: String, value: String?) {
                if (value == null) stored.remove(key) else stored[key] = value
            }
        }
        val features by lazy { NativeFeatures(preferences) }
        val observed = mutableListOf<Boolean>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            snapshotFlow { features.isOn(NativeFeature.BACKGROUND_WATCH) }.collect { observed.add(it) }
        }

        assertEquals(listOf(false), observed)
        assertTrue(features.isOn(NativeFeature.ALERTS))
        assertFalse(features.isOn(NativeFeature.HAPTICS))

        features.set(NativeFeature.BACKGROUND_WATCH, true)
        Snapshot.sendApplyNotifications()
        runCurrent()

        assertEquals(listOf(false, true), observed)
        assertEquals("true", stored[NativeFeature.BACKGROUND_WATCH.key])
        assertTrue(NativeFeatures(preferences).isOn(NativeFeature.BACKGROUND_WATCH))
    }
}
