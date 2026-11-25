package riffet.ui.pickers

import riffet.ui.gesture.riffetHorizontalScroll
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.LocalRiffetSurfaces
import riffet.ui.design.ChipButton
import riffet.ui.design.ToggleChip
import riffet.ui.design.ChipItem
import riffet.ui.design.RiffetIconButton
import riffet.ui.design.SkeletonBlock
import androidx.compose.runtime.key
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.foundation.clickable
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.selection.toggleable
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import org.jetbrains.compose.resources.stringResource
import riffet_mobile.shared.generated.resources.*
import riffet.ui.settings.SettingsNoticeKind
import androidx.compose.ui.semantics.Role
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import riffet.ui.icons.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import riffet.contracts.ModelInfo
import riffet.contracts.NativeBackendProfile
import riffet.contracts.NativeBackendUsage
import riffet.shared.createAppPreferences
import riffet.contracts.NativeProfileContinuation
import riffet.ui.icons.RiffetIcons
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography

/**
 * One provider's models inside the picker.
 *
 * A single provider needs no heading. Two or more are listed together, and choosing a model also
 * chooses its provider — the same grouping the web's model list and the iOS new-task picker use.
 * An id is unique per provider, so two gateways can offer the same model id without colliding.
 */
internal data class ModelPickerGroup(
    val profileId: String,
    val name: String,
    val models: List<ModelInfo>,
    val available: Boolean = true,
    val unavailableReason: String? = null,
    val error: String? = null,
    val loading: Boolean = false,
)

/**
 * The providers a conversation's models are listed under: its own and each it continues on in place,
 * in the backend's configured order. Empty (a flat list) when nothing qualifies.
 */
internal fun sessionProviderGroups(
    profileId: String?,
    catalog: List<ModelInfo>,
    profiles: List<NativeBackendProfile>,
    continuations: List<NativeProfileContinuation>,
): List<ModelPickerGroup> {
    if (profileId == null || continuations.isEmpty()) return emptyList()
    val own = ModelPickerGroup(profileId, profiles.firstOrNull { it.id == profileId }?.name ?: profileId, catalog)
    val others = continuations.map { ModelPickerGroup(it.profile.id, it.profile.name, it.models) }
    val order = profiles.withIndex().associate { it.value.id to it.index }
    return (listOf(own) + others).sortedBy { order[it.profileId] ?: Int.MAX_VALUE }
}

/** The agent chips above the providers: a new conversation picks its agent in the model panel. */
internal class ModelPanelAgents(val items: List<ChipItem>, val selected: String, val onSelect: (String) -> Unit)

/**
 * The model list and its parameter controls, as one sheet.
 *
 * Ported from `apps/web/src/app/session/ModelPicker.tsx` + `apps/web/src/lib/models.ts`. Two things
 * are load-bearing and are kept exactly:
 *
 *  - the list and the parameters both come from the CLI's own catalog ([ModelInfo]); nothing here
 *    is a hardcoded list of model names;
 *  - changing a model or a parameter produces one complete selection string through
 *    [selectionForModel] / [selectionWithParam], which carries every fixed config option the
 *    catalog describes, so `nativeSetModel` receives a string the CLI can resolve.
 *
 * The phone's own form is iOS's picker panel (ios.md §4.3): agents and providers as chip rows fixed at
 * the top, one provider's models scrolling in between, the parameters and 更多设置 fixed at the bottom.
 *
 * @param disabledReason when non-null the sheet explains why nothing here can be acted on yet and
 *   every option is rendered disabled instead of silently doing nothing.
 * @param onParamChange applies a parameter change (Fast / Max / thinking level / context) while the
 *   sheet stays open, which is what the web does (`ModelPicker.tsx`: `onParamChange` does not close
 *   the popover). Picking a *model* still goes through [onSelect] and closes.
 */
@Composable
internal fun ModelPickerSheet(
    catalog: List<ModelInfo>,
    catalogLoading: Boolean,
    catalogError: String?,
    selection: String,
    disabledReason: String?,
    onDismiss: () -> Unit,
    onSelect: (String) -> Unit,
    onRetryCatalog: () -> Unit,
    onBack: (() -> Unit)? = null,
    onParamChange: ((String) -> Unit)? = null,
    loadUsage: (suspend () -> NativeBackendUsage)? = null,
    /** Present only when this agent has more than one provider. One provider stays a flat list. */
    groups: List<ModelPickerGroup> = emptyList(),
    activeProfileId: String? = null,
    /** The backend, session and project these figures belong to; backends can share a profile id. */
    usageScopeKey: String? = null,
    /** Model plus the provider it belongs to. Called instead of [onSelect] while [groups] are shown. */
    onSelectChoice: ((profileId: String, selection: String) -> Unit)? = null,
    onRetryGroup: ((profileId: String) -> Unit)? = null,
    /** Each provider's last picked selection (`profileModels`, "" for a flat list); picking the same model again restores it whole. */
    remembered: Map<String, String> = emptyMap(),
    agents: ModelPanelAgents? = null,
    onMore: (() -> Unit)? = null,
) {
    PickerSheetFrame(onDismiss) {
        ModelPickerPages(
            catalog = catalog,
            catalogLoading = catalogLoading,
            catalogError = catalogError,
            selection = selection,
            disabledReason = disabledReason,
            onSelect = onSelect,
            onRetryCatalog = onRetryCatalog,
            onBack = onBack,
            onParamChange = onParamChange,
            loadUsage = loadUsage,
            groups = groups,
            activeProfileId = activeProfileId,
            usageScopeKey = usageScopeKey,
            onSelectChoice = onSelectChoice,
            onRetryGroup = onRetryGroup,
            remembered = remembered,
            agents = agents,
            onMore = onMore,
            modifier = Modifier.weight(1f, fill = false),
        )
    }
}

/**
 * The sheet's pages without a frame: the model list, and a parameter's own list that slides in over it.
 * [PickerHost.dismiss] from the surrounding host is what a pick calls, so this can sit in a
 * [PickerSheetFrame] or inside another sheet (the quick chat's).
 */
@Composable
internal fun ModelPickerPages(
    catalog: List<ModelInfo>,
    catalogLoading: Boolean,
    catalogError: String?,
    selection: String,
    disabledReason: String?,
    onSelect: (String) -> Unit,
    onRetryCatalog: () -> Unit,
    onBack: (() -> Unit)? = null,
    onParamChange: ((String) -> Unit)? = null,
    loadUsage: (suspend () -> NativeBackendUsage)? = null,
    /** Present only when this agent has more than one provider. One provider stays a flat list. */
    groups: List<ModelPickerGroup> = emptyList(),
    activeProfileId: String? = null,
    /** The backend, session and project these figures belong to; backends can share a profile id. */
    usageScopeKey: String? = null,
    /** Model plus the provider it belongs to. Called instead of [onSelect] while [groups] are shown. */
    onSelectChoice: ((profileId: String, selection: String) -> Unit)? = null,
    onRetryGroup: ((profileId: String) -> Unit)? = null,
    /** Each provider's last picked selection (`profileModels`, "" for a flat list); picking the same model again restores it whole. */
    remembered: Map<String, String> = emptyMap(),
    /** The agents to choose between, on a new conversation; one agent shows no row. */
    agents: ModelPanelAgents? = null,
    /** Opens the settings this panel leaves out (mode, permissions, tools) inside the same sheet. */
    onMore: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    // Quota and load move by the minute, so they are read each time the sheet opens; a failed read
    // leaves the figures out and never holds up the list. A provider switch writes a new read, so
    // the previous provider's figures are dropped first instead of being mislabelled.
    // The last read of this scope is shown at once and replaced by the fresh one; a failed read keeps it.
    val usageStore = remember { ModelUsageStore(createAppPreferences()) }
    var usage by remember(usageScopeKey, activeProfileId) { mutableStateOf(usageScopeKey?.let(usageStore::load)) }
    LaunchedEffect(loadUsage != null, usageScopeKey, activeProfileId) {
        val load = loadUsage ?: return@LaunchedEffect
        val fresh = try { load() } catch (cancellation: kotlinx.coroutines.CancellationException) { throw cancellation } catch (_: Throwable) { null }
        if (fresh != null) {
            usage = fresh
            usageScopeKey?.let { usageStore.save(it, fresh) }
        }
    }
    // The catalog moves too, and the list is only as fresh as the open that shows it. The retry
    // path already knows how to re-read without disturbing the current selection.
    LaunchedEffect(usageScopeKey, activeProfileId) {
        if (!catalogLoading) onRetryCatalog()
    }
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val parsed = remember(catalog, selection) { resolveModelSelection(catalog, selection) }
    val params = remember(catalog, selection) { catalogParams(catalog, parsed.model, parsed.params) }
    // Which parameter's options are open as their own list. Only an id, so the list re-reads the
    // live parameter (and its new value) rather than holding a stale copy.
    var listParamId by remember { mutableStateOf<String?>(null) }
    val applyParam: (String, String) -> Unit = { id, value ->
        (onParamChange ?: onSelect)(selectionWithParam(catalog, selection, id, value))
    }

    val grouped = groups.size > 1
    val agentRow = agents?.takeIf { it.items.size > 1 }
    // The provider whose models the list shows; null follows the current one. A new agent starts over.
    var browsing by remember(agents?.selected) { mutableStateOf<String?>(null) }
    val shownGroup = if (grouped) {
        groups.firstOrNull { it.profileId == browsing } ?: groups.firstOrNull { it.profileId == activeProfileId } ?: groups.first()
    } else {
        null
    }

    val retryText = stringResource(Res.string.pmodel_retry)
    val catalogErrorText = catalogError?.let { stringResource(Res.string.pmodel_load_failed, it) }
    val title = stringResource(if (agentRow != null) Res.string.pmodel_title_agent else Res.string.pmodel_title)

    val host = LocalPickerHost.current
    // A pick has already been applied by the time this runs; it only lets the sheet leave.
    val dismiss: () -> Unit = { host?.dismiss?.invoke() }
    // Hoisted so the list keeps its scroll position while a parameter's list covers it.
    val modelListState = rememberLazyListState()
    // The list already brought the current model into view for this agent and provider.
    var landed by remember { mutableStateOf<String?>(null) }
    val listed = listParamId?.let { id -> params.firstOrNull { it.id == id } }

    PickerPages(page = ModelPage(listed?.id), depth = { if (it.paramId == null) 0 else 1 }, modifier = modifier) { page ->
        val shownParam = page.paramId?.let { id -> params.firstOrNull { it.id == id } }
        if (shownParam != null) {
            // A parameter's own list, in the same sheet: header swapped, back returns to the model list.
            PickerPage(
                title = paramTitle(shownParam),
                subtitle = optionLabel(shownParam, shownParam.value),
                fullHeight = true,
                onBack = { listParamId = null },
            ) {
                shownParam.description?.let { description ->
                    Text(
                        text = description,
                        style = typography.caption,
                        color = colors.fg3,
                        modifier = Modifier.padding(horizontal = SheetInset, vertical = (metrics.controlInset / 4)),
                    )
                }
                LazyColumn(modifier = Modifier.weight(1f).fillMaxWidth()) {
                    items(listValues(shownParam), key = { it.value }) { option ->
                        OptionRow(
                            label = optionLabel(shownParam, option.value),
                            selected = option.value == shownParam.value,
                            onClick = {
                                applyParam(shownParam.id, option.value)
                                listParamId = null
                            },
                            disabledReason = disabledReason,
                        )
                    }
                }
            }
        } else {
            // A picker panel (mobile.md §2.5, as iOS's): what the list belongs to fixed at the top, the
            // model's parameters and the way on to the other settings fixed at the bottom, only the
            // models scrolling in between.
            PickerPage(title = title, fullHeight = true, onBack = onBack, actions = onMore?.let { more -> {
                // The rest of the send settings: low use, so a bar action rather than a row or a chip.
                // The close button's weight and ink: a denser glyph beside it read as the bar's loudest thing.
                RiffetIconButton(onClick = more, modifier = Modifier.size(metrics.controlHeight)) {
                    Icon(RiffetIcons.Ellipsis, stringResource(Res.string.pmodel_more), Modifier.size(metrics.iconSize), tint = colors.fg3)
                }
            } }) {
                // What the list belongs to, as one line read left to right: the agent, then its provider. Each is a
                // chip showing its value and opening a menu; rows of every choice took two scrolling bars.
                if (agentRow != null || grouped) Row(
                    Modifier.fillMaxWidth().padding(start = SheetInset, end = SheetInset, bottom = metrics.controlInset / 2),
                    horizontalArrangement = Arrangement.spacedBy(metrics.controlInset / 2),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (agentRow != null) {
                        val chosen = agentRow.items.firstOrNull { it.key == agentRow.selected }
                        ScopeChip(
                            label = chosen?.label ?: agentRow.selected,
                            icon = chosen?.icon,
                            iconTint = chosen?.iconTint,
                            options = agentRow.items,
                            selected = agentRow.selected,
                            onSelect = agentRow.onSelect,
                        )
                    }
                    if (grouped && shownGroup != null) ScopeChip(
                        label = shownGroup.name.ifBlank { shownGroup.profileId },
                        options = groups.map { ChipItem(it.profileId, it.name.ifBlank { it.profileId }) },
                        selected = shownGroup.profileId,
                        onSelect = { browsing = it },
                    )
                }
                if (!disabledReason.isNullOrEmpty()) SheetNotice(disabledReason, SettingsNoticeKind.INFO)
                if (catalogErrorText != null) SheetNotice(catalogErrorText, SettingsNoticeKind.ERROR, retryText, onRetryCatalog)

                val models = shownGroup?.models ?: catalog
                val current = shownGroup == null || shownGroup.profileId == activeProfileId
                val waiting = if (shownGroup != null) shownGroup.loading && models.isEmpty() else catalogLoading && models.isEmpty()
                val account = usage?.account?.takeIf { current && !waiting }
                val reason = shownGroup?.takeIf { !it.available }?.let { it.unavailableReason ?: stringResource(Res.string.pmodel_unavailable) }
                val failed = shownGroup?.takeIf { it.error != null }
                val currentIndex = if (current && !waiting) models.indexOfFirst { it.value == parsed.model } else -1
                // The current model in view once its list is there: placed a couple of rows down rather than
                // at the very top, so the list reads as continuing above it.
                val landingKey = "${agents?.selected}|${shownGroup?.profileId}|${currentIndex >= 0}"
                LaunchedEffect(landingKey) {
                    if (landed == landingKey) return@LaunchedEffect
                    landed = landingKey
                    val leading = if (reason != null) 1 else 0
                    modelListState.scrollToItem(if (currentIndex >= 0) (leading + currentIndex - 2).coerceAtLeast(0) else 0)
                }
                LazyColumn(state = modelListState, modifier = Modifier.weight(1f).fillMaxWidth()) {
                    if (reason != null) item(key = "reason") {
                        Text(
                            text = reason,
                            style = typography.bodySmall,
                            color = colors.fg3,
                            modifier = Modifier.fillMaxWidth().padding(horizontal = SheetInset, vertical = (metrics.controlInset / 4)),
                        )
                    }
                    when {
                        // The models are on their way: rows of their shape hold the list's place.
                        waiting -> items(PlaceholderRows, key = { "placeholder:$it" }) { index -> PlaceholderRow(index) }
                        failed != null -> item(key = "error") {
                            Row(
                                modifier = Modifier.fillMaxWidth().padding(horizontal = SheetInset, vertical = (metrics.controlInset / 2)),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(
                                    text = stringResource(Res.string.pmodel_load_failed, failed.error.orEmpty()),
                                    style = typography.bodySmall,
                                    color = colors.danger,
                                    modifier = Modifier.weight(1f),
                                )
                                riffet.ui.design.RiffetTextButton(onClick = {
                                    val retryGroup = onRetryGroup
                                    if (retryGroup != null) retryGroup(failed.profileId) else onRetryCatalog()
                                }) { Text(retryText) }
                            }
                        }
                        models.isEmpty() -> item(key = "none") {
                            Row(
                                modifier = Modifier.fillMaxWidth().padding(horizontal = SheetInset, vertical = (metrics.controlInset / 2)),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(text = stringResource(Res.string.pmodel_none), style = typography.bodySmall, color = colors.fg3, modifier = Modifier.weight(1f))
                                if (shownGroup == null && catalogError == null) riffet.ui.design.RiffetTextButton(onClick = onRetryCatalog) { Text(retryText) }
                            }
                        }
                        else -> items(models, key = { "${shownGroup?.profileId.orEmpty()}:${it.value}" }) { model ->
                            val profileId = shownGroup?.profileId
                            OptionRow(
                                label = cleanLabel(model.name.ifEmpty { model.value }),
                                selected = current && model.value == parsed.model,
                                onClick = {
                                    val next = pickedSelection(models, model.value, if (current) selection else "", remembered[profileId ?: activeProfileId.orEmpty()])
                                    val choose = onSelectChoice
                                    if (profileId != null && choose != null) choose(profileId, next) else onSelect(next)
                                    dismiss()
                                },
                                disabledReason = disabledReason ?: if (shownGroup?.available == false) "" else null,
                                annotation = if (current) usage?.models?.get(model.value)?.let { status -> { ModelStatusTags(status) } } else null,
                            )
                        }
                    }
                }
                ModelPanelFooter(
                    account = account,
                    params = params,
                    enabled = disabledReason == null,
                    onChange = applyParam,
                    onOpenList = { listParamId = it },
                )
            }
        }
    }
}

/** How many rows stand in for a list that is still loading. */
private val PlaceholderRows = List(6) { it }

/** A model row's shape while the list loads: a line of uneven width at the row's height. */
@Composable
private fun PlaceholderRow(index: Int) {
    val metrics = LocalInterfaceStyle.current.metrics
    val line = with(LocalDensity.current) { SheetRowText.fontSize.toDp() }
    Box(
        Modifier.fillMaxWidth().heightIn(min = maxOf(metrics.controlHeight, metrics.rowHeight)).padding(horizontal = SheetInset),
        contentAlignment = Alignment.CenterStart,
    ) {
        SkeletonBlock(Modifier.fillMaxWidth(if (index % 2 == 0) 0.5f else 0.36f).height(line))
    }
}

/** The panel's bottom bar: the provider's quota, then the model's parameters, scrolling in the width they get. */
@Composable
private fun ModelPanelFooter(
    account: riffet.contracts.AccountUsage?,
    params: List<ModelParam>,
    enabled: Boolean,
    onChange: (id: String, value: String) -> Unit,
    onOpenList: (id: String) -> Unit,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    if (params.isEmpty() && account == null) {
        Spacer(Modifier.height(metrics.controlInset))
        return
    }
    Column(Modifier.fillMaxWidth().padding(vertical = metrics.controlInset / 2), verticalArrangement = Arrangement.spacedBy(metrics.controlInset / 2)) {
        if (LocalInterfaceStyle.current.components.sheets.headerLine) HorizontalDivider(color = colors.line)
        if (account != null) AccountQuotaStrip(account, Modifier.padding(horizontal = SheetInset))
        if (params.isNotEmpty()) ParamStrip(params = params, enabled = enabled, onChange = onChange, onOpenList = onOpenList)
    }
}

/** One scope of the list (the agent, the provider): a chip with the current value that opens the choices as a menu. */
@Composable
private fun ScopeChip(
    label: String,
    options: List<ChipItem>,
    selected: String,
    onSelect: (String) -> Unit,
    icon: androidx.compose.ui.graphics.vector.ImageVector? = null,
    iconTint: androidx.compose.ui.graphics.Color? = null,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    var open by remember { mutableStateOf(false) }
    Box {
        ChipButton(label, active = false, onClick = { open = true }, icon = icon, iconTint = iconTint)
        RiffetDropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            options.forEach { option ->
                RiffetMenuItem(
                    onClick = { open = false; if (option.key != selected) onSelect(option.key) },
                    selected = option.key == selected,
                    showCheck = true,
                    enabled = option.enabled,
                    leading = option.icon?.let { mark -> {
                        Icon(mark, contentDescription = null, tint = option.iconTint ?: colors.fg2, modifier = Modifier.size(metrics.smallIconSize))
                    } },
                ) {
                    Text(option.label, style = RiffetMenuText, color = if (option.enabled) colors.fg else LocalRiffetSurfaces.current.disabledContent)
                }
            }
        }
    }
}

/** Which of the model sheet's two pages: the list ([paramId] null) or one parameter's own list. */
private data class ModelPage(val paramId: String?)


/**
 * Every parameter of the selected model as one compact strip under the list.
 *
 *  - a select or effort ladder is a menu chip showing `Effort · High`: a dropdown for four options or
 *    fewer, the parameter's own list page above that (and the page is where its description and the
 *    Default marker live);
 *  - Fast with a Default choice is a menu chip too, so Default stays reachable without a marker here;
 *  - Fast, Thinking and Max are toggle chips, selected = on. Max's remaining windows (300K / 1M)
 *    stay a Context menu chip while Max is off, so no documented window becomes unreachable.
 */
@Composable
private fun ParamStrip(
    params: List<ModelParam>,
    enabled: Boolean,
    onChange: (id: String, value: String) -> Unit,
    onOpenList: (id: String) -> Unit,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    Column(Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .riffetHorizontalScroll(rememberScrollState())
                .padding(horizontal = SheetInset),
            horizontalArrangement = Arrangement.spacedBy(metrics.controlInset / 2),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            params.forEach { param ->
                val title = paramTitle(param)
                when (paramKind(param)) {
                    ParamKind.EFFORT, ParamKind.SELECT -> ParamMenuChip(
                        title, listValues(param), param, enabled, { onChange(param.id, it) }, { onOpenList(param.id) },
                    )

                    // Fast is a switch only, as on the desktop: no "Default" third state.
                    ParamKind.FAST, ParamKind.TOGGLE ->
                        ToggleChip(title, isOn(param), { onChange(param.id, toggledValue(param, it)) }, enabled)

                    ParamKind.MAX -> {
                        ToggleChip(title, isOn(param), { onChange(param.id, toggledValue(param, it)) }, enabled)
                        val windows = contextChoices(param)
                        if (windows.size >= 2 && !isOn(param)) {
                            ParamMenuChip(
                                stringResource(Res.string.pmodel_context), windows, param, enabled,
                                { onChange(param.id, it) }, { onOpenList(param.id) },
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ParamMenuChip(
    title: String,
    options: List<ModelParamOption>,
    param: ModelParam,
    enabled: Boolean,
    onSelect: (String) -> Unit,
    onOpenList: () -> Unit,
) {
    val colors = LocalRiffetColors.current
    var open by remember { mutableStateOf(false) }
    val label = stringResource(Res.string.pmodel_param_chip, title, optionLabel(param, param.value))
    Box {
        ChipButton(label, active = false, enabled = enabled, onClick = {
            if (options.size > 4) onOpenList() else open = true
        })
        RiffetDropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            options.forEach { option ->
                RiffetMenuItem(onClick = { open = false; onSelect(option.value) }, selected = option.value == param.value, showCheck = true) {
                    Text(optionLabel(param, option.value), style = RiffetMenuText, color = colors.fg)
                }
            }
        }
    }
}

