package riffet.ui.app

import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.GroupRow
import riffet.ui.design.Group
import riffet.ui.design.GroupTitle
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Text
import androidx.compose.ui.Alignment
import riffet.ui.pickers.PickerOverlay
import riffet.ui.state.RiffetConnectionState
import riffet.ui.timeline.StatusDot
import riffet.ui.theme.LocalRiffetTypography
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
import riffet.ui.icons.RiffetIcons
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.timeline.Spinner
import riffet_mobile.shared.generated.resources.*

/**
 * The navigation drawer's content (mobile.md §2.7): the owner as the header, the server card (tap to
 * switch among paired servers), the 下载 / 统计 tiles, then the host's folder favorites, each of
 * which starts a new session there.
 */
@Composable
internal fun WorkbenchDrawer(
    api: RiffetApi?,
    owner: OwnerController?,
    connection: RiffetConnection,
    status: RiffetConnectionState,
    onClose: () -> Unit,
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
    val metrics = LocalInterfaceStyle.current.metrics
    Column(Modifier.fillMaxSize()) {
        DrawerHeader(owner, onOwner, onClose)
        Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()).padding(bottom = metrics.sectionGap)) {
            ServerCard(api, connection, status, onPaired, onRepair, operationScope, connectionOperation)
            val downloading = if (downloadsSupported) DownloadCenter.shared.items.collectAsState().value.any { it.state == DownloadState.RUNNING } else false
            val tools = buildList {
                if (downloadsSupported) add(PaneAction(RiffetIcons.Download,
                    if (downloading) stringResource(Res.string.session_downloading) else stringResource(Res.string.session_downloads), onClick = onDownloads))
                if (api != null) add(PaneAction(RiffetIcons.Chart, stringResource(Res.string.session_stats), onClick = onStats))
            }
            if (tools.isNotEmpty()) {
                PaneGap()
                PaneActionBar(tools)
            }
            if (api != null) {
                val picks = rememberFolderFavorites(api).byRecentUse
                if (picks.isNotEmpty()) PaneSection(stringResource(Res.string.drawer_favorites)) {
                    picks.forEach { favorite ->
                        PaneRow(title = favoriteName(favorite), leading = { PaneIcon(RiffetIcons.Star, colors.warning) }, onClick = { onFavorite(favorite) })
                    }
                }
            }
            PaneEnd()
        }
    }
}

/** The owner's avatar and name (the page title while there is no name); the title opens the owner page. */
@Composable
private fun DrawerHeader(controller: OwnerController?, onOwner: () -> Unit, onClose: () -> Unit) {
    rememberResourceEnvironment()
    val metrics = LocalInterfaceStyle.current.metrics
    if (controller == null) {
        PaneHeader(title = "Riffet", onClose = onClose)
        return
    }
    val owner = controller.state.collectAsState().value.owner
    PaneHeader(
        title = owner?.name?.takeIf { it.isNotBlank() } ?: L10n.uiText("owner.title"),
        onClose = onClose,
        leading = { OwnerAvatar(owner, controller.avatarUrl(owner), metrics.iconSlot * 4 / 3) },
        onTitleClick = onOwner,
    )
}

/** The connected server on one row: name, address, connection state; with others paired it opens the picker. */
@Composable
private fun ServerCard(
    api: RiffetApi?,
    connection: RiffetConnection,
    status: RiffetConnectionState,
    onPaired: (RiffetApi) -> Unit,
    onRepair: (String) -> Unit,
    operationScope: CoroutineScope,
    connectionOperation: MutableState<String?>,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val type = LocalRiffetTypography.current
    val snackbar = LocalRiffetSnackbar.current
    val current = api?.baseUrl
    var servers by remember(connection) { mutableStateOf<List<PairedServer>>(emptyList()) }
    var picking by rememberSaveable { mutableStateOf(false) }
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

    val (tint, label) = when (status) {
        RiffetConnectionState.Idle -> null to null
        // Connected is the normal state and says nothing (mobile.md §1); only the exceptions do.
        RiffetConnectionState.Live -> null to null
        RiffetConnectionState.Connecting -> colors.fg3 to stringResource(Res.string.session_connecting)
        RiffetConnectionState.Reconnecting -> colors.warning to stringResource(Res.string.session_reconnecting)
        is RiffetConnectionState.Failed -> colors.danger to stringResource(Res.string.session_disconnected)
    }
    PaneSection {
        PaneRow(
            // The address only under a name; a server known by its address does not repeat it.
            title = here?.displayName ?: current?.substringAfter("://")?.trimEnd('/') ?: "Riffet",
            subtitle = current?.takeIf { here?.displayName != null && here.displayName != it.substringAfter("://").trimEnd('/') },
            leading = { if (tint != null) PaneDot(tint) else PaneIcon(RiffetIcons.Monitor) },
            value = label,
            chevron = others.isNotEmpty(),
            onClick = if (others.isNotEmpty()) ({ picking = true }) else null,
        )
    }
    if (picking && others.isNotEmpty()) {
        PickerOverlay(title = stringResource(Res.string.settings_paired_servers), onDismiss = { picking = false }) {
            Group {
                (listOfNotNull(here) + others).forEach { server ->
                    val isCurrent = server.baseUrl == current
                    val switch: () -> Unit = {
                        if (isCurrent) picking = false
                        else if (busy == null) {
                            busy = server.origin
                            operationScope.launch {
                                try {
                                    onPaired(connection.switchServer(server.origin))
                                    picking = false
                                } catch (cancellation: CancellationException) {
                                    throw cancellation
                                } catch (_: RiffetUnauthenticatedException) {
                                    picking = false
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
                        trailing = when {
                            busy == server.origin -> ({ Spinner(size = metrics.smallIconSize) })
                            isCurrent -> ({ Icon(RiffetIcons.Check, null, tint = colors.accent, modifier = Modifier.size(metrics.smallIconSize)) })
                            else -> null
                        },
                        enabled = busy == null, onClick = switch,
                    )
                }
            }
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
