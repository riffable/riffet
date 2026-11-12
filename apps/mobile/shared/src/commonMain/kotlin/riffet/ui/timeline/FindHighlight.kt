package riffet.ui.timeline

import androidx.compose.runtime.Immutable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.node.LayoutAwareModifierNode
import androidx.compose.ui.node.ModifierNodeElement
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import com.mikepenz.markdown.model.State
import org.intellij.markdown.IElementType
import org.intellij.markdown.MarkdownElementTypes
import org.intellij.markdown.MarkdownTokenTypes
import org.intellij.markdown.ast.ASTNode
import org.intellij.markdown.ast.getTextInNode

/*
 * 会话内查找's mark in the transcript: the one occurrence the reader stepped to, drawn as a
 * background span inside the row's own text. It adds no node and no height, so a row looks the same
 * apart from the span. Only the target row is given a [FindHighlight]; every other row reads null.
 */

/** The [nth] (0-based) occurrence of the lower-cased [needle] in the row's visible text. */
@Immutable
internal data class FindHighlight(val needle: String, val nth: Int)

/** Provided per row by the transcript, and it changes with every step, hence not a static local. */
internal val LocalFindHighlight = compositionLocalOf<FindHighlight?> { null }

/**
 * Where the marked occurrence is drawn, so the transcript can bring it into view inside a row taller
 * than the screen: the block of text holding it reports its coordinates, and [FindPlace.span] the
 * offset of the marked line within them where the text knows it. One per transcript.
 */
@Stable
internal class FindAnchor {
    var place by mutableStateOf<FindPlace?>(null)
        internal set
}

/** [span] is the marked line's top and bottom within [coordinates]; null when only the block is known. */
internal class FindPlace(val coordinates: LayoutCoordinates, val span: () -> Pair<Float, Float>?)

/** The transcript's [FindAnchor]; it never changes for a transcript. */
internal val LocalFindAnchor = compositionLocalOf<FindAnchor?> { null }

/**
 * The source offsets of the text leaves [findMarks] marks in the document being drawn, for its blocks
 * to tell which of them holds the mark; null in every row but the find target.
 */
internal val LocalFindLeaves = compositionLocalOf<Set<Int>?> { null }

/**
 * Reports this node to [anchor] while [active]. Always in the chain, whatever [active] is, so landing
 * on a row does not change its modifiers' shape.
 */
internal fun Modifier.findAnchor(anchor: FindAnchor?, active: Boolean, span: () -> Pair<Float, Float>? = WholeBlock): Modifier =
    this then FindAnchorElement(anchor, active, span)

private val WholeBlock: () -> Pair<Float, Float>? = { null }

private class FindAnchorElement(val anchor: FindAnchor?, val active: Boolean, val span: () -> Pair<Float, Float>?) : ModifierNodeElement<FindAnchorNode>() {
    override fun create() = FindAnchorNode(anchor, active, span)
    override fun update(node: FindAnchorNode) = node.update(anchor, active, span)
    override fun equals(other: Any?) = other is FindAnchorElement && other.anchor === anchor && other.active == active && other.span === span
    override fun hashCode() = (anchor.hashCode() * 31 + active.hashCode()) * 31 + span.hashCode()
}

private class FindAnchorNode(var anchor: FindAnchor?, var active: Boolean, var span: () -> Pair<Float, Float>?) : Modifier.Node(), LayoutAwareModifierNode {
    private var reported: FindPlace? = null
    /** Where this block was last placed, so it can report at once when it becomes the target. */
    private var placed: LayoutCoordinates? = null

    override fun onPlaced(coordinates: LayoutCoordinates) {
        placed = coordinates
        if (active && reported?.coordinates !== coordinates) report(coordinates)
    }

    fun update(anchor: FindAnchor?, active: Boolean, span: () -> Pair<Float, Float>?) {
        if (anchor !== this.anchor || !active) release()
        this.anchor = anchor
        this.active = active
        this.span = span
        // A row already on screen becomes the target without being placed again.
        if (active) placed?.takeIf { it.isAttached }?.let(::report)
    }

    override fun onDetach() {
        release()
        placed = null
    }

    private fun report(coordinates: LayoutCoordinates) {
        val anchor = anchor ?: return
        val node = this
        FindPlace(coordinates) { node.span() }.also { reported = it; anchor.place = it }
    }

    private fun release() {
        val reported = reported ?: return
        this.reported = null
        anchor?.let { if (it.place === reported) it.place = null }
    }
}

/** [text] with the occurrence of [highlight] marked; the plain text itself when there is none. */
internal fun highlightedText(text: String, highlight: FindHighlight?, mark: Color): AnnotatedString {
    if (highlight == null) return AnnotatedString(text)
    val lowered = text.lowercase()
    if (lowered.length != text.length) return AnnotatedString(text)
    val at = occurrenceAt(lowered, highlight.needle, highlight.nth)
    if (at < 0) return AnnotatedString(text)
    return buildAnnotatedString {
        append(text.substring(0, at))
        withStyle(SpanStyle(background = mark)) { append(text.substring(at, at + highlight.needle.length)) }
        append(text.substring(at + highlight.needle.length))
    }
}

/** The index of the [nth] non-overlapping occurrence of [needle] in [text], or -1. */
private fun occurrenceAt(text: String, needle: String, nth: Int): Int {
    if (needle.isEmpty()) return -1
    var rest = nth
    var from = 0
    while (true) {
        val at = text.indexOf(needle, from)
        if (at < 0) return -1
        if (rest == 0) return at
        rest -= 1
        from = at + needle.length
    }
}

/**
 * Where the occurrence sits in each parsed text segment of [prepared]: per segment, the start
 * offset of a text leaf in the segment's source to the half-open range of it to mark. A segment
 * without the occurrence (and one the parser refused) is null. The count follows what the server
 * counts, the text a reader sees, so code and link targets are counted or left out the same way;
 * only plain prose leaves can be drawn marked.
 */
internal fun findMarks(prepared: PreparedMarkdown, highlight: FindHighlight): List<Map<Int, Pair<Int, Int>>?> {
    var rest = highlight.nth
    return prepared.segments.map { segment ->
        if (segment !is PreparedSegment.Text || rest < 0) return@map null
        val success = segment.state as? State.Success ?: return@map null
        val pieces = ArrayList<Piece>()
        collect(success.node, success.content, pieces)
        val buffer = StringBuilder()
        pieces.forEach { buffer.append(it.text) }
        val lowered = buffer.toString().lowercase()
        if (lowered.length != buffer.length) return@map null
        var from = 0
        var found = -1
        while (found < 0) {
            val at = lowered.indexOf(highlight.needle, from)
            if (at < 0) break
            if (rest == 0) found = at else { rest -= 1; from = at + highlight.needle.length }
        }
        if (found < 0) return@map null
        rest = -1
        val end = found + highlight.needle.length
        val marks = HashMap<Int, Pair<Int, Int>>()
        var start = 0
        for (piece in pieces) {
            val stop = start + piece.text.length
            if (piece.leaf != null && start < end && stop > found) {
                marks[piece.leaf] = maxOf(found, start) - start to minOf(end, stop) - start
            }
            start = stop
        }
        marks
    }
}

/** A run of the segment's visible text; [leaf] is the source offset of a leaf that can be drawn marked. */
private class Piece(val text: String, val leaf: Int?)

private val VISIBLE_LEAVES: Set<IElementType> = setOf(
    MarkdownTokenTypes.TEXT,
    MarkdownTokenTypes.WHITE_SPACE,
    MarkdownTokenTypes.SINGLE_QUOTE,
    MarkdownTokenTypes.DOUBLE_QUOTE,
    MarkdownTokenTypes.COLON,
    MarkdownTokenTypes.EXCLAMATION_MARK,
)

/** Text a link or a definition holds that the page does not show. */
private val HIDDEN: Set<IElementType> = setOf(
    MarkdownElementTypes.LINK_DESTINATION,
    MarkdownElementTypes.LINK_TITLE,
    MarkdownElementTypes.LINK_LABEL,
    MarkdownElementTypes.LINK_DEFINITION,
)

private val BLOCKS: Set<IElementType> = setOf(
    MarkdownElementTypes.PARAGRAPH,
    MarkdownElementTypes.ATX_1,
    MarkdownElementTypes.ATX_2,
    MarkdownElementTypes.ATX_3,
    MarkdownElementTypes.ATX_4,
    MarkdownElementTypes.ATX_5,
    MarkdownElementTypes.ATX_6,
    MarkdownElementTypes.SETEXT_1,
    MarkdownElementTypes.SETEXT_2,
)

private val BREAK = Piece("\n", null)

private fun collect(node: ASTNode, content: String, out: MutableList<Piece>) {
    val type = node.type
    when {
        type in HIDDEN -> Unit
        type in VISIBLE_LEAVES -> {
            val text = node.getTextInNode(content).toString()
            // An escape or an entity is drawn as something other than its source: counted, not marked.
            out += Piece(text, node.startOffset.takeIf { '\\' !in text && '&' !in text })
        }
        type == MarkdownTokenTypes.EOL -> out += BREAK
        type == MarkdownElementTypes.CODE_SPAN ->
            out += Piece(node.children.filter { it.type != MarkdownTokenTypes.BACKTICK }.joinToString("") { it.getTextInNode(content) }, null)
        type == MarkdownElementTypes.CODE_FENCE -> {
            out += BREAK
            val language = node.children.firstOrNull { it.type == MarkdownTokenTypes.FENCE_LANG }?.getTextInNode(content)?.toString()?.trim()
            out += Piece(language?.ifEmpty { null } ?: "text", null)
            out += Piece(
                node.children.filter { it.type == MarkdownTokenTypes.CODE_FENCE_CONTENT || it.type == MarkdownTokenTypes.EOL }
                    .joinToString("") { it.getTextInNode(content) },
                null,
            )
        }
        type == MarkdownElementTypes.CODE_BLOCK -> {
            out += BREAK
            out += Piece(node.getTextInNode(content).toString(), null)
        }
        else -> {
            if (type in BLOCKS) out += BREAK
            node.children.forEach { collect(it, content, out) }
        }
    }
}

/** The leaf kinds [findMarks] can address; the annotator draws only these. */
internal fun isMarkableLeaf(type: IElementType): Boolean = type in VISIBLE_LEAVES

/**
 * Whether the occurrence is drawn marked in [item]'s text: false for text the renderer cannot mark
 * (code, a row not parsed yet), where the transcript flashes the row instead.
 */
internal fun markDrawn(item: riffet.core.TimelineItem, highlight: FindHighlight): Boolean = when (item) {
    is riffet.core.TimelineItem.User -> highlightedText(item.text, highlight, Color.Unspecified).spanStyles.isNotEmpty()
    is riffet.core.TimelineItem.Assistant -> markedInMarkdown(item.text, highlight)
    is riffet.core.TimelineItem.Thought -> markedInMarkdown(item.text, highlight)
    else -> false
}

private fun markedInMarkdown(text: String, highlight: FindHighlight): Boolean {
    val prepared = cachedPreparedMarkdown(normaliseNewlines(text)) ?: return false
    return findMarks(prepared, highlight).any { !it.isNullOrEmpty() }
}
