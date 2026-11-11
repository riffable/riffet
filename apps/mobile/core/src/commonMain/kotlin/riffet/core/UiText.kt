package riffet.core

/**
 * The display text the `core` model produces for the timeline (tool titles, diff gap rows and speed
 * descriptions). `core` cannot depend on the client's `L10n`, so it carries its own catalog and
 * reads the platform language through [platformUiLocale] on every lookup; a client test that pins
 * `L10n.locale` also pins this catalog.
 *
 * `{0}`, `{1}`, … in a pattern are replaced by the arguments of [text]. The Chinese column is the
 * source copy, unchanged.
 */
object UiText {
    /** A test's fixed language; null follows the platform on every read. */
    private var pinnedLocale: String? = null

    /**
     * `zh-Hans` or `en`; the client writes it when a test pins the interface language, and the
     * getter otherwise follows the platform, so a system language change needs no restart.
     */
    var locale: String
        get() = pinnedLocale ?: platformUiLocale()
        set(value) {
            // Only the override is written: the client's `L10n.locale` setter is the one that
            // propagates here, and writing back would recurse.
            pinnedLocale = value
        }

    fun text(key: String, vararg args: Any?): String {
        val pattern = (if (locale == "en") en else zhHans)[key] ?: return key
        if (args.isEmpty()) return pattern
        // Replacing through the pattern only keeps an argument that itself contains `{1}` intact.
        return UI_PLACEHOLDER.replace(pattern) { match ->
            args.getOrNull(match.groupValues[1].toInt())?.toString().orEmpty()
        }
    }

    private val zhHans: Map<String, String> = mapOf(
        "core.tool.call" to "工具调用",
        "core.diff.unchangedLines" to "{0} 行未改动",
        "core.speed.tokens.provider" to "精确 token 数",
        "core.speed.tokens.estimated" to "估算 token 数",
        "core.speed.tokens.mixed" to "部分估算的 token 数",
        "core.speed.tokens.output" to "输出 token 数",
        "core.speed.window.stream" to "首字到末字的生成时间",
        "core.speed.window.transcript" to "从发起请求到回答结束（含首字延迟）",
        "core.speed.window.observed" to "按记录时间估算（含首字延迟，Cursor 只计不调用工具的回答）",
        "core.speed.generation.stream" to "实际生成时间，不含工具执行和等待",
        "core.speed.generation.transcript" to "模型响应时间（含首字延迟）",
        "core.speed.generation.observed" to "观测到的模型响应时间（含首字延迟）",
        "core.speed.steps.one" to "1 次模型响应",
        "core.speed.steps.other" to "{0} 次模型响应",
        "core.speed.description" to "输出速度 · {0} · {1} · 合计 {2}",
        "core.speed.modelDescription" to "模型输出速度 · 最近 {0} 秒内{1} ÷ {2}",
        "core.speed.recentDescription" to "近期输出速度 · 最近 {0} 秒{1} ÷ {0} 秒 · 包含工具执行和等待时间",
    )

    private val en: Map<String, String> = mapOf(
        "core.tool.call" to "Tool call",
        "core.diff.unchangedLines" to "{0} unchanged lines",
        "core.speed.tokens.provider" to "Exact token count",
        "core.speed.tokens.estimated" to "Estimated token count",
        "core.speed.tokens.mixed" to "Partly estimated token count",
        "core.speed.tokens.output" to "Output token count",
        "core.speed.window.stream" to "Generation time from first to last token",
        "core.speed.window.transcript" to "From request start to answer end (including time to first token)",
        "core.speed.window.observed" to "Estimated from observed write time (including time to first token; Cursor counts only answers without tool calls)",
        "core.speed.generation.stream" to "Actual generation time, excluding tool execution and waits",
        "core.speed.generation.transcript" to "Model response time (including time to first token)",
        "core.speed.generation.observed" to "Observed model response time (including time to first token)",
        "core.speed.steps.one" to "1 model response",
        "core.speed.steps.other" to "{0} model responses",
        "core.speed.description" to "Output speed · {0} · {1} · {2} total",
        "core.speed.modelDescription" to "Model output speed · {1} in the last {0}s ÷ {2}",
        "core.speed.recentDescription" to "Recent output speed · {1} in the last {0}s ÷ {0}s · includes tool execution and waiting",
    )
}

/** The system language (`zh-Hans` or `en`) for [UiText], read on every access. */
internal expect fun platformUiLocale(): String

/** `{0}`, `{1}`, … in a UI text pattern. */
private val UI_PLACEHOLDER = Regex("""\{(\d+)\}""")
