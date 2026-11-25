package riffet.shared

import io.ktor.http.Url
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.Serializable
import kotlinx.serialization.Required
import kotlinx.serialization.encodeToString
import riffet.contracts.RiffetJson
import riffet.i18n.L10n

/** The service list never exposes a device credential to the UI. */
data class PairedServer(
    val origin: String,
    val baseUrl: String,
    val name: String? = null,
    val lastUsedAt: Long = 0,
) {
    val displayName: String get() = name?.takeIf { it.isNotBlank() }
        ?: Url(baseUrl).let { "${it.host}:${it.port}" }

    companion object {
        /** Count a supplementary character once, consistently with the native iOS editor. */
        fun isValidName(name: String): Boolean {
            val value = name.trim()
            return value.none { it.isISOControl() || it == '\u2028' || it == '\u2029' } &&
                value.indices.count { index ->
                    index == 0 || !value[index].isLowSurrogate() || !value[index - 1].isHighSurrogate()
                } <= 64
        }
    }
}

@Serializable
internal data class PairedCredential(
    val origin: String,
    val baseUrl: String,
    val token: String,
    /** Null uses the first pairing's name; empty means the user explicitly chose the address. */
    val name: String? = null,
    val deviceId: String? = null,
    val lastUsedAt: Long = 0,
    /** Where the server was last reached when that is not [baseUrl]; see [ServerRoutes]. */
    val route: String? = null,
    /** The pairing QR's other addresses, tried by [RiffetConnection.relocate] where discovery finds nothing. */
    val alternates: List<String> = emptyList(),
    /** The server's TLS certificate SHA-256 once pinned; its requests then go over TLS ([TransportPins]). */
    val tlsFingerprint: String? = null,
) {
    fun server() = PairedServer(origin, baseUrl, name, lastUsedAt)
}

@Serializable
internal data class PairedServices(
    @Required val version: Int = 1,
    val activeOrigin: String? = null,
    @Required val servers: List<PairedCredential> = emptyList(),
) {
    fun encoded(): String = RiffetJson.instance.encodeToString(this)

    companion object {
        fun decode(raw: String): PairedServices {
            // Serialization diagnostics can include their input; never expose credential JSON.
            val value = try { RiffetJson.instance.decodeFromString<PairedServices>(raw) }
            catch (_: Exception) { throw IllegalStateException(L10n.uiText("connection.pairingUnreadable")) }
            require(value.version == 1) { L10n.uiText("connection.pairingVersionUnsupported") }
            require(value.servers.all { it.token.isNotBlank() && serverOrigin(it.baseUrl) == it.origin }) {
                L10n.uiText("connection.pairingMismatch")
            }
            require(value.servers.distinctBy { it.origin }.size == value.servers.size) { L10n.uiText("connection.pairingDuplicate") }
            require(value.activeOrigin == null || value.servers.any { it.origin == value.activeOrigin }) { L10n.uiText("connection.pairingActiveMissing") }
            return value
        }
    }
}

// iOS creates short-lived connection objects over the same Keychain item. Mutations must serialize
// across those objects too, including migration, so one cannot overwrite another's saved service.
internal val pairingChanges = Mutex()

/** The selected service for resource requests; a saved selection supersedes legacy address keys. */
suspend fun DeviceTokenStore.activeServerBaseUrl(): String? {
    loadPairings()?.let { raw ->
        val state = PairedServices.decode(raw)
        return state.servers.firstOrNull { it.origin == state.activeOrigin }?.baseUrl
    }
    return loadServer()
}

/** Called under [pairingChanges]. The migration becomes one durable platform write. */
internal suspend fun DeviceTokenStore.pairings(): PairedServices {
    loadPairings()?.let { return PairedServices.decode(it) }
    val token = load()?.takeIf { it.isNotBlank() }
    val base = loadServer()?.trim()?.trimEnd('/')
    val origin = loadOrigin() ?: base?.let(::serverOrigin)
    val legacy = if (token != null && origin != null) {
        // A previous debug address override must never transfer the old credential to that address.
        val address = base?.takeIf { serverOrigin(it) == origin } ?: origin
        PairedCredential(origin, address, token)
    } else null
    val state = PairedServices(
        activeOrigin = legacy?.origin?.takeIf { base?.let(::serverOrigin) == it },
        servers = listOfNotNull(legacy),
    )
    savePairings(state.encoded())
    return state
}
