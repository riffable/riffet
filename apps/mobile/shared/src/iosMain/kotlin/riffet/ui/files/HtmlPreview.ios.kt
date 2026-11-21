package riffet.ui.files

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier

// The native iPhone app owns its WebKit preview; this older Compose host keeps source mode.
internal actual val htmlPreviewSupported: Boolean = false

@Composable
internal actual fun PlatformHtmlPreview(document: String, interactive: Boolean, modifier: Modifier, onError: (String) -> Unit, generated: Boolean) = Unit

@Composable
internal actual fun PlatformSitePreview(url: String?, modifier: Modifier, onPage: (url: String, status: Int) -> Unit, onError: (String) -> Unit) = Unit

internal actual val nativePdfSupported: Boolean = false

@Composable
internal actual fun PlatformPdfPreview(api: riffet.shared.RiffetApi, projectId: String, path: String, version: String, modifier: Modifier, onUnavailable: () -> Unit) = Unit
