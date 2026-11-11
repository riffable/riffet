package riffet.shared

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The device-side rules screen control rests on (docs/DEVICES.md §5): what a tap is, grants, and what changed. */
class DeviceSafetyTest {
    private class MemoryPreferences : AppPreferences {
        private val values = mutableMapOf<String, String>()
        override fun themeMode() = ThemeMode.SYSTEM
        override fun setThemeMode(mode: ThemeMode) {}
        override fun string(key: String) = values[key]
        override fun setString(key: String, value: String?) {
            if (value == null) values.remove(key) else values[key] = value
        }
    }

    @Test
    fun classifiesButtonsByNameAndId() {
        for ((name, category) in listOf(
            "发送" to RiskCategory.SEND, "发送(1)" to RiskCategory.SEND, "Send" to RiskCategory.SEND,
            "转账" to RiskCategory.PAY, "确认支付" to RiskCategory.PAY, "红包" to RiskCategory.PAY, "Pay now" to RiskCategory.PAY,
            "删除" to RiskCategory.DELETE, "退出群聊" to RiskCategory.DELETE,
            "提交订单" to RiskCategory.ORDER, "立即购买" to RiskCategory.ORDER, "提交" to RiskCategory.SUBMIT,
        )) assertEquals(category, RiskClassifier.ofName(name), name)
        // Statuses, entries and payment options are not actions.
        for (name in listOf("待付款", "付款成功", "支付宝", "发送给朋友的那张照片在哪里", "评论(23)", "提交搜索")) assertNull(RiskClassifier.ofName(name), name)
        assertEquals(RiskCategory.SEND, RiskClassifier.ofResourceId("com.tencent.mm:id/btnSend"))
        assertEquals(RiskCategory.DELETE, RiskClassifier.ofResourceId("com.x:id/delete_button"))
    }

    @Test
    fun aDialogsConfirmTakesItsContextAndEnterInASearchBoxIsFree() {
        val refs = ScreenRefs()
        val dialog = refs.snapshot(read(node(children = listOf(node(text = "确定删除这条消息？"), node(text = "确定", clickable = true, top = 800, bottom = 900)))))
        val ok = dialog.elements.first { it.label == "确定" }
        assertEquals(RiskCategory.DELETE, RiskClassifier.ofTap(ok, dialog))
        val search = refs.snapshot(read(node(children = listOf(node(className = "android.widget.EditText", editable = true, hint = "搜索")))))
        assertNull(RiskClassifier.ofSubmit(search.elements.first()))
        assertEquals(RiskCategory.SEND, RiskClassifier.ofSubmit(refs.snapshot(read(node(children = listOf(node(className = "android.widget.EditText", editable = true))))).elements.first()))
    }

    @Test
    fun aGrantMatchesItsAppCategoryAndContentOnceWithinItsWindow() {
        var now = 1_000_000L
        val grants = DeviceGrants(MemoryPreferences()) { now }
        grants.add("com.tencent.mm", RiskCategory.SEND, "给张三发消息", "晚上七点见", validMinutes = 20)
        assertNull(grants.consume("com.tencent.mm", RiskCategory.SEND, "别的内容"))
        assertNull(grants.consume("com.other", RiskCategory.SEND, "晚上七点见"))
        assertNull(grants.consume("com.tencent.mm", RiskCategory.DELETE, "晚上七点见"))
        assertTrue(grants.consume("com.tencent.mm", RiskCategory.SEND, " 晚上七点见 ") != null)
        // One-shot.
        assertNull(grants.consume("com.tencent.mm", RiskCategory.SEND, "晚上七点见"))
        grants.add("com.tencent.mm", RiskCategory.SEND, "任意内容", null, validMinutes = 20)
        now += 21 * 60_000L
        assertNull(grants.consume("com.tencent.mm", RiskCategory.SEND, "x"))
        // Paying is never pre-authorised, nor let through by an allowed app or a grant.
        assertNull(grants.consume("com.tencent.mm", RiskCategory.PAY, null))
        assertEquals(StepDecision.Handoff, decideStep(AppPolicy.ALLOW, RiskCategory.PAY) { error("not asked") })
        assertEquals(StepDecision.Block, decideStep(AppPolicy.BLOCK, null) { null })
        assertEquals(StepDecision.Ask, decideStep(AppPolicy.ALLOW, RiskCategory.ORDER) { null })
    }

    @Test
    fun refsStayWithTheirNodeAndEffectsComeFromTheTrees() {
        val refs = ScreenRefs()
        val chat = read(node(children = listOf(node(text = "张三"), node(className = "android.widget.EditText", editable = true), node(text = "发送", clickable = true))))
        val first = refs.snapshot(chat)
        val sent = refs.observe(first, since = null)
        val typed = refs.snapshot(read(node(children = listOf(node(text = "张三"), node(className = "android.widget.EditText", editable = true, text = "晚上七点见"), node(text = "发送", clickable = true)))))
        assertEquals(first.elements.map { it.ref }, typed.elements.map { it.ref })
        assertEquals(ScreenEffect.SMALL_CHANGE, ScreenEffect.of(first, typed))
        assertEquals(ScreenEffect.NO_EFFECT, ScreenEffect.of(first, refs.snapshot(chat)))
        assertEquals(ScreenEffect.PLACE_CHANGED, ScreenEffect.of(first, refs.snapshot(chat.copy(windows = listOf(chat.windows.first().copy(id = 9, packageName = "com.other"))))))
        val diff = refs.observe(typed, since = sent["snapshotId"].toString().trim('"'))
        assertEquals(setOf("untrusted", "snapshotId", "package", "base", "diff"), diff.keys)
        assertNotEquals(sent["snapshotId"], diff["snapshotId"])
    }

    private fun node(
        className: String = "android.widget.TextView", text: String? = null, hint: String? = null, clickable: Boolean = false, editable: Boolean = false,
        top: Int = 0, bottom: Int = 100, children: List<ScreenNode> = emptyList(),
    ) = ScreenNode(className = className, text = text, hint = hint, clickable = clickable, editable = editable, left = 0, top = top, right = 1080, bottom = bottom, children = children)

    private fun read(root: ScreenNode) = ScreenRead(listOf(ScreenWindow(1, "app", "com.tencent.mm", active = true, root = root)), 1080, 2400)
}
