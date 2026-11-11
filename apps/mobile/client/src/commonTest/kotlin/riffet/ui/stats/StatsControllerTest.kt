package riffet.ui.stats

import riffet.ui.settings.settle
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockEngineConfig
import io.ktor.client.engine.mock.MockRequestHandleScope
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.client.request.HttpResponseData
import io.ktor.http.HttpHeaders
import io.ktor.http.headersOf
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import riffet.cache.InMemoryLocalFiles
import riffet.contracts.StatsBreakdown
import riffet.contracts.StatsDashboard
import riffet.contracts.StatsDimension
import riffet.contracts.StatsFilter
import riffet.contracts.StatsGranularity
import riffet.contracts.StatsHeatmap
import riffet.contracts.StatsLatency
import riffet.contracts.StatsOptions
import riffet.contracts.StatsRunStates
import riffet.contracts.StatsSeries
import riffet.contracts.StatsSeriesMetric
import riffet.contracts.StatsSplit
import riffet.contracts.StatsSummary
import riffet.contracts.StatsTokens
import riffet.contracts.StatsTotals
import riffet.contracts.RiffetJson
import riffet.shared.RiffetApi
import riffet.shared.installRiffetClient
import riffet.stats.StatsDashboardCache
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class StatsControllerTest {
    private val headers = headersOf(HttpHeaders.ContentType, "application/json")

    @Test
    fun `a changed query keeps the successful dashboard query until its replacement loads`() = runTest {
        val changedDashboardStarted = CompletableDeferred<Unit>()
        val releaseChangedDashboard = CompletableDeferred<Unit>()
        val latencyBackends = mutableListOf<String?>()
        val seriesBackends = mutableListOf<String?>()
        var holdCodexDashboard = false
        val dispatcher = UnconfinedTestDispatcher(testScheduler)
        val client = client(dispatcher) { request ->
            when (request.url.encodedPath) {
                "/api/stats/dashboard" -> {
                    if (holdCodexDashboard && request.url.parameters["backend"] == "codex") {
                        changedDashboardStarted.complete(Unit)
                        releaseChangedDashboard.await()
                    }
                    respond(dashboardJson(), headers = headers)
                }
                "/api/stats/latency" -> {
                    latencyBackends += request.url.parameters["backend"]
                    respond(latencyJson(), headers = headers)
                }
                "/api/stats/series" -> {
                    seriesBackends += request.url.parameters["backend"]
                    respond(seriesJson(StatsGranularity.HOUR), headers = headers)
                }
                else -> error("unexpected stats request: ${request.url.encodedPath}")
            }
        }
        val controller = controller(RiffetApi(client, "http://127.0.0.1:9"), dispatcher)

        controller.refresh()
        settle()
        val oldQuery = assertNotNull(controller.state.value.activeQuery)
        controller.loadLatency()
        controller.loadSeries(StatsGranularity.HOUR)
        settle()
        assertNotNull(controller.state.value.latency)
        assertNotNull(controller.state.value.detailSeries)

        holdCodexDashboard = true
        controller.toggleBackend("codex")
        changedDashboardStarted.await()
        assertEquals(oldQuery, controller.state.value.activeQuery, "the visible query remains paired with the old dashboard while the new read is pending")
        assertNull(controller.state.value.detailSeries, "series for the old filter must not survive a filter change")
        assertNull(controller.state.value.latency, "latency for the old filter must not survive a filter change")
        assertFalse(controller.state.value.seriesLoading)
        assertFalse(controller.state.value.latencyLoading)
        controller.loadSeries(StatsGranularity.HOUR)
        controller.loadLatency()
        assertEquals(listOf<String?>(null), seriesBackends, "a newly opened detail page must wait for the matching dashboard")
        assertEquals(listOf<String?>(null), latencyBackends, "a newly opened detail page must wait for the matching dashboard")

        releaseChangedDashboard.complete(Unit)
        settle()
        val newQuery = assertNotNull(controller.state.value.activeQuery)
        assertEquals(listOf("codex"), newQuery.backends)
        controller.loadLatency()
        controller.loadSeries(StatsGranularity.HOUR)
        settle()
        assertEquals(listOf<String?>(null, "codex"), latencyBackends)
        assertEquals(listOf<String?>(null, "codex"), seriesBackends)
        client.close()
    }

    @Test
    fun `a same query refresh keeps detail data visible`() = runTest {
        val dashboardRefreshStarted = CompletableDeferred<Unit>()
        val releaseDashboardRefresh = CompletableDeferred<Unit>()
        var holdRefresh = false
        val dispatcher = UnconfinedTestDispatcher(testScheduler)
        val client = client(dispatcher) { request ->
            when (request.url.encodedPath) {
                "/api/stats/dashboard" -> {
                    if (holdRefresh) {
                        dashboardRefreshStarted.complete(Unit)
                        releaseDashboardRefresh.await()
                    }
                    respond(dashboardJson(), headers = headers)
                }
                "/api/stats/latency" -> respond(latencyJson(), headers = headers)
                "/api/stats/series" -> respond(seriesJson(StatsGranularity.HOUR), headers = headers)
                else -> error("unexpected stats request: ${request.url.encodedPath}")
            }
        }
        val controller = controller(RiffetApi(client, "http://127.0.0.1:9"), dispatcher)

        controller.refresh()
        settle()
        controller.loadLatency()
        controller.loadSeries(StatsGranularity.HOUR)
        settle()
        val previousLatency = assertNotNull(controller.state.value.latency)
        val previousSeries = assertNotNull(controller.state.value.detailSeries)

        holdRefresh = true
        controller.refresh()
        dashboardRefreshStarted.await()
        assertSame(previousLatency, controller.state.value.latency)
        assertSame(previousSeries, controller.state.value.detailSeries)
        assertTrue(controller.state.value.refreshing)

        releaseDashboardRefresh.complete(Unit)
        settle()
        assertSame(previousLatency, controller.state.value.latency)
        assertSame(previousSeries, controller.state.value.detailSeries)
        client.close()
    }

    @Test
    fun `cancelling a detail request cannot clear the replacement loading state`() = runTest {
        val firstSeriesStarted = CompletableDeferred<Unit>()
        val firstSeriesGate = CompletableDeferred<Unit>()
        val secondSeriesStarted = CompletableDeferred<Unit>()
        val releaseSecondSeries = CompletableDeferred<Unit>()
        val firstLatencyStarted = CompletableDeferred<Unit>()
        val firstLatencyGate = CompletableDeferred<Unit>()
        val secondLatencyStarted = CompletableDeferred<Unit>()
        val releaseSecondLatency = CompletableDeferred<Unit>()
        var seriesCalls = 0
        var latencyCalls = 0
        val dispatcher = UnconfinedTestDispatcher(testScheduler)
        val client = client(dispatcher) { request ->
            when (request.url.encodedPath) {
                "/api/stats/dashboard" -> respond(dashboardJson(), headers = headers)
                "/api/stats/series" -> {
                    seriesCalls++
                    if (seriesCalls == 1) {
                        firstSeriesStarted.complete(Unit)
                        firstSeriesGate.await()
                    }
                    else {
                        secondSeriesStarted.complete(Unit)
                        releaseSecondSeries.await()
                    }
                    respond(seriesJson(granularityFromWire(request.url.parameters["granularity"])), headers = headers)
                }
                "/api/stats/latency" -> {
                    latencyCalls++
                    if (latencyCalls == 1) {
                        firstLatencyStarted.complete(Unit)
                        firstLatencyGate.await()
                    }
                    else {
                        secondLatencyStarted.complete(Unit)
                        releaseSecondLatency.await()
                    }
                    respond(latencyJson(), headers = headers)
                }
                else -> error("unexpected stats request: ${request.url.encodedPath}")
            }
        }
        val controller = controller(RiffetApi(client, "http://127.0.0.1:9"), dispatcher)

        controller.refresh()
        settle()

        controller.loadSeries(StatsGranularity.HOUR)
        firstSeriesStarted.await()
        controller.loadSeries(StatsGranularity.WEEK)
        secondSeriesStarted.await()
        assertTrue(controller.state.value.seriesLoading, "the cancelled request's finally block must not clear the replacement request's loading state")
        releaseSecondSeries.complete(Unit)
        settle()
        assertFalse(controller.state.value.seriesLoading)
        assertNotNull(controller.state.value.detailSeries)

        controller.loadLatency()
        firstLatencyStarted.await()
        controller.loadLatency()
        secondLatencyStarted.await()
        assertTrue(controller.state.value.latencyLoading, "the cancelled request's finally block must not clear the replacement request's loading state")
        releaseSecondLatency.complete(Unit)
        settle()
        assertFalse(controller.state.value.latencyLoading)
        assertNotNull(controller.state.value.latency)
        client.close()
    }

    private fun client(
        dispatcher: CoroutineDispatcher,
        handler: suspend MockRequestHandleScope.(HttpRequestData) -> HttpResponseData,
    ) = HttpClient(MockEngine(MockEngineConfig().apply {
        this.dispatcher = dispatcher
        addHandler(handler)
    })) { installRiffetClient() }

    private fun controller(api: RiffetApi, dispatcher: CoroutineDispatcher) = StatsController(
        api = api,
        cache = StatsDashboardCache(InMemoryLocalFiles()),
        scope = CoroutineScope(dispatcher),
        zoneId = { "UTC" },
        now = { 1_791_000_000_000L },
        offset = { 0L },
        cacheDispatcher = dispatcher,
    )

    private fun dashboardJson(): String = RiffetJson.instance.encodeToString(
        StatsDashboard.serializer(),
        StatsDashboard(
            filter = StatsFilter(from = "2026-10-01T00:00:00.000Z", to = "2026-11-01T00:00:00.000Z", tz = "UTC"),
            generatedAt = "2026-10-08T12:34:56.000Z",
            summary = StatsSummary(
                current = totals(),
                previous = totals(),
                streakDays = 0,
            ),
            series = StatsSeries(
                metric = StatsSeriesMetric.TOTAL_TOKENS,
                granularity = StatsGranularity.DAY,
                split = StatsSplit.BACKEND,
                keys = emptyList(),
                points = emptyList(),
            ),
            backends = StatsBreakdown(StatsDimension.BACKEND, emptyList()),
            models = StatsBreakdown(StatsDimension.MODEL, emptyList()),
            tools = StatsBreakdown(StatsDimension.TOOL, emptyList()),
            heatmap = StatsHeatmap(weekHour = emptyList(), calendar = emptyList()),
            options = StatsOptions(emptyList(), emptyList(), emptyList(), emptyList()),
        ),
    )

    private fun seriesJson(granularity: StatsGranularity): String = RiffetJson.instance.encodeToString(
        StatsSeries.serializer(),
        StatsSeries(
            metric = StatsSeriesMetric.TOTAL_TOKENS,
            granularity = granularity,
            split = StatsSplit.BACKEND,
            keys = emptyList(),
            points = emptyList(),
        ),
    )

    private fun granularityFromWire(value: String?) = when (value) {
        "hour" -> StatsGranularity.HOUR
        "week" -> StatsGranularity.WEEK
        "month" -> StatsGranularity.MONTH
        else -> StatsGranularity.DAY
    }

    private fun latencyJson(): String = RiffetJson.instance.encodeToString(
        StatsLatency.serializer(),
        StatsLatency(dimension = "model", rows = emptyList()),
    )

    private fun totals() = StatsTotals(
        sessions = 0,
        runs = 0,
        states = StatsRunStates(completed = 0, failed = 0, cancelled = 0, interrupted = 0),
        activeDays = 0,
        tokens = StatsTokens(estimatedOutput = 0),
        totalTokens = 0,
        toolCalls = 0,
        subagents = 0,
    )
}
