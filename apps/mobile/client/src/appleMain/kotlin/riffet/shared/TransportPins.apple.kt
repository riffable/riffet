package riffet.shared

import io.ktor.client.HttpClient
import io.ktor.client.HttpClientConfig
import io.ktor.client.engine.darwin.Darwin
import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.addressOf
import kotlinx.cinterop.usePinned
import platform.CoreFoundation.CFDataGetBytePtr
import platform.CoreFoundation.CFDataGetLength
import platform.CoreFoundation.CFRelease
import platform.Foundation.NSURLAuthenticationMethodServerTrust
import platform.Foundation.NSURLCredential
import platform.Foundation.NSURLSessionAuthChallengePerformDefaultHandling
import platform.Foundation.NSURLSessionAuthChallengeUseCredential
import platform.Foundation.credentialForTrust
import platform.Foundation.serverTrust
import platform.Security.SecCertificateCopyData
import platform.Security.SecTrustGetCertificateAtIndex
import platform.Security.SecTrustRef
import platform.posix.memcpy

@OptIn(ExperimentalForeignApi::class)
internal actual fun platformHttpClient(block: HttpClientConfig<*>.() -> Unit): HttpClient = HttpClient(Darwin) {
    engine {
        handleChallenge { _, _, challenge, completionHandler ->
            val space = challenge.protectionSpace
            val trust = space.serverTrust
            if (space.authenticationMethod == NSURLAuthenticationMethodServerTrust && trust != null && pinned(trust)) {
                completionHandler(NSURLSessionAuthChallengeUseCredential, NSURLCredential.credentialForTrust(trust))
            } else {
                // Anything else, a CA-signed front door included, is judged by the system as before.
                completionHandler(NSURLSessionAuthChallengePerformDefaultHandling, null)
            }
        }
    }
    block()
}

/** Whether the leaf certificate of [trust] is a paired server's pinned one. */
@OptIn(ExperimentalForeignApi::class)
internal fun pinned(trust: SecTrustRef): Boolean {
    @Suppress("DEPRECATION")
    val leaf = SecTrustGetCertificateAtIndex(trust, 0) ?: return false
    val data = SecCertificateCopyData(leaf) ?: return false
    try {
        val length = CFDataGetLength(data).toInt()
        val bytes = ByteArray(length)
        if (length > 0) bytes.usePinned { memcpy(it.addressOf(0), CFDataGetBytePtr(data), length.toULong()) }
        return TransportPins.trusts(bytes)
    } finally {
        CFRelease(data)
    }
}
