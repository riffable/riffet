package riffet.ui.composer

import riffet.ui.design.LocalRiffetSurfaces
import riffet.ui.design.cardEdge
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.timeline.Chevron
import riffet.ui.theme.LocalRiffetMotion
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.ui.semantics.Role
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.serialization.json.JsonPrimitive
import org.jetbrains.compose.resources.stringResource
import riffet_mobile.shared.generated.resources.*
import riffet.core.TimelineItem
import riffet.core.TimelineItemKind
import riffet.core.kind
import riffet.ui.icons.RiffetIcons
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography

/*
 * The agent's todo list as a dock directly above the composer card, ported from the web's
 * `apps/web/src/app/session/ComposerDock.tsx` (`TodoDock`).
 *
 * A plan is a live checklist rather than a message: it is shown once, above the input, and its plan
 * rows are kept out of the transcript by [visibleTimeline], exactly like the CLI's own inbox.
 */

/**
 * The web's `TodoDock`: one card above the input, a single header row that expands. Collapsed on a
 * phone by default — a checklist is not worth the transcript space until asked for — and the header
 * itself is the 44dp touch target where the web uses `max-md:h-11`.
 */
@Composable
fun TodoDock(todos: List<TodoEntry>, modifier: Modifier = Modifier) {
    val metrics = LocalInterfaceStyle.current.metrics
    val motion = LocalRiffetMotion.current
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    if (todos.isEmpty()) return
    var open by remember { mutableStateOf(false) }
    var settled by remember { mutableStateOf<String?>(null) }
    val signature = remember(todos) { todos.joinToString("\u0000") { it.content } }
    val allDone = todos.all { it.status == TodoStatus.COMPLETED }
    // A fresh list and a finished list both fold away on a phone; anything in between leaves the
    // panel alone, so a manual expansion survives status updates (the web's `TodoDock` effect).
    LaunchedEffect(signature, allDone) {
        if (settled != signature) {
            settled = signature
            open = false
            return@LaunchedEffect
        }
        if (allDone) open = false
    }

    val shape = RoundedCornerShape(LocalInterfaceStyle.current.groupRadius)
    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(shape)
            .background(LocalRiffetSurfaces.current.card)
            .cardEdge(shape)
            .padding(horizontal = 6.dp, vertical = 2.dp),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = metrics.controlHeight)
                .clip(RoundedCornerShape(LocalInterfaceStyle.current.controlRadius))
                .clickable(role = Role.Button, onClickLabel = if (open) stringResource(Res.string.composer_collapse) else stringResource(Res.string.composer_expand)) { open = !open }
                .padding(horizontal = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(RiffetIcons.ListTodo, contentDescription = null, tint = colors.fg3, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(8.dp))
            Text(text = stringResource(Res.string.composer_todos), style = typography.label, color = colors.fg)
            Spacer(Modifier.width(8.dp))
            Text(
                text = todoProgress(todos),
                style = typography.caption,
                color = colors.fg3,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Chevron(open, size = 14.dp, tint = colors.fg4, icon = RiffetIcons.ChevronDown, openAngle = 180f)
        }
        AnimatedVisibility(visible = open, enter = motion.expandIn(), exit = motion.collapseOut()) {
            Column(
                modifier = Modifier
                    .heightIn(max = 180.dp)
                    .verticalScroll(rememberScrollState())
                    .padding(bottom = 4.dp),
                verticalArrangement = Arrangement.spacedBy(metrics.controlInset / 3),
            ) {
                todos.forEach { todo ->
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 6.dp),
                        verticalAlignment = Alignment.Top,
                    ) {
                        PlanIcon(status = todo.status, modifier = Modifier.padding(top = 2.dp))
                        Spacer(Modifier.width(8.dp))
                        Text(
                            text = todo.content,
                            style = typography.bodySmall,
                            color = if (todo.status == TodoStatus.COMPLETED) colors.fg3 else colors.fg,
                            textDecoration = if (todo.status == TodoStatus.COMPLETED) TextDecoration.LineThrough else null,
                            modifier = Modifier.weight(1f),
                        )
                    }
                }
            }
        }
    }
}

/** The web's `planIcon`: done, running, or not started, from the shared status palette. */
@Composable
private fun PlanIcon(status: TodoStatus, modifier: Modifier = Modifier) {
    val colors = LocalRiffetColors.current
    val (icon, tint) = when (status) {
        TodoStatus.COMPLETED -> RiffetIcons.CircleCheck to colors.success
        TodoStatus.IN_PROGRESS -> RiffetIcons.CircleDashed to colors.accent
        TodoStatus.PENDING -> RiffetIcons.Circle to colors.fg4
    }
    Icon(icon, contentDescription = null, tint = tint, modifier = modifier.size(14.dp))
}
