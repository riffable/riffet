package riffet.ui.theme

import androidx.compose.runtime.Composable

/**
 * The JVM target exists only so `shared`'s pure logic can be compiled and tested without an Android
 * SDK (see `shared/build.gradle.kts`); it has no window system, so there is no bar to tint.
 */
@Composable
actual fun RiffetSystemBars(darkTheme: Boolean) = Unit
