package riffet.terminal

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * <pre>
 * "CSI ? Pm h", DEC Private Mode Set (DECSET)
 * </pre>
 * <p/>
 * and
 * <p/>
 * <pre>
 * "CSI ? Pm l", DEC Private Mode Reset (DECRST)
 * </pre>
 * <p/>
 * controls various aspects of the terminal
 */
class DecSetTest : TerminalTestCase() {

    /** DECSET 25, DECTCEM, controls visibility of the cursor. */
    @Test
    fun testEnableDisableCursor() {
        withTerminalSized(3, 3)
        assertTrue(mTerminal.isCursorEnabled(), "Initially the cursor should be enabled")
        enterString("\u001b[?25l") // Disable Cursor (DECTCEM).
        assertFalse(mTerminal.isCursorEnabled())
        enterString("\u001b[?25h") // Enable Cursor (DECTCEM).
        assertTrue(mTerminal.isCursorEnabled())

        enterString("\u001b[?25l") // Disable Cursor (DECTCEM), again.
        assertFalse(mTerminal.isCursorEnabled())
        mTerminal.reset()
        assertTrue(mTerminal.isCursorEnabled(), "Resetting the terminal should enable the cursor")

        enterString("\u001b[?25l")
        assertFalse(mTerminal.isCursorEnabled())
        enterString("\u001bc") // RIS resetting should enabled cursor.
        assertTrue(mTerminal.isCursorEnabled())
    }

    /** DECSET 2004, controls bracketed paste mode. */
    @Test
    fun testBracketedPasteMode() {
        withTerminalSized(3, 3)

        mTerminal.paste("a")
        assertEquals("a", mOutput.getOutputAndClear(), "Pasting 'a' should output 'a' when bracketed paste mode is disabled")

        enterString("\u001b[?2004h") // Enable bracketed paste mode.
        mTerminal.paste("a")
        assertEquals("\u001b[200~a\u001b[201~", mOutput.getOutputAndClear(), "Pasting when in bracketed paste mode should be bracketed")

        enterString("\u001b[?2004l") // Disable bracketed paste mode.
        mTerminal.paste("a")
        assertEquals("a", mOutput.getOutputAndClear(), "Pasting 'a' should output 'a' when bracketed paste mode is disabled")

        enterString("\u001b[?2004h") // Enable bracketed paste mode, again.
        mTerminal.paste("a")
        assertEquals("\u001b[200~a\u001b[201~", mOutput.getOutputAndClear(), "Pasting when in bracketed paste mode again should be bracketed")

        mTerminal.paste("\u001bab\u001bcd\u001b")
        assertEquals("\u001b[200~abcd\u001b[201~", mOutput.getOutputAndClear(), "Pasting an escape character should not input it")
        mTerminal.paste("\u0081ab\u0081cd\u009F")
        assertEquals("\u001b[200~abcd\u001b[201~", mOutput.getOutputAndClear(), "Pasting C1 control codes should not input it")

        mTerminal.reset()
        mTerminal.paste("a")
        assertEquals("a", mOutput.getOutputAndClear(), "Terminal reset() should disable bracketed paste mode")
    }

    /** DECSET 7, DECAWM, controls wraparound mode. */
    @Test
    fun testWrapAroundMode() {
        // Default with wraparound:
        withTerminalSized(3, 3).enterString("abcd").assertLinesAre("abc", "d  ", "   ")
        // With wraparound disabled:
        withTerminalSized(3, 3).enterString("\u001b[?7labcd").assertLinesAre("abd", "   ", "   ")
        enterString("efg").assertLinesAre("abg", "   ", "   ")
        // Re-enabling wraparound:
        enterString("\u001b[?7hhij").assertLinesAre("abh", "ij ", "   ")
    }

}
