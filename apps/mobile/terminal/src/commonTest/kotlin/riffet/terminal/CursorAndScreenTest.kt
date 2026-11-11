package riffet.terminal

import kotlin.test.Ignore
import kotlin.test.Test
import kotlin.test.assertEquals

class CursorAndScreenTest : TerminalTestCase() {

    @Test
    fun testDeleteLinesKeepsStyles() {
        val cols = 5
        val rows = 5
        withTerminalSized(cols, rows)
        for (row in 0 until 5) {
            for (col in 0 until 5) {
                // Foreground color to col, background to row:
                enterString("\u001b[38;5;" + col + "m")
                enterString("\u001b[48;5;" + row + "m")
                enterString(('A' + col + row * 5).toString())
            }
        }
        assertLinesAre("ABCDE", "FGHIJ", "KLMNO", "PQRST", "UVWXY")
        for (row in 0 until 5) {
            for (col in 0 until 5) {
                val s = getStyleAt(row, col)
                assertEquals(col, TextStyle.decodeForeColor(s))
                assertEquals(row, TextStyle.decodeBackColor(s))
            }
        }
        // "${CSI}H" - place cursor at 1,1, then "${CSI}2M" to delete two lines.
        enterString("\u001b[H\u001b[2M")
        assertLinesAre("KLMNO", "PQRST", "UVWXY", "     ", "     ")
        for (row in 0 until 3) {
            for (col in 0 until 5) {
                val s = getStyleAt(row, col)
                assertEquals(col, TextStyle.decodeForeColor(s))
                assertEquals(row + 2, TextStyle.decodeBackColor(s))
            }
        }
        // Set default fg and background for the new blank lines:
        enterString("\u001b[38;5;98m")
        enterString("\u001b[48;5;99m")
        // "${CSI}B" to go down one line, then "${CSI}2L" to insert two lines:
        enterString("\u001b[B\u001b[2L")
        assertLinesAre("KLMNO", "     ", "     ", "PQRST", "UVWXY")
        for (row in 0 until 5) {
            for (col in 0 until 5) {
                val wantedForeground = if (row == 1 || row == 2) 98 else col
                val wantedBackground = if (row == 1 || row == 2) 99 else (if (row == 0) 2 else row)
                val s = getStyleAt(row, col)
                assertEquals(wantedForeground, TextStyle.decodeForeColor(s))
                assertEquals(wantedBackground, TextStyle.decodeBackColor(s))
            }
        }
    }

    @Test
    fun testDeleteCharacters() {
        withTerminalSized(5, 2).enterString("枝ce").assertLinesAre("枝ce ", "     ")
        withTerminalSized(5, 2).enterString("a枝ce").assertLinesAre("a枝ce", "     ")
        withTerminalSized(5, 2).enterString("nice").enterString("\u001b[G\u001b[P").assertLinesAre("ice  ", "     ")
        withTerminalSized(5, 2).enterString("nice").enterString("\u001b[G\u001b[2P").assertLinesAre("ce   ", "     ")
        withTerminalSized(5, 2).enterString("nice").enterString("\u001b[2G\u001b[2P").assertLinesAre("ne   ", "     ")
        // "${CSI}${n}P, the delete characters (DCH) sequence should cap characters to delete.
        withTerminalSized(5, 2).enterString("nice").enterString("\u001b[G\u001b[99P").assertLinesAre("     ", "     ")
        // With combining char U+0302.
        withTerminalSized(5, 2).enterString("n\u0302ice").enterString("\u001b[G\u001b[2P").assertLinesAre("ce   ", "     ")
        withTerminalSized(5, 2).enterString("n\u0302ice").enterString("\u001b[G\u001b[P").assertLinesAre("ice  ", "     ")
        withTerminalSized(5, 2).enterString("n\u0302ice").enterString("\u001b[2G\u001b[2P").assertLinesAre("n\u0302e   ", "     ")
        // With wide 枝 char, checking that putting char at part replaces other with whitespace:
        withTerminalSized(5, 2).enterString("枝ce").enterString("\u001b[Ga").assertLinesAre("a ce ", "     ")
        withTerminalSized(5, 2).enterString("枝ce").enterString("\u001b[2Ga").assertLinesAre(" ace ", "     ")
        // With wide 枝 char, deleting either part replaces other with whitespace:
        withTerminalSized(5, 2).enterString("枝ce").enterString("\u001b[G\u001b[P").assertLinesAre(" ce  ", "     ")
        withTerminalSized(5, 2).enterString("枝ce").enterString("\u001b[2G\u001b[P").assertLinesAre(" ce  ", "     ")
        withTerminalSized(5, 2).enterString("枝ce").enterString("\u001b[2G\u001b[2P").assertLinesAre(" e   ", "     ")
        withTerminalSized(5, 2).enterString("枝ce").enterString("\u001b[G\u001b[2P").assertLinesAre("ce   ", "     ")
        withTerminalSized(5, 2).enterString("a枝ce").enterString("\u001b[G\u001b[P").assertLinesAre("枝ce ", "     ")
    }

    @Test
    fun testInsertMode() {
        // "${CSI}4h" enables insert mode.
        withTerminalSized(5, 2).enterString("nice").enterString("\u001b[G\u001b[4hA").assertLinesAre("Anice", "     ")
        withTerminalSized(5, 2).enterString("nice").enterString("\u001b[2G\u001b[4hA").assertLinesAre("nAice", "     ")
        withTerminalSized(5, 2).enterString("nice").enterString("\u001b[G\u001b[4hABC").assertLinesAre("ABCni", "     ")
        // With combining char U+0302.
        withTerminalSized(5, 2).enterString("n\u0302ice").enterString("\u001b[G\u001b[4hA").assertLinesAre("An\u0302ice", "     ")
        withTerminalSized(5, 2).enterString("n\u0302ice").enterString("\u001b[G\u001b[4hAB").assertLinesAre("ABn\u0302ic", "     ")
        withTerminalSized(5, 2).enterString("n\u0302ic\u0302e").enterString("\u001b[2G\u001b[4hA").assertLinesAre("n\u0302Aic\u0302e", "     ")
        // ... but without insert mode, combining char should be overwritten:
        withTerminalSized(5, 2).enterString("n\u0302ice").enterString("\u001b[GA").assertLinesAre("Aice ", "     ")
        // ... also with two combining:
        withTerminalSized(5, 2).enterString("n\u0302\u0302i\u0302ce").enterString("\u001b[GA").assertLinesAre("Ai\u0302ce ", "     ")
        // ... and in last column:
        withTerminalSized(5, 2).enterString("n\u0302\u0302ice!\u0302").enterString("\u001b[5GA").assertLinesAre("n\u0302\u0302iceA", "     ")
        withTerminalSized(5, 2).enterString("nic\u0302e!\u0302").enterString("\u001b[4G枝").assertLinesAre("nic\u0302枝", "     ")
        withTerminalSized(5, 2).enterString("nic枝\u0302").enterString("\u001b[3GA").assertLinesAre("niA枝\u0302", "     ")
        withTerminalSized(5, 2).enterString("nic枝\u0302").enterString("\u001b[3GA").assertLinesAre("niA枝\u0302", "     ")
        // With wide 枝 char.
        withTerminalSized(5, 2).enterString("nice").enterString("\u001b[G\u001b[4h枝").assertLinesAre("枝nic", "     ")
        withTerminalSized(5, 2).enterString("nice").enterString("\u001b[2G\u001b[4h枝").assertLinesAre("n枝ic", "     ")
        withTerminalSized(5, 2).enterString("n枝ce").enterString("\u001b[G\u001b[4ha").assertLinesAre("an枝c", "     ")
    }

    /** HPA—Horizontal Position Absolute (http://www.vt100.net/docs/vt510-rm/HPA) */
    @Test
    fun testCursorHorizontalPositionAbsolute() {
        withTerminalSized(4, 4).enterString("ABC\u001b[`").assertCursorAt(0, 0)
        enterString("\u001b[1`").assertCursorAt(0, 0).enterString("\u001b[2`").assertCursorAt(0, 1)
        enterString("\r\n\u001b[3`").assertCursorAt(1, 2).enterString("\u001b[22`").assertCursorAt(1, 3)
        // Enable and configure right and left margins, first without origin mode:
        enterString("\u001b[?69h\u001b[2;3s\u001b[`").assertCursorAt(0, 0).enterString("\u001b[22`").assertCursorAt(0, 3)
        // .. now with origin mode:
        enterString("\u001b[?6h\u001b[`").assertCursorAt(0, 1).enterString("\u001b[22`").assertCursorAt(0, 2)
    }

    @Test
    fun testCursorForward() {
        // "${CSI}${N:=1}C" moves cursor forward N columns:
        withTerminalSized(6, 2).enterString("A\u001b[CB\u001b[2CC").assertLinesAre("A B  C", "      ")
        // If an attempt is made to move the cursor to the right of the right margin, the cursor stops at the right margin:
        withTerminalSized(6, 2).enterString("A\u001b[44CB").assertLinesAre("A    B", "      ")
        // Enable right margin and verify that CUF ends at the set right margin:
        withTerminalSized(6, 2).enterString("\u001b[?69h\u001b[1;3s\u001b[44CAB").assertLinesAre("  A   ", "B     ")
    }

    @Test
    fun testCursorBack() {
        // "${CSI}${N:=1}D" moves cursor back N columns:
        withTerminalSized(3, 2).enterString("A\u001b[DB").assertLinesAre("B  ", "   ")
        withTerminalSized(3, 2).enterString("AB\u001b[2DC").assertLinesAre("CB ", "   ")
        // If an attempt is made to move the cursor to the left of the left margin, the cursor stops at the left margin:
        withTerminalSized(3, 2).enterString("AB\u001b[44DC").assertLinesAre("CB ", "   ")
        // Enable left margin and verify that CUB ends at the set left margin:
        withTerminalSized(6, 2).enterString("ABCD\u001b[?69h\u001b[2;6s\u001b[44DE").assertLinesAre("AECD  ", "      ")
    }

    @Test
    fun testCursorUp() {
        // "${CSI}${N:=1}A" moves cursor up N rows:
        withTerminalSized(3, 3).enterString("ABCDEFG\u001b[AH").assertLinesAre("ABC", "DHF", "G  ")
        withTerminalSized(3, 3).enterString("ABCDEFG\u001b[2AH").assertLinesAre("AHC", "DEF", "G  ")
        // If an attempt is made to move the cursor above the top margin, the cursor stops at the top margin:
        withTerminalSized(3, 3).enterString("ABCDEFG\u001b[44AH").assertLinesAre("AHC", "DEF", "G  ")
    }

    @Test
    fun testCursorDown() {
        // "${CSI}${N:=1}B" moves cursor down N rows:
        withTerminalSized(3, 3).enterString("AB\u001b[BC").assertLinesAre("AB ", "  C", "   ")
        withTerminalSized(3, 3).enterString("AB\u001b[2BC").assertLinesAre("AB ", "   ", "  C")
        // If an attempt is made to move the cursor below the bottom margin, the cursor stops at the bottom margin:
        withTerminalSized(3, 3).enterString("AB\u001b[44BC").assertLinesAre("AB ", "   ", "  C")
    }

    @Test
    fun testReportCursorPosition() {
        withTerminalSized(10, 10)
        for (i in 0 until 10) {
            for (j in 0 until 10) {
                enterString("\u001b[" + (i + 1) + ";" + (j + 1) + "H") // CUP cursor position.
                assertCursorAt(i, j)
                // Device Status Report (DSR):
                assertEnteringStringGivesResponse("\u001b[6n", "\u001b[" + (i + 1) + ";" + (j + 1) + "R")
                // DECXCPR — Extended Cursor Position. Note that http://www.vt100.net/docs/vt510-rm/DECXCPR says
                // the response is "${CSI}${LINE};${COLUMN};${PAGE}R" while xterm (http://invisible-island.net/xterm/ctlseqs/ctlseqs.html)
                // drops the question mark. Expect xterm behaviour here.
                assertEnteringStringGivesResponse("\u001b[?6n", "\u001b[?" + (i + 1) + ";" + (j + 1) + ";1R")
            }
        }
    }

    /**
     * See comments on horizontal tab handling in TerminalEmulator.java.
     * <p/>
     * We do not want to color already written cells when tabbing over them.
     */
    @Ignore
    @Test
    fun DISABLED_testHorizontalTabColorsBackground() {
        withTerminalSized(10, 3).enterString("\u001b[48;5;15m").enterString("\t")
        assertCursorAt(0, 8)
        for (i in 0 until 10) {
            val expectedColor = if (i < 8) 15 else TextStyle.COLOR_INDEX_BACKGROUND
            assertEquals(expectedColor, TextStyle.decodeBackColor(getStyleAt(0, i)))
        }
    }

    /**
     * Test interactions between the cursor overflow bit and various escape sequences.
     * <p/>
     * Adapted from hterm:
     * https://chromium.googlesource.com/chromiumos/platform/assets/+/2337afa5c063127d5ce40ec7fec9b602d096df86%5E%21/#F2
     */
    @Test
    fun testClearingOfAutowrap() {
        // Fill a row with the last hyphen wrong, then run a command that
        // modifies the screen, then add a hyphen. The wrap bit should be
        // cleared, so the extra hyphen can fix the row.
        withTerminalSized(15, 6)

        enterString("-----  1  ----X")
        enterString("\u001b[K-")  // EL

        enterString("-----  2  ----X")
        enterString("\u001b[J-")  // ED

        enterString("-----  3  ----X")
        enterString("\u001b[@-")  // ICH

        enterString("-----  4  ----X")
        enterString("\u001b[P-")  // DCH

        enterString("-----  5  ----X")
        enterString("\u001b[X-")  // ECH

        // DL will delete the entire line but clear the wrap bit, so we
        // expect a hyphen at the end and nothing else.
        enterString("XXXXXXXXXXXXXXX")
        enterString("\u001b[M-")  // DL

        assertLinesAre(
                "-----  1  -----",
                "-----  2  -----",
                "-----  3  -----",
                "-----  4  -----",
                "-----  5  -----",
                "              -")
    }

    @Test
    fun testBackspaceAcrossWrappedLines() {
        // Backspace should not go to previous line if not auto-wrapped:
        withTerminalSized(3, 3).enterString("hi\r\n\b\byou").assertLinesAre("hi ", "you", "   ")
        // Backspace should go to previous line if auto-wrapped:
        withTerminalSized(3, 3).enterString("hi y").assertLinesAre("hi ", "y  ", "   ").enterString("\b\b#").assertLinesAre("hi#", "y  ", "   ")
        // Initial backspace should do nothing:
        withTerminalSized(3, 3).enterString("\b\b\b\bhi").assertLinesAre("hi ", "   ", "   ")
    }

    @Test
    fun testCursorSaveRestoreLocation() {
        // DEC save/restore
        withTerminalSized(4, 2).enterString("t\u001b7est\r\nme\u001b8ry ").assertLinesAre("try ", "me  ")
        // ANSI.SYS save/restore
        withTerminalSized(4, 2).enterString("t\u001b[sest\r\nme\u001b[ury ").assertLinesAre("try ", "me  ")
        // Alternate screen enter/exit
        withTerminalSized(4, 2).enterString("t\u001b[?1049h\u001b[Hest\r\nme").assertLinesAre("est ", "me  ").enterString("\u001b[?1049lry").assertLinesAre("try ", "    ")
    }

    @Test
    fun testCursorSaveRestoreTextStyle() {
        var s: Long

        // DEC save/restore
        withTerminalSized(4, 2).enterString("\u001b[31;42;4m..\u001b7\u001b[36;47;24m\u001b8..")
        s = getStyleAt(0, 3)
        assertEquals(1, TextStyle.decodeForeColor(s))
        assertEquals(2, TextStyle.decodeBackColor(s))
        assertEquals(TextStyle.CHARACTER_ATTRIBUTE_UNDERLINE, TextStyle.decodeEffect(s))

        // ANSI.SYS save/restore
        withTerminalSized(4, 2).enterString("\u001b[31;42;4m..\u001b[s\u001b[36;47;24m\u001b[u..")
        s = getStyleAt(0, 3)
        assertEquals(1, TextStyle.decodeForeColor(s))
        assertEquals(2, TextStyle.decodeBackColor(s))
        assertEquals(TextStyle.CHARACTER_ATTRIBUTE_UNDERLINE, TextStyle.decodeEffect(s))

        // Alternate screen enter/exit
        withTerminalSized(4, 2)
        enterString("\u001b[31;42;4m..\u001b[?1049h\u001b[H\u001b[36;47;24m.")
        s = getStyleAt(0, 0)
        assertEquals(6, TextStyle.decodeForeColor(s))
        assertEquals(7, TextStyle.decodeBackColor(s))
        assertEquals(0, TextStyle.decodeEffect(s))
        enterString("\u001b[?1049l..")
        s = getStyleAt(0, 3)
        assertEquals(1, TextStyle.decodeForeColor(s))
        assertEquals(2, TextStyle.decodeBackColor(s))
        assertEquals(TextStyle.CHARACTER_ATTRIBUTE_UNDERLINE, TextStyle.decodeEffect(s))
    }

}
