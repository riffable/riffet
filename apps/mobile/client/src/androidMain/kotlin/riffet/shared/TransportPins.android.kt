package riffet.shared

import io.ktor.client.HttpClient
import io.ktor.client.HttpClientConfig
import io.ktor.client.engine.okhttp.OkHttp
import java.security.KeyStore
import java.security.cert.X509Certificate
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

internal actual fun platformHttpClient(block: HttpClientConfig<*>.() -> Unit): HttpClient = HttpClient(OkHttp) {
    engine {
        config {
            val trust = PinnedTrustManager(systemTrustManager())
            val context = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
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
