package riffet.shared

import io.ktor.client.HttpClient
import io.ktor.client.HttpClientConfig

/** Desktop JVM builds are tools and tests; they use whatever engine is on the classpath, without pins. */
internal actual val presentsDeviceCertificate: Boolean = false

internal actual fun platformHttpClient(block: HttpClientConfig<*>.() -> Unit): HttpClient = HttpClient { block() }
