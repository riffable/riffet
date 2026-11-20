package riffet.ui.settings

import riffet.ui.design.LocalInterfaceStyle
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import riffet.ui.design.AlertDialog
import riffet.ui.design.ConfirmDialog
import riffet.ui.icons.Icon
import riffet.ui.design.RiffetIconButton
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.material3.Text
import riffet.ui.design.RiffetTextButton
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CoroutineScope
import riffet.ui.app.PageLeaveGuard
import riffet.ui.app.PageBackHandler
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.stringResource
import riffet_mobile.shared.generated.resources.*
import riffet.shared.PairedServer
import riffet.shared.RiffetApi
import riffet.shared.RiffetConnection
import riffet.shared.RiffetUnauthenticatedException
import riffet.i18n.L10n
import riffet.ui.icons.RiffetIcons
import riffet.ui.pickers.RiffetDropdownMenu
import riffet.ui.pickers.RiffetMenuItem
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet.ui.timeline.Spinner

/** Also used before a connection exists, so an old pairing never requires a new code. */
@Composable
internal fun PairedServersSection(
    connection: RiffetConnection,
    onPaired: (RiffetApi) -> Unit,
    onPair: (String?) -> Unit,
    onDisconnected: () -> Unit,
    operationScope: CoroutineScope? = null,
    connectionOperation: MutableState<String?> = remember { mutableStateOf<String?>(null) },
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val composedScope = rememberCoroutineScope()
    val scope = operationScope ?: composedScope
    var servers by remember(connection) { mutableStateOf<List<PairedServer>>(emptyList()) }
    var loading by remember(connection) { mutableStateOf(true) }
    var busy by connectionOperation
    var error by remember { mutableStateOf<Pair<String?, String>?>(null) }
    var forgetting by remember { mutableStateOf<PairedServer?>(null) }
    var renamingOrigin by rememberSaveable { mutableStateOf<String?>(null) }
    var renameName by rememberSaveable { mutableStateOf("") }
    var renameError by rememberSaveable { mutableStateOf<String?>(null) }
    val current = connection.apiOrNull()?.baseUrl
    val readFailed = stringResource(Res.string.settings_paired_load_failed)
    val needsRepair = stringResource(Res.string.settings_paired_needs_repair)
    val connectFailed = stringResource(Res.string.settings_paired_connect_failed)
    val forgetFailed = stringResource(Res.string.settings_forget_failed)
    val renameFailed = stringResource(Res.string.settings_rename_server_failed)
    PageBackHandler(enabled = busy != null) { }
    PageLeaveGuard { busy == null }
    LaunchedEffect(connection, current) {
        try {
            servers = connection.pairedServers()
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (_: Throwable) {
            error = null to readFailed
        } finally {
            loading = false
        }
    }
    fun connect(server: PairedServer) {
        if (busy != null || server.baseUrl == current) return
        busy = server.origin
        error = null
        scope.launch {
            try {
                onPaired(connection.switchServer(server.origin))
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (_: RiffetUnauthenticatedException) {
                error = server.origin to needsRepair
            } catch (_: Throwable) {
                error = server.origin to connectFailed
            } finally {
                busy = null
            }
        }
    }
    val ordered = servers.sortedWith(compareByDescending<PairedServer> { it.baseUrl == current }.thenByDescending { it.lastUsedAt })
    if (loading || ordered.isNotEmpty()) {
        SettingsGroup(stringResource(Res.string.settings_paired_servers)) {
            if (loading) Box(Modifier.fillMaxWidth().heightIn(min = 72.dp), contentAlignment = Alignment.Center) { Spinner(size = 20.dp) }
            ordered.forEach { server ->
                key(server.origin) {
                    var menu by remember { mutableStateOf(false) }
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = 72.dp)
                            .semantics { selected = server.baseUrl == current }
                            .clickable(enabled = busy == null, role = Role.RadioButton) { connect(server) }
                            .padding(start = 16.dp, end = 4.dp, top = 12.dp, bottom = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(Modifier.size(metrics.iconSize), contentAlignment = Alignment.Center) {
                            when {
                                busy == server.origin -> Spinner(size = 18.dp)
                                else -> riffet.ui.design.SelectionMark(server.baseUrl == current, enabled = busy == null)
                            }
                        }
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f)) {
                            Text(server.displayName, style = typography.body, color = colors.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Spacer(Modifier.height(2.dp))
                            Text(server.baseUrl, style = typography.caption, color = colors.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            error?.takeIf { it.first == server.origin }?.let {
                                if (it.second == needsRepair) {
                                    // The one remedy is pairing again, so the state is that action.
                                    RiffetTextButton(onClick = { onPair(server.baseUrl) }, enabled = busy == null) {
                                        Text(stringResource(Res.string.settings_pair_again))
                                    }
                                } else {
                                    Text(it.second, style = typography.caption, color = colors.danger)
                                }
                            }
                        }
                        Box {
                            RiffetIconButton(onClick = { menu = true }, enabled = busy == null) {
                                Icon(RiffetIcons.Ellipsis, stringResource(Res.string.settings_paired_actions), tint = colors.fg2, modifier = Modifier.size(20.dp))
                            }
                            RiffetDropdownMenu(menu, { menu = false }) {
                                Text(server.baseUrl, style = typography.caption, color = colors.fg3, modifier = Modifier.widthIn(max = 280.dp).padding(horizontal = 16.dp, vertical = 8.dp))
                                RiffetMenuItem(stringResource(Res.string.session_rename), {
                                    menu = false
                                    renameName = server.name.orEmpty()
                                    renameError = null
                                    renamingOrigin = server.origin
                                }, icon = RiffetIcons.Pencil)
                                RiffetMenuItem(stringResource(Res.string.settings_pair_again), { menu = false; onPair(server.baseUrl) }, icon = RiffetIcons.Refresh)
                                RiffetMenuItem(stringResource(Res.string.settings_forget_server), { menu = false; forgetting = server }, icon = RiffetIcons.Trash, danger = true)
                            }
                        }
                    }
                }
            }
        }
    }
    SettingsGroup("") {
        riffet.ui.design.GroupRow(
            title = stringResource(Res.string.settings_pair_new_server),
            leading = { Icon(RiffetIcons.Plus, null, tint = colors.fg2, modifier = Modifier.size(metrics.iconSize)) },
            enabled = busy == null, role = Role.Button, onClick = { onPair(null) },
        )
    }
    SettingsFootnote(stringResource(Res.string.settings_paired_local_only))
    error?.takeIf { it.first == null }?.let { PageBanner(it.second, SettingsNoticeKind.ERROR) }
    servers.firstOrNull { it.origin == renamingOrigin }?.let { server ->
        val validName = PairedServer.isValidName(renameName)
        val nameLabel = stringResource(Res.string.settings_name)
        AlertDialog(
            onDismissRequest = { if (busy == null) renamingOrigin = null },
            title = { Text(stringResource(Res.string.settings_rename_server)) },
            text = {
                val focus = remember { FocusRequester() }
                LaunchedEffect(server.origin) { focus.requestFocus() }
                Column(verticalArrangement = Arrangement.spacedBy(metrics.controlInset / 2)) {
                    SettingsField(
                        value = renameName,
                        onValueChange = { renameName = it; renameError = null },
                        placeholder = nameLabel,
                        enabled = busy == null,
                        modifier = Modifier.focusRequester(focus).semantics { contentDescription = nameLabel },
                    )
                    Text(stringResource(Res.string.settings_server_name_note), style = typography.caption, color = colors.fg3)
                    val message = if (!validName) L10n.uiText("connection.invalidServerName") else renameError
                    message?.let { Text(it, style = typography.caption, color = colors.danger) }
                }
            },
            confirmButton = {
                RiffetTextButton(enabled = busy == null && validName, onClick = rename@ {
                    if (connectionOperation.value != null) return@rename
                    val name = renameName
                    busy = server.origin
                    renameError = null
                    scope.launch {
                        try {
                            val renamed = connection.renameServer(server.origin, name)
                            servers = servers.map { if (it.origin == renamed.origin) renamed else it }
                            renamingOrigin = null
                        } catch (cancellation: CancellationException) {
                            throw cancellation
                        } catch (_: Throwable) {
                            renameError = renameFailed
                        } finally {
                            busy = null
                        }
                    }
                }) { Text(stringResource(Res.string.settings_save)) }
            },
            dismissButton = { RiffetTextButton(enabled = busy == null, onClick = { renamingOrigin = null }) { Text(stringResource(Res.string.settings_cancel)) } },
        )
    }
    forgetting?.let { server ->
        ConfirmDialog(
            title = stringResource(Res.string.confirm_forget_server_title, server.displayName),
            message = stringResource(Res.string.settings_forget_server_body),
            confirmLabel = stringResource(Res.string.settings_forget),
            danger = true,
            enabled = busy == null,
            onDismiss = { if (busy == null) forgetting = null },
            onConfirm = forget@ {
                    if (connectionOperation.value != null) return@forget
                    busy = server.origin
                    scope.launch {
                        try {
                            val disconnected = connection.forgetServer(server.origin)
                            forgetting = null
                            if (disconnected) onDisconnected() else servers = connection.pairedServers()
                        } catch (cancellation: CancellationException) {
                            throw cancellation
                        } catch (_: Throwable) {
                            error = server.origin to forgetFailed
                            forgetting = null
                        } finally {
                            busy = null
                        }
                    }
            },
        )
    }
}
