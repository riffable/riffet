package riffet.ui.icons

import androidx.compose.material3.LocalContentColor
import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorProducer
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.isSpecified
import riffet.contracts.IconPackDocument

/** Resolve at the rendering boundary: remembered actions and enum icons stay reactive without rebuilding screens. */
val LocalIconVectors = compositionLocalOf<Map<String, ImageVector>> { emptyMap() }

internal fun IconPackDocument.vectors(id: String): Map<String, ImageVector> {
    if (!valid()) return emptyMap()
    return icons.mapNotNull { (name, glyph) ->
        // One malformed path must not remove unrelated controls. Missing glyphs use the original Lucide vector.
        runCatching {
            name to ImageVector.Builder("$id/$name", 24.dp, 24.dp, glyph.width, glyph.height).apply {
                glyph.paths.forEach { path ->
                    addPath(
                        pathData = PathParser().parsePathString(path.d).toNodes(),
                        fill = if (path.fill) SolidColor(Color.Black) else null,
                        stroke = if (path.strokeWidth > 0) SolidColor(Color.Black) else null,
                        strokeLineWidth = path.strokeWidth,
                        strokeLineCap = when (path.lineCap) { "butt" -> StrokeCap.Butt; "square" -> StrokeCap.Square; else -> StrokeCap.Round },
                        strokeLineJoin = when (path.lineJoin) { "miter" -> StrokeJoin.Miter; "bevel" -> StrokeJoin.Bevel; else -> StrokeJoin.Round },
                        pathFillType = if (path.fillRule == "evenodd") PathFillType.EvenOdd else PathFillType.NonZero,
                    )
                }
            }.build()
        }.getOrNull()
    }.toMap()
}

@Composable
private fun rememberIconPainter(imageVector: ImageVector, strokeWidth: Dp?): Pair<Painter, Boolean> {
    val key = when {
        imageVector.name.startsWith("Lucide") -> imageVector.name.removePrefix("Lucide")
        imageVector.name == "RiffetMenu" -> "Menu"
        else -> null // Brand and Agent marks keep their own identity.
    }
    val pack = key?.let { LocalIconVectors.current[it] }
    val brandPainter = AgentMarks.painter(imageVector)
    val density = LocalDensity.current.density
    val resolvedStroke = strokeWidth?.takeIf { it.isSpecified && it > 0.dp }?.value
    // Lucide's own strokes keep a constant dp width; a pack's replacement glyph is drawn as its author made it.
    val fixed = remember(imageVector, density, resolvedStroke, pack != null || key == null) {
        if (pack == null && key != null) ConstantStrokePainter.of(imageVector, density, resolvedStroke) else null
    }
    // One call site: switching packs swaps the painter, not the node. A VectorPainter can only be
    // made by this composable, so it always runs; while [fixed] draws, it holds an empty vector.
    val vectorPainter = rememberVectorPainter(if (fixed != null || brandPainter != null) BlankVector else pack ?: imageVector)
    return (brandPainter ?: fixed ?: vectorPainter) to (brandPainter != null)
}

@Composable
fun Icon(
    imageVector: ImageVector,
    contentDescription: String?,
    modifier: Modifier = Modifier,
    tint: Color = LocalContentColor.current,
    strokeWidth: Dp? = null,
) {
    val (painter, isBrand) = rememberIconPainter(imageVector, strokeWidth)
    androidx.compose.material3.Icon(painter, contentDescription, modifier, if (isBrand) Color.Unspecified else tint)
}

/** Deferred-tint overload so colour animations invalidate draw only without recomposing callers. */
@Composable
fun Icon(
    imageVector: ImageVector,
    tint: ColorProducer,
    contentDescription: String?,
    modifier: Modifier = Modifier,
    strokeWidth: Dp? = null,
) {
    val (painter, isBrand) = rememberIconPainter(imageVector, strokeWidth)
    androidx.compose.material3.Icon(painter, if (isBrand) UnspecifiedColorProducer else tint, contentDescription, modifier)
}

private val UnspecifiedColorProducer = ColorProducer { Color.Unspecified }

private val BlankVector = ImageVector.Builder("Blank", 24.dp, 24.dp, 24f, 24f).build()

@Composable
fun Icon(painter: Painter, contentDescription: String?, modifier: Modifier = Modifier, tint: Color = LocalContentColor.current) =
    androidx.compose.material3.Icon(painter, contentDescription, modifier, tint)

@Composable
fun Icon(bitmap: ImageBitmap, contentDescription: String?, modifier: Modifier = Modifier, tint: Color = LocalContentColor.current) =
    androidx.compose.material3.Icon(bitmap, contentDescription, modifier, tint)
