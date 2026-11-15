package riffet.ui.settings.diagnostics

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.getString
import org.jetbrains.compose.resources.stringResource
import riffet.shared.*
import riffet.ui.app.LocalRiffetSnackbar
import riffet.ui.app.PageHost
import riffet.ui.app.PageMoreAction
import riffet.ui.app.PageStack
import riffet.ui.design.ConfirmDialog
import riffet.ui.design.GroupRow
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.pickers.RiffetMenuItem
import riffet.ui.platform.redactLog
import riffet.ui.settings.PageBanner
import riffet.ui.settings.SettingsController
import riffet.ui.settings.SettingsActionRow
import riffet.ui.settings.SettingsGroup
import riffet.ui.settings.SettingsNavigationRow
import riffet.ui.settings.SettingsNoticeKind
import riffet.ui.settings.SettingsPage
import riffet.ui.settings.SettingsSearchTarget
import riffet.ui.settings.SettingsValueRow
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet_mobile.shared.generated.resources.*

private sealed interface DiagnosticsRoute {
    data object Main : DiagnosticsRoute
    data object Models : DiagnosticsRoute
    data object Advanced : DiagnosticsRoute
}

/** The diagnostics category page and the lists beneath it. */
@Composable
internal fun DiagnosticsPage(
    api: RiffetApi,
    controller: SettingsController,
    title: String,
    onBack: () -> Unit,
    searchTarget: SettingsSearchTarget?,
    onOpenBenchmark: () -> Unit,
) {
    val state by controller.state.collectAsState()
    LaunchedEffect(controller) { if (controller.state.value.capabilities == null) controller.loadDiagnostics() }
    val pages = remember { PageStack<DiagnosticsRoute>(DiagnosticsRoute.Main) }
    PageHost(pages) { route, back ->
        when (route) {
            DiagnosticsRoute.Main -> SettingsPage(
                title, onBack, searchTarget = searchTarget,
                refreshing = state.diagnosticsLoading && state.capabilities != null, onRefresh = { controller.loadDiagnostics() },
                actions = {
                    PageMoreAction { close ->
                        RiffetMenuItem(
                            text = stringResource(Res.string.settings_recheck),
                            enabled = !state.diagnosticsLoading,
                            onClick = { close(); controller.loadDiagnostics() },
                        )
                    }
                },
            ) {
                LogsSection(api)
                state.diagnosticsError?.let { Spacer(Modifier.height(16.dp)); PageBanner(it, SettingsNoticeKind.ERROR) }
                EnvironmentSection(controller) { pages.push(DiagnosticsRoute.Models) }
                SettingsGroup("") {
                    SettingsNavigationRow(stringResource(Res.string.settings_advanced_diagnostics), "") { pages.push(DiagnosticsRoute.Advanced) }
                }
                ClearLogsSection()
            }
            DiagnosticsRoute.Models -> SettingsPage(stringResource(Res.string.setp_available_models), back) {
                val models = state.capabilities?.models.orEmpty()
                SettingsGroup("") { models.forEach { GroupRow(title = it) } }
            }
            DiagnosticsRoute.Advanced -> SettingsPage(stringResource(Res.string.settings_advanced_diagnostics), back) {
                SettingsGroup("") {
                    SettingsNavigationRow(stringResource(Res.string.settings_render_benchmark), stringResource(Res.string.settings_terminal_render_test_desc), onClick = onOpenBenchmark)
                }
            }
        }
    }
}

/** Upload sends the log to the server, which keeps it on its own machine; export saves it to Downloads and opens the share sheet. */
@Composable
private fun LogsSection(api: RiffetApi) {
    val scope = rememberCoroutineScope()
    val snackbar = LocalRiffetSnackbar.current
    var uploading by remember { mutableStateOf(false) }
    var exporting by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<String?>(null) }
    failure?.let { PageBanner(it, SettingsNoticeKind.ERROR) }
    SettingsGroup(stringResource(Res.string.settings_diagnostics_logs)) {
        SettingsActionRow(
            title = stringResource(Res.string.settings_upload_logs),
            subtitle = stringResource(Res.string.settings_upload_logs_desc),
            busy = uploading,
            onClick = {
                uploading = true
                failure = null
                scope.launch {
                    try {
                        AppLog.log("app", "upload requested")
                        val saved = api.uploadClientLog(AppLog.exportName(), redactLog(AppLog.export()))
                        snackbar?.show(getString(Res.string.settings_upload_success, saved.path, saved.bytes / 1024))
                    } catch (cancellation: CancellationException) {
                        throw cancellation
                    } catch (error: Throwable) {
                        failure = getString(Res.string.settings_upload_failed, (error.message ?: error::class.simpleName).toString())
                    } finally {
                        uploading = false
                    }
                }
            },
        )
        if (downloadsSupported) SettingsActionRow(
            title = stringResource(Res.string.settings_export_logs),
            subtitle = stringResource(Res.string.settings_export_logs_desc),
            busy = exporting,
            onClick = {
                exporting = true
                failure = null
                scope.launch {
                    try {
                        AppLog.log("app", "export requested")
                        val bytes = redactLog(AppLog.export()).encodeToByteArray()
                        val saved = saveDownload(AppLog.exportName(), "text/plain", bytes)
                        shareSavedFile(saved, getString(Res.string.settings_share_logs))
                        snackbar?.show(getString(Res.string.settings_export_success, saved.location, bytes.size / 1024))
                    } catch (cancellation: CancellationException) {
                        throw cancellation
                    } catch (error: Throwable) {
                        failure = getString(Res.string.settings_export_failed, (error.message ?: error::class.simpleName).toString())
                    } finally {
                        exporting = false
                    }
                }
            },
        )
    }
}

@Composable
private fun ClearLogsSection() {
    val scope = rememberCoroutineScope()
    val snackbar = LocalRiffetSnackbar.current
    var confirm by remember { mutableStateOf(false) }
    SettingsGroup("") {
        SettingsActionRow(title = stringResource(Res.string.settings_clear_logs), danger = true, onClick = { confirm = true })
    }
    if (confirm) ConfirmDialog(
        title = stringResource(Res.string.setp_clear_logs_title),
        message = stringResource(Res.string.setp_clear_logs_message),
        confirmLabel = stringResource(Res.string.settings_clear),
        danger = true,
        onDismiss = { confirm = false },
        onConfirm = {
            confirm = false
            scope.launch {
                AppLog.clear()
                snackbar?.show(getString(Res.string.settings_logs_cleared))
            }
        },
    )
}

@Composable
private fun EnvironmentSection(controller: SettingsController, onOpenModels: () -> Unit) {
    val metrics = LocalInterfaceStyle.current.metrics
    val state by controller.state.collectAsState()
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val capabilities = state.capabilities

    SettingsGroup(title = stringResource(Res.string.settings_runtime_environment)) {
        if (capabilities == null) {
            Text(
                text = stringResource(Res.string.settings_no_cli_capabilities),
                style = typography.caption,
                color = colors.fg3,
                modifier = Modifier.padding(horizontal = metrics.pageInset, vertical = metrics.rowPadding),
            )
        } else {
            SettingsValueRow(stringResource(Res.string.settings_version), capabilities.cliVersion ?: stringResource(Res.string.settings_unknown))
            SettingsValueRow(stringResource(Res.string.settings_path), capabilities.cliPath)
            val custom = capabilities.authMessage?.startsWith("Custom Cursor provider") == true
            SettingsValueRow(
                if (custom) stringResource(Res.string.settings_custom_service) else stringResource(Res.string.settings_account),
                if (capabilities.authenticated) {
                    if (custom) stringResource(Res.string.settings_connected) else stringResource(Res.string.settings_signed_in)
                } else {
                    stringResource(Res.string.settings_signed_out)
                },
            )
            SettingsValueRow("tmux", if (capabilities.tmux) stringResource(Res.string.settings_available) else stringResource(Res.string.settings_not_installed))
            SettingsValueRow(stringResource(Res.string.settings_persistence), capabilities.nativePersistence)
            SettingsValueRow("Tailscale", if (capabilities.tailscale.present) capabilities.tailscale.message else stringResource(Res.string.settings_not_detected))
            SettingsValueRow(stringResource(Res.string.settings_checked_at), capabilities.checkedAt)
            if (capabilities.models.isNotEmpty()) {
                SettingsNavigationRow(stringResource(Res.string.setp_available_models), capabilities.models.size.toString(), onClick = onOpenModels)
            }
        }
    }

    if (capabilities != null && capabilities.warnings.isNotEmpty()) {
        Spacer(Modifier.height(16.dp))
        Column(verticalArrangement = Arrangement.spacedBy(metrics.controlInset / 2)) {
            capabilities.warnings.forEach { warning -> PageBanner(warning, SettingsNoticeKind.WARNING) }
        }
    }
}
