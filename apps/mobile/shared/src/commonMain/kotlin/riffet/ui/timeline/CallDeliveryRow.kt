package riffet.ui.timeline

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import riffet.contracts.AgentMember
import riffet.core.TimelineItem
import riffet.core.timelineItemTime
import riffet.shared.CallDelivery
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.team.MemberAvatar
import riffet.ui.theme.LocalRiffetColors

/** Who answered a call delivery: the member of the called conversation; null for an Agent, which the delivery names. */
internal val LocalDeliveryMember = compositionLocalOf<((CallDelivery) -> AgentMember?)?> { null }

/**
 * Another member's or Agent's answer handed back into this conversation (docs/AGENT-CALLS.md): the body as markdown
 * in a muted bubble, so it reads apart from the owner's own, and the answerer's avatar, name and time under it.
 */
@Composable
internal fun CallDeliveryRow(item: TimelineItem.User, delivery: CallDelivery) {
    val colors = LocalRiffetColors.current
    val type = TimelineTheme.type
    val answerer = LocalDeliveryMember.current?.invoke(delivery)
    // On the owner's side like their own messages (the prototype and the web): it arrives in the conversation as one.
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp), horizontalAlignment = Alignment.End) {
        Column(
            Modifier.padding(start = 32.dp)
                .clip(RoundedCornerShape(LocalInterfaceStyle.current.groupRadius))
                .background(colors.bgMuted)
                .padding(horizontal = 14.dp, vertical = 10.dp),
        ) {
            PlainText(
                text = delivery.body,
                color = TimelineTheme.colors.fg,
                style = TimelineTheme.prose.body,
                codeStyle = TimelineTheme.prose.code,
                streaming = false,
            )
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            if (answerer != null) MemberAvatar(answerer, 16.dp)
            Text(answerer?.name ?: delivery.agentName, style = type.caption, color = TimelineTheme.colors.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false))
            formatDateTime(timelineItemTime(item))?.let { time -> Text(time, style = type.caption, color = TimelineTheme.colors.fg3, softWrap = false) }
        }
    }
}
