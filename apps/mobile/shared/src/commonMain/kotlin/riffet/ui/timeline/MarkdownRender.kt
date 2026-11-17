package riffet.ui.timeline

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.height
import io.ktor.http.encodeURLPathPart
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.UriHandler
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.withStyle
import org.intellij.markdown.ast.getTextInNode
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlin.concurrent.atomics.AtomicReference
import kotlin.concurrent.atomics.ExperimentalAtomicApi
import com.mikepenz.markdown.annotator.AnnotatorSettings
import com.mikepenz.markdown.annotator.annotatorSettings
import com.mikepenz.markdown.annotator.buildMarkdownAnnotatedString
import com.mikepenz.markdown.compose.Markdown
import com.mikepenz.markdown.compose.components.markdownComponents
import com.mikepenz.markdown.compose.extendedspans.ExtendedSpans
import com.mikepenz.markdown.compose.extendedspans.RoundedCornerSpanPainter
import com.mikepenz.markdown.compose.elements.MarkdownCodeBlock
import com.mikepenz.markdown.compose.elements.MarkdownCodeFence
import com.mikepenz.markdown.model.DefaultMarkdownColors
import com.mikepenz.markdown.model.DefaultMarkdownTypography
import com.mikepenz.markdown.model.MarkdownColors
import com.mikepenz.markdown.model.MarkdownAnnotator
import com.mikepenz.markdown.model.MarkdownTypography
import com.mikepenz.markdown.model.ReferenceLinkHandlerImpl
import com.mikepenz.markdown.model.State
import com.mikepenz.markdown.model.markdownAnnotator
import com.mikepenz.markdown.model.markdownDimens
import com.mikepenz.markdown.model.markdownExtendedSpans
import com.mikepenz.markdown.model.markdownPadding
import org.intellij.markdown.MarkdownElementTypes
import org.intellij.markdown.MarkdownTokenTypes
import org.intellij.markdown.parser.MarkdownParser
import org.jetbrains.compose.resources.stringResource
import riffet.theme.RiffetColors
import riffet.theme.RiffetRadius
import riffet.ui.files.htmlPreviewSupported
import riffet_mobile.shared.generated.resources.*

/*
 * The markdown face of the transcript: `mikepenz/multiplatform-markdown-renderer`, wired to the
 * Riffet palette and to the app's own code-block treatment.
 *
 * Everything the library would otherwise decide is decided here, from the generated design tokens:
 *
 *  - colours come from `RiffetColors` — body text from the caller's `fg`/`fg2`, links `accent`,
 *    inline code and fenced code and table backgrounds `bgSubtle`, rules `line`, quote bars
 *    `lineStrong`;
 *  - type and block spacing come from the generated prose scale (`RiffetProse` through
 *    `TimelineTheme.prose`): the web's `.md` as it is laid out on a phone, so reasoning and the
 *    answer keep one scale, and lists, quotes and headings are spaced by `ProseBlocks`;
 *  - a fenced block is the web's `.md pre`: a language header with a copy button over coloured,
 *    sideways-scrolling code (`MarkdownCodeBlockView`);
 *  - a table wraps its cells instead of ellipsising them, and still scrolls horizontally when it
 *    is wider than the phone;
 *  - an image on its own line is a real image (a project path through the image route), and a
 *    link to a project file opens the file panel.
 *
 * Colour and type are plain data in this library (`MarkdownColors` / `MarkdownTypography` are
 * interfaces, not composition locals), which is why nothing here goes through `MaterialTheme`: the
 * generated palette is the only source and `riffet/ui/theme/RiffetTheme.kt` is not touched.
 */

/**
 * Renders [text] as markdown at [style] (the transcript's body scale) and [color].
 *
 * The parse never runs on the UI thread. A transcript's presenter has normally parsed [text] before
 * the row first composes ([prepareTranscriptMarkdown]), so the first frame is already the parsed
 * one. Only on a miss does the row parse on `Dispatchers.Default` and stay plain until it lands —
 * the swap is a change of height, which is why the presenter's warmup exists.
 */
@Composable
internal fun MarkdownBody(
    text: String,
    color: Color,
    style: TextStyle,
    codeStyle: TextStyle,
    modifier: Modifier = Modifier,
) {
    var prepared by remember(text) { mutableStateOf(cachedPreparedMarkdown(text)) }
    LaunchedEffect(text) {
        if (prepared != null) return@LaunchedEffect
        val next = withContext(Dispatchers.Default) { prepareMarkdown(text) } // compose-pitfalls: allow — a miss of the presenter's warmup
        rememberParses(next)
        prepared = next
    }
    if (prepared != null) PreparedMarkdownBody(prepared!!, color, style, codeStyle, modifier)
    else PlainBlocks(text = text, style = style, color = color, codeStyle = codeStyle, modifier = modifier, reserveImages = true)
}

/** A document ready to draw: fences closed, standalone images split out, every text part parsed. */
internal class PreparedMarkdown(val source: String, val segments: List<PreparedSegment>)

internal sealed interface PreparedSegment {
    /** [state] is null when the parser refused [text]; it is then drawn by the plain renderer. */
    class Text(val text: String, val state: State?) : PreparedSegment
    class Image(val alt: String, val src: String) : PreparedSegment
    class Math(val tex: String, val display: Boolean) : PreparedSegment
    class Visualization(val path: String, val title: String?) : PreparedSegment
}

/**
 * Everything [MarkdownBody] does before drawing. It touches no composition state, so a streaming
 * row runs it on a background thread; [parse] is where the UI thread's cache comes in.
 */
internal fun prepareMarkdown(source: String, parse: (String) -> State? = ::parseOffMainThread): PreparedMarkdown {
    // `closeOpenFence` before the parse, not after: the renderer's fenced-code slice loses the tail
    // of an unterminated fence, and an unterminated fence is the normal shape mid-stream.
    val document = closeOpenFence(normaliseNewlines(source))
    // Math first, then standalone images, so a formula's own lines are never scanned as prose: each
    // splitter only ever sees `Text` segments from the one before it.
    val segments = splitVisualizationReferences(document).flatMap { segment ->
        if (segment is MarkdownSegment.Text) splitStandaloneImages(segment.text) else listOf(segment)
    }.flatMap { segment ->
        when (segment) {
            is MarkdownSegment.Text -> splitBlockMath(segment.text)
            else -> listOf(segment)
        }
    }
    if (segments.size == 1 && segments[0] is MarkdownSegment.Text) {
        return PreparedMarkdown(source, listOf(PreparedSegment.Text(document, parse(document))))
    }
    return PreparedMarkdown(
        source,
        segments.map { segment ->
            when (segment) {
                is MarkdownSegment.Text -> PreparedSegment.Text(segment.text, parse(segment.text))
                is MarkdownSegment.Image -> PreparedSegment.Image(segment.alt, segment.src)
                is MarkdownSegment.Math -> PreparedSegment.Math(segment.tex, segment.display)
                is MarkdownSegment.Visualization -> PreparedSegment.Visualization(segment.path, segment.title)
            }
        },
    )
}

/** Hands a background parse to the shared cache, so the row scrolling back in reuses it. */
internal fun rememberParses(prepared: PreparedMarkdown) = rememberParses(listOf(prepared))

/**
 * Publishes [batch] in one swap, last entry newest. The map is never mutated once published, so
 * the UI thread reads it without a lock while the presenter's warmup ([prepareTranscriptMarkdown])
 * and a row's own fallback parse add to it from their threads.
 */
@OptIn(ExperimentalAtomicApi::class)
internal fun rememberParses(batch: List<PreparedMarkdown>) {
    if (batch.isEmpty()) return
    while (true) {
        val current = preparedCache.load()
        val next = LinkedHashMap<String, PreparedMarkdown>(current)
        for (prepared in batch) {
            next.remove(prepared.source)
            next[prepared.source] = prepared
        }
        while (next.size > PARSE_CACHE_SIZE) next.remove(next.keys.first())
        if (preparedCache.compareAndSet(current, next)) return
    }
}

@OptIn(ExperimentalAtomicApi::class)
private val preparedCache = AtomicReference<Map<String, PreparedMarkdown>>(emptyMap())
private const val PARSE_CACHE_SIZE = 256

@OptIn(ExperimentalAtomicApi::class)
internal fun cachedPreparedMarkdown(source: String): PreparedMarkdown? = preparedCache.load()[source]

@Composable
internal fun PreparedMarkdownBody(
    prepared: PreparedMarkdown,
    color: Color,
    style: TextStyle,
    codeStyle: TextStyle,
    modifier: Modifier = Modifier,
) {
    val segments = prepared.segments
    val files = LocalFileAccess.current
    val system = LocalUriHandler.current
    // A link that names a file in the project opens it in the file panel, as on the web.
    val uriHandler = remember(files, system) {
        object : UriHandler {
            override fun openUri(uri: String) {
                val destination = markdownLinkDestination(uri)
                when (val target = markdownLinkTarget(destination)) {
                    is MarkdownLinkTarget.File -> if (files != null) files.open(files.resolve(target.link.path), target.link.line) else runCatching { system.openUri(destination) }
                    MarkdownLinkTarget.Web -> runCatching { system.openUri(destination) }
                    MarkdownLinkTarget.Text -> Unit
                }
            }
        }
    }
    // Null for every row but the find target: only that row's parsed text is marked.
    val find = LocalFindHighlight.current
    val marks = remember(prepared, find) { find?.let { findMarks(prepared, it) } }
    CompositionLocalProvider(LocalUriHandler provides uriHandler) {
        val only = segments.singleOrNull()
        if (only is PreparedSegment.Text) {
            MarkdownDocument(only.text, only.state, color, style, codeStyle, modifier, marks?.getOrNull(0))
        } else {
            // The same rhythm the parsed blocks use: these segments are paragraphs that arrived apart.
            Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(TimelineTheme.prose.paragraph)) {
                segments.forEachIndexed { index, segment ->
                    when (segment) {
                        is PreparedSegment.Text -> MarkdownDocument(segment.text, segment.state, color, style, codeStyle, Modifier, marks?.getOrNull(index))
                        is PreparedSegment.Image -> MarkdownImage(segment.alt, segment.src)
                        is PreparedSegment.Math -> MathFormula(tex = segment.tex, display = segment.display, color = color, modifier = Modifier)
                        is PreparedSegment.Visualization -> Text(
                            stringResource(
                                Res.string.timeline_interactive_preview,
                                segment.title ?: segment.path.substringAfterLast('/'),
                            ),
                            style = style,
                            color = if (files != null) TimelineTheme.colors.accent else color,
                            modifier = Modifier.fillMaxWidth().clickable(
                                enabled = files != null,
                                role = Role.Button,
                                onClickLabel = stringResource(Res.string.timeline_open_interactive_preview),
                            ) { files?.openVisualization(segment.path) },
                        )
                    }
                }
            }
        }
    }
}

/** The web's `MarkdownImage`: a local path loads through the project's image route. */
@Composable
internal fun MarkdownImage(alt: String, src: String) {
    val files = LocalFileAccess.current
    val path = localImagePath(src)
    if (htmlPreviewSupported && path?.substringAfterLast('.')?.lowercase() == "svg" && files != null) {
        ServerContentPreview("/api/projects/${files.projectId.encodeURLPathPart()}/file/raw", parameters = listOf("path" to path), modifier = Modifier.fillMaxWidth().height(320.dp))
        return
    }
    val source = when {
        src.startsWith("data:image/") -> ImageSource.DataUrl(src)
        path != null && files != null -> ImageSource.ProjectFile(files.projectId, path)
        src.startsWith("/api/") -> ImageSource.ServerPath(src)
        path == null -> ImageSource.Web(src)
        else -> null
    }
    val label = path ?: alt.ifEmpty { stringResource(Res.string.timeline_image) }
    if (source == null) {
        Text(label, style = TimelineTheme.type.caption, color = TimelineTheme.colors.fg3)
        return
    }
    FlexibleImage(
        source = source,
        label = label,
        maxHeight = 448.dp,
        onDownload = if (path != null && files?.canDownload == true) ({ files.download(path) }) else null,
    )
}

@Composable
private fun MarkdownDocument(
    document: String,
    state: State?,
    color: Color,
    style: TextStyle,
    codeStyle: TextStyle,
    modifier: Modifier,
    /** Text leaves (by source offset) to draw with the find mark, as `[start, end)` within the leaf. */
    marks: Map<Int, Pair<Int, Int>>? = null,
) {
    val colors = TimelineTheme.colors
    val prose = TimelineTheme.prose
    if (state == null) {
        PlainBlocks(text = document, style = style, color = color, codeStyle = codeStyle, modifier = modifier)
        return
    }
    val typography = remember(colors, prose, style) { markdownTypography(colors, prose, style) }
    val markdownColors = remember(colors, color) { markdownColors(colors, color) }
    val quoteColors = remember(colors) { markdownColors(colors, colors.fg2) }
    // The library's annotator is kept for everything but `**strong**` (Medium, since CJK at 600
    // reads as a smudge) and safe `<br>` line-break tags. Re-entering the annotation for strong
    // spans needs the settings the library builds inside `Markdown`, so `success` hands them over
    // before any text is annotated.
    val settings = remember { arrayOfNulls<AnnotatorSettings>(1) }
    val findMark = colors.warningSoft
    val annotator = remember(marks, findMark) {
        markdownAnnotator { content, child ->
            if (child.type == MarkdownTokenTypes.HTML_TAG) {
                val breaks = safeBreakNewlines(child.getTextInNode(content).toString())
                if (breaks != null) {
                    append(breaks)
                    return@markdownAnnotator true
                }
            }
            val marked = marks?.get(child.startOffset)
            if (marked != null && isMarkableLeaf(child.type)) {
                val leaf = child.getTextInNode(content).toString()
                append(leaf.substring(0, marked.first))
                withStyle(SpanStyle(background = findMark)) { append(leaf.substring(marked.first, marked.second)) }
                append(leaf.substring(marked.second))
                return@markdownAnnotator true
            }
            val current = settings[0]
            if (child.type != MarkdownElementTypes.STRONG || current == null) return@markdownAnnotator false
            pushStyle(SpanStyle(fontWeight = FontWeight.Medium))
            buildMarkdownAnnotatedString(content = content, node = child, annotatorSettings = current)
            pop()
            true
        }
    }
    val components = remember(colors, prose, codeStyle, quoteColors, annotator) {
        transcriptComponents(prose, codeStyle, quoteColors, annotator)
    }
    // The web's inline code chip: rounded, and only as tall as the code, not the whole line box.
    val extendedSpans = markdownExtendedSpans {
        remember(prose) {
            val inset = ((prose.body.lineHeight.value - prose.code.fontSize.value) / 2f - 2f).coerceAtLeast(0f).sp
            ExtendedSpans(RoundedCornerSpanPainter(cornerRadius = 5.sp, padding = RoundedCornerSpanPainter.TextPaddingValues(), topMargin = inset, bottomMargin = inset))
        }
    }
    Markdown(
        state = state,
        colors = markdownColors,
        typography = typography,
        modifier = modifier.fillMaxWidth(),
        // Block spacing is `ProseBlocks`'; the library's own spacers stay at zero so nothing doubles it.
        padding = markdownPadding(
            block = 0.dp,
            list = 0.dp,
            listItemTop = 0.dp,
            listItemBottom = 0.dp,
            listIndent = 0.dp,
            // Unused: our own `CodeBlock` owns its padding and corners.
            codeBlock = PaddingValues(0.dp),
        ),
        dimens = markdownDimens(
            dividerThickness = 1.dp,
            codeBackgroundCornerSize = RiffetRadius.md,
            blockQuoteThickness = 2.dp,
            // `tableCellWidth` is the column width below which the table scrolls instead of
            // squeezing: three columns of 13sp text still fit a phone, a fourth scrolls.
            tableCellWidth = 104.dp,
            tableCellPadding = prose.tableCellHorizontal,
            tableCornerSize = RiffetRadius.lg,
        ),
        annotator = annotator,
        extendedSpans = extendedSpans,
        components = components,
        imageTransformer = remember { TranscriptImageTransformer() },
        // The library's `MarkdownSuccess` puts one spacer before every top-level child, the first
        // included, and spaces the parse's `EOL` nodes (a blank line) as blocks too. `ProseDocument`
        // spaces only blocks, only between two of them, by what they are.
        success = { success, successComponents, successModifier ->
            settings[0] = annotatorSettings()
            CompositionLocalProvider(LocalFindLeaves provides marks?.keys) {
                ProseDocument(success.node, success.content, successComponents, successModifier)
            }
        },
        // Unreachable: `state` above is only ever a `State.Success`. Spelled out rather than left
        // to the library's empty `Box`, so a future change to the parse cannot blank the text.
        error = { PlainBlocks(text = document, style = style, color = color, codeStyle = codeStyle) },
    )
}

/** The library's components with the transcript's lists, quotes, code blocks, tables and images. */
private fun transcriptComponents(
    prose: ProseScale,
    codeStyle: TextStyle,
    quoteColors: MarkdownColors,
    annotator: MarkdownAnnotator,
) =
    markdownComponents(
        codeFence = { model ->
            MarkdownCodeFence(model.content, model.node, style = codeStyle) { code, language, _ ->
                MarkdownCodeBlockView(code = code, language = language, codeStyle = codeStyle)
            }
        },
        codeBlock = { model ->
            MarkdownCodeBlock(model.content, model.node, style = codeStyle) { code, language, _ ->
                MarkdownCodeBlockView(code = code, language = language, codeStyle = codeStyle)
            }
        },
        orderedList = { model -> ProseList(model.content, model.node, ordered = true) },
        unorderedList = { model -> ProseList(model.content, model.node, ordered = false) },
        blockQuote = { model -> ProseQuote(model.content, model.node, quoteColors) },
        table = { model ->
            TranscriptMarkdownTable(
                content = model.content,
                node = model.node,
                style = model.typography.table,
                cellPadding = PaddingValues(horizontal = prose.tableCellHorizontal, vertical = prose.tableCellVertical),
                annotator = annotator,
            )
        },
    )

private val SafeBreakBlock = Regex("""^(?:<br\s*/?>\s*)+$""", RegexOption.IGNORE_CASE)
private val SafeBreakTag = Regex("""<br\s*/?>""", RegexOption.IGNORE_CASE)

/** Returns `\n` per `<br>` when [rawHtml] contains only `<br>` tags, or null for any other HTML. */
internal fun safeBreakNewlines(rawHtml: String): String? {
    val trimmed = rawHtml.trim()
    if (trimmed.isEmpty() || !SafeBreakBlock.matches(trimmed)) return null
    val count = SafeBreakTag.findAll(trimmed).count().coerceAtLeast(1)
    return "\n".repeat(count)
}

/** Each background job owns its parser instance; no parser state crosses workers. */
private fun parseOffMainThread(document: String): State? =
    runCatching { parseMarkdown(document, MarkdownParser(TranscriptMarkdownFlavour())) }.getOrNull()

private fun parseMarkdown(content: String, parser: MarkdownParser): State = State.Success(
    node = parser.buildMarkdownTreeFromString(content),
    content = content,
    // Reference-style link definitions are not pre-scanned (the library's `lookupLinkDefinition` is
    // internal), so `MarkdownElement` stores them as it walks. A definition used before it appears
    // is rendered literally by the library, which is the honest outcome for a rare construct.
    linksLookedUp = false,
    referenceLinkHandler = ReferenceLinkHandlerImpl(),
)

/**
 * The palette half of the theme. Code, inline-code, link and table text take their colour from the
 * matching `MarkdownTypography` style below, not from here.
 */
private fun markdownColors(colors: RiffetColors, text: Color): MarkdownColors = DefaultMarkdownColors(
    text = text,
    codeBackground = colors.bgSubtle,
    // The web's `.md :not(pre) > code` and the Mac scale: the quiet chip, so a path-dense
    // paragraph does not read as a row of buttons.
    inlineCodeBackground = colors.bgSubtle,
    dividerColor = colors.line,
    tableBackground = colors.bgSubtle,
)

/** One heading step, in Medium: size carries the rank, and CJK at 600 is too heavy. */
private fun heading(style: TextStyle, color: Color): TextStyle = style.copy(fontWeight = FontWeight.Medium, color = color)

/**
 * The type half of the theme, from the generated prose scale (`RiffetProse`, the web's `.md` on a
 * phone: a 15sp body, headings 20/17/15sp, 12.5sp code).
 *
 * `base` is the caller's style — the answer's and the reasoning's own body, never a second scale.
 * Headings keep `fg` even inside reasoning, which is what the web does: `.md h1 { color: var(--fg) }`
 * outranks `.md-muted`.
 */
private fun markdownTypography(
    colors: RiffetColors,
    prose: ProseScale,
    base: TextStyle,
): MarkdownTypography = DefaultMarkdownTypography(
    h1 = heading(prose.h1, colors.fg),
    h2 = heading(prose.h2, colors.fg),
    h3 = heading(prose.h3, colors.fg),
    h4 = heading(prose.h4, colors.fg),
    h5 = heading(prose.h4, colors.fg),
    h6 = heading(prose.h4, colors.fg),
    text = base,
    code = prose.code.copy(color = colors.fg2),
    // The web's `.md :not(pre) > code { background: bg-subtle; color: fg; font-size: 12.5px }`; the
    // chip itself is drawn by the rounded span painter.
    inlineCode = prose.code.copy(color = colors.fg),
    // Only the quote *bar* would be drawn from this style; `ProseQuote` draws its own.
    quote = base.copy(color = colors.lineStrong),
    paragraph = base,
    ordered = base.copy(color = colors.fg3),
    bullet = base.copy(color = colors.fg3),
    list = base,
    // The web's `.md a`: accent, no underline (it underlines only on hover). Colour is the
    // affordance; an underline under every file citation turned a list of them into a wall of rules.
    textLink = TextLinkStyles(style = SpanStyle(color = colors.accent)),
    // `.md table { font-size: 13px; line-height: 20px }`.
    table = prose.table,
)
