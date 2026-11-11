package riffet.ui.theme

import androidx.compose.runtime.Composable

// The shipped iOS UI is SwiftUI; shared Compose consumers retain their window/page gates.
@Composable
internal actual fun rememberVisualHostResumed(): Boolean = true
