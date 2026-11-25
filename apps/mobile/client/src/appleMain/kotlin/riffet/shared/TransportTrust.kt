package riffet.shared

import kotlinx.cinterop.ExperimentalForeignApi
import platform.Foundation.NSURLAuthenticationMethodServerTrust
import platform.Foundation.NSURLProtectionSpace
import platform.Foundation.serverTrust

/**
 * For a URLSession or web view delegate of the app's own: whether a server-trust challenge is from a paired server
 * presenting its pinned certificate, to be answered with a credential for that trust. Anything else gets the
 * system's default handling.
 */
@OptIn(ExperimentalForeignApi::class)
fun trustsPairedServer(space: NSURLProtectionSpace): Boolean {
    if (space.authenticationMethod != NSURLAuthenticationMethodServerTrust) return false
    val trust = space.serverTrust ?: return false
    return pinned(trust)
}
