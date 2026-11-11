package riffet.shared

import android.annotation.TargetApi
import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The Android side of [ServerDiscovery], built on the framework `android.net.nsd.NsdManager`.
 *
 * `NsdManager` is framework API, so this adds no dependency (a camera/QR pass would; see the report).
 * The service type is `_riffet._tcp`, exactly what `apps/server/src/discovery.ts` publishes with
 * `bonjour-service`; the trailing dot is required by the NSD API.
 *
 * ## Listener lifecycle
 *
 * The framework rejects a second `stopServiceDiscovery` for the same listener, and a listener that
 * is never stopped leaks a registration and keeps the mDNS socket alive. So each `discover()` call
 * owns exactly one listener and stops it exactly once, through [stopOnce]:
 *
 *  - `onStartDiscoveryFailed` stops it immediately (the documented requirement when a start fails);
 *  - the `finally` around the browse stops it on every other path, including coroutine cancellation.
 *
 * A flag also gates resolution callbacks, which can arrive after the browse has ended.
 */
private class AndroidServerDiscovery(private val context: Context) : ServerDiscovery {

    override suspend fun discover(timeoutMillis: Long): List<DiscoveredServer> {
        val manager = context.getSystemService(NsdManager::class.java) ?: return emptyList()
        val found = CopyOnWriteArrayList<DiscoveredServer>()
        val active = AtomicBoolean(true)
        val stopped = AtomicBoolean(false)
        var listener: NsdManager.DiscoveryListener? = null

        fun stopOnce() {
            if (stopped.compareAndSet(false, true)) {
                active.set(false)
                listener?.let { runCatching { manager.stopServiceDiscovery(it) } }
            }
        }

        val discoveryListener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) = Unit

            override fun onServiceFound(serviceInfo: NsdServiceInfo) {
                if (active.get()) resolve(manager, serviceInfo, active) { found += it }
            }

            override fun onServiceLost(serviceInfo: NsdServiceInfo) = Unit

            override fun onDiscoveryStopped(serviceType: String) = Unit

            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) = stopOnce()

            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) = stopOnce()
        }
        listener = discoveryListener

        return try {
            manager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discoveryListener)
            // Best-effort: collect whatever arrived within the window, then stop regardless.
            delay(timeoutMillis.coerceIn(0L, MAX_TIMEOUT_MILLIS))
            found.distinctBy { it.host to it.port }.toList()
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (_: Throwable) {
            // No permission, no responder, or a malformed request all mean "found nothing".
            emptyList()
        } finally {
            stopOnce()
        }
    }

    private fun resolve(
        manager: NsdManager,
        info: NsdServiceInfo,
        active: AtomicBoolean,
        onResolved: (DiscoveredServer) -> Unit,
    ) {
        val callback = object : NsdManager.ResolveListener {
            override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) = Unit

            override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                if (!active.get()) return
                val rawHost = hostOf(serviceInfo) ?: return
                val port = serviceInfo.port
                if (port !in 1..65535) return
                val name = serviceInfo.serviceName?.takeIf { it.isNotBlank() } ?: rawHost
                onResolved(DiscoveredServer(name = name, host = hostForUrl(rawHost), port = port))
            }
        }
        @Suppress("DEPRECATION")
        runCatching { manager.resolveService(info, callback) }
    }

    /**
     * `getHost()` is the only accessor present on API 26–33; on API 34+ it is deprecated and the
     * address list is authoritative, so that path lives behind an API-level guard in [Api34Nsd].
     */
    private fun hostOf(info: NsdServiceInfo): String? {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return Api34Nsd.hostAddress(info)
        @Suppress("DEPRECATION")
        return info.host?.hostAddress
    }
}

private const val SERVICE_TYPE = "_riffet._tcp."
private const val MAX_TIMEOUT_MILLIS = 60_000L

/** An IPv6 literal is bracketed so the value can be embedded in `host:port` and a URL. */
private fun hostForUrl(raw: String): String =
    if (raw.contains(':') && !raw.startsWith("[")) "[$raw]" else raw

@TargetApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
private object Api34Nsd {
    fun hostAddress(info: NsdServiceInfo): String? = info.hostAddresses.firstOrNull()?.hostAddress
}

actual fun createServerDiscovery(): ServerDiscovery = AndroidServerDiscovery(RiffetAndroid.requireContext())
