package riffet.ui.pickers

import kotlin.math.abs
import riffet.contracts.ModelConfigOption
import riffet.contracts.ModelInfo

/*
 * ============================================================================================
 * The model picker's option derivation - a port of `apps/web/src/lib/models.ts`
 * ============================================================================================
 *
 * The model picker never guesses a model list and never guesses a parameter list. Both come from
 * the CLI's own catalog (`ModelInfo.configOptions`, whose `currentValue` is what the CLI currently
 * has selected), exactly as `ModelPicker.tsx` reads them on the web. What this file adds is the
 * *derivation* the web keeps in `lib/models.ts`:
 *
 *  - which config options are user-visible parameters at all ([paramsFromOptions]);
 *  - what kind of control each one is ([paramKind]) and the copy each kind uses
 *    ([paramTitle], [paramHint], [optionLabel]);
 *  - how a (model, parameter-value) pair becomes the single string `nativeSetModel` takes
 *    ([catalogSelection]), including Cursor's native variants, whose exact CLI ids are listed in
 *    `ModelInfo.nativeVariants` rather than in `value`.
 *
 * This is deliberately pure Kotlin: no Compose, no clock, no network. It is the one piece of this
 * change worth a test (`PickerOptionsTest`), because a wrong answer here is a `nativeSetModel`
 * call the CLI rejects, not a cosmetic difference.
 *
 * Deliberately not ported, with reasons:
 *  - `nativeCatalogSelection` / `matchFamily` / `nativeFamilies` (`lib/native-models.ts`): they map
 *    a *footer string* the CLI printed back onto a catalog entry. The mobile session frame carries
 *    `Session.model`, which is the id we last set, so this repair path has no input here.
 *  - `normalizeNativeFastSelection`: it forces `fast=false` before reopening a Cursor session. It
 *    belongs to the reopen flow (`NativeSession.tsx:reopen`); the mobile resume buttons start the
 *    session as it stands and do not repair its selection first.
 */

/** One user-settable model parameter, derived from a [ModelConfigOption]. */
data class ModelParam(
    val id: String,
    val name: String,
    val description: String?,
    val category: String?,
    val value: String,
    val options: List<ModelParamOption>,
)

data class ModelParamOption(val value: String, val label: String)

/** The control a parameter is drawn as. `paramKind` in `lib/models.ts`. */
enum class ParamKind { EFFORT, TOGGLE, FAST, MAX, SELECT }

/** A model selection split into its id and the parameter overrides spelled out in `[...]`. */
data class ParsedSelection(val model: String, val params: Map<String, String>)

/** `cleanLabel`: strip zero-width characters and collapse whitespace. */
fun cleanLabel(value: String): String =
    value.replace(INVISIBLE, "").replace(WHITESPACE_RUN, " ").trim()

// Compiled once: the Mac re-renders a model chip on every layout pass, and Kotlin/Native compiles
// a pattern far slower than the JVM.
private val INVISIBLE = Regex("[\u200B-\u200D\uFEFF]")
private val WHITESPACE_RUN = Regex("\\s+")

/** Only the two catalog categories the CLI exposes as controls are parameters. */
private val PARAM_CATEGORIES = setOf("thought_level", "model_config")

/**
 * `paramsFromOptions`: the visible parameters a model's config options describe.
 *
 * A `select` with fewer than two usable choices is not a choice, so it is left out rather than
 * rendered as a control with one value.
 */
fun paramsFromOptions(options: List<ModelConfigOption>): List<ModelParam> = options.mapNotNull { option ->
    val category = option.category
    if (option.id.isEmpty() || category == null || category !in PARAM_CATEGORIES || option.type != "select") {
        return@mapNotNull null
    }
    val choices = option.options.mapNotNull { item ->
        item.value.takeIf { it.isNotEmpty() }?.let { ModelParamOption(it, cleanLabel(item.name.ifEmpty { it })) }
    }
    if (choices.size < 2) return@mapNotNull null
    ModelParam(
        id = option.id,
        name = cleanLabel(option.name.ifEmpty { option.id }),
        description = option.description?.takeIf { it.isNotEmpty() },
        category = category,
        value = option.currentValue.ifEmpty { choices.first().value },
        options = choices,
    )
}

/** `catalogParams`: the parameters of [model], with valid [overrides] applied on top. */
fun catalogParams(catalog: List<ModelInfo>, model: String, overrides: Map<String, String>): List<ModelParam> {
    val info = catalog.firstOrNull { it.value == model } ?: return emptyList()
    val normalized = normalizeEffortAlias(info, overrides)
    return paramsFromOptions(info.configOptions).map { param ->
        val override = normalized[param.id]
        if (override != null && param.options.any { it.value == override }) param.copy(value = override) else param
    }
}

/**
 * Translates CLI-specific effort aliases (`reasoning_effort` on Gemini, `reasoning` on GPT) to the
 * catalog's shared `effort` control, mirroring `packages/contracts/src/model-selection.ts`'s
 * `resolveCatalogSelection`. Without this, a normalized Cursor selector such as
 * `gemini-4-neon[context=1m,reasoning_effort=high]` fails to match the `effort` option and falls
 * back to `currentValue` (e.g. `low`).
 */
private fun normalizeEffortAlias(info: ModelInfo, params: Map<String, String>): Map<String, String> {
    if ("reasoning_effort" !in params && "reasoning" !in params) return params
    val hasEffortOption = info.nativeVariants?.isNotEmpty() == true ||
        info.configOptions.any { it.id == "effort" }
    if (!hasEffortOption) return params
    if (info.configOptions.any { it.id == "reasoning_effort" || it.id == "reasoning" }) return params
    val effort = params["effort"] ?: params["reasoning_effort"] ?: params["reasoning"]
    val out = LinkedHashMap<String, String>(params.size)
    for ((key, value) in params) {
        if (key != "reasoning_effort" && key != "reasoning") out[key] = value
    }
    if (effort != null) out["effort"] = effort
    return out
}

private fun isBoolean(param: ModelParam): Boolean =
    param.options.size == 2 && param.options.all { it.value == "true" || it.value == "false" }

/** Cursor's own token for the context window its Max mode selects. */
const val MAX_VALUE = "max"

fun paramKind(param: ModelParam): ParamKind = when {
    param.id == "fast" && listOf("true", "false").all { value -> param.options.any { it.value == value } } &&
        param.options.all { it.value in listOf("true", "false", "default") } -> ParamKind.FAST
    // Max is the `max` context window, not "a context select with two entries": the catalog
    // publishes three windows (300K / 1M / MAX) and Max is the one Cursor's UI shows as a mode.
    param.id == "context" && param.options.any { it.value == MAX_VALUE } -> ParamKind.MAX
    isBoolean(param) -> ParamKind.TOGGLE
    param.category == "thought_level" -> ParamKind.EFFORT
    else -> ParamKind.SELECT
}

/** The option that turns Max mode on, when this parameter has one. */
fun maxOption(param: ModelParam): ModelParamOption? =
    if (paramKind(param) == ParamKind.MAX) param.options.firstOrNull { it.value == MAX_VALUE } else null

/**
 * `contextChoices`: the context windows the Max switch does not own (300K / 1M).
 *
 * Max is one switch and the remaining windows stay pickable, so nothing the CLI documents becomes
 * unreachable - the alternative (a three-segment 300K/1M/MAX strip) is what the phone could not
 * render legibly next to the other parameters.
 */
fun contextChoices(param: ModelParam): List<ModelParamOption> =
    if (paramKind(param) != ParamKind.MAX) emptyList() else param.options.filter { it.value != MAX_VALUE }

/**
 * `listValues`: the options of a parameter, in the order its control should list them.
 *
 * Only effort has an order the CLI does not guarantee: a family's variants may list `max` before
 * `low`, and a ladder read bottom-to-top ("Off, Minimal, Low, Medium, High, xhigh, Max") is the
 * whole point of choosing a thinking level.
 */
fun listValues(param: ModelParam): List<ModelParamOption> {
    if (paramKind(param) != ParamKind.EFFORT) return param.options
    return param.options.sortedBy { option ->
        EFFORT_ORDER.indexOf(option.value).let { if (it < 0) EFFORT_ORDER.size else it }
    }
}

/**
 * `paramNeedsList`: whether this parameter is a row that opens a list instead of a strip of
 * segments.
 *
 * A phone strip divides the sheet's width by the option count, so eight effort levels become eight
 * 40dp cells whose labels are all ellipsised - the reader cannot see which level is selected, which
 * is the only thing the control exists to say. This is the same call the web makes on its phone
 * layout, where an effort control is a dropdown rather than sliding segments.
 */
fun paramNeedsList(param: ModelParam): Boolean = when (paramKind(param)) {
    ParamKind.EFFORT, ParamKind.SELECT -> param.options.size > 3
    else -> false
}

/**
 * `xhigh` keeps Cursor's own token as its label; the CLI reports a friendlier "very high" for it,
 * but the token is what users compare against in the CLI/TUI.
 */
private val EFFORT_LABELS = mapOf(
    "none" to "Off",
    "minimal" to "Minimal",
    "low" to "Low",
    "medium" to "Medium",
    "high" to "High",
    "xhigh" to "xhigh",
    "extra-high" to "xhigh",
    "max" to "Max",
)

fun optionLabel(param: ModelParam, value: String): String {
    if (paramKind(param) == ParamKind.EFFORT) {
        EFFORT_LABELS[value]?.let { return it }
    }
    return param.options.firstOrNull { it.value == value }?.label ?: value
}

fun paramTitle(param: ModelParam): String = when (paramKind(param)) {
    ParamKind.EFFORT -> "Effort"
    ParamKind.FAST -> "Fast"
    ParamKind.MAX -> "Max"
    ParamKind.TOGGLE -> if (param.id == "thinking") "Thinking" else param.name
    ParamKind.SELECT -> if (param.id == "optimize_for") "Routing" else param.name
}

fun paramHint(param: ModelParam): String = when (paramKind(param)) {
    ParamKind.FAST -> "Faster responses, higher usage"
    // Max has no hint: the switch and the window row are two controls over one parameter, and a hint
    // here only said again what that row shows. The row is hidden while Max is on, so exactly one
    // place names the window at any moment.
    ParamKind.MAX -> ""
    ParamKind.TOGGLE -> if (param.id == "thinking") "Reason before responding" else param.description.orEmpty()
    else -> ""
}

fun isOn(param: ModelParam): Boolean = when (paramKind(param)) {
    ParamKind.MAX -> param.value == MAX_VALUE
    else -> param.value == "true"
}

/**
 * The value a toggle writes.
 *
 * Max turns on the `max` context window and off to [fallback] - the window the caller was showing
 * before Max was switched on - so a round trip through Max never silently drops a context choice.
 * With no fallback the widest non-Max window is the honest default: that is the one Cursor's own
 * model names advertise (`Claude Opus 5.5 1M`).
 */
fun toggledValue(param: ModelParam, on: Boolean, fallback: String? = null): String = when (paramKind(param)) {
    ParamKind.MAX -> if (on) {
        MAX_VALUE
    } else {
        fallback ?: contextChoices(param).lastOrNull()?.value ?: param.options.first().value
    }
    else -> if (on) "true" else "false"
}

/**
 * `selectionTags`: the short facts the picker's trigger repeats next to the model name.
 *
 * An empty effort means "the family's own default", which the model's name already says; only a
 * named effort is worth repeating. `No thinking` is the one exception, because it is a fact the
 * name cannot carry.
 */
data class SelectionTags(val effort: String?, val fast: Boolean, val max: Boolean, val context: String? = null)

fun selectionTags(params: List<ModelParam>): SelectionTags {
    val effort = params.firstOrNull { paramKind(it) == ParamKind.EFFORT }
    val thinking = params.firstOrNull { paramKind(it) == ParamKind.TOGGLE && it.id == "thinking" }
    val fast = params.firstOrNull { paramKind(it) == ParamKind.FAST }
    val max = params.firstOrNull { paramKind(it) == ParamKind.MAX }
    val context = params.firstOrNull { it.id == "context" && paramKind(it) == ParamKind.SELECT }
    val effortTag = when {
        thinking != null && !isOn(thinking) -> "No thinking"
        effort != null && effort.value.isNotEmpty() && effort.value != "default" -> optionLabel(effort, effort.value)
        else -> null
    }
    return SelectionTags(
        effort = effortTag,
        fast = fast != null && isOn(fast),
        max = max != null && isOn(max),
        context = context?.takeIf { it.value != "default" }?.let { optionLabel(it, it.value) },
    )
}

private val SELECTION_SUFFIX = Regex("^(.*)\\[([^\\[\\]]*)]$")

/**
 * `parseSelection`: split `model[effort=high,fast=true]` into its parts.
 *
 * Native model ids can contain suffixes such as Claude's `[1m]`. Only a final `key=value` suffix is
 * a workbench selector; every other native suffix is preserved verbatim.
 */
fun parseSelection(value: String?): ParsedSelection {
    val raw = value?.trim().orEmpty()
    val match = SELECTION_SUFFIX.matchEntire(raw) ?: return ParsedSelection(raw, emptyMap())
    val model = match.groupValues[1]
    val entries = match.groupValues[2].split(',').filter { it.isNotEmpty() }
    if (model.isEmpty() || entries.isEmpty()) return ParsedSelection(raw, emptyMap())
    val params = LinkedHashMap<String, String>()
    for (entry in entries) {
        val separator = entry.indexOf('=')
        if (separator <= 0) return ParsedSelection(raw, emptyMap())
        val key = entry.substring(0, separator).trim()
        val item = entry.substring(separator + 1).trim()
        if (key.isEmpty() || item.isEmpty()) return ParsedSelection(raw, emptyMap())
        params[key] = item
    }
    return ParsedSelection(model, params)
}

fun serializeSelection(model: String, params: Map<String, String>): String =
    if (params.isEmpty()) {
        model
    } else {
        model + "[" + params.entries.sortedBy { it.key }.joinToString(",") { (key, value) -> "$key=$value" } + "]"
    }

/** The catalog entry's own display name, or the id when the catalog does not know it. */
fun modelLabel(catalog: List<ModelInfo>, value: String?): String {
    val model = resolveModelSelection(catalog, value).model
    if (model.isEmpty()) return ""
    return cleanLabel(catalog.firstOrNull { it.value == model }?.name ?: model)
}

/**
 * `modelSelectionSummary`: the model name plus the parameter facts worth repeating on a one-line row.
 *
 * The web's picker trigger carries these next to the model (`ModelPicker.tsx`: the effort label, a
 * `Fast` bolt, a `MAX` badge). On the phone the same facts belong on the 发送设置 「模型」 row: the
 * controls for them live two sheets deep, so without this the reader cannot tell that Fast or Max is
 * on at all.
 */
fun modelSelectionSummary(catalog: List<ModelInfo>, selection: String?): String {
    val resolved = resolveModelSelection(catalog, selection)
    val tags = selectionTags(catalogParams(catalog, resolved.model, resolved.params))
    return buildString {
        append(modelLabel(catalog, selection).ifEmpty { resolved.model })
        tags.effort?.let { append(" · ").append(it) }
        if (tags.fast) append(" · Fast")
        if (tags.max) append(" · MAX")
        tags.context?.let { append(" · ").append(it) }
    }
}

/**
 * `resolveModelSelection`: the catalog family a session's model id belongs to, with the parameter
 * values its id already spells out.
 *
 * This is the piece of `apps/web/src/lib/native-models.ts` the first mobile pass left out, and it is
 * load-bearing: the CLI's own id for a Cursor model is a *variant* (`claude-opus-5-5-high`,
 * `…-fast`, `…-max`), while the catalog groups variants under a family (`claude-opus-5-5`). Without
 * this mapping the session's model matches no catalog entry, so [catalogParams] returns nothing and
 * the Fast / Max / thinking controls never appear at all. The web reaches the same result through
 * `backendSelection` → `nativeCatalogSelection` → `matchFamily`.
 *
 * An id that already names a family (`gpt-5.6-luna[context=1m]`, or any non-Cursor model) is
 * returned untouched, and an explicit `[...]` override always outranks the suffix it came with.
 */
fun resolveModelSelection(catalog: List<ModelInfo>, selection: String?): ParsedSelection {
    val parsed = parseSelection(selection)
    if (parsed.model.isEmpty()) return parsed
    catalog.firstOrNull { it.value == parsed.model }?.let { info ->
        return ParsedSelection(info.value, normalizeEffortAlias(info, parsed.params))
    }
    // A provider can keep the selector a session saved before a rename. Its parameters are the
    // reader's own, so only the model identity moves to the catalog's current value.
    catalog.firstOrNull { parsed.model in it.aliases.orEmpty() }?.let { info ->
        return ParsedSelection(info.value, normalizeEffortAlias(info, parsed.params))
    }
    if (parsed.model.endsWith("[1m]", ignoreCase = true)) {
        val base = parsed.model.replace(Regex("(?:\\[1m\\])+$", RegexOption.IGNORE_CASE), "")
        val info = catalog.firstOrNull { it.value == base }
        if (info?.configOptions?.any { it.id == "context" && it.options.any { option -> option.value == "1m" } } == true) {
            val merged = linkedMapOf("context" to "1m").apply { putAll(normalizeEffortAlias(info, parsed.params)) }
            return ParsedSelection(base, merged)
        }
    }
    for (info in catalog) {
        val member = info.nativeVariants.orEmpty().firstOrNull { it.value == parsed.model } ?: continue
        val slots = nativeVariantSlots(member.value).slots
        val params = LinkedHashMap<String, String>()
        if (slots.effort.isNotEmpty()) params["effort"] = slots.effort
        // `false` is a fact about the id (no `-thinking` / `-fast` suffix), not a missing value: the
        // switches have to read it, otherwise a variant that turned thinking off would look on.
        params["thinking"] = slots.thinking.toString()
        params["fast"] = slots.fast.toString()
        params.putAll(normalizeEffortAlias(info, parsed.params))
        return ParsedSelection(info.value, params)
    }
    return parsed
}

/* ---------------------------------------------------------------------------------------------
 * Cursor's native variants
 *
 * Cursor's catalog groups a model family under one `value` and lists the exact CLI ids behind it in
 * `nativeVariants` (`claude-opus-5`, `claude-opus-5-high`, ...). The parameter controls are the
 * family's own config options, so a selection has to be mapped back onto one listed id instead of
 * being serialized as `model[effort=high]`, which the CLI would reject.
 * ------------------------------------------------------------------------------------------- */

private val NATIVE_DIMENSIONS = listOf(
    "extra-high", "xhigh", "minimal", "none", "medium", "low", "high", "max", "thinking", "fast",
)

/**
 * The parameters a native variant id already carries as a suffix. Everything else has to be
 * spelled out in `[...]`, which is why [catalogSelection] leaves the variant id behind as soon as
 * one of them is chosen.
 */
private val NATIVE_VARIANT_PARAMS = setOf("effort", "reasoning", "reasoning_effort", "thinking", "fast")

private data class NativeSlots(val effort: String, val thinking: Boolean, val fast: Boolean)

private data class NativeVariantSlots(val base: String, val slots: NativeSlots)

private fun nativeVariantSlots(value: String): NativeVariantSlots {
    var base = value.trim().substringBefore('[')
    var slots = NativeSlots("", false, false)
    while (true) {
        val token = NATIVE_DIMENSIONS.firstOrNull { base.length > it.length + 1 && base.endsWith("-$it") }
            ?: break
        base = base.dropLast(token.length + 1)
        slots = when (token) {
            "fast" -> slots.copy(fast = true)
            "thinking" -> slots.copy(thinking = true)
            else -> slots.copy(effort = token)
        }
    }
    return NativeVariantSlots(base, slots)
}

private val EFFORT_ORDER = listOf("default", "none", "minimal", "low", "medium", "high", "xhigh", "extra-high", "max")
private fun effortRank(value: String): Int = EFFORT_ORDER.indexOf(if (value.isEmpty()) "medium" else value)

/**
 * Picks the listed variant closest to what the parameters ask for. When one dimension was just
 * changed ([preferredParam]) every other dimension moves as little as possible; the mismatch cost
 * is what keeps a switch from silently dropping the reader's effort choice.
 */
private fun selectNativeVariant(
    info: ModelInfo,
    params: Map<String, String>,
    preferredParam: String?,
): String? {
    val variants = info.nativeVariants.orEmpty().filter { nativeVariantSlots(it.value).base == info.value }
    if (variants.isEmpty()) return null
    val members = variants.map { it to nativeVariantSlots(it.value).slots }
    val defaultMember = members.firstOrNull { it.second.effort.isEmpty() && !it.second.fast && !it.second.thinking }
        ?: members.firstOrNull { it.first.name == info.name }
        ?: members.first()
    val effortParam = params.entries.firstOrNull { it.key in listOf("effort", "reasoning", "reasoning_effort") }?.value
    val wished = NativeSlots(
        effort = if (effortParam == "default") "" else effortParam ?: defaultMember.second.effort,
        fast = params["fast"]?.let { it == "true" } ?: defaultMember.second.fast,
        thinking = params["thinking"]?.let { it == "true" } ?: defaultMember.second.thinking,
    )
    val preferred = if (preferredParam == "reasoning" || preferredParam == "reasoning_effort") "effort" else preferredParam
    fun cost(slots: NativeSlots): Double {
        val fixed = (preferred == "effort" && slots.effort != wished.effort) ||
            (preferred == "fast" && slots.fast != wished.fast) ||
            (preferred == "thinking" && slots.thinking != wished.thinking)
        return (if (fixed) 1000.0 else 0.0) +
            (if (slots.fast == wished.fast) 0.0 else 2.0) +
            (if (slots.thinking == wished.thinking) 0.0 else 2.0) +
            abs(effortRank(slots.effort) - effortRank(wished.effort)) * 0.1
    }
    return members.minByOrNull { cost(it.second) }?.first?.value
}

/**
 * `catalogSelection`: the complete selection for [model], from the catalog's own options.
 *
 * Every fixed one-value option is carried even though it has no visible control, and an invalid or
 * stale override is replaced by the catalog value - so the string handed to `nativeSetModel` is
 * always one the catalog describes.
 *
 * A native variant id encodes effort / thinking / fast by suffix and **nothing else**. When the
 * reader also chose a dimension the id cannot carry - the context window, i.e. `context=max` for
 * Max mode - the selection becomes the family's parameterized form the CLI documents
 * (`claude-opus-4-8[context=1m,effort=high,fast=false]`). Returning the bare variant id instead
 * would drop that choice silently: the switch would look on and the CLI would never hear about it.
 * All other selections keep the exact listed id, which is what the CLI resolves most reliably.
 */
fun catalogSelection(
    catalog: List<ModelInfo>,
    model: String,
    overrides: Map<String, String> = emptyMap(),
    preferredParam: String? = null,
): String {
    val info = catalog.firstOrNull { it.value == model } ?: return serializeSelection(model, overrides)
    val normalizedOverrides = normalizeEffortAlias(info, overrides)
    val params = LinkedHashMap<String, String>()
    for (option in info.configOptions) {
        if (option.type != "select" || option.id.isEmpty()) continue
        val allowed = option.options.map { it.value }.filter { it.isNotEmpty() }
        if (allowed.isEmpty()) continue
        val override = normalizedOverrides[option.id]
        params[option.id] = when {
            override != null && override in allowed -> override
            option.currentValue in allowed -> option.currentValue
            else -> allowed.first()
        }
    }
    val variant = selectNativeVariant(info, params, preferredParam)
    if (variant != null && normalizedOverrides.keys.none { it in params && it !in NATIVE_VARIANT_PARAMS }) return variant
    return serializeSelection(if (variant != null) info.value else model, params)
}

/**
 * Applies one parameter change on top of the session's current selection, keeping every other
 * parameter where it is. This is what the picker calls on a tap.
 *
 * The current selection is resolved to its family first: a session whose model came back from the
 * CLI as a variant id must still be able to change its thinking level, and the family is where that
 * parameter lives.
 */
fun selectionWithParam(
    catalog: List<ModelInfo>,
    currentSelection: String,
    paramId: String,
    value: String,
): String {
    val parsed = resolveModelSelection(catalog, currentSelection)
    val overrides = LinkedHashMap(parsed.params)
    overrides[paramId] = value
    return catalogSelection(catalog, parsed.model, overrides, preferredParam = paramId)
}

/** Switching models without a selection to carry: the model's own options only. */
fun selectionForModel(catalog: List<ModelInfo>, model: String): String = catalogSelection(catalog, model)

/**
 * Port of `pickedSelection`: [model] picked from [catalog]. When it is the same model as the
 * provider's [remembered] selection, that selection is returned as it was; otherwise the
 * parameters in force in [currentSelection] (effort, Fast, context window...) carry over to every
 * option the new model accepts, and [catalogSelection] drops the rest.
 */
fun pickedSelection(
    catalog: List<ModelInfo>,
    model: String,
    currentSelection: String?,
    remembered: String?,
): String {
    if (!remembered.isNullOrBlank()) {
        val last = resolveModelSelection(catalog, remembered).model
        if (last.isNotEmpty() && last == resolveModelSelection(catalog, model).model) return remembered
    }
    val current = if (currentSelection.isNullOrBlank()) emptyMap() else resolveModelSelection(catalog, currentSelection).params
    return catalogSelection(catalog, model, current)
}

/** Fixing the inherited model as a default keeps its parameters; another model starts with its own. */
fun selectionForDefaultModel(catalog: List<ModelInfo>, currentSelection: String?, model: String): String? {
    if (model.isEmpty()) return null
    val inherited = currentSelection.orEmpty()
    return if (inherited.isNotBlank() && resolveModelSelection(catalog, inherited).model == model) inherited
    else selectionForModel(catalog, model)
}
