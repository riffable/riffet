package riffet.ui.onboarding

import androidx.compose.animation.Crossfade
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.ui.layout.layout
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import androidx.compose.ui.text.style.TextOverflow
import kotlinx.coroutines.CancellationException
import org.jetbrains.compose.resources.stringResource
import riffet.contracts.NativeBackendId
import riffet.contracts.Project
import riffet.shared.RiffetApi
import riffet.shared.backends
import riffet.shared.isAssistant
import riffet.ui.app.LocalTabContentBottomPadding
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.LocalRiffetSurfaces
import riffet.ui.design.RiffetButton
import riffet.ui.design.RiffetMaterialContent
import riffet.ui.design.RiffetTextButton
import riffet.ui.design.materialContentBackground
import riffet.ui.home.HomeBands
import riffet.ui.home.ProjectPickerSheet
import riffet.ui.icons.Icon
import riffet.ui.icons.LiveBrandMark
import riffet.ui.icons.RiffetIcons
import riffet.ui.session.backendName
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetMotion
import riffet.ui.theme.LocalRiffetTypography
import riffet.ui.timeline.Spinner
import riffet_mobile.shared.generated.resources.Res
import riffet_mobile.shared.generated.resources.onboarding_enter_address
import riffet_mobile.shared.generated.resources.onboarding_scan
import riffet_mobile.shared.generated.resources.settings_recheck
import riffet_mobile.shared.generated.resources.setup_agent
import riffet_mobile.shared.generated.resources.setup_no_agent
import riffet_mobile.shared.generated.resources.setup_pick_project
import riffet_mobile.shared.generated.resources.setup_project
import riffet_mobile.shared.generated.resources.setup_project_hint
import riffet_mobile.shared.generated.resources.setup_server

/** Where one setup step stands. */
private sealed interface StepState {
    data object Pending : StepState
    data object Current : StepState
    data object Busy : StepState
    data class Done(val result: String) : StepState
}

private sealed interface AgentLookup {
    data object Checking : AgentLookup
    data object None : AgentLookup
    data class Failed(val message: String) : AgentLookup
    data class Found(val label: String, val id: NativeBackendId) : AgentLookup
}

/**
 * The new-session page while something is missing: the mark, and in the composer's place the island
 * with the three steps 服务器 · Agent · 项目. It is shown for an unconnected device, and for a
 * connected one with no project yet; when the steps are done the page swaps it for the composer.
 */
@Composable
internal fun HomeSetupPage(
    api: RiffetApi?,
    projects: List<Project>,
    contentPadding: PaddingValues,
    onSelectProject: (Project) -> Unit,
    /** Opens the directory browser; null where the server cannot add one. */
    onAddDirectory: (() -> Unit)?,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val actions = LocalSetupActions.current
    val busy = actions?.busy?.value != null

    val serverName by produceState<String?>(null, api?.baseUrl, actions) {
        val base = api?.baseUrl ?: return@produceState
        value = runCatching { actions?.connection?.pairedServers()?.firstOrNull { it.baseUrl == base }?.displayName }.getOrNull()
            ?: base.substringAfter("://")
    }
    var recheck by remember { mutableIntStateOf(0) }
    val agent by produceState<AgentLookup>(AgentLookup.Checking, api, recheck) {
        val client = api ?: return@produceState
        value = AgentLookup.Checking
        value = try {
            client.backends().firstOrNull { it.available && it.backendId != NativeBackendId.CHAT }
                ?.let { AgentLookup.Found(it.label, it.backendId) } ?: AgentLookup.None
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (failure: Throwable) {
            AgentLookup.Failed(failure.message ?: failure::class.simpleName.orEmpty())
        }
    }
    val choices = remember(projects) {
        projects.filter { it.archivedAt == null && !it.isAssistant && it.system != "task-workspace" }
    }
    var sheet by remember { mutableStateOf(false) }

    val server: StepState = when {
        api != null -> StepState.Done(serverName.orEmpty())
        busy -> StepState.Busy
        else -> StepState.Current
    }
    val agentStep: StepState = when {
        api == null -> StepState.Pending
        else -> when (val found = agent) {
            AgentLookup.Checking -> StepState.Busy
            AgentLookup.None, is AgentLookup.Failed -> StepState.Current
            is AgentLookup.Found -> StepState.Done(found.label.ifBlank { backendName(found.id) })
        }
    }
    // A failed lookup says nothing about the agents, so it does not hold the project step back.
    val projectStep: StepState = if (agentStep is StepState.Done || agent is AgentLookup.Failed && api != null) StepState.Current else StepState.Pending

    // The viewport's height, read only while the bands measure, as the composer page does.
    val viewport = remember { mutableIntStateOf(0) }
    val topPadding = contentPadding.calculateTopPadding()
    val bottomPadding = contentPadding.calculateBottomPadding() + LocalTabContentBottomPadding.current
    Box(
        Modifier.fillMaxSize().layout { measurable, constraints ->
            viewport.intValue = constraints.maxHeight
            val placeable = measurable.measure(constraints)
            layout(placeable.width, placeable.height) { placeable.place(0, 0) }
        }.verticalScroll(rememberScrollState())
            .padding(start = metrics.pageInset, end = metrics.pageInset)
            .padding(top = topPadding, bottom = bottomPadding),
    ) {
        HomeBands(
            viewport = viewport,
            verticalPadding = topPadding + bottomPadding,
            mark = { LiveBrandMark(modifier = Modifier.fillMaxSize(), fg = colors.fg, accent = colors.accent) },
            form = {
                SetupIsland(
                    steps = listOf(
                        stringResource(Res.string.setup_server) to server,
                        stringResource(Res.string.setup_agent) to agentStep,
                        stringResource(Res.string.setup_project) to projectStep,
                    ),
                ) {
                    if (server is StepState.Current && actions != null) ServerBody(actions)
                    else Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(metrics.controlInset)) {
                        val lookup = agent
                        if (agentStep is StepState.Current) AgentBody(lookup, onRecheck = { recheck++ })
                        if (projectStep is StepState.Current) ProjectBody(
                            onPick = { if (choices.isEmpty()) onAddDirectory?.invoke() else sheet = true },
                        )
                    }
                }
            },
            tools = {},
        )
    }

    if (sheet) {
        ProjectPickerSheet(
            projects = choices,
            selectedId = null,
            onSelect = { picked -> if (picked != null) onSelectProject(picked) },
            onDismiss = { sheet = false },
            onChooseDirectory = onAddDirectory,
        )
    }
}

@Composable
private fun ServerBody(actions: SetupActions) {
    val found = rememberFoundServers()
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(LocalInterfaceStyle.current.metrics.controlInset / 2)) {
        RiffetButton(stringResource(Res.string.onboarding_scan), actions.scan, primary = true, modifier = Modifier.fillMaxWidth())
        found.servers.forEach { server -> FoundServerRow(server, enabled = true, onConnect = { actions.connectTo(riffet.ui.pairing.formatServerAddress(server.host, server.port)) }) }
        RiffetTextButton(actions.enterAddress, Modifier.fillMaxWidth()) { Text(stringResource(Res.string.onboarding_enter_address)) }
    }
}

@Composable
private fun AgentBody(lookup: AgentLookup, onRecheck: () -> Unit) {
    val metrics = LocalInterfaceStyle.current.metrics
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(metrics.controlInset / 2)) {
        Text(
            (lookup as? AgentLookup.Failed)?.message?.takeIf { it.isNotBlank() } ?: stringResource(Res.string.setup_no_agent),
            style = LocalRiffetTypography.current.bodySmall, color = LocalRiffetColors.current.fg3,
            modifier = Modifier.padding(horizontal = metrics.controlInset / 2),
        )
        RiffetButton(stringResource(Res.string.settings_recheck), onRecheck, modifier = Modifier.fillMaxWidth())
    }
}

@Composable
private fun ProjectBody(onPick: () -> Unit) {
    val metrics = LocalInterfaceStyle.current.metrics
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(metrics.controlInset)) {
        Text(
            stringResource(Res.string.setup_project_hint), style = LocalRiffetTypography.current.bodySmall, color = LocalRiffetColors.current.fg3,
            modifier = Modifier.padding(horizontal = metrics.controlInset / 2),
        )
        RiffetButton(stringResource(Res.string.setup_pick_project), onPick, primary = true, modifier = Modifier.fillMaxWidth())
    }
}

/**
 * The composer's card, holding the steps in a row and the current step's body under it. The card is
 * the composer's own shape and fill, so finishing the steps swaps one for the other in place.
 */
@Composable
private fun SetupIsland(steps: List<Pair<String, StepState>>, body: @Composable () -> Unit) {
    val style = LocalInterfaceStyle.current
    val metrics = style.metrics
    val shape = RoundedCornerShape(style.composerRadius)
    Column(
        Modifier.fillMaxWidth()
            .clip(shape)
            .background(materialContentBackground(LocalRiffetSurfaces.current.card), shape)
            .animateContentSize(LocalRiffetMotion.current.spatial()),
    ) {
        RiffetMaterialContent {
            Row(
                Modifier.fillMaxWidth().height(metrics.controlHeight + metrics.controlInset).padding(horizontal = metrics.rowPadding),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(metrics.controlInset / 2),
            ) {
                steps.forEachIndexed { index, (label, state) ->
                    if (index > 0) Box(Modifier.width(metrics.rowPadding).height(metrics.hairlineWidth).background(LocalRiffetSurfaces.current.hairline))
                    StepLabel(label, state)
                }
            }
            Column(Modifier.fillMaxWidth().padding(start = metrics.controlInset, end = metrics.controlInset, bottom = metrics.controlInset)) { body() }
        }
    }
}

@Composable
private fun StepLabel(label: String, state: StepState) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(metrics.controlInset / 2)) {
        Crossfade(state, animationSpec = LocalRiffetMotion.current.short(), label = "step") { shown -> StepGlyph(shown) }
        val text = (state as? StepState.Done)?.result?.takeIf { it.isNotEmpty() } ?: label
        Text(
            text,
            style = LocalRiffetTypography.current.bodySmall,
            color = when (state) {
                StepState.Pending -> colors.fg4
                StepState.Current, StepState.Busy -> colors.fg
                is StepState.Done -> colors.fg2
            },
            maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
    }
}

/** Empty ring, current ring with a dot, spinner, or a filled check. */
@Composable
private fun StepGlyph(state: StepState) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val size = metrics.smallIconSize + 4.dp // design-rules: allow the step glyph is a ring one notch above the small icon
    Box(Modifier.size(size), contentAlignment = Alignment.Center) {
        when (state) {
            StepState.Pending -> Box(Modifier.size(size).border(metrics.focusWidth, colors.fg4, CircleShape))
            StepState.Current -> {
                Box(Modifier.size(size).border(metrics.focusWidth, colors.fg, CircleShape))
                Box(Modifier.size(size / 3).background(colors.fg, CircleShape))
            }
            StepState.Busy -> Spinner(size)
            is StepState.Done -> {
                Box(Modifier.size(size).background(colors.fg2, CircleShape))
                Icon(RiffetIcons.Check, null, Modifier.size(size * 0.6f), colors.bg)
            }
        }
    }
}
