package riffet.ui.settings

import androidx.compose.runtime.*
import kotlinx.coroutines.CancellationException
import org.jetbrains.compose.resources.stringResource
import androidx.compose.ui.Modifier
import kotlinx.coroutines.launch
import riffet.ui.design.GroupRow
import riffet.contracts.ASSISTANT_BUDGET_DAILY_RUNS
import riffet.contracts.AssistantPack
import riffet.contracts.AssistantRunUsage
import riffet.ui.design.ConfirmDialog
import riffet.contracts.ModelInfo
import riffet.contracts.NativeBackendCatalogEntry
import riffet.shared.RiffetApi
import riffet.shared.assistantChoice
import riffet.shared.assistantRunUsage
import riffet.shared.backends
import riffet.shared.setAssistantConsolidation
import riffet.shared.setAssistantDailyRuns
import riffet.shared.setAssistantDispatch
import riffet.shared.backendCatalog
import riffet.shared.rememberAssistant
import riffet.shared.setAssistantSupervision
import riffet.stats.compactCount
import riffet.ui.pickers.ModelPickerGroup
import riffet.ui.pickers.ModelPickerSheet
import riffet.ui.pickers.modelLabel
import riffet.ui.assistant.AssistantSetup
import riffet.ui.assistant.AssistantSheet
import riffet.ui.assistant.AssistantSheets
import riffet_mobile.shared.generated.resources.*

private val DAILY_RUNS = listOf(10, 30, 100)

/**
 * The 个人助理's background runs and how it starts tasks (docs/ASSISTANT.md §7.6), which spend the owner's tokens
 * while they are away. Saved at once, on the server, for every device.
 */
@Composable
internal fun AssistantSettingsSection(api: RiffetApi, controller: SettingsController) {
    val state by controller.state.collectAsState()
    val settings = state.settings ?: return
    val assistant = settings.assistant
    val busy = state.saving
    val scope = rememberCoroutineScope()
    val setup = remember(api) { AssistantSetup(api, scope) }
    var sheet by remember { mutableStateOf<AssistantSheet?>(null) }
    var backends by remember(api) { mutableStateOf<List<NativeBackendCatalogEntry>>(emptyList()) }
    var usage by remember(api) { mutableStateOf<AssistantRunUsage?>(null) }
    LaunchedEffect(api) {
        try { backends = api.backends() } catch (cancellation: CancellationException) { throw cancellation } catch (_: Throwable) { }
    }
    // Read again after each save: a switch turned on or a limit changed moves the counts.
    LaunchedEffect(api, assistant) {
        try { usage = api.assistantRunUsage() } catch (cancellation: CancellationException) { throw cancellation } catch (_: Throwable) { }
    }
    LaunchedEffect(setup, sheet) { if (sheet == null) setup.load() }
    LaunchedEffect(setup) { setup.loadPacks() }
    var packBusy by remember { mutableStateOf(false) }
    var removing by remember { mutableStateOf<AssistantPack?>(null) }
    fun setPack(id: String, on: Boolean) {
        packBusy = true
        scope.launch {
            try { setup.setPack(id, on) } catch (cancellation: CancellationException) { throw cancellation } catch (_: Throwable) { setup.loadPacks() } finally { packBusy = false }
        }
    }

    @Composable fun spent(job: String): String? {
        val read = usage ?: return null
        val row = read.jobs.firstOrNull { it.job == job }?.takeIf { it.runs > 0 } ?: return null
        return stringResource(Res.string.assistant_usage, read.days, row.runs, compactCount(row.tokens.toDouble()))
    }

    // The 助理's own agent; its model comes from every provider of that agent, as the composer lists them.
    val choice = assistantChoice(assistant, backends)
    val backendId = choice?.backendId
    val backend = backends.firstOrNull { it.backendId == backendId }
    val profiles = backend?.profiles.orEmpty()
    val activeProfile = choice?.profileId ?: profiles.firstOrNull { it.isDefault == true }?.id ?: profiles.firstOrNull()?.id
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
    val catalog = reads[activeProfile.orEmpty()]?.models.orEmpty()
    val groups = if (profiles.size > 1) profiles.map { profile ->
        val read = reads[profile.id]
        ModelPickerGroup(profile.id, profile.name.ifBlank { profile.id }, read?.models.orEmpty(), read?.available ?: true, read?.reason, read?.error, read == null || read.loading)
    } else emptyList()
    val pickModel: (String?, String) -> Unit = { profileId, selection ->
        if (backendId != null) controller.saveAssistant({ it.rememberAssistant(backendId, profileId, selection.ifEmpty { null }) })
        modelOpen = false
    }
    val dailyRuns = assistant?.dailyRuns ?: ASSISTANT_BUDGET_DAILY_RUNS
    val dailyOptions = (if (dailyRuns in DAILY_RUNS) DAILY_RUNS else (DAILY_RUNS + dailyRuns).sorted())
    val dailyLabels = dailyOptions.map { it.toString() to stringResource(Res.string.assistant_daily_runs_count, it) }
    val activeDelegations = setup.delegations?.count { it.state == "active" }

    SettingsGroup("") {
        val modelTitle = stringResource(Res.string.assistant_model)
        GroupRow(
            title = modelTitle, subtitle = backend?.label,
            value = choice?.model?.takeIf { it.isNotEmpty() }?.let { modelLabel(catalog, it).ifEmpty { it } },
            chevron = true, enabled = !busy && backendId != null, onClick = { modelOpen = true },
            modifier = Modifier.settingsSearchAnchor(modelTitle),
        )
    }
    val packs = setup.packs.orEmpty()
    if (packs.isNotEmpty()) {
        SettingsGroup(stringResource(Res.string.assistant_packs)) {
            packs.forEach { pack ->
                SettingsSwitchRow(
                    title = pack.title, description = pack.description,
                    checked = pack.installed, enabled = !packBusy,
                    onCheckedChange = { on -> if (!on && !pack.builtIn) removing = pack else setPack(pack.id, on) },
                )
            }
        }
        SettingsFootnote(stringResource(Res.string.assistant_packs_note))
    }
    SettingsGroup(stringResource(Res.string.assistant_background)) {
        SettingsSwitchRow(
            title = stringResource(Res.string.assistant_supervision),
            description = spent("supervise") ?: stringResource(Res.string.assistant_supervision_idle),
            checked = assistant?.supervision == true, enabled = !busy,
            onCheckedChange = { value -> controller.saveAssistant({ it.setAssistantSupervision(value) }) },
        )
        SettingsSwitchRow(
            title = stringResource(Res.string.assistant_consolidation),
            description = spent("consolidate") ?: stringResource(Res.string.assistant_consolidation_idle),
            checked = assistant?.consolidation != false, enabled = !busy,
            onCheckedChange = { value -> controller.saveAssistant({ it.setAssistantConsolidation(value) }) },
        )
        SettingsNavigationRow(
            stringResource(Res.string.assistant_delegations),
            spent("delegation") ?: activeDelegations?.let { stringResource(Res.string.assistant_delegations_active, it) }.orEmpty(),
        ) { sheet = AssistantSheet.DELEGATIONS }
        val read = usage
        SettingsChoiceRow(
            title = stringResource(Res.string.assistant_daily_runs),
            subtitle = read?.let {
                if (it.waiting > 0) stringResource(Res.string.assistant_daily_started_waiting, it.started, it.waiting)
                else stringResource(Res.string.assistant_daily_started, it.started)
            },
            options = dailyLabels, value = dailyRuns.toString(), enabled = !busy,
            onSelect = { value -> controller.saveAssistant({ it.setAssistantDailyRuns(value.toInt()) }) },
        )
    }
    SettingsFootnote(stringResource(Res.string.assistant_background_note))
    SettingsGroup(stringResource(Res.string.session_tab_tasks)) {
        SettingsChoiceRow(
            title = stringResource(Res.string.assistant_dispatch),
            options = listOf(
                "edits" to stringResource(Res.string.assistant_dispatch_edits),
                "all" to stringResource(Res.string.assistant_dispatch_all),
            ),
            value = assistant?.dispatch ?: "edits", enabled = !busy,
            onSelect = { value -> controller.saveAssistant({ it.setAssistantDispatch(value) }) },
        )
    }
    AssistantSheets(setup, sheet) { sheet = null }
    removing?.let { pack ->
        ConfirmDialog(
            title = stringResource(Res.string.assistant_pack_remove_title, pack.title),
            message = stringResource(Res.string.assistant_pack_remove_message),
            confirmLabel = stringResource(Res.string.assistant_pack_remove), danger = true,
            onConfirm = { removing = null; setPack(pack.id, false) },
            onDismiss = { removing = null },
        )
    }
    if (modelOpen) ModelPickerSheet(
        catalog = catalog, catalogLoading = reads[activeProfile.orEmpty()]?.loading == true, catalogError = reads[activeProfile.orEmpty()]?.error,
        selection = choice?.model.orEmpty(), switching = false, disabledReason = null,
        onDismiss = { modelOpen = false },
        onSelect = { selection -> pickModel(activeProfile, selection) },
        onRetryCatalog = { load(activeProfile) },
        groups = groups, activeProfileId = activeProfile,
        usageScopeKey = "assistant|$backendId|${activeProfile.orEmpty()}",
        onSelectChoice = { profileId, selection -> pickModel(profileId, selection) },
        onRetryGroup = { profileId -> load(profileId) },
        showSubtitle = false,
    )
}

private data class ModelRead(
    val models: List<ModelInfo> = emptyList(),
    val available: Boolean = true,
    val reason: String? = null,
    val error: String? = null,
    val loading: Boolean = false,
)
