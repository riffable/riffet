package riffet.ui.theme

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import riffet.ui.design.LocalInterfaceStyle

/**
 * A theme in one tile: its light half beside its dark half, each with its own accent.
 *
 * It takes the [ThemeEntry] itself rather than an id: the entry is the palette, whether it came
 * from the generated tables or from the server's library, so nothing here has to know where a theme
 * came from.
 *
 * The default size is the settings gallery's; the menus pass something smaller, because a swatch
 * beside a 13sp label does not need to be the tallest thing in the row.
 */
@Composable
internal fun ThemeSwatch(
    entry: ThemeEntry,
    modifier: Modifier = Modifier,
    width: Dp = 34.dp,
    height: Dp = 24.dp,
    dot: Dp = 7.dp,
) {
    val shape = RoundedCornerShape(height / 3)
    Row(
        modifier = modifier
            .size(width = width, height = height)
            .clip(shape)
            .border(LocalInterfaceStyle.current.metrics.hairlineWidth, LocalRiffetColors.current.line, shape),
    ) {
        SwatchHalf(entry.light.bg, entry.light.accent, dot, Modifier.weight(1f))
        SwatchHalf(entry.dark.bg, entry.dark.accent, dot, Modifier.weight(1f))
    }
}

@Composable
private fun SwatchHalf(background: Color, accent: Color, dot: Dp, modifier: Modifier) {
    Box(modifier.fillMaxHeight().background(background), contentAlignment = Alignment.Center) {
        Box(Modifier.size(dot).clip(CircleShape).background(accent))
    }
}
