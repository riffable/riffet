package riffet.shared

/*
 * The JVM target exists only so the shared logic can be compiled and tested without an Android SDK
 * (see `Platform.jvm.kt`). There is no desktop product and no desktop discovery mechanism, so this
 * is honest the same way the other JVM seams are: it finds nothing rather than pretending.
 */

private object EmptyServerDiscovery : ServerDiscovery {
    override suspend fun discover(timeoutMillis: Long): List<DiscoveredServer> = emptyList()
}

actual fun createServerDiscovery(): ServerDiscovery = EmptyServerDiscovery
