package riffet.ui.timeline

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import io.ktor.http.encodeURLParameter
import kotlin.math.roundToInt

/**
 * A block formula, rendered by the server's KaTeX page.
 *
 * The web client renders TeX in the browser (`remark-math` + `rehype-katex`); this client has no TeX
 * engine and shipping one for Android and iOS would mean two more renderers that quietly drift from
 * the browser's. Instead the server serves one page using the same KaTeX build the web bundle uses
 * (`apps/server/src/math-assets.ts`), and the platform shows it in a web view sized to its content.
 *
 * The formula travels in the URL fragment, so it is never sent to the server or written to a log,
 * and a client with no web view (the JVM test host, iOS at P4) falls back to the source text.
 */
@Composable
internal fun MathFormula(
    tex: String,
    display: Boolean,
    color: Color,
    modifier: Modifier = Modifier,
) {
    val url = rememberMathUrl(tex, display, color)
    if (url == null) {
        // No server yet, or none configured: the formula is still readable as source, which is what
        // the answer showed before this existed.
        Text(
            text = tex,
            style = TimelineTheme.type.code,
            color = TimelineTheme.colors.fg3,
            modifier = modifier,
        )
        return
    }
    PlatformMathView(tex = tex, url = url, display = display, modifier = modifier)
}

/**
 * The page URL for one formula, or null until the server's base URL is known.
 *
 * `encodeURLParameter` is percent-encoding, which is what a fragment needs: `&`, `#`, `+` and
 * `\` are all common in TeX, and the page decodes the fragment with `URLSearchParams`.
 */
@Composable
private fun rememberMathUrl(tex: String, display: Boolean, color: Color): String? {
    var base by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) {
        base = runCatching { RiffetImageAuth.baseUrl() }.getOrNull()
    }
    val hex = remember(color) { previewColorHex(color) }
    return remember(base, tex, display, hex) {
        val root = base?.trim()?.trimEnd('/')?.takeIf { it.isNotEmpty() } ?: return@remember null
        "$root/math#tex=${tex.encodeURLParameter()}&d=${if (display) 1 else 0}&c=$hex"
    }
}

/** `#rrggbb` for a colour the page can put on `color`. */
internal fun previewColorHex(color: Color): String {
    fun channel(value: Float): String = (value * 255f).roundToInt().coerceIn(0, 255).toString(16).padStart(2, '0')
    return "#" + channel(color.red) + channel(color.green) + channel(color.blue)
}

/**
 * The platform's web view for one formula URL.
 *
 * [display] is only a hint for the first paint, before the page has reported its real height: a
 * display formula is taller than an inline one, so the placeholder starts closer to its final size
 * and the row does not jump when the measurement arrives.
 */
@Composable
internal expect fun PlatformMathView(tex: String, url: String, display: Boolean, modifier: Modifier)
