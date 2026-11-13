package riffet.ui.timeline

import riffet.ui.theme.visualWorkVisibility

import riffet.ui.design.LocalInterfaceStyle
import androidx.compose.ui.semantics.Role
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import org.jetbrains.compose.resources.stringResource
import riffet_mobile.shared.generated.resources.*

/*
 * Ported from apps/web/src/app/session/TurnProcess.tsx.
 *
 * One row per turn, carrying the elapsed time, and folding
 * the turn's reasoning and structured work away behind it. Speed is not here, as on the web: it
 * belongs to the reply's timestamp and to the live 正在处理 line. The fold state lives in
 * `ProcessFolds` (TimelineLayout.kt), not here: the header and the rows it folds are separate lazy
 * items, so this composable can scroll out of composition without the turn forgetting whether it
 * was open.
 *
 * There is no rail and no indent: a turn's contents line up with its own header (README:
 * 「内容与自己的行头左对齐」). Indentation belongs to a tool row's own payload.
 */
@Composable
internal fun TurnProcessHeader(
    row: TimelineRow.Process,
    open: Boolean,
    onToggle: () -> Unit,
) {
    val colors = TimelineTheme.colors
    val running = row.running
    val startMillis = instantMillis(row.startedAt)
    val endMillis = instantMillis(row.endedAt)
    val visibility = riffet.ui.theme.rememberVisualWorkVisibility()
    val now = rememberTickingNow(running, visible = visibility.visible)
    val seconds = when {
        startMillis == null -> 0L
        running -> ((now - startMillis) / 1_000L).coerceAtLeast(0L)
        else -> (((endMillis ?: now) - startMillis) / 1_000L).coerceAtLeast(0L)
    }
    val label = when {
        running -> stringResource(Res.string.timeline_process_working, formatElapsed(seconds))
        row.stopped && seconds > 0 -> stringResource(Res.string.timeline_process_stopped_elapsed, formatElapsed(seconds))
        row.stopped -> stringResource(Res.string.timeline_process_stopped)
        seconds > 0 -> stringResource(Res.string.timeline_process_processed_elapsed, formatElapsed(seconds))
        else -> stringResource(Res.string.timeline_process_processed)
    }

    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.visualWorkVisibility(visibility)
            .fillMaxWidth()
            .heightIn(min = TimelineRhythm.toolRowHeight)
            .clip(RoundedCornerShape(LocalInterfaceStyle.current.rowRadius))
            .clickable(role = Role.Button, onClick = onToggle)
            .padding(vertical = 4.dp),
    ) {
        Box(Modifier.size(14.dp), contentAlignment = Alignment.Center) {
            RunningMark(running) {
                // A plain mark rather than an icon: this row is a label, not a toolbar.
                Box(Modifier.size(8.dp).clip(CircleShape).background(colors.fg4))
            }
        }
        Spacer(Modifier.width(8.dp))
        // No failure count: a run-level error is its own row inside the block, which opens for it.
        Text(
            text = label,
            // Tabular figures, so the elapsed time does not shimmer sideways as it counts.
            style = TimelineTheme.type.rowLabel.copy(fontFeatureSettings = "tnum"),
            color = colors.fg2,
            maxLines = 1,
        )
        Spacer(Modifier.weight(1f))
        Chevron(open)
    }
}

/** A settled turn's copy action and end time. */
@Composable
internal fun TurnFooterRow(text: String?, endedAt: String?) {
    val colors = TimelineTheme.colors
    Row(verticalAlignment = Alignment.CenterVertically) {
        text?.let { CopyTextButton(it, stringResource(Res.string.timeline_copy_answer)) }
        formatDateTime(endedAt)?.let { time ->
            Text(
                text = time,
                style = TimelineTheme.type.caption,
                color = colors.fg3,
                modifier = Modifier.padding(horizontal = 4.dp),
            )
        }
    }
}
