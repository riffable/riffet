package riffet.ui.home

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import riffet.contracts.ServerInfo
import riffet.i18n.L10n
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.icons.Icon
import riffet.ui.icons.RiffetIcons
import riffet.ui.pickers.LocalPickerHost
import riffet.ui.pickers.OptionRow
import riffet.ui.pickers.PickerPage
import riffet.ui.pickers.PickerSheetFrame
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography

/**
 * Compact server selector pill placed to the left of the directory selector on the new-session
 * page when linked servers exist (`docs/SERVER-LINKS.md §10`).
 */
@Composable
internal fun ServerContextPill(
    server: HomeServerOption,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    Row(
        modifier = modifier
            .height(metrics.controlHeight)
            .widthIn(max = 152.dp)
            .clip(RoundedCornerShape(LocalInterfaceStyle.current.controlRadius))
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = metrics.controlInset),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(metrics.controlInset / 2),
    ) {
        Icon(
            if (server.self) RiffetIcons.Monitor else RiffetIcons.Globe,
            contentDescription = null,
            tint = colors.fg3,
            modifier = Modifier.size(metrics.smallIconSize),
        )
        Text(
            text = server.name,
            style = typography.bodySmall,
            color = colors.fg2,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** Bottom sheet listing entry + linked servers for new sessions (`docs/SERVER-LINKS.md §10`). */
@Composable
internal fun ServerPickerSheet(
    options: List<HomeServerOption>,
    selectedId: String,
    onSelect: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    PickerSheetFrame(onDismiss = onDismiss) {
        val host = LocalPickerHost.current
        val metrics = LocalInterfaceStyle.current.metrics
        val colors = LocalRiffetColors.current
        val typography = LocalRiffetTypography.current
        PickerPage(title = L10n.uiText("servers.pickerTitle"), fullHeight = false) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(bottom = metrics.controlInset),
            ) {
                options.forEach { item ->
                    val subtitle = item.subtitle.takeIf { it.isNotEmpty() && item.reason == null }
                    OptionRow(
                        label = item.name,
                        description = subtitle,
                        icon = if (item.self) RiffetIcons.Monitor else RiffetIcons.Globe,
                        iconTint = if (item.usable) colors.fg2 else colors.fg4,
                        selected = item.id == selectedId,
                        disabledReason = item.reason,
                        trailing = {
                            if (item.reason != null) {
                                Text(
                                    text = item.reason.orEmpty(),
                                    style = typography.caption,
                                    color = colors.fg3,
                                    maxLines = 1,
                                )
                            } else {
                                Box(
                                    Modifier
                                        .size(7.dp)
                                        .clip(CircleShape)
                                        .background(if (item.online) colors.success else colors.fg4),
                                )
                            }
                        },
                        onClick = {
                            onSelect(item.id)
                            host?.dismiss?.invoke()
                        },
                    )
                }
            }
        }
    }
}

/** Bottom sheet choosing which server scope the session list displays (`docs/SERVER-LINKS.md §10`). */
@Composable
internal fun ServerScopeSheet(
    peers: List<ServerInfo>,
    selectedScope: ServerScopeKind,
    selectedPeerId: String?,
    onSelect: (ServerScopeKind, String?) -> Unit,
    onDismiss: () -> Unit,
) {
    PickerSheetFrame(onDismiss = onDismiss) {
        val host = LocalPickerHost.current
        val metrics = LocalInterfaceStyle.current.metrics
        val colors = LocalRiffetColors.current
        val typography = LocalRiffetTypography.current
        fun pick(scope: ServerScopeKind, peerId: String? = null) {
            onSelect(scope, peerId)
            host?.dismiss?.invoke()
        }
        PickerPage(title = L10n.uiText("servers.scope.all"), fullHeight = false) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(bottom = metrics.controlInset),
            ) {
                OptionRow(
                    label = L10n.uiText("servers.scope.relevant"),
                    icon = RiffetIcons.Link,
                    selected = selectedScope == ServerScopeKind.RELEVANT,
                    onClick = { pick(ServerScopeKind.RELEVANT) },
                )
                OptionRow(
                    label = L10n.uiText("servers.scope.all"),
                    icon = RiffetIcons.Globe,
                    selected = selectedScope == ServerScopeKind.ALL,
                    onClick = { pick(ServerScopeKind.ALL) },
                )
                OptionRow(
                    label = L10n.uiText("servers.scope.local"),
                    icon = RiffetIcons.Monitor,
                    selected = selectedScope == ServerScopeKind.LOCAL,
                    onClick = { pick(ServerScopeKind.LOCAL) },
                )
                peers.forEach { peer ->
                    OptionRow(
                        label = peer.name,
                        description = peer.note?.takeIf { it.isNotBlank() } ?: formatServerPlatform(peer.platform).takeIf { it.isNotEmpty() },
                        icon = RiffetIcons.Globe,
                        selected = selectedScope == ServerScopeKind.PEER && selectedPeerId == peer.id,
                        trailing = if (!peer.online) {
                            {
                                Text(
                                    text = L10n.uiText("servers.offline"),
                                    style = typography.caption,
                                    color = colors.fg3,
                                    maxLines = 1,
                                )
                            }
                        } else null,
                        onClick = { pick(ServerScopeKind.PEER, peer.id) },
                    )
                }
            }
        }
    }
}
