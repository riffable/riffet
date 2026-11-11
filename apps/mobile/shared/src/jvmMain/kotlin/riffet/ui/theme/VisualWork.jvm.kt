package riffet.ui.theme

import androidx.compose.runtime.Composable

// The JVM target is an offscreen verification host. Window focus still gates each consumer.
@Composable
internal actual fun rememberVisualHostResumed(): Boolean = true
