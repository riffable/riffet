package riffet.ui.timeline

import androidx.compose.ui.window.DialogProperties

/** Android's own word for "draw under the system bars" is `decorFitsSystemWindows`. */
internal actual fun viewerDialogProperties(): DialogProperties = DialogProperties(
    usePlatformDefaultWidth = false,
    decorFitsSystemWindows = false,
)
