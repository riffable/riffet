package riffet.ui.settings.providers

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.stringResource
import riffet.contracts.ModelInfo
import riffet.contracts.NativeBackendId
import riffet.contracts.NativeBackendProfileFields
import riffet.ui.app.PageBarAction
import riffet.ui.app.PageBarProgress
import riffet.ui.app.PageMoreAction
import riffet.ui.app.PageSearch
import riffet.ui.design.AlertDialog
import riffet.ui.design.GroupRow
import riffet.ui.design.GroupField
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.RiffetTextButton
import riffet.ui.icons.RiffetIcons
import riffet.ui.pickers.RiffetMenuItem
import riffet.ui.settings.*
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet_mobile.shared.generated.resources.*

/** What the provider's gateway serves, read for the editor and refreshed on request. */
@Stable
internal class ModelCatalog {
    var models by mutableStateOf<List<ModelInfo>>(emptyList())
    var status by mutableStateOf<String?>(null)
    var probing by mutableStateOf(false)
    var fetch: () -> Unit = {}

    /** The gateway's models plus any enabled id it did not list (typed by hand). */
    fun candidates(enabled: List<String>?): List<ModelInfo> {
        val known = models.map { it.value }.toSet()
        return models + enabled.orEmpty().filterNot { it in known }.map { ModelInfo(value = it, name = it) }
    }

    fun find(id: String, enabled: List<String>?): ModelInfo = candidates(enabled).firstOrNull { it.value == id } ?: ModelInfo(value = id, name = id)
}

@Composable
internal fun rememberModelCatalog(
    controller: SettingsController,
    backendId: NativeBackendId,
    profileId: String,
    apiEndpoint: String,
    /** The protocol a probe speaks; `null` for backends that do not choose one. */
    apiProtocol: String?,
    apiKeyDraft: String,
    clearApiKey: Boolean,
    savedApiEndpoint: String,
    savedApiProtocol: String?,
    enabled: Boolean,
    modelSource: String? = null,
    savedModelSource: String? = null,
): ModelCatalog {
    val catalog = remember { ModelCatalog() }
    val scope = rememberCoroutineScope()
    val catalogConfig = listOf(backendId, profileId, apiEndpoint, apiProtocol, apiKeyDraft, clearApiKey, modelSource)
    val currentConfig by rememberUpdatedState(catalogConfig)
    val selectProjectFirst = stringResource(Res.string.settings_select_project_for_models)
    val unavailable = stringResource(Res.string.settings_model_catalog_unavailable)
    val failed = stringResource(Res.string.settings_model_catalog_failed)
    val noModels = stringResource(Res.string.settings_no_models_returned)
    val fetchFailed = stringResource(Res.string.settings_fetch_failed_manual)

    LaunchedEffect(catalogConfig, savedApiEndpoint, savedApiProtocol, controller.projectId, enabled) {
        catalog.models = emptyList()
        catalog.status = null
        catalog.probing = false
        if (!enabled) return@LaunchedEffect
        // Saved catalogs do not describe an unsaved provider selection or replacement key.
        if (modelSource != savedModelSource || apiEndpoint != savedApiEndpoint || apiProtocol != savedApiProtocol || apiKeyDraft.isNotEmpty() || clearApiKey) return@LaunchedEffect
        if (controller.projectId == null) {
            catalog.status = selectProjectFirst
            return@LaunchedEffect
        }
        val result = controller.catalog(backendId, profileId)
        if (catalogConfig != currentConfig) return@LaunchedEffect
        catalog.models = result.getOrNull()?.models.orEmpty()
        catalog.status = result.fold(
            onSuccess = { entry -> if (entry.available) entry.reason else (entry.reason ?: unavailable) },
            onFailure = { failed },
        )
    }
    catalog.fetch = {
        val requestConfig = currentConfig
        scope.launch {
            catalog.probing = true
            val result = controller.probeModels(backendId, apiEndpoint, apiKeyDraft, profileId, apiProtocol, clearApiKey, modelSource)
            if (requestConfig != currentConfig) return@launch
            result
                .onSuccess { fetched ->
                    catalog.models = fetched
                    catalog.status = if (fetched.isEmpty()) noModels else null
                }
                .onFailure { catalog.status = fetchFailed }
            catalog.probing = false
        }
    }
    return catalog
}

/** The enable list: one switch row per model; search narrows it, the menu holds the bulk actions. */
@Composable
internal fun ProviderModelsPage(
    catalog: ModelCatalog,
    enabled: List<String>?,
    disabled: Boolean,
    canFetch: Boolean,
    /** Declared input types per model id; `null` when this backend does not consume them. */
    inputs: Map<String, List<String>>?,
    /** Declared context windows per model id; `null` when this backend does not consume them. */
    contextWindows: Map<String, Long>?,
    onChange: (List<String>?) -> Unit,
    onOpen: (String) -> Unit,
    onBack: () -> Unit,
) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val metrics = LocalInterfaceStyle.current.metrics
    var query by remember { mutableStateOf("") }
    var adding by remember { mutableStateOf(false) }
    val candidates = catalog.candidates(enabled)
    val shown = candidates.filter { query.isBlank() || it.name.contains(query, ignoreCase = true) || it.value.contains(query, ignoreCase = true) }
    val detailed = inputs != null || contextWindows != null

    SettingsPage(
        stringResource(Res.string.settings_models), onBack,
        search = PageSearch(query, { query = it }, stringResource(Res.string.prov_search_models)),
        actions = {
            if (catalog.probing) PageBarProgress()
            else PageBarAction(RiffetIcons.Plus, stringResource(Res.string.prov_add_model), { adding = true }, enabled = !disabled)
            PageMoreAction { close ->
                RiffetMenuItem(onClick = { close(); catalog.fetch() }, enabled = !disabled && !catalog.probing && canFetch) {
                    Text(stringResource(Res.string.settings_fetch_models), style = typography.body, color = colors.fg)
                }
                RiffetMenuItem(onClick = { close(); onChange(null) }, enabled = !disabled && enabled != null) {
                    Text(stringResource(Res.string.settings_select_all), style = typography.body, color = colors.fg)
                }
                RiffetMenuItem(onClick = { close(); onChange(emptyList()) }, enabled = !disabled && enabled?.isNotEmpty() == true) {
                    Text(stringResource(Res.string.settings_select_none), style = typography.body, color = colors.fg)
                }
            }
        },
    ) {
        catalog.status?.let { PageBanner(it, SettingsNoticeKind.WARNING) }
        if (shown.isEmpty()) {
            Text(stringResource(Res.string.settings_no_models), style = typography.bodySmall, color = colors.fg3, modifier = Modifier.padding(metrics.pageInset))
        } else SettingsGroup("") {
            shown.forEach { model ->
                val selected = enabled == null || enabled.contains(model.value)
                val toggle = { _: Boolean ->
                    val base = enabled ?: candidates.map { it.value }
                    onChange(if (base.contains(model.value)) base.filterNot { it == model.value } else base + model.value)
                }
                val extra = if (detailed && selected) modelSummary(inputs, contextWindows, model.value) else null
                val subtitle = listOfNotNull(model.value.takeIf { it != model.name }, extra).joinToString(" · ").ifEmpty { null }
                if (detailed && selected) {
                    GroupRow(
                        title = model.name, subtitle = subtitle, enabled = !disabled, chevron = false,
                        trailing = { SettingsSwitch(checked = true, enabled = !disabled, onCheckedChange = toggle) },
                        onClick = { onOpen(model.value) },
                    )
                } else {
                    SettingsSwitchRow(model.name, subtitle, selected, !disabled, toggle)
                }
            }
        }
        if (enabled == null) SettingsFootnote(stringResource(Res.string.settings_all_models))
        if (inputs != null) SettingsFootnote(stringResource(Res.string.settings_gateway_image_hint))
        if (contextWindows != null) SettingsFootnote(stringResource(Res.string.settings_gateway_context_hint))
    }

    if (adding) {
        var id by remember { mutableStateOf("") }
        val add = {
            val value = id.trim()
            if (value.isNotEmpty()) {
                val base = enabled ?: candidates.map { it.value }
                if (!base.contains(value)) onChange(base + value)
            }
            adding = false
        }
        AlertDialog(
            onDismissRequest = { adding = false },
            title = { Text(stringResource(Res.string.prov_add_model)) },
            text = { SettingsField(value = id, onValueChange = { id = it }, placeholder = stringResource(Res.string.settings_manual_model_placeholder), mono = true) },
            confirmButton = { RiffetTextButton(enabled = id.isNotBlank(), onClick = add) { Text(stringResource(Res.string.settings_add)) } },
            dismissButton = { RiffetTextButton(onClick = { adding = false }) { Text(stringResource(Res.string.settings_cancel)) } },
        )
    }
}

/** Input types and context window of one enabled model. */
@Composable
internal fun ProviderModelDetailPage(
    model: ModelInfo,
    inputs: Map<String, List<String>>?,
    contextWindows: Map<String, Long>?,
    savedContextWindows: Map<String, Long>,
    enabled: Boolean,
    onInputsChange: (Map<String, List<String>>) -> Unit,
    onContextWindowsChange: (Map<String, Long>) -> Unit,
    onBack: () -> Unit,
) {
    SettingsPage(model.name, onBack) {
        if (inputs != null) {
            val current = declaredTypes(inputs, model.value)
            SettingsGroup(stringResource(Res.string.settings_input_type)) {
                INPUT_TYPES.forEach { modality ->
                    val on = current.contains(modality)
                    SettingsSwitchRow(
                        title = inputTypeLabel(modality), checked = on,
                        // The backend reads a missing entry as text-only, so the last switch stays on.
                        enabled = enabled && !(on && current.size == 1),
                    ) {
                        val next = if (on) current - modality else current + modality
                        if (next.isNotEmpty()) onInputsChange(inputs + (model.value to INPUT_TYPES.filter { next.contains(it) }))
                    }
                }
            }
        }
        if (contextWindows != null) {
            val declared = contextWindows[model.value]
            // The catalog already applies a saved declaration, so only an undeclared id shows the gateway's own figure.
            val defaultLabel = if (model.value in savedContextWindows) {
                stringResource(Res.string.settings_context_default)
            } else {
                stringResource(Res.string.settings_context_default_with, model.contextWindow?.let(::contextWindowLabel) ?: stringResource(Res.string.settings_context_undeclared))
            }
            // A stored window outside the presets stays listed, so opening and saving never changes it.
            val windows = CONTEXT_WINDOWS + listOfNotNull(declared?.takeUnless { it in CONTEXT_WINDOWS })
            SettingsGroup("") {
                SettingsChoiceRow(
                    title = stringResource(Res.string.settings_context),
                    options = listOf("" to defaultLabel) + windows.map { it.toString() to contextWindowLabel(it) },
                    value = declared?.toString() ?: "",
                    enabled = enabled,
                ) { picked ->
                    onContextWindowsChange(if (picked.isEmpty()) contextWindows - model.value else contextWindows + (model.value to picked.toLong()))
                }
            }
        }
    }
}

/** The less common launch options of one provider. */
@Composable
internal fun ProviderLaunchPage(
    backendId: NativeBackendId,
    draft: BackendProfileDraft,
    enabled: Boolean,
    onChange: (BackendProfileDraft) -> Unit,
    onBack: () -> Unit,
    profileFields: NativeBackendProfileFields? = null,
) {
    SettingsPage(stringResource(Res.string.settings_launch_settings), onBack) {
        ProviderLaunchFields(backendId, draft, enabled, profileFields, onChange)
    }
}

@Composable
internal fun ProviderLaunchFields(
    backendId: NativeBackendId,
    draft: BackendProfileDraft,
    enabled: Boolean,
    profileFields: NativeBackendProfileFields? = null,
    onChange: (BackendProfileDraft) -> Unit,
) {
    val executablePlaceholder = profileFields?.executablePlaceholder ?: if (backendId == NativeBackendId.ANTIGRAVITY) "agy" else backendId.name.lowercase()
    val showConfigDir = profileFields?.configDir ?: hasConfigDir(backendId)
    val sourceDirKind = if (profileFields != null) profileFields.sourceDir else when (backendId) {
        NativeBackendId.DSH -> "source"
        NativeBackendId.ANTIGRAVITY -> "config"
        else -> null
    }
    val showDisableAutoUpdate = profileFields?.disableAutoUpdate ?: (backendId == NativeBackendId.CLAUDE || backendId == NativeBackendId.ANTIGRAVITY)
    SettingsGroup("") {
        GroupField(draft.executable, { onChange(draft.copy(executable = it)) }, label = stringResource(Res.string.settings_cli_entry), placeholder = executablePlaceholder, enabled = enabled, mono = true)
        if (showConfigDir) GroupField(draft.configDir, { onChange(draft.copy(configDir = it)) }, label = stringResource(Res.string.settings_config_dir), placeholder = stringResource(Res.string.settings_use_cli_default_dir), enabled = enabled, mono = true)
        if (sourceDirKind == "source") GroupField(draft.sourceDir, { onChange(draft.copy(sourceDir = it)) }, label = stringResource(Res.string.settings_dsh_source_dir), placeholder = stringResource(Res.string.settings_optional_source_checkout), enabled = enabled, mono = true)
        if (sourceDirKind == "config") GroupField(draft.sourceDir, { onChange(draft.copy(sourceDir = it)) }, label = stringResource(Res.string.settings_config_dir), placeholder = stringResource(Res.string.settings_use_cli_default_dir), enabled = enabled, mono = true)
        if (backendId == NativeBackendId.CURSOR) GroupField(draft.agentEndpoint, { onChange(draft.copy(agentEndpoint = it)) }, label = stringResource(Res.string.settings_agent_endpoint), placeholder = stringResource(Res.string.settings_use_cursor_default_endpoint), enabled = enabled, mono = true)
    }
    if (showDisableAutoUpdate) SettingsGroup("") {
        SettingsSwitchRow(stringResource(Res.string.settings_disable_auto_update), checked = draft.disableAutoUpdate, enabled = enabled) { onChange(draft.copy(disableAutoUpdate = it)) }
    }
}

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

/** 128K, 200K, 256K and 1M, the windows gateway models are commonly served with. */
private val CONTEXT_WINDOWS = listOf(131_072L, 200_000L, 262_144L, 1_048_576L)

/** `131072` is `128K`, `200000` is `200K`; both `1048576` and `1000000` read as `1M`. */
private fun contextWindowLabel(tokens: Long): String = when {
    tokens % 1_048_576L == 0L -> "${tokens / 1_048_576L}M"
    tokens % 1_000_000L == 0L -> "${tokens / 1_000_000L}M"
    tokens % 1_024L == 0L -> "${tokens / 1_024L}K"
    tokens % 1_000L == 0L -> "${tokens / 1_000L}K"
    else -> tokens.toString()
}

@Composable
private fun modelSummary(inputs: Map<String, List<String>>?, contextWindows: Map<String, Long>?, id: String): String? {
    val labels = INPUT_TYPES.associateWith { inputTypeLabel(it) }
    return listOfNotNull(
        inputs?.let { declared -> declaredTypes(declared, id).joinToString(" ") { labels[it] ?: it } },
        contextWindows?.get(id)?.let(::contextWindowLabel),
    ).joinToString(" · ").ifEmpty { null }
}
