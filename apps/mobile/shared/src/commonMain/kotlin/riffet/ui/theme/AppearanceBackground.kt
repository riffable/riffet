package riffet.ui.theme

import androidx.compose.foundation.background
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.paint
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageShader
import androidx.compose.ui.graphics.ShaderBrush
import androidx.compose.ui.graphics.TileMode
import androidx.compose.ui.graphics.painter.BitmapPainter
import androidx.compose.ui.layout.ContentScale

/** Page backgrounds stay behind foreground content and keep the page surface as their base. */
@Composable
internal fun Modifier.appearancePageBackground(color: Color): Modifier {
    val resources = LocalAppearanceResources.current
    val image = resources?.background
    val contribution = resources?.effective?.background
    val base = background(color)
    if (image == null || contribution == null) return base
    val opacity = contribution.opacity.takeIf { it.isFinite() }?.coerceIn(0.0, 1.0)?.toFloat() ?: 1f
    return if (contribution.fit == "tile") {
        val brush = ShaderBrush(ImageShader(image, TileMode.Repeated, TileMode.Repeated))
        base.drawBehind { drawRect(brush, alpha = opacity) }
    } else base.paint(BitmapPainter(image), sizeToIntrinsics = false, contentScale = ContentScale.Crop, alpha = opacity)
}
