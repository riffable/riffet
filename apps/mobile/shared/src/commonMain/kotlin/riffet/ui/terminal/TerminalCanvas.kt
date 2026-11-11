package riffet.ui.terminal

import androidx.compose.foundation.layout.Spacer
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle as ComposeTextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.concurrent.Volatile
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.roundToInt
import riffet.terminal.TerminalEmulator
import riffet.terminal.TerminalRow
import riffet.terminal.TextStyle
import riffet.terminal.WcWidth

/**
 * Owns the emulator a [TerminalCanvas] draws, and the [screen] it draws from.
 *
 * The canvas never reads the emulator: it reads [screen], an immutable copy published by
 * [invalidate]. That is what lets the emulator be fed on a background thread. With an [owner]
 * scope (a single-threaded background dispatcher) the emulator belongs to that thread: feed it and
 * call [invalidate] there, and reach it from elsewhere through [post]. Publishing is then paced to
 * at most one copy per [FRAME_MILLIS], however many frames of output arrived in between. Without an
 * owner (the bench) everything happens on the caller's thread and [invalidate] publishes at once.
 *
 * [screen] is snapshot state read inside the canvas's draw lambda: new output repaints without
 * recomposing or re-measuring anything.
 */
@Stable
class TerminalSurfaceState(val emulator: TerminalEmulator, private val owner: CoroutineScope? = null) {
    var screen: TerminalFrame by mutableStateOf(TerminalFrame.of(emulator, 0L))
        private set

    val frame: Long get() = screen.frame

    /**
     * The transcript rows (external numbering: negative above the screen) the next frame copies, set by
     * the scroll view from its draw pass. A frame holds only that window, so the draw never reads the
     * emulator and a 10 000-row transcript costs a frame no more than the rows a reader is looking at.
     */
    @Volatile var historyWindow: IntRange? = null

    private var frames = 0L
    private val pending = Channel<Unit>(Channel.CONFLATED)

    init {
        owner?.launch {
            // The first change after a quiet spell shows at once; a stream of them, once per frame.
            for (ignored in pending) {
                publish()
                delay(FRAME_MILLIS)
            }
        }
    }

    /** The emulator changed. With an [owner], call it on the owner's thread. */
    fun invalidate() {
        if (owner == null) publish() else pending.trySend(Unit)
    }

    /** Runs [block] where the emulator may be touched: on the [owner]'s thread, or right here. */
    fun post(block: (TerminalEmulator) -> Unit) {
        if (owner == null) block(emulator) else owner.launch { block(emulator) }
    }

    private fun publish() {
        screen = TerminalFrame.of(emulator, ++frames, historyWindow)
    }

    private companion object {
        const val FRAME_MILLIS = 16L
    }
}

/**
 * One published frame of an emulator's screen: copies of its rows and the modes the renderer and
 * the input need, taken on the thread that feeds the emulator.
 */
@Immutable
class TerminalFrame private constructor(
    val frame: Long,
    val columns: Int,
    val rows: Int,
    private val lines: Array<TerminalRow>,
    val reverseVideo: Boolean,
    val cursorEnabled: Boolean,
    val cursorRow: Int,
    val cursorCol: Int,
    val cursorStyle: Int,
    val mouseTracking: Boolean,
    val cursorKeysApplication: Boolean,
    val keypadApplication: Boolean,
    /** Rows above the screen the emulator holds, and how many lines it has ever pushed there. */
    val transcriptRows: Int,
    val scrolledRows: Long,
    /** The copied transcript rows, from external row [historyFirst] up to -1. */
    val historyFirst: Int,
    private val history: Array<TerminalRow>,
) {
    fun row(index: Int): TerminalRow = lines[index]

    val historyLast: Int get() = historyFirst + history.size - 1

    /** A copied transcript row by external number (negative); null outside the copied window. */
    fun historyRow(external: Int): TerminalRow? = history.getOrNull(external - historyFirst)

    /** Whether the copied window holds every transcript row of [wanted] that exists. */
    fun covers(wanted: IntRange): Boolean {
        val first = maxOf(wanted.first, -transcriptRows)
        val last = minOf(wanted.last, -1)
        return first > last || (first >= historyFirst && last < historyFirst + history.size)
    }

    companion object {
        fun of(emulator: TerminalEmulator, frame: Long, window: IntRange? = null): TerminalFrame {
            val screen = emulator.getScreen()
            val rows = emulator.getRows()
            val transcript = screen.getActiveTranscriptRows()
            val first = if (window == null) 0 else maxOf(window.first, -transcript)
            val last = if (window == null) -1 else minOf(window.last, -1)
            return TerminalFrame(
                frame = frame,
                columns = emulator.getColumns(),
                rows = rows,
                lines = Array(rows) { row -> screen.allocateFullLineIfNecessary(screen.externalToInternalRow(row)).copy() },
                reverseVideo = emulator.isReverseVideo(),
                cursorEnabled = emulator.isCursorEnabled(),
                cursorRow = emulator.getCursorRow(),
                cursorCol = emulator.getCursorCol(),
                cursorStyle = emulator.getCursorStyle(),
                mouseTracking = emulator.isMouseTrackingActive(),
                cursorKeysApplication = emulator.isCursorKeysApplicationMode(),
                keypadApplication = emulator.isKeypadApplicationMode(),
                transcriptRows = transcript,
                scrolledRows = emulator.getScrolledRows(),
                historyFirst = if (first > last) 0 else first,
                history = if (first > last) emptyArray() else Array(last - first + 1) { index ->
                    screen.allocateFullLineIfNecessary(screen.externalToInternalRow(first + index)).copy()
                },
            )
        }
    }
}

/**
 * Pixel geometry of one cell: [width] keeps its fraction (the run layout places glyphs at exact
 * advances), [height] is whole pixels so background rows meet without seams, [textTop] is the
 * text's offset inside the cell.
 */
class CellMetrics internal constructor(val width: Float, val height: Float, internal val textTop: Float)

/** The cell geometry [TerminalCanvas] uses for these font settings; callers size the grid with it. */
@Composable
fun rememberTerminalCellMetrics(
    fontSize: TextUnit = 13.sp,
    fontFamily: FontFamily = appearanceTerminalFontFamily(),
    lineHeight: Float = 1.2f,
): CellMetrics {
    val measurer = rememberTextMeasurer(cacheSize = 1024)
    val density = LocalDensity.current
    return remember(fontSize, fontFamily, lineHeight, density) {
        val base = ComposeTextStyle(fontFamily = fontFamily, fontSize = fontSize)
        val sample = measurer.measure(AnnotatedString("M".repeat(32)), base, softWrap = false, maxLines = 1, density = density)
        val height = ceil(sample.size.height * lineHeight)
        CellMetrics(sample.size.width / 32f, height, ((height - sample.size.height) / 2f).roundToInt().toFloat())
    }
}

@Composable
fun TerminalCanvas(
    state: TerminalSurfaceState,
    palette: TerminalPalette,
    modifier: Modifier = Modifier,
    fontSize: TextUnit = 13.sp,
    fontFamily: FontFamily = appearanceTerminalFontFamily(),
    lineHeight: Float = 1.2f,
) {
    val measurer = rememberTextMeasurer(cacheSize = 1024)
    val density = LocalDensity.current
    val base = remember(fontSize, fontFamily) { ComposeTextStyle(fontFamily = fontFamily, fontSize = fontSize) }
    val metrics = rememberTerminalCellMetrics(fontSize, fontFamily, lineHeight)
    val painter = remember(measurer, base, density) { ScreenPainter(measurer, base) }
    Spacer(
        modifier.drawBehind {
            painter.draw(this, state.screen, palette, metrics)
        },
    )
}

/**
 * Draws an emulator's visible screen. Text is laid out per run of same-weight, same-slant,
 * single-width characters whose glyph advance matches the cell; colour is applied at draw time, so
 * a layout is reused across colour changes. Everything else is placed cell by cell: wide
 * characters, glyphs from a fallback font (scaled horizontally into their cells, as Termux's
 * renderer does) and box drawing (geometry, see [drawBoxGlyph]).
 */
internal class ScreenPainter(private val measurer: TextMeasurer, private val base: ComposeTextStyle) {
    private val advances = HashMap<Int, Float>()
    private val run = StringBuilder()

    fun draw(scope: DrawScope, screen: TerminalFrame, palette: TerminalPalette, cell: CellMetrics) = with(scope) {
        drawRect(Color(palette.background))
        drawScreenRows(screen, palette, cell, firstRow = 0, top = 0f)
    }

    /**
     * The screen's rows from [firstRow] down, the first one at [top] pixels, stopping at the
     * bottom of the draw area; the cursor too when its row is among them.
     */
    fun DrawScope.drawScreenRows(screen: TerminalFrame, palette: TerminalPalette, cell: CellMetrics, firstRow: Int, top: Float) {
        drawRows(firstRow until screen.rows, top, screen.columns, palette, cell, screen.reverseVideo) { row -> screen.row(row) }
        drawCursor(screen, palette, cell, top - firstRow * cell.height)
    }

    /** Rows from any source (the live screen, the scrollback), [rows].first at [top] pixels. */
    fun DrawScope.drawRows(rows: IntRange, top: Float, columns: Int, palette: TerminalPalette, cell: CellMetrics, reverse: Boolean, rowAt: (Int) -> TerminalRow) {
        var y = top
        for (row in rows) {
            if (y >= size.height) break
            if (y + cell.height > 0f) {
                val line = rowAt(row)
                drawRowBackground(line, y, columns, palette, cell, reverse)
                drawRowText(line, y, columns, palette, cell, reverse)
            }
            y += cell.height
        }
    }

    private fun DrawScope.drawRowBackground(line: TerminalRow, top: Float, columns: Int, palette: TerminalPalette, cell: CellMetrics, reverse: Boolean) {
        var runStart = 0
        var runColor = 0
        for (column in 0..columns) {
            val color = if (column < columns) backgroundOf(line.getStyle(column), palette, reverse) else Int.MIN_VALUE
            if (column == 0) {
                runColor = color
                continue
            }
            if (color != runColor) {
                if (runColor != palette.background) {
                    val left = (runStart * cell.width).roundToInt().toFloat()
                    val right = (column * cell.width).roundToInt().toFloat()
                    drawRect(Color(runColor), Offset(left, top), Size(right - left, cell.height))
                }
                runStart = column
                runColor = color
            }
        }
    }

    private fun DrawScope.drawRowText(line: TerminalRow, top: Float, columns: Int, palette: TerminalPalette, cell: CellMetrics, reverse: Boolean) {
        val text = line.mText
        val used = line.getSpaceUsed()
        var runStart = -1
        var runStyle = 0L
        var runColor = 0

        fun flush() {
            if (runStart < 0) return
            val trimmed = run.trimEnd()
            if (trimmed.isNotEmpty()) {
                val effect = TextStyle.decodeEffect(runStyle)
                val layout = layout(trimmed.toString(), effect)
                drawText(layout, color = Color(runColor), topLeft = Offset(runStart * cell.width, top + cell.textTop))
            }
            run.setLength(0)
            runStart = -1
        }

        var index = 0
        var column = 0
        while (column < columns && index < used) {
            val start = index
            val codePoint = codePointAt(text, index)
            index += if (codePoint >= 0x10000) 2 else 1
            while (index < used) {
                val next = codePointAt(text, index)
                if (WcWidth.width(next) > 0) break
                index += if (next >= 0x10000) 2 else 1
            }
            val width = max(1, WcWidth.width(codePoint))
            val style = line.getStyle(column)
            val effect = TextStyle.decodeEffect(style)
            val color = if (isBoxGlyph(codePoint) || codePoint in 0xE0A0..0xE0D7) foregroundOf(style, palette, reverse) else palette.readable(
                foregroundOf(style, palette, reverse),
                backgroundOf(style, palette, reverse),
                faint = effect and TextStyle.CHARACTER_ATTRIBUTE_DIM != 0,
            )
            val invisible = effect and TextStyle.CHARACTER_ATTRIBUTE_INVISIBLE != 0
            val simple = width == 1 && index - start == 1 && !isBoxGlyph(codePoint) && fitsCell(codePoint, effect, cell)
            if (simple && !invisible) {
                if (runStart >= 0 && (color != runColor || !sameFace(style, runStyle))) flush()
                if (runStart < 0) {
                    runStart = column
                    runStyle = style
                    runColor = color
                }
                run.append(text[start])
            } else {
                flush()
                if (!invisible && codePoint != ' '.code) {
                    val left = column * cell.width
                    if (isBoxGlyph(codePoint)) {
                        drawBoxGlyph(codePoint, left.roundToInt().toFloat(), top, ((column + width) * cell.width).roundToInt() - left.roundToInt().toFloat(), cell.height, Color(color))
                    } else {
                        drawFitted(text.concatToString(start, index), effect, left, top, width * cell.width, cell, Color(color))
                    }
                }
            }
            drawDecorations(effect, column, width, top, cell, color)
            column += width
        }
        flush()
    }

    private fun DrawScope.drawDecorations(effect: Int, column: Int, width: Int, top: Float, cell: CellMetrics, color: Int) {
        val underline = effect and TextStyle.CHARACTER_ATTRIBUTE_UNDERLINE != 0
        val strike = effect and TextStyle.CHARACTER_ATTRIBUTE_STRIKETHROUGH != 0
        if (!underline && !strike) return
        val thickness = max(1f, (cell.height / 16f).roundToInt().toFloat())
        val left = column * cell.width
        val size = Size(width * cell.width, thickness)
        if (underline) drawRect(Color(color), Offset(left, top + cell.height - thickness * 2), size)
        if (strike) drawRect(Color(color), Offset(left, top + (cell.height / 2f).roundToInt()), size)
    }

    /** A glyph the run layout cannot place: centred in its cells and squeezed if it is too wide. */
    private fun DrawScope.drawFitted(text: String, effect: Int, left: Float, top: Float, span: Float, cell: CellMetrics, color: Color) {
        val layout = layout(text, effect)
        val advance = layout.size.width.toFloat()
        if (advance <= 0f) return
        val scale = if (advance > span) span / advance else 1f
        val offset = (span - advance * scale) / 2f
        withTransform({
            translate(left + offset, top + cell.textTop)
            scale(scale, 1f, Offset.Zero)
        }) {
            drawText(layout, color = color, topLeft = Offset.Zero)
        }
    }

    private fun DrawScope.drawCursor(screen: TerminalFrame, palette: TerminalPalette, cell: CellMetrics, originY: Float) {
        if (!screen.cursorEnabled) return
        val row = screen.cursorRow
        val column = screen.cursorCol
        if (row !in 0 until screen.rows || column !in 0 until screen.columns) return
        val left = column * cell.width
        val top = originY + row * cell.height
        val color = Color(palette.cursor)
        when (screen.cursorStyle) {
            TerminalEmulator.TERMINAL_CURSOR_STYLE_UNDERLINE ->
                drawRect(color, Offset(left, top + cell.height - max(2f, cell.height / 10f)), Size(cell.width, max(2f, cell.height / 10f)))
            TerminalEmulator.TERMINAL_CURSOR_STYLE_BAR ->
                drawRect(color, Offset(left, top), Size(max(2f, cell.width / 6f), cell.height))
            else -> {
                drawRect(color, Offset(left, top), Size(cell.width, cell.height))
                val line = screen.row(row)
                val start = line.findStartOfColumn(column)
                if (start < line.getSpaceUsed()) {
                    val codePoint = codePointAt(line.mText, start)
                    if (codePoint != ' '.code) {
                        val effect = TextStyle.decodeEffect(line.getStyle(column))
                        drawFitted(line.mText.concatToString(start, start + if (codePoint >= 0x10000) 2 else 1), effect, left, top,
                            max(1, WcWidth.width(codePoint)) * cell.width, cell, Color(palette.background))
                    }
                }
            }
        }
    }

    private fun layout(text: String, effect: Int): TextLayoutResult {
        val bold = effect and TextStyle.CHARACTER_ATTRIBUTE_BOLD != 0
        val italic = effect and TextStyle.CHARACTER_ATTRIBUTE_ITALIC != 0
        return measurer.measure(
            AnnotatedString(text),
            base.copy(fontWeight = if (bold) FontWeight.Bold else null, fontStyle = if (italic) FontStyle.Italic else null),
            softWrap = false,
            maxLines = 1,
        )
    }

    /**
     * Whether the font draws [codePoint] at exactly one cell's advance; otherwise it is placed alone.
     * ASCII is checked too: a face that is not truly monospaced still lands on the grid.
     */
    private fun fitsCell(codePoint: Int, effect: Int, cell: CellMetrics): Boolean {
        if (codePoint == ' '.code) return true
        val advance = advances.getOrPut(codePoint) { layout(codePointString(codePoint), effect).size.width.toFloat() }
        return abs(advance - cell.width) <= cell.width * 0.01f
    }

    private fun sameFace(a: Long, b: Long): Boolean {
        val mask = TextStyle.CHARACTER_ATTRIBUTE_BOLD or TextStyle.CHARACTER_ATTRIBUTE_ITALIC
        return TextStyle.decodeEffect(a) and mask == TextStyle.decodeEffect(b) and mask
    }

}

/** The ARGB a cell's text is drawn in: inverse, dim and bold-as-bright applied. */
internal fun foregroundOf(style: Long, palette: TerminalPalette, reverseVideo: Boolean): Int {
    val effect = TextStyle.decodeEffect(style)
    var fore = TextStyle.decodeForeColor(style)
    val back = TextStyle.decodeBackColor(style)
    if (effect and TextStyle.CHARACTER_ATTRIBUTE_BOLD != 0 && fore in 0..7) fore += 8
    val inverse = (effect and TextStyle.CHARACTER_ATTRIBUTE_INVERSE != 0) != reverseVideo
    val argb = if (inverse) palette.resolveBackground(back) else palette.resolve(fore)
    return if (effect and TextStyle.CHARACTER_ATTRIBUTE_DIM != 0) dim(argb, if (inverse) palette.resolve(fore) else palette.resolveBackground(back)) else argb
}

/** The ARGB behind a cell. */
internal fun backgroundOf(style: Long, palette: TerminalPalette, reverseVideo: Boolean): Int {
    val effect = TextStyle.decodeEffect(style)
    val inverse = (effect and TextStyle.CHARACTER_ATTRIBUTE_INVERSE != 0) != reverseVideo
    return if (inverse) palette.resolve(TextStyle.decodeForeColor(style)) else palette.resolveBackground(TextStyle.decodeBackColor(style))
}

/** Faint text: two thirds of the way from the background to the colour. */
private fun dim(argb: Int, background: Int): Int {
    fun mix(shift: Int) = ((argb shr shift and 0xFF) * 2 + (background shr shift and 0xFF)) / 3
    return -0x1000000 or (mix(16) shl 16) or (mix(8) shl 8) or mix(0)
}

private fun codePointAt(text: CharArray, index: Int): Int {
    val high = text[index]
    if (high.isHighSurrogate() && index + 1 < text.size && text[index + 1].isLowSurrogate()) {
        return ((high.code - 0xD800) shl 10) + (text[index + 1].code - 0xDC00) + 0x10000
    }
    return high.code
}

private fun codePointString(codePoint: Int): String {
    if (codePoint < 0x10000) return codePoint.toChar().toString()
    val offset = codePoint - 0x10000
    return charArrayOf((0xD800 + (offset ushr 10)).toChar(), (0xDC00 + (offset and 0x3FF)).toChar()).concatToString()
}
