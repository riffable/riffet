package riffet.terminal

import kotlin.test.BeforeTest
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.test.fail

abstract class TerminalTestCase {

    companion object {
        const val INITIAL_CELL_WIDTH_PIXELS = 13
        const val INITIAL_CELL_HEIGHT_PIXELS = 15

        private fun describeStyle(styleBits: Int): String {
            return "'" + (if ((styleBits and TextStyle.CHARACTER_ATTRIBUTE_BLINK) != 0) ":BLINK:" else "") +
                (if ((styleBits and TextStyle.CHARACTER_ATTRIBUTE_BOLD) != 0) ":BOLD:" else "") +
                (if ((styleBits and TextStyle.CHARACTER_ATTRIBUTE_INVERSE) != 0) ":INVERSE:" else "") +
                (if ((styleBits and TextStyle.CHARACTER_ATTRIBUTE_INVISIBLE) != 0) ":INVISIBLE:" else "") +
                (if ((styleBits and TextStyle.CHARACTER_ATTRIBUTE_ITALIC) != 0) ":ITALIC:" else "") +
                (if ((styleBits and TextStyle.CHARACTER_ATTRIBUTE_PROTECTED) != 0) ":PROTECTED:" else "") +
                (if ((styleBits and TextStyle.CHARACTER_ATTRIBUTE_STRIKETHROUGH) != 0) ":STRIKETHROUGH:" else "") +
                (if ((styleBits and TextStyle.CHARACTER_ATTRIBUTE_UNDERLINE) != 0) ":UNDERLINE:" else "") + "'"
        }
    }

    open class MockTerminalOutput : TerminalOutput() {
        private var baos = ByteArray(64)
        private var baosSize = 0
        val titleChanges: MutableList<ChangedTitle> = ArrayList()
        val clipboardPuts: MutableList<String> = ArrayList()
        var bellsRung = 0
        var colorsChanged = 0

        override fun write(data: ByteArray, offset: Int, count: Int) {
            if (baosSize + count > baos.size) baos = baos.copyOf(maxOf(baos.size * 2, baosSize + count))
            data.copyInto(baos, baosSize, offset, offset + count)
            baosSize += count
        }

        fun getOutputAndClear(): String {
            val result = baos.decodeToString(0, baosSize)
            baosSize = 0
            return result
        }

        override fun titleChanged(oldTitle: String?, newTitle: String?) {
            titleChanges.add(ChangedTitle(oldTitle, newTitle))
        }

        override fun onCopyTextToClipboard(text: String) {
            clipboardPuts.add(text)
        }

        override fun onPasteTextFromClipboard() {
        }

        override fun onBell() {
            bellsRung++
        }

        override fun onColorsChanged() {
            colorsChanged++
        }
    }

    lateinit var mTerminal: TerminalEmulator
    lateinit var mOutput: MockTerminalOutput

    data class ChangedTitle(val oldTitle: String?, val newTitle: String?) {
        override fun toString(): String = "ChangedTitle[oldTitle=$oldTitle, newTitle=$newTitle]"
    }

    open fun enterString(s: String): TerminalTestCase {
        val bytes = s.encodeToByteArray()
        mTerminal.append(bytes, bytes.size)
        assertInvariants()
        return this
    }

    open fun assertEnteringStringGivesResponse(input: String, expectedResponse: String) {
        enterString(input)
        val response = mOutput.getOutputAndClear()
        assertEquals(expectedResponse, response)
    }

    @BeforeTest
    open fun setUp() {
        mOutput = MockTerminalOutput()
    }

    open fun withTerminalSized(columns: Int, rows: Int): TerminalTestCase {
        // The tests aren't currently using the client, so a null client will suffice, a dummy client should be implemented if needed
        mTerminal = TerminalEmulator(mOutput, columns, rows, INITIAL_CELL_WIDTH_PIXELS, INITIAL_CELL_HEIGHT_PIXELS, rows * 2, null)
        return this
    }

    open fun assertHistoryStartsWith(vararg rows: String) {
        assertTrue(
            mTerminal.getScreen().getActiveTranscriptRows() >= rows.size,
            "About to check " + rows.size + " lines, but only " + mTerminal.getScreen().getActiveTranscriptRows() + " in history"
        )
        for (i in rows.indices) {
            assertLineIs(-i - 1, rows[i])
        }
    }

    open fun assertInvariants(): TerminalTestCase {
        val screen = mTerminal.getScreen()
        val lines = screen.mLines

        // Identity set: a TerminalRow must not be referenced from two places.
        val linesSet = ArrayList<TerminalRow>()
        for (i in lines.indices) {
            val line = lines[i] ?: continue
            assertTrue(linesSet.none { it === line }, "Line exists at multiple places: $i")
            linesSet.add(line)
            val text = line.mText
            val usedChars = line.getSpaceUsed()
            var currentColumn = 0
            var j = 0
            while (j < usedChars) {
                val c = text[j]
                val codePoint: Int
                if (c.isHighSurrogate()) {
                    val lowSurrogate = text[++j]
                    assertTrue(lowSurrogate.isLowSurrogate(), "High surrogate without following low surrogate")
                    codePoint = toCodePoint(c, lowSurrogate)
                } else {
                    assertFalse(c.isLowSurrogate(), "Low surrogate without preceding high surrogate")
                    codePoint = c.code
                }
                // Common code has no code point categories: only BMP characters can be checked here.
                assertFalse(
                    codePoint < MIN_SUPPLEMENTARY_CODE_POINT && codePoint.toChar().category == CharCategory.UNASSIGNED,
                    "Screen should never contain unassigned characters"
                )
                val width = WcWidth.width(codePoint)
                assertFalse(currentColumn == 0 && width < 0, "The first column should not start with combining character")
                if (width > 0) currentColumn += width
                j++
            }
            assertEquals(
                screen.mColumns, currentColumn,
                "Line whose width does not match screens. line=" + line.mText.concatToString(0, line.getSpaceUsed())
            )
        }

        assertEquals(mTerminal.mAltBuffer.mTotalRows, mTerminal.mAltBuffer.mScreenRows, "The alt buffer should have have no history")
        if (mTerminal.isAlternateBufferActive()) {
            assertEquals(mTerminal.mRows, mTerminal.mAltBuffer.mTotalRows, "The alt buffer should be the same size as the screen")
        }

        return this
    }

    open fun assertLineIs(line: Int, expected: String) {
        val l = mTerminal.getScreen().allocateFullLineIfNecessary(mTerminal.getScreen().externalToInternalRow(line))
        val chars = l.mText
        val textLen = l.getSpaceUsed()
        if (textLen != expected.length) fail(
            "Expected '" + expected + "' (len=" + expected.length + "), was='" +
                chars.concatToString(0, textLen) + "' (len=" + textLen + ")"
        )
        for (i in 0 until textLen) {
            if (expected[i] != chars[i])
                fail("Expected '" + expected + "', was='" + chars.concatToString(0, textLen) + "' - first different at index=" + i)
        }
    }

    open fun assertLinesAre(vararg lines: String): TerminalTestCase {
        assertEquals(lines.size, mTerminal.getScreen().mScreenRows)
        for (i in lines.indices)
            try {
                assertLineIs(i, lines[i])
            } catch (e: AssertionError) {
                throw AssertionError("Line: " + i + " - " + e.message)
            }
        return this
    }

    open fun resize(cols: Int, rows: Int): TerminalTestCase {
        mTerminal.resize(cols, rows, INITIAL_CELL_WIDTH_PIXELS, INITIAL_CELL_HEIGHT_PIXELS)
        assertInvariants()
        return this
    }

    open fun assertLineWraps(vararg lines: Boolean): TerminalTestCase {
        for (i in lines.indices)
            assertEquals(lines[i], mTerminal.getScreen().mLines[mTerminal.getScreen().externalToInternalRow(i)]!!.mLineWrap, "line=$i")
        return this
    }

    open fun assertLineStartsWith(line: Int, vararg codePoints: Int): TerminalTestCase {
        val chars = mTerminal.getScreen().mLines[mTerminal.getScreen().externalToInternalRow(line)]!!.mText
        var charIndex = 0
        for (i in codePoints.indices) {
            var lineCodePoint = chars[charIndex++].code
            if (lineCodePoint.toChar().isHighSurrogate()) {
                lineCodePoint = toCodePoint(lineCodePoint.toChar(), chars[charIndex++])
            }
            assertEquals(codePoints[i], lineCodePoint, "Differing a code point index=$i")
        }
        return this
    }

    open fun placeCursorAndAssert(row: Int, col: Int): TerminalTestCase {
        // +1 due to escape sequence being one based.
        enterString("\u001b[" + (row + 1) + ";" + (col + 1) + "H")
        assertCursorAt(row, col)
        return this
    }

    open fun assertCursorAt(row: Int, col: Int): TerminalTestCase {
        val actualRow = mTerminal.getCursorRow()
        val actualCol = mTerminal.getCursorCol()
        if (!(row == actualRow && col == actualCol))
            fail("Expected cursor at (row,col)=($row, $col) but was ($actualRow, $actualCol)")
        return this
    }

    /** For testing only. Encoded style according to [TextStyle]. */
    open fun getStyleAt(externalRow: Int, column: Int): Long {
        return mTerminal.getScreen().getStyleAt(externalRow, column)
    }

    class EffectLine(val styles: IntArray)

    open fun effectLine(vararg bits: Int): EffectLine {
        return EffectLine(bits)
    }

    open fun assertEffectAttributesSet(vararg lines: EffectLine): TerminalTestCase {
        assertEquals(lines.size, mTerminal.getScreen().mScreenRows)
        for (i in lines.indices) {
            val line = lines[i].styles
            for (j in line.indices) {
                val effectsAtCell = TextStyle.decodeEffect(getStyleAt(i, j))
                val attributes = line[j]
                if ((effectsAtCell and attributes) != attributes) fail(
                    "Line=" + i + ", column=" + j + ", expected " +
                        describeStyle(attributes) + " set, was " + describeStyle(effectsAtCell)
                )
            }
        }
        return this
    }

    open fun assertForegroundIndices(vararg lines: EffectLine): TerminalTestCase {
        assertEquals(lines.size, mTerminal.getScreen().mScreenRows)
        for (i in lines.indices) {
            val line = lines[i].styles
            for (j in line.indices) {
                val actualColor = TextStyle.decodeForeColor(getStyleAt(i, j))
                val expectedColor = line[j]
                if (actualColor != expectedColor) fail(
                    "Line=" + i + ", column=" + j + ", expected color " +
                        expectedColor.toUInt().toString(16) + " set, was " + actualColor.toUInt().toString(16)
                )
            }
        }
        return this
    }

    open fun assertForegroundColorAt(externalRow: Int, column: Int, color: Int) {
        val style = mTerminal.getScreen().mLines[mTerminal.getScreen().externalToInternalRow(externalRow)]!!.getStyle(column)
        assertEquals(color, TextStyle.decodeForeColor(style))
    }

    open fun assertBackgroundColorAt(externalRow: Int, column: Int, color: Int) {
        val style = mTerminal.getScreen().mLines[mTerminal.getScreen().externalToInternalRow(externalRow)]!!.getStyle(column)
        assertEquals(color, TextStyle.decodeBackColor(style))
    }

    open fun assertColor(colorIndex: Int, expected: Int): TerminalTestCase {
        val actual = mTerminal.mColors.mCurrentColors[colorIndex]
        if (expected != actual) {
            fail("Color index=" + colorIndex + ", expected=" + expected.toUInt().toString(16) + ", was=" + actual.toUInt().toString(16))
        }
        return this
    }
}
