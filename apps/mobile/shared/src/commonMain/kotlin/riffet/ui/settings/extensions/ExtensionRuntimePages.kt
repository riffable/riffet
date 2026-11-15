package riffet.ui.settings.extensions

import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.getString
import org.jetbrains.compose.resources.stringResource
import riffet.contracts.ExtensionActionRequest
import riffet.contracts.ExtensionRuntimeReport
import riffet.shared.extensionRuntime
import riffet.ui.app.LocalRiffetSnackbar
import riffet.ui.app.PageBarProgress
import riffet.ui.design.ConfirmDialog
import riffet.ui.design.GroupRow
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.settings.ExtensionsController
import riffet.ui.settings.PageBanner
import riffet.ui.settings.SettingsActionRow
import riffet.ui.settings.SettingsFootnote
import riffet.ui.settings.SettingsGroup
import riffet.ui.settings.SettingsNoticeKind
import riffet.ui.settings.SettingsPage
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet_mobile.shared.generated.resources.*

/** What the agent has loaded now, read from the server when the page opens. */
@Composable
internal fun ExtensionRuntimePage(controller: ExtensionsController, onBack: () -> Unit) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val scope = rememberCoroutineScope()
    val snackbar = LocalRiffetSnackbar.current
    val uri = LocalUriHandler.current
    val runner = remember(controller.api, snackbar) { ExtensionActionRunner(controller.api, scope, snackbar) }
    var report by remember { mutableStateOf<ExtensionRuntimeReport?>(null) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var confirm by remember { mutableStateOf<String?>(null) }

    suspend fun load() {
        loading = true
        try { report = controller.api.extensionRuntime(controller.context); error = null }
        catch (cancel: CancellationException) { throw cancel }
        catch (failure: Throwable) { error = failure.message ?: getString(Res.string.settings_extra_ext_action_failed) }
        finally { loading = false }
    }
    LaunchedEffect(Unit) { load() }

    val retry: () -> Unit = { scope.launch { load() } }
    val canLogin = controller.capabilities?.kinds?.get("mcp")?.contains("login") == true
    val current = report
    SettingsPage(stringResource(Res.string.settings_extension_runtime), onBack, refreshing = loading && current != null, onRefresh = retry,
        actions = { if (runner.busy) PageBarProgress() }) {
        (runner.error ?: error)?.let { PageBanner(it, SettingsNoticeKind.ERROR, stringResource(Res.string.settings_retry), retry.takeIf { error != null }) }
        if (current == null) { if (loading) CenteredSpinner(); return@SettingsPage }
        if (current.entries.isEmpty() && current.diagnostics.isEmpty()) {
            Text(stringResource(Res.string.ext_runtime_empty), style = typography.body, color = colors.fg3, modifier = Modifier.padding(metrics.pageInset))
        }
        if (current.entries.isNotEmpty()) SettingsGroup("") {
            current.entries.forEach { entry ->
                val line = listOfNotNull(extensionKind(entry.kind), extensionRuntimeState(entry.state), entry.message?.takeIf { it.isNotBlank() }, entry.tools?.takeIf { it.isNotEmpty() }?.joinToString(", ")).joinToString("\n")
                GroupRow(entry.name, subtitle = line, subtitleLines = 4, leading = { ExtensionIcon(entry.kind) })
            }
        }
        if (canLogin) {
            val servers = current.entries.filter { it.kind == "mcp" }
            if (servers.isNotEmpty()) SettingsGroup("") {
                servers.forEach { entry ->
                    SettingsActionRow(stringResource(Res.string.ext_auth_login, entry.name), onClick = { confirm = entry.name }, enabled = !runner.busy)
                }
            }
        }
        runner.authorization?.let { url ->
            SettingsGroup("") { SettingsActionRow(stringResource(Res.string.ext_open_auth), onClick = { uri.openUri(url) }) }
            SettingsFootnote(stringResource(Res.string.ext_auth_note))
        }
        if (current.diagnostics.isNotEmpty()) SettingsGroup(stringResource(Res.string.ext_diagnostics)) {
            current.diagnostics.forEach { SelectionContainer { Text(it, style = typography.caption, color = colors.fg2, modifier = Modifier.padding(metrics.pageInset)) } }
        }
    }
    confirm?.let { name ->
        ConfirmDialog(
            title = stringResource(Res.string.ext_confirm_title, extensionAction("login"), name),
            confirmLabel = extensionAction("login"),
            onConfirm = { confirm = null; runner.run(controller.context, ExtensionActionRequest("login", null, name)) },
            onDismiss = { confirm = null },
        )
    }
}

@Composable
internal fun ExtensionDiagnosticsPage(values: List<String>, onBack: () -> Unit) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    SettingsPage(stringResource(Res.string.ext_diagnostics), onBack) {
        SettingsGroup("") {
            values.forEach { SelectionContainer { Text(it, style = typography.caption, color = colors.fg2, modifier = Modifier.padding(metrics.pageInset)) } }
        }
    }
}
