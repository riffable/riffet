package riffet.shared

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import riffet.contracts.RiffetJson
import kotlin.random.Random
import kotlin.time.Clock

/*
 * The device's own safety rules for screen control (docs/DEVICES.md §5). Nothing here trusts the
 * agent: the category of a tap is read off the screen, grants and per-app policies live on this
 * device, and the stop switch is the owner's.
 */

/** Irreversible actions, after Mika's `IrrevAction`. [PAY] is always left to the owner. */
enum class RiskCategory(val wire: String) {
    SEND("send"), PAY("pay"), DELETE("delete"), ORDER("order"), SUBMIT("submit");

    /** Categories a pre-authorisation may cover; paying and ordering never are. */
    val grantable: Boolean get() = this == SEND || this == DELETE || this == SUBMIT

    companion object {
        fun of(wire: String?): RiskCategory? = entries.firstOrNull { it.wire == wire }
    }
}

/**
 * Word lists for what a button does, after Mika's `IrreversibleDetector` (Apache-2.0, see NOTICE):
 * button names and resource ids only, no understanding of the page. When unsure it errs towards
 * asking; only `submit` must match exactly.
 */
object RiskClassifier {
    /** Anywhere in a short name, unless it reads as a status (待付款, 付款成功, 购买记录). */
    private val STRONG: List<Pair<String, RiskCategory>> = listOf(
        "支付" to RiskCategory.PAY, "付款" to RiskCategory.PAY, "转账" to RiskCategory.PAY,
        "删除" to RiskCategory.DELETE, "撤回" to RiskCategory.DELETE,
        "下单" to RiskCategory.ORDER, "购买" to RiskCategory.ORDER, "结算" to RiskCategory.ORDER, "结账" to RiskCategory.ORDER,
        "取消订单" to RiskCategory.ORDER, "确认收货" to RiskCategory.ORDER, "退款" to RiskCategory.ORDER,
        "转发" to RiskCategory.SEND,
    )
    private const val STRONG_MAX_LEN = 12
    private val STATUS_PREFIXES = setOf('待', '已')
    private val STATUS_SUFFIXES = listOf("成功", "记录", "售后", "明细", "方式", "列表", "中心", "入口", "码")

    /** Payment words that count only as the whole name, or after 立即 / 确认 / 去. */
    private val EXACT_PAY = listOf("收银台", "买单", "充值", "储值", "提现", "转出", "打赏", "缴费", "捐赠", "捐款")
    private val EXACT_PAY_PREFIXES = listOf("", "立即", "确认", "去")
    private val RED_PACKET = setOf("红包", "发红包", "塞钱进红包")

    /** The word, or the word plus a few characters (发送(1)). */
    private val PREFIX_WORDS: List<Pair<String, RiskCategory>> = listOf(
        "发送" to RiskCategory.SEND, "传送" to RiskCategory.SEND, "发布" to RiskCategory.SEND, "发表" to RiskCategory.SEND,
        "清空" to RiskCategory.DELETE, "移除" to RiskCategory.DELETE, "注销" to RiskCategory.DELETE, "退出群聊" to RiskCategory.DELETE,
        "提交订单" to RiskCategory.ORDER,
    )
    private const val PREFIX_SLACK = 4

    /** The word, or the word followed by punctuation only (评论(23) is a counter, not a button). */
    private val PUNCT_WORDS = listOf("评论", "回复")
    private val BOOKING_WORDS = listOf("预约", "报名")
    private val BOOKING_PREFIXES = listOf("", "立即", "确认")
    private val SUBMIT_WORDS = setOf("提交", "确认提交", "送出", "submit")

    /** English: the name starts with the phrase, on a word boundary. */
    private val ENGLISH: List<Pair<String, RiskCategory>> = listOf(
        "send" to RiskCategory.SEND, "post" to RiskCategory.SEND, "reply" to RiskCategory.SEND,
        "pay" to RiskCategory.PAY, "donate" to RiskCategory.PAY, "transfer" to RiskCategory.PAY,
        "delete" to RiskCategory.DELETE, "remove" to RiskCategory.DELETE, "clear all" to RiskCategory.DELETE,
        "place order" to RiskCategory.ORDER, "buy now" to RiskCategory.ORDER, "checkout" to RiskCategory.ORDER,
    )
    private val RESOURCE_WORDS = mapOf(
        "send" to RiskCategory.SEND, "reply" to RiskCategory.SEND,
        "pay" to RiskCategory.PAY,
        "delete" to RiskCategory.DELETE, "remove" to RiskCategory.DELETE,
        "checkout" to RiskCategory.ORDER,
    )

    /** A dialog's generic confirm counts as what the rest of the dialog says. */
    private val GENERIC = setOf("确认", "确定", "ok", "完成", "confirm", "好")
    private val AMOUNT = Regex("[¥￥$＄]\\s*\\d|\\d+(\\.\\d+)?\\s*元")
    private val PAY_SHEET_WORDS = listOf("支付方式", "付款方式", "收银台", "免密", "银行卡")

    /** Options naming a way to pay are not a payment. */
    private val EXCLUDED = listOf("支付宝", "支付方式", "支付设置", "付款方式")
    private val SEARCH = listOf("search", "搜索", "搜寻")

    /** The category of a name, or null. */
    fun ofName(name: String): RiskCategory? {
        val raw = name.trim()
        if (raw.isEmpty()) return null
        val n = raw.filterNot(Char::isWhitespace).lowercase()
        if (n in SUBMIT_WORDS) return RiskCategory.SUBMIT
        if (n in RED_PACKET) return RiskCategory.PAY
        if (EXACT_PAY.any { w -> EXACT_PAY_PREFIXES.any { n == it + w } }) return RiskCategory.PAY
        strong(raw)?.let { return it }
        for ((w, category) in PREFIX_WORDS) if (n.startsWith(w) && n.length <= w.length + PREFIX_SLACK) return category
        for (w in PUNCT_WORDS) if (n.startsWith(w) && n.drop(w.length).none { it.isLetterOrDigit() }) return RiskCategory.SEND
        if (BOOKING_WORDS.any { w -> BOOKING_PREFIXES.any { n == it + w } }) return RiskCategory.ORDER
        val lower = raw.lowercase().replace(Regex("\\s+"), " ")
        for ((w, category) in ENGLISH) if (lower.startsWith(w) && lower.getOrNull(w.length)?.isLetter() != true) return category
        return null
    }

    /** A resource id split on `_ - .` and camel case, e.g. `btn_send`, `sendButton`. */
    fun ofResourceId(id: String?): RiskCategory? {
        val words = id?.substringAfter(":id/")?.replace(Regex("([a-z])([A-Z])"), "$1 $2")?.lowercase()?.split(Regex("[^a-z0-9]+")).orEmpty()
        return words.firstNotNullOfOrNull { RESOURCE_WORDS[it] }
    }

    /** What tapping [element] would do on [screen]: its own name, the text inside it, its id, a dialog's context. */
    fun ofTap(element: ScreenElement, screen: ScreenSnapshot): RiskCategory? {
        val names = listOf(element.label, screen.innerText(element)).filter(String::isNotBlank)
        names.firstNotNullOfOrNull(::ofName)?.let { return it }
        ofResourceId(element.node.resourceId)?.let { return it }
        val generic = names.any { it.filterNot(Char::isWhitespace).lowercase().trimEnd { c -> !c.isLetterOrDigit() } in GENERIC }
        return if (generic) context(screen, element) else null
    }

    /** Pressing enter in [field]: a send, unless the field is a search box. */
    fun ofSubmit(field: ScreenElement?): RiskCategory? {
        val hay = listOfNotNull(field?.hint, field?.resourceId, field?.node?.className, field?.desc).joinToString(" ").lowercase()
        return if (SEARCH.any { it in hay }) null else RiskCategory.SEND
    }

    /** Everything else on the same window: a payment word or an amount on a payment sheet makes it a payment. */
    private fun context(screen: ScreenSnapshot, hit: ScreenElement): RiskCategory? {
        val others = screen.elements.filter { it.windowId == hit.windowId && it.ref != hit.ref }.map { it.label }.filter(String::isNotBlank)
        val found = others.mapNotNull(::strong)
        if (RiskCategory.PAY in found) return RiskCategory.PAY
        if (others.any { AMOUNT.containsMatchIn(it) } && others.any { o -> PAY_SHEET_WORDS.any { it in o } }) return RiskCategory.PAY
        return found.firstOrNull { it != RiskCategory.ORDER } ?: found.firstOrNull()
    }

    private fun strong(label: String): RiskCategory? {
        for (part in listOf(label) + label.split(Regex("\\s+"))) {
            var t = part.filterNot(Char::isWhitespace)
            EXCLUDED.forEach { t = t.replace(it, "") }
            if (t.isEmpty() || t.length > STRONG_MAX_LEN) continue
            STRONG.firstOrNull { (w, _) -> occurrences(t, w).any { actionAt(t, w, it) } }?.let { return it.second }
        }
        return null
    }

    private fun occurrences(t: String, w: String) = generateSequence(t.indexOf(w).takeIf { it >= 0 }) { i -> t.indexOf(w, i + 1).takeIf { it >= 0 } }

    private fun actionAt(t: String, w: String, i: Int): Boolean {
        if (i > 0 && t[i - 1] in STATUS_PREFIXES) return false
        val rest = t.substring(i + w.length).dropWhile { !it.isLetterOrDigit() }
        return STATUS_SUFFIXES.none { rest.startsWith(it) }
    }
}

/** Per-app control: [ALLOW] lets irreversible steps (except paying) go unasked, [BLOCK] hides the app from the agent. */
enum class AppPolicy(val wire: String) {
    ALLOW("allow"), ASK("ask"), BLOCK("block");

    companion object {
        fun of(wire: String?): AppPolicy? = entries.firstOrNull { it.wire == wire }
    }
}

@Serializable
data class TouchedApp(val packageName: String, val label: String, val at: Long)

/**
 * The owner's per-app policies and the apps the agent has touched, on this device only. Banks and
 * payment apps start blocked; WeChat Pay lives inside WeChat, so it is left to the `pay` category.
 */
class DeviceAppPolicies(private val preferences: AppPreferences, private val now: () -> Long = { Clock.System.now().toEpochMilliseconds() }) {
    private val policySerializer = MapSerializer(String.serializer(), String.serializer())
    private val touchedSerializer = ListSerializer(TouchedApp.serializer())
    private val policies = MutableStateFlow(read(POLICIES, policySerializer).orEmpty())
    private val _touched = MutableStateFlow(read(TOUCHED, touchedSerializer).orEmpty())

    /** Most recent first. */
    val touched: StateFlow<List<TouchedApp>> = _touched.asStateFlow()
    val changes: StateFlow<Map<String, String>> = policies.asStateFlow()

    fun policy(packageName: String?): AppPolicy {
        if (packageName == null) return AppPolicy.ASK
        return AppPolicy.of(policies.value[packageName]) ?: if (packageName in DEFAULT_BLOCKED) AppPolicy.BLOCK else AppPolicy.ASK
    }

    fun set(packageName: String, policy: AppPolicy) {
        val next = policies.value + (packageName to policy.wire)
        policies.value = next
        preferences.setString(POLICIES, RiffetJson.instance.encodeToString(policySerializer, next))
    }

    fun touch(packageName: String, label: String) {
        val current = _touched.value
        if (current.firstOrNull()?.packageName == packageName && current.first().label == label) return
        val next = (listOf(TouchedApp(packageName, label, now())) + current.filter { it.packageName != packageName }).take(MAX_TOUCHED)
        _touched.value = next
        preferences.setString(TOUCHED, RiffetJson.instance.encodeToString(touchedSerializer, next))
    }

    private fun <T> read(key: String, serializer: kotlinx.serialization.KSerializer<T>): T? =
        runCatching { preferences.string(key)?.let { RiffetJson.instance.decodeFromString(serializer, it) } }.getOrNull()

    companion object {
        private const val POLICIES = "device.app-policies"
        private const val TOUCHED = "device.touched-apps"
        private const val MAX_TOUCHED = 40

        val DEFAULT_BLOCKED = setOf(
            "com.eg.android.AlipayGphone", // 支付宝
            "com.unionpay", // 云闪付
            "com.icbc", // 工商银行
            "com.chinamworld.main", // 建设银行
            "com.android.bankabc", // 农业银行
            "com.chinamworld.bocmbci", // 中国银行
            "cmb.pb", // 招商银行
            "com.bankcomm.Bankcomm", // 交通银行
            "com.yitong.mbank.psbc", // 邮储银行
            "com.jd.jrapp", // 京东金融
            "com.paypal.android.p2pmobile",
        )
    }
}

/** A pre-authorisation the owner confirmed on this device (`device_authorize`). */
@Serializable
data class DeviceGrant(
    val id: String,
    val packageName: String,
    val category: String,
    val summary: String,
    val contentHash: String? = null,
    val createdAt: Long,
    val expiresAt: Long,
)

/** Grants in [AppPreferences]; each matches one step and is then gone. */
class DeviceGrants(private val preferences: AppPreferences, private val now: () -> Long = { Clock.System.now().toEpochMilliseconds() }) {
    private val serializer = ListSerializer(DeviceGrant.serializer())
    private var grants: List<DeviceGrant> = runCatching { preferences.string(KEY)?.let { RiffetJson.instance.decodeFromString(serializer, it) } }.getOrNull().orEmpty()

    fun add(packageName: String, category: RiskCategory, summary: String, content: String?, validMinutes: Int): DeviceGrant {
        require(category.grantable) { "${category.wire} cannot be pre-authorised" }
        val at = now()
        val grant = DeviceGrant(
            id = "g" + Random.nextLong().toULong().toString(36),
            packageName = packageName, category = category.wire, summary = summary,
            contentHash = content?.takeIf { it.isNotBlank() }?.let(::contentHash),
            createdAt = at, expiresAt = at + validMinutes.coerceIn(1, MAX_MINUTES) * 60_000L,
        )
        save(live() + grant)
        return grant
    }

    /**
     * The first live grant for this package and category whose content (when it named one) is
     * [content], used up; null when none matches.
     */
    fun consume(packageName: String, category: RiskCategory, content: String?): DeviceGrant? {
        if (!category.grantable) return null
        val hash = content?.takeIf { it.isNotBlank() }?.let(::contentHash)
        val live = live()
        val match = live.firstOrNull { it.packageName == packageName && it.category == category.wire && (it.contentHash == null || it.contentHash == hash) }
        save(if (match == null) live else live - match)
        return match
    }

    fun live(): List<DeviceGrant> = grants.filter { it.expiresAt > now() }

    private fun save(next: List<DeviceGrant>) {
        grants = next
        preferences.setString(KEY, if (next.isEmpty()) null else RiffetJson.instance.encodeToString(serializer, next))
    }

    private companion object {
        const val KEY = "device.grants"
        const val MAX_MINUTES = 1440
    }
}

/** What the gate does with one step. */
sealed interface StepDecision {
    /** Go ahead; [authorizedBy] is `policy`, `grant:<id>` or null for a step that needs none. */
    data class Allow(val authorizedBy: String?) : StepDecision
    data object Block : StepDecision
    data object Handoff : StepDecision
    data object Ask : StepDecision
}

/**
 * The rule, in order: a blocked app is never touched; a step with no category needs nothing;
 * paying is the owner's; an allowed app goes ahead, except placing an order; a matching grant is
 * used up; otherwise ask.
 */
fun decideStep(policy: AppPolicy, category: RiskCategory?, grant: () -> DeviceGrant?): StepDecision = when {
    policy == AppPolicy.BLOCK -> StepDecision.Block
    category == null -> StepDecision.Allow(null)
    category == RiskCategory.PAY -> StepDecision.Handoff
    policy == AppPolicy.ALLOW && category != RiskCategory.ORDER -> StepDecision.Allow("policy")
    else -> grant()?.let { StepDecision.Allow("grant:${it.id}") } ?: StepDecision.Ask
}

/** 停止: the owner's emergency stop. Control calls are refused until [until]. */
object DeviceStop {
    const val HOLD_MILLIS = 60_000L
    private val _until = MutableStateFlow(0L)
    val until: StateFlow<Long> = _until.asStateFlow()

    fun stop(now: Long = Clock.System.now().toEpochMilliseconds()) {
        _until.value = now + HOLD_MILLIS
    }

    fun active(now: Long = Clock.System.now().toEpochMilliseconds()): Boolean = now < _until.value
}
