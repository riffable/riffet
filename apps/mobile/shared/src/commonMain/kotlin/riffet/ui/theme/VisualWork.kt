package riffet.ui.theme

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalWindowInfo
import riffet.ui.app.LocalPageActive
import riffet.ui.timeline.rememberReducedMotion

private val LocalVisualHostResumed = staticCompositionLocalOf { true }

/** Visual loops never own connection, job, or navigation lifetimes. */
@Composable
internal fun RiffetVisualWorkScope(content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalVisualHostResumed provides rememberVisualHostResumed(), content = content)
}

/** Timers remain useful with reduced motion; only decorative loops are disabled by that setting. */
@Composable
internal fun visualWorkActive(visible: Boolean = true, decorative: Boolean = false): Boolean {
    // Every read runs on every composition. Short-circuited, a page pushed on top remounted whatever
    // the caller composed after this call (seen on device: transcript images flashed empty).
    val resumed = LocalVisualHostResumed.current
    val pageActive = LocalPageActive.current
    val focused = LocalWindowInfo.current.isWindowFocused
    val reduced = rememberReducedMotion()
    return resumed && pageActive && focused && visible && (!decorative || !reduced)
}

@Stable
internal class VisualWorkVisibility {
    var visible by mutableStateOf(false)
        internal set
}

@Composable
internal fun rememberVisualWorkVisibility(): VisualWorkVisibility = remember { VisualWorkVisibility() }

/** Clipped window bounds exclude retained lazy items outside the viewport. No visibility polling. */
internal fun Modifier.visualWorkVisibility(state: VisualWorkVisibility): Modifier = onGloballyPositioned { coordinates ->
    val bounds = coordinates.boundsInWindow()
    state.visible = coordinates.isAttached && bounds.width > 0f && bounds.height > 0f
}

@Composable
internal expect fun rememberVisualHostResumed(): Boolean
