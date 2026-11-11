package riffet.terminal

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Feeds each recorded tmux client stream (scripts/record-terminal-fixtures.ts) to the engine and
 * requires the screen tmux itself reported at the end: the text of every row, the cursor, and the
 * colour and attributes of every cell. tmux produced the stream for exactly this screen, so any
 * difference is the engine's.
 */
class TmuxParityTest {

    private val fixtures = File("fixtures/tmux").listFiles { file -> File(file, "expected.json").isFile }
        .orEmpty().sortedBy { it.name }

    private class Discard : TerminalOutput() {
        override fun write(data: ByteArray, offset: Int, count: Int) = Unit
        override fun titleChanged(oldTitle: String?, newTitle: String?) = Unit
        override fun onCopyTextToClipboard(text: String) = Unit
        override fun onPasteTextFromClipboard() = Unit
        override fun onBell() = Unit
        override fun onColorsChanged() = Unit
    }

    private class Fixture(dir: File) {
        val name: String = dir.name
        private val expected = Json.parseToJsonElement(File(dir, "expected.json").readText()).jsonObject
        val cols = expected.getValue("cols").jsonPrimitive.int
        val rows = expected.getValue("rows").jsonPrimitive.int
        val cursorX = expected.getValue("cursorX").jsonPrimitive.int
        val cursorY = expected.getValue("cursorY").jsonPrimitive.int
        val lines = expected.getValue("lines").jsonArray.map { it.jsonPrimitive.content }
        val ansi = expected.getValue("ansi").jsonPrimitive.content
        val stream = File(dir, "stream.bin").readBytes()
        val chunks = Json.parseToJsonElement(File(dir, "chunks.json").readText()).jsonArray.map {
            val chunk = it.jsonObject
            chunk.getValue("offset").jsonPrimitive.int to chunk.getValue("length").jsonPrimitive.int
        }

        /** Replays the stream with the PTY's own read boundaries, as the WebSocket delivers it. */
        fun play(): TerminalEmulator {
            val emulator = TerminalEmulator(Discard(), cols, rows, 10, 20, null, null)
            for ((offset, length) in chunks) emulator.append(stream.copyOfRange(offset, offset + length), length)
            return emulator
        }
    }

    @Test
    fun fixturesExist() {
        assertTrue(fixtures.isNotEmpty(), "no fixtures under ${File("fixtures/tmux").absolutePath}")
    }

    @Test
    fun everyRowMatchesTmux() {
        val failures = fixtures.map(::Fixture).mapNotNull { fixture ->
            val screen = fixture.play().getScreen()
            val diff = (0 until fixture.rows).mapNotNull { row ->
                val actual = rowText(screen, row)
                val expected = fixture.lines.getOrElse(row) { "" }.trimEnd()
                if (actual == expected) null else "  row $row\n    tmux:   |$expected|\n    engine: |$actual|"
            }
            if (diff.isEmpty()) null else "${fixture.name}:\n${diff.joinToString("\n")}"
        }
        assertTrue(failures.isEmpty(), failures.joinToString("\n"))
    }

    @Test
    fun cursorMatchesTmux() {
        val failures = fixtures.map(::Fixture).mapNotNull { fixture ->
            val emulator = fixture.play()
            // tmux reports a pending wrap as the column past the edge; the engine stays on the last one.
            val expected = minOf(fixture.cursorX, fixture.cols - 1) to fixture.cursorY
            val actual = emulator.getCursorCol() to emulator.getCursorRow()
            if (actual == expected) null else "${fixture.name}: tmux $expected, engine $actual"
        }
        assertTrue(failures.isEmpty(), failures.joinToString("\n"))
    }

    @Test
    fun everyCellStyleMatchesTmux() {
        val failures = fixtures.map(::Fixture).mapNotNull { fixture ->
            val screen = fixture.play().getScreen()
            val expectedRows = parseCapture(fixture.ansi, fixture.cols)
            val diff = (0 until fixture.rows).flatMap { row ->
                val expected = expectedRows.getOrElse(row) { emptyMap() }
                val line = screen.allocateFullLineIfNecessary(screen.externalToInternalRow(row))
                (0 until fixture.cols).mapNotNull { column ->
                    val want = expected[column] ?: CellStyle.DEFAULT
                    val got = CellStyle.of(line.getStyle(column))
                    if (want == got) null else "  ($column,$row) tmux $want, engine $got"
                }
            }
            if (diff.isEmpty()) null else "${fixture.name}: ${diff.size} cells differ\n${diff.take(12).joinToString("\n")}"
        }
        assertTrue(failures.isEmpty(), failures.joinToString("\n"))
    }

    private fun rowText(screen: TerminalBuffer, row: Int): String {
        val line = screen.allocateFullLineIfNecessary(screen.externalToInternalRow(row))
        return line.mText.concatToString(0, line.getSpaceUsed()).trimEnd()
    }

    /** The parts of a cell's style tmux's `capture-pane -e` can express. */
    private data class CellStyle(val fg: Int, val bg: Int, val effects: Int) {
        override fun toString() = "fg=${color(fg)} bg=${color(bg)} effects=${effects.toString(2)}"

        companion object {
            const val COMPARED = TextStyle.CHARACTER_ATTRIBUTE_BOLD or TextStyle.CHARACTER_ATTRIBUTE_ITALIC or
                TextStyle.CHARACTER_ATTRIBUTE_UNDERLINE or TextStyle.CHARACTER_ATTRIBUTE_INVERSE or
                TextStyle.CHARACTER_ATTRIBUTE_STRIKETHROUGH or TextStyle.CHARACTER_ATTRIBUTE_DIM
            val DEFAULT = CellStyle(TextStyle.COLOR_INDEX_FOREGROUND, TextStyle.COLOR_INDEX_BACKGROUND, 0)

            fun of(style: Long) = CellStyle(TextStyle.decodeForeColor(style), TextStyle.decodeBackColor(style), TextStyle.decodeEffect(style) and COMPARED)

            fun color(value: Int) = when {
                value == TextStyle.COLOR_INDEX_FOREGROUND -> "default"
                value == TextStyle.COLOR_INDEX_BACKGROUND -> "default"
                value and -0x1000000 == -0x1000000 -> "#" + (value and 0xffffff).toString(16).padStart(6, '0')
                else -> value.toString()
            }
        }
    }

    /**
     * The style of every column of `capture-pane -p -e` output, keyed by column. tmux writes only SGR
     * sequences, as changes from the previous cell — including the last cell of the previous line,
     * so the state carries across line breaks. A wide character's two columns both carry its style.
     */
    private fun parseCapture(ansi: String, cols: Int): List<Map<Int, CellStyle>> {
        val rows = ansi.split('\n').let { if (it.lastOrNull() == "") it.dropLast(1) else it }
        var style = CellStyle.DEFAULT
        return rows.map { text ->
            val cells = HashMap<Int, CellStyle>()
            var column = 0
            var index = 0
            while (index < text.length && column < cols) {
                val char = text[index]
                if (char == '\u001b' && text.getOrNull(index + 1) == '[') {
                    val end = text.indexOf('m', index + 2)
                    style = applySgr(style, text.substring(index + 2, end))
                    index = end + 1
                    continue
                }
                val codePoint = text.codePointAt(index)
                index += charCount(codePoint)
                val width = WcWidth.width(codePoint)
                if (width <= 0) continue
                repeat(width) { if (column + it < cols) cells[column + it] = style }
                column += width
            }
            cells
        }
    }

    private fun applySgr(current: CellStyle, params: String): CellStyle {
        val codes = if (params.isEmpty()) listOf(0) else params.split(';', ':').map { it.toIntOrNull() ?: 0 }
        var fg = current.fg
        var bg = current.bg
        var effects = current.effects
        var i = 0
        fun extended(): Int? = when (codes.getOrNull(i + 1)) {
            5 -> codes.getOrNull(i + 2).also { i += 2 }
            2 -> {
                val (r, g, b) = Triple(codes.getOrElse(i + 2) { 0 }, codes.getOrElse(i + 3) { 0 }, codes.getOrElse(i + 4) { 0 })
                i += 4
                -0x1000000 or (r shl 16) or (g shl 8) or b
            }
            else -> null
        }
        while (i < codes.size) {
            when (val code = codes[i]) {
                0 -> { fg = TextStyle.COLOR_INDEX_FOREGROUND; bg = TextStyle.COLOR_INDEX_BACKGROUND; effects = 0 }
                1 -> effects = effects or TextStyle.CHARACTER_ATTRIBUTE_BOLD
                2 -> effects = effects or TextStyle.CHARACTER_ATTRIBUTE_DIM
                3 -> effects = effects or TextStyle.CHARACTER_ATTRIBUTE_ITALIC
                4 -> effects = effects or TextStyle.CHARACTER_ATTRIBUTE_UNDERLINE
                7 -> effects = effects or TextStyle.CHARACTER_ATTRIBUTE_INVERSE
                9 -> effects = effects or TextStyle.CHARACTER_ATTRIBUTE_STRIKETHROUGH
                22 -> effects = effects and (TextStyle.CHARACTER_ATTRIBUTE_BOLD or TextStyle.CHARACTER_ATTRIBUTE_DIM).inv()
                23 -> effects = effects and TextStyle.CHARACTER_ATTRIBUTE_ITALIC.inv()
                24 -> effects = effects and TextStyle.CHARACTER_ATTRIBUTE_UNDERLINE.inv()
                27 -> effects = effects and TextStyle.CHARACTER_ATTRIBUTE_INVERSE.inv()
                29 -> effects = effects and TextStyle.CHARACTER_ATTRIBUTE_STRIKETHROUGH.inv()
                in 30..37 -> fg = code - 30
                38 -> extended()?.let { fg = it }
                39 -> fg = TextStyle.COLOR_INDEX_FOREGROUND
                in 40..47 -> bg = code - 40
                48 -> extended()?.let { bg = it }
                49 -> bg = TextStyle.COLOR_INDEX_BACKGROUND
                in 90..97 -> fg = code - 90 + 8
                in 100..107 -> bg = code - 100 + 8
            }
            i++
        }
        return CellStyle(fg, bg, effects)
    }

    @Test
    fun replayThroughput() {
        // Not an assertion on speed (CI machines vary); prints MB/s so a regression is visible in logs.
        // One emulator per fixture, fed its stream over and over: parsing only, no allocation of
        // a fresh 2000-row transcript per round.
        val all = fixtures.map(::Fixture)
        val emulators = all.map { TerminalEmulator(Discard(), it.cols, it.rows, 10, 20, null, null) }
        fun round() = all.forEachIndexed { index, fixture -> emulators[index].append(fixture.stream, fixture.stream.size) }
        repeat(50) { round() }
        val bytes = all.sumOf { it.stream.size }.toLong()
        val rounds = 500
        val started = System.nanoTime()
        repeat(rounds) { round() }
        val seconds = (System.nanoTime() - started) / 1e9
        println("TmuxParityTest: ${"%.1f".format(bytes * rounds / seconds / 1e6)} MB/s parsing ${bytes * rounds / 1_000_000} MB")
        assertEquals(true, seconds > 0)
    }
}
