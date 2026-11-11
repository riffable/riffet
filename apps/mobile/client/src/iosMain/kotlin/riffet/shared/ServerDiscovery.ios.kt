package riffet.shared

/**
 * The native iPhone host uses Swift's Bonjour browser because discovery permission, cancellation
 * and lifecycle belong to the system UI. This legacy shared factory supplies no duplicate browser.
 * Typed addresses and scanned pairing payloads still go through the common pairing validation.
 */
private object IosServerDiscovery : ServerDiscovery {
    override suspend fun discover(timeoutMillis: Long): List<DiscoveredServer> = emptyList()
}

actual fun createServerDiscovery(): ServerDiscovery = IosServerDiscovery
