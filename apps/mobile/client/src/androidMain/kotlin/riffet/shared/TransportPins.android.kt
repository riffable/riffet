package riffet.shared

import io.ktor.client.HttpClient
import io.ktor.client.HttpClientConfig
import io.ktor.client.engine.okhttp.OkHttp
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.net.Socket
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Principal
import java.security.PrivateKey
import java.security.spec.ECGenParameterSpec
import javax.net.ssl.X509KeyManager
import javax.security.auth.x500.X500Principal
import java.security.cert.X509Certificate
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

internal actual fun platformHttpClient(block: HttpClientConfig<*>.() -> Unit): HttpClient = HttpClient(OkHttp) {
    engine {
        config {
            val trust = PinnedTrustManager(systemTrustManager())
            // The device's own key, which never leaves the Keystore, answers a server that asks for a certificate.
            val context = SSLContext.getInstance("TLS").apply { init(arrayOf(DeviceKeyManager), arrayOf(trust), null) }
            sslSocketFactory(context.socketFactory, trust)
            // A pinned certificate names no host; one a CA signed must still match the host it was asked for.
            val system = HttpsURLConnection.getDefaultHostnameVerifier()
            hostnameVerifier { host, session ->
                val leaf = runCatching { session.peerCertificates.firstOrNull()?.encoded }.getOrNull()
                (leaf != null && TransportPins.trusts(leaf)) || system.verify(host, session)
            }
        }
    }
    block()
}

internal actual val presentsDeviceCertificate: Boolean = true

/**
 * This device's TLS identity (docs/TRANSPORT-SECURITY.md §2): a P-256 key made in the Android Keystore, in StrongBox
 * where there is one, never exportable, with the self-signed certificate the Keystore issues for it.
 */
private object DeviceKeyManager : X509KeyManager {
    private const val ALIAS = "riffet.device.tls"

    private val keyStore: KeyStore by lazy { KeyStore.getInstance("AndroidKeyStore").apply { load(null) } }

    @Synchronized
    private fun ensure() {
        if (keyStore.containsAlias(ALIAS)) return
        fun spec(strongBox: Boolean) = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_NONE, KeyProperties.DIGEST_SHA256)
            .setCertificateSubject(X500Principal("CN=Riffet device"))
            .setIsStrongBoxBacked(strongBox)
            .build()
        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
        try {
            generator.initialize(spec(strongBox = android.os.Build.VERSION.SDK_INT >= 28))
            generator.generateKeyPair()
        } catch (_: Exception) {
            // No StrongBox on this device: the TEE-backed Keystore is the next best.
            generator.initialize(spec(strongBox = false))
            generator.generateKeyPair()
        }
    }

    private fun offered(keyTypes: Array<out String>?): String? =
        if (keyTypes == null || keyTypes.any { it.startsWith("EC") }) runCatching { ensure(); ALIAS }.getOrNull() else null

    override fun chooseClientAlias(keyType: Array<out String>?, issuers: Array<out Principal>?, socket: Socket?): String? = offered(keyType)

    override fun getClientAliases(keyType: String?, issuers: Array<out Principal>?): Array<String>? =
        offered(keyType?.let { arrayOf(it) })?.let { arrayOf(it) }

    override fun getCertificateChain(alias: String?): Array<X509Certificate>? =
        if (alias != ALIAS) null else keyStore.getCertificateChain(ALIAS)?.map { it as X509Certificate }?.toTypedArray()

    override fun getPrivateKey(alias: String?): PrivateKey? = if (alias != ALIAS) null else keyStore.getKey(ALIAS, null) as? PrivateKey

    override fun getServerAliases(keyType: String?, issuers: Array<out Principal>?): Array<String>? = null

    override fun chooseServerAlias(keyType: String?, issuers: Array<out Principal>?, socket: Socket?): String? = null
}

private fun systemTrustManager(): X509TrustManager {
    val factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
    factory.init(null as KeyStore?)
    return factory.trustManagers.filterIsInstance<X509TrustManager>().first()
}

/** A paired server's own certificate by its pin; every other one through the system's CAs. */
private class PinnedTrustManager(private val system: X509TrustManager) : X509TrustManager {
    override fun checkServerTrusted(chain: Array<out X509Certificate>, authType: String) {
        val leaf = chain.firstOrNull() ?: return system.checkServerTrusted(chain, authType)
        if (TransportPins.trusts(leaf.encoded)) return
        system.checkServerTrusted(chain, authType)
    }

    override fun checkClientTrusted(chain: Array<out X509Certificate>, authType: String) = system.checkClientTrusted(chain, authType)

    override fun getAcceptedIssuers(): Array<X509Certificate> = system.acceptedIssuers
}
