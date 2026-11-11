package riffet.terminal

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class KeyHandlerTest {

    private fun stringToHex(s: String?): String? {
        if (s == null) return null
        val buffer = StringBuilder()
        for (i in 0 until s.length) {
            if (buffer.length > 0) {
                buffer.append(" ")
            }
            buffer.append("0x")
            buffer.append(s[i].code.toString(16))
        }
        return buffer.toString()
    }

    private fun assertKeysEquals(expected: String, actual: String?) {
        if (expected != actual) {
            assertEquals(stringToHex(expected), stringToHex(actual))
        }
    }

    /** See http://pubs.opengroup.org/onlinepubs/7990989799/xcurses/terminfo.html */
    @Test
    fun testTermCaps() {
        // Backspace.
        assertKeysEquals("\u007f", KeyHandler.getCodeFromTermcap("kb", false, false))

        // Back tab.
        assertKeysEquals("\u001b[Z", KeyHandler.getCodeFromTermcap("kB", false, false))

        // Arrow keys (up/down/right/left):
        assertKeysEquals("\u001b[A", KeyHandler.getCodeFromTermcap("ku", false, false))
        assertKeysEquals("\u001b[B", KeyHandler.getCodeFromTermcap("kd", false, false))
        assertKeysEquals("\u001b[C", KeyHandler.getCodeFromTermcap("kr", false, false))
        assertKeysEquals("\u001b[D", KeyHandler.getCodeFromTermcap("kl", false, false))
        // .. shifted:
        assertKeysEquals("\u001b[1;2A", KeyHandler.getCodeFromTermcap("kUP", false, false))
        assertKeysEquals("\u001b[1;2B", KeyHandler.getCodeFromTermcap("kDN", false, false))
        assertKeysEquals("\u001b[1;2C", KeyHandler.getCodeFromTermcap("%i", false, false))
        assertKeysEquals("\u001b[1;2D", KeyHandler.getCodeFromTermcap("#4", false, false))

        // Home/end keys:
        assertKeysEquals("\u001b[H", KeyHandler.getCodeFromTermcap("kh", false, false))
        assertKeysEquals("\u001b[F", KeyHandler.getCodeFromTermcap("@7", false, false))
        // ... shifted:
        assertKeysEquals("\u001b[1;2H", KeyHandler.getCodeFromTermcap("#2", false, false))
        assertKeysEquals("\u001b[1;2F", KeyHandler.getCodeFromTermcap("*7", false, false))

        // The traditional keyboard keypad:
        // [Insert] [Home] [Page Up ]
        // [Delete] [End] [Page Down]
        //
        // Termcap names (with xterm response in parenthesis):
        // K1=Upper left of keypad (xterm sends same "<ESC>[H" = Home).
        // K2=Center of keypad (xterm sends invalid response).
        // K3=Upper right of keypad (xterm sends "<ESC>[5~" = Page Up).
        // K4=Lower left of keypad (xterm sends "<ESC>[F" = End key).
        // K5=Lower right of keypad (xterm sends "<ESC>[6~" = Page Down).
        //
        // vim/neovim (runtime/doc/term.txt):
        // t_K1 <kHome> keypad home key
        // t_K3 <kPageUp> keypad page-up key
        // t_K4 <kEnd> keypad end key
        // t_K5 <kPageDown> keypad page-down key
        //
        assertKeysEquals("\u001b[H", KeyHandler.getCodeFromTermcap("K1", false, false))
        assertKeysEquals("\u001bOH", KeyHandler.getCodeFromTermcap("K1", true, false))
        assertKeysEquals("\u001b[5~", KeyHandler.getCodeFromTermcap("K3", false, false))
        assertKeysEquals("\u001b[F", KeyHandler.getCodeFromTermcap("K4", false, false))
        assertKeysEquals("\u001bOF", KeyHandler.getCodeFromTermcap("K4", true, false))
        assertKeysEquals("\u001b[6~", KeyHandler.getCodeFromTermcap("K5", false, false))

        // Function keys F1-F12:
        assertKeysEquals("\u001bOP", KeyHandler.getCodeFromTermcap("k1", false, false))
        assertKeysEquals("\u001bOQ", KeyHandler.getCodeFromTermcap("k2", false, false))
        assertKeysEquals("\u001bOR", KeyHandler.getCodeFromTermcap("k3", false, false))
        assertKeysEquals("\u001bOS", KeyHandler.getCodeFromTermcap("k4", false, false))
        assertKeysEquals("\u001b[15~", KeyHandler.getCodeFromTermcap("k5", false, false))
        assertKeysEquals("\u001b[17~", KeyHandler.getCodeFromTermcap("k6", false, false))
        assertKeysEquals("\u001b[18~", KeyHandler.getCodeFromTermcap("k7", false, false))
        assertKeysEquals("\u001b[19~", KeyHandler.getCodeFromTermcap("k8", false, false))
        assertKeysEquals("\u001b[20~", KeyHandler.getCodeFromTermcap("k9", false, false))
        assertKeysEquals("\u001b[21~", KeyHandler.getCodeFromTermcap("k;", false, false))
        assertKeysEquals("\u001b[23~", KeyHandler.getCodeFromTermcap("F1", false, false))
        assertKeysEquals("\u001b[24~", KeyHandler.getCodeFromTermcap("F2", false, false))
        // Function keys F13-F24 (same as shifted F1-F12):
        assertKeysEquals("\u001b[1;2P", KeyHandler.getCodeFromTermcap("F3", false, false))
        assertKeysEquals("\u001b[1;2Q", KeyHandler.getCodeFromTermcap("F4", false, false))
        assertKeysEquals("\u001b[1;2R", KeyHandler.getCodeFromTermcap("F5", false, false))
        assertKeysEquals("\u001b[1;2S", KeyHandler.getCodeFromTermcap("F6", false, false))
        assertKeysEquals("\u001b[15;2~", KeyHandler.getCodeFromTermcap("F7", false, false))
        assertKeysEquals("\u001b[17;2~", KeyHandler.getCodeFromTermcap("F8", false, false))
        assertKeysEquals("\u001b[18;2~", KeyHandler.getCodeFromTermcap("F9", false, false))
        assertKeysEquals("\u001b[19;2~", KeyHandler.getCodeFromTermcap("FA", false, false))
        assertKeysEquals("\u001b[20;2~", KeyHandler.getCodeFromTermcap("FB", false, false))
        assertKeysEquals("\u001b[21;2~", KeyHandler.getCodeFromTermcap("FC", false, false))
        assertKeysEquals("\u001b[23;2~", KeyHandler.getCodeFromTermcap("FD", false, false))
        assertKeysEquals("\u001b[24;2~", KeyHandler.getCodeFromTermcap("FE", false, false))
    }

    @Test
    fun testKeyCodes() {
        // Return sends carriage return (\r), which normally gets translated by the device driver to newline (\n) unless the ICRNL termios
        // flag has been set.
        assertKeysEquals("\r", KeyHandler.getCode(KeyHandler.KEYCODE_ENTER, 0, false, false))

        // Backspace.
        assertKeysEquals("\u007f", KeyHandler.getCode(KeyHandler.KEYCODE_DEL, 0, false, false))

        // Space.
        assertNull(KeyHandler.getCode(KeyHandler.KEYCODE_SPACE, 0, false, false))
        assertKeysEquals("\u0000", KeyHandler.getCode(KeyHandler.KEYCODE_SPACE, KeyHandler.KEYMOD_CTRL, false, false))

        // Back tab.
        assertKeysEquals("\u001b[Z", KeyHandler.getCode(KeyHandler.KEYCODE_TAB, KeyHandler.KEYMOD_SHIFT, false, false))

        // Arrow keys (up/down/right/left):
        assertKeysEquals("\u001b[A", KeyHandler.getCode(KeyHandler.KEYCODE_DPAD_UP, 0, false, false))
        assertKeysEquals("\u001b[B", KeyHandler.getCode(KeyHandler.KEYCODE_DPAD_DOWN, 0, false, false))
        assertKeysEquals("\u001b[C", KeyHandler.getCode(KeyHandler.KEYCODE_DPAD_RIGHT, 0, false, false))
        assertKeysEquals("\u001b[D", KeyHandler.getCode(KeyHandler.KEYCODE_DPAD_LEFT, 0, false, false))
        // .. shifted:
        assertKeysEquals("\u001b[1;2A", KeyHandler.getCode(KeyHandler.KEYCODE_DPAD_UP, KeyHandler.KEYMOD_SHIFT, false, false))
        assertKeysEquals("\u001b[1;2B", KeyHandler.getCode(KeyHandler.KEYCODE_DPAD_DOWN, KeyHandler.KEYMOD_SHIFT, false, false))
        assertKeysEquals("\u001b[1;2C", KeyHandler.getCode(KeyHandler.KEYCODE_DPAD_RIGHT, KeyHandler.KEYMOD_SHIFT, false, false))
        assertKeysEquals("\u001b[1;2D", KeyHandler.getCode(KeyHandler.KEYCODE_DPAD_LEFT, KeyHandler.KEYMOD_SHIFT, false, false))
        // .. ctrl:ed:
        assertKeysEquals("\u001b[1;5A", KeyHandler.getCode(KeyHandler.KEYCODE_DPAD_UP, KeyHandler.KEYMOD_CTRL, false, false))
        assertKeysEquals("\u001b[1;5B", KeyHandler.getCode(KeyHandler.KEYCODE_DPAD_DOWN, KeyHandler.KEYMOD_CTRL, false, false))
        assertKeysEquals("\u001b[1;5C", KeyHandler.getCode(KeyHandler.KEYCODE_DPAD_RIGHT, KeyHandler.KEYMOD_CTRL, false, false))
        assertKeysEquals("\u001b[1;5D", KeyHandler.getCode(KeyHandler.KEYCODE_DPAD_LEFT, KeyHandler.KEYMOD_CTRL, false, false))
        // .. ctrl:ed and shifted:
        val mod = KeyHandler.KEYMOD_CTRL or KeyHandler.KEYMOD_SHIFT
        assertKeysEquals("\u001b[1;6A", KeyHandler.getCode(KeyHandler.KEYCODE_DPAD_UP, mod, false, false))
        assertKeysEquals("\u001b[1;6B", KeyHandler.getCode(KeyHandler.KEYCODE_DPAD_DOWN, mod, false, false))
        assertKeysEquals("\u001b[1;6C", KeyHandler.getCode(KeyHandler.KEYCODE_DPAD_RIGHT, mod, false, false))
        assertKeysEquals("\u001b[1;6D", KeyHandler.getCode(KeyHandler.KEYCODE_DPAD_LEFT, mod, false, false))

        // Home/end keys:
        assertKeysEquals("\u001b[H", KeyHandler.getCode(KeyHandler.KEYCODE_MOVE_HOME, 0, false, false))
        assertKeysEquals("\u001b[F", KeyHandler.getCode(KeyHandler.KEYCODE_MOVE_END, 0, false, false))
        // ... shifted:
        assertKeysEquals("\u001b[1;2H", KeyHandler.getCode(KeyHandler.KEYCODE_MOVE_HOME, KeyHandler.KEYMOD_SHIFT, false, false))
        assertKeysEquals("\u001b[1;2F", KeyHandler.getCode(KeyHandler.KEYCODE_MOVE_END, KeyHandler.KEYMOD_SHIFT, false, false))

        // Function keys F1-F12:
        assertKeysEquals("\u001bOP", KeyHandler.getCode(KeyHandler.KEYCODE_F1, 0, false, false))
        assertKeysEquals("\u001bOQ", KeyHandler.getCode(KeyHandler.KEYCODE_F2, 0, false, false))
        assertKeysEquals("\u001bOR", KeyHandler.getCode(KeyHandler.KEYCODE_F3, 0, false, false))
        assertKeysEquals("\u001bOS", KeyHandler.getCode(KeyHandler.KEYCODE_F4, 0, false, false))
        assertKeysEquals("\u001b[15~", KeyHandler.getCode(KeyHandler.KEYCODE_F5, 0, false, false))
        assertKeysEquals("\u001b[17~", KeyHandler.getCode(KeyHandler.KEYCODE_F6, 0, false, false))
        assertKeysEquals("\u001b[18~", KeyHandler.getCode(KeyHandler.KEYCODE_F7, 0, false, false))
        assertKeysEquals("\u001b[19~", KeyHandler.getCode(KeyHandler.KEYCODE_F8, 0, false, false))
        assertKeysEquals("\u001b[20~", KeyHandler.getCode(KeyHandler.KEYCODE_F9, 0, false, false))
        assertKeysEquals("\u001b[21~", KeyHandler.getCode(KeyHandler.KEYCODE_F10, 0, false, false))
        assertKeysEquals("\u001b[23~", KeyHandler.getCode(KeyHandler.KEYCODE_F11, 0, false, false))
        assertKeysEquals("\u001b[24~", KeyHandler.getCode(KeyHandler.KEYCODE_F12, 0, false, false))
        // Function keys F13-F24 (same as shifted F1-F12):
        assertKeysEquals("\u001b[1;2P", KeyHandler.getCode(KeyHandler.KEYCODE_F1, KeyHandler.KEYMOD_SHIFT, false, false))
        assertKeysEquals("\u001b[1;2Q", KeyHandler.getCode(KeyHandler.KEYCODE_F2, KeyHandler.KEYMOD_SHIFT, false, false))
        assertKeysEquals("\u001b[1;2R", KeyHandler.getCode(KeyHandler.KEYCODE_F3, KeyHandler.KEYMOD_SHIFT, false, false))
        assertKeysEquals("\u001b[1;2S", KeyHandler.getCode(KeyHandler.KEYCODE_F4, KeyHandler.KEYMOD_SHIFT, false, false))
        assertKeysEquals("\u001b[15;2~", KeyHandler.getCode(KeyHandler.KEYCODE_F5, KeyHandler.KEYMOD_SHIFT, false, false))
        assertKeysEquals("\u001b[17;2~", KeyHandler.getCode(KeyHandler.KEYCODE_F6, KeyHandler.KEYMOD_SHIFT, false, false))
        assertKeysEquals("\u001b[18;2~", KeyHandler.getCode(KeyHandler.KEYCODE_F7, KeyHandler.KEYMOD_SHIFT, false, false))
        assertKeysEquals("\u001b[19;2~", KeyHandler.getCode(KeyHandler.KEYCODE_F8, KeyHandler.KEYMOD_SHIFT, false, false))
        assertKeysEquals("\u001b[20;2~", KeyHandler.getCode(KeyHandler.KEYCODE_F9, KeyHandler.KEYMOD_SHIFT, false, false))
        assertKeysEquals("\u001b[21;2~", KeyHandler.getCode(KeyHandler.KEYCODE_F10, KeyHandler.KEYMOD_SHIFT, false, false))
        assertKeysEquals("\u001b[23;2~", KeyHandler.getCode(KeyHandler.KEYCODE_F11, KeyHandler.KEYMOD_SHIFT, false, false))
        assertKeysEquals("\u001b[24;2~", KeyHandler.getCode(KeyHandler.KEYCODE_F12, KeyHandler.KEYMOD_SHIFT, false, false))

        assertKeysEquals("0", KeyHandler.getCode(KeyHandler.KEYCODE_NUMPAD_0, KeyHandler.KEYMOD_NUM_LOCK, false, false))
        assertKeysEquals("1", KeyHandler.getCode(KeyHandler.KEYCODE_NUMPAD_1, KeyHandler.KEYMOD_NUM_LOCK, false, false))
        assertKeysEquals("2", KeyHandler.getCode(KeyHandler.KEYCODE_NUMPAD_2, KeyHandler.KEYMOD_NUM_LOCK, false, false))
        assertKeysEquals("3", KeyHandler.getCode(KeyHandler.KEYCODE_NUMPAD_3, KeyHandler.KEYMOD_NUM_LOCK, false, false))
        assertKeysEquals("4", KeyHandler.getCode(KeyHandler.KEYCODE_NUMPAD_4, KeyHandler.KEYMOD_NUM_LOCK, false, false))
        assertKeysEquals("5", KeyHandler.getCode(KeyHandler.KEYCODE_NUMPAD_5, KeyHandler.KEYMOD_NUM_LOCK, false, false))
        assertKeysEquals("6", KeyHandler.getCode(KeyHandler.KEYCODE_NUMPAD_6, KeyHandler.KEYMOD_NUM_LOCK, false, false))
        assertKeysEquals("7", KeyHandler.getCode(KeyHandler.KEYCODE_NUMPAD_7, KeyHandler.KEYMOD_NUM_LOCK, false, false))
        assertKeysEquals("8", KeyHandler.getCode(KeyHandler.KEYCODE_NUMPAD_8, KeyHandler.KEYMOD_NUM_LOCK, false, false))
        assertKeysEquals("9", KeyHandler.getCode(KeyHandler.KEYCODE_NUMPAD_9, KeyHandler.KEYMOD_NUM_LOCK, false, false))
        assertKeysEquals(",", KeyHandler.getCode(KeyHandler.KEYCODE_NUMPAD_COMMA, KeyHandler.KEYMOD_NUM_LOCK, false, false))
        assertKeysEquals(".", KeyHandler.getCode(KeyHandler.KEYCODE_NUMPAD_DOT, KeyHandler.KEYMOD_NUM_LOCK, false, false))

        assertKeysEquals("\u001b[2~", KeyHandler.getCode(KeyHandler.KEYCODE_NUMPAD_0, 0, false, false))
        assertKeysEquals("\u001b[F", KeyHandler.getCode(KeyHandler.KEYCODE_NUMPAD_1, 0, false, false))
        assertKeysEquals("\u001b[B", KeyHandler.getCode(KeyHandler.KEYCODE_NUMPAD_2, 0, false, false))
        assertKeysEquals("\u001b[6~", KeyHandler.getCode(KeyHandler.KEYCODE_NUMPAD_3, 0, false, false))
        assertKeysEquals("\u001b[D", KeyHandler.getCode(KeyHandler.KEYCODE_NUMPAD_4, 0, false, false))
        assertKeysEquals("5", KeyHandler.getCode(KeyHandler.KEYCODE_NUMPAD_5, 0, false, false))
        assertKeysEquals("\u001b[C", KeyHandler.getCode(KeyHandler.KEYCODE_NUMPAD_6, 0, false, false))
        assertKeysEquals("\u001b[H", KeyHandler.getCode(KeyHandler.KEYCODE_NUMPAD_7, 0, false, false))
        assertKeysEquals("\u001b[A", KeyHandler.getCode(KeyHandler.KEYCODE_NUMPAD_8, 0, false, false))
        assertKeysEquals("\u001b[5~", KeyHandler.getCode(KeyHandler.KEYCODE_NUMPAD_9, 0, false, false))
        assertKeysEquals("\u001b[3~", KeyHandler.getCode(KeyHandler.KEYCODE_NUMPAD_DOT, 0, false, false))
    }

}
