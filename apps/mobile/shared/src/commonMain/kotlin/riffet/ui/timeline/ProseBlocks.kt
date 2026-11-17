package riffet.ui.timeline

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.mikepenz.markdown.compose.LocalMarkdownColors
import com.mikepenz.markdown.compose.LocalMarkdownComponents
import com.mikepenz.markdown.compose.LocalMarkdownTypography
import com.mikepenz.markdown.compose.MarkdownElement
import com.mikepenz.markdown.compose.components.MarkdownComponentModel
import com.mikepenz.markdown.compose.components.MarkdownComponents
import com.mikepenz.markdown.model.MarkdownColors
import org.intellij.markdown.IElementType
import org.intellij.markdown.MarkdownElementTypes
import org.intellij.markdown.MarkdownTokenTypes
import org.intellij.markdown.ast.ASTNode
import org.intellij.markdown.flavours.gfm.GFMElementTypes
import org.intellij.markdown.flavours.gfm.GFMTokenTypes

/*
 * The block layout of the answer: the web's `.md` box model, which the library's own list, quote and
 * top-level layouts do not have.
 *
 *  - Blocks are spaced by what they are, not by one number: a heading has its own space above and
 *    below, a rule and a table theirs, and two blocks inside one list item sit closer than two
 *    top-level paragraphs but clearly apart (the library put nothing between them, so an item's
 *    second paragraph ran straight on from its first).
 *  - A list item hangs: the marker sits in the indent and every block of the item — continuation
 *    paragraphs, code, nested lists — starts at the item's text column. Numbers are right-aligned
 *    so `9.` and `10.` share one column.
 *  - A tight list keeps its items close; a loose one (an item holding more than one block, the
 *    shape a long answer takes) separates its items by more than a paragraph, or an item's own
 *    paragraphs would sit further apart than the items themselves.
 */

/** Nodes the walk still hands to `MarkdownElement` (a link definition is recorded there) but that draw nothing. */
private val SilentTypes: Set<IElementType> = setOf(
    MarkdownTokenTypes.EOL,
    MarkdownTokenTypes.WHITE_SPACE,
    MarkdownTokenTypes.LIST_BULLET,
    MarkdownTokenTypes.LIST_NUMBER,
    MarkdownTokenTypes.BLOCK_QUOTE,
    MarkdownElementTypes.LINK_DEFINITION,
    GFMTokenTypes.CHECK_BOX,
)

private val HeadingTypes: Set<IElementType> = setOf(
    MarkdownElementTypes.ATX_1, MarkdownElementTypes.ATX_2, MarkdownElementTypes.ATX_3,
    MarkdownElementTypes.ATX_4, MarkdownElementTypes.ATX_5, MarkdownElementTypes.ATX_6,
    MarkdownElementTypes.SETEXT_1, MarkdownElementTypes.SETEXT_2,
)

private val ListTypes: Set<IElementType> = setOf(MarkdownElementTypes.ORDERED_LIST, MarkdownElementTypes.UNORDERED_LIST)

/** Where a run of blocks sits, which decides the gap between two of them. */
internal enum class ProseContext { DOCUMENT, ITEM, QUOTE }

/** The space above [node] when [previous] is the block before it. */
private fun gapBefore(previous: ASTNode, node: ASTNode, context: ProseContext, prose: ProseScale): Dp = when {
    context == ProseContext.ITEM -> if (node.type in ListTypes) prose.nestedList else prose.itemBlock
    node.type in HeadingTypes -> prose.headingTop
    previous.type in HeadingTypes -> prose.headingBottom
    node.type == MarkdownTokenTypes.HORIZONTAL_RULE || previous.type == MarkdownTokenTypes.HORIZONTAL_RULE -> prose.rule
    previous.type == GFMElementTypes.TABLE -> prose.tableGap
    else -> prose.paragraph
}

/** Renders [nodes] as one column of blocks with the `.md` gaps between them. */
@Composable
internal fun ProseBlocks(
    nodes: List<ASTNode>,
    content: String,
    components: MarkdownComponents,
    context: ProseContext,
    listDepth: Int = 0,
    modifier: Modifier = Modifier,
) {
    val prose = TimelineTheme.prose
    val anchor = LocalFindAnchor.current
    val leaves = LocalFindLeaves.current
    Column(modifier) {
        var previous: ASTNode? = null
        nodes.forEach { node ->
            val silent = node.type in SilentTypes || (node.type == MarkdownElementTypes.HTML_BLOCK && safeBreakNewlines(content.substring(node.startOffset, node.endOffset)) != null)
            if (!silent) {
                previous?.let { Spacer(Modifier.height(gapBefore(it, node, context, prose))) }
                previous = node
            }
            when {
                // Nested lists are drawn here rather than through the component table, so the
                // depth (which picks the bullet) travels with them.
                context == ProseContext.ITEM && node.type in ListTypes ->
                    ProseList(content, node, ordered = node.type == MarkdownElementTypes.ORDERED_LIST, depth = listDepth + 1)
                silent -> MarkdownElement(node = node, components = components, content = content, includeSpacer = false)
                // The innermost block holding find's mark is where the transcript scrolls to; a list or
                // a quote leaves that to the block inside it.
                else -> {
                    val marked = leaves != null && node.type !in ListTypes && node.type != MarkdownElementTypes.BLOCK_QUOTE &&
                        leaves.any { it >= node.startOffset && it < node.endOffset }
                    Box(Modifier.findAnchor(anchor, marked)) {
                        MarkdownElement(node = node, components = components, content = content, includeSpacer = false)
                    }
                }
            }
        }
    }
}

private val Bullets = listOf("•", "◦", "▪")

/**
 * A list with hanging markers. [depth] picks the bullet (disc, circle, square, as a browser does);
 * the indent itself comes from the parent item's text column, so it never compounds.
 */
@Composable
internal fun ProseList(content: String, node: ASTNode, ordered: Boolean, depth: Int = 0) {
    val prose = TimelineTheme.prose
    val colors = TimelineTheme.colors
    val components = LocalMarkdownComponents.current
    val typography = LocalMarkdownTypography.current
    val items = remember(node) { node.children.filter { it.type == MarkdownElementTypes.LIST_ITEM } }
    if (items.isEmpty()) return
    val blocksOf = remember(node) { items.map { item -> item.children.filter { it.type !in SilentTypes } } }
    // Loose: an item holds more than one block of its own (a nested list does not count, or every
    // list with a sub-list would spread out).
    val loose = remember(node) { blocksOf.any { blocks -> blocks.count { it.type !in ListTypes } > 1 } }
    val markerStyle = typography.text.copy(color = colors.fg3)
    // CommonMark numbers from the first item's start and counts up, whatever the later items say.
    val first = remember(node) { items.first().children.firstOrNull { it.type == MarkdownTokenTypes.LIST_NUMBER }?.let { content.substring(it.startOffset, it.endOffset).trim() } }
    val start = first?.takeWhile(Char::isDigit)?.toIntOrNull() ?: 1
    val delimiter = first?.dropWhile(Char::isDigit)?.firstOrNull() ?: '.'
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    val indent = if (!ordered) {
        prose.listIndent
    } else {
        val widest = "${start + items.size - 1}$delimiter"
        val width = remember(widest, markerStyle, density) { with(density) { measurer.measure(widest, markerStyle).size.width.toDp() } }
        maxOf(prose.listIndent, width + prose.markerGap)
    }
    // A loose item's own blocks are `itemBlock` apart, so the items are a paragraph plus their own
    // margins apart: the next item's lead must read as the start of something new.
    val between = if (loose) prose.paragraph + prose.item * 2 else prose.item * 2
    Column(Modifier.fillMaxWidth()) {
        items.forEachIndexed { index, item ->
            if (index > 0) Spacer(Modifier.height(between))
            Row(Modifier.fillMaxWidth()) {
                Box(Modifier.width(indent)) {
                    val checkbox = item.children.firstOrNull { it.type == GFMTokenTypes.CHECK_BOX }
                    when {
                        checkbox != null -> components.checkbox(MarkdownComponentModel(content = content, node = checkbox, typography = typography))
                        ordered -> Text(
                            text = "${start + index}$delimiter",
                            style = markerStyle,
                            textAlign = TextAlign.End,
                            maxLines = 1,
                            modifier = Modifier.width(indent - prose.markerGap),
                        )
                        // The bullet centres in the indent's marker box, the Mac scale's 16 of 22.
                        else -> Text(
                            text = Bullets[depth.coerceAtMost(Bullets.lastIndex)],
                            style = markerStyle,
                            textAlign = TextAlign.Center,
                            maxLines = 1,
                            modifier = Modifier.width(indent - prose.markerGap),
                        )
                    }
                }
                ProseBlocks(
                    nodes = item.children,
                    content = content,
                    components = components,
                    context = ProseContext.ITEM,
                    listDepth = depth,
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

/**
 * The web's `.md blockquote`: a 2dp `lineStrong` bar, the text inset beside it in `fg-2`, and the
 * quoted blocks spaced as paragraphs.
 */
@Composable
internal fun ProseQuote(content: String, node: ASTNode, quoteColors: MarkdownColors) {
    val prose = TimelineTheme.prose
    val bar = TimelineTheme.colors.lineStrong
    val components = LocalMarkdownComponents.current
    CompositionLocalProvider(LocalMarkdownColors provides quoteColors) {
        ProseBlocks(
            nodes = node.children,
            content = content,
            components = components,
            context = ProseContext.QUOTE,
            modifier = Modifier
                .fillMaxWidth()
                .drawBehind {
                    val stroke = 2.dp.toPx()
                    drawLine(bar, Offset(stroke / 2, 0f), Offset(stroke / 2, size.height), stroke)
                }
                .padding(start = prose.quoteInset),
        )
    }
}

/** The top-level column: what `MarkdownSuccess` does, with the `.md` gaps instead of one spacer per child. */
@Composable
internal fun ProseDocument(node: ASTNode, content: String, components: MarkdownComponents, modifier: Modifier) {
    ProseBlocks(nodes = node.children, content = content, components = components, context = ProseContext.DOCUMENT, modifier = modifier)
}
