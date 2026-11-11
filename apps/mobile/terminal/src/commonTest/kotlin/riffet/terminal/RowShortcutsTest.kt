package riffet.terminal

import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * `TerminalRow.clearFrom` and `copyAllFrom` replace upstream's per-cell `setChar` loops; on any
 * row they must leave exactly the cells (text and style) the loops would.
 */
class RowShortcutsTest {
    private val alphabet = intArrayOf('a'.code, 'Z'.code, ' '.code, '─'.code, '中'.code, '文'.code, 0x1F642, 0x301, 0xFF21)

    private fun randomRow(random: Random, columns: Int): TerminalRow {
        val row = TerminalRow(columns, TextStyle.NORMAL)
        repeat(columns * 2) {
            val column = random.nextInt(columns)
            val codePoint = alphabet[random.nextInt(alphabet.size)]
            if (WcWidth.width(codePoint) == 2 && column >= columns - 1) return@repeat
            row.setChar(column, codePoint, TextStyle.encode(random.nextInt(16), random.nextInt(16), 0))
        }
        return row
    }

    private fun cells(row: TerminalRow, columns: Int): String =
        row.mText.concatToString(0, row.getSpaceUsed()) + "|" + (0 until columns).joinToString(",") { row.getStyle(it).toString() }

    private fun copyOf(row: TerminalRow, columns: Int) = TerminalRow(columns, TextStyle.NORMAL).also { it.copyInterval(row, 0, columns, 0) }

    @Test
    fun clearFromMatchesPerCellBlanking() {
        val random = Random(7)
        repeat(2000) {
            val columns = 2 + random.nextInt(30)
            val row = randomRow(random, columns)
            val column = random.nextInt(columns)
            val style = TextStyle.encode(3, 4, 0)
            val expected = copyOf(row, columns).also { reference -> for (x in column until columns) reference.setChar(x, ' '.code, style) }
            val actual = copyOf(row, columns).also { it.clearFrom(column, style) }
            assertEquals(cells(expected, columns), cells(actual, columns), "clearFrom($column) on |${row.mText.concatToString(0, row.getSpaceUsed())}|")
        }
    }

    @Test
    fun copyAllFromMatchesCopyInterval() {
        val random = Random(11)
        repeat(2000) {
            val columns = 2 + random.nextInt(30)
            val source = randomRow(random, columns)
            val destination = randomRow(random, columns)
            val expected = copyOf(destination, columns).also { it.copyInterval(source, 0, columns, 0) }
            val actual = copyOf(destination, columns).also { it.copyAllFrom(source) }
            assertEquals(cells(expected, columns), cells(actual, columns), "source ${cells(source, columns)}\ndestination ${cells(destination, columns)}")
        }
    }
}
