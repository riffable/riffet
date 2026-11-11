package riffet.shared

import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import riffet.contracts.AgentIds
import riffet.contracts.RiffetJson

/**
 * Plugin Agent ids on the wire, for a client that names [AgentIds.PLUGIN_AGENTS_FEATURE].
 *
 * [NativeBackendId][riffet.contracts.NativeBackendId] is a closed enum that Android compiles
 * exhaustive `when`s over, so it cannot hold `acme.gemini`. This is the one place that bridges the
 * two: [lift] moves a plugin id out of the field the enum decodes into a sidecar (`agentId`,
 * `defaultAgentId`, `agentDefaults`) and leaves a stand-in that still decodes; [lower] does the
 * reverse on a request body. A build that does not name the feature never calls either, so Android
 * and iOS keep decoding exactly what they did.
 */
internal object AgentWire {
    /** What a typed field holds in place of a plugin id; nothing reads it. */
    private const val STAND_IN = "pi"

    fun <T> decode(text: String, serializer: KSerializer<T>): T {
        // Most payloads name no backend at all; the two checks keep them on the plain streaming decode.
        if (!text.contains("ackendId") && !text.contains("nativeBackendDefaults") && !text.contains("\"backends\"")) {
            return RiffetJson.instance.decodeFromString(serializer, text)
        }
        return RiffetJson.instance.decodeFromJsonElement(serializer, lift(RiffetJson.instance.parseToJsonElement(text)))
    }

    /** Returns [element] itself when it names no plugin Agent. */
    fun lift(element: JsonElement): JsonElement = when (element) {
        is JsonObject -> liftObject(element)
        is JsonArray -> liftArray(element)
        else -> element
    }

    private fun liftArray(array: JsonArray): JsonElement {
        var out: MutableList<JsonElement>? = null
        array.forEachIndexed { index, item ->
            val lifted = lift(item)
            if (lifted !== item) (out ?: array.toMutableList().also { out = it })[index] = lifted
        }
        return out?.let(::JsonArray) ?: array
    }

    fun lift(obj: JsonObject): JsonObject = liftObject(obj)

    private fun liftObject(obj: JsonObject): JsonObject {
        var out: MutableMap<String, JsonElement>? = null
        fun edit(): MutableMap<String, JsonElement> = out ?: LinkedHashMap(obj).also { out = it }
        for ((name, value) in obj) {
            when {
                (name == "backendId" || name == "defaultBackendId") && value.pluginId() != null -> {
                    val sidecar = if (name == "backendId") "agentId" else "defaultAgentId"
                    edit()[name] = JsonPrimitive(STAND_IN)
                    if (sidecar !in obj) edit()[sidecar] = value
                }
                name == "nativeBackendDefaults" && value is JsonObject && value.keys.any(AgentIds::isPlugin) -> {
                    edit()[name] = JsonObject(value.filterKeys { !AgentIds.isPlugin(it) })
                    if ("agentDefaults" !in obj) edit()["agentDefaults"] = JsonObject(value.filterKeys(AgentIds::isPlugin))
                }
                name == "backends" && value is JsonArray && value.any { it.pluginId() != null } ->
                    edit()[name] = JsonArray(value.filter { it.pluginId() == null })
                else -> {
                    val lifted = lift(value)
                    if (lifted !== value) edit()[name] = lifted
                }
            }
        }
        return out?.let(::JsonObject) ?: obj
    }

    /** Puts the sidecars of a request body back where the server reads them. Returns [body] itself when there are none. */
    fun lower(body: JsonElement): JsonElement = when (body) {
        is JsonObject -> lowerObject(body)
        is JsonArray -> {
            var out: MutableList<JsonElement>? = null
            body.forEachIndexed { index, item ->
                val lowered = lower(item)
                if (lowered !== item) (out ?: body.toMutableList().also { out = it })[index] = lowered
            }
            out?.let(::JsonArray) ?: body
        }
        else -> body
    }

    private fun lowerObject(obj: JsonObject): JsonElement {
        var out: MutableMap<String, JsonElement>? = null
        fun edit(): MutableMap<String, JsonElement> = out ?: LinkedHashMap(obj).also { out = it }
        for ((name, value) in obj) {
            when {
                name == "agentId" && value.pluginId() != null -> { edit().remove(name); edit()["backendId"] = value }
                name == "defaultAgentId" && value.pluginId() != null -> { edit().remove(name); edit()["defaultBackendId"] = value }
                name == "agentDefaults" && value is JsonObject -> {
                    val merged = LinkedHashMap((obj["nativeBackendDefaults"] as? JsonObject) ?: JsonObject(emptyMap()))
                    merged.putAll(value)
                    edit().remove(name)
                    edit()["nativeBackendDefaults"] = JsonObject(merged)
                }
                else -> {
                    val lowered = lower(value)
                    if (lowered !== value) edit()[name] = lowered
                }
            }
        }
        return out?.let(::JsonObject) ?: obj
    }

    private fun JsonElement.pluginId(): String? =
        (this as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf(AgentIds::isPlugin)
}
