package riffet.ui.stats

import riffet.ui.design.LocalRiffetSurfaces
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.app.cardColor
import riffet.ui.pickers.RiffetMenuText
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.indication
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.ui.Alignment
import androidx.compose.ui.unit.sp
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.material3.HorizontalDivider
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import riffet.ui.icons.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import org.jetbrains.compose.resources.rememberResourceEnvironment
import org.jetbrains.compose.resources.stringResource
import riffet_mobile.shared.generated.resources.*
import riffet.contracts.StatsDashboard
import riffet.contracts.StatsGranularity
import riffet.stats.DeltaPolarity
import riffet.stats.KpiFormat
import riffet.stats.LatencyMetric
import riffet.stats.calendarGrid
import riffet.stats.deltaPolarity
import riffet.stats.donutWeights
import riffet.stats.formatBucketLabel
import riffet.stats.parseIsoInstant
import riffet.stats.formatDelta
import riffet.stats.formatDurationMs
import riffet.stats.formatKpi
import riffet.stats.formatNullableCount
import riffet.stats.latencyMarks
import riffet.stats.normalizeWeekHour
import riffet.stats.overviewKpis
import riffet.stats.rankedBars
import riffet.stats.reliabilityRows
import riffet.stats.seriesTracks
import riffet.theme.RiffetColors
import riffet.ui.icons.RiffetIcons
import riffet.ui.pickers.RiffetDropdownMenu
import riffet.ui.pickers.RiffetMenuItem
import riffet.ui.settings.SettingsSegmented
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet.ui.timeline.platformNowMillis
import riffet.ui.timeline.platformUtcOffsetMillis

@Composable
internal fun OverviewPage(dashboard: StatsDashboard, modifier: Modifier = Modifier) {
    rememberResourceEnvironment()
    val designMetrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val kpis = overviewKpis(dashboard.summary)
    val tracks = seriesTracks(dashboard.series)
    val labels = dashboard.series.points.map { bucketLabel(it.start, dashboard.series.granularity) }
    PageScroll(modifier) {
        val primary = kpis.first()
        Column(Modifier.fillMaxWidth().clip(StatsCardShape).background(cardColor()).padding(20.dp)) {
            Text(stringResource(Res.string.stats_total_token_usage), style = typography.bodySmall, color = colors.fg3)
            Spacer(Modifier.height(8.dp))
            Text(primary.text, style = typography.largeTitle, color = colors.fg)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(formatDelta(primary.delta), style = typography.caption, color = deltaPolarity(primary.delta, false).color(colors))
                Text(stringResource(Res.string.stats_vs_last_period), style = typography.caption, color = colors.fg4)
            }
            primary.footnote?.let {
                Text(it, style = typography.caption, color = colors.fg3, modifier = Modifier.padding(top = 4.dp))
            }
        }
        StatsCard(null, padded = false) {
            kpis.drop(1).forEachIndexed { index, spec ->
                if (index > 0) HorizontalDivider(color = colors.line, modifier = Modifier.padding(horizontal = designMetrics.pageInset))
                Row(Modifier.fillMaxWidth().padding(horizontal = designMetrics.pageInset, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(spec.label, style = typography.body, color = colors.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (spec.delta != null) Text(formatDelta(spec.delta), style = typography.caption, color = deltaPolarity(spec.delta, spec.lowerIsBetter).color(colors))
                    }
                    Text(spec.text, style = typography.body.copy(fontFeatureSettings = "tnum"), color = colors.fg, maxLines = 1)
                }
            }
        }
        StatsCard(stringResource(Res.string.stats_usage_trend)) { StackedAreaChart(tracks, labels) }
    }
}

@Composable
internal fun AgentsPage(dashboard: StatsDashboard, modifier: Modifier = Modifier) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    PageScroll(modifier) {
        StatsCard("Agent") { DonutChart(donutWeights(dashboard.backends.rows)) }
        StatsCard(stringResource(Res.string.stats_models)) { HorizontalBars(rankedBars(dashboard.models.rows, byCount = false)) }
        StatsCard(stringResource(Res.string.stats_tools)) {
            HorizontalBars(rankedBars(dashboard.tools.rows, byCount = true))
            dashboard.tools.rows.firstOrNull { (it.failed ?: 0L) > 0L }?.let { row ->
                Text(
                    stringResource(Res.string.stats_tool_failures, row.label, formatNullableCount(row.failed)),
                    style = typography.caption,
                    color = colors.warning,
                    modifier = Modifier.padding(top = 6.dp),
                )
            }
        }
    }
}

@Composable
internal fun TimePage(controller: StatsController, dashboard: StatsDashboard, modifier: Modifier = Modifier) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val state by controller.state.collectAsState()
    var picked by rememberSaveable { mutableStateOf<StatsGranularity?>(null) }
    val granularity = picked ?: dashboard.series.granularity
    LaunchedEffect(granularity, state.activeQuery, dashboard) { controller.loadSeries(granularity) }
    val series = state.detailSeries?.takeIf { it.granularity == granularity }
        ?: dashboard.series.takeIf { it.granularity == granularity }
    PageScroll(modifier) {
        StatsCard(stringResource(Res.string.stats_active_hours)) { WeekHourHeatmap(normalizeWeekHour(dashboard.heatmap.weekHour)) }
        StatsCard(stringResource(Res.string.stats_daily_activity)) { CalendarHeatmap(calendarGrid(dashboard.heatmap.calendar)) }
        StatsCard(
            stringResource(Res.string.stats_trend),
            trailing = {
                val granularityLabels = mapOf(
                    StatsGranularity.HOUR to stringResource(Res.string.stats_granularity_hour),
                    StatsGranularity.DAY to stringResource(Res.string.stats_granularity_day),
                    StatsGranularity.WEEK to stringResource(Res.string.stats_granularity_week),
                    StatsGranularity.MONTH to stringResource(Res.string.stats_granularity_month),
                )
                StatsDropdown(
                    label = stringResource(Res.string.stats_granularity),
                    options = StatsGranularity.entries.map { it.name to granularityLabels.getValue(it) },
                    value = granularity.name,
                    onSelect = { name -> StatsGranularity.entries.firstOrNull { it.name == name }?.let { picked = it } },
                )
            },
        ) {
        when {
            state.seriesLoading && series == null -> Text(stringResource(Res.string.stats_loading_trend), style = typography.caption, color = colors.fg3)
            series == null -> Text(state.seriesError ?: stringResource(Res.string.stats_no_trend), style = typography.bodySmall, color = colors.fg3)
            else -> {
                StackedAreaChart(
                    seriesTracks(series),
                    series.points.map { bucketLabel(it.start, series.granularity) },
                )
            }
        }
        }
    }
}

@Composable
internal fun PerformancePage(controller: StatsController, dashboard: StatsDashboard, modifier: Modifier = Modifier) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val state by controller.state.collectAsState()
    var metric by rememberSaveable { mutableStateOf(LatencyMetric.TTFT) }
    LaunchedEffect(state.activeQuery, dashboard) { controller.loadLatency() }
    val format: (Double) -> String = if (metric == LatencyMetric.SPEED) {
        { value -> formatKpi(KpiFormat.SPEED, value) }
    } else {
        ::formatDurationMs
    }
    PageScroll(modifier) {
        StatsCard(stringResource(Res.string.stats_by_model)) {
            rememberResourceEnvironment()
            SettingsSegmented(
                options = LatencyMetric.entries.map { it.id to it.label },
                value = metric.id,
                onSelect = { id -> LatencyMetric.entries.firstOrNull { it.id == id }?.let { metric = it } },
            )
            Spacer(Modifier.height(12.dp))
            when {
                state.latencyLoading && state.latency == null -> Text(stringResource(Res.string.stats_loading_performance), style = typography.caption, color = colors.fg3)
                state.latency == null -> Text(state.latencyError ?: stringResource(Res.string.stats_no_performance), style = typography.bodySmall, color = colors.fg3)
                else -> LatencyRangeChart(latencyMarks(state.latency!!, metric), format)
            }
        }
        StatsCard(stringResource(Res.string.stats_reliability)) { ReliabilityChart(reliabilityRows(dashboard.backends)) }
    }
}

@Composable
private fun PageScroll(modifier: Modifier, content: @Composable () -> Unit) {
    val metrics = LocalInterfaceStyle.current.metrics
    Column(
        modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(riffet.ui.app.LocalPageChromeInsets.current).padding(PaddingValues(horizontal = metrics.pageInset, vertical = metrics.pageInset)),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        content()
        Spacer(Modifier.height(12.dp))
    }
}

private val StatsCardShape: RoundedCornerShape
    @Composable get() = RoundedCornerShape(LocalInterfaceStyle.current.groupRadius)

/** One section of a stats page: a raised card on the page colour, titled, with an optional control. */
@Composable
private fun StatsCard(
    title: String?,
    padded: Boolean = true,
    trailing: (@Composable () -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    val designMetrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    Column(Modifier.fillMaxWidth().clip(StatsCardShape).background(cardColor()).padding(vertical = 16.dp)) {
        if (title != null) Row(
            Modifier.fillMaxWidth().heightIn(min = 24.dp).padding(start = 16.dp, end = if (trailing != null) 8.dp else 16.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(title, style = typography.label, color = colors.fg, modifier = Modifier.weight(1f))
            trailing?.invoke()
        }
        Column(if (padded) Modifier.padding(horizontal = designMetrics.pageInset) else Modifier) { content() }
    }
}

private fun DeltaPolarity.color(colors: RiffetColors) = when (this) {
    DeltaPolarity.FAVORABLE -> colors.success
    DeltaPolarity.UNFAVORABLE -> colors.danger
    DeltaPolarity.FLAT, DeltaPolarity.UNKNOWN -> colors.fg3
}

private fun bucketLabel(iso: String, granularity: StatsGranularity): String {
    val epoch = parseIsoInstant(iso)
    val offset = platformUtcOffsetMillis(epoch ?: platformNowMillis())
    return formatBucketLabel(iso, granularity, offset)
}

@Composable
internal fun StatsSkeleton(modifier: Modifier = Modifier) {
    val designMetrics = LocalInterfaceStyle.current.metrics
    Column(modifier.fillMaxSize().padding(designMetrics.rowPadding), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        riffet.ui.design.SkeletonBlock(Modifier.fillMaxWidth().height(180.dp), StatsCardShape)
        riffet.ui.design.SkeletonBlock(Modifier.fillMaxWidth().height(220.dp), StatsCardShape)
    }
}

// The page's empty state (mobile.md section 2.1): centred; the range pill above says which period.
@Composable
internal fun StatsEmpty(modifier: Modifier = Modifier) {
    riffet.ui.design.EmptyState(stringResource(Res.string.stats_empty_title), modifier)
}

/** Compact trigger shared by the date range and the trend's bucket size. */
@Composable
internal fun StatsDropdown(
    label: String,
    options: List<Pair<String, String>>,
    value: String,
    onSelect: (String) -> Unit,
) {
    val designMetrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    var expanded by remember { mutableStateOf(false) }
    val selectedLabel = options.firstOrNull { it.first == value }?.second ?: value
    val description = stringResource(Res.string.stats_dropdown_a11y, label, selectedLabel)
    val visualHeight = designMetrics.smallIconSize + designMetrics.controlInset
    val source = remember { MutableInteractionSource() }
    val indication = LocalIndication.current
    Box {
        Row(
            Modifier.heightIn(min = designMetrics.controlHeight)
                .clickable(interactionSource = source, indication = null, role = Role.Button) { expanded = true }
                .semantics { contentDescription = description }
                .padding(vertical = ((designMetrics.controlHeight - visualHeight) / 2).coerceAtLeast(0.dp))
                .clip(RoundedCornerShape(LocalInterfaceStyle.current.controlRadius))
                .border(designMetrics.hairlineWidth, LocalRiffetSurfaces.current.hairline, RoundedCornerShape(LocalInterfaceStyle.current.controlRadius))
                .indication(source, indication)
                .heightIn(min = visualHeight)
                .padding(start = 12.dp, end = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(selectedLabel, style = typography.label, color = colors.fg, maxLines = 1)
            Icon(RiffetIcons.ChevronDown, contentDescription = null, tint = colors.fg3, modifier = Modifier.size(16.dp))
        }
        RiffetDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }, modifier = Modifier.widthIn(min = 140.dp)) {
            options.forEach { (id, title) ->
                RiffetMenuItem(
                    selected = id == value,
                    showCheck = true,
                    onClick = { expanded = false; onSelect(id) },
                ) {
                    Text(title, style = RiffetMenuText, color = colors.fg, modifier = Modifier.weight(1f))
                }
            }
        }
    }
}
