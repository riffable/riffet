package riffet.ui.timeline

import riffet.ui.design.LocalRiffetSurfaces
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.theme.LocalRiffetMotion
import riffet.ui.theme.visualWorkVisibility
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import riffet.core.TimelineItem
import riffet.ui.focus.SelectableText
import riffet.ui.design.RiffetProgressIndicator as CircularProgressIndicator
import riffet.ui.icons.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.verticalScroll
import kotlinx.coroutines.delay
import riffet.ui.theme.RiffetTypography
import riffet.ui.files.htmlPreviewSupported
import riffet.ui.icons.RiffetIcons
import riffet.ui.pickers.RiffetDropdownMenu
import riffet.ui.pickers.RiffetMenuItem
import riffet_mobile.shared.generated.resources.*
import org.jetbrains.compose.resources.stringResource

/*
 * The small shared pieces every row is built from.
 *
 * Marks are shapes (a dot, a ring, a progress arc) or `RiffetIcons` vectors. Text characters are
 * only used where they are text — a diff's `+`/`−` gutter, a shell's `$` — never as icons, because
 * their size and baseline depend on whichever fallback font the device picks.
 */

/** A leading state dot: running, succeeded, failed, idle. */
@Composable
internal fun StatusDot(color: Color, size: Dp = 6.dp) {
    Box(Modifier.size(size).clip(CircleShape).background(color))
}

/** A row's leading mark: the spinner while [running], then [idle], cross-fading when the state changes. */
@Composable
internal fun RunningMark(running: Boolean, idle: @Composable () -> Unit) {
    val motion = LocalRiffetMotion.current
    Crossfade(targetState = running, animationSpec = motion.short(), label = "running") { active ->
        if (active) Spinner() else idle()
    }
}

/** The running indicator: Material 3's indeterminate spinner, at transcript scale. */
@Composable
internal fun Spinner(size: Dp = 14.dp) {
    CircularProgressIndicator(
        modifier = Modifier.size(size),
        color = TimelineTheme.colors.accent,
        strokeWidth = 1.5.dp,
    )
}

/**
 * The disclosure mark: one chevron that rotates a quarter turn to point down when [open].
 *
 * A rotation rather than a glyph swap, so the two states are visibly the same mark turning — the
 * web's `Collapse` does the same. A vector, not a `▸` character: font fallback gives that glyph a
 * different size and baseline on every device, and a rotating text box wobbles around its own
 * line height. Reduced motion collapses the turn to a single frame.
 */
@Composable
internal fun Chevron(
    open: Boolean,
    size: Dp = 14.dp,
    tint: Color = TimelineTheme.colors.fg4,
    /** A dock's mark is a down chevron that flips to point up: pass `ChevronDown` and an [openAngle] of 180. */
    icon: ImageVector = RiffetIcons.ChevronRight,
    openAngle: Float = 90f,
    description: String? = null,
) {
    val motion = LocalRiffetMotion.current
    val reduced = rememberReducedMotion()
    val angle by animateFloatAsState(
        targetValue = if (open) openAngle else 0f,
        animationSpec = tween(durationMillis = motionDuration(reduced, motion.SHORT), easing = motion.Standard),
        label = "chevron",
    )
    Icon(
        imageVector = icon,
        contentDescription = description,
        tint = tint,
        modifier = Modifier.size(size).graphicsLayer { rotationZ = angle },
    )
}

/** A `bg-muted` chip: a path, a shell id, a count. Optionally tappable. */
@Composable
internal fun Chip(
    text: String,
    mono: Boolean = false,
    onClick: (() -> Unit)? = null,
) {
    val colors = TimelineTheme.colors
    Text(
        text = text,
        style = if (mono) TimelineTheme.type.codeSmall else TimelineTheme.type.caption,
        color = colors.fg2,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier
            .clip(RoundedCornerShape(LocalInterfaceStyle.current.controlRadius))
            .background(LocalRiffetSurfaces.current.floating)
            .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier)
            .padding(horizontal = 6.dp, vertical = 3.dp),
    )
}

/**
 * The web's `LocationChip`: a file icon and `path:line` that opens the file, then copy and
 * download. Without a project there is nothing to open, and it is a plain chip.
 */
@Composable
internal fun PathChip(path: String, line: Long?, onOpenFile: (String, Int?) -> Unit) {
    val designMetrics = LocalInterfaceStyle.current.metrics
    val colors = TimelineTheme.colors
    val files = LocalFileAccess.current
    val label = if (line != null) "$path:$line" else path
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .clip(RoundedCornerShape(LocalInterfaceStyle.current.controlRadius))
            .background(LocalRiffetSurfaces.current.floating)
            .heightIn(min = designMetrics.controlHeight),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .weight(1f, fill = false)
                .heightIn(min = designMetrics.controlHeight)
                .clickable(role = Role.Button) { onOpenFile(path, line?.toInt()) }
                .padding(start = 8.dp, end = 4.dp),
        ) {
            Icon(RiffetIcons.FileText, contentDescription = null, tint = colors.fg3, modifier = Modifier.size(12.dp))
            Spacer(Modifier.width(4.dp))
            Text(
                text = label,
                style = TimelineTheme.type.codeSmall,
                color = colors.fg2,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        // 32dp, the chip's own height: the two sit side by side, so each takes all the room it has.
        CopyTextButton(path, stringResource(Res.string.timeline_copy_path), size = 32.dp)
        if (files != null) FileDownloadButton(path, size = 32.dp)
    }
}

/** The web's `FileDownloadButton`; nothing outside a project, where there is no file route. */
@Composable
internal fun FileDownloadButton(path: String, size: Dp = 32.dp) {
    // Nowhere to save it: no dead button (see `FileAccess.canDownload`).
    val files = LocalFileAccess.current?.takeIf { it.canDownload } ?: return
    IconAction(RiffetIcons.Download, stringResource(Res.string.timeline_download_file), size) { files.download(path) }
}

/**
 * Puts a message into the composer as a quote. Provided by the session screen; a transcript with
 * no composer under it (a subagent's page) leaves it null and shows no button.
 */
internal val LocalQuote = staticCompositionLocalOf<((String) -> Unit)?> { null }
internal val LocalRunRecoveryStore = staticCompositionLocalOf<riffet.ui.state.SessionStore?> { null }
internal val LocalRestoreNativeRun = staticCompositionLocalOf<((riffet.contracts.Run) -> Unit)?> { null }

/** Saving and unsaving an answer (收藏), provided by a transcript whose host has a [riffet.ui.state.SessionMarks]. */
internal class MarkActions(
    val marked: (TimelineItem) -> Boolean,
    val toggle: (TimelineItem, String) -> Unit,
)
internal val LocalMarkActions = staticCompositionLocalOf<MarkActions?> { null }

/**
 * How far the ⋯ glyph's ink sits inside [MessageMenuButton]: the 14dp icon is centred in the 22dp
 * wide slot (4dp), and lucide's outer dots start 4 of 24 units in (~2.3dp). A row that leads with
 * the button shifts left by this so the dots line up with the text above (whose glyphs carry ~1dp
 * of side bearing of their own).
 */
internal val MessageMenuInkInset = 5.dp

private val MessageMenuSlotWidth = 22.dp

/**
 * A message's ⋯ button and the menu of what can be done with it; a new action is one more row here.
 * Narrow in the row rather than square: a square slot's side padding is what pushed the timestamp
 * away. The touch target is still 32dp square, overhanging the slot by 5dp on each side.
 */
@Composable
internal fun MessageMenuButton(
    text: String,
    onRestore: (() -> Unit)? = null,
    /** The answer already has a saved reply (收藏). */
    marked: Boolean = false,
    /** Null when this row cannot be marked (no host, or a provisional message id). */
    onToggleMark: (() -> Unit)? = null,
) {
    val clipboard = LocalClipboardManager.current
    val quote = LocalQuote.current
    val moreActions = stringResource(Res.string.timeline_more_actions)
    var open by remember { mutableStateOf(false) }
    // The menu anchors to this Box, so it opens at the button rather than at the row's start.
    Box {
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .layout { measurable, _ ->
                    val target = measurable.measure(Constraints())
                    val slot = MessageMenuSlotWidth.roundToPx()
                    layout(slot, target.height) { target.place((slot - target.width) / 2, 0) }
                }
                .size(32.dp)
                .clip(RoundedCornerShape(LocalInterfaceStyle.current.controlRadius))
                .clickable(onClickLabel = moreActions, role = Role.Button) { open = true },
        ) {
            Icon(RiffetIcons.Ellipsis, contentDescription = moreActions, tint = TimelineTheme.colors.fg3, modifier = Modifier.size(14.dp))
        }
        RiffetDropdownMenu(
            expanded = open,
            onDismissRequest = { open = false },
            offset = DpOffset(0.dp, (-4).dp),
            modifier = Modifier.width(168.dp),
        ) {
            RiffetMenuItem(text = stringResource(Res.string.timeline_copy), icon = RiffetIcons.Copy, onClick = {
                open = false
                clipboard.setText(AnnotatedString(text))
            })
            if (quote != null) {
                RiffetMenuItem(text = stringResource(Res.string.timeline_quote), icon = RiffetIcons.Reply, onClick = {
                    open = false
                    quote(text)
                })
            }
            if (onToggleMark != null) {
                RiffetMenuItem(
                    text = stringResource(if (marked) Res.string.timeline_unmark_reply else Res.string.timeline_mark_reply),
                    icon = RiffetIcons.Bookmark,
                    onClick = {
                        open = false
                        onToggleMark()
                    },
                )
            }
            if (onRestore != null) {
                RiffetMenuItem(text = stringResource(Res.string.timeline_restore_unsent), icon = RiffetIcons.Reply, onClick = {
                    open = false
                    onRestore()
                })
            }
        }
    }
}

@Composable
private fun IconAction(icon: ImageVector, label: String, size: Dp, tint: Color? = null, swap: Boolean = false, onClick: () -> Unit) {
    val motion = LocalRiffetMotion.current
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .size(size)
            .clip(RoundedCornerShape(LocalInterfaceStyle.current.controlRadius))
            .clickable(role = Role.Button, onClickLabel = label, onClick = onClick),
    ) {
        val tinted = tint ?: TimelineTheme.colors.fg3
        if (swap) {
            // The icon changing in place (copy to check) cross-fades instead of snapping.
            Crossfade(targetState = icon to tinted, animationSpec = motion.short(), label = "icon") { (shown, color) ->
                Icon(shown, contentDescription = label, tint = color, modifier = Modifier.size(14.dp))
            }
        } else {
            Icon(icon, contentDescription = label, tint = tinted, modifier = Modifier.size(14.dp))
        }
    }
}

/** The web's `CodeBlock` line box: `text-xs leading-[18px]`. */
internal val RiffetTypography.codeBlock: TextStyle get() = codeSmall.copy(lineHeight = 20.sp)

/**
 * The web's `<pre>` in a tool row: `bg-subtle`, monospace, wrapping rather than
 * scrolling sideways, and capped at [maxHeight] with its own scroll so one long output cannot
 * push the rest of the turn off screen. No frame: the tint is the boundary.
 */
@Composable
internal fun CodeBlock(
    text: String,
    language: String? = null,
    prefix: String? = null,
    textStyle: TextStyle? = null,
    background: Color? = null,
    foreground: Color? = null,
    maxHeight: Dp = 288.dp,
    rounded: Boolean = true,
    modifier: Modifier = Modifier,
) {
    val colors = TimelineTheme.colors
    val codeColors = TimelineTheme.codeColors
    val style = textStyle ?: TimelineTheme.type.codeBlock
    val shape = if (rounded) RoundedCornerShape(LocalInterfaceStyle.current.controlRadius) else RectangleShape
    val body = remember(text, prefix, language, colors, codeColors) {
        buildAnnotatedString {
            if (prefix != null) withStyle(SpanStyle(color = colors.fg4)) { append(prefix) }
            append(if (isHighlightable(language)) highlightCode(text, language, colors, codeColors) else AnnotatedString(text))
        }
    }
    Box(
        modifier = modifier
            .fillMaxWidth()
            .clip(shape)
            .background(background ?: LocalRiffetSurfaces.current.card)
            .heightIn(max = maxHeight)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 12.dp, vertical = 8.dp),
    ) {
        // Tool output, a shell command, raw params, a diff's fallback body: the text people came to
        // copy. The container wraps the code text only — the rounded box, its scroll and its
        // height cap stay outside — so long-press yields the platform menu without disturbing the
        // scroll. One container per code block, and code blocks live inside a row, never above the
        // `LazyColumn`.
        SelectableText {
            Text(body, style = style, color = foreground ?: colors.fg2)
        }
    }
}

/**
 * A fenced block in markdown: the web's `.md pre` — a header with the language and a copy button
 * over the code, which keeps its lines and scrolls sideways rather than wrapping.
 */
@Composable
internal fun MarkdownCodeBlockView(code: String, language: String?, codeStyle: TextStyle) {
    // Some agents cite code as ```218:228:path/to/file.ts — a line range and a file, not a language.
    val cited = remember(language) { language?.let(::codeCitation) }
    val label = cited?.let { "${it.path} · L${it.start}–${it.end}" } ?: (language?.takeIf { it.isNotBlank() } ?: "text").uppercase()
    val codeLanguage = cited?.let { languageForPath(it.path) } ?: language
    val designMetrics = LocalInterfaceStyle.current.metrics
    val colors = TimelineTheme.colors
    val shape = RoundedCornerShape(LocalInterfaceStyle.current.controlRadius)
    val diagram = codeLanguage?.lowercase() in diagramLanguages
    val renderable = htmlPreviewSupported && (diagram || codeLanguage?.lowercase() in contentPreviewLanguages)
    var preview by remember(codeLanguage) { mutableStateOf(diagram && htmlPreviewSupported) }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(LocalRiffetSurfaces.current.card),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            // The web's `.md-code-head`: its own `bg-muted` surface, so the chrome does not sit on the code.
            modifier = Modifier.fillMaxWidth().height(36.dp).background(LocalRiffetSurfaces.current.floating).padding(start = 12.dp, end = 2.dp),
        ) {
            Text(
                text = label,
                style = TimelineTheme.type.caption.copy(fontFamily = TimelineTheme.type.monoFamily, letterSpacing = if (cited != null) 0.sp else 0.5.sp),
                color = colors.fg3,
                maxLines = 1,
                // A cited path keeps its file name and lines; a language name is short.
                overflow = if (cited != null) TextOverflow.StartEllipsis else TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (renderable) {
                Chip(
                    text = stringResource(if (preview) Res.string.timeline_source else Res.string.timeline_preview),
                    onClick = { preview = !preview },
                )
            }
            CopyTextButton(code, stringResource(Res.string.timeline_copy_code), size = 34.dp)
        }
        Box(Modifier.fillMaxWidth().height(designMetrics.hairlineWidth).background(colors.lineSoft))
        if (renderable && preview) {
            ServerContentPreview(path = if (diagram) "/diagram" else "/content-preview", source = code, language = codeLanguage?.lowercase(), modifier = Modifier.fillMaxWidth().height(320.dp))
        } else CodeLines(
            code = code,
            language = codeLanguage,
            style = codeStyle.copy(lineHeight = 20.sp),
            color = colors.fg,
            modifier = Modifier
                .horizontalScroll(rememberScrollState())
                .padding(horizontal = 14.dp, vertical = 12.dp),
        )
    }
}

internal class CodeCitation(val start: Int, val end: Int, val path: String)

/** A fence's info string as `start:end:path` (the web's `citation`), or null for a language. */
internal fun codeCitation(info: String): CodeCitation? {
    val match = Regex("""^(\d+):(\d+):(.+)$""").find(info.trim()) ?: return null
    val start = match.groupValues[1].toIntOrNull() ?: return null
    val end = match.groupValues[2].toIntOrNull() ?: return null
    return CodeCitation(start, end, match.groupValues[3])
}

/** Lines per separately laid-out piece of a code block; see [CodeLines]. */
private const val CODE_PIECE_LINES = 24

/**
 * A code block's lines as pieces of [CODE_PIECE_LINES] lines, each its own `Text`.
 *
 * A block that is still streaming grows by a few characters per frame. As one `Text`, each of
 * those frames re-highlighted and re-laid-out every line, so a long block slowed down the whole
 * app as it grew. Complete pieces never change, so only the last one is redone. They are
 * highlighted together, so a string or comment that crosses pieces keeps its colour; the piece
 * still being written is highlighted alone until it completes.
 */
@Composable
private fun CodeLines(code: String, language: String?, style: TextStyle, color: Color, modifier: Modifier) {
    val colors = TimelineTheme.colors
    val codeColors = TimelineTheme.codeColors
    val split = remember(code) { completePiecesEnd(code) }
    val head = if (split < 0) "" else code.substring(0, split)
    val tail = if (split < 0) code else code.substring(split + 1)
    val pieces = remember(head, language, colors, codeColors) {
        if (head.isEmpty()) emptyList() else splitPieces(highlightCode(head, language, colors, codeColors))
    }
    val last = remember(tail, language, colors, codeColors) { highlightCode(tail, language, colors, codeColors) }
    val count = pieces.size + 1
    Column(modifier) {
        pieces.forEachIndexed { index, piece ->
            Text(text = piece, style = style.pieceOf(index, count), color = color, softWrap = false)
        }
        Text(text = last, style = style.pieceOf(count - 1, count), color = color, softWrap = false)
    }
}

/**
 * Where the complete pieces end: the newline after line `k * CODE_PIECE_LINES` that leaves the
 * last piece between one and [CODE_PIECE_LINES] lines long, or -1 when there is only one piece.
 */
private fun completePiecesEnd(code: String): Int {
    var newlines = 0
    for (char in code) if (char == '\n') newlines++
    val complete = newlines / CODE_PIECE_LINES
    if (complete == 0) return -1
    var remaining = complete * CODE_PIECE_LINES
    var index = -1
    while (remaining > 0) {
        index = code.indexOf('\n', index + 1)
        remaining--
    }
    return index
}

/** [text] cut every [CODE_PIECE_LINES] lines, its colour spans dealt out to the pieces in one pass. */
internal fun splitPieces(text: AnnotatedString): List<AnnotatedString> {
    val source = text.text
    val starts = ArrayList<Int>().apply { add(0) }
    val ends = ArrayList<Int>()
    var lines = 0
    var index = source.indexOf('\n')
    while (index >= 0) {
        lines++
        if (lines == CODE_PIECE_LINES) {
            ends += index
            starts += index + 1
            lines = 0
        }
        index = source.indexOf('\n', index + 1)
    }
    ends += source.length
    val spans = List(starts.size) { ArrayList<AnnotatedString.Range<SpanStyle>>() }
    var piece = 0
    for (span in text.spanStyles.sortedBy { it.start }) {
        while (piece < ends.size - 1 && span.start > ends[piece]) piece++
        var covered = piece
        while (covered < starts.size && starts[covered] < span.end) {
            val start = maxOf(span.start, starts[covered])
            val end = minOf(span.end, ends[covered])
            if (end > start) spans[covered] += AnnotatedString.Range(span.item, start - starts[covered], end - starts[covered])
            covered++
        }
    }
    return starts.indices.map { AnnotatedString(source.substring(starts[it], ends[it]), spans[it]) }
}

/**
 * The line-height trim that makes stacked pieces read as one `Text`: the default trims the top of
 * the first line and the bottom of the last, so only the block's outer edges may be trimmed.
 */
private fun TextStyle.pieceOf(index: Int, count: Int): TextStyle {
    if (count == 1) return this
    val trim = when (index) {
        0 -> LineHeightStyle.Trim.FirstLineTop
        count - 1 -> LineHeightStyle.Trim.LastLineBottom
        else -> LineHeightStyle.Trim.None
    }
    return copy(lineHeightStyle = LineHeightStyle((lineHeightStyle ?: LineHeightStyle.Default).alignment, trim))
}

/**
 * The web's `CopyButton`: a copy icon that turns into a check for a moment once the text is on
 * the clipboard, so a tap visibly did something.
 */
@Composable
internal fun CopyTextButton(text: String, label: String? = null, size: Dp = 32.dp) {
    val clipboard = LocalClipboardManager.current
    val colors = TimelineTheme.colors
    val actionLabel = label ?: stringResource(Res.string.timeline_copy)
    var copied by remember() { mutableStateOf(false) }
    var generation by remember() { mutableStateOf(0) }
    var appliedGeneration by remember() { mutableStateOf(0) }
    val visibility = riffet.ui.theme.rememberVisualWorkVisibility()
    val active = riffet.ui.theme.visualWorkActive(visibility.visible)
    val motion = LocalRiffetMotion.current
    val clock = remember() { riffet.ui.feedback.FeedbackTiming(1500.0 + 32.0 + motion.SHORT) }
    LaunchedEffect(generation, active) {
        val now = riffet.ui.composer.feedbackNowMillis()
        clock.update(now, false)
        if (generation != appliedGeneration) {
            clock.restart(now)
            appliedGeneration = generation
        }
        if (!copied || !active) return@LaunchedEffect
        try {
            clock.update(riffet.ui.composer.feedbackNowMillis(), true)
            delay(kotlin.math.ceil(clock.remainingMillis).toLong().coerceAtLeast(1L))
            clock.update(riffet.ui.composer.feedbackNowMillis(), true)
            if (clock.complete) copied = false
        } finally {
            clock.update(riffet.ui.composer.feedbackNowMillis(), false)
        }
    }
    Box(Modifier.visualWorkVisibility(visibility)) {
        IconAction(
            icon = if (copied) RiffetIcons.Check else RiffetIcons.Copy,
            label = actionLabel,
            size = size,
            tint = if (copied) colors.success else colors.fg3,
            swap = true,
        ) {
            clipboard.setText(AnnotatedString(text))
            copied = true
            generation += 1
        }
    }
}

/**
 * `tok/s`, with the project's central distinction kept intact: a measured rate is `fg3` and bare,
 * an estimated one keeps its `~` and is dimmed to `fg4`.
 *
 * "We could not measure this" is not "the model produced nothing": `tokensPerSecond` returns null
 * for the former, and this then renders nothing at all rather than a plausible-looking `0`.
 */
@Composable
internal fun SpeedLabel(tag: SpeedTag?) {
    if (tag == null) return
    val colors = TimelineTheme.colors
    Text(
        text = tag.label,
        style = TimelineTheme.type.caption,
        color = if (tag.estimated) colors.fg4 else colors.fg3,
    )
}

/**
 * Epoch milliseconds, refreshed every [intervalMillis] (a second by default) while [active].
 *
 * The ticker exists only while something is running, so a settled transcript holds no timer at
 * all. The current value is read once at composition, so the first frame is never a spurious `0`.
 */
@Composable
internal fun rememberTickingNow(active: Boolean, intervalMillis: Long = 1_000L, visible: Boolean = true): Long {
    val ticking = riffet.ui.theme.visualWorkActive(visible) && active
    var now by remember { mutableStateOf(if (active) platformNowMillis() else 0L) }
    LaunchedEffect(ticking, intervalMillis) {
        if (!ticking) return@LaunchedEffect
        while (true) {
            now = platformNowMillis()
            delay(intervalMillis)
        }
    }
    // Turning active keeps the inactive `0` until the effect's first tick, a frame later; read the clock for that frame.
    return if (active && now == 0L) platformNowMillis() else now
}

/**
 * A filled thumbnail slot with the geometry the web computes.
 *
 * **There is no image loader in this build.** Compose Multiplatform 1.7.3 ships no `commonMain`
 * way to decode bytes into an `ImageBitmap`, and adding one (Coil 3, or a platform
 * `expect/actual` decoder) is a dependency decision that is out of scope here. So the box is
 * ported exactly — including the crop-vs-squeeze rule — and the pixels are not drawn. See the
 * change report.
 */
@Composable
internal fun ImageSlot(
    box: ImageBox,
    label: String,
    detail: String?,
    modifier: Modifier = Modifier,
) {
    val colors = TimelineTheme.colors
    Box(
        modifier = modifier
            .size(box.width, box.height)
            .clip(RoundedCornerShape(LocalInterfaceStyle.current.rowRadius))
            .background(LocalRiffetSurfaces.current.floating),
        contentAlignment = box.alignment,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.padding(8.dp),
        ) {
            Text(
                text = label,
                style = TimelineTheme.type.caption,
                color = colors.fg2,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (detail != null) {
                Text(
                    text = detail,
                    style = TimelineTheme.type.caption,
                    color = colors.fg4,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

internal val LocalSessionReferenceStore = staticCompositionLocalOf<riffet.ui.state.SessionStore?> { null }

internal val LocalSessionReferenceOpen = staticCompositionLocalOf<((String) -> Unit)?> { null }
