package riffet.ui.timeline

import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.theme.LocalRiffetMotion
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import org.jetbrains.compose.resources.rememberResourceEnvironment
import org.jetbrains.compose.resources.stringResource
import riffet.core.TimelineItem
import riffet_mobile.shared.generated.resources.*

/*
 * Ported from `ToolRun` in apps/web/src/app/session/TranscriptView.tsx (the Mac's `toolRun`).
 *
 * A stretch of tool calls folds into one line naming what the calls did. A tail run opens by
 * default and folds once later content follows, even if a command inside it is still running in
 * the background. The reader can fold or reopen it at any point.
 */
@Composable
internal fun ToolRun(
    items: List<TimelineItem>,
    followedByContent: Boolean,
    /** The turn is live; a pending call in it can still finish. */
    turnActive: Boolean,
    root: String?,
    /** A focus jump landed on this run: it opens, as the reader asked to see what is inside. */
    reveal: Boolean,
    onOpenFile: (String, Int?) -> Unit,
    item: @Composable (TimelineItem) -> Unit,
) {
    val motion = LocalRiffetMotion.current
    val colors = TimelineTheme.colors
    val type = TimelineTheme.type
    val environment = rememberResourceEnvironment()
    val stale = !turnActive
    val tools = remember(items) { items.filterIsInstance<TimelineItem.Tool>() }
    // The run's item list is new on every lane update while a turn streams; a tool whose row did not
    // change keeps its presentation, which for an edit includes a line diff of the whole file.
    val memo = remember(root, stale, environment) { HashMap<String, Pair<TimelineItem.Tool, ToolPresentation>>() }
    val presentations = remember(tools, memo) {
        tools.map { tool -> memo[tool.key]?.takeIf { it.first === tool }?.second ?: toolPresentation(tool, root, stale).also { memo[tool.key] = tool to it } }
            .also { memo.keys.retainAll(tools.mapTo(HashSet()) { it.key }) }
    }
    val summary = remember(tools, presentations, root, stale) {
        toolRunSummary(tools, root, stale, presentations)
    }
    val grouped = remember(items, root, stale) {
        groupAdjacentToolRunEntries(items, root, stale)
    }
    var choice by rememberSaveable { mutableStateOf<Boolean?>(null) }
    LaunchedEffect(reveal) { if (reveal) choice = true }

    val open = choice ?: !followedByContent

    val names = summary.counts.take(2).map { toolRunCountLabel(it) }
    val pair = if (names.size == 2) stringResource(Res.string.timeline_tool_run_pair, names[0], names[1]) else names.firstOrNull().orEmpty()
    val title = if (summary.counts.size > 2) stringResource(Res.string.timeline_tool_run_more, pair) else pair
    val expandMillis = motionDuration(rememberReducedMotion(), motion.MEDIUM)

    Column(Modifier.fillMaxWidth()) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = TimelineRhythm.toolRowHeight)
                .clip(RoundedCornerShape(LocalInterfaceStyle.current.rowRadius))
                .clickable(role = Role.Button) { choice = !open },
        ) {
            Box(Modifier.size(16.dp), contentAlignment = Alignment.Center) {
                ToolIcon(toolIcon(summary.primaryIcon))
            }
            Spacer(Modifier.width(8.dp))
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                modifier = Modifier.weight(1f),
            ) {
                Text(
                    text = title,
                    style = type.rowLabel,
                    color = colors.fg3,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (summary.totalAdded > 0) {
                    Text("+${summary.totalAdded}", style = type.codeSmall, color = colors.success, maxLines = 1, softWrap = false)
                }
                if (summary.totalRemoved > 0) {
                    Text("−${summary.totalRemoved}", style = type.codeSmall, color = colors.danger, maxLines = 1, softWrap = false)
                }
            }
            Spacer(Modifier.width(6.dp))
            Chevron(open)
        }
        AnimatedVisibility(
            visible = open,
            enter = expandVertically(animationSpec = tween(expandMillis, easing = motion.Standard), expandFrom = Alignment.Top),
            exit = shrinkVertically(animationSpec = tween(expandMillis, easing = motion.Standard), shrinkTowards = Alignment.Top),
        ) {
            NestedDetail(spacing = 0.dp) {
                grouped.forEach { entry ->
                    when (entry) {
                        is ToolRunGroupEntry.Single -> key(entry.item.key) { item(entry.item) }
                        is ToolRunGroupEntry.Merged -> key("merged:${entry.key}") { MergedToolRow(entry, root, onOpenFile) }
                    }
                }
            }
        }
    }
}

@Composable
private fun toolRunCountLabel(entry: ToolRunCount): String = when (entry.bucket) {
    "read" -> if (entry.count == 1) stringResource(Res.string.timeline_tool_run_count_read_one) else stringResource(Res.string.timeline_tool_run_count_read, entry.count)
    "edit" -> if (entry.count == 1) stringResource(Res.string.timeline_tool_run_count_edit_one) else stringResource(Res.string.timeline_tool_run_count_edit, entry.count)
    "search" -> if (entry.count == 1) stringResource(Res.string.timeline_tool_run_count_search_one) else stringResource(Res.string.timeline_tool_run_count_search, entry.count)
    "execute" -> if (entry.count == 1) stringResource(Res.string.timeline_tool_run_count_execute_one) else stringResource(Res.string.timeline_tool_run_count_execute, entry.count)
    "fetch" -> if (entry.count == 1) stringResource(Res.string.timeline_tool_run_count_fetch_one) else stringResource(Res.string.timeline_tool_run_count_fetch, entry.count)
    else -> if (entry.count == 1) stringResource(Res.string.timeline_tool_run_count_other_one) else stringResource(Res.string.timeline_tool_run_count_other, entry.count)
}
