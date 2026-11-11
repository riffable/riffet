package riffet.ui.timeline

import androidx.compose.ui.window.DialogProperties

/** The skiko targets (desktop, iOS) spell Android's `decorFitsSystemWindows` as `usePlatformInsets`. */
internal actual fun viewerDialogProperties(): DialogProperties = DialogProperties(
    usePlatformDefaultWidth = false,
    usePlatformInsets = false,
)
