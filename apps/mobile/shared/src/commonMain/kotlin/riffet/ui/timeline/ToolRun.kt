package riffet.ui.timeline

import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.theme.LocalRiffetMotion
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.clickable
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
import org.jetbrains.compose.resources.StringResource
import org.jetbrains.compose.resources.rememberResourceEnvironment
import org.jetbrains.compose.resources.stringResource
import riffet.contracts.NativeJobStatus
import riffet.core.TimelineItem
import riffet_mobile.shared.generated.resources.*

/*
 * Ported from `ToolRun` in apps/web/src/app/session/TranscriptView.tsx (the Mac's `toolRun`).
 *
 * A stretch of tool calls folds into one line naming what the calls did. Work in progress opens
 * by default; a call that never settled or has nothing after it also opens. The reader can fold or
 * reopen it at any point.
 */
@Composable
internal fun ToolRun(
    items: List<TimelineItem>,
    followedByContent: Boolean,
    /** The process block is working. */
    running: Boolean,
    /** The turn is live; a pending call in it can still finish. */
    turnActive: Boolean,
    root: String?,
    /** A focus jump landed on this run: it opens, as the reader asked to see what is inside. */
    reveal: Boolean,
    item: @Composable (TimelineItem) -> Unit,
) {
    val motion = LocalRiffetMotion.current
    val colors = TimelineTheme.colors
    val environment = rememberResourceEnvironment()
    val stale = !turnActive
    val tools = remember(items) { items.filterIsInstance<TimelineItem.Tool>() }
    val presentations = remember(tools, root, stale, environment) { tools.map { toolPresentation(it, root, stale) } }
    val kinds = remember(tools) { toolRunKinds(tools) }
    var choice by rememberSaveable { mutableStateOf<Boolean?>(null) }
    LaunchedEffect(reveal) { if (reveal) choice = true }

    // Reasoning still streaming at the end of the block keeps its run open, as a working call does.
    val thinking = running && !followedByContent && items.last() is TimelineItem.Thought
    val active = thinking || tools.indices.any { index ->
        tools[index].job?.let { it.status == NativeJobStatus.RUNNING } ?: presentations[index].running
    }
    val incomplete = tools.indices.any { index ->
        tools[index].job?.let { it.status == NativeJobStatus.UNKNOWN } ?: presentations[index].dangling
    }
    val open = choice ?: (active || incomplete || !followedByContent)

    val names = kinds.take(2).map { stringResource(toolRunLabel(it)) }
    val pair = if (names.size == 2) stringResource(Res.string.timeline_tool_run_pair, names[0], names[1]) else names.firstOrNull().orEmpty()
    val title = if (kinds.size > 2) stringResource(Res.string.timeline_tool_run_more, pair) else pair
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
                ToolIcon(toolIcon(kinds.firstOrNull() ?: "other"))
            }
            Spacer(Modifier.width(8.dp))
            Text(
                text = title,
                style = TimelineTheme.type.rowLabel,
                color = colors.fg3,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Spacer(Modifier.width(6.dp))
            Chevron(open)
        }
        AnimatedVisibility(
            visible = open,
            enter = expandVertically(animationSpec = tween(expandMillis, easing = motion.Standard), expandFrom = Alignment.Top),
            exit = shrinkVertically(animationSpec = tween(expandMillis, easing = motion.Standard), shrinkTowards = Alignment.Top),
        ) {
            NestedDetail(spacing = 0.dp) {
                items.forEach { entry -> key(entry.key) { item(entry) } }
            }
        }
    }
}

/** The web's `toolRunSummary` wording, one category at a time. */
private fun toolRunLabel(kind: String): StringResource = when (kind) {
    "read" -> Res.string.timeline_tool_run_read
    "search" -> Res.string.timeline_tool_run_search
    "execute" -> Res.string.timeline_tool_run_execute
    "edit" -> Res.string.timeline_tool_run_edit
    "delete" -> Res.string.timeline_tool_run_delete
    "move" -> Res.string.timeline_tool_run_move
    "fetch" -> Res.string.timeline_tool_run_fetch
    "agent" -> Res.string.timeline_tool_run_agent
    "think" -> Res.string.timeline_tool_run_think
    "switch_mode" -> Res.string.timeline_tool_run_switch_mode
    "question" -> Res.string.timeline_tool_run_question
    "plan" -> Res.string.timeline_tool_run_plan
    else -> Res.string.timeline_tool_run_other
}
