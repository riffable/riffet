package riffet.shared

import platform.Foundation.NSHost
import platform.Foundation.NSUserDefaults

/*
 * The macOS side of the platform seams. The app passes its Keychain-backed [DeviceTokenStore] to
 * `RiffetConnection` itself (apps/macos/Riffet/Bridge), so the default here is only what a test or a
 * framework consumer gets when it does not.
 */

private class MacInMemoryTokenStore : DeviceTokenStore {
    private var token: String? = null
    private var origin: String? = null
    private var server: String? = null
    private var pairings: String? = null

    override suspend fun loadPairings(): String? = pairings

    override suspend fun savePairings(value: String) {
        pairings = value
        token = null
        origin = null
        server = null
    }

    override suspend fun load(): String? = token

    override suspend fun loadOrigin(): String? = origin

    override suspend fun save(token: String, origin: String) {
        this.token = token
        this.origin = origin
    }

    override suspend fun clear() {
        pairings = null
        token = null
        origin = null
        server = null
    }

    override suspend fun loadServer(): String? = server

    override suspend fun saveServer(baseUrl: String) {
        server = baseUrl
    }
}

/** The name the Mac shows in Sharing settings, which is also what the server's device list should show. */
private class MacDeviceInfo : DeviceInfo {
    override val deviceName: String = NSHost.currentHost().localizedName?.takeIf { it.isNotBlank() } ?: "Mac"
}

/** Touch ID is asked for by the app before it calls into Kotlin; nothing here gates on it. */
private class MacBiometricGate : BiometricGate {
    override suspend fun authenticate(reason: String): Boolean = true
}

private class MacAppPreferences : AppPreferences {
    private val defaults get() = NSUserDefaults.standardUserDefaults

    override fun themeMode(): ThemeMode =
        ThemeMode.entries.firstOrNull { it.name == defaults.stringForKey(THEME_KEY) } ?: ThemeMode.SYSTEM

    override fun setThemeMode(mode: ThemeMode) {
        defaults.setObject(mode.name, forKey = THEME_KEY)
    }

    override fun string(key: String): String? = defaults.stringForKey(PREFIX + key)

    override fun setString(key: String, value: String?) {
        if (value == null) defaults.removeObjectForKey(PREFIX + key) else defaults.setObject(value, forKey = PREFIX + key)
    }

    private companion object {
        const val THEME_KEY = "riffet.theme-mode"
        const val PREFIX = "riffet.pref."
    }
}

private object MacServerDiscovery : ServerDiscovery {
    override suspend fun discover(timeoutMillis: Long): List<DiscoveredServer> = emptyList()
}

actual fun createDeviceTokenStore(): DeviceTokenStore = MacInMemoryTokenStore()

actual fun createDeviceInfo(): DeviceInfo = MacDeviceInfo()

actual fun createBiometricGate(): BiometricGate = MacBiometricGate()

actual fun createAppPreferences(): AppPreferences = MacAppPreferences()

actual fun createServerDiscovery(): ServerDiscovery = MacServerDiscovery
