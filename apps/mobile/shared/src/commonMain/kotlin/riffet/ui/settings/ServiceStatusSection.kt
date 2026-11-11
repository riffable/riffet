package riffet.ui.settings

import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.GroupShape
import riffet.ui.design.LocalRiffetSurfaces
import riffet.ui.design.cardEdge
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import riffet.ui.design.AlertDialog
import androidx.compose.material3.Text
import riffet.ui.design.RiffetTextButton
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
import androidx.compose.ui.text.style.TextOverflow
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
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet.ui.timeline.Spinner
import kotlin.math.max
import kotlin.math.round
import riffet.shared.serviceMonitor
import riffet.shared.terminateServiceProcess

private const val POLL_MS = 5_000L

/**
 * 服务状态: the running service's load, requests and processes (`ServiceStatusSection.tsx` on the
 * web, `ServiceMonitorSettings.swift` on the Mac), laid out for a phone. Read every five seconds
 * while the page is on screen; a failed read keeps the last picture and says so.
 */
@Composable
internal fun ServiceStatusSection(api: RiffetApi) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val scope = rememberCoroutineScope()
    val active = riffet.ui.app.LocalPageActive.current
    var snapshot by remember { mutableStateOf<ServiceMonitorSnapshot?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var refresh by remember { mutableStateOf(0) }
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
    LaunchedEffect(active, refresh) {
        while (active) {
            read()
            delay(POLL_MS)
        }
    }


    val data = snapshot
    if (data == null) {
        if (error != null) {
            PageBanner(error!!, SettingsNoticeKind.ERROR)
            Spacer(Modifier.height(12.dp))
            SettingsButton(stringResource(Res.string.settings_retry), onClick = { refresh++ })
        } else {
            Box(Modifier.fillMaxWidth().padding(vertical = 48.dp), contentAlignment = Alignment.Center) { Spinner(size = 20.dp) }
        }
        return
    }

    // Status line: live or stale, how long the service has run, and a manual refresh.
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(8.dp).clip(CircleShape).background(if (error == null) colors.success else colors.warning))
        Spacer(Modifier.width(8.dp))
        Text(
            if (error == null) stringResource(Res.string.settings_service_live, duration(data.process.uptimeSec)) else stringResource(Res.string.settings_service_stale),
            style = typography.caption, color = colors.fg3, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
        SettingsButton(stringResource(Res.string.settings_service_refresh), onClick = { refresh++ })
    }
    error?.let { Spacer(Modifier.height(8.dp)); PageBanner(it, SettingsNoticeKind.ERROR) }
    Spacer(Modifier.height(12.dp))

    val series = data.series.takeLast(60)
    val cores = data.host.cpuCount.coerceAtLeast(1)
    val load = data.host.loadAvg
    val usedMem = data.host.totalMemBytes - data.host.freeMemBytes
    val tiles = listOf(
        Tile("CPU", percent(data.process.cpuPercent), stringResource(Res.string.settings_service_process), series.map { it.cpuPercent }, colors.accent, meter = data.process.cpuPercent / 100.0),
        Tile(stringResource(Res.string.settings_service_memory), bytes(data.process.rssBytes), stringResource(Res.string.settings_service_heap, bytes(data.process.heapUsedBytes), bytes(data.process.heapTotalBytes)), series.map { it.rssBytes.toDouble() }, colors.success,
            meter = data.process.heapUsedBytes.toDouble() / max(1L, data.process.heapTotalBytes)),
        Tile(stringResource(Res.string.settings_service_request_rate), stringResource(Res.string.settings_service_per_minute, fixed(data.requests.perMinute)), stringResource(Res.string.settings_service_in_flight, data.requests.inFlight, data.requests.total), series.map { it.requests.toDouble() }, colors.accent),
        Tile(stringResource(Res.string.settings_service_latency), "${fixed(data.requests.avgMs)} ms", stringResource(Res.string.settings_service_lag_p95, fixed(data.requests.p95Ms), if (data.requests.byStatus.status5xx > 0) stringResource(Res.string.settings_service_status_5xx, data.requests.byStatus.status5xx) else stringResource(Res.string.settings_service_no_errors)),
            series.map { it.avgMs }, if (data.requests.byStatus.status5xx > 0) colors.danger else colors.warning),
        Tile(stringResource(Res.string.settings_service_event_loop), "${fixed(data.eventLoop.recentLagMs)} ms", stringResource(Res.string.settings_service_lag, fixed(data.eventLoop.p99Ms), data.eventLoop.stalls), series.map { it.loopLagMs }, colors.warning,
            meter = data.eventLoop.utilization),
        Tile(stringResource(Res.string.settings_service_load), fixed(load.getOrElse(0) { 0.0 }), stringResource(Res.string.settings_service_load_detail, cores, bytes(usedMem), bytes(data.host.totalMemBytes)), series.map { it.load1 }, colors.fg2,
            meter = usedMem.toDouble() / max(1L, data.host.totalMemBytes)),
    )
    tiles.chunked(2).forEach { row ->
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            row.forEach { KpiTile(it, Modifier.weight(1f)) }
            if (row.size == 1) Spacer(Modifier.weight(1f))
        }
        Spacer(Modifier.height(10.dp))
    }

    SettingsGroup(stringResource(Res.string.settings_service_requests_latency_chart)) {
        Column {
            RequestsChart(data.series, Modifier.fillMaxWidth().height(140.dp).padding(metrics.pageInset))
            Legend(listOf(stringResource(Res.string.settings_service_requests) to colors.accent, "5xx" to colors.danger, stringResource(Res.string.settings_service_avg_latency) to colors.warning))
        }
    }
    SettingsGroup(stringResource(Res.string.settings_service_cpu_memory_chart)) {
        Column {
            LoadChart(data.series, Modifier.fillMaxWidth().height(140.dp).padding(metrics.pageInset))
            Legend(listOf("CPU" to colors.accent, stringResource(Res.string.settings_service_memory) to colors.success))
        }
    }

    SettingsGroup(stringResource(Res.string.settings_service_status_codes)) {
        val status = data.requests.byStatus
        val parts = listOf("2xx" to status.status2xx, "3xx" to status.status3xx, "4xx" to status.status4xx, "5xx" to status.status5xx)
        val tints = listOf(colors.success, colors.accent, colors.warning, colors.danger)
        val total = parts.sumOf { it.second }.coerceAtLeast(1)
        Row(Modifier.fillMaxWidth().padding(metrics.pageInset), verticalAlignment = Alignment.CenterVertically) {
            Canvas(Modifier.size(88.dp)) {
                var start = -90f
                parts.forEachIndexed { index, (_, count) ->
                    val sweep = 360f * count / total
                    if (sweep > 0f) drawArc(tints[index], start, sweep, useCenter = false, style = Stroke(width = 14.dp.toPx()))
                    start += sweep
                }
            }
            Spacer(Modifier.width(20.dp))
            Column(verticalArrangement = Arrangement.spacedBy(metrics.controlInset / 3)) {
                parts.forEachIndexed { index, (label, count) ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(8.dp).clip(CircleShape).background(tints[index]))
                        Spacer(Modifier.width(8.dp))
                        Text("$label  $count", style = typography.caption, color = colors.fg2)
                        Text("  ${round(count * 100.0 / total).toInt()}%", style = typography.caption, color = colors.fg4)
                    }
                }
            }
        }
    }

    if (data.requests.topRoutes.isNotEmpty()) {
        SettingsGroup(stringResource(Res.string.settings_service_top_routes)) {
            val top = data.requests.topRoutes.maxOf { it.count }.coerceAtLeast(1)
            Column(Modifier.fillMaxWidth().padding(metrics.pageInset), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                data.requests.topRoutes.forEach { route ->
                    Column {
                        Text("${route.method} ${route.route}", style = typography.caption, color = colors.fg)
                        Text(stringResource(Res.string.settings_service_route_count, route.count, fixed(route.avgMs), fixed(route.p95Ms)), style = typography.caption, color = colors.fg3)
                        Spacer(Modifier.height(4.dp))
                        Meter(route.count.toDouble() / top, if (route.errors > 0) colors.danger else colors.accent)
                    }
                }
            }
        }
    }

    SettingsGroup(stringResource(Res.string.settings_service_service)) {
        Info(stringResource(Res.string.settings_version), stringResource(Res.string.settings_service_version_value, data.process.version, data.process.pid))
        Info(stringResource(Res.string.settings_service_runtime), "Node ${data.process.nodeVersion} · ${data.process.platform}/${data.process.arch}")
        Info(stringResource(Res.string.settings_service_host), "${data.host.hostname} · ${data.host.cpuModel}")
        Info(stringResource(Res.string.settings_service_connections), stringResource(Res.string.settings_service_connection_detail, data.connections.eventStreams, data.connections.terminalSockets))
        Info(stringResource(Res.string.settings_service_terminals), stringResource(Res.string.settings_service_terminal_detail, data.terminals.live, data.terminals.total))
        Info(stringResource(Res.string.settings_service_sessions), stringResource(Res.string.settings_service_session_detail, data.sessions.running, data.sessions.waiting, data.sessions.total))
    }

    if (data.processes.isNotEmpty()) {
        SettingsGroup(stringResource(Res.string.settings_service_processes, data.processes.size)) {
            val maxCpu = data.processes.maxOf { it.cpuPercent }.coerceAtLeast(1.0)
            data.processes.forEach { process ->
                ProcessRow(process, maxCpu, depth = depthOf(process, data.processes), onStop = { confirming = process })
            }
        }
    }

    confirming?.let { process ->
        AlertDialog(
            onDismissRequest = { confirming = null },
            title = { Text(stringResource(Res.string.settings_service_end_process_title, process.name)) },
            text = { Text(stringResource(Res.string.settings_service_end_process_body, process.pid, process.command), maxLines = 8, overflow = TextOverflow.Ellipsis) },
            confirmButton = {
                RiffetTextButton(danger = true, onClick = {
                    confirming = null
                    scope.launch {
                        try { api.terminateServiceProcess(process.pid); read() } catch (cancellation: CancellationException) { throw cancellation } catch (failure: Throwable) {
                            error = failure.message?.takeIf { it.isNotBlank() } ?: endFailed
                        }
                    }
                }) { Text(stringResource(Res.string.settings_service_end_process)) }
            },
            dismissButton = { RiffetTextButton(onClick = { confirming = null }) { Text(stringResource(Res.string.settings_cancel)) } },
        )
    }
}

private data class Tile(val title: String, val value: String, val detail: String, val series: List<Double>, val tint: Color, val meter: Double? = null)

@Composable
private fun KpiTile(tile: Tile, modifier: Modifier) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    Column(modifier.cardEdge(GroupShape).clip(GroupShape).background(LocalRiffetSurfaces.current.card).padding(14.dp)) {
        Text(tile.title, style = typography.caption, color = colors.fg3)
        Spacer(Modifier.height(4.dp))
        Text(tile.value, style = typography.title, color = colors.fg, maxLines = 1)
        Spacer(Modifier.height(6.dp))
        Sparkline(tile.series, tile.tint, Modifier.fillMaxWidth().height(28.dp))
        tile.meter?.let { Spacer(Modifier.height(6.dp)); Meter(it, tile.tint) }
        Spacer(Modifier.height(6.dp))
        Text(tile.detail, style = typography.caption, color = colors.fg4, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun Sparkline(values: List<Double>, tint: Color, modifier: Modifier) {
    Canvas(modifier) {
        if (values.size < 2) return@Canvas
        val top = values.max().coerceAtLeast(1e-9)
        val step = size.width / (values.size - 1)
        val line = Path()
        values.forEachIndexed { index, value ->
            val point = Offset(index * step, size.height - (value / top).toFloat() * size.height)
            if (index == 0) line.moveTo(point.x, point.y) else line.lineTo(point.x, point.y)
        }
        val area = Path().apply { addPath(line); lineTo(size.width, size.height); lineTo(0f, size.height); close() }
        drawPath(area, tint.copy(alpha = 0.14f))
        drawPath(line, tint, style = Stroke(width = 1.6.dp.toPx(), cap = StrokeCap.Round))
    }
}

@Composable
private fun Meter(fraction: Double, tint: Color) {
    // The track is the grouped page's tone, so it reads sunk into the card it sits on.
    Box(Modifier.fillMaxWidth().height(5.dp).clip(CircleShape).background(LocalRiffetSurfaces.current.groupedPage)) {
        Box(Modifier.fillMaxWidth(fraction.coerceIn(0.0, 1.0).toFloat()).height(5.dp).clip(CircleShape).background(tint))
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

@Composable
private fun Info(label: String, value: String) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    Row(Modifier.fillMaxWidth().padding(horizontal = metrics.pageInset, vertical = metrics.rowPadding)) {
        Text(label, style = typography.bodySmall, color = colors.fg3, modifier = Modifier.width(72.dp))
        Text(value, style = typography.bodySmall, color = colors.fg, modifier = Modifier.weight(1f))
    }
}

@Composable
private fun ProcessRow(process: ServiceProcess, maxCpu: Double, depth: Int, onStop: () -> Unit) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val tint = when (process.kind) { "server" -> colors.accent; "tmux" -> colors.success; "agent" -> colors.warning; else -> colors.fg3 }
    val kind = when (process.kind) { "server" -> stringResource(Res.string.settings_service_server_process); "tmux" -> "tmux"; "agent" -> "Agent"; else -> stringResource(Res.string.settings_service_child_process) }
    Row(Modifier.fillMaxWidth().padding(start = 16.dp + (depth * 14).dp, end = 12.dp, top = 12.dp, bottom = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(kind, style = typography.caption, color = tint, modifier = Modifier.clip(RoundedCornerShape(metrics.controlRadius / 2)).background(tint.copy(alpha = 0.14f)).padding(horizontal = 6.dp, vertical = 1.dp))
                Spacer(Modifier.width(8.dp))
                Text(process.name, style = typography.body, color = colors.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                Text("  ${process.pid}", style = typography.caption, color = colors.fg4)
            }
            process.sessionTitle?.let { Text(it, style = typography.caption, color = colors.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            Spacer(Modifier.height(6.dp))
            Meter(process.cpuPercent / maxCpu, tint)
            Spacer(Modifier.height(4.dp))
            Text("CPU ${percent(process.cpuPercent)} · ${bytes(process.rssBytes)} · ${duration(process.elapsedSec)}", style = typography.caption, color = colors.fg4)
        }
        if (process.canTerminate) {
            Spacer(Modifier.width(10.dp))
            SettingsButton(stringResource(Res.string.settings_service_end), onClick = onStop, danger = true)
        }
    }
}

/** How deep [process] sits under the listed processes, for indentation. */
private fun depthOf(process: ServiceProcess, all: List<ServiceProcess>): Int {
    val byPid = all.associateBy { it.pid }
    var depth = 0
    var parent = byPid[process.ppid]
    while (parent != null && depth < 4) { depth++; parent = byPid[parent.ppid] }
    return depth
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
