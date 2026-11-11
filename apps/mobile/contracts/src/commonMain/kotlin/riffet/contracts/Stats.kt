package riffet.contracts

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/*
 * Usage statistics, ported from the `Stats*` types at the end of packages/contracts/src/index.ts.
 * The server computes every aggregate; this file only names the wire. docs/STATS.md §5 and
 * docs/MOBILE.md ("契约：手写 DTO + golden fixture") are why these are written by hand.
 *
 * A TS `T | null` stays nullable. A TS `?` also gets `= null`, so a missing key and an explicit
 * null decode to the same value under [RiffetJson]. A token total of null means the source never
 * reported that field — it must not be read as zero.
 */

@Serializable
enum class StatsGranularity {
    @SerialName("hour") HOUR,
    @SerialName("day") DAY,
    @SerialName("week") WEEK,
    @SerialName("month") MONTH,
}

@Serializable
enum class StatsDimension {
    @SerialName("backend") BACKEND,
    @SerialName("model") MODEL,
    @SerialName("profile") PROFILE,
    @SerialName("project") PROJECT,
    @SerialName("mode") MODE,
    @SerialName("tool") TOOL,
}

@Serializable
enum class StatsSplit {
    @SerialName("backend") BACKEND,
    @SerialName("model") MODEL,
    @SerialName("project") PROJECT,
}

@Serializable
enum class StatsAgentKind {
    @SerialName("main") MAIN,
    @SerialName("subagent") SUBAGENT,
    @SerialName("all") ALL,
}

/** `totalTokens` counts only the parts a record actually reported. */
@Serializable
enum class StatsSeriesMetric {
    @SerialName("totalTokens") TOTAL_TOKENS,
    @SerialName("inputTokens") INPUT_TOKENS,
    @SerialName("outputTokens") OUTPUT_TOKENS,
    @SerialName("cacheReadTokens") CACHE_READ_TOKENS,
    @SerialName("runs") RUNS,
    @SerialName("sessions") SESSIONS,
    @SerialName("durationMs") DURATION_MS,
}

/** The filter the server applied. `to` is exclusive. */
@Serializable
data class StatsFilter(
    val from: String,
    val to: String,
    val tz: String,
    val backends: List<NativeBackendId>? = null,
    val models: List<String>? = null,
    val projects: List<String>? = null,
    val profiles: List<String>? = null,
    val agentKind: StatsAgentKind? = null,
    val includeArchived: Boolean? = null,
    val includeEstimated: Boolean? = null,
)

/**
 * Token totals. `input` is the part that missed the cache. A field is null when no record in the
 * aggregate reported it (Cursor never reports input), never when the true value is zero.
 * `estimatedOutput` is the part of `output` that was estimated from text; zero means none of it was.
 */
@Serializable
data class StatsTokens(
    val input: Long? = null,
    val cacheRead: Long? = null,
    val cacheWrite: Long? = null,
    val output: Long? = null,
    val reasoning: Long? = null,
    val estimatedOutput: Long,
)

@Serializable
data class StatsRunStates(
    val completed: Long,
    val failed: Long,
    val cancelled: Long,
    val interrupted: Long,
)

/** Display identity of one group. `backendId` is set when the group belongs to a single backend. */
@Serializable
data class StatsKeyInfo(
    val key: String,
    val label: String,
    val backendId: NativeBackendId? = null,
    val agentId: String? = null,
) {
    val agent: String? get() = agentId ?: backendId?.let(AgentIds::wire)
}

@Serializable
data class StatsPercentiles(
    val p50: Double,
    val p90: Double,
    val p99: Double,
    val samples: Long,
)

@Serializable
data class StatsTotals(
    val sessions: Long,
    val runs: Long,
    val states: StatsRunStates,
    val activeDays: Long,
    val tokens: StatsTokens,
    val totalTokens: Long,
    val toolCalls: Long,
    val subagents: Long,
    /** cacheRead / (input + cacheRead) over records that reported both; null when none did. */
    val cacheHitRate: Double? = null,
    val ttftMs: StatsPercentiles? = null,
    val durationMs: StatsPercentiles? = null,
    val outputTokensPerSecond: StatsPercentiles? = null,
)

/** `previous` is the window of equal length immediately before `from`. */
@Serializable
data class StatsSummary(
    val current: StatsTotals,
    val previous: StatsTotals,
    val streakDays: Long,
)

@Serializable
data class StatsSeriesPoint(
    val start: String,
    val values: Map<String, Double>,
)

@Serializable
data class StatsSeries(
    val metric: StatsSeriesMetric,
    val granularity: StatsGranularity,
    val split: StatsSplit,
    val keys: List<StatsKeyInfo>,
    val points: List<StatsSeriesPoint>,
)

@Serializable
data class StatsBreakdownRow(
    val key: String,
    val label: String,
    val backendId: NativeBackendId? = null,
    /** Runs for every dimension except `tool`, where it is the number of calls. */
    val count: Long,
    val sessions: Long,
    val states: StatsRunStates,
    val tokens: StatsTokens,
    val totalTokens: Long,
    val share: Double,
    /** Tool dimension only: calls that reported a failure. */
    val failed: Long? = null,
    val durationMs: StatsPercentiles? = null,
    val outputTokensPerSecond: StatsPercentiles? = null,
    val agentId: String? = null,
) {
    val agent: String? get() = agentId ?: backendId?.let(AgentIds::wire)
}

@Serializable
data class StatsBreakdown(
    val dimension: StatsDimension,
    val rows: List<StatsBreakdownRow>,
)

@Serializable
data class StatsLatencyRow(
    val key: String,
    val label: String,
    val backendId: NativeBackendId? = null,
    val ttftMs: StatsPercentiles? = null,
    val durationMs: StatsPercentiles? = null,
    val queueMs: StatsPercentiles? = null,
    val outputTokensPerSecond: StatsPercentiles? = null,
    /** Measurement windows that contributed to `outputTokensPerSecond`. */
    val windows: List<MetricsWindow>,
    val agentId: String? = null,
) {
    val agent: String? get() = agentId ?: backendId?.let(AgentIds::wire)
}

@Serializable
data class StatsLatency(
    val dimension: String,
    val rows: List<StatsLatencyRow>,
)

@Serializable
data class StatsHeatmapDay(
    val date: String,
    val runs: Long,
    val totalTokens: Long,
)

/** `weekHour[weekday][hour]` counts runs, Monday first, in the requested zone. */
@Serializable
data class StatsHeatmap(
    val weekHour: List<List<Long>>,
    val calendar: List<StatsHeatmapDay>,
)

@Serializable
data class StatsRunRow(
    val runId: String,
    val sessionId: String,
    val sessionTitle: String,
    val projectId: String,
    val projectName: String,
    val backendId: NativeBackendId,
    val model: String? = null,
    val state: RunState,
    val createdAt: String,
    val durationMs: Long? = null,
    val ttftMs: Long? = null,
    val tokens: StatsTokens,
    val totalTokens: Long,
    val toolCalls: Long,
    val agentId: String? = null,
) {
    val agent: String get() = agentId ?: AgentIds.wire(backendId)
}

@Serializable
data class StatsRunsPage(
    val rows: List<StatsRunRow>,
    val nextCursor: String? = null,
)

/** Choices for the filter bar, drawn from all recorded data regardless of the current filter. */
@Serializable
data class StatsOptions(
    val backends: List<StatsKeyInfo>,
    val models: List<StatsKeyInfo>,
    val projects: List<StatsKeyInfo>,
    val profiles: List<StatsKeyInfo>,
)

/** Everything the first paint needs, so a phone makes one request. */
@Serializable
data class StatsDashboard(
    val filter: StatsFilter,
    val generatedAt: String,
    val summary: StatsSummary,
    val series: StatsSeries,
    val backends: StatsBreakdown,
    val models: StatsBreakdown,
    val tools: StatsBreakdown,
    val heatmap: StatsHeatmap,
    val options: StatsOptions,
)

/** One frame of `GET /api/stats/stream`: a hint to refetch, carrying no aggregate of its own. */
@Serializable
data class StatsStreamMessage(
    val type: String,
    val at: String,
)
