package riffet.core

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/*
 * Ported from apps/web/src/lib/models.ts — only the part the timeline projection needs.
 * `deriveSessionConfig` calls `paramsFromOptions`, so the model-parameter reader is a real
 * dependency of `core/`, not UI. The presentation helpers (`paramKind`, `optionLabel`, ...) stay
 * behind until P2 needs them.
 */

/** One controllable model parameter (effort, fast, context...). */
data class ModelParam(
    val id: String,
    val name: String,
    val description: String? = null,
    val category: String? = null,
    val value: String,
    val options: List<ModelParamOption>,
)

data class ModelParamOption(
    val value: String,
    val label: String,
)

private val PARAM_CATEGORIES = setOf("thought_level", "model_config")

/** Reads model parameter selects (effort, fast, context...) out of the catalog's config options. */
fun paramsFromOptions(options: JsonElement?): List<ModelParam> =
    records(options).mapNotNull { option ->
        val id = str(option["id"])
        val category = str(option["category"])
        if (id == null || category == null || category !in PARAM_CATEGORIES) return@mapNotNull null
        if (str(option["type"]) != "select") return@mapNotNull null
        val choices = records(option["options"]).mapNotNull { item ->
            val value = str(item["value"]) ?: return@mapNotNull null
            ModelParamOption(value = value, label = cleanLabel(str(item["name"]) ?: value))
        }
        if (choices.size < 2) return@mapNotNull null
        ModelParam(
            id = id,
            name = cleanLabel(str(option["name"]) ?: id),
            description = str(option["description"]),
            category = category,
            value = str(option["currentValue"]) ?: choices.first().value,
            options = choices,
        )
    }

/** Convenience overload so callers holding the raw config-option array can call it directly. */
fun paramsFromOptions(options: List<JsonObject>): List<ModelParam> =
    paramsFromOptions(kotlinx.serialization.json.JsonArray(options))
