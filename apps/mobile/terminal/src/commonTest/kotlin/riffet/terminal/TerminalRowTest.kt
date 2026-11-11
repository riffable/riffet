package riffet.terminal

import kotlin.random.Random
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class TerminalRowTest {

    companion object {
        /** The properties of these code points are validated in [testStaticConstants]. */
        private const val ONE_JAVA_CHAR_DISPLAY_WIDTH_TWO_1 = 0x679C
        private const val ONE_JAVA_CHAR_DISPLAY_WIDTH_TWO_2 = 0x679D
        private const val TWO_JAVA_CHARS_DISPLAY_WIDTH_TWO_1 = 0x2070E
        private const val TWO_JAVA_CHARS_DISPLAY_WIDTH_TWO_2 = 0x20731

        /** Unicode Character 'MUSICAL SYMBOL G CLEF' (U+1D11E). Two java chars required for this. */
        const val TWO_JAVA_CHARS_DISPLAY_WIDTH_ONE_1 = 0x1D11E
        /** Unicode Character 'MUSICAL SYMBOL G CLEF OTTAVA ALTA' (U+1D11F). Two java chars required for this. */
        private const val TWO_JAVA_CHARS_DISPLAY_WIDTH_ONE_2 = 0x1D11F

        /** A combining character. */
        private const val DIARESIS_CODEPOINT = 0x0308
    }

    private val COLUMNS = 80

    private lateinit var row: TerminalRow

    @BeforeTest
    fun setUp() {
        row = TerminalRow(COLUMNS, TextStyle.NORMAL)
    }

    private fun assertLineStartsWith(vararg codePoints: Int) {
        val chars = row.mText
        var charIndex = 0
        for (i in 0 until codePoints.size) {
            var lineCodePoint = chars[charIndex++].code
            if (lineCodePoint.toChar().isHighSurrogate()) {
                lineCodePoint = toCodePoint(lineCodePoint.toChar(), chars[charIndex++])
            }
            assertEquals(codePoints[i], lineCodePoint, "Differing a code point index=" + i)
        }
    }

    private fun assertColumnCharIndicesStartsWith(vararg indices: Int) {
        for (i in 0 until indices.size) {
            val expected = indices[i]
            val actual = row.findStartOfColumn(i)
            assertEquals(expected, actual, "At index=" + i)
        }
    }

    @Test
    fun testSimpleDiaresis() {
        row.setChar(0, DIARESIS_CODEPOINT, 0)
        assertEquals(81, row.getSpaceUsed())
        row.setChar(0, DIARESIS_CODEPOINT, 0)
        assertEquals(82, row.getSpaceUsed())
        assertLineStartsWith(' '.code, DIARESIS_CODEPOINT, DIARESIS_CODEPOINT, ' '.code)
    }

    @Test
    fun testStaticConstants() {
        assertEquals(1, charCount(ONE_JAVA_CHAR_DISPLAY_WIDTH_TWO_1))
        assertEquals(1, charCount(ONE_JAVA_CHAR_DISPLAY_WIDTH_TWO_2))
        assertEquals(2, WcWidth.width(ONE_JAVA_CHAR_DISPLAY_WIDTH_TWO_1))
        assertEquals(2, WcWidth.width(ONE_JAVA_CHAR_DISPLAY_WIDTH_TWO_2))

        assertEquals(2, charCount(TWO_JAVA_CHARS_DISPLAY_WIDTH_ONE_1))
        assertEquals(2, charCount(TWO_JAVA_CHARS_DISPLAY_WIDTH_ONE_2))
        assertEquals(1, WcWidth.width(TWO_JAVA_CHARS_DISPLAY_WIDTH_ONE_1))
        assertEquals(1, WcWidth.width(TWO_JAVA_CHARS_DISPLAY_WIDTH_ONE_2))

        assertEquals(2, charCount(TWO_JAVA_CHARS_DISPLAY_WIDTH_TWO_1))
        assertEquals(2, charCount(TWO_JAVA_CHARS_DISPLAY_WIDTH_TWO_2))
        assertEquals(2, WcWidth.width(TWO_JAVA_CHARS_DISPLAY_WIDTH_TWO_1))
        assertEquals(2, WcWidth.width(TWO_JAVA_CHARS_DISPLAY_WIDTH_TWO_2))

        assertEquals(1, charCount(DIARESIS_CODEPOINT))
        assertEquals(0, WcWidth.width(DIARESIS_CODEPOINT))
    }

    @Test
    fun testOneColumn() {
        assertEquals(0, row.findStartOfColumn(0))
        row.setChar(0, 'a'.code, 0)
        assertEquals(0, row.findStartOfColumn(0))
    }

    @Test
    fun testAscii() {
        assertEquals(0, row.findStartOfColumn(0))
        row.setChar(0, 'a'.code, 0)
        assertLineStartsWith('a'.code, ' '.code, ' '.code)
        assertEquals(1, row.findStartOfColumn(1))
        assertEquals(80, row.getSpaceUsed())
        row.setChar(0, 'b'.code, 0)
        assertEquals(1, row.findStartOfColumn(1))
        assertEquals(2, row.findStartOfColumn(2))
        assertEquals(80, row.getSpaceUsed())
        assertColumnCharIndicesStartsWith(0, 1, 2, 3)

        val someChars = charArrayOf('a', 'c', 'e', '4', '5', '6', '7', '8')

        val rawLine = CharArray(80)
        rawLine.fill(' ')
        val random = Random.Default
        for (i in 0 until 1000) {
            val lineIndex = random.nextInt(rawLine.size)
            val charIndex = random.nextInt(someChars.size)
            rawLine[lineIndex] = someChars[charIndex]
            row.setChar(lineIndex, someChars[charIndex].code, 0)
        }
        val lineChars = row.mText
        for (i in 0 until rawLine.size) {
            assertEquals(rawLine[i], lineChars[i])
        }
    }

    @Test
    fun testUnicode() {
        assertEquals(0, row.findStartOfColumn(0))
        assertEquals(80, row.getSpaceUsed())

        row.setChar(0, TWO_JAVA_CHARS_DISPLAY_WIDTH_ONE_1, 0)
        assertEquals(81, row.getSpaceUsed())
        assertEquals(0, row.findStartOfColumn(0))
        assertEquals(2, row.findStartOfColumn(1))
        assertLineStartsWith(TWO_JAVA_CHARS_DISPLAY_WIDTH_ONE_1, ' '.code, ' '.code)
        assertColumnCharIndicesStartsWith(0, 2, 3, 4)

        row.setChar(0, 'a'.code, 0)
        assertEquals(80, row.getSpaceUsed())
        assertEquals(0, row.findStartOfColumn(0))
        assertEquals(1, row.findStartOfColumn(1))
        assertLineStartsWith('a'.code, ' '.code, ' '.code)
        assertColumnCharIndicesStartsWith(0, 1, 2, 3)

        row.setChar(0, TWO_JAVA_CHARS_DISPLAY_WIDTH_ONE_1, 0)
        row.setChar(1, 'a'.code, 0)
        assertLineStartsWith(TWO_JAVA_CHARS_DISPLAY_WIDTH_ONE_1, 'a'.code, ' '.code)

        row.setChar(0, TWO_JAVA_CHARS_DISPLAY_WIDTH_ONE_1, 0)
        row.setChar(1, TWO_JAVA_CHARS_DISPLAY_WIDTH_ONE_2, 0)
        assertLineStartsWith(TWO_JAVA_CHARS_DISPLAY_WIDTH_ONE_1, TWO_JAVA_CHARS_DISPLAY_WIDTH_ONE_2, ' '.code)
        assertColumnCharIndicesStartsWith(0, 2, 4, 5)
        assertEquals(82, row.getSpaceUsed())
    }

    @Test
    fun testDoubleWidth() {
        row.setChar(0, 'a'.code, 0)
        row.setChar(1, ONE_JAVA_CHAR_DISPLAY_WIDTH_TWO_2, 0)
        assertLineStartsWith('a'.code, ONE_JAVA_CHAR_DISPLAY_WIDTH_TWO_2, ' '.code)
        assertColumnCharIndicesStartsWith(0, 1, 1, 2)
        row.setChar(0, ONE_JAVA_CHAR_DISPLAY_WIDTH_TWO_1, 0)
        assertLineStartsWith(ONE_JAVA_CHAR_DISPLAY_WIDTH_TWO_1, ' '.code, ' '.code)
        assertColumnCharIndicesStartsWith(0, 0, 1, 2)

        row.setChar(0, ' '.code, 0)
        assertLineStartsWith(' '.code, ' '.code, ' '.code, ' '.code)
        assertColumnCharIndicesStartsWith(0, 1, 2, 3, 4)
        row.setChar(0, ONE_JAVA_CHAR_DISPLAY_WIDTH_TWO_1, 0)
        row.setChar(2, ONE_JAVA_CHAR_DISPLAY_WIDTH_TWO_2, 0)
        assertLineStartsWith(ONE_JAVA_CHAR_DISPLAY_WIDTH_TWO_1, ONE_JAVA_CHAR_DISPLAY_WIDTH_TWO_2)
        assertColumnCharIndicesStartsWith(0, 0, 1, 1, 2)
        row.setChar(0, 'a'.code, 0)
        assertLineStartsWith('a'.code, ' '.code, ONE_JAVA_CHAR_DISPLAY_WIDTH_TWO_2, ' '.code)
    }

    /** Just as [testDoubleWidth] but requires a surrogate pair. */
    @Test
    fun testDoubleWidthSurrogage() {
        row.setChar(0, 'a'.code, 0)
        assertColumnCharIndicesStartsWith(0, 1, 2, 3, 4)

        row.setChar(1, TWO_JAVA_CHARS_DISPLAY_WIDTH_TWO_2, 0)
        assertColumnCharIndicesStartsWith(0, 1, 1, 3, 4)
        assertLineStartsWith('a'.code, TWO_JAVA_CHARS_DISPLAY_WIDTH_TWO_2, ' '.code)
        row.setChar(0, TWO_JAVA_CHARS_DISPLAY_WIDTH_TWO_1, 0)
        assertColumnCharIndicesStartsWith(0, 0, 2, 3, 4)
        assertLineStartsWith(TWO_JAVA_CHARS_DISPLAY_WIDTH_TWO_1, ' '.code, ' '.code, ' '.code)

        row.setChar(0, ' '.code, 0)
        assertLineStartsWith(' '.code, ' '.code, ' '.code, ' '.code)
        row.setChar(0, TWO_JAVA_CHARS_DISPLAY_WIDTH_TWO_1, 0)
        row.setChar(1, TWO_JAVA_CHARS_DISPLAY_WIDTH_TWO_2, 0)
        assertLineStartsWith(' '.code, TWO_JAVA_CHARS_DISPLAY_WIDTH_TWO_2, ' '.code)
        row.setChar(0, 'a'.code, 0)
        assertLineStartsWith('a'.code, TWO_JAVA_CHARS_DISPLAY_WIDTH_TWO_2, ' '.code)
    }

    @Test
    fun testReplacementChar() {
        row.setChar(0, TerminalEmulator.UNICODE_REPLACEMENT_CHAR, 0)
        row.setChar(1, 'Y'.code, 0)
        assertLineStartsWith(TerminalEmulator.UNICODE_REPLACEMENT_CHAR, 'Y'.code, ' '.code, ' '.code)
    }

    @Test
    fun testSurrogateCharsWithNormalDisplayWidth() {
        // These requires a UTF-16 surrogate pair, and has a display width of one.
        val first = 0x1D306
        val second = 0x1D307
        // Assert the above statement:
        assertEquals(2, StringBuilder().appendCodePoint(first).length)
        assertEquals(2, StringBuilder().appendCodePoint(second).length)

        row.setChar(0, second, 0)
        assertEquals(second, toCodePoint(row.mText[0], row.mText[1]))
        assertEquals(' ', row.mText[2])
        assertEquals(2, row.findStartOfColumn(1))

        row.setChar(0, first, 0)
        assertEquals(first, toCodePoint(row.mText[0], row.mText[1]))
        assertEquals(' ', row.mText[2])
        assertEquals(2, row.findStartOfColumn(1))

        row.setChar(1, second, 0)
        row.setChar(2, 'a'.code, 0)
        assertEquals(first, toCodePoint(row.mText[0], row.mText[1]))
        assertEquals(second, toCodePoint(row.mText[2], row.mText[3]))
        assertEquals('a', row.mText[4])
        assertEquals(' ', row.mText[5])
        assertEquals(0, row.findStartOfColumn(0))
        assertEquals(2, row.findStartOfColumn(1))
        assertEquals(4, row.findStartOfColumn(2))
        assertEquals(5, row.findStartOfColumn(3))
        assertEquals(6, row.findStartOfColumn(4))

        row.setChar(0, ' '.code, 0)
        assertEquals(' ', row.mText[0])
        assertEquals(second, toCodePoint(row.mText[1], row.mText[2]))
        assertEquals('a', row.mText[3])
        assertEquals(' ', row.mText[4])
        assertEquals(0, row.findStartOfColumn(0))
        assertEquals(1, row.findStartOfColumn(1))
        assertEquals(3, row.findStartOfColumn(2))
        assertEquals(4, row.findStartOfColumn(3))
        assertEquals(5, row.findStartOfColumn(4))

        for (i in 0 until 80) {
            row.setChar(i, if (i % 2 == 0) first else second, 0)
        }
        for (i in 0 until 80) {
            val idx = row.findStartOfColumn(i)
            assertEquals(if (i % 2 == 0) first else second, toCodePoint(row.mText[idx], row.mText[idx + 1]))
        }
        for (i in 0 until 80) {
            row.setChar(i, (if (i % 2 == 0) 'a' else 'b').code, 0)
        }
        for (i in 0 until 80) {
            val idx = row.findStartOfColumn(i)
            assertEquals(i, idx)
            assertEquals(if (i % 2 == 0) 'a' else 'b', row.mText[i])
        }
    }

    @Test
    fun testOverwritingDoubleDisplayWidthWithNormalDisplayWidth() {
        // Initial "OO "
        row.setChar(0, ONE_JAVA_CHAR_DISPLAY_WIDTH_TWO_1, 0)
        assertEquals(ONE_JAVA_CHAR_DISPLAY_WIDTH_TWO_1, row.mText[0].code)
        assertEquals(' ', row.mText[1])
        assertEquals(0, row.findStartOfColumn(0))
        assertEquals(0, row.findStartOfColumn(1))
        assertEquals(1, row.findStartOfColumn(2))

        // Setting first column to a clears second: "a  "
        row.setChar(0, 'a'.code, 0)
        assertEquals('a', row.mText[0])
        assertEquals(' ', row.mText[1])
        assertEquals(0, row.findStartOfColumn(0))
        assertEquals(1, row.findStartOfColumn(1))
        assertEquals(2, row.findStartOfColumn(2))

        // Back to initial "OO "
        row.setChar(0, ONE_JAVA_CHAR_DISPLAY_WIDTH_TWO_1, 0)
        assertEquals(ONE_JAVA_CHAR_DISPLAY_WIDTH_TWO_1, row.mText[0].code)
        assertEquals(' ', row.mText[1])
        assertEquals(0, row.findStartOfColumn(0))
        assertEquals(0, row.findStartOfColumn(1))
        assertEquals(1, row.findStartOfColumn(2))

        // Setting first column to a clears first: " a "
        row.setChar(1, 'a'.code, 0)
        assertEquals(' ', row.mText[0])
        assertEquals('a', row.mText[1])
        assertEquals(' ', row.mText[2])
        assertEquals(0, row.findStartOfColumn(0))
        assertEquals(1, row.findStartOfColumn(1))
        assertEquals(2, row.findStartOfColumn(2))
    }

    @Test
    fun testOverwritingDoubleDisplayWidthWithSelf() {
        row.setChar(0, ONE_JAVA_CHAR_DISPLAY_WIDTH_TWO_1, 0)
        row.setChar(0, ONE_JAVA_CHAR_DISPLAY_WIDTH_TWO_1, 0)
        assertEquals(ONE_JAVA_CHAR_DISPLAY_WIDTH_TWO_1, row.mText[0].code)
        assertEquals(' ', row.mText[1])
        assertEquals(0, row.findStartOfColumn(0))
        assertEquals(0, row.findStartOfColumn(1))
        assertEquals(1, row.findStartOfColumn(2))
    }

    @Test
    fun testNormalCharsWithDoubleDisplayWidth() {
        // These fit in one java char, and has a display width of two.
        assertTrue(ONE_JAVA_CHAR_DISPLAY_WIDTH_TWO_1 != ONE_JAVA_CHAR_DISPLAY_WIDTH_TWO_2)
        assertEquals(1, charCount(ONE_JAVA_CHAR_DISPLAY_WIDTH_TWO_1))
        assertEquals(1, charCount(ONE_JAVA_CHAR_DISPLAY_WIDTH_TWO_2))
        assertEquals(2, WcWidth.width(ONE_JAVA_CHAR_DISPLAY_WIDTH_TWO_1))
        assertEquals(2, WcWidth.width(ONE_JAVA_CHAR_DISPLAY_WIDTH_TWO_2))

        row.setChar(0, ONE_JAVA_CHAR_DISPLAY_WIDTH_TWO_1, 0)
        assertEquals(ONE_JAVA_CHAR_DISPLAY_WIDTH_TWO_1, row.mText[0].code)
        assertEquals(0, row.findStartOfColumn(1))
        assertEquals(' ', row.mText[1])

        row.setChar(0, 'a'.code, 0)
        assertEquals('a', row.mText[0])
        assertEquals(' ', row.mText[1])
        assertEquals(1, row.findStartOfColumn(1))

        row.setChar(0, ONE_JAVA_CHAR_DISPLAY_WIDTH_TWO_1, 0)
        assertEquals(ONE_JAVA_CHAR_DISPLAY_WIDTH_TWO_1, row.mText[0].code)
        // The first character fills both first columns.
        assertEquals(0, row.findStartOfColumn(1))
        row.setChar(2, 'a'.code, 0)
        assertEquals(ONE_JAVA_CHAR_DISPLAY_WIDTH_TWO_1, row.mText[0].code)
        assertEquals('a', row.mText[1])
        assertEquals(1, row.findStartOfColumn(2))

        row.setChar(0, 'c'.code, 0)
        assertEquals('c', row.mText[0])
        assertEquals(' ', row.mText[1])
        assertEquals('a', row.mText[2])
        assertEquals(' ', row.mText[3])
        assertEquals(0, row.findStartOfColumn(0))
        assertEquals(1, row.findStartOfColumn(1))
        assertEquals(2, row.findStartOfColumn(2))
    }

    @Test
    fun testNormalCharsWithDoubleDisplayWidthOverlapping() {
        // These fit in one java char, and has a display width of two.
        row.setChar(0, ONE_JAVA_CHAR_DISPLAY_WIDTH_TWO_1, 0)
        row.setChar(2, ONE_JAVA_CHAR_DISPLAY_WIDTH_TWO_2, 0)
        row.setChar(4, 'a'.code, 0)
        // O = ONE_JAVA_CHAR_DISPLAY_WIDTH_TWO
        // A = ANOTHER_JAVA_CHAR_DISPLAY_WIDTH_TWO
        // "OOAAa    "
        assertEquals(0, row.findStartOfColumn(0))
        assertEquals(0, row.findStartOfColumn(1))
        assertEquals(1, row.findStartOfColumn(2))
        assertEquals(1, row.findStartOfColumn(3))
        assertEquals(2, row.findStartOfColumn(4))
        assertEquals(ONE_JAVA_CHAR_DISPLAY_WIDTH_TWO_1, row.mText[0].code)
        assertEquals(ONE_JAVA_CHAR_DISPLAY_WIDTH_TWO_2, row.mText[1].code)
        assertEquals('a', row.mText[2])
        assertEquals(' ', row.mText[3])

        row.setChar(1, ONE_JAVA_CHAR_DISPLAY_WIDTH_TWO_2, 0)
        // " AA a    "
        assertEquals(' ', row.mText[0])
        assertEquals(ONE_JAVA_CHAR_DISPLAY_WIDTH_TWO_2, row.mText[1].code)
        assertEquals(' ', row.mText[2])
        assertEquals('a', row.mText[3])
        assertEquals(' ', row.mText[4])
        assertEquals(0, row.findStartOfColumn(0))
        assertEquals(1, row.findStartOfColumn(1))
        assertEquals(1, row.findStartOfColumn(2))
        assertEquals(2, row.findStartOfColumn(3))
        assertEquals(3, row.findStartOfColumn(4))
    }

    // https://github.com/jackpal/Android-Terminal-Emulator/issues/145
    @Test
    fun testCrashATE145() {
        // 0xC2541 is unassigned, use display width 1 for UNICODE_REPLACEMENT_CHAR.
        // assertEquals(1, WcWidth.width(0xC2541));
        assertEquals(2, charCount(0xC2541))

        assertEquals(2, WcWidth.width(0x73EE))
        assertEquals(1, charCount(0x73EE))

        assertEquals(0, WcWidth.width(0x009F))
        assertEquals(1, charCount(0x009F))

        val points = intArrayOf(0xC2541, 'a'.code, '8'.code, 0x73EE, 0x009F, 0x881F, 0x8324, 0xD4C9, 0xFFFD, 'B'.code, 0x009B, 0x61C9, 'Z'.code)
        // int[] expected = new int[] { TerminalEmulator.UNICODE_REPLACEMENT_CHAR, 'a', '8', 0x73EE, 0x009F, 0x881F, 0x8324, 0xD4C9, 0xFFFD,
        // 'B', 0x009B, 0x61C9, 'Z' };
        var currentColumn = 0
        for (point in points) {
            row.setChar(currentColumn, point, 0)
            currentColumn += WcWidth.width(point)
        }
        // assertLineStartsWith(points);
        // assertEquals(Character.highSurrogate(0xC2541), line.mText[0]);
        // assertEquals(Character.lowSurrogate(0xC2541), line.mText[1]);
        // assertEquals('a', line.mText[2]);
        // assertEquals('8', line.mText[3]);
        // assertEquals(Character.highSurrogate(0x73EE), line.mText[4]);
        // assertEquals(Character.lowSurrogate(0x73EE), line.mText[5]);
        //
        // char[] chars = line.mText;
        // int charIndex = 0;
        // for (int i = 0; i < points.length; i++) {
        // char c = chars[charIndex];
        // charIndex++;
        // int thisPoint = (int) c;
        // if (Character.isHighSurrogate(c)) {
        // thisPoint = Character.toCodePoint(c, chars[charIndex]);
        // charIndex++;
        // }
        // assertEquals("At index=" + i + ", charIndex=" + charIndex + ", char=" + (char) thisPoint, points[i], thisPoint);
        // }
    }

    @Test
    fun testNormalization() {
        // int lowerCaseN = 0x006E;
        // int combiningTilde = 0x0303;
        // int combined = 0x00F1;
        row.setChar(0, 0x006E, 0)
        assertEquals(80, row.getSpaceUsed())
        row.setChar(0, 0x0303, 0)
        assertEquals(81, row.getSpaceUsed())
        // assertEquals("\u00F1  ", new String(term.getScreen().getLine(0)));
        assertLineStartsWith(0x006E, 0x0303, ' '.code)
    }

    @Test
    fun testInsertWideAtLastColumn() {
        row.setChar(COLUMNS - 2, 'Z'.code, 0)
        row.setChar(COLUMNS - 1, 'a'.code, 0)
        assertEquals('Z', row.mText[row.findStartOfColumn(COLUMNS - 2)])
        assertEquals('a', row.mText[row.findStartOfColumn(COLUMNS - 1)])
        row.setChar(COLUMNS - 1, 'ö'.code, 0)
        assertEquals('Z', row.mText[row.findStartOfColumn(COLUMNS - 2)])
        assertEquals('ö', row.mText[row.findStartOfColumn(COLUMNS - 1)])
        // line.setChar(COLUMNS - 1, ONE_JAVA_CHAR_DISPLAY_WIDTH_TWO_1);
        // assertEquals('Z', line.mText[line.findStartOfColumn(COLUMNS - 2)]);
        // assertEquals(' ', line.mText[line.findStartOfColumn(COLUMNS - 1)]);
    }

}
