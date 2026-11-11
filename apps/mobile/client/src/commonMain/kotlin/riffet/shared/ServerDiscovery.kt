package riffet.shared

/**
 * Best-effort local-network discovery of Riffet servers, so the pairing screen can offer "tap your
 * Mac" instead of asking the user to type an IP or a `.local` name.
 *
 * This is the fifth platform seam of the `expect`/`actual` family in [Platform], declared the same
 * way (an interface plus an `expect` factory) because the Android implementation needs a `Context`.
 *
 * Discovery is an optimisation, never a prerequisite: the pairing screen's typed address field is
 * the first-class path, and every failure mode of this interface (no mDNS responder on the network,
 * no permission, a timeout, an unsupported platform) means "discovered nothing", never an error the
 * user has to dismiss.
 */
interface ServerDiscovery {
    /**
     * Best-effort local-network lookup; returns quickly and never throws.
     *
     * The Android actual browses `_riffet._tcp`, the service type `apps/server/src/discovery.ts`
     * advertises. The JVM and iOS actuals are stubs that return an empty list.
     */
    suspend fun discover(timeoutMillis: Long = 3000): List<DiscoveredServer>
}

/**
 * One advertised Riffet server. [host] is what a URL would embed (an IPv6 literal keeps its
 * brackets); [port] is the port the server actually listens on, not an assumed default.
 */
data class DiscoveredServer(val name: String, val host: String, val port: Int)

expect fun createServerDiscovery(): ServerDiscovery
