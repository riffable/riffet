package riffet.ui.timeline

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier

/*
 * The JVM target is a test host (see `shared/build.gradle.kts`), not a desktop product: there is no
 * web view to render a formula in, so it reads as its source text.
 */

@Composable
internal actual fun PlatformMathView(tex: String, url: String, display: Boolean, modifier: Modifier) {
    Text(text = tex, style = TimelineTheme.type.code, color = TimelineTheme.colors.fg3, modifier = modifier)
}
