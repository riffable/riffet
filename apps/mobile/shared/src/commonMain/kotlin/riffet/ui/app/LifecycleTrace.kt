package riffet.ui.app

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.currentCompositeKeyHash
import riffet.ui.state.lifecycleTrace
import riffet.ui.state.lifecycleTraceEnabled

/**
 * Logs this point of the composition being created and disposed, when lifecycle tracing is on
 * (see [lifecycleTraceEnabled]). A `-` then `+` for the same tag while nothing left the screen
 * means the subtree remounted instead of recomposing: its remembered state and images restart.
 */
@Composable
internal fun TraceLifecycle(tag: String) {
    if (!lifecycleTraceEnabled()) return
    val id = currentCompositeKeyHash.toUInt().toString(16)
    DisposableEffect(Unit) {
        lifecycleTrace("+ $tag #$id")
        onDispose { lifecycleTrace("- $tag #$id") }
    }
}
