package riffet.ui.stats

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.IO
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import riffet.contracts.StatsDashboard
import riffet.contracts.StatsGranularity
import riffet.contracts.StatsLatency
import riffet.contracts.StatsSeries
import riffet.contracts.StatsSeriesMetric
import riffet.contracts.StatsSplit
import riffet.shared.RiffetApi
import riffet.shared.RiffetUnauthenticatedException
import riffet.stats.StatsDashboardCache
import riffet.stats.StatsQuery
import riffet.stats.StatsRange
import riffet.stats.formatIsoUtc
import riffet.stats.statsDimensionParameters
import riffet.stats.statsQueryParameters
import riffet.i18n.L10n
import riffet.stats.statsRangeBounds
import riffet.stats.statsSeriesParameters
import riffet.shared.statsDashboard
import riffet.shared.statsLatency
import riffet.shared.statsSeries

/** Refetch at most this often when `stats_changed` arrives in a burst. */
private const val THROTTLE_MS = 1_500L

/** Everything the stats page renders. [dashboard] and [activeQuery] always change together. */
data class StatsState(
    val range: StatsRange = StatsRange.MONTH,
    val backends: Set<String> = emptySet(),
    val includeEstimated: Boolean = true,
    val dashboard: StatsDashboard? = null,
    /** Query paired with the last network-loaded dashboard. Cached dashboards have no query. */
    val activeQuery: StatsQuery? = null,
    val refreshing: Boolean = false,
    val offline: Boolean = false,
    val error: String? = null,
    val detailSeries: StatsSeries? = null,
    val seriesLoading: Boolean = false,
    val seriesError: String? = null,
    val latency: StatsLatency? = null,
    val latencyLoading: Boolean = false,
    val latencyError: String? = null,
)

/**
 * The stats page's reads. The dashboard is one request; a granularity change and the performance
 * tab ask for series and latency on top of it. The last dashboard is kept on disk so a failed
 * refresh still has something to show.
 */
class StatsController(
    private val api: RiffetApi,
    private val cache: StatsDashboardCache,
    private val scope: CoroutineScope,
    private val zoneId: () -> String,
    private val now: () -> Long,
    private val offset: (Long) -> Long,
    private val cacheDispatcher: CoroutineDispatcher = Dispatchers.IO,
) {
    private val _state = MutableStateFlow(StatsState())
    val state: StateFlow<StatsState> = _state.asStateFlow()

    private var ticket = 0
    private var loadJob: Job? = null
    private var pending: Job? = null
    private var seriesJob: Job? = null
    private var latencyJob: Job? = null
    private var seriesRequest = 0
    private var latencyRequest = 0
    private var requestedQuery: StatsQuery? = null
    private var lastRefresh = 0L

    private val activeQuery: StatsQuery? get() = _state.value.activeQuery

    fun chooseRange(next: StatsRange) {
        if (next == _state.value.range) return
        _state.update { it.copy(range = next) }
        refresh()
    }

    fun toggleBackend(id: String) {
        _state.update { it.copy(backends = if (id in it.backends) it.backends - id else it.backends + id) }
        refresh()
    }

    fun toggleEstimated() {
        _state.update { it.copy(includeEstimated = !it.includeEstimated) }
        refresh()
    }

    fun refresh() {
        val query = currentQuery()
        requestedQuery = query
        if (query != activeQuery) clearDetails()
        lastRefresh = now()
        pending?.cancel()
        pending = null
        val mine = ++ticket
        loadJob?.cancel()
        loadJob = scope.launch { loadDashboard(mine, query) }
    }

    /** Leading-edge throttle: the first hint refreshes now, a burst keeps one trailing refresh. */
    fun noteChanged() {
        val elapsed = now() - lastRefresh
        if (elapsed >= THROTTLE_MS) refresh()
        else if (pending?.isActive != true) {
            pending = scope.launch {
                delay(THROTTLE_MS - elapsed)
                refresh()
            }
        }
    }

    fun loadSeries(granularity: StatsGranularity) {
        val current = _state.value.dashboard
        val query = activeQuery
        if (current == null || query == null || query != requestedQuery) return
        if (current.series.granularity == granularity &&
            current.series.metric == StatsSeriesMetric.TOTAL_TOKENS &&
            current.series.split == StatsSplit.BACKEND
        ) {
            clearSeries()
            return
        }
        val request = ++seriesRequest
        seriesJob?.cancel()
        _state.update { it.copy(seriesLoading = true, seriesError = null) }
        seriesJob = scope.launch {
            try {
                val result = api.statsSeries(
                    statsSeriesParameters(query, StatsSeriesMetric.TOTAL_TOKENS, granularity, StatsSplit.BACKEND),
                )
                if (request == seriesRequest && activeQuery == query) _state.update { it.copy(detailSeries = result) }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (failure: Throwable) {
                if (request == seriesRequest && activeQuery == query) {
                    _state.update { it.copy(seriesError = failure.message?.takeIf { message -> message.isNotBlank() } ?: L10n.uiText("stats.error.trend")) }
                }
            } finally {
                if (request == seriesRequest) _state.update { it.copy(seriesLoading = false) }
            }
        }
    }

    fun loadLatency() {
        if (_state.value.dashboard == null) return
        val query = activeQuery ?: return
        if (query != requestedQuery) return
        val request = ++latencyRequest
        latencyJob?.cancel()
        _state.update { it.copy(latencyLoading = true, latencyError = null) }
        latencyJob = scope.launch {
            try {
                val result = api.statsLatency(statsDimensionParameters(query, "model"))
                if (request == latencyRequest && activeQuery == query) _state.update { it.copy(latency = result) }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (failure: Throwable) {
                if (request == latencyRequest && activeQuery == query) {
                    _state.update { it.copy(latencyError = failure.message?.takeIf { message -> message.isNotBlank() } ?: L10n.uiText("stats.error.performance")) }
                }
            } finally {
                if (request == latencyRequest) _state.update { it.copy(latencyLoading = false) }
            }
        }
    }

    private fun clearDetails() {
        clearSeries()
        clearLatency()
    }

    private fun clearSeries() {
        ++seriesRequest
        seriesJob?.cancel()
        seriesJob = null
        _state.update { it.copy(detailSeries = null, seriesLoading = false, seriesError = null) }
    }

    private fun clearLatency() {
        ++latencyRequest
        latencyJob?.cancel()
        latencyJob = null
        _state.update { it.copy(latency = null, latencyLoading = false, latencyError = null) }
    }

    private fun currentQuery(): StatsQuery {
        val nowMillis = now()
        val current = _state.value
        val (from, to) = statsRangeBounds(current.range, nowMillis, offset(nowMillis))
        return StatsQuery(
            from = formatIsoUtc(from),
            to = formatIsoUtc(to),
            tz = zoneId(),
            backends = current.backends.toList(),
            includeEstimated = current.includeEstimated,
        )
    }

    private suspend fun loadDashboard(mine: Int, query: StatsQuery) {
        if (_state.value.dashboard == null) {
            val cached = withContext(cacheDispatcher) { cache.load() }
            if (mine == ticket && _state.value.dashboard == null && cached != null) {
                _state.update { it.copy(dashboard = cached, activeQuery = null) }
            }
        }
        _state.update { it.copy(refreshing = true) }
        try {
            val loaded = api.statsDashboard(statsQueryParameters(query))
            if (mine != ticket) return
            if (query != activeQuery) clearDetails()
            _state.update { it.copy(dashboard = loaded, activeQuery = query, offline = false, error = null) }
            withContext(cacheDispatcher) { cache.save(loaded) }
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (failure: Throwable) {
            if (mine != ticket) return
            val message = when (failure) {
                is RiffetUnauthenticatedException -> L10n.uiText("stats.error.signIn")
                else -> failure.message?.takeIf { it.isNotBlank() } ?: L10n.uiText("stats.error.all")
            }
            _state.update { it.copy(offline = it.offline || it.dashboard != null, error = message) }
        } finally {
            if (mine == ticket) _state.update { it.copy(refreshing = false) }
        }
    }
}
