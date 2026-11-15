package riffet.ui.settings

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import riffet.ui.pickers.RiffetMenuText
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.stringResource
import riffet_mobile.shared.generated.resources.*
import riffet.contracts.ServiceMonitorSample
import riffet.contracts.ServiceMonitorSnapshot
import riffet.contracts.ServiceProcess
import riffet.shared.RiffetApi
import riffet.ui.app.LocalPageActive
import riffet.ui.app.PageHost
import riffet.ui.app.PageStack
import riffet.ui.design.ConfirmDialog
import riffet.ui.design.GroupRow
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.pickers.RiffetDropdownMenu
import riffet.ui.pickers.RiffetMenuItem
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet.ui.timeline.Spinner
import kotlin.math.round
import riffet.shared.serviceMonitor
import riffet.shared.terminateServiceProcess

private const val POLL_MS = 5_000L

/** Processes listed on the page itself; the rest are one tap down. */
private const val INLINE_PROCESSES = 5

private sealed interface ServiceRoute {
    data object Overview : ServiceRoute
    data object Processes : ServiceRoute
    data class Process(val pid: Int) : ServiceRoute
}

/**
 * 服务状态: the running service's load, requests and processes (`ServiceStatusSection.tsx` on the
 * web, `ServiceMonitorSettings.swift` on the Mac), laid out for a phone. Monitoring first, the
 * reclaim settings last; the process list and a process's detail are pages beneath. Read every five
 * seconds while the page is on screen; a failed read keeps the last picture and says so.
 */
@Composable
internal fun ServiceStatusPage(
    api: RiffetApi, controller: SettingsController, title: String, onBack: () -> Unit, searchTarget: SettingsSearchTarget?,
) {
    val scope = rememberCoroutineScope()
    val active = LocalPageActive.current
    val pages = remember { PageStack<ServiceRoute>(ServiceRoute.Overview) }
    var snapshot by remember { mutableStateOf<ServiceMonitorSnapshot?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    var confirming by remember { mutableStateOf<ServiceProcess?>(null) }
    val readFailed = stringResource(Res.string.settings_service_read_failed)
    val endFailed = stringResource(Res.string.settings_service_end_failed)

    suspend fun read() {
        try {
            snapshot = api.serviceMonitor()
            error = null
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (failure: Throwable) {
            error = failure.message?.takeIf { it.isNotBlank() } ?: readFailed
        }
    }
    LaunchedEffect(controller) { if (controller.state.value.settings == null) controller.load() }
    LaunchedEffect(active) {
        while (active) {
            read()
            delay(POLL_MS)
        }
    }

    PageHost(pages) { route, back ->
        when (route) {
            ServiceRoute.Overview -> SettingsPage(
                title, onBack, searchTarget = searchTarget, refreshing = refreshing,
                onRefresh = { scope.launch { refreshing = true; read(); refreshing = false } },
            ) {
                val data = snapshot
                if (data == null) {
                    if (error != null) {
                        PageBanner(error!!, SettingsNoticeKind.ERROR)
                        SettingsGroup("") { SettingsActionRow(stringResource(Res.string.settings_retry), onClick = { scope.launch { read() } }) }
                    } else {
                        Box(Modifier.fillMaxWidth().padding(vertical = 48.dp), contentAlignment = Alignment.Center) { Spinner(size = 20.dp) }
                    }
                } else {
                    error?.let { PageBanner(it, SettingsNoticeKind.ERROR); Spacer(Modifier.height(12.dp)) }
                    ServiceOverview(data, onAllProcesses = { pages.push(ServiceRoute.Processes) }, onProcess = { pages.push(ServiceRoute.Process(it.pid)) }, onEnd = { confirming = it })
                }
                ReclaimSection(controller)
            }
            ServiceRoute.Processes -> SettingsPage(stringResource(Res.string.setm_process_title), back) {
                val list = snapshot?.processes.orEmpty()
                SettingsGroup(stringResource(Res.string.settings_service_processes, list.size)) {
                    list.forEach { ProcessRow(it, onOpen = { pages.push(ServiceRoute.Process(it.pid)) }, onEnd = { confirming = it }) }
                }
            }
            is ServiceRoute.Process -> SettingsPage(snapshot?.processes?.firstOrNull { it.pid == route.pid }?.name.orEmpty(), back) {
                val process = snapshot?.processes?.firstOrNull { it.pid == route.pid }
                error?.let { PageBanner(it, SettingsNoticeKind.ERROR); Spacer(Modifier.height(12.dp)) }
                if (process != null) ProcessDetail(process, onEnd = { confirming = process })
            }
        }
    }

    confirming?.let { process ->
        ConfirmDialog(
            title = stringResource(Res.string.confirm_end_process_title, process.name),
            message = stringResource(Res.string.settings_service_end_process_body, process.pid, process.command),
            confirmLabel = stringResource(Res.string.settings_service_end_process),
            danger = true,
            onDismiss = { confirming = null },
            onConfirm = {
                confirming = null
                scope.launch {
                    try { api.terminateServiceProcess(process.pid); read() } catch (cancellation: CancellationException) { throw cancellation } catch (failure: Throwable) {
                        error = failure.message?.takeIf { it.isNotBlank() } ?: endFailed
                    }
                }
            },
        )
    }
}

@Composable
private fun ColumnScope.ServiceOverview(
    data: ServiceMonitorSnapshot, onAllProcesses: () -> Unit, onProcess: (ServiceProcess) -> Unit, onEnd: (ServiceProcess) -> Unit,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val usedMem = data.host.totalMemBytes - data.host.freeMemBytes
    val cores = data.host.cpuCount.coerceAtLeast(1)

    SettingsGroup(stringResource(Res.string.setm_service_overview)) {
        GroupRow(stringResource(Res.string.setm_service_uptime), value = duration(data.process.uptimeSec))
        GroupRow("CPU", value = percent(data.process.cpuPercent))
        GroupRow(stringResource(Res.string.settings_service_memory), value = bytes(data.process.rssBytes))
        GroupRow(stringResource(Res.string.settings_service_request_rate), value = stringResource(Res.string.settings_service_per_minute, fixed(data.requests.perMinute)))
        GroupRow(stringResource(Res.string.settings_service_latency), value = "${fixed(data.requests.avgMs)} ms")
        GroupRow(stringResource(Res.string.settings_service_event_loop), value = "${fixed(data.eventLoop.recentLagMs)} ms")
        GroupRow(stringResource(Res.string.settings_service_load), value = fixed(data.host.loadAvg.getOrElse(0) { 0.0 }),
            subtitle = stringResource(Res.string.settings_service_load_detail, cores, bytes(usedMem), bytes(data.host.totalMemBytes)))
    }

    val series = data.series.takeLast(60)
    SettingsGroup(stringResource(Res.string.settings_service_requests_latency_chart)) {
        Column {
            RequestsChart(series, Modifier.fillMaxWidth().height(140.dp).padding(metrics.pageInset))
            Legend(listOf(stringResource(Res.string.settings_service_requests) to colors.accent, "5xx" to colors.danger, stringResource(Res.string.settings_service_avg_latency) to colors.warning))
        }
    }
    SettingsGroup(stringResource(Res.string.settings_service_cpu_memory_chart)) {
        Column {
            LoadChart(series, Modifier.fillMaxWidth().height(140.dp).padding(metrics.pageInset))
            Legend(listOf("CPU" to colors.accent, stringResource(Res.string.settings_service_memory) to colors.success))
        }
    }

    SettingsGroup(stringResource(Res.string.settings_service_status_codes)) {
        val status = data.requests.byStatus
        val parts = listOf("2xx" to status.status2xx, "3xx" to status.status3xx, "4xx" to status.status4xx, "5xx" to status.status5xx)
        val tints = listOf(colors.success, colors.accent, colors.warning, colors.danger)
        val total = parts.sumOf { it.second }.coerceAtLeast(1)
        parts.forEachIndexed { index, (label, count) ->
            GroupRow(
                label,
                leading = { Box(Modifier.size(8.dp).clip(CircleShape).background(tints[index])) },
                value = "$count · ${round(count * 100.0 / total).toInt()}%",
            )
        }
    }

    if (data.requests.topRoutes.isNotEmpty()) {
        SettingsGroup(stringResource(Res.string.settings_service_top_routes)) {
            data.requests.topRoutes.forEach { route ->
                GroupRow(
                    "${route.method} ${route.route}",
                    subtitle = stringResource(Res.string.settings_service_route_count, route.count, fixed(route.avgMs), fixed(route.p95Ms)),
                    leading = if (route.errors > 0) ({ Box(Modifier.size(8.dp).clip(CircleShape).background(colors.danger)) }) else null,
                )
            }
        }
    }

    SettingsGroup(stringResource(Res.string.settings_service_service)) {
        SettingsValueRow(stringResource(Res.string.settings_version), stringResource(Res.string.settings_service_version_value, data.process.version, data.process.pid), mono = false)
        SettingsValueRow(stringResource(Res.string.settings_service_runtime), "Node ${data.process.nodeVersion} · ${data.process.platform}/${data.process.arch}", mono = false)
        SettingsValueRow(stringResource(Res.string.settings_service_host), "${data.host.hostname} · ${data.host.cpuModel}", mono = false)
        SettingsValueRow(stringResource(Res.string.settings_service_connections), stringResource(Res.string.settings_service_connection_detail, data.connections.eventStreams, data.connections.terminalSockets), mono = false)
        SettingsValueRow(stringResource(Res.string.settings_service_terminals), stringResource(Res.string.settings_service_terminal_detail, data.terminals.live, data.terminals.total), mono = false)
        SettingsValueRow(stringResource(Res.string.settings_service_sessions), stringResource(Res.string.settings_service_session_detail, data.sessions.running, data.sessions.waiting, data.sessions.total), mono = false)
    }

    if (data.processes.isNotEmpty()) {
        SettingsGroup(stringResource(Res.string.settings_service_processes, data.processes.size)) {
            data.processes.take(INLINE_PROCESSES).forEach { ProcessRow(it, onOpen = { onProcess(it) }, onEnd = onEnd) }
            if (data.processes.size > INLINE_PROCESSES) {
                GroupRow(stringResource(Res.string.ext_show_all, data.processes.size), chevron = true, onClick = onAllProcesses)
            }
        }
    }
}

@Composable
private fun processTint(process: ServiceProcess): Color {
    val colors = LocalRiffetColors.current
    return when (process.kind) { "server" -> colors.accent; "tmux" -> colors.success; "agent" -> colors.warning; else -> colors.fg3 }
}

@Composable
private fun processKind(process: ServiceProcess): String =
    when (process.kind) {
        "server" -> stringResource(Res.string.settings_service_server_process)
        "tmux" -> "tmux"
        "agent" -> "Agent"
        else -> stringResource(Res.string.settings_service_child_process)
    }

/** A process: its name over what it costs, the PID at the end. A press opens it, a long press offers to end it. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ProcessRow(process: ServiceProcess, onOpen: () -> Unit, onEnd: (ServiceProcess) -> Unit) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    var menu by remember { mutableStateOf(false) }
    Box {
        GroupRow(
            process.name,
            subtitle = "CPU ${percent(process.cpuPercent)} · ${bytes(process.rssBytes)} · ${duration(process.elapsedSec)}",
            leading = { Box(Modifier.size(8.dp).clip(CircleShape).background(processTint(process))) },
            trailing = { Text(process.pid.toString(), style = typography.caption.copy(fontFeatureSettings = "tnum"), color = colors.fg4) },
            modifier = Modifier.combinedClickable(onLongClick = { if (process.canTerminate) menu = true }, onClick = onOpen),
        )
        Box(Modifier.align(Alignment.TopEnd)) {
            RiffetDropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                RiffetMenuItem(onClick = { menu = false; onEnd(process) }) {
                    Text(stringResource(Res.string.settings_service_end_process), style = RiffetMenuText, color = colors.danger)
                }
            }
        }
    }
}

@Composable
private fun ColumnScope.ProcessDetail(process: ServiceProcess, onEnd: () -> Unit) {
    SettingsGroup("") {
        SettingsValueRow(stringResource(Res.string.setm_process_kind), processKind(process), mono = false)
        SettingsValueRow("PID", process.pid.toString(), mono = false)
        SettingsValueRow(stringResource(Res.string.setm_process_parent), process.ppid.toString(), mono = false)
        SettingsValueRow("CPU", percent(process.cpuPercent), mono = false)
        SettingsValueRow(stringResource(Res.string.settings_service_memory), bytes(process.rssBytes), mono = false)
        SettingsValueRow(stringResource(Res.string.setm_process_elapsed), duration(process.elapsedSec), mono = false)
        process.sessionTitle?.let { SettingsValueRow(stringResource(Res.string.settings_service_sessions), it, mono = false) }
        SettingsValueRow(stringResource(Res.string.setm_process_command), process.command)
    }
    if (process.canTerminate) SettingsGroup("") {
        SettingsActionRow(stringResource(Res.string.settings_service_end_process), onClick = onEnd, danger = true)
    }
}

/** Requests as bars (the 5xx share in red) under the mean latency as a line on its own scale. */
@Composable
private fun RequestsChart(samples: List<ServiceMonitorSample>, modifier: Modifier) {
    val colors = LocalRiffetColors.current
    Canvas(modifier) {
        if (samples.isEmpty()) return@Canvas
        val top = samples.maxOf { it.requests }.coerceAtLeast(1)
        val slot = size.width / samples.size
        samples.forEachIndexed { index, sample ->
            val height = size.height * sample.requests / top
            val errors = size.height * sample.errors / top
            val x = index * slot + slot * 0.15f
            drawRect(colors.accent.copy(alpha = 0.7f), Offset(x, size.height - height), Size(slot * 0.7f, height - errors))
            if (errors > 0f) drawRect(colors.danger, Offset(x, size.height - errors), Size(slot * 0.7f, errors))
        }
        val slowest = samples.maxOf { it.avgMs }.coerceAtLeast(1e-9)
        val line = Path()
        samples.forEachIndexed { index, sample ->
            val point = Offset(index * slot + slot / 2, size.height - (sample.avgMs / slowest).toFloat() * size.height)
            if (index == 0) line.moveTo(point.x, point.y) else line.lineTo(point.x, point.y)
        }
        drawPath(line, colors.warning, style = Stroke(width = 1.6.dp.toPx(), cap = StrokeCap.Round))
    }
}

/** CPU as an area and resident memory as a line, each against its own maximum. */
@Composable
private fun LoadChart(samples: List<ServiceMonitorSample>, modifier: Modifier) {
    val colors = LocalRiffetColors.current
    Canvas(modifier) {
        if (samples.size < 2) return@Canvas
        val step = size.width / (samples.size - 1)
        fun path(value: (ServiceMonitorSample) -> Double): Path {
            val top = samples.maxOf(value).coerceAtLeast(1e-9)
            return Path().apply {
                samples.forEachIndexed { index, sample ->
                    val y = size.height - (value(sample) / top).toFloat() * size.height
                    if (index == 0) moveTo(0f, y) else lineTo(index * step, y)
                }
            }
        }
        val cpu = path { it.cpuPercent }
        drawPath(Path().apply { addPath(cpu); lineTo(size.width, size.height); lineTo(0f, size.height); close() }, colors.accent.copy(alpha = 0.16f))
        drawPath(cpu, colors.accent, style = Stroke(width = 1.6.dp.toPx(), cap = StrokeCap.Round))
        drawPath(path { it.rssBytes.toDouble() }, colors.success, style = Stroke(width = 1.6.dp.toPx(), cap = StrokeCap.Round))
    }
}

@Composable
private fun Legend(items: List<Pair<String, Color>>) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    Row(Modifier.fillMaxWidth().padding(start = metrics.pageInset, end = metrics.pageInset, bottom = metrics.rowPadding), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        items.forEach { (label, tint) ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(8.dp).clip(CircleShape).background(tint))
                Spacer(Modifier.width(6.dp))
                Text(label, style = typography.caption, color = colors.fg3)
            }
        }
    }
}

private fun fixed(value: Double): String = if (value >= 100) round(value).toLong().toString() else (round(value * 10) / 10).toString()
private fun percent(value: Double): String = "${fixed(value)}%"

private fun bytes(value: Long): String = when {
    value >= 1L shl 30 -> "${fixed(value / 1073741824.0)} GB"
    value >= 1L shl 20 -> "${fixed(value / 1048576.0)} MB"
    else -> "${fixed(value / 1024.0)} KB"
}

@Composable
private fun duration(seconds: Double): String {
    val total = seconds.toLong()
    val days = total / 86_400
    val hours = total % 86_400 / 3_600
    val minutes = total % 3_600 / 60
    return when {
        days > 0 -> stringResource(Res.string.settings_extra_duration_days_hours, days, hours)
        hours > 0 -> stringResource(Res.string.settings_extra_duration_hours_minutes, hours, minutes)
        minutes > 0 -> stringResource(Res.string.settings_extra_duration_minutes, minutes)
        else -> stringResource(Res.string.settings_extra_duration_seconds, total)
    }
}
