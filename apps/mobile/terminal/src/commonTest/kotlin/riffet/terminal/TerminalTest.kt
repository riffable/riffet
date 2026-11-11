package riffet.terminal

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class TerminalTest : TerminalTestCase() {

    @Test
    fun testCursorPositioning() {
        withTerminalSized(10, 10).placeCursorAndAssert(1, 2).placeCursorAndAssert(3, 5).placeCursorAndAssert(2, 2).enterString("A")
                .assertCursorAt(2, 3)
    }

    @Test
    fun testScreen() {
        withTerminalSized(3, 3)
        assertLinesAre("   ", "   ", "   ")

        assertEquals("", mTerminal.getScreen().getTranscriptText())
        enterString("hi").assertLinesAre("hi ", "   ", "   ")
        assertEquals("hi", mTerminal.getScreen().getTranscriptText())
        enterString("\r\nu")
        assertEquals("hi\nu", mTerminal.getScreen().getTranscriptText())
        mTerminal.reset()
        assertEquals("hi\nu", mTerminal.getScreen().getTranscriptText())

        withTerminalSized(3, 3).enterString("hello")
        assertEquals("hello", mTerminal.getScreen().getTranscriptText())
        enterString("\r\nworld")
        assertEquals("hello\nworld", mTerminal.getScreen().getTranscriptText())
    }

    @Test
    fun testScrollDownInAltBuffer() {
        withTerminalSized(3, 3).enterString("\u001b[?1049h")
        enterString("\u001b[38;5;111m1\r\n")
        enterString("\u001b[38;5;112m2\r\n")
        enterString("\u001b[38;5;113m3\r\n")
        enterString("\u001b[38;5;114m4\r\n")
        enterString("\u001b[38;5;115m5")
        assertLinesAre("3  ", "4  ", "5  ")
        assertForegroundColorAt(0, 0, 113)
        assertForegroundColorAt(1, 0, 114)
        assertForegroundColorAt(2, 0, 115)
    }

    @Test
    fun testMouseClick() {
        withTerminalSized(10, 10)
        assertFalse(mTerminal.isMouseTrackingActive())
        enterString("\u001b[?1000h")
        assertTrue(mTerminal.isMouseTrackingActive())
        enterString("\u001b[?1000l")
        assertFalse(mTerminal.isMouseTrackingActive())
        enterString("\u001b[?1000h")
        assertTrue(mTerminal.isMouseTrackingActive())

        enterString("\u001b[?1006h")
        mTerminal.sendMouseEvent(TerminalEmulator.MOUSE_LEFT_BUTTON, 3, 4, true)
        assertEquals("\u001b[<0;3;4M", mOutput.getOutputAndClear())
        mTerminal.sendMouseEvent(TerminalEmulator.MOUSE_LEFT_BUTTON, 3, 4, false)
        assertEquals("\u001b[<0;3;4m", mOutput.getOutputAndClear())

        // When the client says that a click is outside (which could happen when pixels are outside
        // the terminal area, see https://github.com/termux/termux-app/issues/501) the terminal
        // sends a click at the edge.
        mTerminal.sendMouseEvent(TerminalEmulator.MOUSE_LEFT_BUTTON, 0, 0, true)
        assertEquals("\u001b[<0;1;1M", mOutput.getOutputAndClear())
        mTerminal.sendMouseEvent(TerminalEmulator.MOUSE_LEFT_BUTTON, 11, 11, false)
        assertEquals("\u001b[<0;10;10m", mOutput.getOutputAndClear())
    }

    @Test
    fun testNormalization() {
        // int lowerCaseN = 0x006E;
        // int combiningTilde = 0x0303;
        // int combined = 0x00F1;
        withTerminalSized(3, 3).assertLinesAre("   ", "   ", "   ")
        enterString("\u006E\u0303")
        assertEquals(1, WcWidth.width("\u006E\u0303".toCharArray(), 0))
        // assertEquals("\u00F1  ", new String(mTerminal.getScreen().getLine(0)));
        assertLinesAre("\u006E\u0303  ", "   ", "   ")
    }

    /** On "\e[18t" xterm replies with "\e[8;${HEIGHT};${WIDTH}t" */
    @Test
    fun testReportTerminalSize() {
        withTerminalSized(5, 5)
        assertEnteringStringGivesResponse("\u001b[18t", "\u001b[8;5;5t")
        for (width in 3 until 12) {
            for (height in 3 until 12) {
                resize(width, height)
                assertEnteringStringGivesResponse("\u001b[18t", "\u001b[8;" + height + ";" + width + "t")
            }
        }
    }

    /** Device Status Report (DSR) and Report Cursor Position (CPR). */
    @Test
    fun testDeviceStatusReport() {
        withTerminalSized(5, 5)
        assertEnteringStringGivesResponse("\u001b[5n", "\u001b[0n")

        assertEnteringStringGivesResponse("\u001b[6n", "\u001b[1;1R")
        enterString("AB")
        assertEnteringStringGivesResponse("\u001b[6n", "\u001b[1;3R")
        enterString("\r\n")
        assertEnteringStringGivesResponse("\u001b[6n", "\u001b[2;1R")
    }

    /** Test the cursor shape changes using DECSCUSR. */
    @Test
    fun testSetCursorStyle() {
        withTerminalSized(5, 5)
        assertEquals(TerminalEmulator.TERMINAL_CURSOR_STYLE_BLOCK, mTerminal.getCursorStyle())
        enterString("\u001b[3 q")
        assertEquals(TerminalEmulator.TERMINAL_CURSOR_STYLE_UNDERLINE, mTerminal.getCursorStyle())
        enterString("\u001b[5 q")
        assertEquals(TerminalEmulator.TERMINAL_CURSOR_STYLE_BAR, mTerminal.getCursorStyle())
        enterString("\u001b[0 q")
        assertEquals(TerminalEmulator.TERMINAL_CURSOR_STYLE_BLOCK, mTerminal.getCursorStyle())
        enterString("\u001b[6 q")
        assertEquals(TerminalEmulator.TERMINAL_CURSOR_STYLE_BAR, mTerminal.getCursorStyle())
        enterString("\u001b[4 q")
        assertEquals(TerminalEmulator.TERMINAL_CURSOR_STYLE_UNDERLINE, mTerminal.getCursorStyle())
        enterString("\u001b[1 q")
        assertEquals(TerminalEmulator.TERMINAL_CURSOR_STYLE_BLOCK, mTerminal.getCursorStyle())
        enterString("\u001b[4 q")
        assertEquals(TerminalEmulator.TERMINAL_CURSOR_STYLE_UNDERLINE, mTerminal.getCursorStyle())
        enterString("\u001b[2 q")
        assertEquals(TerminalEmulator.TERMINAL_CURSOR_STYLE_BLOCK, mTerminal.getCursorStyle())
    }

    @Test
    fun testPaste() {
        withTerminalSized(5, 5)
        mTerminal.paste("hi")
        assertEquals("hi", mOutput.getOutputAndClear())

        enterString("\u001b[?2004h")
        mTerminal.paste("hi")
        assertEquals("\u001b[200~" + "hi" + "\u001b[201~", mOutput.getOutputAndClear())

        enterString("\u001b[?2004l")
        mTerminal.paste("hi")
        assertEquals("hi", mOutput.getOutputAndClear())
    }

    @Test
    fun testSelectGraphics() {
        selectGraphicsTestRun(';')
        selectGraphicsTestRun(':')
    }

    fun selectGraphicsTestRun(separator: Char) {
        withTerminalSized(5, 5)
        enterString("\u001b[31m")
        assertEquals(mTerminal.mForeColor, 1)
        enterString("\u001b[32m")
        assertEquals(mTerminal.mForeColor, 2)
        enterString("\u001b[43m")
        assertEquals(2, mTerminal.mForeColor)
        assertEquals(3, mTerminal.mBackColor)

        // SGR 0 should reset both foreground and background color.
        enterString("\u001b[0m")
        assertEquals(TextStyle.COLOR_INDEX_FOREGROUND, mTerminal.mForeColor)
        assertEquals(TextStyle.COLOR_INDEX_BACKGROUND, mTerminal.mBackColor)

        // Test CSI resetting to default if sequence starts with ; or has sequential ;;
        // Check TerminalEmulator.parseArg()
        enterString("\u001b[31m\u001b[m")
        assertEquals(TextStyle.COLOR_INDEX_FOREGROUND, mTerminal.mForeColor)
        enterString("\u001b[31m\u001b[;m".replace(';', separator))
        assertEquals(TextStyle.COLOR_INDEX_FOREGROUND, mTerminal.mForeColor)
        enterString("\u001b[31m\u001b[0m")
        assertEquals(TextStyle.COLOR_INDEX_FOREGROUND, mTerminal.mForeColor)
        enterString("\u001b[31m\u001b[0;m".replace(';', separator))
        assertEquals(TextStyle.COLOR_INDEX_FOREGROUND, mTerminal.mForeColor)
        enterString("\u001b[31;;m")
        assertEquals(TextStyle.COLOR_INDEX_FOREGROUND, mTerminal.mForeColor)
        enterString("\u001b[31::m")
        assertEquals(1, mTerminal.mForeColor)
        enterString("\u001b[31;m")
        assertEquals(TextStyle.COLOR_INDEX_FOREGROUND, mTerminal.mForeColor)
        enterString("\u001b[31:m")
        assertEquals(1, mTerminal.mForeColor)
        enterString("\u001b[31;;41m")
        assertEquals(TextStyle.COLOR_INDEX_FOREGROUND, mTerminal.mForeColor)
        assertEquals(1, mTerminal.mBackColor)
        enterString("\u001b[0m")
        assertEquals(TextStyle.COLOR_INDEX_BACKGROUND, mTerminal.mBackColor)

        // 256 colors:
        enterString("\u001b[38;5;119m".replace(';', separator))
        assertEquals(119, mTerminal.mForeColor)
        assertEquals(TextStyle.COLOR_INDEX_BACKGROUND, mTerminal.mBackColor)
        enterString("\u001b[48;5;129m".replace(';', separator))
        assertEquals(119, mTerminal.mForeColor)
        assertEquals(129, mTerminal.mBackColor)

        // Invalid parameter:
        enterString("\u001b[48;8;129m".replace(';', separator))
        assertEquals(119, mTerminal.mForeColor)
        assertEquals(129, mTerminal.mBackColor)

        // Multiple parameters at once:
        enterString("\u001b[38;5;178".replace(';', separator) + ";" + "48;5;179m".replace(';', separator))
        assertEquals(178, mTerminal.mForeColor)
        assertEquals(179, mTerminal.mBackColor)

        // Omitted parameter means zero:
        enterString("\u001b[38;5;m".replace(';', separator))
        assertEquals(0, mTerminal.mForeColor)
        assertEquals(179, mTerminal.mBackColor)
        enterString("\u001b[48;5;m".replace(';', separator))
        assertEquals(0, mTerminal.mForeColor)
        assertEquals(0, mTerminal.mBackColor)

        // 24 bit colors:
        enterString(("\u001b[0m")) // Reset fg and bg colors.
        enterString("\u001b[38;2;255;127;2m".replace(';', separator))
        var expectedForeground = 0xff000000.toInt() or (255 shl 16) or (127 shl 8) or 2
        assertEquals(expectedForeground, mTerminal.mForeColor)
        assertEquals(TextStyle.COLOR_INDEX_BACKGROUND, mTerminal.mBackColor)
        enterString("\u001b[48;2;1;2;254m".replace(';', separator))
        val expectedBackground = 0xff000000.toInt() or (1 shl 16) or (2 shl 8) or 254
        assertEquals(expectedForeground, mTerminal.mForeColor)
        assertEquals(expectedBackground, mTerminal.mBackColor)

        // 24 bit colors, set fg and bg at once:
        enterString(("\u001b[0m")) // Reset fg and bg colors.
        assertEquals(TextStyle.COLOR_INDEX_FOREGROUND, mTerminal.mForeColor)
        assertEquals(TextStyle.COLOR_INDEX_BACKGROUND, mTerminal.mBackColor)
        enterString("\u001b[38;2;255;127;2".replace(';', separator) + ";" + "48;2;1;2;254m".replace(';', separator))
        assertEquals(expectedForeground, mTerminal.mForeColor)
        assertEquals(expectedBackground, mTerminal.mBackColor)

        // 24 bit colors, invalid input:
        enterString("\u001b[38;2;300;127;2;48;2;1;300;254m".replace(';', separator))
        assertEquals(expectedForeground, mTerminal.mForeColor)
        assertEquals(expectedBackground, mTerminal.mBackColor)

        // 24 bit colors, omitted parameter means zero:
        enterString("\u001b[38;2;255;127;m".replace(';', separator))
        expectedForeground = 0xff000000.toInt() or (255 shl 16) or (127 shl 8)
        assertEquals(expectedForeground, mTerminal.mForeColor)
        assertEquals(expectedBackground, mTerminal.mBackColor)
        enterString("\u001b[38;2;123;;77m".replace(';', separator))
        expectedForeground = 0xff000000.toInt() or (123 shl 16) or 77
        assertEquals(expectedForeground, mTerminal.mForeColor)
        assertEquals(expectedBackground, mTerminal.mBackColor)

        // 24 bit colors, extra sub-parameters are skipped:
        expectedForeground = 0xff000000.toInt() or (255 shl 16) or (127 shl 8) or 2
        enterString("\u001b[0;38:2:255:127:2:48:2:1:2:254m")
        assertEquals(expectedForeground, mTerminal.mForeColor)
        assertEquals(TextStyle.COLOR_INDEX_BACKGROUND, mTerminal.mBackColor)
    }

    @Test
    fun testBackgroundColorErase() {
        val rows = 3
        val cols = 3
        withTerminalSized(cols, rows)
        for (r in 0 until rows) {
            for (c in 0 until cols) {
                val style = getStyleAt(r, c)
                assertEquals(TextStyle.COLOR_INDEX_FOREGROUND, TextStyle.decodeForeColor(style))
                assertEquals(TextStyle.COLOR_INDEX_BACKGROUND, TextStyle.decodeBackColor(style))
            }
        }
        // Foreground color to 119:
        enterString("\u001b[38;5;119m")
        // Background color to 129:
        enterString("\u001b[48;5;129m")
        // Clear with ED, Erase in Display:
        enterString("\u001b[2J")
        for (r in 0 until rows) {
            for (c in 0 until cols) {
                val style = getStyleAt(r, c)
                assertEquals(119, TextStyle.decodeForeColor(style))
                assertEquals(129, TextStyle.decodeBackColor(style))
            }
        }
        // Background color to 139:
        enterString("\u001b[48;5;139m")
        // Insert two blank lines.
        enterString("\u001b[2L")
        for (r in 0 until rows) {
            for (c in 0 until cols) {
                val style = getStyleAt(r, c)
                assertEquals(if (r == 0 || r == 1) 139 else 129, TextStyle.decodeBackColor(style))
            }
        }

        withTerminalSized(cols, rows)
        // Background color to 129:
        enterString("\u001b[48;5;129m")
        // Erase two characters, filling them with background color:
        enterString("\u001b[2X")
        assertEquals(129, TextStyle.decodeBackColor(getStyleAt(0, 0)))
        assertEquals(129, TextStyle.decodeBackColor(getStyleAt(0, 1)))
        assertEquals(TextStyle.COLOR_INDEX_BACKGROUND, TextStyle.decodeBackColor(getStyleAt(0, 2)))
    }

    @Test
    fun testParseColor() {
        assertEquals(0xFF0000FA.toInt(), TerminalColors.parse("#0000FA"))
        assertEquals(0xFF000000.toInt(), TerminalColors.parse("#000000"))
        assertEquals(0xFF000000.toInt(), TerminalColors.parse("#000"))
        assertEquals(0xFF000000.toInt(), TerminalColors.parse("#000000000"))
        assertEquals(0xFF53186f.toInt(), TerminalColors.parse("#53186f"))

        assertEquals(0xFFFF00FF.toInt(), TerminalColors.parse("rgb:F/0/F"))
        assertEquals(0xFF0000FA.toInt(), TerminalColors.parse("rgb:00/00/FA"))
        assertEquals(0xFF53186f.toInt(), TerminalColors.parse("rgb:53/18/6f"))

        assertEquals(0, TerminalColors.parse("invalid_0000FA"))
        assertEquals(0, TerminalColors.parse("#3456"))
    }

    /** The ncurses library still uses this. */
    @Test
    fun testLineDrawing() {
        // 016 - shift out / G1. 017 - shift in / G0. "ESC ) 0" - use line drawing for G1
        withTerminalSized(4, 2).enterString("q\u001b)0q\u000eq\u000fq").assertLinesAre("qq─q", "    ")
        // "\0337", saving cursor should save G0, G1 and invoked charset and "ESC 8" should restore.
        withTerminalSized(4, 2).enterString("\u001b)0\u000eqqq\u001b7\u000f\u001b8q").assertLinesAre("────", "    ")
    }

    @Test
    fun testSoftTerminalReset() {
        // See http://vt100.net/docs/vt510-rm/DECSTR and https://bugs.debian.org/cgi-bin/bugreport.cgi?bug=650304
        // "\033[?7l" is DECRST to disable wrap-around, and DECSTR ("\033[!p") should reset it.
        withTerminalSized(3, 3).enterString("\u001b[?7lABCD").assertLinesAre("ABD", "   ", "   ")
        enterString("\u001b[!pEF").assertLinesAre("ABE", "F  ", "   ")
    }

    @Test
    fun testBel() {
        withTerminalSized(3, 3)
        assertEquals(0, mOutput.bellsRung)
        enterString("\u0007")
        assertEquals(1, mOutput.bellsRung)
        enterString("hello\u0007")
        assertEquals(2, mOutput.bellsRung)
        enterString("\u0007hello")
        assertEquals(3, mOutput.bellsRung)
        enterString("hello\u0007world")
        assertEquals(4, mOutput.bellsRung)
    }

    @Test
    fun testAutomargins() {
        withTerminalSized(3, 3).enterString("abc").assertLinesAre("abc", "   ", "   ").assertCursorAt(0, 2)
        enterString("d").assertLinesAre("abc", "d  ", "   ").assertCursorAt(1, 1)

        withTerminalSized(3, 3).enterString("abc\r ").assertLinesAre(" bc", "   ", "   ").assertCursorAt(0, 1)
    }

    @Test
    fun testTab() {
        withTerminalSized(11, 2).enterString("01234567890\r\tXX").assertLinesAre("01234567XX0", "           ")
        withTerminalSized(11, 2).enterString("01234567890\u001b[44m\r\tXX").assertLinesAre("01234567XX0", "           ")
    }

}
