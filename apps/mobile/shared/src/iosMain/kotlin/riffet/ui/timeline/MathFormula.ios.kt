package riffet.ui.timeline

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier

/*
 * iOS is P4 (docs/MOBILE.md, 分期与验收): like the attachment picker and the system bars, this is a
 * stub so the iOS targets compile today.
 *
 * TODO(ios, P4): back this with a `WKWebView` through `UIKitView` — the page and its KaTeX assets
 * are already served (`apps/server/src/math-assets.ts`), so only the view, its transparent
 * background and the height read (`evaluateJavaScript` on the page's `#formula` element) are
 * missing. Until then a formula reads as its source text on iOS, which is what it did before.
 */

@Composable
internal actual fun PlatformMathView(tex: String, url: String, display: Boolean, modifier: Modifier) {
    Text(
        text = tex,
        style = TimelineTheme.type.code,
        color = TimelineTheme.colors.fg3,
        modifier = modifier,
    )
}
