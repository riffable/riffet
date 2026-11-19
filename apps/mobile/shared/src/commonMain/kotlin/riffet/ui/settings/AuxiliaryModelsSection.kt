package riffet.ui.settings

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import org.jetbrains.compose.resources.stringResource
import riffet.contracts.AuxiliaryModelOption
import riffet.contracts.AuxiliaryModelRef
import riffet.shared.ModelUseDeclaration
import riffet.shared.RiffetApi
import riffet.shared.auxiliaryModels
import riffet.ui.pickers.*
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.localizedAppearanceTitle
import riffet_mobile.shared.generated.resources.*

@Composable
internal fun rememberAuxiliaryModelOptions(api: RiffetApi): Pair<List<AuxiliaryModelOption>?, String?> {
    var options by remember(api) { mutableStateOf<List<AuxiliaryModelOption>?>(null) }
    var loadError by remember(api) { mutableStateOf<Throwable?>(null) }
    val loadFailed = stringResource(Res.string.settings_quick_chat_models_failed)
    LaunchedEffect(api) {
        options = try {
            api.auxiliaryModels()
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (failure: Throwable) {
            loadError = failure
            emptyList()
        }
    }
    return options to loadError?.settingsMessage(loadFailed)
}

@Composable
internal fun AuxiliaryModelsSection(controller: SettingsController, options: List<AuxiliaryModelOption>?, error: String?) {
    val state by controller.state.collectAsState()
    val hasDefault = state.settings?.auxiliaryModels?.default != null
    val followDefault = stringResource(Res.string.settings_auxiliary_follow_default)
    val off = stringResource(Res.string.settings_auxiliary_off)
    SettingsGroup(stringResource(Res.string.settings_auxiliary_models)) {
        AuxiliaryModelRow(controller, "default", stringResource(Res.string.settings_auxiliary_default), off, options, error)
        AuxiliaryModelRow(controller, "title", stringResource(Res.string.settings_auxiliary_title), if (hasDefault) followDefault else stringResource(Res.string.settings_auxiliary_title_off), options, null)
        AuxiliaryModelRow(controller, "handoff", stringResource(Res.string.settings_auxiliary_handoff), if (hasDefault) followDefault else off, options, null)
    }
    val uses = rememberPluginModelUses(controller)
    if (uses.isNotEmpty()) {
        SettingsGroup(stringResource(Res.string.settings_auxiliary_plugins)) {
            uses.forEach { use ->
                val useOff = when (use.fallback) {
                    "default" -> followDefault
                    "chat" -> stringResource(Res.string.settings_auxiliary_follow_chat)
                    else -> off
                }
                AuxiliaryModelRow(controller, "chat", localizedAppearanceTitle(use.title).ifBlank { use.id }, useOff, options, null, pluginUse = use.id)
            }
        }
    }
}

/** The model uses every enabled plugin declares; empty until the list loads or when the server is older. */
@Composable
private fun rememberPluginModelUses(controller: SettingsController): List<ModelUseDeclaration> {
    var uses by remember(controller) { mutableStateOf<List<ModelUseDeclaration>>(emptyList()) }
    LaunchedEffect(controller) {
        controller.providerPlugins().onSuccess { plugins ->
            uses = plugins.filter { it.enabled }.flatMap { it.declared?.modelUses.orEmpty() }
        }
    }
    return uses
}

@Composable
internal fun AuxiliaryModelRow(
    controller: SettingsController, purpose: String, title: String, offLabel: String,
    options: List<AuxiliaryModelOption>?, loadError: String?, pluginUse: String? = null,
) {
    val state by controller.state.collectAsState()
    val settings = state.settings ?: return
    val current = if (pluginUse != null) settings.pluginModels?.get(pluginUse) else when (purpose) { "default" -> settings.auxiliaryModels?.default; "title" -> settings.auxiliaryModels?.title; "handoff" -> settings.auxiliaryModels?.handoff; else -> settings.auxiliaryModels?.chat }
    val cliSlowTag = stringResource(Res.string.settings_auxiliary_cli_slow)
    // The chat catalog names models `<provider> · <model>`; the saved choice repeats that.
    val currentLabel = current?.let { ref ->
        val profile = options.orEmpty()
            .firstOrNull { it.backendId == ref.backendId && it.profileId == ref.profileId && it.model == ref.model }
            ?.profileName
            ?.takeIf { it.isNotBlank() }
            ?: ref.profileId
        if (profile.isBlank()) ref.model else "$profile · ${ref.model}"
    } ?: offLabel
    val busy = state.saving
    var modelOpen by remember { mutableStateOf(false) }
    // A choice row (mobile.md §2.4) with the menu anchored at its end.
    Box {
        // A model reads `<provider> · <model>`, too long for the row's end: it goes under the title.
        riffet.ui.design.GroupRow(title = title, subtitle = loadError ?: currentLabel, subtitleLines = 2,
            enabled = !busy && options != null, onClick = { modelOpen = true }, modifier = Modifier.settingsSearchAnchor(title))
        Box(Modifier.align(androidx.compose.ui.Alignment.TopEnd)) {
            RiffetDropdownMenu(expanded = modelOpen, onDismissRequest = { modelOpen = false }, modifier = Modifier.widthIn(min = 200.dp)) {
                RiffetMenuItem(
                    onClick = {
                        modelOpen = false
                        if (current != null) {
                            if (pluginUse != null) controller.savePluginModel(pluginUse, null) else controller.saveAuxiliaryModel(purpose, null)
                        }
                    },
                    selected = current == null,
                    showCheck = true,
                ) {
                    Text(offLabel, style = RiffetMenuText, color = LocalRiffetColors.current.fg)
                }
                options.orEmpty().groupBy {
                    val base = it.profileName.ifBlank { backendLabel(it.backendId) }
                    if (it.transport == "cli-process") "$base ($cliSlowTag)" else base
                }.forEach { (profile, items) ->
                    RiffetMenuLabel(profile)
                    items.forEach { option ->
                        RiffetMenuItem(
                            onClick = {
                                modelOpen = false
                                val ref = AuxiliaryModelRef(option.backendId, option.profileId, option.model)
                                if (pluginUse != null) controller.savePluginModel(pluginUse, ref) else controller.saveAuxiliaryModel(purpose, ref)
                            },
                            selected = current?.let { it.backendId == option.backendId && it.profileId == option.profileId && it.model == option.model } == true,
                            showCheck = true,
                        ) {
                            Text(option.model, style = RiffetMenuText, color = LocalRiffetColors.current.fg)
                        }
                    }
                }
            }
        }
    }
}
