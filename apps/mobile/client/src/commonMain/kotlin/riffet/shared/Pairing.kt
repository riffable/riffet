package riffet.shared

import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import riffet.contracts.RiffetJson

/**
 * The JSON a pairing QR carries, exactly as `POST /api/pairing/code` builds it:
 * `{"v":1,"scheme":"http","host":"…","port":1234,"code":"…","name":"…"}`. `scheme` is optional in
 * the parser so a QR from an older server still pairs.
 *
 * The QR contains a short-lived one-time **pairing code**, never the long-lived access token: a
 * screenshot of the code must not become a permanent credential. The code is redeemed at
 * `POST /api/devices/pair`, which is the only place a device token is ever returned.
 *
 * The parser is hand-written over `JsonObject` rather than a strict `@Serializable` decode,
 * because both tolerated conditions are requirements: unknown fields from a newer server must be
 * ignored, and an unknown `v` must produce [PairingPayloadException.UnknownVersion] so the UI can
 * say "update the app" instead of "this code is broken".
 */
data class PairingPayload(
    val v: Int,
    /** Hostname, LAN address or mDNS name; the server's `allowedHosts` accepts all three. */
    val host: String,
    val port: Int,
    val code: String,
    /** The server machine's name; display only. */
    val name: String? = null,
    /**
     * `http` or `https`. The server reports it, because only it can know: the recommended remote
     * topology is a TLS-terminating front door (`tailscale serve`, a reverse proxy) in front of a
     * server that itself has no certificate, and that front door forwards the original scheme.
     *
     * Defaults to `http` so a QR printed by a server too old to send the field still pairs — over
     * plain HTTP, which is what such a server is serving.
     */
    val scheme: String = HTTP,
    /**
     * Every address the server listens on, [host] first. A network can block one of them (Wi-Fi
     * that isolates wireless clients) while another answers, so a scan tries them in order; a QR
     * from an older server carries only [host].
     */
    val hosts: List<String> = listOf(host),
) {
    /**
     * Plain HTTP over a LAN is the documented tradeoff (`docs/MOBILE.md`, 网络接入): the token
     * crosses the network in the clear. HTTPS is what a TLS front door provides, and it is why the
     * scheme travels with the pairing payload instead of being assumed here.
     */
    val baseUrl: String get() = "$scheme://$host:$port"

    /** [hosts] as base URLs, [baseUrl] first. */
    val baseUrls: List<String> get() = (listOf(host) + hosts).distinct().map { "$scheme://$it:$port" }

    companion object {
        /** The only protocol version this build can redeem. */
        const val CURRENT_VERSION: Int = 1

        const val HTTP: String = "http"
        const val HTTPS: String = "https"

        private const val MAX_HOSTS = 8

        fun parse(json: String): PairingPayload {
            val element = try {
                RiffetJson.instance.parseToJsonElement(json)
            } catch (_: SerializationException) {
                throw PairingPayloadException.Invalid("The pairing code is not valid JSON.")
            }
            val payload = element as? JsonObject
                ?: throw PairingPayloadException.Invalid("The pairing code must be a JSON object.")

            val rawVersion = payload["v"]
            val version = (rawVersion as? JsonPrimitive)?.intOrNull
            if (version != CURRENT_VERSION) throw PairingPayloadException.UnknownVersion(version, rawVersion)

            val host = (payload["host"] as? JsonPrimitive)?.contentOrNull
            val port = (payload["port"] as? JsonPrimitive)?.intOrNull
            val code = (payload["code"] as? JsonPrimitive)?.contentOrNull
            if (host.isNullOrBlank() || port == null || port !in 1..65535 || code.isNullOrBlank()) {
                throw PairingPayloadException.Invalid("The pairing code is missing its host, port or code.")
            }
            val name = (payload["name"] as? JsonPrimitive)?.contentOrNull
            // Only the two schemes are ever accepted, so nothing a server sends can be spliced into
            // the URL as something else. Anything unrecognised means plain HTTP.
            val scheme = (payload["scheme"] as? JsonPrimitive)?.contentOrNull
                ?.trim()?.lowercase()?.takeIf { it == HTTP || it == HTTPS } ?: HTTP
            // Only plain host names and IPv4 literals: anything else could reshape the URL it is put into.
            val hosts = (payload["hosts"] as? JsonArray).orEmpty()
                .mapNotNull { (it as? JsonPrimitive)?.contentOrNull?.trim() }
                .filter { it.isNotEmpty() && it.all { char -> char in 'a'..'z' || char in 'A'..'Z' || char in '0'..'9' || char in ".-_" } }
                .take(MAX_HOSTS)
            return PairingPayload(
                v = version, host = host, port = port, code = code, name = name, scheme = scheme,
                hosts = (listOf(host) + hosts).distinct(),
            )
        }
    }
}
