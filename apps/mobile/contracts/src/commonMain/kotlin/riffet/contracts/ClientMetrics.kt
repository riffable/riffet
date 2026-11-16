package riffet.contracts

import kotlinx.serialization.Serializable

/*
 * A client's own resource figures for the service monitor (`packages/contracts/src/service-monitor.ts`,
 * docs/guide/performance.md §4). Numbers and cache names only.
 */

/** One registered cache: what it holds now and its ceiling. */
@Serializable
data class ClientCacheSample(
    val name: String,
    val bytes: Long? = null,
    val limitBytes: Long? = null,
    val count: Long? = null,
)

/** The figures at one moment; `at` is set by the server. */
@Serializable
data class ClientMetricsSample(
    val at: Long = 0,
    val footprintBytes: Long? = null,
    val managedHeapBytes: Long? = null,
    val streams: Int? = null,
    val hitches: Int? = null,
    val caches: List<ClientCacheSample>? = null,
)

/** `POST /api/system/client-metrics`. `platform` is `mac`, `ios` or `android`. */
@Serializable
data class ClientMetricsReport(
    val clientId: String,
    val platform: String,
    val appVersion: String? = null,
    val sample: ClientMetricsSample,
)

/** A client as `GET /api/system/monitor` lists it. */
@Serializable
data class ClientMetrics(
    val key: String,
    val platform: String,
    val name: String? = null,
    val appVersion: String? = null,
    val latest: ClientMetricsSample,
    val peakFootprintBytes: Long? = null,
    val series: List<ClientMetricsSample> = emptyList(),
)
