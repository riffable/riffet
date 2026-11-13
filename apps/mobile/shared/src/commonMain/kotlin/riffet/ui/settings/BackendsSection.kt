package riffet.ui.settings

import riffet.ui.design.LocalInterfaceStyle
import androidx.compose.ui.semantics.Role
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import riffet.ui.design.AlertDialog
import riffet.ui.icons.Icon
import androidx.compose.material3.Text
import riffet.ui.design.RiffetTextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.stringResource
import riffet_mobile.shared.generated.resources.*
import kotlin.random.Random
import riffet.contracts.AppSettingsUpdate
import riffet.contracts.ModelInfo
import riffet.contracts.NativeBackendDefaults
import riffet.contracts.NativeBackendId
import riffet.contracts.NativeBackendProfileSettings
import riffet.contracts.NativeBackendProfileSettingsUpdate
import riffet.contracts.PatchValue
import riffet.ui.design.Group
import riffet.ui.icons.AgentMark
import riffet.ui.icons.AgentMarks
import riffet.ui.icons.RiffetIcons
import riffet.ui.pickers.RiffetDropdownMenu
import riffet.ui.pickers.RiffetMenuItem
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet.ui.theme.LocalRiffetMotion
import riffet.ui.timeline.Chevron
import riffet.ui.timeline.Spinner

/*
 * Agent backends: one CLI at a time, one provider card at a time, exactly the shape of the web's
 * `BackendProfilesSection.tsx`. Cursor is the exception the server enforces: it has a single
 * built-in `default` profile, cannot curate its model list, and carries an extra `agentEndpoint`.
 */

private val backendOrder = listOf(
    NativeBackendId.CURSOR,
    NativeBackendId.CODEX,
    NativeBackendId.CLAUDE,
    NativeBackendId.DSH,
    NativeBackendId.DROID,
    NativeBackendId.TRAEX,
    NativeBackendId.PI,
    NativeBackendId.ANTIGRAVITY,
)

internal fun backendLabel(id: NativeBackendId): String = when (id) {
    NativeBackendId.CURSOR -> "Cursor"
    NativeBackendId.CODEX -> "Codex"
    NativeBackendId.CLAUDE -> "Claude"
    NativeBackendId.DSH -> "DeepSeek"
    NativeBackendId.DROID -> "Droid"
    NativeBackendId.TRAEX -> "TRAE CLI"
    NativeBackendId.PI -> "pi"
    NativeBackendId.ANTIGRAVITY -> "Antigravity"
    NativeBackendId.CHAT -> "Quick chat"
}

/** Droid and TRAE CLI sign in on their own, so neither has a service address. Only Droid also hides the config directory. */
private fun hasEndpoint(id: NativeBackendId): Boolean = id != NativeBackendId.DROID && id != NativeBackendId.TRAEX

private fun hasConfigDir(id: NativeBackendId): Boolean = id != NativeBackendId.DROID && id != NativeBackendId.ANTIGRAVITY

@Composable
private fun endpointPlaceholder(id: NativeBackendId): String = when (id) {
    NativeBackendId.CLAUDE -> "https://gateway.example.com"
    NativeBackendId.CODEX -> "https://gateway.example.com/v1"
    NativeBackendId.DSH -> "https://api.deepseek.com"
    NativeBackendId.DROID -> stringResource(Res.string.settings_extra_endpoint_placeholder_droid)
    NativeBackendId.TRAEX -> stringResource(Res.string.settings_extra_endpoint_placeholder_traex)
    NativeBackendId.CURSOR -> stringResource(Res.string.settings_extra_endpoint_placeholder_cursor)
    NativeBackendId.PI -> "https://"
    NativeBackendId.ANTIGRAVITY -> "https://"
    NativeBackendId.CHAT -> ""
}

@Composable
private fun endpointHint(id: NativeBackendId): String? = when (id) {
    NativeBackendId.CLAUDE -> stringResource(Res.string.settings_extra_endpoint_hint_claude)
    NativeBackendId.CODEX -> stringResource(Res.string.settings_extra_endpoint_hint_codex)
    NativeBackendId.DSH -> stringResource(Res.string.settings_extra_endpoint_hint_dsh)
    NativeBackendId.DROID -> stringResource(Res.string.settings_extra_endpoint_hint_droid)
    NativeBackendId.TRAEX -> stringResource(Res.string.settings_extra_endpoint_hint_traex)
    NativeBackendId.CURSOR -> null
    NativeBackendId.PI -> null
    NativeBackendId.ANTIGRAVITY -> null
    NativeBackendId.CHAT -> null
}

/** The wire APIs pi can speak, in the order the editor offers them. */
private val apiProtocols = listOf(
    "openai-completions" to "OpenAI Chat Completions",
    "openai-responses" to "OpenAI Responses",
    "anthropic-messages" to "Anthropic Messages",
    "google-generative-ai" to "Google Gemini",
)

private const val DEFAULT_API_PROTOCOL = "openai-completions"

/** A menu rather than a segmented row: four brand names do not fit one line on a phone. */
@Composable
private fun ApiProtocolField(value: String?, enabled: Boolean, onSelect: (String) -> Unit) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val selected = value ?: DEFAULT_API_PROTOCOL
    val label = apiProtocols.firstOrNull { it.first == selected }?.second ?: selected
    var open by remember { mutableStateOf(false) }
    FieldLabel("API")
    Box {
        SettingsButton(label, enabled = enabled, onClick = { open = true })
        RiffetDropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            apiProtocols.forEach { (id, title) ->
                RiffetMenuItem(
                    onClick = { open = false; onSelect(id) },
                    selected = id == selected,
                    showCheck = true,
                ) { Text(title, style = typography.body, color = colors.fg) }
            }
        }
    }
}

/** A profile id the server accepts (`[A-Za-z0-9][A-Za-z0-9._-]{0,99}`), generated client-side. */
internal fun newProfileId(): String = "p" + Random.nextLong().toULong().toString(36) + Random.nextLong().toULong().toString(36).take(8)

@Composable
internal fun BackendsSection(controller: SettingsController, onSelect: (NativeBackendId) -> Unit) {
    val state by controller.state.collectAsState()
    val settings = state.settings ?: return
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    SettingsGroup(stringResource(Res.string.settings_agent_backends)) {
        backendOrder.forEach { id ->
            val isDefault = (settings.defaultBackendId ?: NativeBackendId.CURSOR) == id
            // The brand mark stays neutral rather than sitting on a coloured tile, which would
            // recolour every agent's own mark.
            SettingsLinkRow(
                title = backendLabel(id),
                subtitle = if (isDefault) stringResource(Res.string.settings_new_session_default) else null,
                leading = AgentMarks.vector(id.name.lowercase())?.let { { AgentMark(backendId = id.name.lowercase(), size = 20.dp, tint = colors.fg2) } },
                onClick = { onSelect(id) },
            )
        }
    }
    SettingsFootnote(stringResource(Res.string.settings_backend_save_note))
    SettingsGroup(stringResource(Res.string.settings_new_session)) {
        DefaultApprovalRow(controller, settings.defaultBackendId ?: NativeBackendId.CURSOR)
    }
}

/** Same-provider changes preserve overrides; another provider gets its own model/mode defaults. */
internal fun defaultProfilePatch(settings: riffet.contracts.AppSettings, backendId: NativeBackendId, profileId: String): AppSettingsUpdate {
    val defaults = settings.nativeBackendDefaults.orEmpty()
    return AppSettingsUpdate(
        defaultBackendId = backendId,
        nativeBackendDefaults = defaults + (backendId to (defaults[backendId]?.takeIf { it.profileId == profileId } ?: NativeBackendDefaults()).copy(profileId = profileId)),
    )
}

@Composable
internal fun BackendProfilesSection(
    controller: SettingsController,
    backendId: NativeBackendId,
    onEdit: (String) -> Unit,
    onAdd: () -> Unit,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val state by controller.state.collectAsState()
    val settings = state.settings ?: return
    val colors = LocalRiffetColors.current
    val setDefaultMessage = stringResource(Res.string.settings_set_as_default_done)
    val profiles = state.profileLists[backendId]
    val loading = state.profilesLoading[backendId] == true
    state.profilesErrors[backendId]?.let { message ->
        PageBanner(message, SettingsNoticeKind.ERROR)
        Spacer(Modifier.height(8.dp))
        SettingsButton(stringResource(Res.string.settings_retry), enabled = !loading, onClick = { controller.loadProfiles(backendId) })
    }
    SettingsGroup(stringResource(Res.string.settings_provider), card = profiles != null || loading, action = {
        if (backendId != NativeBackendId.CURSOR && hasEndpoint(backendId)) SettingsButton(stringResource(Res.string.settings_add), enabled = !state.saving, onClick = onAdd)
    }) {
        if (loading && profiles == null) {
            Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) { Spinner(size = 20.dp) }
        }
        profiles?.forEach { profile ->
            val default = profile.id == defaultProfileId(state, backendId)
            val endpoint = profile.apiEndpoint ?: stringResource(Res.string.settings_cli_builtin_login)
            val summary = if (default) stringResource(Res.string.settings_profile_default_summary, endpoint) else endpoint
            SettingsNavigationRow(profile.name, summary) { onEdit(profile.id) }
        }
        if (!loading && profiles != null && profiles.isEmpty()) {
            Text(stringResource(Res.string.settings_no_providers), style = LocalRiffetTypography.current.bodySmall, color = colors.fg3, modifier = Modifier.padding(metrics.pageInset))
        }
    }
    val currentDefault = defaultProfileId(state, backendId)
    if (currentDefault != null) SettingsGroup(stringResource(Res.string.settings_new_session)) {
        SettingsRow(stringResource(Res.string.settings_default_backend), if ((settings.defaultBackendId ?: NativeBackendId.CURSOR) == backendId) stringResource(Res.string.settings_current_backend, backendLabel(backendId)) else null) {
            SettingsButton(stringResource(Res.string.settings_set_as_default), enabled = !state.saving && (settings.defaultBackendId ?: NativeBackendId.CURSOR) != backendId, onClick = {
                controller.saveSettings(defaultProfilePatch(settings, backendId, currentDefault), setDefaultMessage)
            })
        }
        DefaultApprovalRow(controller, backendId)
    }
}

@Composable
internal fun BackendProfileEditor(
    backendId: NativeBackendId,
    profile: NativeBackendProfileSettings,
    isDefault: Boolean,
    controller: SettingsController,
    onDeleted: () -> Unit,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val state by controller.state.collectAsState()
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val isCursor = backendId == NativeBackendId.CURSOR
    var draft by remember(profile) { mutableStateOf(editableDraft(profile)) }
    var apiKeyDraft by remember(profile) { mutableStateOf("") }
    var clearKey by remember(profile) { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    val busy = state.saving

    val patch = backendProfilePatch(profile, draft.copy(apiKeyDraft = apiKeyDraft, clearApiKey = clearKey))
    val dirty = patch != null
    fun save(after: () -> Unit = {}) {
        patch?.let { body ->
            controller.updateProfile(backendId, profile.id, if (backendId == NativeBackendId.ANTIGRAVITY) body.copy(apiProtocol = PatchValue.key("google-generative-ai".takeIf { draft.apiEndpoint.isNotBlank() })) else body) {
                apiKeyDraft = ""
                clearKey = false
                after()
            }
        }
    }
    UnsavedSettingsGuard(dirty, busy, onSave = ::save)
    val setDefaultMessage = stringResource(Res.string.settings_set_as_default_done)
    val onSetDefault: () -> Unit = {
        state.settings?.let { settings ->
            controller.saveSettings(defaultProfilePatch(settings, backendId, profile.id), setDefaultMessage)
        }
    }

    Spacer(Modifier.height(8.dp))
    Group(Modifier.bleed()) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(text = profile.name, style = typography.body, color = colors.fg, modifier = Modifier.weight(1f, fill = false), maxLines = 2, overflow = TextOverflow.Ellipsis)
                    if (isDefault) {
                        Spacer(Modifier.width(6.dp))
                        Text(text = stringResource(Res.string.settings_default), style = typography.caption, color = colors.fg3)
                    }
                }
                Text(
                    text = profile.apiEndpoint ?: stringResource(Res.string.settings_backend_cli_builtin_login, backendLabel(backendId)),
                    style = typography.caption,
                    color = colors.fg3,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }

        Column(modifier = Modifier.padding(horizontal = metrics.pageInset, vertical = metrics.rowPadding)) {
            FieldLabel(stringResource(Res.string.settings_name))
            SettingsField(value = draft.name, onValueChange = { draft = draft.copy(name = it) }, enabled = !busy)

            if (hasEndpoint(backendId)) {
                Spacer(Modifier.height(10.dp))
                FieldLabel(stringResource(Res.string.settings_service_address))
                endpointHint(backendId)?.let { HintText(it) }
                SettingsField(
                    value = draft.apiEndpoint,
                    onValueChange = { draft = if (isCursor) updateCursorProfileGateway(draft, it) else draft.copy(apiEndpoint = it) },
                    placeholder = endpointPlaceholder(backendId),
                    enabled = !busy,
                    mono = true,
                )
            }

            if (backendId == NativeBackendId.PI && draft.apiEndpoint.isNotEmpty()) {
                Spacer(Modifier.height(10.dp))
                ApiProtocolField(value = draft.apiProtocol, enabled = !busy) { draft = draft.copy(apiProtocol = it) }
            }

            if (draft.apiEndpoint.isNotEmpty() || isCursor) {
                Spacer(Modifier.height(10.dp))
                FieldLabel("API Key")
                HintText(stringResource(Res.string.settings_api_key_hint))
                SettingsField(
                    value = apiKeyDraft,
                    onValueChange = { apiKeyDraft = it; clearKey = false },
                    placeholder = if (profile.hasApiKey == true) stringResource(Res.string.settings_api_key_replace_placeholder) else stringResource(Res.string.settings_api_key_placeholder),
                    enabled = !busy,
                    mono = true,
                    password = true,
                )
                Spacer(Modifier.height(4.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    SettingsStatusLine(
                        text = when {
                            clearKey -> stringResource(Res.string.settings_api_key_cleared_on_save)
                            profile.hasApiKey == true -> stringResource(Res.string.settings_api_key_configured)
                            else -> stringResource(Res.string.settings_api_key_missing)
                        },
                        tone = if (profile.hasApiKey == true && !clearKey) colors.accent else colors.fg4,
                    )
                    if (profile.hasApiKey == true) {
                        Spacer(Modifier.width(8.dp))
                        SettingsButton(
                            text = if (clearKey) stringResource(Res.string.settings_cancel_clear) else stringResource(Res.string.settings_clear_key),
                            enabled = !busy,
                            onClick = { apiKeyDraft = ""; clearKey = !clearKey },
                        )
                    }
                }
            }

            if (!isCursor) {
                Spacer(Modifier.height(12.dp))
                EnabledModelsEditor(
                    backendId = backendId,
                    profileId = profile.id,
                    enabled = draft.enabledModels,
                    apiEndpoint = draft.apiEndpoint,
                    apiKeyDraft = apiKeyDraft,
                    apiProtocol = if (backendId == NativeBackendId.ANTIGRAVITY) "google-generative-ai" else if (backendId == NativeBackendId.PI) draft.apiProtocol ?: DEFAULT_API_PROTOCOL else null,
                    savedApiEndpoint = profile.apiEndpoint.orEmpty(),
                    savedApiProtocol = if (backendId == NativeBackendId.ANTIGRAVITY) "google-generative-ai" else if (backendId == NativeBackendId.PI) profile.apiProtocol ?: DEFAULT_API_PROTOCOL else null,
                    clearApiKey = clearKey,
                    controller = controller,
                    disabled = busy,
                    onChange = { draft = draft.copy(enabledModels = it) },
                    // DSH and a custom pi endpoint carry input types only through the profile Riffet
                    // writes; the other CLIs, and pi's own CLI login, would store a choice nothing reads.
                    inputs = if (backendId == NativeBackendId.DSH ||
                        (backendId == NativeBackendId.PI && profile.modelSource == null && draft.apiEndpoint.isNotEmpty())
                    ) draft.modelInputModalities else null,
                    onInputsChange = { next -> draft = draft.copy(modelInputModalities = next) },
                    // Claude Code and a custom pi endpoint read a declared window; a CLI login knows
                    // its own models and nothing would consume the declaration.
                    contextWindows = if (
                        (backendId == NativeBackendId.CLAUDE && (draft.apiEndpoint.isNotEmpty() || profile.modelSource != null)) ||
                        (backendId == NativeBackendId.PI && profile.modelSource == null && draft.apiEndpoint.isNotEmpty())
                    ) draft.modelContextWindows else null,
                    savedContextWindows = profile.modelContextWindows.orEmpty(),
                    onContextWindowsChange = { next -> draft = draft.copy(modelContextWindows = next) },
                )
            }

            Spacer(Modifier.height(10.dp))
            FieldLabel(stringResource(Res.string.settings_default_model))
            SettingsField(
                value = draft.defaultModel,
                onValueChange = { draft = draft.copy(defaultModel = it) },
                placeholder = stringResource(Res.string.settings_cli_default),
                enabled = !busy,
                mono = true,
            )

            Spacer(Modifier.height(12.dp))
            CollapsibleAdvanced(
                backendId = backendId,
                draft = draft,
                enabled = !busy,
                onChange = { draft = it },
            )

            Spacer(Modifier.height(12.dp))
            androidx.compose.foundation.layout.FlowRow(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(metrics.controlInset / 2, Alignment.End),
                verticalArrangement = Arrangement.spacedBy(metrics.controlInset / 2),
            ) {
                if (isDefault) {
                    SettingsStatusLine(text = stringResource(Res.string.settings_new_session_default), tone = colors.accent)
                } else {
                    SettingsButton(text = stringResource(Res.string.settings_set_as_default), enabled = !busy && !dirty, onClick = onSetDefault)
                }
                if (!isCursor) {
                    SettingsButton(text = stringResource(Res.string.settings_delete), enabled = !busy, danger = true, onClick = { confirmDelete = true })
                }
                SettingsButton(
                    text = if (state.saving) stringResource(Res.string.settings_saving) else stringResource(Res.string.settings_save),
                    enabled = !busy && dirty,
                    primary = true,
                    onClick = { save() },
                )
            }
        }
    }

    if (confirmDelete && riffet.ui.app.LocalPageActive.current) {
        riffet.ui.app.PageBackHandler { confirmDelete = false }
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text(stringResource(Res.string.settings_delete_profile_title, profile.name)) },
            text = { Text(stringResource(Res.string.settings_delete_profile_body)) },
            confirmButton = {
                RiffetTextButton(danger = true, onClick = {
                    confirmDelete = false
                    controller.deleteProfile(backendId, profile.id, onDeleted = onDeleted)
                }) { Text(stringResource(Res.string.settings_delete)) }
            },
            dismissButton = { RiffetTextButton(onClick = { confirmDelete = false }) { Text(stringResource(Res.string.settings_cancel)) } },
        )
    }
}

@Composable
private fun CollapsibleAdvanced(
    backendId: NativeBackendId,
    draft: BackendProfileDraft,
    enabled: Boolean,
    onChange: (BackendProfileDraft) -> Unit,
) {
    val motion = LocalRiffetMotion.current
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    var open by remember { mutableStateOf(false) }

    Row(
        modifier = Modifier.fillMaxWidth().clickable(role = Role.Button, enabled = enabled) { open = !open }.padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Chevron(open = open)
        Spacer(Modifier.width(6.dp))
        Text(stringResource(Res.string.settings_launch_settings), style = typography.bodySmall, color = colors.fg2)
        Spacer(Modifier.weight(1f))
        Text(stringResource(Res.string.settings_optional), style = typography.caption, color = colors.fg4)
    }
    AnimatedVisibility(open, enter = motion.expandIn(), exit = motion.collapseOut()) {
        Column { AdvancedFields(backendId, draft, enabled, onChange) }
    }
}

@Composable
private fun AdvancedFields(
    backendId: NativeBackendId,
    draft: BackendProfileDraft,
    enabled: Boolean,
    onChange: (BackendProfileDraft) -> Unit,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val showSourceDir = backendId == NativeBackendId.DSH
    val showAutoUpdate = backendId == NativeBackendId.CLAUDE
    val showAgentEndpoint = backendId == NativeBackendId.CURSOR

    FieldLabel(stringResource(Res.string.settings_cli_entry))
    SettingsField(
        value = draft.executable,
        onValueChange = { onChange(draft.copy(executable = it)) },
        placeholder = backendId.name.lowercase(),
        enabled = enabled,
        mono = true,
    )
    if (hasConfigDir(backendId)) {
        Spacer(Modifier.height(10.dp))
        FieldLabel(stringResource(Res.string.settings_config_dir))
        SettingsField(
            value = draft.configDir,
            onValueChange = { onChange(draft.copy(configDir = it)) },
            placeholder = stringResource(Res.string.settings_use_cli_default_dir),
            enabled = enabled,
            mono = true,
        )
    }
    if (showSourceDir) {
        Spacer(Modifier.height(10.dp))
        FieldLabel(stringResource(Res.string.settings_dsh_source_dir))
        SettingsField(
            value = draft.sourceDir,
            onValueChange = { onChange(draft.copy(sourceDir = it)) },
            placeholder = stringResource(Res.string.settings_optional_source_checkout),
            enabled = enabled,
            mono = true,
        )
    }
    if (showAgentEndpoint) {
        Spacer(Modifier.height(10.dp))
        FieldLabel(stringResource(Res.string.settings_agent_endpoint))
        SettingsField(
            value = draft.agentEndpoint,
            onValueChange = { onChange(draft.copy(agentEndpoint = it)) },
            placeholder = stringResource(Res.string.settings_use_cursor_default_endpoint),
            enabled = enabled,
            mono = true,
        )
    }
    if (showAutoUpdate) {
        Spacer(Modifier.height(6.dp))
        Row(
            modifier = Modifier.heightIn(min = metrics.controlHeight).toggleable(draft.disableAutoUpdate, enabled = enabled, role = Role.Switch) { onChange(draft.copy(disableAutoUpdate = it)) },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(stringResource(Res.string.settings_disable_auto_update), style = typography.body, color = colors.fg)
            }
            SettingsSwitch(checked = draft.disableAutoUpdate, enabled = enabled, onCheckedChange = null)
        }
    }
}

@Composable
private fun EnabledModelsEditor(
    backendId: NativeBackendId,
    profileId: String,
    enabled: List<String>?,
    apiEndpoint: String,
    apiKeyDraft: String,
    /** The protocol a pi probe speaks; `null` for every other backend. */
    apiProtocol: String?,
    savedApiEndpoint: String,
    savedApiProtocol: String?,
    clearApiKey: Boolean,
    controller: SettingsController,
    disabled: Boolean,
    onChange: (List<String>?) -> Unit,
    /** Declared input types per model id; `null` when this backend does not consume them. */
    inputs: Map<String, List<String>>?,
    onInputsChange: (Map<String, List<String>>) -> Unit,
    /** Declared context windows per model id; `null` when this backend does not consume them. */
    contextWindows: Map<String, Long>?,
    savedContextWindows: Map<String, Long>,
    onContextWindowsChange: (Map<String, Long>) -> Unit,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val scope = rememberCoroutineScope()
    var models by remember { mutableStateOf<List<ModelInfo>>(emptyList()) }
    var status by remember { mutableStateOf<String?>(null) }
    var probing by remember { mutableStateOf(false) }
    var manual by remember { mutableStateOf("") }
    val catalogConfig = listOf(backendId, profileId, apiEndpoint, apiProtocol, apiKeyDraft, clearApiKey)
    val currentCatalogConfig by rememberUpdatedState(catalogConfig)

    val declared = inputs ?: emptyMap()
    // Input declarations are consumed by DSH and custom pi providers with an endpoint.
    val declaring = inputs != null && apiEndpoint.isNotEmpty()
    val selectProjectFirst = stringResource(Res.string.settings_select_project_for_models)
    val catalogUnavailable = stringResource(Res.string.settings_model_catalog_unavailable)
    val catalogFailed = stringResource(Res.string.settings_model_catalog_failed)
    val noModelsReturned = stringResource(Res.string.settings_no_models_returned)
    val fetchFailedManual = stringResource(Res.string.settings_fetch_failed_manual)

    LaunchedEffect(catalogConfig, savedApiEndpoint, savedApiProtocol, controller.projectId) {
        models = emptyList()
        status = null
        probing = false
        // Saved catalogs do not describe an unsaved provider selection or replacement key.
        if (apiEndpoint != savedApiEndpoint || apiProtocol != savedApiProtocol || apiKeyDraft.isNotEmpty() || clearApiKey) return@LaunchedEffect
        if (controller.projectId == null) {
            status = selectProjectFirst
            return@LaunchedEffect
        }
        val result = controller.catalog(backendId, profileId)
        if (catalogConfig != currentCatalogConfig) return@LaunchedEffect
        models = result.getOrNull()?.models.orEmpty()
        status = result.fold(
            onSuccess = { entry -> if (entry.available) entry.reason else (entry.reason ?: catalogUnavailable) },
            onFailure = { catalogFailed },
        )
    }

    FieldLabel(stringResource(Res.string.settings_models))
    HintText(
        status ?: if (enabled == null) {
            stringResource(Res.string.settings_all_models)
        } else {
            stringResource(Res.string.settings_models_selected, enabled.size)
        },
    )
    if (declaring && backendId == NativeBackendId.DSH) {
        HintText(stringResource(Res.string.settings_gateway_image_hint))
    }
    if (contextWindows != null) {
        HintText(stringResource(Res.string.settings_gateway_context_hint))
    }

    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(metrics.controlInset / 2)) {
        SettingsButton(
            text = if (probing) stringResource(Res.string.settings_fetching) else stringResource(Res.string.settings_fetch_models),
            enabled = !disabled && !probing && apiEndpoint.isNotEmpty(),
            onClick = {
                val requestConfig = currentCatalogConfig
                scope.launch {
                    probing = true
                    val result = controller.probeModels(backendId, apiEndpoint, apiKeyDraft, profileId, apiProtocol, clearApiKey)
                    if (requestConfig != currentCatalogConfig) return@launch
                    result
                        .onSuccess { fetched ->
                            models = fetched
                            status = if (fetched.isEmpty()) noModelsReturned else null
                        }
                        .onFailure { status = fetchFailedManual }
                    probing = false
                }
            },
        )
        SettingsButton(text = stringResource(Res.string.settings_select_all), enabled = !disabled && enabled != null, onClick = { onChange(null) })
        SettingsButton(text = stringResource(Res.string.settings_select_none), enabled = !disabled && enabled?.isNotEmpty() == true, onClick = { onChange(emptyList()) })
    }

    Spacer(Modifier.height(6.dp))
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(max = 220.dp)
            .clip(RoundedCornerShape(metrics.controlRadius))
            .border(metrics.hairlineWidth, colors.line, RoundedCornerShape(metrics.controlRadius))
            .verticalScroll(rememberScrollState()),
    ) {
        val known = models.map { it.value }.toSet()
        val typed = (enabled.orEmpty() + manualList(manual)).filterNot { it in known }.map { ModelInfo(value = it, name = it) }
        val candidates = models + typed
        if (candidates.isEmpty()) {
            Text(
                text = stringResource(Res.string.settings_no_models),
                style = typography.caption,
                color = colors.fg3,
                modifier = Modifier.padding(metrics.controlInset),
            )
        }
        candidates.forEach { model ->
            val selected = enabled == null || enabled.contains(model.value)
            Column(Modifier.fillMaxWidth()) {
                Row(
                    modifier = Modifier.fillMaxWidth().heightIn(min = metrics.controlHeight).toggleable(value = selected, enabled = !disabled, role = Role.Checkbox) {
                        val base = enabled ?: candidates.map { it.value }
                        onChange(if (base.contains(model.value)) base.filterNot { it == model.value } else base + model.value)
                    }.padding(horizontal = 12.dp, vertical = 9.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    riffet.ui.design.RiffetCheckbox(selected, null, enabled = !disabled)
                    Spacer(Modifier.width(8.dp))
                    Column(Modifier.weight(1f)) {
                        Text(model.name, style = typography.bodySmall, color = colors.fg)
                        if (model.name != model.value) Text(model.value, style = typography.monoSmall, color = colors.fg4)
                    }
                }
                if (declaring && selected) {
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(start = 36.dp, end = 12.dp).padding(bottom = 9.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(metrics.sectionGap / 2),
                    ) {
                        Text(stringResource(Res.string.settings_input_type), style = typography.caption, color = colors.fg3)
                        val current = declaredTypes(declared, model.value)
                        INPUT_TYPES.forEach { modality ->
                            InputTypeToggle(
                                label = inputTypeLabel(modality),
                                checked = current.contains(modality),
                                // The backend reads a missing entry as text-only, so the last box stays on.
                                enabled = !disabled && !(current.contains(modality) && current.size == 1),
                                onClick = {
                                    val next = if (current.contains(modality)) current - modality else current + modality
                                    if (next.isNotEmpty()) {
                                        onInputsChange(declared + (model.value to INPUT_TYPES.filter { next.contains(it) }))
                                    }
                                },
                            )
                        }
                    }
                }
                if (contextWindows != null && selected) {
                    ContextWindowRow(
                        declared = contextWindows[model.value],
                        // The catalog already applies a saved declaration, so only an undeclared id shows the gateway's own figure.
                        defaultLabel = if (model.value in savedContextWindows) {
                            stringResource(Res.string.settings_context_default)
                        } else {
                            stringResource(
                                Res.string.settings_context_default_with,
                                model.contextWindow?.let(::contextWindowLabel) ?: stringResource(Res.string.settings_context_undeclared),
                            )
                        },
                        enabled = !disabled,
                        onSelect = { tokens ->
                            onContextWindowsChange(if (tokens == null) contextWindows - model.value else contextWindows + (model.value to tokens))
                        },
                    )
                }
            }
        }
    }

    Spacer(Modifier.height(6.dp))
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(metrics.controlInset / 2)) {
        SettingsField(
            value = manual,
            onValueChange = { manual = it },
            placeholder = stringResource(Res.string.settings_manual_model_placeholder),
            enabled = !disabled,
            mono = true,
            modifier = Modifier.weight(1f),
        )
        SettingsButton(
            text = stringResource(Res.string.settings_add),
            enabled = !disabled && manual.isNotBlank(),
            onClick = {
                val id = manual.trim()
                if (id.isNotEmpty()) {
                    val base = enabled ?: models.map { it.value }
                    if (!base.contains(id)) onChange(base + id)
                }
                manual = ""
            },
        )
    }
}

private fun manualList(text: String): List<String> = text.trim().takeIf { it.isNotEmpty() }?.let { listOf(it) }.orEmpty()

/** The two types DSH's own model editor offers, in the order it shows them. */
private val INPUT_TYPES = listOf("text", "image")

@Composable
private fun inputTypeLabel(modality: String): String = when (modality) {
    "text" -> stringResource(Res.string.settings_extra_input_type_text)
    "image" -> stringResource(Res.string.settings_extra_input_type_image)
    else -> modality
}

/** DSH reads a model it has no entry for as text-only, so that is what an unanswered row shows. */
private fun declaredTypes(declared: Map<String, List<String>>, id: String): List<String> = declared[id] ?: listOf("text")

/** 128K, 200K, 256K and 1M — the windows gateway models are commonly served with. */
private val CONTEXT_WINDOWS = listOf(131_072L, 200_000L, 262_144L, 1_048_576L)

/** `131072` → `128K`, `200000` → `200K`; both `1048576` and `1000000` read as `1M`. */
private fun contextWindowLabel(tokens: Long): String = when {
    tokens % 1_048_576L == 0L -> "${tokens / 1_048_576L}M"
    tokens % 1_000_000L == 0L -> "${tokens / 1_000_000L}M"
    tokens % 1_024L == 0L -> "${tokens / 1_024L}K"
    tokens % 1_000L == 0L -> "${tokens / 1_000L}K"
    else -> tokens.toString()
}

/** A stored window outside the presets stays listed, so opening and saving never changes it. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ContextWindowRow(declared: Long?, defaultLabel: String, enabled: Boolean, onSelect: (Long?) -> Unit) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    FlowRow(
        modifier = Modifier.fillMaxWidth().padding(start = 36.dp, end = 12.dp).padding(bottom = 9.dp),
        horizontalArrangement = Arrangement.spacedBy(metrics.sectionGap / 2),
        verticalArrangement = Arrangement.spacedBy(metrics.controlInset / 3),
    ) {
        Text(stringResource(Res.string.settings_context), style = typography.caption, color = colors.fg3, modifier = Modifier.align(Alignment.CenterVertically))
        InputTypeToggle(label = defaultLabel, checked = declared == null, enabled = enabled, onClick = { onSelect(null) })
        (CONTEXT_WINDOWS + listOfNotNull(declared?.takeUnless { it in CONTEXT_WINDOWS })).forEach { tokens ->
            InputTypeToggle(label = contextWindowLabel(tokens), checked = declared == tokens, enabled = enabled, onClick = { onSelect(tokens) })
        }
    }
}

@Composable
private fun InputTypeToggle(label: String, checked: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    Row(
        modifier = Modifier.heightIn(min = metrics.controlHeight).toggleable(value = checked, enabled = enabled, role = Role.Checkbox) { onClick() },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        riffet.ui.design.RiffetCheckbox(checked, null, enabled = enabled)
        Spacer(Modifier.width(4.dp))
        Text(label, style = typography.caption, color = if (enabled) colors.fg2 else colors.fg4)
    }
}

@Composable
internal fun AddProfileForm(
    backendId: NativeBackendId,
    controller: SettingsController,
    onCancel: () -> Unit,
    onCreated: (String) -> Unit,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val state by controller.state.collectAsState()
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    var name by remember { mutableStateOf("") }
    var custom by remember { mutableStateOf(false) }
    var apiEndpoint by remember { mutableStateOf("") }
    var apiKey by remember { mutableStateOf("") }
    var apiProtocol by remember { mutableStateOf(DEFAULT_API_PROTOCOL) }
    val busy = state.saving
    val id = remember { newProfileId() }
    val valid = name.isNotBlank() && (!custom || apiEndpoint.isNotBlank())
    fun save(after: (() -> Unit)? = null) {
        if (!valid || busy) return
        val body = NativeBackendProfileSettingsUpdate(
            name = name.trim(),
            apiEndpoint = apiEndpoint.trim().takeIf { custom && it.isNotEmpty() },
            apiKey = apiKey.takeIf { custom && it.isNotEmpty() }?.let { PatchValue.key(it) },
            apiProtocol = if (backendId == NativeBackendId.ANTIGRAVITY && custom) PatchValue.key("google-generative-ai") else if (backendId == NativeBackendId.PI && custom) PatchValue.key(apiProtocol) else null,
        )
        controller.createProfile(backendId, id, body) { created -> if (after != null) after() else onCreated(created) }
    }
    UnsavedSettingsGuard(name.isNotEmpty() || apiEndpoint.isNotEmpty() || apiKey.isNotEmpty() || custom, busy, canSave = valid, onSave = ::save)

    Spacer(Modifier.height(8.dp))
    Group(Modifier.bleed()) {
        Column(Modifier.padding(metrics.pageInset)) {
            Text(stringResource(Res.string.settings_add_provider), style = typography.label, color = colors.fg)
            Spacer(Modifier.height(8.dp))
            FieldLabel(stringResource(Res.string.settings_source))
            SettingsSegmented(
                options = listOf("login" to stringResource(Res.string.settings_cli_builtin_login), "custom" to stringResource(Res.string.settings_custom_api)),
                value = if (custom) "custom" else "login",
                enabled = !busy,
                onSelect = { custom = it == "custom" },
            )
            Spacer(Modifier.height(10.dp))
            FieldLabel(stringResource(Res.string.settings_name))
            SettingsField(value = name, onValueChange = { name = it }, placeholder = backendLabel(backendId), enabled = !busy)
            if (custom) {
                Spacer(Modifier.height(10.dp))
                FieldLabel(stringResource(Res.string.settings_service_address))
                endpointHint(backendId)?.let { HintText(it) }
                SettingsField(
                    value = apiEndpoint,
                    onValueChange = { apiEndpoint = it },
                    placeholder = endpointPlaceholder(backendId),
                    enabled = !busy,
                    mono = true,
                )
                if (backendId == NativeBackendId.PI) {
                    Spacer(Modifier.height(10.dp))
                    ApiProtocolField(value = apiProtocol, enabled = !busy) { apiProtocol = it }
                }
                Spacer(Modifier.height(10.dp))
                FieldLabel("API Key")
                SettingsField(
                    value = apiKey,
                    onValueChange = { apiKey = it },
                    placeholder = stringResource(Res.string.settings_api_key_placeholder),
                    enabled = !busy,
                    mono = true,
                    password = true,
                )
            }
            Spacer(Modifier.height(12.dp))
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(metrics.controlInset / 2)) {
                SettingsButton(
                    text = stringResource(Res.string.settings_add),
                    enabled = !busy && valid,
                    primary = true,
                    onClick = { save() },
                )
                SettingsButton(text = stringResource(Res.string.settings_cancel), enabled = !busy, onClick = onCancel)
            }

        }
    }
}

@Composable
private fun FieldLabel(text: String) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    Text(text = text, style = typography.label, color = colors.fg2, modifier = Modifier.padding(bottom = 4.dp))
}

@Composable
private fun HintText(text: String) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    Text(text = text, style = typography.caption, color = colors.fg4, modifier = Modifier.padding(bottom = 4.dp))
}
