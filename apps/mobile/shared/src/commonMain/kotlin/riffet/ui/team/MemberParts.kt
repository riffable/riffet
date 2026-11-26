package riffet.ui.team

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil3.compose.AsyncImagePainter
import org.jetbrains.compose.resources.stringResource
import riffet.contracts.AgentMember
import riffet.shared.MemberRowMark
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.rememberAvatarPainter
import riffet.ui.design.RiffetProgressIndicator
import riffet.ui.icons.Icon
import riffet.ui.icons.RiffetIcons
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet_mobile.shared.generated.resources.Res
import riffet_mobile.shared.generated.resources.session_filter_unread
import riffet_mobile.shared.generated.resources.session_state_running
import riffet_mobile.shared.generated.resources.team_waiting

/** Where a member's image avatar is served from; the workbench provides it from the connected server. */
internal val LocalMemberAvatarUrl = compositionLocalOf<(AgentMember) -> String?> { { null } }

/**
 * A member's avatar: its picture, else its emoji on the active fill, the bot glyph for the default member without
 * one, else the name's first character. A picture stands on its own: its transparent parts show what is behind
 * the row, not a disc. No outer ring.
 */
@Composable
internal fun MemberAvatar(member: AgentMember, size: Dp, modifier: Modifier = Modifier) {
    val colors = LocalRiffetColors.current
    val type = LocalRiffetTypography.current
    val imageUrl = LocalMemberAvatarUrl.current(member)
    val painter = imageUrl?.let { rememberAvatarPainter(it, size) }
    val loaded = painter?.state?.collectAsState()?.value is AsyncImagePainter.State.Success
    val emoji = member.avatar?.takeIf { it.kind == "emoji" }?.value?.takeIf { it.isNotBlank() }
    Box(
        modifier.size(size).clip(CircleShape).then(if (loaded) Modifier else Modifier.background(colors.bgActive)),
        contentAlignment = Alignment.Center,
    ) {
        when {
            loaded && painter != null -> Image(painter, null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
            emoji != null -> Text(emoji, style = type.headline.copy(fontSize = (size.value * 0.5f).sp, lineHeight = (size.value * 0.6f).sp), maxLines = 1, overflow = TextOverflow.Clip)
            member.isDefault || member.name.isBlank() -> Icon(RiffetIcons.Bot, null, Modifier.size(size * 0.5f), colors.fg2)
            else -> Text(
                member.name.trim().take(1).uppercase(),
                style = type.headline.copy(fontSize = (size.value * 0.42f).sp, fontWeight = FontWeight.Medium),
                color = colors.fg2, maxLines = 1, overflow = TextOverflow.Clip,
            )
        }
    }
}

/** What a row says about its conversation at the end: one mark, the most urgent. Nothing for [MemberRowMark.NONE]. */
@Composable
internal fun RowMark(mark: MemberRowMark, modifier: Modifier = Modifier) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    when (mark) {
        MemberRowMark.NONE -> Unit
        MemberRowMark.WAITING -> Text(
            stringResource(Res.string.team_waiting),
            style = LocalRiffetTypography.current.caption, color = colors.warning, maxLines = 1,
            modifier = modifier.border(metrics.hairlineWidth, colors.warning, RoundedCornerShape(metrics.controlRadius))
                .padding(horizontal = metrics.controlInset / 2, vertical = metrics.hairlineWidth * 2),
        )
        MemberRowMark.RUNNING -> {
            val label = stringResource(Res.string.session_state_running)
            RiffetProgressIndicator(
                modifier.size(metrics.smallIconSize * 0.875f).semantics { contentDescription = label },
                color = colors.fg3, strokeWidth = metrics.hairlineWidth * 1.5f,
            )
        }
        MemberRowMark.UNREAD -> {
            val label = stringResource(Res.string.session_filter_unread)
            Box(modifier.size(8.dp).background(colors.fg, CircleShape).semantics { contentDescription = label })
        }
    }
}
