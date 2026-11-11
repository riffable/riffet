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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.jetbrains.compose.resources.stringResource
import riffet_mobile.shared.generated.resources.*
import riffet.core.TimelineItem
import riffet.core.TimelineItemKind
import riffet.core.kind
import riffet.core.toolView
import riffet.ui.icons.RiffetIcons
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography

/*
 * ============================================================================================
 * The goal dock - the harness's goal, above the input card
 * ============================================================================================
 *
 * DeepSeek Harness keeps a goal on its own side of the wire: `create_goal` sets one, `update_goal`
 * moves it between phases, `get_goal` reports it. Those calls reach the transcript as tool calls
 * (the DSH projection tags them `kind: "goal"` and puts the objective in `title`), and until now the
 * only sign of a goal was that one row scrolling away in the transcript - a reader had to remember
 * what the session was for.
 *
 * This is the todo dock's shape, for the same reason: the state a reader checks while typing belongs
 * above the input card, not inside the message stream. It is deliberately *not* a checklist - a goal
 * is one sentence plus a phase. Like the todo dock, it expands only when asked for.
 */

/**
 * The goal, above the input card.
 *
 * `已设定` / `继续中` read as ordinary state; `受阻` carries the harness's own reason, because a
 * blocked goal is the one phase a reader must act on.
 */
@Composable
fun GoalDock(goal: SessionGoal, modifier: Modifier = Modifier) {
    val metrics = LocalInterfaceStyle.current.metrics
    val motion = LocalRiffetMotion.current
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    var open by remember(goal.objective) { mutableStateOf(false) }
    LaunchedEffect(goal.action) {
        if (goal.action == "complete") open = false
    }
    val blocked = goal.action == "blocked"
    val tone = if (blocked) colors.warning else colors.fg3
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
            modifier = Modifier.fillMaxWidth().heightIn(min = metrics.controlHeight)
                .clip(RoundedCornerShape(LocalInterfaceStyle.current.controlRadius))
                .clickable(role = Role.Button, onClickLabel = if (open) stringResource(Res.string.composer_goal_collapse) else stringResource(Res.string.composer_goal_expand)) { open = !open }
                .padding(horizontal = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(RiffetIcons.Target, contentDescription = null, tint = tone, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(8.dp))
            Text(text = stringResource(Res.string.composer_goal), style = typography.label, color = colors.fg)
            Spacer(Modifier.width(8.dp))
            Text(
                text = goalStatusLabel(goal.action),
                style = typography.caption,
                color = tone,
                maxLines = 1,
            )
            Spacer(Modifier.width(8.dp))
            Text(
                text = goal.objective,
                style = typography.bodySmall,
                color = colors.fg2,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Chevron(open, size = 14.dp, tint = colors.fg4, icon = RiffetIcons.ChevronDown, openAngle = 180f)
        }
        AnimatedVisibility(visible = open, enter = motion.expandIn(), exit = motion.collapseOut()) {
            Column(
                modifier = Modifier.heightIn(max = 180.dp)
                    .verticalScroll(rememberScrollState())
                    .padding(start = 6.dp, end = 6.dp, bottom = 6.dp),
            ) {
                if (goal.objective.isNotBlank()) {
                    Text(text = goal.objective, style = typography.bodySmall, color = colors.fg2)
                }
                val blockedReason = goal.blockedReason
                if (blocked && !blockedReason.isNullOrBlank()) {
                    Text(
                        text = blockedReason,
                        style = typography.caption,
                        color = colors.warning,
                        modifier = Modifier.padding(top = 4.dp),
                    )
                }
            }
        }
    }
}
