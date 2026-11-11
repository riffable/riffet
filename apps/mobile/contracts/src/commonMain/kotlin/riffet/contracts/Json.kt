package riffet.contracts

import kotlinx.serialization.json.Json

/**
 * The single shared JSON configuration for every Riffet payload, client and (in tests) fixture.
 *
 * - [Json.ignoreUnknownKeys] is forward compatibility: a newer server may add fields and an older
 *   phone must still read the message rather than fail the whole stream.
 * - [Json.isLenient] stays false: the server emits strict JSON, and silently accepting malformed
 *   JSON would hide a real protocol break behind an empty screen.
 * - [Json.explicitNulls] is false: absent and null are the same thing on this wire. Every optional
 *   TS field carries a `?`, and the two must round-trip to the same value.
 *
 * This mirrors the contract rules in docs/MOBILE.md ("契约：手写 DTO + golden fixture").
 */
object RiffetJson {
    val instance: Json = Json {
        ignoreUnknownKeys = true
        isLenient = false
        explicitNulls = false
    }
}
