package riffet.shared

import io.ktor.client.request.url
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import riffet.contracts.StatsBreakdown
import riffet.contracts.StatsDashboard
import riffet.contracts.StatsHeatmap
import riffet.contracts.StatsLatency
import riffet.contracts.StatsRunsPage
import riffet.contracts.StatsSeries

// RiffetApi endpoints — usage statistics. Transport and auth rules: see RiffetApi.kt.

/** `GET /api/stats/dashboard`: everything the first paint needs. */
@Throws(Exception::class)
suspend fun RiffetApi.statsDashboard(query: List<Pair<String, String>> = emptyList()): StatsDashboard =
    get("/api/stats/dashboard", query).decode()

/** `GET /api/stats/series`. `query` already includes metric, granularity and split. */
@Throws(Exception::class)
suspend fun RiffetApi.statsSeries(query: List<Pair<String, String>>): StatsSeries =
    get("/api/stats/series", query).decode()

/** `GET /api/stats/breakdown`. `query` already includes `dimension`. */
@Throws(Exception::class)
suspend fun RiffetApi.statsBreakdown(query: List<Pair<String, String>>): StatsBreakdown =
    get("/api/stats/breakdown", query).decode()

/** `GET /api/stats/latency`. `dimension` is `model` or `backend`. */
@Throws(Exception::class)
suspend fun RiffetApi.statsLatency(query: List<Pair<String, String>>): StatsLatency =
    get("/api/stats/latency", query).decode()

/** `GET /api/stats/heatmap`. */
@Throws(Exception::class)
suspend fun RiffetApi.statsHeatmap(query: List<Pair<String, String>>): StatsHeatmap =
    get("/api/stats/heatmap", query).decode()

/** `GET /api/stats/runs`. `query` may include `cursor` and `limit`. */
@Throws(Exception::class)
suspend fun RiffetApi.statsRuns(query: List<Pair<String, String>>): StatsRunsPage =
    get("/api/stats/runs", query).decode()

/**
 * `GET /api/stats/stream`. Frames are `{ "type": "stats_changed" }` hints; the caller refetches.
 * Reconnects the same way as [nativeStream], and only while the returned flow is collected.
 */
fun RiffetApi.statsStream(): StatsStreamSession = StatsStreamSource(
    http = http,
    url = "$baseUrl/api/stats/stream",
    tokenProvider = tokenProvider,
    config = config,
).open()

/**
 * `GET /api/stats/export` with [query]'s filters and `format` (`csv` or `json`): the server's
 * file, named the way its `Content-Disposition` names it.
 */
@Throws(Exception::class)
suspend fun RiffetApi.exportStats(query: List<Pair<String, String>>): ExportedText {
    val response = get("/api/stats/export", query)
    val name = response.headers[HttpHeaders.ContentDisposition]?.let(::dispositionFileName)
    return ExportedText(name, response.bodyAsText())
}
