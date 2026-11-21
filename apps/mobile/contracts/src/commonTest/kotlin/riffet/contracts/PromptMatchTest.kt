package riffet.contracts

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The same cases as packages/contracts/src/prompt-match.test.ts: the phones and the server have to
 * agree on which stored prompt is the receipt of which sent one.
 */
class PromptMatchTest {
    private val gone = "�"

    /** Replace the character at each index with that many U+FFFD characters, as the terminal does. */
    private fun mangle(text: String, vararg sites: Pair<Int, Int>): String {
        val out = StringBuilder()
        var cursor = 0
        for ((index, replacement) in sites) {
            out.append(text, cursor, index).append(gone.repeat(replacement))
            cursor = index + 1
        }
        return out.append(text, cursor, text.length).toString()
    }

    @Test
    fun acceptsAnIdenticalPrompt() {
        assertTrue(samePromptText("inspect the project", "inspect the project"))
    }

    @Test
    fun recognisesALongPromptMangledAtSeveralPlaces() {
        val sent = "股票分析流程与风控规则。".repeat(300) + "请给出建议。"
        val stored = mangle(sent, 390 to 2, 809 to 2, 1630 to 2, 2030 to 3)
        assertEquals(5, stored.length - sent.length)
        assertTrue(samePromptText(sent, stored))
        assertTrue(samePromptText(stored, sent))
    }

    @Test
    fun recognisesAShortPromptThatLostOneCharacter() {
        assertTrue(samePromptText("继续", "$gone${gone}续"))
        assertTrue(samePromptText("好的，继续吧", "好的${gone}继续吧"))
        assertTrue(samePromptText("提交代码", "提交代$gone$gone$gone"))
        assertTrue(samePromptText("提交代码吧", "提$gone$gone${gone}码吧"))
        assertTrue(samePromptText("查看😀日志", "查看${gone}日志"))
        assertFalse(samePromptText("提交代码", "提${gone}码"))
    }

    @Test
    fun recognisesTwoCopiesMangledAtDifferentPlaces() {
        assertTrue(samePromptText("先看日志${gone}再重启服务", "先$gone${gone}日志，再重启服务"))
    }

    @Test
    fun refusesADifferentShortPrompt() {
        assertFalse(samePromptText("继续", "好的"))
        assertFalse(samePromptText("hi", "你好"))
        assertFalse(samePromptText("好", "清理吧"))
        assertFalse(samePromptText("message 1", "message 2"))
    }

    @Test
    fun refusesAPromptThatDiffersInAWordASuffixOrAPrefix() {
        assertFalse(samePromptText("inspect the project", "delete the project"))
        assertFalse(samePromptText("stock analysis plan", "stock analysis report"))
        val long = "请检查部署脚本在预发环境的执行结果，并把失败的步骤列出来。".repeat(8)
        assertFalse(samePromptText("${long}方案一", "${long}方案二"))
        assertFalse(samePromptText(long, "$long。"))
        assertFalse(samePromptText(long, "继续，$long"))
    }

    @Test
    fun refusesACopyWithNoCharacterLeftToAgreeOn() {
        assertFalse(samePromptText("继续", "$gone$gone"))
        assertFalse(samePromptText("好的", "$gone$gone$gone$gone"))
        assertFalse(samePromptText("查看 日志", "$gone$gone $gone$gone"))
    }

    @Test
    fun comparesWhitespaceByPosition() {
        assertTrue(samePromptText("a\tb\n\nc", "a        b c"))
        assertTrue(samePromptText("  inspect the project \n", "inspect the project"))
        assertFalse(samePromptText("ab c", "a bc"))
    }

    @Test
    fun refusesAPromptWhoseLengthDriftedPastTheBudget() {
        val sent = "a".repeat(200)
        assertFalse(samePromptText(sent, sent + "b".repeat(40)))
    }

    @Test
    fun refusesMoreMangledPlacesThanTheRateObserved() {
        val sent = "股票分析流程与风控规则。".repeat(20)
        assertTrue(samePromptText(sent, mangle(sent, 10 to 1, 50 to 1, 90 to 1)))
        assertFalse(samePromptText(sent, mangle(sent, 10 to 1, 50 to 1, 90 to 1, 130 to 1)))
        assertTrue(samePromptText("查�看�日�志", "查��看��日��志"))
        assertFalse(samePromptText("查�看�日�志�", "查��看��日��志��"))
    }

    @Test
    fun comparesEmptySidesOnlyWithEachOther() {
        assertTrue(samePromptText("", ""))
        assertFalse(samePromptText("", "inspect the project"))
        assertFalse(samePromptText("inspect the project", ""))
    }
}
