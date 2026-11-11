package riffet.terminal

import kotlin.test.Test
import kotlin.test.assertEquals

/** "\033[" is the Control Sequence Introducer char sequence (CSI). */
class ControlSequenceIntroducerTest : TerminalTestCase() {

    /** CSI Ps P Scroll down Ps lines (default = 1) (SD). */
    @Test
    fun testCsiT() {
        withTerminalSized(4, 6).enterString("1\r\n2\r\n3\r\nhi\u001b[2Tyo\r\nA\r\nB").assertLinesAre("    ", "    ", "1   ", "2 yo", "A   ",
                "Bi  ")
        // Default value (1):
        withTerminalSized(4, 6).enterString("1\r\n2\r\n3\r\nhi\u001b[Tyo\r\nA\r\nB").assertLinesAre("    ", "1   ", "2   ", "3 yo", "Ai  ",
                "B   ")
    }

    /** CSI Ps S Scroll up Ps lines (default = 1) (SU). */
    @Test
    fun testCsiS() {
        // The behaviour here is a bit inconsistent between terminals - this is how the OS X Terminal.app does it:
        withTerminalSized(3, 4).enterString("1\r\n2\r\n3\r\nhi\u001b[2Sy").assertLinesAre("3  ", "hi ", "   ", "  y")
        // Default value (1):
        withTerminalSized(3, 4).enterString("1\r\n2\r\n3\r\nhi\u001b[Sy").assertLinesAre("2  ", "3  ", "hi ", "  y")
    }

    /** CSI Ps X  Erase Ps Character(s) (default = 1) (ECH). */
    @Test
    fun testCsiX() {
        // See https://code.google.com/p/chromium/issues/detail?id=212712 where test was extraced from.
        withTerminalSized(13, 2).enterString("abcdefghijkl\b\b\b\b\b\u001b[X").assertLinesAre("abcdefg ijkl ", "             ")
        withTerminalSized(13, 2).enterString("abcdefghijkl\b\b\b\b\b\u001b[1X").assertLinesAre("abcdefg ijkl ", "             ")
        withTerminalSized(13, 2).enterString("abcdefghijkl\b\b\b\b\b\u001b[2X").assertLinesAre("abcdefg  jkl ", "             ")
        withTerminalSized(13, 2).enterString("abcdefghijkl\b\b\b\b\b\u001b[20X").assertLinesAre("abcdefg      ", "             ")
    }

    /** CSI Pm m  Set SGR parameter(s) from semicolon-separated list Pm. */
    @Test
    fun testCsiSGRParameters() {
        // Set more parameters (19) than supported (16).  Additional parameters should be silently consumed.
        withTerminalSized(3, 2).enterString("\u001b[0;38;2;255;255;255;48;2;0;0;0;1;2;3;4;5;7;8;9mabc").assertLinesAre("abc", "   ")
    }

    /** CSI Ps b  Repeat the preceding graphic character Ps times (REP). */
    @Test
    fun testRepeat() {
        withTerminalSized(3, 2).enterString("a\u001b[b").assertLinesAre("aa ", "   ")
        withTerminalSized(3, 2).enterString("a\u001b[2b").assertLinesAre("aaa", "   ")
        // When no char has been output we ignore REP:
        withTerminalSized(3, 2).enterString("\u001b[b").assertLinesAre("   ", "   ")
        // This shows that REP outputs the last emitted code point and not the one relative to the
        // current cursor position:
        withTerminalSized(5, 2).enterString("abcde\u001b[2G\u001b[2b\n").assertLinesAre("aeede", "     ")
    }

    /** CSI 3 J  Clear scrollback (xterm, libvte; non-standard). */
    @Test
    fun testCsi3J() {
        withTerminalSized(3, 2).enterString("a\r\nb\r\nc\r\nd")
        assertEquals("a\nb\nc\nd", mTerminal.getScreen().getTranscriptText())
        enterString("\u001b[3J")
        assertEquals("c\nd", mTerminal.getScreen().getTranscriptText())

        withTerminalSized(3, 2).enterString("Lorem_ipsum")
        assertEquals("Lorem_ipsum", mTerminal.getScreen().getTranscriptText())
        enterString("\u001b[3J")
        assertEquals("ipsum", mTerminal.getScreen().getTranscriptText())

        withTerminalSized(3, 2).enterString("w\r\nx\r\ny\r\nz\u001b[?1049h\u001b[3J\u001b[?1049l")
        assertEquals("y\nz", mTerminal.getScreen().getTranscriptText())
    }

    @Test
    fun testReportPixelSize() {
        var columns = 3
        var rows = 3
        withTerminalSized(columns, rows)
        var cellWidth = TerminalTestCase.INITIAL_CELL_WIDTH_PIXELS
        var cellHeight = TerminalTestCase.INITIAL_CELL_HEIGHT_PIXELS
        assertEnteringStringGivesResponse("\u001b[14t", "\u001b[4;" + (rows*cellHeight) + ";" + (columns*cellWidth) + "t")
        assertEnteringStringGivesResponse("\u001b[16t", "\u001b[6;" + cellHeight + ";" + cellWidth + "t")
        columns = 23
        rows = 33
        resize(columns, rows)
        assertEnteringStringGivesResponse("\u001b[14t", "\u001b[4;" + (rows*cellHeight) + ";" + (columns*cellWidth) + "t")
        assertEnteringStringGivesResponse("\u001b[16t", "\u001b[6;" + cellHeight + ";" + cellWidth + "t")
        cellWidth = 8
        cellHeight = 18
        mTerminal.resize(columns, rows, cellWidth, cellHeight)
        assertEnteringStringGivesResponse("\u001b[14t", "\u001b[4;" + (rows*cellHeight) + ";" + (columns*cellWidth) + "t")
        assertEnteringStringGivesResponse("\u001b[16t", "\u001b[6;" + cellHeight + ";" + cellWidth + "t")
    }

    /**
     * See <a href="https://sw.kovidgoyal.net/kitty/underlines/">Colored and styled underlines</a>:
     *
     * <pre>
     *  <ESC>[4:0m  # no underline
     *  <ESC>[4:1m  # straight underline
     *  <ESC>[4:2m  # double underline
     *  <ESC>[4:3m  # curly underline
     *  <ESC>[4:4m  # dotted underline
     *  <ESC>[4:5m  # dashed underline
     *  <ESC>[4m    # straight underline (for backwards compat)
     *  <ESC>[24m   # no underline (for backwards compat)
     * </pre>
     * <p>
     * We currently parse the variants, but map them to normal/no underlines as appropriate
     */
    @Test
    fun testUnderlineVariants() {
        for (suffix in listOf("", ":1", ":2", ":3", ":4", ":5")) {
            for (stop in listOf("24", "4:0")) {
                withTerminalSized(3, 3)
                enterString("\u001b[4" + suffix + "m").assertLinesAre("   ", "   ", "   ")
                assertEquals(TextStyle.CHARACTER_ATTRIBUTE_UNDERLINE, mTerminal.mEffect)
                enterString("\u001b[4;1m").assertLinesAre("   ", "   ", "   ")
                assertEquals(TextStyle.CHARACTER_ATTRIBUTE_BOLD or TextStyle.CHARACTER_ATTRIBUTE_UNDERLINE, mTerminal.mEffect)
                enterString("\u001b[" + stop + "m").assertLinesAre("   ", "   ", "   ")
                assertEquals(TextStyle.CHARACTER_ATTRIBUTE_BOLD, mTerminal.mEffect)
            }
        }
    }

    @Test
    fun testManyParameters() {
        val b = StringBuilder("\u001b[")
        for (i in 0 until 30) {
            b.append("0;")
        }
        b.append("4:2")
        // This clearing of underline should be ignored as the parameters pass the threshold for too many parameters:
        b.append("4:0m")
        withTerminalSized(3, 3)
            .enterString(b.toString())
            .assertLinesAre("   ", "   ", "   ")
        assertEquals(TextStyle.CHARACTER_ATTRIBUTE_UNDERLINE, mTerminal.mEffect)
    }

}
