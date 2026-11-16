package riffet.ui.settings

import androidx.compose.runtime.*
import org.jetbrains.compose.resources.stringResource
import riffet.contracts.AppSettingsUpdate
import riffet.contracts.NativeBackendCatalogEntry
import riffet.contracts.NativeBackendDefaults
import riffet.contracts.NativeBackendId
import riffet.ui.pickers.*
import riffet.ui.home.NewSessionDraft
import riffet_mobile.shared.generated.resources.*

/** The same serialized model and parameters that NewSessionDraft sends when a session starts. */
@Composable
internal fun AgentLaunchModelSettings(controller: SettingsController, backend: NativeBackendId, profileId: String) {
    val state by controller.state.collectAsState()
    var catalog by remember(controller, backend, profileId) { mutableStateOf<NativeBackendCatalogEntry?>(null) }
    var loading by remember(controller, backend, profileId) { mutableStateOf(true) }
    var failure by remember(controller, backend, profileId) { mutableStateOf<String?>(null) }
    var retry by remember { mutableStateOf(0) }
    val savedMessage = stringResource(Res.string.settings_set_as_default_done)
    val failedMessage = stringResource(Res.string.settings_model_catalog_failed)
    LaunchedEffect(controller, backend, profileId, retry) {
        loading = true
        controller.launchCatalog(backend, profileId).onSuccess { catalog = it; failure = it.reason?.takeUnless { _ -> it.available } }
            .onFailure { failure = it.message ?: failedMessage }
        loading = false
    }
    if (catalog?.capabilities?.supportsModelSelection == false) return
    val saved = state.settings?.nativeBackendDefaults?.get(backend)
    val models = catalog?.models.orEmpty()
    val selection = catalog?.let { NewSessionDraft(profileId = profileId).resolve(it, saved, state.settings?.defaultModel).model }.orEmpty()
    fun saveModel(value: String?) {
        val current = controller.state.value.settings ?: return
        val defaults = current.nativeBackendDefaults.orEmpty()
        val previous = defaults[backend] ?: NativeBackendDefaults()
        controller.saveSettings(AppSettingsUpdate(nativeBackendDefaults = defaults + (backend to previous.copy(profileId = profileId, model = value))), savedMessage)
    }
    val explicitModel = saved?.model
    val selectedModel = explicitModel?.let { resolveModelSelection(models, it).model }.orEmpty()
    val modelChoices = listOf("" to stringResource(Res.string.settings_model_automatic)) + models.map { it.value to cleanLabel(it.name) } +
        listOfNotNull(selectedModel.takeIf { it.isNotEmpty() && models.none { model -> model.value == it } }?.let { it to it })
    SettingsChoiceRow(stringResource(Res.string.settings_default_model), modelChoices, selectedModel, enabled = !state.saving && !loading) { next ->
        saveModel(selectionForDefaultModel(models, selection, next))
    }
    failure?.let { PageBanner(it, SettingsNoticeKind.ERROR, stringResource(Res.string.settings_retry)) { retry++ } }
    val resolved = resolveModelSelection(models, selection)
    val contextFallback = remember(backend, profileId) { mutableMapOf<String, String>() }
    catalogParams(models, resolved.model, resolved.params).forEach { param ->
        val kind = paramKind(param)
        if (kind == ParamKind.TOGGLE || kind == ParamKind.FAST || kind == ParamKind.MAX) {
            SettingsSwitchRow(paramTitle(param), checked = isOn(param), enabled = !state.saving && !loading) { on ->
                if (kind == ParamKind.MAX && on && !isOn(param)) contextFallback[resolved.model] = param.value
                saveModel(selectionWithParam(models, selection, param.id, toggledValue(param, on, contextFallback[resolved.model])))
            }
            if (kind == ParamKind.MAX && !isOn(param) && contextChoices(param).size > 1) {
                val choices = contextChoices(param).map { it.value to it.label }
                val segmented = choices.size in 2..3 && choices.all { it.second.length <= 8 && !it.second.contains(' ') }
                if (segmented) SettingsRow("Context") {
                    SettingsSegmented(choices, param.value, enabled = !state.saving && !loading) { next ->
                        contextFallback[resolved.model] = next
                        saveModel(selectionWithParam(models, selection, param.id, next))
                    }
                } else SettingsChoiceRow("Context", choices, param.value, enabled = !state.saving && !loading) { next ->
                    contextFallback[resolved.model] = next
                    saveModel(selectionWithParam(models, selection, param.id, next))
                }
            }
        } else {
            val choices = listValues(param).map { it.value to optionLabel(param, it.value) }
            val segmented = choices.size in 2..3 && choices.all { it.second.length <= 8 && !it.second.contains(' ') }
            if (segmented) SettingsRow(paramTitle(param)) {
                SettingsSegmented(choices, param.value, enabled = !state.saving && !loading) { saveModel(selectionWithParam(models, selection, param.id, it)) }
            } else SettingsChoiceRow(paramTitle(param), choices, param.value, enabled = !state.saving && !loading) {
                saveModel(selectionWithParam(models, selection, param.id, it))
            }
        }
    }
}
