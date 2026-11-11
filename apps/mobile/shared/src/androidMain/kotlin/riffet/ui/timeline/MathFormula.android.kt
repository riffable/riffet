package riffet.ui.timeline

import android.annotation.SuppressLint
import android.graphics.Color as AndroidColor
import android.webkit.WebView
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import riffet.ui.design.RiffetMaterialPlatformView
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

/**
 * The formula web view, sized to the page's own content.
 *
 * The page is local, script-free apart from KaTeX itself, and cannot navigate: it renders one
 * formula from its fragment. Java script is enabled because KaTeX *is* a script; file and content
 * access stay off, and a transparent background lets the transcript's own surface show through.
 *
 * Height is measured rather than guessed because a formula's size is its content: `\frac` stacks,
 * `\sum` grows, and a fixed box would clip one or float the other. The page may paint twice (fonts
 * arrive after the first layout), so the measurement is retried a few times and the last one wins.
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
internal actual fun PlatformMathView(tex: String, url: String, display: Boolean, modifier: Modifier) {
    val density = LocalDensity.current
    var height by remember(url) { mutableStateOf(if (display) 40.dp else 24.dp) }
    var web by remember { mutableStateOf<WebView?>(null) }
    RiffetMaterialPlatformView { AndroidView(
        modifier = modifier.height(height),
        factory = { context ->
            WebView(context).apply {
                setBackgroundColor(AndroidColor.TRANSPARENT)
                isVerticalScrollBarEnabled = false
                isHorizontalScrollBarEnabled = false
                settings.javaScriptEnabled = true
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                settings.domStorageEnabled = false
                web = this
            }
        },
    ) }
    LaunchedEffect(url, web) {
        val view = web ?: return@LaunchedEffect
        view.loadUrl(url)
        // First paint, then two passes for the fonts KaTeX swaps in. A later, larger measurement
        // replaces an earlier one; a failed read leaves the previous height alone.
        repeat(6) { attempt ->
            delay(if (attempt == 0) 80 else 150)
            val pixels = view.formulaHeight() ?: return@repeat
            val next: Dp = with(density) { pixels.toDp() }
            if (next > height) height = next
        }
    }
}

/** The rendered formula's height in CSS pixels, or null while the page cannot answer. */
private suspend fun WebView.formulaHeight(): Float? = suspendCancellableCoroutine { continuation ->
    evaluateJavascript(
        "(function(){var e=document.getElementById('formula');" +
            "return e?Math.ceil(e.getBoundingClientRect().height):0})()",
    ) { value ->
        val pixels = value?.trim('"')?.toFloatOrNull()
        if (continuation.isActive) continuation.resume(if (pixels != null && pixels > 0f) pixels else null)
    }
}
