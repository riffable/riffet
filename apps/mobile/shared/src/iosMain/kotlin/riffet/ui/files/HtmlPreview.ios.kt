package riffet.ui.files

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier

// The native iPhone app owns its WebKit preview; this older Compose host keeps source mode.
internal actual val htmlPreviewSupported: Boolean = false

@Composable
internal actual fun PlatformHtmlPreview(html: String, interactive: Boolean, modifier: Modifier, onError: (String) -> Unit, generated: Boolean) = Unit
