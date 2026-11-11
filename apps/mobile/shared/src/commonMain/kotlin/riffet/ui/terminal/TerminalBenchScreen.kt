package riffet.ui.terminal

import riffet.ui.theme.appearancePageBackground

import riffet.ui.design.LocalRiffetSurfaces
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.app.PageTopBar
import riffet.ui.app.RiffetPageScaffold
import riffet.ui.design.materialBackdropEnabled
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.HorizontalDivider
import riffet.ui.icons.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.max
import kotlin.time.TimeSource
import org.jetbrains.compose.resources.getString
import org.jetbrains.compose.resources.stringResource
import riffet.shared.AppLog
import riffet.terminal.TerminalEmulator
import riffet.terminal.TerminalOutput
import riffet.ui.icons.RiffetIcons
import riffet.ui.settings.SettingsButton
import riffet.ui.settings.SettingsSegmented
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetDarkTheme
import riffet.ui.theme.LocalRiffetThemeEntry
import riffet.ui.theme.LocalRiffetTypography
import riffet_mobile.shared.generated.resources.*

/**
 * 终端渲染测试 (Settings → 诊断与日志 → 高级诊断): drives [TerminalCanvas] with a generated agent-CLI
 * screen — box panels, colours, a near-black input panel, Chinese text — and reports how long each
 * frame's drawing takes and how far apart frames land, so the renderer can be judged on a real
 * phone before any terminal is wired to a server. Every five seconds the numbers go to [AppLog]
 * under `term`, so an uploaded log carries them.
 *
 * Modes: 静止 (the default, so the page opens on a still screen) only invalidates every frame, so
 * the cost is drawing alone; agent 输出 appends a few lines every ~120 ms, the pace of an agent CLI
 * streaming an answer; 整屏重绘 repaints every row in place each frame with only the spinner line
 * changing, which is what tmux sends while a TUI animates; 高速滚动 appends a line every frame, a
 * stress case well beyond any real CLI.
 *
 * Nothing on this page may change the canvas's size while it runs: a resize repaints the whole
 * grid, which is exactly the flicker the page exists to rule out. The statistics therefore sit in
 * two fixed single-line rows, and a size change resizes the one emulator instead of replacing it.
 */
@Composable
internal fun TerminalBenchScreen(onBack: () -> Unit) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val entry = LocalRiffetThemeEntry.current
    val dark = LocalRiffetDarkTheme.current
    val palette = remember(entry, dark) { TerminalPalette.from(entry, dark) }
    var mode by remember { mutableStateOf("idle") }
    var fontSize by remember { mutableStateOf(13) }
    val measuring = stringResource(Res.string.timeline_bench_measuring)
    var drawSummary by remember { mutableStateOf(measuring) }
    var frameSummary by remember { mutableStateOf("") }

    RiffetPageScaffold(
        modifier = Modifier.fillMaxSize().appearancePageBackground(LocalRiffetSurfaces.current.page),
        topBar = {
            Column {
                PageTopBar(title = stringResource(Res.string.timeline_bench_title), onBack = onBack)
                Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
                    SettingsSegmented(
                        options = listOf(
                            "idle" to stringResource(Res.string.timeline_bench_mode_idle),
                            "agent" to stringResource(Res.string.timeline_bench_mode_agent),
                            "redraw" to stringResource(Res.string.timeline_bench_mode_redraw),
                            "flood" to stringResource(Res.string.timeline_bench_mode_flood),
                        ),
                        value = mode,
                        onSelect = { mode = it },
                    )
                    Spacer(Modifier.height(8.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        SettingsButton(text = "A−", onClick = { fontSize = max(8, fontSize - 1) })
                        Spacer(Modifier.size(8.dp))
                        SettingsButton(text = "A+", onClick = { fontSize = minOf(24, fontSize + 1) })
                        Spacer(Modifier.size(12.dp))
                        Column(Modifier.weight(1f)) {
                            Text(drawSummary, style = typography.caption, color = colors.fg2, maxLines = 1, overflow = TextOverflow.Clip, softWrap = false)
                            Text(frameSummary, style = typography.caption, color = colors.fg3, maxLines = 1, overflow = TextOverflow.Clip, softWrap = false)
                        }
                    }
                }
                if (!materialBackdropEnabled) HorizontalDivider(color = colors.line)
            }
        },
    ) { contentInsets ->
        val metrics = rememberTerminalCellMetrics(fontSize.sp)
        BoxWithConstraints(Modifier.fillMaxSize().background(androidx.compose.ui.graphics.Color(palette.background)).padding(contentInsets)) {
            val density = LocalDensity.current
            val columns = max(20, (with(density) { maxWidth.toPx() } / metrics.width).toInt())
            val rows = max(5, (with(density) { maxHeight.toPx() } / metrics.height).toInt())
            val state = remember {
                TerminalSurfaceState(TerminalEmulator(DiscardOutput, columns, rows, metrics.width.toInt(), metrics.height.toInt(), 2000, null))
            }
            LaunchedEffect(columns, rows) {
                val emulator = state.emulator
                if (emulator.getColumns() != columns || emulator.getRows() != rows) {
                    emulator.resize(columns, rows, metrics.width.toInt(), metrics.height.toInt())
                    state.invalidate()
                }
            }
            val stats = remember { FrameStats() }
            val script = remember { AgentScreenScript() }

            LaunchedEffect(mode) {
                var lastFrame = 0L
                var lastReport = 0L
                var lastBurst = 0L
                while (true) {
                    var reportDue = false
                    withFrameNanos { now ->
                        if (lastFrame != 0L) stats.interval(now - lastFrame)
                        lastFrame = now
                        val emulator = state.emulator
                        val bytes = when (mode) {
                            "agent" -> if (now - lastBurst >= 120_000_000L) {
                                lastBurst = now
                                script.nextLines(2 + (now / 120_000_000L % 2).toInt(), emulator.getColumns())
                            } else null
                            "flood" -> script.nextLines(1, emulator.getColumns())
                            "redraw" -> script.fullRepaint(emulator.getRows(), emulator.getColumns())
                            else -> null
                        }
                        if (bytes != null) {
                            val started = TimeSource.Monotonic.markNow()
                            state.emulator.append(bytes, bytes.size)
                            stats.parse(started.elapsedNow().inWholeMicroseconds, bytes.size)
                        }
                        state.invalidate()
                        if (now - lastReport > 1_000_000_000L) {
                            lastReport = now
                            reportDue = true
                        }
                    }
                    if (reportDue) {
                        val emulator = state.emulator
                        drawSummary = getString(
                            Res.string.timeline_bench_draw_summary,
                            emulator.getColumns(),
                            emulator.getRows(),
                            stats.drawP50(),
                            stats.drawP95(),
                        )
                        frameSummary = getString(
                            Res.string.timeline_bench_frame_summary,
                            stats.intervalP50(),
                            stats.intervalP95(),
                            stats.parseRate(),
                        )
                    }
                    if (stats.shouldLog()) {
                        val emulator = state.emulator
                        val draw = getString(
                            Res.string.timeline_bench_draw_summary,
                            emulator.getColumns(),
                            emulator.getRows(),
                            stats.drawP50(),
                            stats.drawP95(),
                        )
                        val frame = getString(
                            Res.string.timeline_bench_frame_summary,
                            stats.intervalP50(),
                            stats.intervalP95(),
                            stats.parseRate(),
                        )
                        AppLog.log("term", "bench mode=$mode font=${fontSize}sp $draw · $frame")
                    }
                }
            }

            TerminalCanvas(
                state = state,
                palette = palette,
                fontSize = fontSize.sp,
                modifier = Modifier.fillMaxSize().drawWithContent {
                    val started = TimeSource.Monotonic.markNow()
                    drawContent()
                    stats.draw(started.elapsedNow().inWholeMicroseconds)
                },
            )
        }
    }
}

private object DiscardOutput : TerminalOutput() {
    override fun write(data: ByteArray, offset: Int, count: Int) = Unit
    override fun titleChanged(oldTitle: String?, newTitle: String?) = Unit
    override fun onCopyTextToClipboard(text: String) = Unit
    override fun onPasteTextFromClipboard() = Unit
    override fun onBell() = Unit
    override fun onColorsChanged() = Unit
}

/** Rolling samples of draw time, frame interval and parse speed. */
private class FrameStats {
    private val draws = LongArray(SAMPLES)
    private val intervals = LongArray(SAMPLES)
    private var drawCount = 0
    private var intervalCount = 0
    private var parseMicros = 0L
    private var parseBytes = 0L
    private var lastLog = TimeSource.Monotonic.markNow()

    fun draw(micros: Long) {
        draws[drawCount++ % SAMPLES] = micros
    }

    fun interval(nanos: Long) {
        intervals[intervalCount++ % SAMPLES] = nanos / 1000
    }

    fun parse(micros: Long, bytes: Int) {
        parseMicros += micros
        parseBytes += bytes
    }

    fun shouldLog(): Boolean {
        if (lastLog.elapsedNow().inWholeSeconds < 5) return false
        lastLog = TimeSource.Monotonic.markNow()
        return true
    }

    private fun percentile(values: LongArray, count: Int, p: Double): String {
        val n = minOf(count, SAMPLES)
        if (n == 0) return "–"
        val sorted = values.copyOf(n).sorted()
        val micros = sorted[((n - 1) * p).toInt()]
        return "${micros / 1000}.${(micros % 1000) / 100}"
    }

    fun drawP50(): String = percentile(draws, drawCount, 0.5)

    fun drawP95(): String = percentile(draws, drawCount, 0.95)

    fun intervalP50(): String = percentile(intervals, intervalCount, 0.5)

    fun intervalP95(): String = percentile(intervals, intervalCount, 0.95)

    fun parseRate(): Double = if (parseMicros > 0) parseBytes.toDouble() / parseMicros else 0.0

    private companion object {
        const val SAMPLES = 240
    }
}

/**
 * Generates what an agent CLI prints: tool lines with a coloured bullet, Chinese prose, a diff, a
 * rounded panel, and the near-black input box the Cursor CLI draws (`48;2;21;21;21`).
 */
private class AgentScreenScript {
    private var step = 0
    private var frame = 0
    private val spinner = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
    private fun lines(columns: Int) = listOf(
        "\u001b[38;2;120;200;120m⏺\u001b[0m \u001b[1mRead\u001b[0m(apps/mobile/terminal/src/commonMain/kotlin/riffet/terminal/TerminalRow.kt)",
        "  ⎿  Read 320 lines (ctrl+o to expand)",
        // i18n-ignore: simulated CLI output in the terminal benchmark, not interface copy.
        "正在分析项目结构，检查依赖关系、构建脚本与测试覆盖率，稍后给出修改建议。",
        "\u001b[32m+    if (newCodePointDisplayWidth == 2) mStyle[columnToSet + 1] = style\u001b[0m",
        "\u001b[31m-    mStyle[columnToSet] = style\u001b[0m",
        "\u001b[38;5;245m╭" + "─".repeat(24) + "╮\u001b[0m",
        "\u001b[38;5;245m│\u001b[0m ✓ 150 tests passed      \u001b[38;5;245m│\u001b[0m",
        "\u001b[38;5;245m╰" + "─".repeat(24) + "╯\u001b[0m",
        // i18n-ignore: simulated keystrokes the fake CLI draws, not interface copy.
        "\u001b[48;2;21;21;21m\u001b[38;2;230;230;230m > 帮我把终端的滚动做得更顺滑 " + " ".repeat(max(0, columns - 30)) + "\u001b[0m",
        "\u001b[2m  esc to interrupt · ⇧tab to cycle modes · 🙂 emoji\u001b[0m",
    )

    fun nextLines(count: Int, columns: Int): ByteArray = buildString {
        val lines = lines(columns)
        repeat(count) { append(lines[step++ % lines.size]).append("\r\n") }
    }.encodeToByteArray()

    /** Every row rewritten in place; only the last row's spinner and timer move. */
    fun fullRepaint(rows: Int, columns: Int): ByteArray = buildString {
        val lines = lines(columns)
        frame++
        for (row in 0 until rows - 1) {
            append("\u001b[").append(row + 1).append(";1H")
            append(lines[row % lines.size]).append("\u001b[0m\u001b[K")
        }
        append("\u001b[").append(rows).append(";1H\u001b[38;5;208m").append(spinner[frame / 4 % spinner.length])
        append("\u001b[0m Thinking… (").append(frame / 60).append("s · esc to interrupt)\u001b[K")
    }.encodeToByteArray()
}
