package riffet.ui.icons

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Fill
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.graphics.vector.VectorGroup
import androidx.compose.ui.graphics.vector.VectorPath

/**
 * Draws a stroked glyph with the stroke width fixed in dp, like the web (`vector-effect: non-scaling-stroke`):
 * a vector's own stroke scales with the size it is drawn at, so 16dp and 24dp would differ. The width is
 * resolved in [onDraw] from the real size, so the call sites keep their `Modifier.size(...)` and nothing
 * is rebuilt per size or per frame. A path's `strokeLineWidth` is read as dp (1.25 regular, 1.75 selected).
 */
internal class ConstantStrokePainter private constructor(
    private val vector: ImageVector,
    private val paths: List<Entry>,
    private val density: Float,
    private val strokeWidth: Float? = null,
) : Painter() {
    class Entry(val source: VectorPath, val path: Path)

    override val intrinsicSize: Size = Size(vector.defaultWidth.value * density, vector.defaultHeight.value * density)

    private var alpha = 1f
    private var colorFilter: ColorFilter? = null

    override fun applyAlpha(alpha: Float): Boolean { this.alpha = alpha; return true }

    override fun applyColorFilter(colorFilter: ColorFilter?): Boolean { this.colorFilter = colorFilter; return true }

    override fun DrawScope.onDraw() {
        val sx = size.width / vector.viewportWidth
        val sy = size.height / vector.viewportHeight
        val unit = minOf(sx, sy)
        withTransform({ scale(sx, sy, Offset.Zero) }) {
            for (entry in paths) {
                val p = entry.source
                p.fill?.let { drawPath(entry.path, it, p.fillAlpha * alpha, Fill, colorFilter) }
                p.stroke?.let {
                    val width = strokeWidth ?: p.strokeLineWidth
                    val style = Stroke(width * density / unit, p.strokeLineMiter, p.strokeLineCap, p.strokeLineJoin)
                    drawPath(entry.path, it, p.strokeAlpha * alpha, style, colorFilter)
                }
            }
        }
    }

    companion object {
        // Compose runs on one thread; the parsed paths depend only on the (singleton) vector.
        private val parsed = HashMap<ImageVector, List<Entry>?>()

        /** Null when there is nothing to adjust (no stroked path) or the vector has groups; the caller then draws it as is. */
        fun of(vector: ImageVector, density: Float, strokeWidth: Float? = null): ConstantStrokePainter? {
            val entries = parsed.getOrPut(vector) {
                val nodes = vector.root.toList()
                if (nodes.any { it !is VectorPath } || nodes.none { (it as VectorPath).stroke != null }) null
                else nodes.map { node ->
                    val p = node as VectorPath
                    Entry(p, PathParser().addPathNodes(p.pathData).toPath().also { it.fillType = p.pathFillType })
                }
            } ?: return null
            return ConstantStrokePainter(vector, entries, density, strokeWidth)
        }
    }
}
