package riffet.ui.terminal

import androidx.compose.foundation.gestures.FlingBehavior
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.ScrollScope
import androidx.compose.foundation.gestures.ScrollableDefaults
import androidx.compose.foundation.gestures.ScrollableState
import androidx.compose.foundation.gestures.animateScrollBy
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.scrollable
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.layout.Spacer
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle as ComposeTextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.TextUnit
import riffet.terminal.TerminalEmulator
import kotlin.concurrent.Volatile
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * The terminal's pixel offset from the live anchor. Zero follows input; positive offsets read
 * earlier rows, and negative offsets reach grid rows below the cursor while the keyboard is open.
 * Manual positions retain their rows across cursor movement and history growth or trimming.
 */
@Stable
internal class TerminalScrollState(private val frame: () -> TerminalFrame) {
    private var base by mutableFloatStateOf(0f)
    private var anchor = 0L
    private var anchorTop = 0f
    private var anchorTranscriptRows = 0
    /**
     * The last frame published before a snapshot reset the emulator. Frames up to it still show the old
     * screen, whose `scrolledRows` the seed is about to outgrow, so they hold the view at the bottom and
     * ignore gestures; the seed's own frame follows them.
     */
    @Volatile private var staleThrough = -1L

    /** Set by the draw pass: the content height beyond the viewport, and one row's height. */
    internal var maxFromBottom = 0f
    internal var minFromBottom = 0f
    internal var rowHeight = 0f
    internal var liveTop = 0f

    /**
     * Set by the draw pass while the program tracks the mouse and there is no scrollback: an agent
     * CLI on the pane's alternate screen. Travel beyond the scroll range goes to it as wheel steps,
     * one per row, positive toward the past.
     */
    internal var wheel: ((steps: Int) -> Unit)? = null
    private var wheelTravel = 0f

    /** The offset for [current], following the line the reader is on. */
    fun fromBottom(current: TerminalFrame): Float {
        if (abs(base) < 0.5f || current.frame <= staleThrough) return 0f
        // The cursor and keyboard can move the live anchor before any row enters history.
        // Keep the reader's content position, compensating history growth only once; when
        // history is capped, scrolledRows still accounts for the oldest rows being removed.
        val offset = (base + anchorTop - liveTop +
            (current.scrolledRows - anchor - (current.transcriptRows - anchorTranscriptRows)) * rowHeight)
            .coerceIn(minFromBottom, maxFromBottom)
        // A larger viewport can catch up with the live end without a scroll gesture.
        // Once there, follow subsequent output rather than reviving an obsolete anchor.
        if (abs(offset) < 0.5f) base = 0f
        return offset
    }

    /** At the live bottom, including while the alternate screen (no transcript) leaves nothing to scroll. */
    val atBottom: Boolean get() = abs(fromBottom(frame())) < 0.5f

    /** A snapshot replaced everything on screen; the old offset names lines that no longer exist. */
    fun toLiveNow() {
        staleThrough = frame().frame
        base = 0f
    }

    val scrollable = ScrollableState { delta ->
        val current = frame()
        if (current.frame <= staleThrough) return@ScrollableState 0f
        val before = fromBottom(current)
        val next = (before + delta).coerceIn(minFromBottom, maxFromBottom)
        base = next
        anchor = current.scrolledRows
        anchorTop = liveTop
        anchorTranscriptRows = current.transcriptRows
        val consumed = next - before
        val wheel = wheel
        if (wheel == null || rowHeight <= 0f) {
            wheelTravel = 0f
            consumed
        } else {
            // Whole rows only; the remainder carries over to the next delta.
            wheelTravel += delta - consumed
            val steps = (wheelTravel / rowHeight).toInt()
            if (steps != 0) {
                wheelTravel -= steps * rowHeight
                wheel(steps)
            }
            delta
        }
    }

    suspend fun toLive() {
        scrollable.animateScrollBy(-fromBottom(frame()))
    }
}

/**
 * The emulator's own transcript and its live screen as one surface, drawn in the draw phase only:
 * scrolling and new output repaint without recomposing. Only the rows in the viewport are drawn, so a
 * 10 000-row scrollback costs no more per frame than the screen itself.
 */
@Composable
internal fun TerminalScrollView(
    surface: TerminalSurfaceState,
    scroll: TerminalScrollState,
    palette: TerminalPalette,
    fontSize: TextUnit,
    modifier: Modifier = Modifier,
    /** The pane keeps its grid while the keyboard is open; reveal the input without its blank tail. */
    followCursor: Boolean = false,
    /** A tap that did not turn into a scroll. */
    onTap: () -> Unit = {},
) {
    val tap by rememberUpdatedState(onTap)
    val measurer = rememberTextMeasurer(cacheSize = 1024)
    val density = LocalDensity.current
    val font = appearanceTerminalFontFamily()
    val base = remember(fontSize, font) { ComposeTextStyle(fontFamily = font, fontSize = fontSize) }
    val metrics = rememberTerminalCellMetrics(fontSize)
    val painter = remember(measurer, base, density) { ScreenPainter(measurer, base) }
    // The engine encodes the reports for the program's mouse mode and sends them as its replies,
    // so only while this client holds control. They name the middle of the screen, inside the pane
    // whatever tmux draws around it.
    val wheel = remember(surface) {
        { steps: Int ->
            surface.post { emulator ->
                val button = if (steps > 0) TerminalEmulator.MOUSE_WHEELUP_BUTTON else TerminalEmulator.MOUSE_WHEELDOWN_BUTTON
                repeat(abs(steps)) { emulator.sendMouseEvent(button, emulator.getColumns() / 2 + 1, emulator.getRows() / 2 + 1, true) }
            }
        }
    }
    val defaultFling = ScrollableDefaults.flingBehavior()
    val fling = remember(defaultFling, scroll) {
        object : FlingBehavior {
            // A fling would become a burst of wheel reports: the program gets the finger's travel only.
            override suspend fun ScrollScope.performFling(initialVelocity: Float): Float =
                if (scroll.wheel != null) initialVelocity else with(defaultFling) { performFling(initialVelocity) }
        }
    }
    Spacer(
        modifier
            .scrollable(scroll.scrollable, Orientation.Vertical, flingBehavior = fling)
            .pointerInput(Unit) {
                awaitEachGesture {
                    awaitFirstDown(requireUnconsumed = false)
                    // A drag is consumed by the scroll, which makes this null: only a clean release is a tap.
                    if (waitForUpOrCancellation() != null) tap()
                }
            }
            .drawBehind {
                val screen = surface.screen
                drawRect(Color(palette.background))
                val cell = metrics.height
                val transcript = screen.transcriptRows
                // The live input may have many blank grid rows below it. Anchoring that tail to
                // the keyboard would pull the prompt toward the top. Reveal the cursor with one
                // context row below it; keep the pane's first row at the top when it already fits.
                // Scroll offsets use this same anchor, so the first drag does not jump back to
                // the grid's tail. Keep the complete grid reachable: cursor movement in a TUI
                // does not imply that all rows below it are blank.
                val liveRows = if (followCursor && screen.cursorEnabled)
                    min(screen.rows, screen.cursorRow + 2) else screen.rows
                val liveTop = min(0f, size.height - (transcript + liveRows) * cell)
                scroll.rowHeight = cell
                scroll.liveTop = liveTop
                scroll.minFromBottom = min(0f, size.height - (transcript + screen.rows) * cell) - liveTop
                scroll.maxFromBottom = -liveTop
                scroll.wheel = if (transcript == 0 && screen.mouseTracking) wheel else null
                val contentTop = liveTop + scroll.fromBottom(screen)
                // The transcript rows on screen, in the emulator's numbering, with a viewport of margin on
                // both sides: the next frame copies them, so a scroll never waits for the emulator.
                val firstRow = max(0, floor(-contentTop / cell).toInt())
                val lastRow = min(transcript - 1, ceil((size.height - contentTop) / cell).toInt())
                val viewRows = ceil(size.height / cell).toInt()
                val wanted = (firstRow - transcript - viewRows)..(lastRow - transcript + viewRows)
                if (transcript > 0) {
                    surface.historyWindow = wanted
                    if (!screen.covers((firstRow - transcript)..(lastRow - transcript))) surface.invalidate()
                } else surface.historyWindow = null
                with(painter) {
                    val available = max(firstRow, transcript + screen.historyFirst)
                    val availableLast = min(lastRow, transcript + screen.historyLast)
                    if (transcript > 0 && available <= availableLast) {
                        drawRows(available..availableLast, contentTop + available * cell, screen.columns, palette, metrics, reverse = false) { index ->
                            checkNotNull(screen.historyRow(index - transcript))
                        }
                    }
                    val liveTop = contentTop + transcript * cell
                    val firstLive = max(0, floor(-liveTop / cell).toInt())
                    drawScreenRows(screen, palette, metrics, firstLive, liveTop + firstLive * cell)
                }
            },
    )
}
