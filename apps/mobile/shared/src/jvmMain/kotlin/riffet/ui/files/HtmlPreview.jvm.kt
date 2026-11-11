package riffet.ui.files

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier

// The JVM test host keeps the existing source view; the Android host supplies the WebView.
internal actual val htmlPreviewSupported: Boolean = false

@Composable
internal actual fun PlatformHtmlPreview(html: String, interactive: Boolean, modifier: Modifier, onError: (String) -> Unit, generated: Boolean) = Unit
