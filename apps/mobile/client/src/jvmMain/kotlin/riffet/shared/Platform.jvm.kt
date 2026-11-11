package riffet.shared

/*
 * The `jvm()` target exists so the network/auth/connection logic can be compiled and tested on a
 * machine without an Android SDK. These actuals are the minimum needed to satisfy the expect
 * declarations; they are test-host implementations, not a desktop product.
 */

private class JvmInMemoryTokenStore : DeviceTokenStore {
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

private class JvmDeviceInfo : DeviceInfo {
    override val deviceName: String = "JVM test host"
}

private class JvmBiometricGate : BiometricGate {
    override suspend fun authenticate(reason: String): Boolean = true
}

actual fun createDeviceTokenStore(): DeviceTokenStore = JvmInMemoryTokenStore()

actual fun createDeviceInfo(): DeviceInfo = JvmDeviceInfo()

actual fun createBiometricGate(): BiometricGate = JvmBiometricGate()

