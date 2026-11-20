package riffet.ui.files

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import riffet.shared.RiffetApi

/** The platform draws PDF pages itself; elsewhere the server-rendered page is the preview. */
internal expect val nativePdfSupported: Boolean

/**
 * The PDF at [path], read through [api] into a private file that goes with the composition and
 * drawn a page at a time. [version] (the file's hash) re-reads it when the file changes;
 * [onUnavailable] is called when it cannot be drawn here, and the caller falls back to the rendered page.
 */
@Composable
internal expect fun PlatformPdfPreview(api: RiffetApi, projectId: String, path: String, version: String, modifier: Modifier, onUnavailable: () -> Unit)
