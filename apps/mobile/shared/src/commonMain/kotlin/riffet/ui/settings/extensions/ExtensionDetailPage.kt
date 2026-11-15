package riffet.ui.settings.extensions

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.getString
import org.jetbrains.compose.resources.stringResource
import riffet.contracts.ExtensionActionRequest
import riffet.contracts.ExtensionDetail
import riffet.contracts.ExtensionItem
import riffet.shared.extension
import riffet.ui.app.LocalRiffetSnackbar
import riffet.ui.app.PageBarProgress
import riffet.ui.design.ConfirmDialog
import riffet.ui.design.GroupRow
import riffet.ui.design.IconTile
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.icons.RiffetIcons
import riffet.ui.settings.ExtensionsController
import riffet.ui.settings.PageBanner
import riffet.ui.settings.SettingsActionRow
import riffet.ui.settings.SettingsFootnote
import riffet.ui.settings.SettingsGroup
import riffet.ui.settings.SettingsNavigationRow
import riffet.ui.settings.SettingsNoticeKind
import riffet.ui.settings.SettingsPage
import riffet.ui.settings.SettingsSwitchRow
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet_mobile.shared.generated.resources.*

/** One extension: header, the main switch, what it relates to, its other actions, and removal last. */
@Composable
internal fun ExtensionDetailPage(controller: ExtensionsController, itemId: String, push: (ExtRoute) -> Unit, onBack: () -> Unit) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val scope = rememberCoroutineScope()
    val snackbar = LocalRiffetSnackbar.current
    val uri = LocalUriHandler.current
    val runner = remember(controller.api, snackbar) { ExtensionActionRunner(controller.api, scope, snackbar) }
    val listed = controller.inventory?.items?.firstOrNull { it.id == itemId }
    var detail by remember(itemId) { mutableStateOf<ExtensionDetail?>(null) }
    var loading by remember(itemId) { mutableStateOf(true) }
    var loadError by remember(itemId) { mutableStateOf<String?>(null) }
    var confirm by remember { mutableStateOf<String?>(null) }

    suspend fun load() {
        loading = true
        try { detail = controller.api.extension(controller.context, itemId); loadError = null }
        catch (cancel: CancellationException) { throw cancel }
        catch (failure: Throwable) { loadError = failure.message ?: getString(Res.string.settings_extra_ext_action_failed) }
        finally { loading = false }
    }
    LaunchedEffect(itemId) { load() }
    fun afterChange() { controller.reload(); scope.launch { load() } }

    val current: ExtensionItem? = detail?.item ?: listed
    val busy = runner.busy || loading
    SettingsPage(current?.name.orEmpty(), onBack, actions = { if (busy) PageBarProgress() }) {
        if (current == null) {
            if (loadError != null) PageBanner(loadError.orEmpty(), SettingsNoticeKind.ERROR)
            return@SettingsPage
        }
        val actions = extensionActions(current, controller)
        val toggles = "enable" in actions || "disable" in actions
        val others = actions.filter { it != "enable" && it != "disable" && it != "uninstall" }
        val state = extensionRuntimeState(current.runtimeState)

        Row(Modifier.fillMaxWidth().padding(vertical = metrics.rowPadding), horizontalArrangement = Arrangement.spacedBy(metrics.rowPadding), verticalAlignment = Alignment.Top) {
            IconTile(extensionGlyph(current.kind), colors.accent, size = metrics.iconSlot * 1.4f)
            Column(Modifier.weight(1f)) {
                Text(current.name, style = typography.title, color = colors.fg)
                Text(extensionKind(current.kind) + " · " + extensionScope(current.scope), style = typography.caption, color = colors.fg3)
            }
        }
        current.description?.takeIf { it.isNotBlank() }?.let {
            Text(it, style = typography.body, color = colors.fg2, modifier = Modifier.padding(bottom = metrics.rowPadding))
        }
        (runner.error ?: loadError)?.let { PageBanner(it, SettingsNoticeKind.ERROR) }

        if (toggles || state != null) SettingsGroup("") {
            if (toggles) SettingsSwitchRow(stringResource(Res.string.ext_enabled), checked = current.enabled ?: true, enabled = !busy) { on ->
                val next = if (on) "enable" else "disable"
                if (next in actions) runner.run(controller.context, ExtensionActionRequest(next, current.id)) { afterChange() }
            }
            if (state != null) GroupRow(stringResource(Res.string.ext_state), value = state)
        }
        current.readOnlyReason?.let { SettingsFootnote(it) }
        current.managementNote?.let { SettingsFootnote(it) }
        if (toggles && current.kind == "skill") SettingsFootnote(stringResource(Res.string.settings_extra_ext_confirm_skill_note))
        current.sourcePath?.let { path ->
            SelectionContainer { Text(path, style = typography.monoSmall, color = colors.fg3, modifier = Modifier.padding(horizontal = metrics.rowPadding, vertical = metrics.rowPadding / 2)) }
        }

        val files = detail?.files.orEmpty()
        if (files.isNotEmpty() || (detail != null && current.documentId != null)) SettingsGroup(stringResource(Res.string.ext_config_files)) {
            files.forEach { file ->
                GroupRow(
                    title = file.path.substringAfterLast('/'), subtitle = listOfNotNull(file.path, file.reason).joinToString("\n"), subtitleLines = 2,
                    leading = { ExtensionIcon("config") }, chevron = true, onClick = { push(ExtRoute.Editor(file.id)) },
                )
            }
            if (files.isEmpty()) current.documentId?.let { documentId ->
                SettingsNavigationRow(stringResource(Res.string.ext_view_config), "", RiffetIcons.FileText) { push(ExtRoute.Editor(documentId)) }
            }
        }
        current.ownerPluginId?.let { owner ->
            val ownerName = controller.inventory?.items?.firstOrNull { it.id == owner }?.name ?: owner
            SettingsGroup("") { SettingsNavigationRow(stringResource(Res.string.settings_owner_plugin), ownerName, RiffetIcons.Puzzle) { push(ExtRoute.Detail(owner)) } }
        }
        if (others.isNotEmpty()) SettingsGroup("") {
            others.forEach { action -> SettingsActionRow(extensionAction(action), onClick = { confirm = action }, enabled = !busy) }
        }
        runner.authorization?.let { url ->
            SettingsGroup("") { SettingsActionRow(stringResource(Res.string.ext_open_auth), onClick = { uri.openUri(url) }) }
            SettingsFootnote(stringResource(Res.string.ext_auth_note))
        }
        if ("uninstall" in actions) SettingsGroup("") {
            SettingsActionRow(extensionAction("uninstall"), onClick = { confirm = "uninstall" }, danger = true, enabled = !busy)
        }
    }

    val pending = confirm
    if (pending != null && current != null) {
        val label = extensionAction(pending)
        ConfirmDialog(
            title = stringResource(Res.string.ext_confirm_title, label, current.name),
            confirmLabel = label,
            danger = pending == "uninstall",
            onConfirm = {
                confirm = null
                runner.run(controller.context, ExtensionActionRequest(pending, current.id)) {
                    if (pending == "uninstall") { controller.reload(); onBack() } else afterChange()
                }
            },
            onDismiss = { confirm = null },
        )
    }
}

/** What the server lets this extension do from here; none for what the user does not manage. */
private fun extensionActions(item: ExtensionItem, controller: ExtensionsController): List<String> {
    if (item.readOnlyReason != null || item.ownerPluginId != null || item.scope in listOf("managed", "builtin")) return emptyList()
    if (item.kind in listOf("mcp", "plugin") && item.nativeId.isNullOrEmpty()) return emptyList()
    val supported = controller.capabilities?.kinds?.get(item.kind).orEmpty()
    return supported.filter { it != "install" && (item.actions == null || it in item.actions!!) }
}
