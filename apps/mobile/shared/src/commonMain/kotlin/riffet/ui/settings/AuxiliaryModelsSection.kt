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
import riffet.shared.RiffetApi
import riffet.shared.auxiliaryModels
import riffet.ui.pickers.*
import riffet.ui.theme.LocalRiffetColors
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
    SettingsGroup(stringResource(Res.string.settings_auxiliary_models)) {
        AuxiliaryModelRow(controller, "title", stringResource(Res.string.settings_auxiliary_title), stringResource(Res.string.settings_auxiliary_title_off), options, error)
        AuxiliaryModelRow(controller, "handoff", stringResource(Res.string.settings_auxiliary_handoff), stringResource(Res.string.settings_auxiliary_off), options, null)
    }
}

@Composable
internal fun AuxiliaryModelRow(
    controller: SettingsController, purpose: String, title: String, offLabel: String,
    options: List<AuxiliaryModelOption>?, loadError: String?,
) {
    val state by controller.state.collectAsState()
    val settings = state.settings ?: return
    val current = when (purpose) { "title" -> settings.auxiliaryModels?.title; "handoff" -> settings.auxiliaryModels?.handoff; else -> settings.auxiliaryModels?.chat }
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
    SettingsRow(title, loadError) {
        Box {
            SettingsButton(currentLabel, enabled = !busy && options != null, onClick = { modelOpen = true })
            RiffetDropdownMenu(expanded = modelOpen, onDismissRequest = { modelOpen = false }, modifier = Modifier.widthIn(min = 200.dp)) {
                RiffetMenuItem(
                    onClick = {
                        modelOpen = false
                        if (current != null) controller.saveAuxiliaryModel(purpose, null)
                    },
                    selected = current == null,
                    showCheck = true,
                ) {
                    Text(offLabel, style = RiffetMenuText, color = LocalRiffetColors.current.fg)
                }
                options.orEmpty().groupBy { it.profileName.ifBlank { backendLabel(it.backendId) } }.forEach { (profile, items) ->
                    RiffetMenuLabel(profile)
                    items.forEach { option ->
                        RiffetMenuItem(
                            onClick = {
                                modelOpen = false
                                controller.saveAuxiliaryModel(purpose, AuxiliaryModelRef(option.backendId, option.profileId, option.model))
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
