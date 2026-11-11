package riffet.terminal

import kotlin.test.Test

class ApcTest : TerminalTestCase() {

    @Test
    fun testApcConsumed() {
        // At time of writing this is part of what yazi sends for probing for kitty graphics protocol support:
        // https://github.com/sxyazi/yazi/blob/0cdaff98d0b3723caff63eebf1974e7907a43a2c/yazi-adapter/src/emulator.rs#L129
        // This should not result in anything being written to the screen: If kitty graphics protocol support
        // is implemented it should instead result in an error code on stdin, and if not it should be consumed
        // silently just as xterm does. See https://sw.kovidgoyal.net/kitty/graphics-protocol/.
        withTerminalSized(2, 2)
            .enterString("\u001b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\u001b\\")
            .assertLinesAre("  ", "  ")

        // It is ok for the APC content to be non printable characters:
        withTerminalSized(12, 2)
            .enterString("hello \u001b_some\u0013\u001b_\\apc#end\u001b\\ world")
            .assertLinesAre("hello  world", "            ")
    }

}
