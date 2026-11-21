package riffet.stats

import riffet.contracts.NativeBackendId
import riffet.contracts.StatsBreakdown
import riffet.contracts.StatsBreakdownRow
import riffet.contracts.StatsGranularity
import riffet.contracts.StatsHeatmapDay
import riffet.contracts.StatsKeyInfo
import riffet.contracts.StatsLatency
import riffet.contracts.StatsPercentiles
import riffet.contracts.StatsRunStates
import riffet.contracts.StatsSeries
import riffet.contracts.StatsSeriesMetric
import riffet.contracts.StatsSplit
import riffet.contracts.StatsSummary
import riffet.contracts.StatsTokens
import riffet.i18n.L10n
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.log10
import kotlin.math.pow
import kotlin.math.round

/** What a missing measurement looks like. A null token is this, never `0`. */
const val STATS_UNAVAILABLE = "—"

/** The ranges the stats page offers. [days] counts today, so 7 is six midnights back plus today. */
enum class StatsRange(val id: String, val days: Int) {
    TODAY("today", 1),
    WEEK("7", 7),
    MONTH("30", 30),
    QUARTER("90", 90),
    YEAR("365", 365),
    ;

    val label: String get() = when (this) {
        TODAY -> L10n.uiText("stats.range.today")
        WEEK -> L10n.uiText("stats.range.week")
        MONTH -> L10n.uiText("stats.range.month")
        QUARTER -> L10n.uiText("stats.range.quarter")
        YEAR -> L10n.uiText("stats.range.year")
    }
}

/** Query shared by every stats read. Repeatable filters stay lists so they can be empty. */
data class StatsQuery(
    val from: String,
    val to: String,
    val tz: String,
    val backends: List<String> = emptyList(),
    val models: List<String> = emptyList(),
    val projects: List<String> = emptyList(),
    val profiles: List<String> = emptyList(),
    val agentKind: String? = null,
    val includeArchived: Boolean? = null,
    val includeEstimated: Boolean? = null,
)

fun statsQueryParameters(query: StatsQuery): List<Pair<String, String>> = buildList {
    add("from" to query.from)
    add("to" to query.to)
    add("tz" to query.tz)
    query.backends.forEach { add("backend" to it) }
    query.models.forEach { add("model" to it) }
    query.projects.forEach { add("project" to it) }
    query.profiles.forEach { add("profile" to it) }
    query.agentKind?.let { add("agentKind" to it) }
    query.includeArchived?.let { add("includeArchived" to it.toString()) }
    query.includeEstimated?.let { add("includeEstimated" to it.toString()) }
}

fun statsSeriesParameters(
    query: StatsQuery,
    metric: StatsSeriesMetric,
    granularity: StatsGranularity,
    split: StatsSplit,
): List<Pair<String, String>> = statsQueryParameters(query) + listOf(
    "metric" to metric.wire(),
    "granularity" to granularity.wire(),
    "split" to split.wire(),
)

fun statsDimensionParameters(query: StatsQuery, dimension: String): List<Pair<String, String>> =
    statsQueryParameters(query) + ("dimension" to dimension)

fun statsRunsParameters(query: StatsQuery, cursor: String?, limit: Int?): List<Pair<String, String>> =
    statsQueryParameters(query) + buildList {
        if (!cursor.isNullOrEmpty()) add("cursor" to cursor)
        if (limit != null) add("limit" to limit.toString())
    }

fun StatsGranularity.wire(): String = when (this) {
    StatsGranularity.HOUR -> "hour"
    StatsGranularity.DAY -> "day"
    StatsGranularity.WEEK -> "week"
    StatsGranularity.MONTH -> "month"
}

fun StatsSeriesMetric.wire(): String = when (this) {
    StatsSeriesMetric.TOTAL_TOKENS -> "totalTokens"
    StatsSeriesMetric.INPUT_TOKENS -> "inputTokens"
    StatsSeriesMetric.OUTPUT_TOKENS -> "outputTokens"
    StatsSeriesMetric.CACHE_READ_TOKENS -> "cacheReadTokens"
    StatsSeriesMetric.RUNS -> "runs"
    StatsSeriesMetric.SESSIONS -> "sessions"
    StatsSeriesMetric.DURATION_MS -> "durationMs"
}

fun StatsSplit.wire(): String = when (this) {
    StatsSplit.BACKEND -> "backend"
    StatsSplit.MODEL -> "model"
    StatsSplit.PROJECT -> "project"
}

fun metricLabel(metric: StatsSeriesMetric): String = when (metric) {
    StatsSeriesMetric.TOTAL_TOKENS -> "Token"
    StatsSeriesMetric.INPUT_TOKENS -> L10n.uiText("stats.metric.input")
    StatsSeriesMetric.OUTPUT_TOKENS -> L10n.uiText("stats.metric.output")
    StatsSeriesMetric.CACHE_READ_TOKENS -> L10n.uiText("stats.metric.cacheRead")
    StatsSeriesMetric.RUNS -> L10n.uiText("stats.metric.runs")
    StatsSeriesMetric.SESSIONS -> L10n.uiText("stats.metric.sessions")
    StatsSeriesMetric.DURATION_MS -> L10n.uiText("stats.metric.duration")
}

/** The built-in agents, used before the dashboard has reported its own option list. */
fun defaultAgentOptions(): List<StatsKeyInfo> = listOf(
    StatsKeyInfo("claude", "Claude", NativeBackendId.CLAUDE),
    StatsKeyInfo("codex", "Codex", NativeBackendId.CODEX),
    StatsKeyInfo("antigravity", "Antigravity", NativeBackendId.ANTIGRAVITY),
    StatsKeyInfo("cursor", "Cursor", NativeBackendId.CURSOR),
    StatsKeyInfo("pi", "pi", NativeBackendId.PI),
    StatsKeyInfo("traex", "TRAE", NativeBackendId.TRAEX),
    StatsKeyInfo("droid", "Droid", NativeBackendId.DROID),
    StatsKeyInfo("dsh", "DeepSeek", NativeBackendId.DSH),
)

/**
 * Inclusive local start and exclusive local end, both as epoch millis.
 * [utcOffsetMillis] is the device offset at [nowMillis]; day length is a fixed 24h, matching
 * [riffet.ui.timeline.localDayStart].
 */
fun statsRangeBounds(range: StatsRange, nowMillis: Long, utcOffsetMillis: Long): Pair<Long, Long> {
    val startToday = localDayStartMillis(nowMillis, utcOffsetMillis)
    val from = startToday - (range.days - 1) * DAY_MS
    return from to (startToday + DAY_MS)
}

fun localDayStartMillis(epochMillis: Long, utcOffsetMillis: Long): Long {
    val local = epochMillis + utcOffsetMillis
    return local.floorDiv(DAY_MS) * DAY_MS - utcOffsetMillis
}

enum class KpiFormat { COUNT, PERCENT, MILLIS, SPEED }

data class KpiSpec(
    val label: String,
    val raw: Double?,
    val text: String,
    val format: KpiFormat,
    val delta: Double?,
    val lowerIsBetter: Boolean,
    val footnote: String? = null,
)

/** Compared with the previous window of the same length. Null when either side was not measured. */
data class PeriodDelta(val fraction: Double?)

enum class DeltaPolarity { FAVORABLE, UNFAVORABLE, FLAT, UNKNOWN }

fun periodDelta(current: Double, previous: Double): PeriodDelta {
    if (!current.isFinite() || !previous.isFinite()) return PeriodDelta(null)
    if (previous == 0.0) return PeriodDelta(if (current == 0.0) 0.0 else null)
    return PeriodDelta((current - previous) / abs(previous))
}

/** [lowerIsBetter] flips latency: a drop is favorable. */
fun deltaPolarity(fraction: Double?, lowerIsBetter: Boolean): DeltaPolarity {
    if (fraction == null || !fraction.isFinite()) return DeltaPolarity.UNKNOWN
    if (abs(fraction) < 0.0005) return DeltaPolarity.FLAT
    val favorable = if (lowerIsBetter) fraction < 0 else fraction > 0
    return if (favorable) DeltaPolarity.FAVORABLE else DeltaPolarity.UNFAVORABLE
}

fun successRate(states: StatsRunStates): Double? {
    val total = states.completed + states.failed + states.cancelled + states.interrupted
    if (total <= 0L) return null
    return states.completed.toDouble() / total.toDouble()
}

fun containsEstimate(tokens: StatsTokens): Boolean = tokens.estimatedOutput > 0

fun overviewKpis(summary: StatsSummary): List<KpiSpec> {
    val current = summary.current
    val previous = summary.previous
    val notes = buildList {
        if (containsEstimate(current.tokens)) add(L10n.uiText("stats.kpi.includesEstimate"))
        if (current.tokens.input == null) add(L10n.uiText("stats.kpi.inputUnavailable"))
    }
    return listOf(
        countKpi(L10n.uiText("stats.kpi.totalTokens"), current.totalTokens, previous.totalTokens, footnote = notes.joinToString(" · ").ifBlank { null }),
        countKpi(L10n.uiText("stats.kpi.runs"), current.runs, previous.runs),
        countKpi(L10n.uiText("stats.kpi.sessions"), current.sessions, previous.sessions),
        countKpi(L10n.uiText("stats.kpi.activeDays"), current.activeDays, previous.activeDays),
        KpiSpec(
            label = L10n.uiText("stats.kpi.streak"),
            raw = summary.streakDays.toDouble(),
            text = formatKpi(KpiFormat.COUNT, summary.streakDays.toDouble()),
            format = KpiFormat.COUNT,
            delta = null,
            lowerIsBetter = false,
        ),
        optionalKpi(L10n.uiText("stats.kpi.cacheHitRate"), current.cacheHitRate, previous.cacheHitRate, KpiFormat.PERCENT, lowerIsBetter = false),
        optionalKpi(L10n.uiText("stats.kpi.ttft"), current.ttftMs?.p50, previous.ttftMs?.p50, KpiFormat.MILLIS, lowerIsBetter = true),
        optionalKpi(
            L10n.uiText("stats.kpi.outputSpeed"),
            current.outputTokensPerSecond?.p50,
            previous.outputTokensPerSecond?.p50,
            KpiFormat.SPEED,
            lowerIsBetter = false,
        ),
        optionalKpi(L10n.uiText("stats.kpi.successRate"), successRate(current.states), successRate(previous.states), KpiFormat.PERCENT, lowerIsBetter = false),
    )
}

fun dashboardIsEmpty(summary: StatsSummary, series: StatsSeries): Boolean {
    if (summary.current.runs > 0L || summary.current.sessions > 0L || summary.current.totalTokens > 0L) return false
    return series.points.all { point -> point.values.values.all { it == 0.0 } }
}

data class SeriesTrack(
    val key: String,
    val label: String,
    val backendId: NativeBackendId?,
    val values: List<Double>,
)

/**
 * One track per series key. A missing key in a point is a bucket with no usage (drawn as zero).
 * That is not the same as a null token field, which is omitted from the chart entirely.
 */
fun seriesTracks(series: StatsSeries): List<SeriesTrack> = series.keys.map { key ->
    SeriesTrack(
        key = key.key,
        label = key.label.ifBlank { key.key },
        backendId = key.backendId,
        values = series.points.map { point -> point.values[key.key] ?: 0.0 },
    )
}

data class NamedValue(
    val key: String,
    val label: String,
    val value: Double,
    val backendId: NativeBackendId?,
)

fun rankedBars(rows: List<StatsBreakdownRow>, byCount: Boolean, limit: Int = 8): List<NamedValue> =
    rows.map { row ->
        val value = if (byCount) row.count.toDouble() else {
            if (rows.any { it.totalTokens > 0L }) row.totalTokens.toDouble() else row.count.toDouble()
        }
        NamedValue(row.key, row.label.ifBlank { row.key }, value, row.backendId)
    }.sortedByDescending { it.value }.take(limit)

fun donutWeights(rows: List<StatsBreakdownRow>): List<NamedValue> = rankedBars(rows, byCount = false, limit = rows.size)

enum class LatencyMetric(val id: String) {
    TTFT("ttft"),
    DURATION("duration"),
    SPEED("speed"),
    ;

    val label: String get() = when (this) {
        TTFT -> L10n.uiText("stats.latency.ttft")
        DURATION -> L10n.uiText("stats.latency.duration")
        SPEED -> L10n.uiText("stats.latency.speed")
    }
}

data class LatencyMark(
    val key: String,
    val label: String,
    val backendId: NativeBackendId?,
    val low: Double?,
    val high: Double?,
    val mark: Double?,
)

fun latencyMarks(latency: StatsLatency, metric: LatencyMetric): List<LatencyMark> = latency.rows.map { row ->
    val band = when (metric) {
        LatencyMetric.TTFT -> row.ttftMs
        LatencyMetric.DURATION -> row.durationMs
        LatencyMetric.SPEED -> row.outputTokensPerSecond
    }
    LatencyMark(row.key, row.label.ifBlank { row.key }, row.backendId, band?.p50, band?.p90, band?.p99)
}

/** Highest p99, so every tick shares one scale. Null bands are skipped rather than treated as zero. */
fun latencyDomain(marks: List<LatencyMark>): Double {
    val top = marks.mapNotNull { it.mark ?: it.high ?: it.low }.maxOrNull() ?: return 1.0
    return if (top > 0) top else 1.0
}

data class ReliabilityRow(
    val key: String,
    val label: String,
    val backendId: NativeBackendId?,
    val completed: Long,
    val failed: Long,
    val cancelled: Long,
    val interrupted: Long,
)

fun reliabilityRows(breakdown: StatsBreakdown): List<ReliabilityRow> = breakdown.rows.map { row ->
    ReliabilityRow(
        key = row.key,
        label = row.label.ifBlank { row.key },
        backendId = row.backendId,
        completed = row.states.completed,
        failed = row.states.failed,
        cancelled = row.states.cancelled,
        interrupted = row.states.interrupted,
    )
}

data class CalendarCell(val date: String?, val runs: Long, val totalTokens: Long, val level: Int)

/** Weeks of seven cells, Monday first. Days the payload skipped are empty cells, not zeros drawn as data. */
fun calendarGrid(days: List<StatsHeatmapDay>, steps: Int = 4): List<List<CalendarCell>> {
    val parsed = days.mapNotNull { day ->
        val parts = day.date.split("-")
        if (parts.size != 3) return@mapNotNull null
        val year = parts[0].toIntOrNull() ?: return@mapNotNull null
        val month = parts[1].toIntOrNull() ?: return@mapNotNull null
        val dayOfMonth = parts[2].toIntOrNull() ?: return@mapNotNull null
        val epochDay = daysFromCivil(year, month, dayOfMonth)
        epochDay to day
    }.sortedBy { it.first }
    if (parsed.isEmpty()) return emptyList()
    val maxTokens = parsed.maxOf { it.second.totalTokens }
    val maxRuns = parsed.maxOf { it.second.runs }
    val byDay = parsed.associate { it.first to it.second }
    val first = parsed.first().first
    val last = parsed.last().first
    val start = first - weekdayMonday(first)
    val end = last + (6 - weekdayMonday(last))
    val cells = (start..end).map { epochDay ->
        val hit = byDay[epochDay]
        if (hit == null) CalendarCell(null, 0L, 0L, 0)
        else {
            val weight = if (maxTokens > 0L) hit.totalTokens else hit.runs
            val max = if (maxTokens > 0L) maxTokens else maxRuns
            CalendarCell(hit.date, hit.runs, hit.totalTokens, heatmapLevel(weight, max, steps))
        }
    }
    return cells.chunked(7)
}

fun normalizeWeekHour(raw: List<List<Long>>): List<List<Long>> =
    List(7) { day -> List(24) { hour -> raw.getOrNull(day)?.getOrNull(hour) ?: 0L } }

/** 0 when there is nothing to colour; otherwise 1..[steps], with [max] in the top bucket. */
fun heatmapLevel(value: Long, max: Long, steps: Int = 4): Int {
    if (value <= 0L || max <= 0L || steps <= 0) return 0
    return ceil(value.toDouble() / max.toDouble() * steps).toInt().coerceIn(1, steps)
}

data class ArcSlice(val key: String, val start: Double, val sweep: Double)

/** Slices start at 12 o'clock and run clockwise, matching Compose's `drawArc`. */
fun donutSlices(weights: List<Pair<String, Double>>): List<ArcSlice> {
    val positive = weights.filter { it.second > 0.0 }
    val sum = positive.sumOf { it.second }
    if (sum <= 0.0) return emptyList()
    var angle = -90.0
    return positive.map { (key, weight) ->
        val sweep = weight / sum * 360.0
        ArcSlice(key, angle, sweep).also { angle += sweep }
    }
}

fun hitDonut(slices: List<ArcSlice>, dx: Double, dy: Double, inner: Double, outer: Double): String? {
    val radius = hypot(dx, dy)
    if (radius < inner || radius > outer) return null
    val pointer = atan2(dy, dx) * 180.0 / PI
    for (slice in slices) {
        val start = normalizeDegrees(slice.start)
        val end = start + slice.sweep
        val angle = normalizeDegrees(pointer).let { if (it < start) it + 360.0 else it }
        if (angle >= start && angle < end) return slice.key
    }
    return null
}

fun scrubIndex(x: Float, left: Float, right: Float, count: Int): Int {
    if (count <= 1) return 0
    val span = (right - left).takeIf { it > 0f } ?: return 0
    val t = ((x - left) / span).coerceIn(0f, 1f)
    return (t * (count - 1)).toDouble().let { round(it) }.toInt().coerceIn(0, count - 1)
}

fun niceStep(span: Double, divisions: Int): Double {
    if (span <= 0.0 || divisions <= 0 || !span.isFinite()) return 1.0
    val rough = span / divisions
    val mag = 10.0.pow(floor(log10(rough)))
    if (mag == 0.0 || !mag.isFinite()) return 1.0
    val residual = rough / mag
    val nice = when {
        residual <= 1.5 -> 1.0
        residual <= 3.0 -> 2.0
        residual <= 7.0 -> 5.0
        else -> 10.0
    }
    return nice * mag
}

fun axisTicks(max: Double, divisions: Int = 4): List<Double> {
    if (max <= 0.0 || !max.isFinite()) return listOf(0.0, 1.0)
    val step = niceStep(max, divisions)
    val top = ceil(max / step) * step
    val ticks = ArrayList<Double>()
    var value = 0.0
    var guard = 0
    while (value <= top + step * 1e-6 && guard < 12) {
        ticks.add(value)
        value += step
        guard++
    }
    return ticks
}

/** Cumulative tops of each series, bottom first. Negatives are clamped; a token series does not go below zero. */
fun stackCumulatives(columns: List<List<Double>>): List<List<Double>> = columns.map { column ->
    var sum = 0.0
    column.map { raw ->
        sum += raw.coerceAtLeast(0.0)
        sum
    }
}

fun lerp(a: Double, b: Double, t: Float): Double = a + (b - a) * t.toDouble()

fun sampleAt(values: List<Double>, t: Double): Double {
    if (values.isEmpty()) return 0.0
    if (values.size == 1) return values.first()
    val x = t.coerceIn(0.0, 1.0) * values.lastIndex
    val index = floor(x).toInt().coerceIn(0, values.lastIndex - 1)
    val fraction = x - index
    return values[index] * (1.0 - fraction) + values[index + 1] * fraction
}

fun resample(values: List<Double>, samples: Int): List<Double> {
    if (samples <= 0) return emptyList()
    if (values.isEmpty()) return List(samples) { 0.0 }
    if (samples == 1) return listOf(values.last())
    return List(samples) { index -> sampleAt(values, index.toDouble() / (samples - 1)) }
}

/**
 * Morph [from] into [to]. Both are resampled to [to]'s point count so a scrub index still names a
 * real bucket of the series on screen. An empty [from] grows up from the baseline.
 */
fun blendTracks(from: List<SeriesTrack>, to: List<SeriesTrack>, t: Float): List<SeriesTrack> {
    val samples = to.maxOfOrNull { it.values.size } ?: return emptyList()
    if (samples == 0) return emptyList()
    val keys = (to.map { it.key } + from.map { it.key }).distinct()
    return keys.map { key ->
        val target = to.firstOrNull { it.key == key }
        val previous = from.firstOrNull { it.key == key }
        val end = resample(target?.values.orEmpty(), samples)
        val start = resample(previous?.values.orEmpty(), samples)
        SeriesTrack(
            key = key,
            label = target?.label ?: previous?.label ?: key,
            backendId = target?.backendId ?: previous?.backendId,
            values = List(samples) { index -> lerp(start[index], end[index], t) },
        )
    }
}

fun compactCount(value: Double): String {
    if (!value.isFinite()) return STATS_UNAVAILABLE
    val sign = if (value < 0) "-" else ""
    var scaled = abs(value)
    val units = arrayOf("", "K", "M", "B")
    var unit = 0
    while (scaled >= 1000.0 && unit < units.lastIndex) {
        scaled /= 1000.0
        unit++
    }
    var text = trimOneDecimal(scaled)
    if (text == "1000" && unit < units.lastIndex) {
        text = "1"
        unit++
    }
    return sign + text + units[unit]
}

fun formatKpi(format: KpiFormat, value: Double): String = when (format) {
    KpiFormat.COUNT -> compactCount(value)
    KpiFormat.PERCENT -> if (!value.isFinite()) STATS_UNAVAILABLE else "${round(value * 100.0).toInt()}%"
    KpiFormat.MILLIS -> formatDurationMs(value)
    KpiFormat.SPEED -> L10n.uiText("stats.speedPerSecond", compactCount(value))
}

fun formatDurationMs(ms: Double): String {
    if (!ms.isFinite()) return STATS_UNAVAILABLE
    val magnitude = abs(ms)
    return when {
        magnitude < 1000.0 -> "${round(ms).toLong()} ms"
        magnitude < 60_000.0 -> L10n.uiText("stats.duration.seconds", trimOneDecimal(ms / 1000.0))
        else -> L10n.uiText("stats.duration.minutes", trimOneDecimal(ms / 60_000.0))
    }
}

fun formatDelta(fraction: Double?): String {
    if (fraction == null || !fraction.isFinite()) return STATS_UNAVAILABLE
    val percent = fraction * 100.0
    if (abs(percent) < 0.05) return "0%"
    val body = trimOneDecimal(abs(percent))
    return if (percent < 0) "-$body%" else "+$body%"
}

fun formatNullableCount(value: Long?): String = value?.let { compactCount(it.toDouble()) } ?: STATS_UNAVAILABLE

/** `2026-10-08T02:00:00.000Z` with a +8h offset renders as `10月8日 10:00`. */
fun formatLocalStamp(epochMillis: Long, utcOffsetMillis: Long): String {
    val local = epochMillis + utcOffsetMillis
    val days = local.floorDiv(DAY_MS)
    val tod = local.mod(DAY_MS)
    val (_, month, day) = civilFromDays(days)
    val minutes = tod / 60_000L
    return L10n.uiText("stats.stamp.local", month, day, pad(minutes / 60), pad(minutes % 60))
}

fun formatBucketLabel(iso: String, granularity: StatsGranularity, utcOffsetMillis: Long): String {
    val epoch = parseIsoInstant(iso) ?: return iso.take(10)
    val local = epoch + utcOffsetMillis
    val days = local.floorDiv(DAY_MS)
    val tod = local.mod(DAY_MS)
    val (year, month, day) = civilFromDays(days)
    val minutes = tod / 60_000L
    val clock = "${pad(minutes / 60)}:${pad(minutes % 60)}"
    return when (granularity) {
        StatsGranularity.HOUR -> "$month/$day $clock"
        StatsGranularity.DAY, StatsGranularity.WEEK -> "$month/$day"
        StatsGranularity.MONTH -> "$year/$month"
    }
}

fun formatIsoUtc(epochMillis: Long): String {
    val days = epochMillis.floorDiv(DAY_MS)
    val tod = epochMillis.mod(DAY_MS)
    val (year, month, day) = civilFromDays(days)
    val hours = tod / 3_600_000L
    val minutes = (tod % 3_600_000L) / 60_000L
    val seconds = (tod % 60_000L) / 1000L
    val millis = tod % 1000L
    return "${pad(year.toLong(), 4)}-${pad(month.toLong())}-${pad(day.toLong())}T${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}Z"
}

fun parseIsoInstant(text: String): Long? {
    val match = ISO.matchEntire(text.trim()) ?: return null
    val year = match.groupValues[1].toInt()
    val month = match.groupValues[2].toInt()
    val day = match.groupValues[3].toInt()
    val hour = match.groupValues[4].toLong()
    val minute = match.groupValues[5].toLong()
    val second = match.groupValues[6].toLong()
    val fraction = match.groupValues[7]
    val zone = match.groupValues[8]
    val millis = if (fraction.isEmpty()) 0L else fraction.padEnd(3, '0').take(3).toLong()
    var epoch = daysFromCivil(year, month, day) * DAY_MS + hour * 3_600_000L + minute * 60_000L + second * 1000L + millis
    if (zone != "Z") {
        val sign = if (zone.startsWith("-")) -1L else 1L
        val zoneHours = zone.substring(1, 3).toLong()
        val zoneMinutes = zone.substring(4, 6).toLong()
        epoch -= sign * (zoneHours * 3_600_000L + zoneMinutes * 60_000L)
    }
    return epoch
}

fun trimOneDecimal(value: Double): String {
    val tenths = round(value * 10.0).toLong()
    val whole = tenths / 10
    val fraction = abs(tenths % 10)
    return if (fraction == 0L) whole.toString() else "$whole.$fraction"
}

/** Monday = 0 … Sunday = 6. 1970-01-01 was a Thursday. */
fun weekdayMonday(epochDay: Long): Int = (epochDay + 3).mod(7)

fun daysFromCivil(year: Int, month: Int, day: Int): Long {
    val y = (if (month <= 2) year - 1 else year).toLong()
    val era = if (y >= 0) y / 400 else (y - 399) / 400
    val yoe = (y - era * 400).toInt()
    val mp = if (month > 2) month - 3 else month + 9
    val doy = (153 * mp + 2) / 5 + day - 1
    val doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
    return era * 146097L + doe - 719468L
}

fun civilFromDays(epochDay: Long): Triple<Int, Int, Int> {
    val z = epochDay + 719468
    val era = if (z >= 0) z / 146097 else (z - 146096) / 146097
    val doe = (z - era * 146097).toInt()
    val yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365
    var year = yoe + era.toInt() * 400
    val doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
    val mp = (5 * doy + 2) / 153
    val day = doy - (153 * mp + 2) / 5 + 1
    val month = mp + if (mp < 10) 3 else -9
    year += if (month <= 2) 1 else 0
    return Triple(year, month, day)
}

private const val DAY_MS = 86_400_000L
private const val PI = 3.141592653589793

private val ISO = Regex("""^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$""")

private fun pad(value: Long, width: Int = 2): String = value.toString().padStart(width, '0')

private fun normalizeDegrees(angle: Double): Double {
    var wrapped = angle % 360.0
    if (wrapped < 0) wrapped += 360.0
    return wrapped
}

private fun countKpi(label: String, current: Long, previous: Long, footnote: String? = null) = KpiSpec(
    label = label,
    raw = current.toDouble(),
    text = formatKpi(KpiFormat.COUNT, current.toDouble()),
    format = KpiFormat.COUNT,
    delta = periodDelta(current.toDouble(), previous.toDouble()).fraction,
    lowerIsBetter = false,
    footnote = footnote,
)

private fun optionalKpi(
    label: String,
    current: Double?,
    previous: Double?,
    format: KpiFormat,
    lowerIsBetter: Boolean,
) = KpiSpec(
    label = label,
    raw = current,
    text = if (current == null) STATS_UNAVAILABLE else formatKpi(format, current),
    format = format,
    delta = if (current == null || previous == null) null else periodDelta(current, previous).fraction,
    lowerIsBetter = lowerIsBetter,
)
