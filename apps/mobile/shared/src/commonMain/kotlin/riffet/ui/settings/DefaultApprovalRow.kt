package riffet.ui.settings

import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import org.jetbrains.compose.resources.stringResource
import riffet_mobile.shared.generated.resources.*
import riffet.contracts.AppSettings
import riffet.contracts.AppSettingsUpdate
import riffet.contracts.NativeBackendCapabilities
import riffet.contracts.NativeBackendDefaults
import riffet.contracts.NativeBackendId
import riffet.contracts.NativeBackendOption
import riffet.ui.app.LocalPageActive
import riffet.ui.pickers.ApprovalPickerSheet
import riffet.ui.pickers.optionLabelOf
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.timeline.Spinner

internal fun defaultApprovalPatch(settings: AppSettings, backendId: NativeBackendId, approval: String): AppSettingsUpdate {
    val defaults = settings.nativeBackendDefaults.orEmpty()
    return AppSettingsUpdate(nativeBackendDefaults = defaults + (backendId to
        (defaults[backendId] ?: NativeBackendDefaults()).copy(approval = approval.takeIf { it.isNotBlank() })))
}

@Composable
internal fun DefaultApprovalRow(controller: SettingsController, backendId: NativeBackendId) {
    val state by controller.state.collectAsState()
    val settings = state.settings ?: return
    val defaults = settings.nativeBackendDefaults?.get(backendId)
    var capabilities by remember(backendId) { mutableStateOf<NativeBackendCapabilities?>(null) }
    var loading by remember(backendId) { mutableStateOf(true) }
    var failure by remember(backendId) { mutableStateOf<Throwable?>(null) }
    var retry by remember(backendId) { mutableIntStateOf(0) }
    var choosing by remember(backendId) { mutableStateOf(false) }
    val loadFailed = stringResource(Res.string.settings_approval_load_failed)
    val cliDefault = stringResource(Res.string.settings_approval_cli_default)
    val modeDescription = stringResource(Res.string.settings_approval_mode_desc, backendLabel(backendId))
    val savingReason = stringResource(Res.string.settings_approval_saving)
    val savedMessage = stringResource(Res.string.settings_approval_saved)
    LaunchedEffect(controller, backendId, defaults?.profileId, retry) {
        loading = true
        failure = null
        capabilities = null
        controller.backendCapabilities(backendId).fold(
            onSuccess = { capabilities = it },
            onFailure = { failure = it },
        )
        loading = false
    }
    val permissions = capabilities?.takeIf { it.supportsPermissionSelection }?.permissions.orEmpty()
    val error = failure?.settingsMessage(loadFailed)
    val options = listOf(NativeBackendOption("", cliDefault, null)) + permissions
    val value = defaults?.approval.orEmpty()
    val label = optionLabelOf(options, value, stringResource(Res.string.pickers_approval_title))
    // A choice row: the mode at the end opens the picker; a failed load retries from the same row.
    val title = stringResource(Res.string.settings_approval_mode)
    val retryLabel = stringResource(Res.string.settings_retry)
    val unsupported = stringResource(Res.string.settings_approval_unsupported)
    riffet.ui.design.GroupRow(
        title = title,
        subtitle = error ?: modeDescription,
        subtitleLines = 3,
        value = when {
            loading -> null
            error != null -> retryLabel
            permissions.isEmpty() -> unsupported
            else -> label
        },
        trailing = if (loading) ({ Spinner() }) else null,
        enabled = !state.saving && !loading && (error != null || permissions.isNotEmpty()),
        onClick = { if (error != null) retry++ else choosing = true },
        modifier = androidx.compose.ui.Modifier.settingsSearchAnchor(title),
    )
    if (choosing && LocalPageActive.current) ApprovalPickerSheet(
        options = options,
        value = value,
        currentLabel = label,
        disabledReason = if (state.saving) savingReason else null,
        onDismiss = { choosing = false },
        onSelect = { next ->
            if (!state.saving) {
                choosing = false
                if (next != value) controller.saveSettings(defaultApprovalPatch(settings, backendId, next), savedMessage)
            }
        },
    )
}
