package riffet.ui.settings.providers

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import org.jetbrains.compose.resources.stringResource
import riffet.contracts.NativeBackendId
import riffet.contracts.NativeBackendProfileSettings
import riffet.contracts.PatchValue
import riffet.ui.app.LocalPageBack
import riffet.ui.app.PageBackHandler
import riffet.ui.design.ConfirmDialog
import riffet.ui.design.GroupRow
import riffet.ui.design.GroupField
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.icons.Icon
import riffet.ui.icons.RiffetIcons
import riffet.ui.settings.*
import riffet.ui.theme.LocalRiffetColors
import riffet_mobile.shared.generated.resources.*

/**
 * The pages of one provider: the editor, and beneath it the model list, one model and the launch
 * settings. They share the editor's draft, so they live in a stack inside the provider's own page.
 */
internal sealed interface ProviderSub {
    data object Editor : ProviderSub
    data object Models : ProviderSub
    data object Launch : ProviderSub
    data class Model(val id: String) : ProviderSub
}

@Composable
internal fun ProviderEditorPage(
    controller: SettingsController,
    backendId: NativeBackendId,
    id: String,
    onBack: () -> Unit,
    onDeleted: () -> Unit,
    launchOnly: Boolean = false,
) {
    val state by controller.state.collectAsState()
    val profile = state.profileLists[backendId]?.firstOrNull { it.id == id }
    LaunchedEffect(controller) { controller.clearMessages() }
    if (profile == null) {
        SettingsPage(stringResource(Res.string.settings_provider), onBack) {
            PageBanner(stringResource(Res.string.settings_provider_missing), SettingsNoticeKind.ERROR)
        }
        return
    }
    ProviderEditor(controller, backendId, profile, onBack, onDeleted, launchOnly)
}

@Composable
private fun ProviderEditor(
    controller: SettingsController,
    backendId: NativeBackendId,
    profile: NativeBackendProfileSettings,
    onBack: () -> Unit,
    onDeleted: () -> Unit,
    launchOnly: Boolean,
) {
    val state by controller.state.collectAsState()
    val colors = LocalRiffetColors.current
    val isCursor = backendId == NativeBackendId.CURSOR
    var draft by remember(profile) { mutableStateOf(editableDraft(profile)) }
    var apiKeyDraft by remember(profile) { mutableStateOf("") }
    var clearKey by remember(profile) { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    val pages = remember { riffet.ui.app.PageStack<ProviderSub>(ProviderSub.Editor) }
    val busy = state.saving
    val isDefault = defaultProfileId(state, backendId) == profile.id
    val pageBack = LocalPageBack.current

    val patch = backendProfilePatch(profile, draft.copy(apiKeyDraft = apiKeyDraft, clearApiKey = clearKey))
    val dirty = patch != null
    // Saved and typed protocol; Antigravity always speaks Gemini, pi lets the user choose.
    fun protocolOf(endpoint: String?, protocol: String?): String? = when (backendId) {
        NativeBackendId.ANTIGRAVITY -> "google-generative-ai"
        NativeBackendId.PI -> protocol ?: DEFAULT_API_PROTOCOL
        else -> null
    }
    val catalog = rememberModelCatalog(
        controller = controller,
        backendId = backendId,
        profileId = profile.id,
        apiEndpoint = draft.apiEndpoint,
        apiProtocol = protocolOf(draft.apiEndpoint, draft.apiProtocol),
        apiKeyDraft = apiKeyDraft,
        clearApiKey = clearKey,
        savedApiEndpoint = profile.apiEndpoint.orEmpty(),
        savedApiProtocol = protocolOf(profile.apiEndpoint, profile.apiProtocol),
        enabled = !isCursor && !launchOnly,
        modelSource = draft.modelSource,
        savedModelSource = profile.modelSource,
    )
    val customPi = backendId == NativeBackendId.PI && draft.modelSource == null && draft.apiEndpoint.isNotEmpty()
    // DSH and a custom pi endpoint carry input types only through the profile Riffet writes.
    val inputs = if (backendId == NativeBackendId.DSH || customPi) draft.modelInputModalities else null
    // Claude Code and a custom pi endpoint read a declared window; a CLI login knows its own models.
    val contextWindows = if ((backendId == NativeBackendId.CLAUDE && (draft.apiEndpoint.isNotEmpty() || draft.modelSource != null)) || customPi) draft.modelContextWindows else null

    fun save() {
        patch?.let { body ->
            val sent = if (backendId == NativeBackendId.ANTIGRAVITY) body.copy(apiProtocol = PatchValue.key("google-generative-ai".takeIf { draft.apiEndpoint.isNotBlank() })) else body
            // The saved profile resets the draft; leaving here skips the guard that still sees the old draft.
            controller.updateProfile(backendId, profile.id, sent) { pageBack?.leaveConfirmed() ?: onBack() }
        }
    }

    if (launchOnly) {
        EditPage(stringResource(Res.string.settings_advanced_launch_settings), onBack, dirty = dirty, busy = busy, onSave = ::save) {
            ControllerMessages(controller)
            ProviderLaunchFields(backendId, draft, !busy) { draft = it }
        }
        return
    }

    // On the provider's own page, not the editor inside the stack: every way out of the provider,
    // from any page beneath the editor too, asks before dropping the draft.
    UnsavedSettingsGuard(dirty = dirty, busy = busy)
    riffet.ui.app.PageHost(pages) { page, back ->
        when (page) {
            ProviderSub.Editor -> ProviderEditorRoot(
                controller, backendId, profile, draft, { draft = it }, apiKeyDraft, { apiKeyDraft = it }, clearKey, { clearKey = it },
                dirty, busy, isDefault, isCursor, onBack, ::save, onOpen = { pages.push(it) }, onDelete = { confirmDelete = true },
            )
            ProviderSub.Models -> ProviderModelsPage(
                catalog = catalog,
                enabled = draft.enabledModels,
                disabled = busy,
                canFetch = draft.apiEndpoint.isNotEmpty(),
                inputs = inputs,
                contextWindows = contextWindows,
                onChange = { draft = draft.copy(enabledModels = it) },
                onOpen = { pages.push(ProviderSub.Model(it)) },
                onBack = back,
            )
            ProviderSub.Launch -> ProviderLaunchPage(backendId, draft, !busy, { draft = it }, back)
            is ProviderSub.Model -> ProviderModelDetailPage(
                model = catalog.find(page.id, draft.enabledModels),
                inputs = inputs,
                contextWindows = contextWindows,
                savedContextWindows = profile.modelContextWindows.orEmpty(),
                enabled = !busy,
                onInputsChange = { draft = draft.copy(modelInputModalities = it) },
                onContextWindowsChange = { draft = draft.copy(modelContextWindows = it) },
                onBack = back,
            )
        }
    }

    if (confirmDelete) ConfirmDialog(
        title = stringResource(Res.string.settings_delete_profile_title, profile.name),
        message = stringResource(Res.string.settings_delete_profile_body),
        confirmLabel = stringResource(Res.string.settings_delete),
        danger = true,
        onConfirm = {
            confirmDelete = false
            controller.deleteProfile(backendId, profile.id, onDeleted = onDeleted)
        },
        onDismiss = { confirmDelete = false },
    )
}

/** The provider's fields; its pages beneath open through [onOpen]. */
@Composable
private fun ProviderEditorRoot(
    controller: SettingsController,
    backendId: NativeBackendId,
    profile: NativeBackendProfileSettings,
    draft: BackendProfileDraft,
    setDraft: (BackendProfileDraft) -> Unit,
    apiKeyDraft: String,
    setApiKeyDraft: (String) -> Unit,
    clearKey: Boolean,
    setClearKey: (Boolean) -> Unit,
    dirty: Boolean,
    busy: Boolean,
    isDefault: Boolean,
    isCursor: Boolean,
    onBack: () -> Unit,
    save: () -> Unit,
    onOpen: (ProviderSub) -> Unit,
    onDelete: () -> Unit,
) {
    val state by controller.state.collectAsState()
    val colors = LocalRiffetColors.current
    EditPage(profile.name, onBack, dirty = dirty, busy = busy, onSave = save, guard = false) {
        ControllerMessages(controller)
        val (sources, availableSources, sourcesLoaded) = rememberProviderSources(controller, backendId)
        val choice = connectionChoice(draft, sources)
        val entry = sources.firstOrNull { it.id == draft.modelSource }
        SettingsGroup("") {
            if (hasEndpoint(backendId) && !isCursor) ProviderConnectionChoices(draft, sources, !busy && sourcesLoaded, availableSources) { next ->
                val keepConnection = isApiConnection(choice, sources) && isApiConnection(connectionChoice(next, sources), sources)
                setDraft(next)
                if (!keepConnection) { setApiKeyDraft(""); setClearKey(true) }
            }
            GroupField(value = draft.name, onValueChange = { setDraft(draft.copy(name = it)) }, label = stringResource(Res.string.settings_name), enabled = !busy)
            if (hasEndpoint(backendId) && (isCursor || choice != "login" && (entry == null || "apiEndpoint" in entry.overridable))) GroupField(
                value = draft.apiEndpoint,
                onValueChange = { setDraft(if (isCursor) updateCursorProfileGateway(draft, it) else draft.copy(apiEndpoint = it)) },
                label = stringResource(Res.string.settings_service_address),
                placeholder = entry?.defaultEndpoint ?: endpointPlaceholder(backendId),
                enabled = !busy,
                mono = true,
            )
            if (backendId == NativeBackendId.PI && draft.apiEndpoint.isNotEmpty()) {
                SettingsChoiceRow("API", apiProtocols, draft.apiProtocol ?: DEFAULT_API_PROTOCOL, enabled = !busy) { setDraft(draft.copy(apiProtocol = it)) }
            }
            if (choice != "login" && (entry == null || "apiKey" in entry.overridable) || isCursor) {
                GroupField(
                    value = apiKeyDraft,
                    onValueChange = { setApiKeyDraft(it); setClearKey(false) },
                    label = "API Key",
                    placeholder = if (profile.hasApiKey == true) stringResource(Res.string.settings_api_key_replace_placeholder) else stringResource(Res.string.settings_api_key_placeholder),
                    enabled = !busy,
                    mono = true,
                    password = true,
                )
                Box(Modifier.padding(horizontal = LocalInterfaceStyle.current.metrics.rowPadding, vertical = LocalInterfaceStyle.current.metrics.rowPadding / 2)) {
                    SettingsStatusLine(
                        text = when {
                            clearKey -> stringResource(Res.string.settings_api_key_cleared_on_save)
                            profile.hasApiKey == true -> stringResource(Res.string.settings_api_key_configured)
                            else -> stringResource(Res.string.settings_api_key_missing)
                        },
                        tone = if (profile.hasApiKey == true && !clearKey) colors.accent else colors.fg4,
                    )
                }
                if (profile.hasApiKey == true) {
                    SettingsActionRow(
                        title = if (clearKey) stringResource(Res.string.settings_cancel_clear) else stringResource(Res.string.prov_clear_key),
                        danger = !clearKey,
                        enabled = !busy,
                        onClick = { setApiKeyDraft(""); setClearKey(!clearKey) },
                    )
                }
            }
            GroupField(
                value = draft.defaultModel,
                onValueChange = { setDraft(draft.copy(defaultModel = it)) },
                label = stringResource(Res.string.settings_default_model),
                placeholder = stringResource(Res.string.settings_cli_default),
                enabled = !busy,
                mono = true,
            )
        }
        if (hasEndpoint(backendId)) endpointHint(backendId)?.let { SettingsFootnote(it) }
        if (draft.apiEndpoint.isNotEmpty() || isCursor) SettingsFootnote(stringResource(Res.string.settings_api_key_hint))

        ProviderQuota(controller, backendId, profile, dirty)

        SettingsGroup("") {
            if (!isCursor) {
                SettingsNavigationRow(
                    stringResource(Res.string.settings_models),
                    draft.enabledModels?.let { stringResource(Res.string.prov_models_enabled, it.size) } ?: stringResource(Res.string.prov_models_all),
                ) { onOpen(ProviderSub.Models) }
            }

        }

        SettingsGroup("") {
            if (isDefault) {
                GroupRow(title = stringResource(Res.string.settings_new_session_default), trailing = { Icon(RiffetIcons.Check, null, tint = colors.accent) })
            } else {
                val setDefaultMessage = stringResource(Res.string.settings_set_as_default_done)
                SettingsActionRow(stringResource(Res.string.settings_set_as_default), enabled = !busy, onClick = {
                    state.settings?.let { controller.saveSettings(defaultProfilePatch(it, backendId, profile.id), setDefaultMessage) }
                })
            }
        }

        if (!isCursor) {
            SettingsGroup("") {
                SettingsActionRow(stringResource(Res.string.settings_delete), danger = true, enabled = !busy, onClick = onDelete)
            }
            Spacer(Modifier.height(16.dp))
        }
        }
}
