package riffet.ui.settings

import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.stringResource
import riffet.contracts.AgentIds
import riffet.contracts.ModelInfo
import riffet.contracts.NativeBackendCatalogEntry
import riffet.shared.RiffetApi
import riffet.shared.backendCatalog
import riffet.shared.backends
import riffet.shared.setWorkItemAgent
import riffet.shared.setWorkItemComposerSessions
import riffet.ui.design.GroupRow
import riffet.ui.pickers.ModelPickerGroup
import riffet.ui.pickers.ModelPickerSheet
import riffet.ui.pickers.modelLabel
import riffet_mobile.shared.generated.resources.*

private const val FOLLOW_COMPOSER = ""

/** 任务看板's settings (docs/TASK-BOARD.md §10): saved at once, on the server, for every device. */
@Composable
internal fun TaskBoardSettingsSection(api: RiffetApi, controller: SettingsController) {
    val state by controller.state.collectAsState()
    val settings = state.settings ?: return
    val workItems = settings.workItems
    val busy = state.saving
    val scope = rememberCoroutineScope()
    var backends by remember(api) { mutableStateOf<List<NativeBackendCatalogEntry>>(emptyList()) }
    LaunchedEffect(api) {
        try { backends = api.backends() } catch (cancellation: CancellationException) { throw cancellation } catch (_: Throwable) { }
    }
    val backendId = workItems?.backendId
    val backend = backends.firstOrNull { it.backendId == backendId }
    val profiles = backend?.profiles.orEmpty()
    val activeProfile = workItems?.profileId?.takeIf { id -> profiles.any { it.id == id } }
        ?: profiles.firstOrNull { it.isDefault == true }?.id ?: profiles.firstOrNull()?.id
    var reads by remember(api, backendId) { mutableStateOf<Map<String, ModelRead>>(emptyMap()) }
    var modelOpen by remember { mutableStateOf(false) }
    fun load(profileId: String?) {
        val id = backendId ?: return
        val key = profileId.orEmpty()
        if (reads[key]?.loading == true) return
        reads = reads + (key to (reads[key] ?: ModelRead()).copy(loading = true, error = null))
        scope.launch {
            val read = try {
                val entry = api.backendCatalog(id, profileId = profileId, allModels = false, global = true)
                ModelRead(entry.models, entry.available, entry.reason)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (failure: Throwable) {
                ModelRead(reads[key]?.models.orEmpty(), error = failure.message ?: "")
            }
            reads = reads + (key to read)
        }
    }
    LaunchedEffect(modelOpen, backendId, profiles.size) {
        if (modelOpen) (profiles.map { it.id }.ifEmpty { listOf(null) }).forEach { load(it) }
    }
    // The saved model's name, read once the agent's models are known.
    LaunchedEffect(backendId, activeProfile) { if (backendId != null && workItems.model != null) load(activeProfile) }
    val catalog = reads[activeProfile.orEmpty()]?.models.orEmpty()
    val groups = if (profiles.size > 1) profiles.map { profile ->
        val read = reads[profile.id]
        ModelPickerGroup(profile.id, profile.name.ifBlank { profile.id }, read?.models.orEmpty(), read?.available ?: true, read?.reason, read?.error, read == null || read.loading)
    } else emptyList()
    val pickModel: (String?, String) -> Unit = { profileId, selection ->
        if (backendId != null) controller.saveAssistant({ it.setWorkItemAgent(backendId, profileId, selection.ifEmpty { null }) })
        modelOpen = false
    }
    val agents = backends.filter { it.available || it.backendId == backendId }
    val agentOptions = listOf(FOLLOW_COMPOSER to stringResource(Res.string.task_board_follow_composer)) +
        agents.map { AgentIds.wire(it.backendId) to it.label }

    SettingsGroup("") {
        SettingsSwitchRow(
            title = stringResource(Res.string.task_board_composer_sessions),
            checked = workItems?.composerSessions == true, enabled = !busy,
            onCheckedChange = { value -> controller.saveAssistant({ it.setWorkItemComposerSessions(value) }) },
        )
        SettingsChoiceRow(
            title = stringResource(Res.string.task_board_agent),
            options = agentOptions, value = backendId?.let(AgentIds::wire) ?: FOLLOW_COMPOSER, enabled = !busy,
            onSelect = { id ->
                val next = agents.firstOrNull { AgentIds.wire(it.backendId) == id }?.backendId
                controller.saveAssistant({ it.setWorkItemAgent(next, null, null) })
            },
        )
        val modelTitle = stringResource(Res.string.task_board_model)
        GroupRow(
            title = modelTitle,
            value = workItems?.model?.takeIf { it.isNotEmpty() }?.let { modelLabel(catalog, it).ifEmpty { it } },
            chevron = true, enabled = !busy && backendId != null, onClick = { modelOpen = true },
            modifier = Modifier.settingsSearchAnchor(modelTitle),
        )
    }
    if (modelOpen) ModelPickerSheet(
        catalog = catalog, catalogLoading = reads[activeProfile.orEmpty()]?.loading == true, catalogError = reads[activeProfile.orEmpty()]?.error,
        selection = workItems?.model.orEmpty(), switching = false, disabledReason = null,
        onDismiss = { modelOpen = false },
        onSelect = { selection -> pickModel(activeProfile, selection) },
        onRetryCatalog = { load(activeProfile) },
        groups = groups, activeProfileId = activeProfile,
        usageScopeKey = "work-items|$backendId|${activeProfile.orEmpty()}",
        onSelectChoice = { profileId, selection -> pickModel(profileId, selection) },
        onRetryGroup = { profileId -> load(profileId) },
        showSubtitle = false,
    )
}
