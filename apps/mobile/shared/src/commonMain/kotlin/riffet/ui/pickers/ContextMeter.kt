package riffet.ui.pickers

import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import riffet.ui.icons.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlin.math.roundToInt
import org.jetbrains.compose.resources.stringResource
import riffet_mobile.shared.generated.resources.*
import riffet.contracts.NativeContext
import riffet.theme.RiffetColors
import riffet.ui.icons.RiffetIcons
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.LocalRiffetSurfaces

/*
 * ============================================================================================
 * Context-window gauge - `Composer.tsx`'s `ContextMeter`, ported
 * ============================================================================================
 *
 * One rule decides whether this renders at all: the backend either reported an occupancy or it did
 * not. Cursor reads `used`/`size` out of its own chat store; a backend that has no such store sends
 * nothing, and then this composable draws nothing. An empty ring at 0% would be a fabricated
 * measurement, which is the one thing the web's comment on `ContextMeter` refuses to do.
 *
 * The colours follow the web exactly: >=90% danger, >=75% warning, otherwise the neutral icon colour.
 */

/** The web's `contextLabels`: the breakdown ids the server sends, in the operator's language. */
@Composable
private fun contextPartLabel(id: String, parts: List<riffet.contracts.NativeContextBreakdown>, fallback: String): String = when (id) {
    "system_prompt", "systemPrompt" -> stringResource(Res.string.pickers_context_system_prompt)
    "tools", "toolDefinitions" -> stringResource(Res.string.pickers_context_tools)
    "rules" -> stringResource(Res.string.pickers_context_rules)
    "skills" -> "Skills"
    "mcp" -> stringResource(Res.string.pickers_context_mcp)
    "subagents" -> stringResource(Res.string.pickers_context_subagents)
    "summarized_conversation" -> stringResource(Res.string.pickers_context_summarized)
    "conversation" -> stringResource(Res.string.pickers_context_conversation)
    "cached_input" -> stringResource(Res.string.pickers_context_cached_input)
    "cacheRead" -> stringResource(Res.string.pickers_context_cache_read)
    "cache_write", "cacheWrite" -> stringResource(Res.string.pickers_context_cache_write)
    "input" -> {
        val splitFromCache = parts.any { it.id == "cached_input" || it.id == "cacheRead" || it.id == "cacheWrite" }
        stringResource(if (splitFromCache) Res.string.pickers_context_uncached_input else Res.string.pickers_context_input)
    }
    "output" -> {
        val splitFromReasoning = parts.any { it.id == "reasoning_output" }
        stringResource(if (splitFromReasoning) Res.string.pickers_context_response_output else Res.string.pickers_context_output)
    }
    "reasoning_output" -> stringResource(Res.string.pickers_context_reasoning_output)
    "developerMessages" -> stringResource(Res.string.pickers_context_developer_messages)
    "userMessages" -> stringResource(Res.string.pickers_context_user_messages)
    "assistantMessages" -> stringResource(Res.string.pickers_context_assistant_messages)
    "toolResponses" -> stringResource(Res.string.pickers_context_tool_responses)
    "otherMessages" -> stringResource(Res.string.pickers_context_other_messages)
    else -> fallback
}

private fun formatContextShare(tokens: Long, base: Long): String {
    val pct = tokens.toDouble() / maxOf(1L, base).toDouble() * 100.0
    return if (tokens > 0L && pct < 1.0) "<1%" else "${pct.roundToInt()}%"
}

/** `compactTokens` from the web: `1.2k`, `42k`, `900`. */
internal fun compactTokens(value: Long): String = when {
    value >= 10_000L -> "${(value + 500L) / 1_000L}k"
    value >= 1_000L -> "${((value + 50L) / 100L) / 10.0}k"
    else -> value.toString()
}

private fun ratioOf(usage: NativeContext): Float =
    (usage.used.toDouble() / usage.size.toDouble()).coerceIn(0.0, 1.0).toFloat()

private fun percentOf(usage: NativeContext): Int = (usage.used.toDouble() / usage.size * 100).roundToInt()

@Composable
private fun titleOf(usage: NativeContext): String = if (usage.limitKind == "compaction") stringResource(Res.string.pickers_context_compaction) else stringResource(Res.string.pickers_context_title)

private fun toneFor(ratio: Float, colors: RiffetColors): Color = when {
    ratio >= 0.9f -> colors.danger
    ratio >= 0.75f -> colors.warning
    else -> colors.fg2
}

/**
 * The gauge as a row of the send-settings sheet: the ring where a row's icon goes, the share and
 * the token counts under the label, and the breakdown one tap away.
 *
 * [usage] is null until the session's stream has sent a `context` frame, and the whole composable
 * renders nothing in that case - see the file comment.
 */
@Composable
internal fun ContextSummaryRow(usage: NativeContext?, onClick: () -> Unit) {
    val metrics = LocalInterfaceStyle.current.metrics
    if (usage == null || usage.size <= 0L) return
    val colors = LocalRiffetColors.current
    val ratio = ratioOf(usage)
    val recipe = LocalInterfaceStyle.current.components.lists
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = SheetGutter)
            .clip(SheetRowShape)
            .then(if (sheetRowsFilled) Modifier.background(LocalRiffetSurfaces.current.card) else Modifier)
            .pickerRowDivider()
            .clickable(role = Role.Button, onClick = onClick)
            .heightIn(min = maxOf(metrics.controlHeight, metrics.rowSubtitleHeight))
            .padding(start = (SheetInset - SheetGutter).coerceAtLeast(0.dp), end = if (recipe.compactChevron) metrics.rowPadding else metrics.controlInset / 4, top = (metrics.rowPadding / 2), bottom = (metrics.rowPadding / 2)),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ContextRing(ratio = ratio, tone = toneFor(ratio, colors), size = metrics.iconSize)
        Spacer(Modifier.width(metrics.rowPadding))
        Column(modifier = Modifier.weight(1f)) {
            Text(text = titleOf(usage), style = SheetRowText, color = colors.fg)
            Text(
                text = stringResource(Res.string.pickers_context_usage, "${percentOf(usage)}%", compactTokens(usage.used), compactTokens(usage.size)),
                style = LocalRiffetTypography.current.bodySmall,
                color = colors.fg2,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Spacer(Modifier.width(metrics.controlInset))
        Icon(RiffetIcons.ChevronRight, contentDescription = null, tint = colors.fg3, modifier = Modifier.size(metrics.iconSize))
    }
}

/**
 * The ring alone, for the composer's settings chip, where it leads the model name. It reads its share
 * aloud; the breakdown stays in the sheet the chip opens.
 */
@Composable
internal fun ContextGlyph(usage: NativeContext, size: Dp) {
    if (usage.size <= 0L) return
    val ratio = ratioOf(usage)
    val description = "${titleOf(usage)} ${percentOf(usage)}%"
    Box(modifier = Modifier.semantics { stateDescription = description }) {
        ContextRing(ratio = ratio, tone = toneFor(ratio, LocalRiffetColors.current), size = size)
    }
}

@Composable
private fun ContextRing(ratio: Float, tone: Color, size: Dp) {
    val colors = LocalRiffetColors.current
    Canvas(modifier = Modifier.size(size)) {
        val stroke = this.size.minDimension * (2.5f / 16f)
        val diameter = this.size.minDimension - stroke
        val topLeft = Offset(stroke / 2f, stroke / 2f)
        val arcSize = Size(diameter, diameter)
        drawArc(
            color = colors.lineStrong,
            startAngle = 0f,
            sweepAngle = 360f,
            useCenter = false,
            topLeft = topLeft,
            size = arcSize,
            style = Stroke(width = stroke, cap = StrokeCap.Round),
        )
        if (ratio > 0f) {
            drawArc(
                color = tone,
                startAngle = -90f,
                sweepAngle = 360f * ratio,
                useCenter = false,
                topLeft = topLeft,
                size = arcSize,
                style = Stroke(width = stroke, cap = StrokeCap.Round),
            )
        }
    }
}

/** The web's popover body, as a sheet: the ratio, the stacked breakdown, then the per-part list. */
@Composable
internal fun ContextBreakdownSheet(usage: NativeContext, onDismiss: () -> Unit, onBack: (() -> Unit)? = null) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val ratio = ratioOf(usage)
    val tone = toneFor(ratio, colors)
    val parts = usage.breakdown.filter { it.tokens > 0L }
    val breakdownTotal = parts.sumOf { it.tokens }
    val breakdownBase = if (usage.breakdownEstimated) {
        maxOf(1L, breakdownTotal)
    } else {
        maxOf(1L, usage.size, usage.used, breakdownTotal)
    }
    PickerOverlay(
        title = "${titleOf(usage)} ${percentOf(usage)}%",
        subtitle = "${compactTokens(usage.used)} / ${compactTokens(usage.size)} tokens",
        onDismiss = onDismiss,
        onBack = onBack,
    ) {
        Column(modifier = Modifier.fillMaxWidth().padding(horizontal = SheetInset)) {
            Canvas(
                modifier = Modifier
                    .fillMaxWidth()
                    .height((metrics.controlInset / 2))
                    .clip(RoundedCornerShape((metrics.controlInset / 4)))
                    .background(colors.line),
            ) {
                if (parts.isEmpty() || usage.breakdownEstimated) {
                    drawRect(color = tone, size = Size(size.width * ratio, size.height))
                } else {
                    val denominator = maxOf(1L, usage.used, breakdownTotal).toDouble()
                    var left = 0f
                    parts.forEachIndexed { index, part ->
                        val width = size.width * ratio * (part.tokens / denominator).toFloat()
                        val alpha = (1f - index * (0.7f / parts.size)).coerceIn(0.25f, 1f)
                        drawRect(
                            color = tone.copy(alpha = alpha),
                            topLeft = Offset(left, 0f),
                            size = Size(width, size.height),
                        )
                        left += width
                    }
                }
            }
            if (usage.limitKind == "compaction") {
                Text(
                    text = stringResource(Res.string.pickers_context_measured, compactTokens(usage.size)),
                    style = typography.bodySmall,
                    color = colors.fg3,
                    modifier = Modifier.padding(top = (metrics.controlInset / 2)),
                )
            }
            if (usage.breakdownEstimated && parts.isNotEmpty()) {
                Text(
                    text = stringResource(Res.string.pickers_context_estimated, compactTokens(breakdownTotal)),
                    style = typography.bodySmall,
                    color = colors.fg3,
                    modifier = Modifier.padding(top = metrics.controlInset),
                )
            }
        }
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(top = metrics.controlInset, bottom = metrics.sectionGap),
        ) {
            parts.forEach { part ->
                Row(
                    modifier = Modifier.fillMaxWidth()
                        .then(if (sheetRowsFilled) Modifier.background(LocalRiffetSurfaces.current.card) else Modifier)
                        .pickerRowDivider()
                        .heightIn(min = metrics.controlHeight)
                        .padding(horizontal = SheetInset, vertical = (metrics.controlInset / 2)),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = contextPartLabel(part.id, parts, part.label),
                        style = SheetRowText,
                        color = colors.fg,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    Text(text = "${if (usage.breakdownEstimated) "~" else ""}${compactTokens(part.tokens)}", style = typography.bodySmall, color = colors.fg2)
                    Spacer(Modifier.width(metrics.controlInset))
                    Text(
                        text = formatContextShare(part.tokens, breakdownBase),
                        style = typography.bodySmall,
                        color = colors.fg3,
                        textAlign = TextAlign.End,
                        modifier = Modifier.width(metrics.iconSlot + metrics.rowPadding),
                    )
                }
            }
        }
    }
}
