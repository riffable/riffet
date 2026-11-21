package riffet.ui.stats

import riffet.ui.gesture.riffetHorizontalScroll
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.ViewTabs
import riffet.ui.app.PageMoreAction
import riffet.ui.pickers.RiffetMenuItem
import riffet.ui.pickers.RiffetMenuText
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.pulltorefresh.PullToRefreshDefaults
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
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
@OptIn(ExperimentalMaterial3Api::class)
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
    val pageStates = rememberSaveableStateHolder()
    val pagerState = rememberPagerState { StatsTab.entries.size }

    riffet.ui.app.RiffetPageScaffold(modifier = modifier, topBar = {
        PageTopBar(title = stringResource(Res.string.stats_title), onBack = onBack) {
            PageMoreAction { close ->
                RiffetMenuItem(selected = state.includeEstimated, showCheck = true, onClick = controller::toggleEstimated) {
                    Text(stringResource(Res.string.stats_include_estimated), style = RiffetMenuText, color = colors.fg, modifier = Modifier.weight(1f))
                }
                HorizontalDivider(color = colors.line)
                RiffetMenuItem(text = stringResource(Res.string.stats_refresh), onClick = { close(); controller.refresh() }, enabled = !state.refreshing)
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
        ViewTabs(
            labels = StatsTab.entries.map { it.label },
            selected = tab.ordinal,
            onSelect = { tab = StatsTab.entries[it] },
        )
        // The scope the figures cover (mobile.md §2.1 范围条): the period and the agents, each a pill
        // showing its value, so an empty or surprising page says which slice it is.
        val agentOptions = dashboard?.options?.backends?.takeIf { it.isNotEmpty() } ?: defaultAgentOptions()
        val chosenAgents = agentOptions.filter { it.key in state.backends }
        var rangeOpen by remember { mutableStateOf(false) }
        var agentsOpen by remember { mutableStateOf(false) }
        Row(
            Modifier.fillMaxWidth().riffetHorizontalScroll(rememberScrollState())
                .padding(horizontal = LocalInterfaceStyle.current.metrics.pageInset, vertical = LocalInterfaceStyle.current.metrics.controlInset / 2),
            horizontalArrangement = Arrangement.spacedBy(LocalInterfaceStyle.current.metrics.controlInset / 2),
        ) {
            Box {
                riffet.ui.design.ChipButton(state.range.label, active = false, onClick = { rangeOpen = true })
                riffet.ui.pickers.RiffetDropdownMenu(expanded = rangeOpen, onDismissRequest = { rangeOpen = false }) {
                    StatsRange.entries.forEach { range ->
                        RiffetMenuItem(selected = range == state.range, showCheck = true, onClick = { rangeOpen = false; controller.chooseRange(range) }) {
                            Text(range.label, style = RiffetMenuText, color = colors.fg, modifier = Modifier.weight(1f))
                        }
                    }
                }
            }
            Box {
                val agentsLabel = when (chosenAgents.size) {
                    0 -> stringResource(Res.string.statp_all_agents)
                    1 -> chosenAgents.first().label
                    else -> stringResource(Res.string.statp_agent_count, chosenAgents.size)
                }
                riffet.ui.design.ChipButton(agentsLabel, active = chosenAgents.isNotEmpty(), onClick = { agentsOpen = true })
                riffet.ui.pickers.RiffetDropdownMenu(expanded = agentsOpen, onDismissRequest = { agentsOpen = false }) {
                    agentOptions.forEach { agent ->
                        RiffetMenuItem(
                            selected = agent.key in state.backends,
                            showCheck = true,
                            onClick = { controller.toggleBackend(agent.key) },
                            leading = agent.backendId?.let { id -> { Box(Modifier.size(6.dp).clip(CircleShape).background(colors.agentColor(id))) } },
                        ) {
                            Text(agent.label, style = RiffetMenuText, color = colors.fg, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
        }
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
                StatsPhase.CONTENT -> if (dashboard != null) {
                    val pull = rememberPullToRefreshState()
                    PullToRefreshBox(
                        isRefreshing = state.refreshing,
                        onRefresh = controller::refresh,
                        modifier = Modifier.fillMaxSize(),
                        state = pull,
                        contentAlignment = Alignment.TopCenter,
                        indicator = {
                            PullToRefreshDefaults.Indicator(
                                state = pull,
                                isRefreshing = state.refreshing,
                                modifier = Modifier.align(Alignment.TopCenter).padding(top = chromeInsets.calculateTopPadding()),
                            )
                        },
                    ) { RiffetTabPager(
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
                } }
                }
            }
        }
    }
}

private enum class StatsPhase { LOADING, BLANK, EMPTY, CONTENT }

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
