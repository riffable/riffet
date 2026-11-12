package riffet.ui.git

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import riffet.shared.GitGraphRow
import riffet.ui.theme.LocalRiffetColors

internal val GitLaneWidth = 12.dp

/** Lanes drawn at most; a wider graph puts the rest on the last one. */
internal const val GitMaxLanes = 9

/**
 * The commit graph of one history row, drawn from its [GitGraphRow]: lanes passing by as vertical
 * lines, lines coming down into the commit and leaving it for its parents as curves, and the commit's dot.
 * Each row spans the full [height], so neighbouring rows join into continuous lines.
 */
@Composable
internal fun GitGraphCell(row: GitGraphRow, lanes: Int, height: Dp, modifier: Modifier = Modifier) {
    val colors = LocalRiffetColors.current
    val palette = remember(colors) { listOf(colors.accent, colors.success, colors.warning, colors.danger, colors.chart1, colors.chart2) }
    Canvas(modifier.size(GitLaneWidth * lanes, height)) {
        val laneWidth = GitLaneWidth.toPx()
        val stroke = Stroke(width = 1.5.dp.toPx(), cap = StrokeCap.Round)
        val mid = size.height / 2
        fun x(column: Int) = laneWidth * column.coerceAtMost(lanes - 1) + laneWidth / 2
        fun color(index: Int) = palette[index % palette.size]

        row.through.forEach { lane -> line(x(lane.column), 0f, x(lane.column), size.height, color(lane.color), stroke) }
        row.from.forEach { lane -> line(x(lane.column), 0f, x(row.column), mid, color(lane.color), stroke) }
        row.to.forEach { lane -> line(x(row.column), mid, x(lane.column), size.height, color(lane.color), stroke) }
        drawCircle(color(row.color), radius = 3.5.dp.toPx(), center = Offset(x(row.column), mid))
    }
}

// A straight line between lanes in one column, an S-curve between two.
private fun DrawScope.line(x1: Float, y1: Float, x2: Float, y2: Float, color: Color, stroke: Stroke) {
    if (x1 == x2) {
        drawLine(color, Offset(x1, y1), Offset(x2, y2), stroke.width, stroke.cap)
        return
    }
    val bend = (y1 + y2) / 2
    val path = Path().apply {
        moveTo(x1, y1)
        cubicTo(x1, bend, x2, bend, x2, y2)
    }
    drawPath(path, color, style = stroke)
}
