package riffet.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlin.time.Instant

/*
 * The small untrusted-JSON readers that apps/web/src/lib/utils.ts provides for buildTimeline.ts.
 *
 * They are ports, not reinventions, and the difference matters: `str` treats the empty string as
 * absent, `pixelEdge` accepts only safe positive integers, and `cleanLabel` strips the zero-width
 * padding Cursor puts in model names. Every one of those is load-bearing for the timeline.
 */

/** `isRecord`: a JSON object, not an array and not null. */
internal fun isRecord(value: JsonElement?): Boolean = value is JsonObject

/** `str`: only a non-empty JSON string counts; numbers/booleans/null are absent. */
internal fun str(value: JsonElement?): String? {
    val primitive = value as? JsonPrimitive ?: return null
    if (!primitive.isString) return null
    return primitive.content.takeIf { it.isNotEmpty() }
}

/** `records`: the object members of a JSON array, in order. */
internal fun records(value: JsonElement?): List<JsonObject> =
    (value as? JsonArray)?.mapNotNull { it as? JsonObject } ?: emptyList()

/** `typeof value === 'number' && Number.isFinite(value)`. */
internal fun finiteNumber(value: JsonElement?): Double? {
    val primitive = value as? JsonPrimitive ?: return null
    if (primitive is JsonNull) return null
    if (primitive.isString) return null
    val number = primitive.doubleOrNull ?: return null
    return if (number.isFinite()) number else null
}

/** `typeof value === 'number' && Number.isFinite(value) && value >= 0`. */
internal fun nonNegativeNumber(value: JsonElement?): Double? = finiteNumber(value)?.takeIf { it >= 0.0 }

/** A JSON boolean; a string `"true"` is not one, matching `event.data.x === true`. */
internal fun bool(value: JsonElement?): Boolean? {
    val primitive = value as? JsonPrimitive ?: return null
    if (primitive.isString) return null
    return primitive.booleanOrNull
}

/** `Number.isSafeInteger(value) && value > 0`. */
internal fun pixelEdge(value: JsonElement?): Long? {
    val number = finiteNumber(value) ?: return null
    if (number % 1.0 != 0.0) return null
    if (number <= 0.0 || number > 9_007_199_254_740_991.0) return null
    return number.toLong()
}

/** Cursor model names sometimes carry zero-width padding and doubled spaces. */
internal fun cleanLabel(value: String): String {
    val builder = StringBuilder(value.length)
    for (character in value) {
        if (character in '\u200B'..'\u200D' || character == '\uFEFF') continue
        builder.append(character)
    }
    return builder.toString().replace(Regex("\\s+"), " ").trim()
}

/**
 * `Date.parse`, restricted to the ISO-8601 instants the server writes. An unparseable stamp is
 * `null` (the JS `NaN`), never a silently substituted epoch.
 */
internal fun parseMillis(value: String?): Long? {
    if (value.isNullOrEmpty()) return null
    return try {
        Instant.parse(value).toEpochMilliseconds()
    } catch (_: IllegalArgumentException) {
        null
    }
}

/**
 * `encodeURIComponent`, which the projection keys were built with on the web. Only `runId` and
 * `toolCallId` are escaped, so the exact escape set is not observable on the wire — but the keys
 * must agree between the two implementations, so this stays the literal algorithm.
 */
private const val UNRESERVED = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"
private const val HEX = "0123456789ABCDEF"

internal fun encodeUriComponent(value: String): String {
    val builder = StringBuilder(value.length)
    for (character in value) {
        if (character in UNRESERVED) {
            builder.append(character)
            continue
        }
        for (byte in character.toString().encodeToByteArray()) {
            val code = byte.toInt() and 0xFF
            builder.append('%').append(HEX[code shr 4]).append(HEX[code and 0x0F])
        }
    }
    return builder.toString()
}
