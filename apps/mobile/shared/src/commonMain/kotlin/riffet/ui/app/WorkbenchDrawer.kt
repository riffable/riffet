package riffet.ui.app

import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.GroupRow
import riffet.ui.design.Group
import riffet.ui.design.GroupTitle
import riffet.ui.design.GroupSpacer
import riffet.ui.design.IconTile
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import riffet.ui.icons.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.getString
import org.jetbrains.compose.resources.rememberResourceEnvironment
import org.jetbrains.compose.resources.stringResource
import riffet.contracts.FolderFavorite
import riffet.shared.DownloadCenter
import riffet.shared.DownloadState
import riffet.shared.PairedServer
import riffet.shared.RiffetApi
import riffet.shared.RiffetConnection
import riffet.shared.RiffetUnauthenticatedException
import riffet.shared.downloadsSupported
import riffet.i18n.L10n
import riffet.ui.design.OwnerAvatar
import riffet.ui.settings.OwnerController
import riffet.ui.favorites.favoriteName
import riffet.ui.favorites.rememberFolderFavorites
import riffet.ui.icons.BrandMark
import riffet.ui.icons.RiffetIcons
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.timeline.Spinner
import riffet_mobile.shared.generated.resources.*

/**
 * The navigation drawer's content: context and secondary destinations, not the session list or the
 * projects. The server (switch between paired ones), the host's folder favorites (each starts a
 * new session there), 下载 and 统计.
 */
@Composable
internal fun WorkbenchDrawer(
    api: RiffetApi?,
    owner: OwnerController?,
    connection: RiffetConnection,
    onOwner: () -> Unit,
    /** A switched-to server, handed over like a fresh pairing. */
    onPaired: (RiffetApi) -> Unit,
    /** A paired server whose token was revoked: pairing again is the remedy. */
    onRepair: (String) -> Unit,
    onFavorite: (FolderFavorite) -> Unit,
    onDownloads: () -> Unit,
    onStats: () -> Unit,
    operationScope: CoroutineScope,
    connectionOperation: MutableState<String?>,
) {
    val colors = LocalRiffetColors.current
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(top = 8.dp, bottom = 24.dp)) {
        if (owner != null) {
            Group { OwnerHeader(owner, onOwner) }
            GroupSpacer()
        }
        GroupTitle(stringResource(Res.string.settings_paired_servers))
        Group { ServerHeader(api, connection, onPaired, onRepair, operationScope, connectionOperation) }
        if (api != null) {
            val picks = rememberFolderFavorites(api).byRecentUse
            if (picks.isNotEmpty()) {
                GroupTitle(stringResource(Res.string.session_favorites))
                Group {
                    picks.forEach { favorite ->
                        GroupRow(title = favoriteName(favorite), leading = { EntryMark(RiffetIcons.Star, colors.warning) },
                            chevron = true, onClick = { onFavorite(favorite) })
                    }
                }
            }
        }
        GroupSpacer()
        if (downloadsSupported || api != null) Group {
            if (downloadsSupported) {
                val downloading = DownloadCenter.shared.items.collectAsState().value.any { it.state == DownloadState.RUNNING }
                DrawerItem(
                    label = if (downloading) stringResource(Res.string.session_downloading) else stringResource(Res.string.session_downloads),
                    icon = RiffetIcons.Download, onClick = onDownloads,
                )
            }
            if (api != null) DrawerItem(stringResource(Res.string.session_stats), RiffetIcons.Chart, onClick = onStats)
        }
    }
}

/** The owner's avatar and name (or the page title while there is no name); opens the owner page in 设置. */
@Composable
private fun OwnerHeader(controller: OwnerController, onClick: () -> Unit) {
    rememberResourceEnvironment()
    val owner = controller.state.collectAsState().value.owner
    GroupRow(
        title = owner?.name?.takeIf { it.isNotBlank() } ?: L10n.uiText("owner.title"),
        leading = { OwnerAvatar(owner, controller.avatarUrl(owner), 40.dp) },
        chevron = true, onClick = onClick,
    )
}

/** The connected server under the mark; with others paired, the row unfolds into a switch. */
@Composable
private fun ServerHeader(
    api: RiffetApi?,
    connection: RiffetConnection,
    onPaired: (RiffetApi) -> Unit,
    onRepair: (String) -> Unit,
    operationScope: CoroutineScope,
    connectionOperation: MutableState<String?>,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val snackbar = LocalRiffetSnackbar.current
    val current = api?.baseUrl
    var servers by remember(connection) { mutableStateOf<List<PairedServer>>(emptyList()) }
    var open by rememberSaveable { mutableStateOf(false) }
    var busy by connectionOperation
    LaunchedEffect(connection, current) {
        servers = try {
            connection.pairedServers()
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (_: Throwable) {
            emptyList()
        }
    }
    val here = servers.firstOrNull { it.baseUrl == current }
    val others = servers.filter { it.baseUrl != current }.sortedByDescending { it.lastUsedAt }

    val grouped = LocalInterfaceStyle.current.components.lists.grouped
    GroupRow(
        title = here?.displayName ?: "Riffet", subtitle = current,
        leading = {
            if (grouped) IconTile(RiffetIcons.Monitor, colors.accent)
            else BrandMark(fg = colors.fg, accent = colors.accent, modifier = Modifier.size(metrics.iconSize))
        },
        trailing = if (others.isNotEmpty()) ({
            Icon(RiffetIcons.ChevronDown, contentDescription = stringResource(Res.string.settings_paired_servers),
                tint = colors.fg3, modifier = Modifier.size(metrics.smallIconSize).rotate(if (open) 180f else 0f))
        }) else null,
        onClick = if (others.isNotEmpty()) ({ open = !open }) else null,
    )
    if (open) {
        others.forEach { server ->
            val switch: () -> Unit = {
                if (busy == null) {
                    busy = server.origin
                    operationScope.launch {
                        try {
                            onPaired(connection.switchServer(server.origin))
                        } catch (cancellation: CancellationException) {
                            throw cancellation
                        } catch (_: RiffetUnauthenticatedException) {
                            onRepair(server.baseUrl)
                        } catch (_: Throwable) {
                            snackbar?.show(getString(Res.string.settings_paired_connect_failed))
                        } finally {
                            busy = null
                        }
                    }
                }
            }
            GroupRow(
                title = server.displayName, subtitle = server.baseUrl,
                leading = { EntryMark(RiffetIcons.Monitor, colors.accent) },
                trailing = if (busy == server.origin) ({ Spinner(size = 18.dp) }) else null,
                enabled = busy == null, onClick = switch,
            )
        }
    }
}

/** Settings' leading mark per style: a tinted tile on grouped styles, a plain secondary glyph on Material. */
@Composable
private fun EntryMark(icon: ImageVector, tint: Color) {
    val style = LocalInterfaceStyle.current
    if (style.components.lists.grouped) IconTile(icon, tint)
    else Icon(icon, null, Modifier.size(style.metrics.iconSize), LocalRiffetColors.current.fg2)
}

@Composable
private fun DrawerItem(label: String, icon: ImageVector, onClick: () -> Unit) {
    GroupRow(title = label, leading = { EntryMark(icon, LocalRiffetColors.current.accent) }, chevron = true, onClick = onClick)
}
