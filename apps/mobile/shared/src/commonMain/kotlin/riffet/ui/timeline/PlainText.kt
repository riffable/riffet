package riffet.ui.timeline

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import riffet.ui.focus.SelectableText
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameMillis
import androidx.compose.ui.Modifier
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextStyle
import kotlinx.coroutines.Dispatchers
import riffet.shared.LocalNativeFeatures
import riffet.shared.NativeFeature
import riffet.ui.theme.LocalRiffetMotion
import kotlinx.coroutines.withContext

/*
 * ============================================================================================
 * Agent prose is markdown now
 * ============================================================================================
 *
 * This file used to be the *deliberate limit*: the web rendered an answer through `<Markdown>`
 * and the phone rendered plain text with paragraph breaks and stripped fences, on the reasoning
 * that a real renderer meant "a CommonMark-level parser plus inline spans (emphasis, links,
 * inline code, tables) and somewhere for a link tap to go, which is a dependency and a rendering
 * model — not something to smuggle in behind a text component."
 *
 * That reasoning has been resolved rather than repeated. `mikepenz/multiplatform-markdown-renderer`
 * *is* that parser and that rendering model, as a Compose Multiplatform library built on
 * `org.jetbrains:markdown` (the same CommonMark/GFM tree the web's `remark-gfm` produces); its
 * core artifact is deliberately Material-free and takes its colours and typography as plain data,
 * so every value can come from `RiffetColors` / `RiffetTypography`; and a link tap has a
 * destination through `LocalUriHandler`. So the decision is made, and `MarkdownRender.kt` is its
 * implementation. What follows here is the part that is *not* the library's: the split between
 * what is safe to parse and what is still arriving, and the plain renderer that keeps a
 * half-written answer readable.
 *
 * Two guarantees from the old file survived the rewrite, because they are what made it safe and
 * they are still what makes this safe:
 *
 *  - **Never drop text.** A truncated or unterminated fenced block still shows its content, and
 *    a parse failure falls back to the plain renderer instead of an empty box. The library needs
 *    two things to hold that up: `closeOpenFence` below (its `MarkdownCodeFence` computes the
 *    code slice from child offsets and loses the tail of an *unterminated* fence that contains a
 *    blank line), and `splitStreamingMarkdown` never cutting inside a fence.
 *  - **Never claim formatting was applied when it was not.** While a message is still arriving,
 *    only the settled prefix is parsed as markdown; the paragraph still being written is shown by
 *    the plain renderer below. If a construct cannot be rendered, showing it literally is correct
 *    — and during a stream, "we have not seen the end of this paragraph yet" is exactly that case.
 *
 * ## Streaming
 *
 * Assistant prose and reasoning do not arrive as one string: the same `TimelineItem`'s `text`
 * grows on every stream event, and a `remember(text)`-memoised parse re-runs on all of them (~30/s
 * on a fast model). Each run is a fresh AST for the whole answer plus a recomposition of the whole
 * tree, on a phone.
 *
 * So `PlainText` splits the text at the last blank line that is outside any fence
 * ([`splitStreamingMarkdown`]) and parses only the part before it. A parser run therefore costs one
 * *paragraph boundary*, not one stream chunk. Measured on this machine with `org.jetbrains:markdown`
 * (the parser the renderer uses), a ~10 KB answer delivered as 300 chunks:
 *
 * | shape of the answer                    | whole-doc parse per chunk | settled prefix |
 * | -------------------------------------- | ------------------------: | -------------: |
 * | 1200-character paragraphs              |                  172 ms   |        8.4 ms  |
 * | 400-character paragraphs               |                  140 ms   |        9.3 ms  |
 * | a list + a fence per paragraph (worst) |                  217 ms   |       87.5 ms  |
 *
 * and the split itself costs 3-10 µs per chunk. The answers a reader actually scrolls are 15-20x
 * cheaper to render than the naive shape, and no case is ever a whole-document parse per chunk.
 *
 * The cut is *exactly* the last finished paragraph boundary, never an arbitrary number of trailing
 * characters. An earlier version also held a fixed window of the tail back (a `MIN_LIVE_CHARS`
 * floor, so the cut advanced less often). That floor was wrong: a blank line is the only thing that
 * finishes a paragraph, so holding characters back past one does not hold back "the paragraph still
 * being written" — it holds back paragraphs that are already complete and renders them through the
 * plain fallback, where `**bold**` is literal. An answer's first paragraphs came out bold and its
 * last few did not, which is the reader-visible bug. Parsing one more prefix per blank line is the
 * price of every finished paragraph looking finished.
 *
 * The split is not a heuristic on the parser's input: the settled prefix is a prefix of the final
 * document, so the only difference between a streaming render and a settled one is that the
 * paragraph still being written briefly shows its own punctuation. When the turn ends
 * (`streaming = false` — the same `settled` flag the copy/timestamp row already uses) the whole
 * text is parsed once, exactly. The still-open tail goes through the same O(n) plain renderer this
 * file always had, so the cost per chunk is strictly *lower* than before the renderer was added.
 *
 * ## Syntax highlighting: deliberately none
 *
 * The brief cited the web as the behaviour to match. It does not highlight here either: the file
 * preview (`apps/web/src/lib/highlight.ts` + refractor, ~25 lazily-loaded grammars) is wired into
 * `ContextPanel.tsx` only, and `apps/web/src/app/session/Markdown.tsx` renders a fenced block as
 * `<pre><code>{code}</code></pre>` with a language label and a copy button — no tokenizer, no
 * `.token-*` classes. The Prism rules in `index.css` are scoped to the file preview.
 *
 * So highlighting on the phone would be a *new* divergence from the web, bought with a second
 * dependency (`multiplatform-markdown-renderer-code` pulls `dev.snipme:highlights`), a theme
 * mapping from its palette onto ours, and a per-block cache to keep it off the streaming path.
 * The honest answer is the one the web gives: monospace, `bgSubtle`, `fg2`, the language name,
 * and no colour. If the file preview's highlighting is ever wanted on the phone it should come
 * with the file preview, not with the transcript's code blocks.
 */

/** A run of prose, or a fenced code block. The plain renderer's two shapes. */
internal sealed interface TextBlock {
    data class Prose(val text: String) : TextBlock
    data class Code(val language: String?, val text: String) : TextBlock
}

/** LF-only, and allocation-free in the common case: streams almost never carry a CR. */
internal fun normaliseNewlines(text: String): String =
    if (text.indexOf('\r') < 0) text else text.replace("\r\n", "\n").replace('\r', '\n')

/** The fence still open at the end of [text], or null when every fence is closed. */
internal fun openFenceAt(text: String): Fence? {
    var open: Fence? = null
    for (line in normaliseNewlines(text).split('\n')) {
        val current = open
        when {
            current != null && closesFence(line, current) -> open = null
            current == null -> open = fenceOpener(line)
            // Inside a fence, a line that looks like an opener is content, not a new fence.
            else -> Unit
        }
    }
    return open
}

/**
 * Terminates an unterminated fence with a closing delimiter, so the parser sees the block
 * CommonMark says it is (a fence runs to the end of the document) instead of the shape the
 * renderer mis-reads.
 *
 * This is not cosmetic. `MarkdownCodeFence` takes the code as
 * `content.subSequence(children[2].startOffset, children[size - 2].endOffset)`, which assumes a
 * trailing EOL that only a *closed* fence has: on `"```kt\none\n\ntwo"` it stops at the EOL after
 * `one` and silently drops `two`. Closing the fence first is what makes "never drop text" true
 * for a truncated stream. Nothing is added to what is displayed — the appended delimiter is a
 * fence, not content.
 */
internal fun closeOpenFence(text: String): String {
    val open = openFenceAt(text) ?: return text
    return buildString(text.length + open.length + 2) {
        append(text)
        if (text.isNotEmpty() && !text.endsWith("\n")) append('\n')
        append(open.marker.toString().repeat(open.length))
        append('\n')
    }
}

/**
 * Splits [text] into prose and fenced code blocks for the plain renderer.
 *
 * An unterminated fence keeps its content and is still shown as code: a truncated stream must not
 * lose the last thing the agent wrote.
 */
internal fun splitTextBlocks(text: String): List<TextBlock> {
    val blocks = mutableListOf<TextBlock>()
    val prose = StringBuilder()
    val code = StringBuilder()
    var open: Fence? = null
    var language: String? = null

    fun flushProse() {
        val chunk = prose.toString().trim('\n', ' ', '\t')
        if (chunk.isNotEmpty()) blocks.add(TextBlock.Prose(chunk))
        prose.setLength(0)
    }

    fun flushCode() {
        blocks.add(TextBlock.Code(language, code.toString().trimEnd('\n')))
        code.setLength(0)
        language = null
    }

    for (line in normaliseNewlines(text).split('\n')) {
        val current = open
        when {
            current != null && closesFence(line, current) -> {
                flushCode()
                open = null
            }

            current != null -> code.append(line).append('\n')

            else -> {
                val opener = fenceOpener(line)
                if (opener == null) {
                    prose.append(line).append('\n')
                } else {
                    flushProse()
                    language = line.trim().drop(opener.length).trim().takeIf { it.isNotEmpty() }
                    open = opener
                }
            }
        }
    }
    if (open != null) flushCode() else flushProse()
    return blocks
}

private val PARAGRAPH_BREAK = Regex("\\n[ \\t]*\\n")

/** Splits a prose run on blank lines, which is the only block structure the plain renderer has. */
internal fun splitParagraphs(text: String): List<String> =
    text.split(PARAGRAPH_BREAK).map { it.trim('\n', ' ', '\t') }.filter { it.isNotEmpty() }

/**
 * A still-growing message cut in two: [settled] is everything up to the last blank line that is
 * outside a fence (safe to parse as a finished document), [live] is the paragraph still being
 * written (shown plain). `live` holds no paragraph that has already been finished, so nothing that
 * the parser could format is left to the plain renderer. It is only the trailing blank lines when
 * the text ends on one.
 */
internal data class StreamingText(val settled: String, val live: String)

/**
 * Cuts [text] at its last safe paragraph boundary, and nowhere earlier.
 *
 * "Safe" means outside every fence, so neither half is handed a half-open code block, and before
 * the end of the string, so the paragraph still being written is never mistaken for a settled one
 * (which is what a naive `lastIndexOf("\n\n")` does on text that has just ended a line).
 *
 * There is deliberately no minimum tail: a blank line is what ends a paragraph, so the only
 * paragraph that is not finished is the one after the last blank line. Holding a fixed number of
 * characters back instead (the old `MIN_LIVE_CHARS`) pushed complete paragraphs into the plain
 * half, where their `**bold**` rendered literally. A shorter settle window is bought by parsing a
 * prefix that is genuinely a finished document.
 *
 * Pure and O(n) with no allocation beyond the two slices, so it is cheap enough to run on every
 * stream chunk — which is exactly what `PlainText` does with it, at ~3-10 µs per call for a 10 KB
 * document.
 */
internal fun splitStreamingMarkdown(text: String): StreamingText {
    val normalised = normaliseNewlines(text)
    var open: Fence? = null
    var cut = 0
    var start = 0
    while (start <= normalised.length) {
        val newline = normalised.indexOf('\n', start)
        val end = if (newline < 0) normalised.length else newline
        // A blank line that is not the very last one is a paragraph boundary the parser has
        // finished with; `end < length` keeps the paragraph still arriving on the live side.
        if (end < normalised.length && open == null && isBlankRange(normalised, start, end)) cut = start
        // Only a line that starts like a fence can open or close one; the rest are not copied out.
        if (startsLikeFence(normalised, start, end)) {
            val line = normalised.substring(start, end)
            val current = open
            when {
                current != null && closesFence(line, current) -> open = null
                current == null -> open = fenceOpener(line)
                else -> Unit
            }
        }
        if (newline < 0) break
        start = end + 1
    }
    if (cut <= 0) return StreamingText("", normalised)
    return StreamingText(normalised.substring(0, cut).trimEnd('\n', ' '), normalised.substring(cut))
}

private fun isBlankRange(text: String, start: Int, end: Int): Boolean {
    for (index in start until end) if (!text[index].isWhitespace()) return false
    return true
}

/** The [fenceOpener] prefix test: up to three spaces, then a backtick or a tilde. */
private fun startsLikeFence(text: String, start: Int, end: Int): Boolean {
    var index = start
    while (index < end && index - start < 3 && text[index] == ' ') index++
    return index < end && (text[index] == '`' || text[index] == '~')
}

/**
 * Renders agent prose or reasoning.
 *
 * [style] and [color] belong to the caller: the transcript shows the answer at `body`/`fg` and
 * reasoning at the same `body` in `fg2`, which is the web's rule (`Markdown className="md-muted"`
 * over the same 14px/24px) and the reason two type scales never end up side by side in one column.
 *
 * [streaming] is the one piece of knowledge the caller has and this file does not: while it is
 * true the text is cut at its last safe paragraph boundary and only the settled prefix is parsed
 * (see the file comment). It defaults to false so a caller that has nothing to say about streaming
 * gets the exact, whole-document render.
 *
 * Once a row has been seen streaming, every later parse — each new settled prefix, and the whole
 * text when the turn ends — runs off the UI thread. Until it lands the row keeps the markdown it
 * already has and shows the rest plain, so the text is always all there and the reader's scroll
 * never waits on the parser.
 */
@Composable
internal fun PlainText(
    text: String,
    color: Color,
    style: TextStyle,
    codeStyle: TextStyle,
    modifier: Modifier = Modifier,
    streaming: Boolean = false,
) {
    val normalised = remember(text) { normaliseNewlines(text) }
    val target = remember(normalised, streaming) {
        if (streaming) splitStreamingMarkdown(normalised).settled else normalised
    }
    // The presenter parses each settled prefix before publishing the frame that carries it
    // (`prepareTranscriptMarkdown`), so it is read here, in the same frame; a miss is parsed off the
    // UI thread below, and until it lands the row keeps the markdown it already had.
    var parsed by remember { mutableStateOf(cachedPreparedMarkdown(target)) }
    val ready = remember(target) { cachedPreparedMarkdown(target) } ?: parsed
    if (!streaming && ready == null) {
        // Selection wraps the smallest unit that still lets a whole message be selected: this
        // row's own text tree (prose, headings, tables and code blocks alike), never the
        // `LazyColumn`, whose lazy composition a container above it is known to break.
        SelectableText(modifier = modifier) {
            MarkdownBody(text = text, color = color, style = style, codeStyle = codeStyle)
        }
        return
    }
    LaunchedEffect(target) {
        if (target.isBlank() || parsed?.source == target) return@LaunchedEffect
        // Kept as the fallback for the next prefix, should that one miss.
        cachedPreparedMarkdown(target)?.let { parsed = it; return@LaunchedEffect }
        val next = withContext(Dispatchers.Default) { prepareMarkdown(target) } // compose-pitfalls: allow — a miss of the presenter's warmup
        rememberParses(next)
        parsed = next
    }
    val shown = ready?.takeIf { normalised.startsWith(it.source) }
    val rest = if (shown == null) normalised else normalised.substring(shown.source.length)
    // One container over both halves, so a message can be selected across a paragraph boundary
    // that happens to be the streaming cut. See the non-streaming branch above for the scope.
    SelectableText(modifier = modifier) {
        // The streaming cut is a paragraph boundary, so the two halves sit a paragraph apart: the
        // text does not move when the parse catches up.
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(TimelineTheme.prose.paragraph)) {
            if (shown != null) {
                PreparedMarkdownBody(prepared = shown, color = color, style = style, codeStyle = codeStyle)
            }
            if (rest.isNotBlank()) {
                PlainBlocks(text = rest, style = style, color = color, codeStyle = codeStyle, streaming = streaming, reserveImages = true)
            }
        }
    }
}

/**
 * The pre-markdown renderer, kept for the paragraph a stream has not finished and as the fallback
 * when the parser refuses a document. Paragraph breaks and fences, nothing else.
 */
@Composable
internal fun PlainBlocks(
    text: String,
    style: TextStyle,
    color: Color,
    codeStyle: TextStyle,
    modifier: Modifier = Modifier,
    /** The text is still arriving: its last paragraph fades each new chunk in. */
    streaming: Boolean = false,
    /** Reserve standalone image rows before the background Markdown parse completes. */
    reserveImages: Boolean = false,
) {
    val blocks = remember(text, reserveImages) {
        if (reserveImages) splitStandaloneImages(text).flatMap { segment ->
            when (segment) {
                is MarkdownSegment.Image -> listOf(segment)
                is MarkdownSegment.Text -> splitTextBlocks(segment.text)
                else -> emptyList()
            }
        } else splitTextBlocks(text)
    }
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(TimelineTheme.prose.paragraph)) {
        blocks.forEachIndexed { index, block ->
            when (block) {
                is TextBlock.Prose -> Paragraphs(block.text, style, color, streaming = streaming && index == blocks.lastIndex)
                // The same block the settled markdown uses, so a fence does not restyle when it lands.
                is TextBlock.Code -> MarkdownCodeBlockView(code = block.text, language = block.language, codeStyle = codeStyle)
                is MarkdownSegment.Image -> MarkdownImage(block.alt, block.src)
                else -> Unit
            }
        }
    }
}

@Composable
private fun Paragraphs(text: String, style: TextStyle, color: Color, streaming: Boolean = false) {
    val paragraphs = remember(text) { splitParagraphs(text) }
    // The same number the markdown renderer spaces top-level blocks with (`prose.paragraph`, the
    // web's `.md p { margin: 0 0 12px }`). A smaller one here made the paragraph rhythm change the
    // moment the parse caught up.
    Column(verticalArrangement = Arrangement.spacedBy(TimelineTheme.prose.paragraph)) {
        paragraphs.forEachIndexed { index, paragraph ->
            if (streaming && index == paragraphs.lastIndex) {
                ArrivingText(paragraph, style, color)
            } else {
                Text(paragraph, style = style, color = color)
            }
        }
    }
}

/**
 * A paragraph that is still being written: each chunk appended to it fades in on its own clock,
 * so a fast stream does not flicker and a slow one still reads as arriving rather than popping.
 * Anything other than an append (the paragraph above settling, a rewrite) shows as is.
 */
@Composable
private fun ArrivingText(text: String, style: TextStyle, color: Color) {
    // This frame loop bypasses animation specs, so apply the platform scale exactly once.
    val durationScale = rememberCoroutineScope().coroutineContext[MotionDurationScale]?.scaleFactor ?: 1f
    val fadeMillis = (LocalRiffetMotion.current.SHORT * durationScale).toLong().coerceAtLeast(0L)
    val still = fadeMillis == 0L || !LocalNativeFeatures.current.isOn(NativeFeature.FADE_IN)
    // Start offset of every chunk still fading, with the frame time it arrived at (null until the next frame).
    val arrivals = remember { mutableStateListOf<Pair<Int, Long?>>() }
    // The text the last applied composition showed; plain, not state, since only composition reads it.
    val known = remember { arrayOf(text) }
    val previous = known[0]
    val changed = text != previous
    // A fade re-lays the paragraph out every frame; past a few screens of text that costs more than it shows.
    val appended = changed && !still && text.length <= ARRIVAL_MAX_CHARS && text.startsWith(previous) && text.length > previous.length
    // Recorded only once this composition is applied; until then the new chunk is drawn as pending
    // (transparent), so it never shows for a frame at full strength before its fade begins.
    SideEffect {
        if (still) arrivals.clear()
        if (changed) {
            if (appended) arrivals += previous.length to null else arrivals.clear()
            known[0] = text
        }
    }
    val fading: List<Pair<Int, Long?>> = when {
        still -> emptyList()
        appended -> arrivals + (previous.length to null)
        changed -> emptyList()
        else -> arrivals
    }
    var now by remember { mutableLongStateOf(0L) }
    LaunchedEffect(arrivals.isNotEmpty(), fadeMillis, still) {
        if (still) {
            arrivals.clear()
            return@LaunchedEffect
        }
        while (arrivals.isNotEmpty()) {
            withFrameMillis { frame ->
                now = frame
                for (index in arrivals.indices) if (arrivals[index].second == null) arrivals[index] = arrivals[index].first to frame
                arrivals.removeAll { (_, at) -> at != null && frame - at >= fadeMillis }
            }
        }
    }
    if (fading.isEmpty()) {
        Text(text, style = style, color = color)
        return
    }
    // The text is laid out once, at full strength. Each frame of a fade only repaints: the chunks
    // still arriving are erased in proportion to their age over the finished text, so nothing is
    // laid out again per frame. A chunk the layout has not been drawn for yet stays erased.
    val layoutOf = remember { arrayOfNulls<TextLayoutResult>(1) }
    val chunkPaths = remember { HashMap<Int, Path>() }
    Text(
        text = text,
        style = style,
        color = color,
        onTextLayout = { layout ->
            layoutOf[0] = layout
            chunkPaths.clear()
        },
        modifier = Modifier
            .graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }
            .drawWithContent {
                val layout = layoutOf[0]
                if (layout == null || layout.layoutInput.text.length != text.length) return@drawWithContent
                drawContent()
                val clock = now
                fading.forEachIndexed { index, (start, at) ->
                    val end = fading.getOrNull(index + 1)?.first ?: text.length
                    if (start >= end || end > text.length) return@forEachIndexed
                    val alpha = if (at == null) 0f else ((clock - at).toFloat() / fadeMillis).coerceIn(0f, 1f)
                    if (alpha >= 1f) return@forEachIndexed
                    val chunk = chunkPaths.getOrPut(start) { layout.getPathForRange(start, end) }
                    drawPath(chunk, Color.Black, alpha = 1f - alpha, blendMode = BlendMode.DstOut)
                }
            },
    )
}

private const val ARRIVAL_MAX_CHARS = 2_000
