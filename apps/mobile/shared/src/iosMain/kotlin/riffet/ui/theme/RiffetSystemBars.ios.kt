package riffet.ui.theme

import androidx.compose.runtime.Composable

/**
 * iOS owns the status-bar style through `UIViewController.preferredStatusBarStyle`. The Compose
 * `iosApp` target lands in P4; until then this is deliberately a no-op rather than an untested
 * guess at the UIKit bridge.
 */
@Composable
actual fun RiffetSystemBars(darkTheme: Boolean) = Unit
