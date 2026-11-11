package riffet.terminal

import kotlin.test.Test

/**
 * ${CSI}${top};${bottom}r" - set Scrolling Region [top;bottom] (default = full size of window) (DECSTBM).
 * <p/>
 * "DECSTBM moves the cursor to column 1, line 1 of the page" (http://www.vt100.net/docs/vt510-rm/DECSTBM).
 */
class ScrollRegionTest : TerminalTestCase() {

    @Test
    fun testScrollRegionTop() {
        withTerminalSized(3, 4).enterString("111222333444").assertLinesAre("111", "222", "333", "444")
        enterString("\u001b[2r").assertCursorAt(0, 0)
        enterString("\r\n\r\n\r\n\r\nCDEFGH").assertLinesAre("111", "444", "CDE", "FGH").assertHistoryStartsWith("333")
        enterString("IJK").assertLinesAre("111", "CDE", "FGH", "IJK").assertHistoryStartsWith("444")
        // Reset scroll region and enter line:
        enterString("\u001b[r").enterString("\r\n\r\n\r\n").enterString("LMNOPQ").assertLinesAre("CDE", "FGH", "LMN", "OPQ")
    }

    @Test
    fun testScrollRegionBottom() {
        withTerminalSized(3, 4).enterString("111222333444")
        assertLinesAre("111", "222", "333", "444")
        enterString("\u001b[1;3r").assertCursorAt(0, 0)
        enterString("\r\n\r\nCDEFGH").assertLinesAre("222", "CDE", "FGH", "444").assertHistoryStartsWith("111")
        // Reset scroll region and enter line:
        enterString("\u001b[r").enterString("\r\n\r\n\r\n").enterString("IJKLMN").assertLinesAre("CDE", "FGH", "IJK", "LMN")
    }

    @Test
    fun testScrollRegionResetWithOriginMode() {
        withTerminalSized(3, 4).enterString("111222333444")
        assertLinesAre("111", "222", "333", "444")
        // "\033[?6h" sets origin mode, so that the later DECSTBM resets cursor to below margin:
        enterString("\u001b[?6h\u001b[2r").assertCursorAt(1, 0)
    }

    @Test
    fun testScrollRegionLeft() {
        // ${CSI}?69h for DECLRMM enabling, ${CSI}${LEFTMARGIN};${RIGHTMARGIN}s for DECSLRM margin setting.
        withTerminalSized(3, 3).enterString("\u001b[?69h\u001b[2sABCDEFG").assertLinesAre("ABC", " DE", " FG")
        enterString("HI").assertLinesAre("ADE", " FG", " HI").enterString("JK").assertLinesAre("AFG", " HI", " JK")
        enterString("\n").assertLinesAre("AHI", " JK", "   ")
    }

    @Test
    fun testScrollRegionRight() {
        // ${CSI}?69h for DECLRMM enabling, ${CSI}${LEFTMARGIN};${RIGHTMARGIN}s for DECSLRM margin setting.
        withTerminalSized(3, 3).enterString("YYY\u001b[?69h\u001b[1;2sABCDEF").assertLinesAre("ABY", "CD ", "EF ")
        enterString("GH").assertLinesAre("CDY", "EF ", "GH ").enterString("IJ").assertLinesAre("EFY", "GH ", "IJ ")
        enterString("\n").assertLinesAre("GHY", "IJ ", "   ")
    }

    @Test
    fun testScrollRegionOnAllSides() {
        // ${CSI}?69h for DECLRMM enabling, ${CSI}${LEFTMARGIN};${RIGHTMARGIN}s for DECSLRM margin setting.
        withTerminalSized(4, 4).enterString("ABCDEFGHIJKLMNOP").assertLinesAre("ABCD", "EFGH", "IJKL", "MNOP")
        // http://www.vt100.net/docs/vt510-rm/DECOM
        enterString("\u001b[?6h\u001b[2;3r").assertCursorAt(1, 0)
        enterString("\u001b[?69h\u001b[2;3s").assertCursorAt(1, 1)
        enterString("QRST").assertLinesAre("ABCD", "EQRH", "ISTL", "MNOP")
        enterString("UV").assertLinesAre("ABCD", "ESTH", "IUVL", "MNOP")
    }

    @Test
    fun testDECCOLMResetsScrollMargin() {
        // DECCOLM — Select 80 or 132 Columns per Page (http://www.vt100.net/docs/vt510-rm/DECCOLM) has the important
        // side effect to clear scroll margins, which is useful for e.g. the "reset" utility to clear scroll margins.
        withTerminalSized(3, 4).enterString("111222333444").assertLinesAre("111", "222", "333", "444")
        enterString("\u001b[2r\u001b[?3h\r\nABCDEFGHIJKL").assertLinesAre("ABC", "DEF", "GHI", "JKL")
    }

    @Test
    fun testScrollOutsideVerticalRegion() {
        withTerminalSized(3, 4).enterString("\u001b[0;2rhi\u001b[4;0Hyou").assertLinesAre("hi ", "   ", "   ", "you")
        //enterString("see").assertLinesAre("hi ", "   ", "   ", "see");
    }

    @Test
    fun testNELRespectsLeftMargin() {
        // vttest "Menu 11.3.2: VT420 Cursor-Movement Test", select "10. Test other movement (CR/HT/LF/FF) within margins".
        // The NEL (ESC E) sequence moves cursor to first position on next line, where first position depends on origin mode and margin.
        withTerminalSized(3, 3).enterString("\u001b[?69h\u001b[2sABC\u001bED").assertLinesAre("ABC", "D  ", "   ")
        withTerminalSized(3, 3).enterString("\u001b[?69h\u001b[2sABC\u001b[?6h\u001bED").assertLinesAre("ABC", " D ", "   ")
    }

    @Test
    fun testRiRespectsLeftMargin() {
        // Reverse Index (RI), ${ESC}M, should respect horizontal margins:
        withTerminalSized(4, 3).enterString("ABCD\u001b[?69h\u001b[2;3s\u001b[?6h\u001bM").assertLinesAre("A  D", " BC ", "    ")
    }

    @Test
    fun testSdRespectsLeftMargin() {
        // Scroll Down (SD), ${CSI}${N}T, should respect horizontal margins:
        withTerminalSized(4, 3).enterString("ABCD\u001b[?69h\u001b[2;3s\u001b[?6h\u001b[2T").assertLinesAre("A  D", "    ", " BC ")
    }

    @Test
    fun testBackwardIndex() {
        // vttest "Menu 11.3.2: VT420 Cursor-Movement Test", test 7.
        // Without margins:
        withTerminalSized(3, 3).enterString("ABCDEF\u001b6H").assertLinesAre("ABC", "DHF", "   ")
        enterString("\u001b6\u001b6I").assertLinesAre("ABC", "IHF", "   ")
        enterString("\u001b6\u001b6").assertLinesAre(" AB", " IH", "   ")
        // With left margin:
        withTerminalSized(3, 3).enterString("\u001b[?69h\u001b[2sABCDEF\u001b6\u001b6").assertLinesAre("A B", "  D", "  F")
    }

    @Test
    fun testForwardIndex() {
        // vttest "Menu 11.3.2: VT420 Cursor-Movement Test", test 8.
        // Without margins:
        withTerminalSized(3, 3).enterString("ABCD\u001b9E").assertLinesAre("ABC", "D E", "   ")
        enterString("\u001b9").assertLinesAre("BC ", " E ", "   ")
        // With right margin:
        withTerminalSized(3, 3).enterString("\u001b[?69h\u001b[0;2sABCD\u001b9").assertLinesAre("B  ", "D  ", "   ")
    }

    @Test
    fun testScrollDownWithScrollRegion() {
        withTerminalSized(2, 5).enterString("1\r\n2\r\n3\r\n4\r\n5").assertLinesAre("1 ", "2 ", "3 ", "4 ", "5 ")
        enterString("\u001b[3r").enterString("\u001b[2T").assertLinesAre("1 ", "2 ", "  ", "  ", "3 ")
    }

    @Test
    fun testScrollDownBelowScrollRegion() {
        withTerminalSized(2, 5).enterString("1\r\n2\r\n3\r\n4\r\n5").assertLinesAre("1 ", "2 ", "3 ", "4 ", "5 ")
        enterString("\u001b[1;3r") // DECSTBM margins.
        enterString("\u001b[4;1H") // Place cursor just below bottom margin.
        enterString("QQ\r\nRR\r\n\r\n\r\nYY")
        assertLinesAre("1 ", "2 ", "3 ", "QQ", "YY")
    }

    /** See https://github.com/termux/termux-app/issues/1340 */
    @Test
    fun testScrollRegionDoesNotLimitCursorMovement() {
        withTerminalSized(6, 4)
            .enterString("\u001b[4;7r\u001b[3;1Haaa\u001b[Axxx")
            .assertLinesAre(
                "      ",
                "   xxx",
                "aaa   ",
                "      "
            )

        withTerminalSized(6, 4)
            .enterString("\u001b[1;3r\u001b[3;1Haaa\u001b[Bxxx")
            .assertLinesAre(
                "      ",
                "      ",
                "aaa   ",
                "   xxx"
            )
    }

    /**
     * See <a href="https://github.com/termux/termux-packages/issues/12556">reported issue</a>.
     */
    @Test
    fun testClearingWhenScrollingWithMargins() {
        val newForeground = 2
        val newBackground = 3
        val size = 3
        val terminal = withTerminalSized(size, size)
            // Enable horizontal margin and set left margin to 1:
            .enterString("\u001b[?69h\u001b[2s")
            // Set foreground and background color:
            .enterString("\u001b[" + (30 + newForeground) + ";" + (40 + newBackground) + "m")
            // Enter newlines to scroll down:
            .enterString("\r\n\r\n\r\n\r\n\r\n")
        for (row in 0 until size) {
            for (col in 0 until size) {
                // The first column (outside of the scrolling area, due to us setting a left scroll
                // margin of 1) should be unmodified, the others should use the current style:
                val expectedForeground = if (col == 0) TextStyle.COLOR_INDEX_FOREGROUND else newForeground
                val expectedBackground = if (col == 0) TextStyle.COLOR_INDEX_BACKGROUND else newBackground
                terminal.assertForegroundColorAt(row, col, expectedForeground)
                terminal.assertBackgroundColorAt(row, col, expectedBackground)
            }
        }
    }

}
