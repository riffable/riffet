package riffet.ui.timeline

import androidx.compose.ui.window.DialogProperties

/**
 * The properties the image viewer's window needs, which no two platforms spell the same way.
 *
 * The page is drawn edge to edge on purpose: a photo viewer framed by strips of the app's own
 * background, or by a status bar painted for a light page, is the shape it replaced. Android's dialog
 * window is inset by the system bars unless `decorFitsSystemWindows` says otherwise, while the skiko
 * targets (desktop, iOS) call the same thing `usePlatformInsets` — and each side rejects the other's
 * word at compile time, so a single common `DialogProperties(...)` cannot express it.
 *
 * The page itself pays for this: with the insets off the window, [ImageViewerInfoBar] is what keeps
 * its buttons clear of the gesture bar.
 */
internal expect fun viewerDialogProperties(): DialogProperties
