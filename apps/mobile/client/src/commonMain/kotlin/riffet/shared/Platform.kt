package riffet.shared

/*
 * Platform seams. Everything above this file is commonMain and must not know which platform it
 * runs on; these four capabilities are the only places that differ (docs/MOBILE.md, "平台层").
 *
 * They are declared as interfaces plus `expect` factory functions rather than `expect class`
 * declarations because the Android implementations need a `Context` and the iOS ones will need
 * framework objects; a factory keeps that out of the common signature.
 */

/**
 * Persists the paired device across launches: the token, the origin that issued it, and the server
 * it belongs to.
 *
 * They are stored together because they are meaningful only as a set. A token without its server
 * cannot rebuild an API, and a server without a token is an unpaired device; keeping them in one
 * store means a relaunch either has a working connection or has nothing, never half of one.
 *
 * The origin is what keeps the token from leaving its server: it is attached only to requests for
 * that exact `scheme://host:port` (see [tokenFor]), so pointing the app at another address — typed,
 * discovered, scanned or injected — never hands the token to it.
 *
 * Android seals the token with an Android Keystore key (see `Platform.android.kt`); the iOS
 * implementation targets the Keychain.
 */
interface DeviceTokenStore {
    /** Versioned multi-server snapshot, protected by the same platform credential storage. */
    suspend fun loadPairings(): String?

    /** Atomically replaces the snapshot; legacy credentials are removed only after it is durable. */
    suspend fun savePairings(value: String)

    // The single-server methods remain for migration and hosts which manage their own server list.
    suspend fun load(): String?

    /**
     * The origin ([serverOrigin]) the stored token was issued by. Null when there is no token, and
     * for a token stored before origins were recorded; [boundOrigin] binds that one to its server.
     */
    suspend fun loadOrigin(): String?

    /** Stores [token] as issued by [origin], replacing any earlier token. */
    suspend fun save(token: String, origin: String)

    suspend fun clear()

    /** The paired server's base URL, or null when this device has never paired. */
    suspend fun loadServer(): String?

    suspend fun saveServer(baseUrl: String)
}

/** A stable, human-readable name the server shows in `GET /api/devices`. */
interface DeviceInfo {
    val deviceName: String
}

/** Gate a destructive action (approving a tool call, deleting a session) behind the device lock. */
interface BiometricGate {
    suspend fun authenticate(reason: String): Boolean
}

/**
 * Posts a local notification. Only meaningful while the foreground service holds the stream; the
 * UI must say so rather than implying background push (docs/MOBILE.md, "通知").
 */
interface Notifier {
    fun notify(title: String, body: String)
}

expect fun createDeviceTokenStore(): DeviceTokenStore

expect fun createDeviceInfo(): DeviceInfo

expect fun createBiometricGate(): BiometricGate
