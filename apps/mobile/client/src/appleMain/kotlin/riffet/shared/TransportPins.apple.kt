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
import platform.Foundation.NSURLAuthenticationMethodClientCertificate
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
import kotlin.concurrent.Volatile

/** The app's own device identity (docs/TRANSPORT-SECURITY.md §2): Swift builds the `SecIdentity` the Security framework needs. */
interface DeviceCredentialProvider {
    /** The credential answering a server's client-certificate request; null when the identity cannot be made. */
    fun credential(): NSURLCredential?
}

/** Set once by the app at launch. The Mac app sets none, and so presents no certificate. */
object DeviceCredentials {
    @Volatile
    var provider: DeviceCredentialProvider? = null
}

internal actual val presentsDeviceCertificate: Boolean get() = DeviceCredentials.provider != null

@OptIn(ExperimentalForeignApi::class)
internal actual fun platformHttpClient(block: HttpClientConfig<*>.() -> Unit): HttpClient = HttpClient(Darwin) {
    engine {
        handleChallenge { _, _, challenge, completionHandler ->
            val space = challenge.protectionSpace
            val trust = space.serverTrust
            val device = if (space.authenticationMethod == NSURLAuthenticationMethodClientCertificate) DeviceCredentials.provider?.credential() else null
            if (space.authenticationMethod == NSURLAuthenticationMethodServerTrust && trust != null && pinned(trust)) {
                completionHandler(NSURLSessionAuthChallengeUseCredential, NSURLCredential.credentialForTrust(trust))
            } else if (device != null) {
                completionHandler(NSURLSessionAuthChallengeUseCredential, device)
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
