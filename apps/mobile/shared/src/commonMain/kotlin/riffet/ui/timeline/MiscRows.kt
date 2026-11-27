package riffet.ui.timeline

import riffet.ui.design.LocalRiffetSurfaces
import riffet.ui.design.LocalInterfaceStyle
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import riffet.ui.focus.SelectableText
import riffet.ui.icons.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.serialization.json.JsonObject
import org.jetbrains.compose.resources.stringResource
import riffet.core.StatusTone
import riffet.core.TaskNotificationStatus
import riffet.core.TimelineItem
import riffet.i18n.L10n
import riffet.stats.compactCount
import riffet.ui.icons.RiffetIcons
import riffet_mobile.shared.generated.resources.*

/*
 * The rows that are neither prose nor a tool call: the plan, a run status line, an image, and the
 * background-task notifications that woke a turn.
 *
 * Notifications use the same one-line disclosure as tools; their output stays folded by default.
 */

@Composable
internal fun PlanRow(item: TimelineItem.Plan) {
    val colors = TimelineTheme.colors
    val type = TimelineTheme.type
    val entries = item.entries
    val done = entries.count { jsonText(it["status"]) == "completed" }
    Column(
        verticalArrangement = Arrangement.spacedBy(TimelineRhythm.block),
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(LocalInterfaceStyle.current.rowRadius))
            .background(LocalRiffetSurfaces.current.card)
            .padding(horizontal = 14.dp, vertical = 10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(Res.string.timeline_todo), style = type.label, color = colors.fg)
            Spacer(Modifier.width(8.dp))
            Text("$done/${entries.size}", style = type.caption, color = colors.fg3)
            Spacer(Modifier.weight(1f))
            PlanProgress(fraction = if (entries.isEmpty()) 0f else done.toFloat() / entries.size)
        }
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            entries.forEachIndexed { index, entry ->
                PlanEntry(entry, index)
            }
        }
    }
}

@Composable
private fun PlanEntry(entry: JsonObject, index: Int) {
    val colors = TimelineTheme.colors
    val type = TimelineTheme.type
    val status = jsonText(entry["status"])
    val label = jsonText(entry["content"]) ?: jsonText(entry["title"]) ?: stringResource(Res.string.timeline_task_number, index + 1)
    val completed = status == "completed"
    Row(verticalAlignment = Alignment.Top) {
        // Shapes, not icons: a filled circle is done, a ring is in progress, a hollow circle is
        // still pending. `in_progress` also animates in the web; on a phone a static accent ring
        // reads the same at this size for none of the cost.
        Box(
            Modifier
                .padding(top = 4.dp)
                .size(10.dp)
                .clip(CircleShape)
                .background(if (completed) colors.success else Color.Transparent)
                .border(
                    width = 1.5.dp,
                    color = when {
                        completed -> colors.success
                        status == "in_progress" -> colors.accent
                        else -> colors.fg4
                    },
                    shape = CircleShape,
                ),
        )
        Spacer(Modifier.width(8.dp))
        Text(
            text = label,
            style = type.label,
            color = if (completed) colors.fg3 else colors.fg,
            textDecoration = if (completed) TextDecoration.LineThrough else null,
        )
    }
}

@Composable
private fun PlanProgress(fraction: Float) {
    val colors = TimelineTheme.colors
    Box(
        Modifier
            .width(72.dp)
            .height(4.dp)
            .clip(CircleShape)
            .background(colors.line),
    ) {
        Box(
            Modifier
                .fillMaxWidth(fraction.coerceIn(0f, 1f))
                .height(4.dp)
                .clip(CircleShape)
                .background(colors.success),
        )
    }
}

/** A run that failed or was stopped: a warning for a failure, a cross for a stop. */
@Composable
internal fun StatusRow(item: TimelineItem.Status) {
    val colors = TimelineTheme.colors
    val type = TimelineTheme.type
    val danger = item.tone == StatusTone.DANGER
    val color = if (danger) colors.danger else colors.fg3
    val detail = item.detail?.takeIf { it.isNotBlank() }
    var open by rememberSaveable(item.key, detail) { mutableStateOf(false) }
    if (detail != null) {
        TimelineDisclosure(
            open = open,
            onToggle = { open = !open },
            danger = danger,
            leading = { Icon(if (danger) RiffetIcons.Warning else RiffetIcons.Close, contentDescription = null, tint = color, modifier = Modifier.size(14.dp)) },
            title = { Text(item.text, style = type.label, color = color) },
        ) {
            CodeBlock(text = detail, maxHeight = 320.dp)
        }
    } else {
        Row(verticalAlignment = Alignment.Top, modifier = Modifier.fillMaxWidth()) {
            Icon(
                imageVector = if (danger) RiffetIcons.Warning else RiffetIcons.Close,
                contentDescription = null,
                tint = color,
                modifier = Modifier.padding(top = 2.dp).size(14.dp),
            )
            Spacer(Modifier.width(6.dp))
            SelectableText {
                Text(item.text, style = type.label, color = color)
            }
        }
    }
}

/** Each notification already owns its title, state and disclosure. */
@Composable
internal fun TriggerRow(notices: List<TimelineItem.TaskNotification>, root: String? = null) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxWidth()) {
        notices.forEach { notice -> TaskNotificationRow(notice, root) }
    }
}

@Composable
internal fun TaskNotificationRow(item: TimelineItem.TaskNotification, root: String? = null) {
    val colors = TimelineTheme.colors
    val type = TimelineTheme.type
    var open by rememberSaveable(item.key) { mutableStateOf(false) }
    var diagnosticsOpen by rememberSaveable(item.key) { mutableStateOf(false) }
    val view = remember(item, root, L10n.locale) { taskNoticeView(item, root) }
    val name = view.name
    val command = item.command
    TimelineDisclosure(
        open = open,
        onToggle = { open = !open },
        danger = view.failed,
        leading = {
            RunningMark(view.running) {
                val icon = when (view.kind) {
                    "subagent" -> RiffetIcons.Bot
                    "monitor" -> RiffetIcons.Eye
                    "workflow" -> RiffetIcons.Repeat
                    else -> RiffetIcons.SquareTerminal
                }
                ToolIcon(icon, tint = if (view.failed) colors.danger else colors.fg4)
            }
        },
        title = {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(view.headline, style = type.rowLabel, color = colors.fg2, maxLines = 1, softWrap = false)
                if (name != null) {
                    Text(
                        text = name.primary,
                        style = if (name.primaryKind == "prose") type.bodySmall else type.codeSmall,
                        color = colors.fg3,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                }
            }
        },
        inline = if ((name?.extraCommands ?: 0) > 0 || view.figures.isNotEmpty() || view.unsettled) {
            {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    name?.extraCommands?.takeIf { it > 0 }?.let { Text("+$it", style = type.codeSmall, color = colors.fg4, maxLines = 1, softWrap = false) }
                    if (view.figures.isNotEmpty()) {
                        Text(view.figures.joinToString(" · "), style = type.caption, color = colors.fg4, maxLines = 1, softWrap = false)
                    }
                    if (view.unsettled) RowOutcome(false)
                }
            }
        } else null,
    ) {
        if (name?.primaryKind == "prose") Text(name.primary, style = type.bodySmall, color = colors.fg2)
        if (command != null) {
            CodeBlock(command, prefix = "\$ ", foreground = colors.fg)
        }
        // `detail` lives in another module, so `?.let` rather than a smart-cast after a null check.
        item.detail?.let { detail -> CodeBlock(detail) }
        val time = formatDateTime(item.event.createdAt)
        val tokens = item.tokens?.let { "${compactCount(it.toDouble())} tok" }
        val meta = listOfNotNull(time, tokens)
        if (meta.isNotEmpty()) Text(meta.joinToString(" · "), style = type.caption, color = colors.fg3)
        if (item.taskId != null || item.sourceStatus != null) {
            TimelineDisclosure(
                open = diagnosticsOpen,
                onToggle = { diagnosticsOpen = !diagnosticsOpen },
                title = { Text(stringResource(Res.string.timeline_diagnostics), style = type.caption, color = colors.fg3) },
            ) {
                item.taskId?.let { Chip(stringResource(Res.string.timeline_task_id, it), mono = true) }
                item.sourceStatus?.let { Text(stringResource(Res.string.timeline_cli_status, it), style = type.caption, color = colors.fg3) }
            }
        }
    }
}
