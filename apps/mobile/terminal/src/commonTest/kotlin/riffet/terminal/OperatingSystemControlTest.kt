package riffet.terminal

import kotlin.io.encoding.Base64
import kotlin.random.Random
import kotlin.test.Ignore
import kotlin.test.Test
import kotlin.test.assertEquals

/** "ESC ]" is the Operating System Command. */
class OperatingSystemControlTest : TerminalTestCase() {

    @Test
    fun testSetTitle() {
        val expectedTitleChanges: MutableList<ChangedTitle> = ArrayList()

        withTerminalSized(10, 10)
        enterString("\u001b]0;Hello, world\u0007")
        assertEquals("Hello, world", mTerminal.getTitle())
        expectedTitleChanges.add(ChangedTitle(null, "Hello, world"))
        assertEquals(expectedTitleChanges, mOutput.titleChanges)

        enterString("\u001b]0;Goodbye, world\u0007")
        assertEquals("Goodbye, world", mTerminal.getTitle())
        expectedTitleChanges.add(ChangedTitle("Hello, world", "Goodbye, world"))
        assertEquals(expectedTitleChanges, mOutput.titleChanges)

        enterString("\u001b]0;Goodbye, \u00F1 world\u0007")
        assertEquals("Goodbye, \u00F1 world", mTerminal.getTitle())
        expectedTitleChanges.add(ChangedTitle("Goodbye, world", "Goodbye, \u00F1 world"))
        assertEquals(expectedTitleChanges, mOutput.titleChanges)

        // 2 should work as well (0 sets both title and icon).
        enterString("\u001b]2;Updated\u0007")
        assertEquals("Updated", mTerminal.getTitle())
        expectedTitleChanges.add(ChangedTitle("Goodbye, \u00F1 world", "Updated"))
        assertEquals(expectedTitleChanges, mOutput.titleChanges)

        enterString("\u001b[22;0t")
        enterString("\u001b]0;FIRST\u0007")
        expectedTitleChanges.add(ChangedTitle("Updated", "FIRST"))
        assertEquals("FIRST", mTerminal.getTitle())
        assertEquals(expectedTitleChanges, mOutput.titleChanges)

        enterString("\u001b[22;0t")
        enterString("\u001b]0;SECOND\u0007")
        assertEquals("SECOND", mTerminal.getTitle())

        expectedTitleChanges.add(ChangedTitle("FIRST", "SECOND"))
        assertEquals(expectedTitleChanges, mOutput.titleChanges)

        enterString("\u001b[23;0t")
        assertEquals("FIRST", mTerminal.getTitle())

        expectedTitleChanges.add(ChangedTitle("SECOND", "FIRST"))
        assertEquals(expectedTitleChanges, mOutput.titleChanges)

        enterString("\u001b[23;0t")
        expectedTitleChanges.add(ChangedTitle("FIRST", "Updated"))
        assertEquals(expectedTitleChanges, mOutput.titleChanges)

        enterString("\u001b[22;0t")
        enterString("\u001b[22;0t")
        enterString("\u001b[22;0t")
        // Popping to same title should not cause changes.
        enterString("\u001b[23;0t")
        enterString("\u001b[23;0t")
        enterString("\u001b[23;0t")
        assertEquals(expectedTitleChanges, mOutput.titleChanges)
    }

    @Test
    fun testTitleStack() {
        // echo -ne '\e]0;BEFORE\007' # set title
        // echo -ne '\e[22t' # push to stack
        // echo -ne '\e]0;AFTER\007' # set new title
        // echo -ne '\e[23t' # retrieve from stack

        withTerminalSized(10, 10)
        enterString("\u001b]0;InitialTitle\u0007")
        assertEquals("InitialTitle", mTerminal.getTitle())
        enterString("\u001b[22t")
        assertEquals("InitialTitle", mTerminal.getTitle())
        enterString("\u001b]0;UpdatedTitle\u0007")
        assertEquals("UpdatedTitle", mTerminal.getTitle())
        enterString("\u001b[23t")
        assertEquals("InitialTitle", mTerminal.getTitle())
        enterString("\u001b[23t\u001b[23t\u001b[23t")
        assertEquals("InitialTitle", mTerminal.getTitle())
    }

    @Test
    fun testSetColor() {
        // "OSC 4; $INDEX; $COLORSPEC BEL" => Change color $INDEX to the color specified by $COLORSPEC.
        withTerminalSized(4, 4).enterString("\u001b]4;5;#00FF00\u0007")
        assertEquals(0xFF00FF00.toInt().toUInt().toString(16), mTerminal.mColors.mCurrentColors[5].toUInt().toString(16))
        enterString("\u001b]4;5;#00FFAB\u0007")
        assertEquals(mTerminal.mColors.mCurrentColors[5], 0xFF00FFAB.toInt())
        enterString("\u001b]4;255;#ABFFAB\u0007")
        assertEquals(mTerminal.mColors.mCurrentColors[255], 0xFFABFFAB.toInt())
        // Two indexed colors at once:
        enterString("\u001b]4;7;#00FF00;8;#0000FF\u0007")
        assertEquals(mTerminal.mColors.mCurrentColors[7], 0xFF00FF00.toInt())
        assertEquals(mTerminal.mColors.mCurrentColors[8], 0xFF0000FF.toInt())
    }

    fun assertIndexColorsMatch(expected: IntArray) {
        for (i in 0 until 255)
            assertEquals(expected[i], mTerminal.mColors.mCurrentColors[i], "index=" + i)
    }

    @Test
    fun testResetColor() {
        withTerminalSized(4, 4)
        val initialColors = IntArray(TextStyle.NUM_INDEXED_COLORS)
        mTerminal.mColors.mCurrentColors.copyInto(initialColors, 0, 0, initialColors.size)
        val expectedColors = IntArray(initialColors.size)
        mTerminal.mColors.mCurrentColors.copyInto(expectedColors, 0, 0, expectedColors.size)
        val rand = Random.Default
        for (endType in 0 until 3) {
            // Both BEL (7) and ST (ESC \) can end an OSC sequence.
            val ender = if (endType == 0) "\u0007" else "\u001b\\"
            for (i in 0 until 255) {
                expectedColors[i] = 0xFF000000.toInt() + (rand.nextInt() and 0xFFFFFF)
                val r = (expectedColors[i] shr 16) and 0xFF
                val g = (expectedColors[i] shr 8) and 0xFF
                val b = expectedColors[i] and 0xFF
                val rgbHex = r.toString(16).padStart(2, '0') + g.toString(16).padStart(2, '0') + b.toString(16).padStart(2, '0')
                enterString("\u001b]4;" + i + ";#" + rgbHex + ender)
                assertEquals(expectedColors[i], mTerminal.mColors.mCurrentColors[i])
            }
        }

        enterString("\u001b]104;0\u0007")
        expectedColors[0] = TerminalColors.COLOR_SCHEME.mDefaultColors[0]
        assertIndexColorsMatch(expectedColors)
        enterString("\u001b]104;1;2\u0007")
        expectedColors[1] = TerminalColors.COLOR_SCHEME.mDefaultColors[1]
        expectedColors[2] = TerminalColors.COLOR_SCHEME.mDefaultColors[2]
        assertIndexColorsMatch(expectedColors)
        enterString("\u001b]104\u0007") // Reset all colors.
        assertIndexColorsMatch(TerminalColors.COLOR_SCHEME.mDefaultColors)
    }

    @Ignore
    @Test
    fun disabledTestSetClipboard() {
        // Disabled upstream, where Base64 was the android.util class.
        enterString("\u001b]52;c;" + Base64.encode("Hello, world".encodeToByteArray()) + "\u0007")
    }

    @Test
    fun testResettingTerminalResetsColor() {
        // "OSC 4; $INDEX; $COLORSPEC BEL" => Change color $INDEX to the color specified by $COLORSPEC.
        withTerminalSized(4, 4).enterString("\u001b]4;5;#00FF00\u0007")
        enterString("\u001b]4;5;#00FFAB\u0007").assertColor(5, 0xFF00FFAB.toInt())
        enterString("\u001b]4;255;#ABFFAB\u0007").assertColor(255, 0xFFABFFAB.toInt())
        mTerminal.reset()
        assertIndexColorsMatch(TerminalColors.COLOR_SCHEME.mDefaultColors)
    }

    @Test
    fun testSettingDynamicColors() {
        // "${OSC}${DYNAMIC};${COLORSPEC}${BEL_OR_STRINGTERMINATOR}" => Change ${DYNAMIC} color to the color specified by $COLORSPEC where:
        // DYNAMIC=10: Text foreground color.
        // DYNAMIC=11: Text background color.
        // DYNAMIC=12: Text cursor color.
        withTerminalSized(3, 3).enterString("\u001b]10;#ABCD00\u0007").assertColor(TextStyle.COLOR_INDEX_FOREGROUND, 0xFFABCD00.toInt())
        enterString("\u001b]11;#0ABCD0\u0007").assertColor(TextStyle.COLOR_INDEX_BACKGROUND, 0xFF0ABCD0.toInt())
        enterString("\u001b]12;#00ABCD\u0007").assertColor(TextStyle.COLOR_INDEX_CURSOR, 0xFF00ABCD.toInt())
        // Two special colors at once
        // ("Each successive parameter changes the next color in the list. The value of P s tells the starting point in the list"):
        enterString("\u001b]10;#FF0000;#00FF00\u0007").assertColor(TextStyle.COLOR_INDEX_FOREGROUND, 0xFFFF0000.toInt())
        assertColor(TextStyle.COLOR_INDEX_BACKGROUND, 0xFF00FF00.toInt())
        // Three at once:
        enterString("\u001b]10;#0000FF;#00FF00;#FF0000\u0007").assertColor(TextStyle.COLOR_INDEX_FOREGROUND, 0xFF0000FF.toInt())
        assertColor(TextStyle.COLOR_INDEX_BACKGROUND, 0xFF00FF00.toInt()).assertColor(TextStyle.COLOR_INDEX_CURSOR, 0xFFFF0000.toInt())

        // Without ending semicolon:
        enterString("\u001b]10;#FF0000\u0007").assertColor(TextStyle.COLOR_INDEX_FOREGROUND, 0xFFFF0000.toInt())
        // For background and cursor:
        enterString("\u001b]11;#FFFF00;\u0007").assertColor(TextStyle.COLOR_INDEX_BACKGROUND, 0xFFFFFF00.toInt())
        enterString("\u001b]12;#00FFFF;\u0007").assertColor(TextStyle.COLOR_INDEX_CURSOR, 0xFF00FFFF.toInt())

        // Using string terminator:
        val stringTerminator = "\u001b\\"
        enterString("\u001b]10;#FF0000" + stringTerminator).assertColor(TextStyle.COLOR_INDEX_FOREGROUND, 0xFFFF0000.toInt())
        // For background and cursor:
        enterString("\u001b]11;#FFFF00;" + stringTerminator).assertColor(TextStyle.COLOR_INDEX_BACKGROUND, 0xFFFFFF00.toInt())
        enterString("\u001b]12;#00FFFF;" + stringTerminator).assertColor(TextStyle.COLOR_INDEX_CURSOR, 0xFF00FFFF.toInt())
    }

    @Test
    fun testReportSpecialColors() {
        // "${OSC}${DYNAMIC};?${BEL}" => Terminal responds with the control sequence which would set the current color.
        // Both xterm and libvte (gnome-terminal and others) use the longest color representation, which means that
        // the response is "${OSC}rgb:RRRR/GGGG/BBBB"
        withTerminalSized(3, 3).enterString("\u001b]10;#ABCD00\u0007").assertColor(TextStyle.COLOR_INDEX_FOREGROUND, 0xFFABCD00.toInt())
        assertEnteringStringGivesResponse("\u001b]10;?\u0007", "\u001b]10;rgb:abab/cdcd/0000\u0007")
        // Same as above but with string terminator. xterm uses the same string terminator in the response, which
        // e.g. script posted at http://superuser.com/questions/157563/programmatic-access-to-current-xterm-background-color
        // relies on:
        assertEnteringStringGivesResponse("\u001b]10;?\u001b\\", "\u001b]10;rgb:abab/cdcd/0000\u001b\\")
    }

}
