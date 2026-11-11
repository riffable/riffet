package riffet.ui.stats

import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.surfaces
import riffet.ui.app.pageColor
import riffet.ui.app.pageBackground
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.sizeIn
import riffet.ui.app.PageTopBar
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.AnimatedContent
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import riffet.ui.design.RiffetProgressIndicator as CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import riffet.ui.icons.Icon
import riffet.ui.design.RiffetIconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.foundation.selection.selectable
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.stringResource
import riffet_mobile.shared.generated.resources.*
import riffet.cache.createLocalFiles
import riffet.contracts.StatsKeyInfo
import riffet.shared.StatsStreamSession
import riffet.shared.StreamConnection
import riffet.shared.RiffetApi
import riffet.stats.StatsRange
import riffet.stats.dashboardIsEmpty
import riffet.stats.defaultAgentOptions
import riffet.stats.formatLocalStamp
import riffet.stats.parseIsoInstant
import riffet.ui.pager.RiffetTabPager
import riffet.ui.settings.SettingsNoticeKind
import riffet.ui.settings.SettingsMessageBanner
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet.ui.theme.LocalRiffetMotion
import riffet.ui.theme.LocalRiffetPageMotion
import riffet.ui.icons.RiffetIcons
import riffet.ui.timeline.platformNowMillis
import riffet.ui.timeline.platformTimeZoneId
import riffet.ui.timeline.platformUtcOffsetMillis
import riffet.shared.statsStream

private enum class StatsTab(val id: String) {
    OVERVIEW("overview"),
    AGENTS("agents"),
    TIME("time"),
    PERFORMANCE("performance"),
}

private val StatsTab.label: String
    @Composable get() = when (this) {
        StatsTab.OVERVIEW -> stringResource(Res.string.stats_tab_overview)
        StatsTab.AGENTS -> stringResource(Res.string.stats_tab_agents)
        StatsTab.TIME -> stringResource(Res.string.stats_tab_time)
        StatsTab.PERFORMANCE -> stringResource(Res.string.stats_tab_performance)
    }

/**
 * Full-screen stats. Opened from the sidebar as [riffet.ui.app.RiffetApp]'s `Overlay.Stats`.
 * The stream is collected only while this page is composed, which is what "visible" means here.
 */
@Composable
internal fun StatsScreen(
    api: RiffetApi,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val designMetrics = LocalInterfaceStyle.current.metrics
    val motion = LocalRiffetMotion.current
    val pageMotion = LocalRiffetPageMotion.current
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val scope = rememberCoroutineScope()
    val controller = remember(api) {
        StatsController(
            api = api,
            cache = riffet.stats.StatsDashboardCache(createLocalFiles()),
            scope = scope,
            zoneId = ::platformTimeZoneId,
            now = ::platformNowMillis,
            offset = ::platformUtcOffsetMillis,
        )
    }
    val stream = remember(api) { api.statsStream() }
    LaunchedEffect(controller) { controller.refresh() }
    val active = riffet.ui.app.LocalPageActive.current
    LaunchedEffect(stream, active) { if (active) collectStatsStream(stream, controller) }
    var tab by remember { mutableStateOf(StatsTab.OVERVIEW) }
    val state by controller.state.collectAsState()
    val dashboard = state.dashboard
    var filtersExpanded by rememberSaveable { mutableStateOf(false) }
    val pageStates = rememberSaveableStateHolder()
    val pagerState = rememberPagerState { StatsTab.entries.size }

    riffet.ui.app.RiffetPageScaffold(modifier = modifier, topBar = {
        PageTopBar(title = stringResource(Res.string.stats_title), onBack = onBack) {
            StatsDropdown(
                label = stringResource(Res.string.stats_time_range),
                options = StatsRange.entries.map { it.id to it.label },
                value = state.range.id,
                onSelect = { id -> StatsRange.entries.firstOrNull { it.id == id }?.let(controller::chooseRange) },
            )
            RiffetIconButton(onClick = { filtersExpanded = !filtersExpanded }) {
                Icon(
                    RiffetIcons.Filter,
                    contentDescription = if (filtersExpanded) stringResource(Res.string.stats_filter_collapse) else stringResource(Res.string.stats_filter_expand),
                    tint = if (filtersExpanded || state.backends.isNotEmpty() || !state.includeEstimated) colors.accent else colors.fg3,
                    modifier = Modifier.size(designMetrics.buttonIconSize),
                )
            }
            RiffetIconButton(onClick = controller::refresh, enabled = !state.refreshing) {
                if (state.refreshing) {
                    CircularProgressIndicator(modifier = Modifier.size(designMetrics.smallIconSize), color = colors.accent, strokeWidth = 1.5.dp)
                } else {
                    Icon(RiffetIcons.Refresh, contentDescription = stringResource(Res.string.stats_refresh), tint = colors.fg2, modifier = Modifier.size(designMetrics.buttonIconSize))
                }
            }
        }
        if (state.offline && dashboard != null) {
            val stamp = dataStamp(dashboard.generatedAt)
            val error = state.error
            val message = if (error != null) {
                stringResource(Res.string.stats_offline_stale_error, error, stamp)
            } else {
                stringResource(Res.string.stats_offline_stale, stamp)
            }
            Box(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
                SettingsMessageBanner(message, SettingsNoticeKind.INFO)
            }
        } else if (dashboard == null && state.error != null) {
            Box(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
                SettingsMessageBanner(state.error ?: stringResource(Res.string.stats_load_failed), SettingsNoticeKind.ERROR)
            }
        }
        Column(Modifier.fillMaxWidth()) {
            AnimatedVisibility(visible = filtersExpanded, enter = motion.expandIn(), exit = motion.collapseOut()) {
                Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(stringResource(Res.string.stats_agent_hint), style = typography.caption, color = colors.fg3, modifier = Modifier.padding(start = 4.dp))
                    FilterChips(
                        agents = dashboard?.options?.backends?.takeIf { it.isNotEmpty() } ?: defaultAgentOptions(),
                        selected = state.backends,
                        includeEstimated = state.includeEstimated,
                        onToggleAgent = controller::toggleBackend,
                        onToggleEstimated = controller::toggleEstimated,
                    )
                }
            }
        }
        if (LocalInterfaceStyle.current.components.lists.grouped) {
            riffet.ui.design.SegmentedControl(
                options = StatsTab.entries.map { it.label },
                selected = tab.ordinal,
                onSelect = { tab = StatsTab.entries[it] },
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            )
        } else Row(Modifier.fillMaxWidth().padding(horizontal = designMetrics.pageInset).drawBehind {
            val cellWidth = size.width / StatsTab.entries.size
            val indicatorWidth = 32.dp.toPx()
            val position = pagerState.currentPage + pagerState.currentPageOffsetFraction
            drawRoundRect(
                colors.accent,
                topLeft = Offset(cellWidth * (position + 0.5f) - indicatorWidth / 2f, size.height - 3.dp.toPx()),
                size = Size(indicatorWidth, 3.dp.toPx()),
                cornerRadius = CornerRadius(1.5.dp.toPx()),
            )
        }) {
            StatsTab.entries.forEach { item ->
                val selected = tab == item
                Column(
                    Modifier.weight(1f).selectable(selected, role = Role.Tab, onClick = { tab = item }),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(item.label, style = typography.label, color = if (selected) colors.accent else colors.fg2, modifier = Modifier.padding(vertical = 13.dp))
                    Spacer(Modifier.height(2.dp))
                }
            }
        }
        if (!riffet.ui.design.materialBackdropEnabled) HorizontalDivider(color = colors.line)
    }) { chromeInsets ->
        // Loading, empty and loaded are different screens: they cross-fade, and refreshes within one
        // phase leave it alone. The pager's state is hoisted above, so it survives a phase change.
        val phase = when {
            dashboard == null && state.error == null -> StatsPhase.LOADING
            dashboard == null -> StatsPhase.BLANK
            dashboardIsEmpty(dashboard.summary, dashboard.series) -> StatsPhase.EMPTY
            else -> StatsPhase.CONTENT
        }
        AnimatedContent(phase, Modifier.fillMaxSize(), transitionSpec = { pageMotion.transition() }, label = "stats-body") { shown ->
            when (shown) {
                StatsPhase.LOADING -> androidx.compose.foundation.layout.Box(Modifier.fillMaxSize().padding(chromeInsets)) { StatsSkeleton() }
                StatsPhase.BLANK -> Spacer(Modifier.fillMaxSize())
                StatsPhase.EMPTY -> androidx.compose.foundation.layout.Box(Modifier.fillMaxSize().padding(chromeInsets)) { StatsEmpty() }
                StatsPhase.CONTENT -> if (dashboard != null) RiffetTabPager(
                    selected = tab.ordinal,
                    onSelect = { page -> StatsTab.entries.getOrNull(page)?.let { tab = it } },
                    pageCount = StatsTab.entries.size,
                    pagerState = pagerState,
                    modifier = Modifier.fillMaxSize(),
                ) { page ->
                    pageStates.SaveableStateProvider(page) {
                        when (StatsTab.entries[page]) {
                            StatsTab.OVERVIEW -> OverviewPage(dashboard)
                            StatsTab.AGENTS -> AgentsPage(dashboard)
                            StatsTab.TIME -> TimePage(controller, dashboard)
                            StatsTab.PERFORMANCE -> PerformancePage(controller, dashboard)
                        }
                    }
                }
            }
        }
    }
}

private enum class StatsPhase { LOADING, BLANK, EMPTY, CONTENT }

@Composable
private fun FilterChips(
    agents: List<StatsKeyInfo>,
    selected: Set<String>,
    includeEstimated: Boolean,
    onToggleAgent: (String) -> Unit,
    onToggleEstimated: () -> Unit,
) {
    val colors = LocalRiffetColors.current
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        agents.forEach { agent ->
            FilterChip(
                label = agent.label,
                selected = agent.key in selected,
                dot = agent.backendId?.let { colors.agentColor(it) },
                onClick = { onToggleAgent(agent.key) },
            )
        }
        FilterChip(label = stringResource(Res.string.stats_include_estimated), selected = includeEstimated, dot = null, onClick = onToggleEstimated)
    }
}

@Composable
private fun FilterChip(label: String, selected: Boolean, dot: androidx.compose.ui.graphics.Color?, onClick: () -> Unit) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    if ((LocalInterfaceStyle.current.components.controls.chips == riffet.ui.design.ComponentBackend.MATERIAL)) {
        androidx.compose.material3.FilterChip(
            selected = selected,
            onClick = onClick,
            label = { Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis) },
            leadingIcon = dot?.let { tint -> { Box(Modifier.size(6.dp).clip(CircleShape).background(tint)) } },
        )
        return
    }
    val shape = RoundedCornerShape(LocalInterfaceStyle.current.selectionRadius)
    Row(
        modifier = Modifier
            .clip(shape)
            .background(if (selected) surfaces.selected else surfaces.card)
            .border(LocalInterfaceStyle.current.metrics.hairlineWidth, if (selected) surfaces.selected else colors.lineStrong, shape)
            .clickable(role = Role.Button, onClick = onClick)
            .sizeIn(minWidth = 48.dp, minHeight = 48.dp)
            .padding(horizontal = 12.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (dot != null) {
            Box(Modifier.size(6.dp).clip(CircleShape).background(dot))
            Spacer(Modifier.width(6.dp))
        }
        Text(label, style = typography.label, color = if (selected) surfaces.selectedContent else colors.fg2, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

private fun dataStamp(generatedAt: String): String {
    val epoch = parseIsoInstant(generatedAt) ?: return generatedAt
    return formatLocalStamp(epoch, platformUtcOffsetMillis(epoch))
}

private suspend fun collectStatsStream(stream: StatsStreamSession, controller: StatsController) {
    kotlinx.coroutines.coroutineScope {
        launch {
            var dropped = false
            stream.connection.collect { state ->
                when (state) {
                    is StreamConnection.Reconnecting -> dropped = true
                    StreamConnection.Live -> if (dropped) {
                        dropped = false
                        controller.noteChanged()
                    }
                    StreamConnection.Connecting -> Unit
                }
            }
        }
        launch {
            stream.messages.collect { controller.noteChanged() }
        }
    }
}
