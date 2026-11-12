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
import org.jetbrains.compose.resources.stringResource
import riffet_mobile.shared.generated.resources.*
import riffet.contracts.SessionGoal
import riffet.ui.icons.RiffetIcons
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography

/*
 * ============================================================================================
 * The goal dock - the session's goal, above the input card
 * ============================================================================================
 *
 * Claude Code's `/goal`, a Codex thread goal and the DeepSeek Harness goal tools all land in one
 * `Session.goal` the server keeps; until then the only sign of a goal was a row scrolling away in the
 * transcript - a reader had to remember what the session was for.
 *
 * This is the todo dock's shape, for the same reason: the state a reader checks while typing belongs
 * above the input card, not inside the message stream. It is deliberately *not* a checklist - a goal
 * is one sentence plus a phase. Like the todo dock, it expands only when asked for.
 */

/**
 * The goal, above the input card.
 *
 * `进行中` / `已暂停` read as ordinary state; `受阻` carries the agent's own reason, because a
 * blocked goal is the one phase a reader must act on, and the only one whose reason is shown.
 */
@Composable
fun GoalDock(goal: SessionGoal, modifier: Modifier = Modifier) {
    val metrics = LocalInterfaceStyle.current.metrics
    val motion = LocalRiffetMotion.current
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    var open by remember(goal.objective) { mutableStateOf(false) }
    LaunchedEffect(goal.status) {
        if (goal.status == "complete") open = false
    }
    val blocked = goal.status == "blocked"
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
                text = goalStatusLabel(goal),
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
                val reason = goal.reason
                if (blocked && !reason.isNullOrBlank()) {
                    Text(
                        text = reason,
                        style = typography.caption,
                        color = colors.warning,
                        modifier = Modifier.padding(top = 4.dp),
                    )
                }
            }
        }
    }
}
