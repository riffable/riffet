package riffet.ui.pairing

/**
 * The port the `riffet` launcher and an npm install listen on when nothing else is chosen (the
 * dev server's 4317 is not a user-facing default). It is only the fallback for a typed plain-HTTP
 * address with no port; a discovered server or an explicit `host:port` always wins, because the
 * server can listen anywhere (`apps/server/src/pairing.ts` puts the real port in the payload).
 */
internal const val DEFAULT_RIFFET_PORT = 4337

/** What `https://host` means without a port: a TLS reverse proxy on the scheme's own port. */
private const val DEFAULT_HTTPS_PORT = 443

/** The 30-symbol alphabet `apps/server/src/pairing.ts` draws codes from: no `I`, `L`, `O` or `U`. */
internal const val PAIRING_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ"

internal const val PAIRING_CODE_LENGTH = 8

/**
 * A typed address resolved to a scheme, host and port. [host] is URL-embeddable: an IPv6 literal
 * keeps its brackets, so [baseUrl] is well formed and so is the transmitter built from the same host.
 */
internal data class ServerAddress(
    val host: String,
    val port: Int,
    /** `http` unless the person typed `https://`, which means a TLS front door is in front. */
    val scheme: String = "http",
) {
    val baseUrl: String get() = "$scheme://$host:$port"
}

/**
 * Turns what a person actually types into a [ServerAddress], or `null` when it cannot be one.
 *
 * Accepted:
 *  - `192.168.1.10` / `mac.local` — the port defaults to [DEFAULT_RIFFET_PORT];
 *  - `192.168.1.10:4337` / `mac.local:8080` — the port is honoured;
 *  - `http://192.168.1.10:4337/` — trailing slash, path, query and fragment are dropped;
 *  - `https://mac.tailnet.ts.net` — the scheme is kept, which is what a `tailscale serve` or
 *    reverse-proxy deployment needs, and without a port it is 443, not [DEFAULT_RIFFET_PORT];
 *  - `[fe80::1]:4337` — IPv6 must be bracketed; the brackets are preserved.
 *
 * A bare, unbracketed IPv6 literal is rejected rather than guessed, because `fe80::1:4337` is
 * genuinely ambiguous.
 */
internal fun normalizeServerAddress(input: String, defaultPort: Int = DEFAULT_RIFFET_PORT): ServerAddress? {
    var text = input.trim()
    if (text.isEmpty()) return null

    var scheme = "http"
    text = when {
        text.startsWith("http://", ignoreCase = true) -> text.substring(7)
        text.startsWith("https://", ignoreCase = true) -> {
            scheme = "https"
            text.substring(8)
        }
        else -> text
    }
    val fallbackPort = if (scheme == "https") DEFAULT_HTTPS_PORT else defaultPort
    // A base URL can be pasted whole; keep only the authority.
    text = text.substringBefore('/').substringBefore('?').substringBefore('#').trim()

    if (text.startsWith("[")) {
        val close = text.indexOf(']')
        if (close <= 1) return null
        val host = text.substring(0, close + 1).lowercase()
        val rest = text.substring(close + 1).trim()
        val port = when {
            rest.isEmpty() -> fallbackPort
            rest.startsWith(":") -> rest.substring(1).trim().toIntOrNull() ?: return null
            else -> return null
        }
        if (!isValidPort(port)) return null
        return ServerAddress(host, port, scheme)
    }

    val firstColon = text.indexOf(':')
    val lastColon = text.lastIndexOf(':')
    return when {
        // No colon at all: a bare host, default port.
        firstColon < 0 -> ServerAddress(text.lowercase(), fallbackPort, scheme).takeIf { it.host.isNotEmpty() }

        // Exactly one colon: host:port.
        firstColon == lastColon -> {
            val host = text.substring(0, firstColon).trim().lowercase()
            val port = text.substring(lastColon + 1).trim().toIntOrNull() ?: return null
            if (host.isEmpty() || !isValidPort(port)) return null
            ServerAddress(host, port, scheme)
        }

        // Several colons and no brackets: an IPv6 literal we refuse to guess at.
        else -> null
    }
}

/** The address string to prefill into the field for a discovered server. */
internal fun formatServerAddress(host: String, port: Int): String =
    "${if (host.contains(':') && !host.startsWith("[")) "[$host]" else host}:$port"

private fun isValidPort(port: Int): Boolean = port in 1..65535

/**
 * Canonical form of a typed or pasted code: case-insensitive and whitespace-tolerant, matching what
 * `apps/server/src/pairing.ts` does before comparing.
 */
internal fun normalizePairingCode(raw: String): String =
    raw.filterNot { it.isWhitespace() }.uppercase()

/**
 * Whether a code could be a real one. The server's alphabet excludes `I`, `L`, `O` and `U` precisely
 * so a code read aloud is unambiguous, so a code containing them is a typo, not a valid code.
 */
internal fun isPlausiblePairingCode(raw: String): Boolean {
    val code = normalizePairingCode(raw)
    return code.length == PAIRING_CODE_LENGTH && code.all { it in PAIRING_CODE_ALPHABET }
}
