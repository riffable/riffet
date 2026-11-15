package riffet.ui.stats

import riffet.ui.design.LocalRiffetSurfaces
import riffet.ui.design.LocalInterfaceStyle
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.AnimationVector1D
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.updateTransition
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import org.jetbrains.compose.resources.stringResource
import org.jetbrains.compose.resources.rememberResourceEnvironment
import riffet_mobile.shared.generated.resources.*
import riffet.contracts.NativeBackendId
import riffet.stats.CalendarCell
import riffet.stats.LatencyMark
import riffet.stats.NamedValue
import riffet.stats.ReliabilityRow
import riffet.stats.STATS_UNAVAILABLE
import riffet.stats.SeriesTrack
import riffet.stats.axisTicks
import riffet.stats.blendTracks
import riffet.stats.compactCount
import riffet.stats.donutSlices
import riffet.stats.heatmapLevel
import riffet.stats.hitDonut
import riffet.stats.latencyDomain
import riffet.stats.lerp
import riffet.stats.scrubIndex
import riffet.stats.stackCumulatives
import riffet.theme.RiffetColors
import riffet.ui.haptics.rememberAppHaptics
import riffet.ui.theme.LocalRiffetDarkTheme
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet.ui.theme.LocalRiffetMotion
import riffet.ui.timeline.motionDuration
import riffet.ui.timeline.rememberReducedMotion

/**
 * Uses a stable key to choose a categorical colour, so sorting a breakdown never changes its colour.
 * Agent series keep a fixed palette slot in [RiffetColors] in both themes.
 */
internal fun RiffetColors.seriesColor(key: String, backendId: NativeBackendId?): Color =
    (backendId ?: when (key) {
        "cursor" -> NativeBackendId.CURSOR
        "codex" -> NativeBackendId.CODEX
        "claude" -> NativeBackendId.CLAUDE
        "dsh" -> NativeBackendId.DSH
        "droid" -> NativeBackendId.DROID
        "traex" -> NativeBackendId.TRAEX
        "pi" -> NativeBackendId.PI
        "antigravity" -> NativeBackendId.ANTIGRAVITY
        "chat" -> NativeBackendId.CHAT
        else -> null
    })?.let(::agentColor) ?: chartColor(stableChartIndex(key))

/** Java-compatible String.hashCode over UTF-16 code units, with a non-negative chart slot. */
internal fun stableChartIndex(key: String): Int {
    var hash = 0
    key.forEach { character -> hash = hash * 31 + character.code }
    return ((hash % 8) + 8) % 8
}

internal fun RiffetColors.agentColor(backendId: NativeBackendId): Color = when (backendId) {
    NativeBackendId.CURSOR -> chart1
    NativeBackendId.CODEX -> chart2
    NativeBackendId.CLAUDE -> chart3
    NativeBackendId.DSH -> chart4
    NativeBackendId.DROID -> chart5
    NativeBackendId.TRAEX -> chart6
    NativeBackendId.CHAT -> chart7
    NativeBackendId.PI -> chart8
    NativeBackendId.ANTIGRAVITY -> chartColor(stableChartIndex("antigravity"))
}

internal fun RiffetColors.chartColor(index: Int): Color = when (index.mod(8)) {
    0 -> chart1
    1 -> chart2
    2 -> chart3
    3 -> chart4
    4 -> chart5
    5 -> chart6
    6 -> chart7
    else -> chart8
}

/** Same allocation as the web: fixed Agent slots, then sorted keys with collision probing. */
internal fun RiffetColors.seriesColors(keys: List<String>): Map<String, Color> {
    val slots = linkedMapOf<String, Int>()
    val used = mutableSetOf<Int>()
    val ordered = keys.distinct().sorted()
    val backends = listOf("cursor", "codex", "claude", "dsh", "droid", "traex", "chat", "pi")
    ordered.forEach { key ->
        val slot = backends.indexOf(key)
        if (slot >= 0) { slots[key] = slot; used.add(slot) }
    }
    ordered.forEach { key ->
        if (key !in slots) {
            var slot = stableChartIndex(key)
            var probe = 0
            while (probe < 8 && slot in used) { slot = (slot + 1) % 8; probe++ }
            slots[key] = slot
            used.add(slot)
        }
    }
    return slots.mapValues { (_, slot) -> chartColor(slot) }
}

@Composable
internal fun StackedAreaChart(
    tracks: List<SeriesTrack>,
    labels: List<String>,
    modifier: Modifier = Modifier,
) {
    val colors = LocalRiffetColors.current
    val lineWidth = LocalInterfaceStyle.current.metrics.hairlineWidth
    val typography = LocalRiffetTypography.current
    val darkTheme = LocalRiffetDarkTheme.current
    val shown = rememberMorphedTracks(tracks)
    val reveal = rememberReveal(hasData = tracks.isNotEmpty())
    if (tracks.isEmpty()) {
        EmptyChart(stringResource(Res.string.stats_empty_trend), modifier)
        return
    }
    val plotting = shown.ifEmpty { tracks }
    val palette = colors.seriesColors(plotting.map { it.key })
    val count = plotting.first().values.size
    val columns = List(count) { index -> plotting.map { it.values.getOrElse(index) { 0.0 }.coerceAtLeast(0.0) } }
    val cumulative = stackCumulatives(columns)
    val max = cumulative.maxOfOrNull { it.lastOrNull() ?: 0.0 }?.coerceAtLeast(1.0) ?: 1.0
    val ticks = axisTicks(max)
    val scaleTop = ticks.lastOrNull() ?: max
    val xLabelCount = minOf(4, count - 1).coerceAtLeast(0)
    val xLabelIndices = if (count <= 1) listOf(0) else
        (0..xLabelCount).map { index -> (index * (count - 1) / xLabelCount).coerceIn(0, count - 1) }.distinct()
    var scrub by remember { mutableStateOf<Int?>(null) }
    val haptics = rememberAppHaptics()
    var lastBuzz by remember { mutableStateOf<Int?>(null) }
    var box by remember { mutableStateOf(IntSize.Zero) }
    val density = LocalDensity.current
    val leftPx = with(density) { 40.dp.toPx() }
    val rightPx = with(density) { 8.dp.toPx() }
    val topPx = with(density) { 12.dp.toPx() }
    val bottomPx = with(density) { 18.dp.toPx() }
    fun move(index: Int?) {
        scrub = index
        if (index != null && index != lastBuzz) {
            // TextHandleMove is the selection tick SelectionHaptics isolates from transcripts.
            // A chart uses it on purpose, and rememberAppHaptics still honours the haptic switch.
            lastBuzz = index
            haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
        }
        if (index == null) lastBuzz = null
    }
    Column(modifier) {
        Box(
            Modifier
                .fillMaxWidth()
                .height(200.dp)
                .onSizeChanged { box = it }
                .pointerInput(count, box) {
                    detectDragGesturesAfterLongPress(
                        onDragStart = { offset ->
                            move(scrubIndex(offset.x, leftPx, box.width - rightPx, count))
                        },
                        onDrag = { change, _ ->
                            change.consume()
                            move(scrubIndex(change.position.x, leftPx, box.width - rightPx, count))
                        },
                        onDragEnd = { move(null) },
                        onDragCancel = { move(null) },
                    )
                },
        ) {
            Canvas(Modifier.fillMaxSize()) {
                val plotLeft = leftPx
                val plotRight = size.width - rightPx
                val plotTop = topPx
                val plotBottom = size.height - bottomPx
                fun xAt(index: Int): Float = if (count <= 1) (plotLeft + plotRight) / 2f else plotLeft + (plotRight - plotLeft) * index / (count - 1)
                fun yAt(value: Double): Float = plotBottom - ((value / scaleTop).toFloat().coerceIn(0f, 1f) * (plotBottom - plotTop))
                // The series rise from the baseline on first show while the axis already stands at its final scale.
                val rise = reveal.value.toDouble()
                fun yData(value: Double): Float = yAt(value * rise)
                ticks.forEach { tick ->
                    val y = yAt(tick)
                    drawLine(colors.line, Offset(plotLeft, y), Offset(plotRight, y), strokeWidth = lineWidth.toPx())
                }
                plotting.indices.forEach { series ->
                    val track = plotting[series]
                    val color = palette.getValue(track.key)
                    val upperPoints = List(count) { index ->
                        val upper = cumulative.getOrNull(index)?.getOrNull(series) ?: 0.0
                        Offset(xAt(index), yData(upper))
                    }
                    val lowerPoints = List(count) { index ->
                        val lower = if (series == 0) 0.0 else cumulative.getOrNull(index)?.getOrNull(series - 1) ?: 0.0
                        Offset(xAt(index), yData(lower))
                    }
                    val path = Path()
                    path.appendSmoothCurve(upperPoints)
                    path.appendSmoothCurve(lowerPoints.asReversed(), connectToCurrent = true)
                    path.close()
                    drawPath(path, color.copy(alpha = if (darkTheme) 0.28f else 0.22f))
                    val topEdge = Path()
                    topEdge.appendSmoothCurve(upperPoints)
                    drawPath(topEdge, color, style = Stroke(width = 1.5f))
                    if (count == 1) {
                        drawCircle(color, radius = 3.5f, center = upperPoints.first())
                    }
                }
                val index = scrub
                if (index != null && index in 0 until count) {
                    val x = xAt(index)
                    drawLine(colors.fg3, Offset(x, plotTop), Offset(x, plotBottom), strokeWidth = 1.5f)
                    plotting.indices.forEach { series ->
                        val track = plotting[series]
                        val upper = cumulative.getOrNull(index)?.getOrNull(series) ?: 0.0
                        drawCircle(palette.getValue(track.key), radius = 3.5f, center = Offset(x, yData(upper)))
                    }
                }
            }
            Column(
                Modifier
                    .align(Alignment.TopStart)
                    .width(40.dp)
                    .fillMaxHeight()
                    .padding(top = 5.dp, bottom = 11.dp, end = 6.dp),
                verticalArrangement = Arrangement.SpaceBetween,
            ) {
                ticks.asReversed().forEach { tick ->
                    Text(
                        compactCount(tick),
                        style = typography.caption,
                        color = colors.fg4,
                        textAlign = TextAlign.End,
                        maxLines = 1,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
            val index = scrub
            if (index != null && plotting.isNotEmpty() && index < plotting.first().values.size) {
                Column(
                    Modifier
                        .align(Alignment.TopEnd)
                        .padding(6.dp)
                        .clip(RoundedCornerShape(LocalInterfaceStyle.current.controlRadius))
                        .background(LocalRiffetSurfaces.current.floating)
                        .border(LocalInterfaceStyle.current.metrics.hairlineWidth, colors.line,
                            RoundedCornerShape(LocalInterfaceStyle.current.controlRadius))
                        .padding(horizontal = 8.dp, vertical = 6.dp),
                ) {
                    Text(labels.getOrElse(index) { "" }, style = typography.caption, color = colors.fg2, maxLines = 1)
                    plotting.forEach { track ->
                        val value = track.values.getOrElse(index) { 0.0 }
                        Text(
                            "${track.label} ${compactCount(value)}",
                            style = typography.caption,
                            color = colors.fg,
                            maxLines = 1,
                        )
                    }
                }
            }
        }
        BoxWithConstraints(
            Modifier.fillMaxWidth().padding(start = 40.dp, end = 8.dp).height(18.dp),
        ) {
            val labelWidth = 56.dp.coerceAtMost(maxWidth)
            xLabelIndices.forEach { point ->
                val fraction = if (count <= 1) 0.5f else point.toFloat() / (count - 1)
                val left = (maxWidth * fraction - labelWidth / 2).coerceIn(0.dp, maxWidth - labelWidth)
                Text(
                    labels.getOrElse(point) { "" },
                    style = typography.caption,
                    color = colors.fg4,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    textAlign = when {
                        count <= 1 -> TextAlign.Center
                        point == 0 -> TextAlign.Start
                        point == count - 1 -> TextAlign.End
                        else -> TextAlign.Center
                    },
                    modifier = Modifier.offset(x = left).width(labelWidth),
                )
            }
        }
        Legend(plotting.map { track -> track.label to palette.getValue(track.key) })
    }
}

@Composable
internal fun DonutChart(
    weights: List<NamedValue>,
    modifier: Modifier = Modifier,
) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val reduced = rememberReducedMotion()
    val morphed = rememberMorphedValues(weights).ifEmpty { weights }
    val reveal = rememberReveal(hasData = weights.isNotEmpty())
    val palette = colors.seriesColors(morphed.map { it.key })
    val slices = donutSlices(morphed.map { it.key to it.value })
    var selected by remember { mutableStateOf<String?>(null) }
    val transition = updateTransition(targetState = selected, label = "donut")
    val motion = LocalRiffetMotion.current
    val dim by transition.animateFloat(
        transitionSpec = { tween(motionDuration(reduced, motion.SHORT), easing = motion.Standard) },
        label = "dim",
    ) { highlighted -> if (highlighted == null) 1f else 0.35f }
    val total = morphed.sumOf { it.value }
    val selectedValue = morphed.firstOrNull { it.key == selected }
    if (slices.isEmpty()) {
        EmptyChart(stringResource(Res.string.stats_empty_share), modifier)
        return
    }
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        Box(
            Modifier.size(200.dp).pointerInput(slices) {
                detectTapGestures { offset ->
                    val center = Offset(size.width / 2f, size.height / 2f)
                    val outer = minOf(size.width, size.height) * 0.40f
                    val stroke = outer * 0.42f
                    val inner = outer - stroke / 2f
                    val hit = hitDonut(
                        slices,
                        (offset.x - center.x).toDouble(),
                        (offset.y - center.y).toDouble(),
                        inner.toDouble(),
                        (outer + stroke / 2f).toDouble(),
                    )
                    selected = if (hit == null || hit == selected) null else hit
                }
            },
            contentAlignment = Alignment.Center,
        ) {
            Canvas(Modifier.fillMaxSize()) {
                val outer = size.minDimension * 0.40f
                val stroke = outer * 0.42f
                val topLeft = Offset((size.width - outer * 2) / 2f, (size.height - outer * 2) / 2f)
                val arcSize = Size(outer * 2, outer * 2)
                slices.forEachIndexed { index, slice ->
                    val color = palette.getValue(slice.key)
                    val alpha = if (selected == null || selected == slice.key) 1f else dim
                    // On first show the ring is drawn clockwise from 12 o'clock.
                    val sweep = (reveal.value * 360.0 - (slice.start + 90.0)).coerceIn(0.0, slice.sweep)
                    if (sweep <= 0.0) return@forEachIndexed
                    drawArc(
                        color = color.copy(alpha = alpha),
                        startAngle = slice.start.toFloat(),
                        sweepAngle = sweep.toFloat(),
                        useCenter = false,
                        topLeft = topLeft,
                        size = arcSize,
                        style = Stroke(width = stroke),
                    )
                }
            }
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(
                    selectedValue?.label ?: stringResource(Res.string.stats_total),
                    style = typography.caption,
                    color = colors.fg3,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(compactCount(selectedValue?.value ?: total), style = typography.title, color = colors.fg, maxLines = 1)
            }
        }
        Legend(morphed.map { value -> value.label to palette.getValue(value.key) })
    }
}

@Composable
internal fun HorizontalBars(
    rows: List<NamedValue>,
    modifier: Modifier = Modifier,
) {
    val motion = LocalRiffetMotion.current
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val reduced = rememberReducedMotion()
    if (rows.isEmpty() || rows.all { it.value <= 0.0 }) {
        EmptyChart(stringResource(Res.string.stats_empty_ranking), modifier)
        return
    }
    val max = rows.maxOf { it.value }.coerceAtLeast(1.0)
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        rows.forEach { row -> key(row.key) {
            val fraction = (row.value / max).toFloat().coerceIn(0f, 1f)
            // A new row grows from empty; a changed one moves from where it stood.
            val anim = remember(row.key) { Animatable(if (reduced) fraction else 0f) }
            LaunchedEffect(fraction, reduced, motion) {
                if (reduced) anim.snapTo(fraction) else anim.animateTo(fraction, motion.enter())
            }
            Column {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(row.label, style = typography.body, color = colors.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    Text(compactCount(row.value), style = typography.body.copy(fontFeatureSettings = "tnum"), color = colors.fg, maxLines = 1, modifier = Modifier.padding(start = 12.dp))
                }
                Canvas(Modifier.fillMaxWidth().height(8.dp).padding(top = 2.dp)) {
                    drawRoundRect(colors.bgMuted, cornerRadius = CornerRadius(8f, 8f), size = Size(size.width, size.height))
                    drawRoundRect(
                        colors.accent,
                        size = Size(size.width * anim.value, size.height),
                        cornerRadius = CornerRadius(8f, 8f),
                    )
                }
            }
        } }
    }
}

@Composable
internal fun WeekHourHeatmap(cells: List<List<Long>>, modifier: Modifier = Modifier) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val max = cells.maxOfOrNull { row -> row.maxOrNull() ?: 0L } ?: 0L
    val weekdays = listOf(
        stringResource(Res.string.stats_weekday_mon),
        stringResource(Res.string.stats_weekday_tue),
        stringResource(Res.string.stats_weekday_wed),
        stringResource(Res.string.stats_weekday_thu),
        stringResource(Res.string.stats_weekday_fri),
        stringResource(Res.string.stats_weekday_sat),
        stringResource(Res.string.stats_weekday_sun),
    )
    // Seven rows by six four-hour blocks: at 360dp a 24-column grid has 9dp cells, blocks have ~40dp ones.
    val blocks = 6
    val grid = List(7) { day -> List(blocks) { block -> (0 until 4).sumOf { cells.getOrNull(day)?.getOrNull(block * 4 + it) ?: 0L } } }
    val blockMax = grid.maxOfOrNull { row -> row.maxOrNull() ?: 0L } ?: 0L
    Column(modifier) {
        Row(Modifier.fillMaxWidth().height(196.dp)) {
            Column(Modifier.width(24.dp).fillMaxSize()) {
                weekdays.forEach { day ->
                    Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.CenterStart) {
                        Text(day, style = typography.caption, color = colors.fg3, maxLines = 1)
                    }
                }
            }
            Canvas(Modifier.weight(1f).fillMaxSize()) {
                val gap = 3.dp.toPx()
                val cellW = ((size.width - gap * (blocks - 1)) / blocks).coerceAtLeast(1f)
                val rowPitch = size.height / 7
                val cellH = (rowPitch - gap).coerceAtLeast(1f)
                for (day in 0 until 7) {
                    for (block in 0 until blocks) {
                        drawRoundRect(
                            heatColor(colors, heatmapLevel(grid[day][block], blockMax)),
                            topLeft = Offset(block * (cellW + gap), day * rowPitch),
                            size = Size(cellW, cellH),
                            cornerRadius = CornerRadius(4.dp.toPx(), 4.dp.toPx()),
                        )
                    }
                }
            }
        }
        Row(Modifier.fillMaxWidth().padding(start = 24.dp, top = 4.dp)) {
            listOf("0", "4", "8", "12", "16", "20").forEach { label ->
                Text(label, style = typography.caption.copy(fontFeatureSettings = "tnum"), color = colors.fg3, maxLines = 1, modifier = Modifier.weight(1f))
            }
        }
    }
}

@Composable
internal fun CalendarHeatmap(weeks: List<List<CalendarCell>>, modifier: Modifier = Modifier) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    // Seven rows by at most twelve weeks, so a cell is ~20dp at 360dp; a year-long range shows its latest quarter.
    val shown = weeks.takeLast(12)
    val days = shown.flatten().mapNotNull { it.date }
    if (days.isEmpty()) {
        EmptyChart(stringResource(Res.string.stats_empty_daily), modifier)
        return
    }
    fun short(date: String): String = date.split("-").let { p -> if (p.size == 3) "${p[1].toIntOrNull() ?: p[1]}/${p[2].toIntOrNull() ?: p[2]}" else date }
    val dateRange = if (days.size == 1) short(days.first()) else "${short(days.first())} – ${short(days.last())}"
    Column(modifier) {
        Text(dateRange, style = typography.caption.copy(fontFeatureSettings = "tnum"), color = colors.fg3, maxLines = 1, modifier = Modifier.padding(bottom = 8.dp))
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val gap = 3.dp
            val cell = ((maxWidth - gap * (shown.size - 1).toFloat()) / shown.size.toFloat()).coerceAtMost(28.dp)
            Canvas(Modifier.width(cell * shown.size.toFloat() + gap * (shown.size - 1).toFloat()).height(cell * 7f + gap * 6f)) {
                shown.forEachIndexed { col, week ->
                    week.forEachIndexed { row, item ->
                        drawRoundRect(
                            heatColor(colors, item.level),
                            topLeft = Offset(col * (cell + gap).toPx(), row * (cell + gap).toPx()),
                            size = Size(cell.toPx(), cell.toPx()),
                            cornerRadius = CornerRadius(4.dp.toPx(), 4.dp.toPx()),
                        )
                    }
                }
            }
        }
    }
}

@Composable
internal fun LatencyRangeChart(
    marks: List<LatencyMark>,
    format: (Double) -> String,
    modifier: Modifier = Modifier,
) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    if (marks.isEmpty()) {
        EmptyChart(stringResource(Res.string.stats_empty_latency), modifier)
        return
    }
    val domain = latencyDomain(marks)
    Column(modifier, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        marks.forEach { mark ->
            val low = mark.low
            val high = mark.high
            val color = colors.accent
            Column {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(mark.label, style = typography.body, color = colors.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    Text(
                        mark.mark?.let(format) ?: STATS_UNAVAILABLE,
                        style = typography.body.copy(fontFeatureSettings = "tnum"), color = colors.fg, maxLines = 1,
                        modifier = Modifier.padding(start = 12.dp),
                    )
                }
                Canvas(Modifier.fillMaxWidth().height(16.dp)) {
                    val midY = size.height / 2f
                    drawLine(colors.line, Offset(0f, midY), Offset(size.width, midY), strokeWidth = 2f)
                    if (low != null && high != null) {
                        val start = (minOf(low, high) / domain).toFloat().coerceIn(0f, 1f)
                        val end = (maxOf(low, high) / domain).toFloat().coerceIn(0f, 1f)
                        drawLine(color.copy(alpha = 0.78f), Offset(size.width * start, midY), Offset(size.width * end, midY), strokeWidth = 7f)
                    }
                    val tick = mark.mark
                    if (tick != null) {
                        val x = size.width * (tick / domain).toFloat().coerceIn(0f, 1f)
                        drawLine(colors.fg, Offset(x, 1f), Offset(x, size.height - 1f), strokeWidth = 1.5f)
                    }
                }
                rememberResourceEnvironment()
                if (low != null || high != null) {
                    Text(
                        "${low?.let(format) ?: STATS_UNAVAILABLE} – ${high?.let(format) ?: STATS_UNAVAILABLE}",
                        style = typography.caption.copy(fontFeatureSettings = "tnum"), color = colors.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

@Composable
internal fun ReliabilityChart(rows: List<ReliabilityRow>, modifier: Modifier = Modifier) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    if (rows.isEmpty()) {
        EmptyChart(stringResource(Res.string.stats_empty_reliability), modifier)
        return
    }
    val parts = listOf(
        stringResource(Res.string.stats_completed) to colors.success,
        stringResource(Res.string.stats_failed) to colors.danger,
        stringResource(Res.string.stats_cancelled) to colors.fg4,
        stringResource(Res.string.stats_interrupted) to colors.warning,
    )
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        rows.forEach { row ->
            val values = listOf(row.completed, row.failed, row.cancelled, row.interrupted)
            val total = values.sum().coerceAtLeast(1L)
            Column {
                Text(row.label, style = typography.body, color = colors.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Canvas(Modifier.fillMaxWidth().height(12.dp)) {
                    var x = 0f
                    values.forEachIndexed { index, value ->
                        if (value <= 0L) return@forEachIndexed
                        val width = size.width * (value.toFloat() / total.toFloat())
                        drawRect(parts[index].second, topLeft = Offset(x, 0f), size = Size(width, size.height))
                        x += width
                    }
                }
            }
        }
        Legend(parts)
    }
}

@Composable
@OptIn(ExperimentalLayoutApi::class)
private fun Legend(items: List<Pair<String, Color>>) {
    val typography = LocalRiffetTypography.current
    val colors = LocalRiffetColors.current
    FlowRow(
        Modifier.fillMaxWidth().padding(top = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        items.forEach { (label, color) ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(8.dp).clip(CircleShape).background(color))
                Spacer(Modifier.width(4.dp))
                Text(label, style = typography.caption, color = colors.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

@Composable
private fun EmptyChart(text: String, modifier: Modifier = Modifier) {
    riffet.ui.design.EmptyState(text, modifier, fill = false)
}

/**
 * 0 → 1 the first time [hasData] is true for this composition, so an empty chart does not use the
 * reveal up. It does not replay on later changes (the data morphs below cover those), but it does
 * start over if the chart leaves composition and returns, e.g. on pager re-entry.
 */
@Composable
private fun rememberReveal(hasData: Boolean): Animatable<Float, AnimationVector1D> {
    val motion = LocalRiffetMotion.current
    val reduced = rememberReducedMotion()
    val reveal = remember { Animatable(if (reduced) 1f else 0f) }
    LaunchedEffect(hasData, reduced, motion) {
        if (hasData && reveal.value < 1f) {
            if (reduced) reveal.snapTo(1f) else reveal.animateTo(1f, motion.enter())
        }
    }
    return reveal
}

@Composable
private fun rememberMorphedTracks(tracks: List<SeriesTrack>): List<SeriesTrack> {
    val motion = LocalRiffetMotion.current
    val reduced = rememberReducedMotion()
    var from by remember { mutableStateOf(emptyList<SeriesTrack>()) }
    var to by remember { mutableStateOf(emptyList<SeriesTrack>()) }
    var hasData by remember { mutableStateOf(false) }
    val progress = remember { Animatable(1f) }
    LaunchedEffect(tracks, reduced, motion) {
        if (tracks.isEmpty()) {
            from = emptyList()
            to = emptyList()
            progress.snapTo(1f)
            hasData = false
            return@LaunchedEffect
        }
        if (!hasData) {
            from = tracks
            to = tracks
            progress.snapTo(1f)
            hasData = true
            return@LaunchedEffect
        }
        from = blendTracks(from, to, progress.value)
        to = tracks
        if (reduced) progress.snapTo(1f) else {
            progress.snapTo(0f)
            progress.animateTo(1f, motion.enter())
        }
    }
    return blendTracks(from, to, progress.value)
}

@Composable
private fun rememberMorphedValues(weights: List<NamedValue>): List<NamedValue> {
    val motion = LocalRiffetMotion.current
    val reduced = rememberReducedMotion()
    var from by remember { mutableStateOf(emptyList<NamedValue>()) }
    var to by remember { mutableStateOf(emptyList<NamedValue>()) }
    var hasData by remember { mutableStateOf(false) }
    val progress = remember { Animatable(1f) }
    LaunchedEffect(weights, reduced, motion) {
        if (weights.isEmpty()) {
            from = emptyList()
            to = emptyList()
            progress.snapTo(1f)
            hasData = false
            return@LaunchedEffect
        }
        if (!hasData) {
            from = weights
            to = weights
            progress.snapTo(1f)
            hasData = true
            return@LaunchedEffect
        }
        from = blendNamedValues(from, to, progress.value)
        to = weights
        if (reduced) progress.snapTo(1f) else {
            progress.snapTo(0f)
            progress.animateTo(1f, motion.enter())
        }
    }
    return blendNamedValues(from, to, progress.value)
}

private fun blendNamedValues(from: List<NamedValue>, to: List<NamedValue>, t: Float): List<NamedValue> {
    val keys = (to.map { it.key } + from.map { it.key }).distinct()
    return keys.mapNotNull { key ->
        val start = from.firstOrNull { it.key == key }
        val end = to.firstOrNull { it.key == key }
        val sample = end ?: start ?: return@mapNotNull null
        sample.copy(value = lerp(start?.value ?: 0.0, end?.value ?: 0.0, t).coerceAtLeast(0.0))
    }
}

private fun heatColor(colors: RiffetColors, level: Int): Color = when (level) {
    0 -> colors.bgMuted
    1 -> colors.accent.copy(alpha = 0.18f).compositeOver(colors.bgMuted)
    2 -> colors.accent.copy(alpha = 0.38f).compositeOver(colors.bgMuted)
    3 -> colors.accent.copy(alpha = 0.62f).compositeOver(colors.bgMuted)
    else -> colors.accent.copy(alpha = 0.9f).compositeOver(colors.bgMuted)
}

/** Uses a bounded smoothstep curve: every segment stays between its sample values. */
private fun Path.appendSmoothCurve(points: List<Offset>, connectToCurrent: Boolean = false) {
    if (points.isEmpty()) return
    val first = points.first()
    if (connectToCurrent) lineTo(first.x, first.y) else moveTo(first.x, first.y)
    for (index in 1 until points.size) {
        val previous = points[index - 1]
        val next = points[index]
        val middleX = (previous.x + next.x) / 2f
        cubicTo(middleX, previous.y, middleX, next.y, next.x, next.y)
    }
}
