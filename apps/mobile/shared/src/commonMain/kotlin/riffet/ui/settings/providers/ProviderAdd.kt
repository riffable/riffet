package riffet.ui.settings.providers

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import org.jetbrains.compose.resources.stringResource
import riffet.contracts.NativeBackendId
import riffet.contracts.NativeBackendProfileSettingsUpdate
import riffet.contracts.PatchValue
import riffet.ui.app.LocalPageBack
import riffet.ui.design.GroupField
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.settings.*
import riffet_mobile.shared.generated.resources.*

@Composable
internal fun AddProviderPage(controller: SettingsController, backendId: NativeBackendId, onBack: () -> Unit, onCreated: () -> Unit) {
    val metrics = LocalInterfaceStyle.current.metrics
    val state by controller.state.collectAsState()
    val pageBack = LocalPageBack.current
    var name by remember { mutableStateOf("") }
    var custom by remember { mutableStateOf(false) }
    var apiEndpoint by remember { mutableStateOf("") }
    var apiKey by remember { mutableStateOf("") }
    var apiProtocol by remember { mutableStateOf(DEFAULT_API_PROTOCOL) }
    val busy = state.saving
    val id = remember { newProfileId() }
    val valid = name.isNotBlank() && (!custom || apiEndpoint.isNotBlank())
    LaunchedEffect(controller) { controller.clearMessages() }

    fun save() {
        if (!valid || busy) return
        val body = NativeBackendProfileSettingsUpdate(
            name = name.trim(),
            apiEndpoint = apiEndpoint.trim().takeIf { custom && it.isNotEmpty() },
            apiKey = apiKey.takeIf { custom && it.isNotEmpty() }?.let { PatchValue.key(it) },
            apiProtocol = if (backendId == NativeBackendId.ANTIGRAVITY && custom) PatchValue.key("google-generative-ai") else if (backendId == NativeBackendId.PI && custom) PatchValue.key(apiProtocol) else null,
        )
        // Leaving here skips the unsaved-changes guard, which still sees the typed values.
        controller.createProfile(backendId, id, body) { pageBack?.leaveConfirmed() ?: onCreated() }
    }

    EditPage(
        stringResource(Res.string.settings_add_provider_title, backendLabel(backendId)), onBack,
        dirty = name.isNotEmpty() || apiEndpoint.isNotEmpty() || apiKey.isNotEmpty() || custom,
        busy = busy, onSave = ::save, canSave = valid,
        saveLabel = stringResource(Res.string.settings_add),
    ) {
        ControllerMessages(controller)
        SettingsGroup("") {
            SettingsRow(stringResource(Res.string.settings_source)) {
                SettingsSegmented(
                    options = listOf("login" to stringResource(Res.string.settings_cli_builtin_login), "custom" to stringResource(Res.string.settings_custom_api)),
                    value = if (custom) "custom" else "login",
                    enabled = !busy,
                    onSelect = { custom = it == "custom" },
                )
            }
            GroupField(value = name, onValueChange = { name = it }, label = stringResource(Res.string.settings_name), placeholder = backendLabel(backendId), enabled = !busy)
            if (custom) {
                GroupField(value = apiEndpoint, onValueChange = { apiEndpoint = it }, label = stringResource(Res.string.settings_service_address), placeholder = endpointPlaceholder(backendId), enabled = !busy, mono = true)
            }
            if (custom && backendId == NativeBackendId.PI) {
                SettingsChoiceRow("API", apiProtocols, apiProtocol, enabled = !busy) { apiProtocol = it }
            }
            if (custom) {
                GroupField(value = apiKey, onValueChange = { apiKey = it }, label = "API Key", placeholder = stringResource(Res.string.settings_api_key_placeholder), enabled = !busy, mono = true, password = true)
            }
        }
        if (custom) endpointHint(backendId)?.let { SettingsFootnote(it) }
    }
}
