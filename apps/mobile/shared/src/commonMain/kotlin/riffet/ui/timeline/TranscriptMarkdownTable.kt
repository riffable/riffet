package riffet.ui.timeline

import riffet.ui.design.LocalInterfaceStyle
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.mikepenz.markdown.compose.LocalMarkdownDimens
import com.mikepenz.markdown.compose.LocalMarkdownComponents
import com.mikepenz.markdown.compose.MarkdownElement
import com.mikepenz.markdown.compose.components.markdownComponents
import com.mikepenz.markdown.compose.elements.MarkdownTableBasicText
import com.mikepenz.markdown.annotator.AnnotatorSettings
import com.mikepenz.markdown.annotator.annotatorSettings
import com.mikepenz.markdown.model.MarkdownAnnotator
import com.mikepenz.markdown.model.markdownAnnotator
import org.intellij.markdown.MarkdownElementTypes
import org.intellij.markdown.ast.ASTNode
import org.intellij.markdown.flavours.gfm.GFMElementTypes
import org.intellij.markdown.flavours.gfm.GFMTokenTypes

private val TableGridThickness = 0.5.dp

/** Wrap cells, preserve inline Markdown and column alignment, and draw a complete table grid. */
@Composable
internal fun TranscriptMarkdownTable(
    content: String,
    node: ASTNode,
    style: TextStyle,
    cellPadding: PaddingValues,
    annotator: MarkdownAnnotator = markdownAnnotator { _, _ -> false },
) {
    val colors = TimelineTheme.colors
    val dimens = LocalMarkdownDimens.current
    val components = LocalMarkdownComponents.current
    val cellAnnotatorSettings: AnnotatorSettings = annotatorSettings(annotator = annotator)
    val rows = remember(node) {
        node.children.filter { it.type == GFMElementTypes.HEADER || it.type == GFMElementTypes.ROW }
            .map { row -> row.children.filter { it.type == GFMTokenTypes.CELL } }
    }
    val columns = rows.firstOrNull()?.size ?: 0
    if (columns == 0) return
    val alignments = remember(content, node) {
        val separator = node.children.firstOrNull { it.type == GFMTokenTypes.TABLE_SEPARATOR }
        val text = separator?.let { content.substring(it.startOffset, it.endOffset) }.orEmpty()
        tableAlignments(text)
    }
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val tableWidth = maxOf(maxWidth, dimens.tableCellWidth * columns)
        val shape = RoundedCornerShape(LocalInterfaceStyle.current.rowRadius)
        Box(Modifier.horizontalScroll(rememberScrollState())) {
            Column(
                Modifier.width(tableWidth).clip(shape)
                    .border(BorderStroke(TableGridThickness, colors.line), shape),
            ) {
                rows.forEachIndexed { rowIndex, cells ->
                    if (rowIndex > 0) HorizontalDivider(thickness = TableGridThickness, color = colors.line)
                    // The web's `.md th { background: bg-subtle; color: fg-2; font-weight: 600 }`.
                    val header = rowIndex == 0
                    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min).then(if (header) Modifier.background(colors.bgSubtle) else Modifier)) {
                        repeat(columns) { column ->
                            val alignment = alignments.getOrElse(column) { TextAlign.Start }
                            Box(
                                Modifier.weight(1f).fillMaxHeight()
                                    .drawBehind {
                                        if (column < columns - 1) {
                                            val stroke = TableGridThickness.toPx()
                                            val x = size.width - stroke / 2
                                            drawLine(colors.line, Offset(x, 0f), Offset(x, size.height), stroke)
                                        }
                                    }
                                    .padding(cellPadding),
                                contentAlignment = when (alignment) {
                                    TextAlign.Center -> Alignment.TopCenter
                                    TextAlign.End -> Alignment.TopEnd
                                    else -> Alignment.TopStart
                                },
                            ) {
                                cells.getOrNull(column)?.let { cell ->
                                    if (cell.children.any { it.type == MarkdownElementTypes.IMAGE }) {
                                        MarkdownElement(node = cell, components = components, content = content, includeSpacer = false)
                                    } else MarkdownTableBasicText(
                                        content = content,
                                        cell = cell,
                                        style = style.copy(
                                            fontWeight = if (header) FontWeight.Medium else style.fontWeight,
                                            color = if (header) colors.fg2 else style.color,
                                            textAlign = alignment,
                                        ),
                                        maxLines = Int.MAX_VALUE,
                                        overflow = TextOverflow.Clip,
                                        annotatorSettings = cellAnnotatorSettings,
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

internal fun tableAlignments(separator: String): List<TextAlign> =
    separator.trim().removePrefix("|").removeSuffix("|").split('|').map { raw ->
        val cell = raw.trim()
        when {
            cell.startsWith(':') && cell.endsWith(':') -> TextAlign.Center
            cell.endsWith(':') -> TextAlign.End
            else -> TextAlign.Start
        }
    }
