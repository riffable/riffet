package riffet.ui.pickers

import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.LocalRiffetSurfaces
import riffet.ui.design.ChipButton
import riffet.ui.design.ToggleChip
import androidx.compose.foundation.clickable
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
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
 * The phone's own difference, also the web's (`inlineParams={mobile}`): the parameter controls are
 * full-width rows under the list rather than a small block beside it.
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
    switching: Boolean,
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
    /** False for the chat picker, whose title already says everything the subtitle would repeat. */
    showSubtitle: Boolean = true,
) {
    PickerSheetFrame(onDismiss) {
        ModelPickerPages(
            catalog = catalog,
            catalogLoading = catalogLoading,
            catalogError = catalogError,
            selection = selection,
            switching = switching,
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
            showSubtitle = showSubtitle,
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
    switching: Boolean,
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
    /** False for the chat picker, whose title already says everything the subtitle would repeat. */
    showSubtitle: Boolean = true,
    modifier: Modifier = Modifier,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    // Quota and load move by the minute, so they are read each time the sheet opens; a failed read
    // leaves the figures out and never holds up the list. A provider switch writes a new read, so
    // the previous provider's figures are dropped first instead of being mislabelled.
    var usage by remember { mutableStateOf<NativeBackendUsage?>(null) }
    LaunchedEffect(loadUsage != null, usageScopeKey, activeProfileId) {
        usage = null
        val load = loadUsage ?: return@LaunchedEffect
        usage = try { load() } catch (cancellation: kotlinx.coroutines.CancellationException) { throw cancellation } catch (_: Throwable) { null }
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
    val tags = selectionTags(params)
    val selectModel = stringResource(Res.string.pmodel_title)
    val currentLabel = modelLabel(catalog, selection).ifEmpty { selection.ifEmpty { selectModel } }
    // Which parameter's options are open as their own list. Only an id, so the list re-reads the
    // live parameter (and its new value) rather than holding a stale copy.
    var listParamId by remember { mutableStateOf<String?>(null) }
    val applyParam: (String, String) -> Unit = { id, value ->
        (onParamChange ?: onSelect)(selectionWithParam(catalog, selection, id, value))
    }

    val grouped = groups.size > 1
    val providerName = if (grouped) groups.firstOrNull { it.profileId == activeProfileId }?.name?.takeIf { it.isNotBlank() } else null

    val switchingText = stringResource(Res.string.pmodel_switching)
    val catalogLoadingText = stringResource(Res.string.pmodel_loading)
    val fastText = stringResource(Res.string.pmodel_fast)
    val maxText = stringResource(Res.string.pmodel_max)
    val limitText = stringResource(Res.string.pmodel_limit_reached)
    val retryText = stringResource(Res.string.pmodel_retry)
    val noModelsText = stringResource(Res.string.pmodel_none)
    val unavailableText = stringResource(Res.string.pmodel_unavailable)
    val catalogErrorText = catalogError?.let { stringResource(Res.string.pmodel_load_failed, it) }
    val subtitle = if (!showSubtitle) {
        ""
    } else {
        buildString {
            if (!providerName.isNullOrBlank()) append(providerName).append(" · ")
            append(currentLabel)
            tags.effort?.let { append(" · ").append(it) }
            if (tags.fast) append(" · ").append(fastText)
            if (tags.max) append(" · ").append(maxText)
            tags.context?.let { append(" · ").append(it) }
            when {
                switching -> append(" · ").append(switchingText)
                catalogLoading -> append(" · ").append(catalogLoadingText)
            }
        }.takeIf { it != currentLabel }.orEmpty() // the model alone is already the checked row
    }

    val host = LocalPickerHost.current
    // A pick has already been applied by the time this runs; it only lets the sheet leave.
    val dismiss: () -> Unit = { host?.dismiss?.invoke() }
    // Hoisted so the list keeps its scroll position while a parameter's list covers it.
    val modelListState = rememberLazyListState()
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
            PickerPage(title = selectModel, subtitle = subtitle, fullHeight = true, onBack = onBack) {
            usage?.account?.let { account ->
                Text(
                    text = (if (account.limitReached) limitText + " · " else "") + accountSummary(account),
                    style = typography.caption,
                    color = if (account.limitReached) colors.danger else colors.fg3,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = SheetInset, vertical = (metrics.controlInset / 4)),
                )
            }
            if (!disabledReason.isNullOrEmpty()) SheetNotice(disabledReason, SettingsNoticeKind.INFO)
            if (catalogErrorText != null) SheetNotice(catalogErrorText, SettingsNoticeKind.ERROR, retryText, onRetryCatalog)
            if (!grouped && !catalogLoading && catalogError == null && catalog.isEmpty()) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = SheetInset, vertical = (metrics.rowPadding / 2)),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(text = noModelsText, style = typography.bodySmall, color = colors.fg3, modifier = Modifier.weight(1f))
                    riffet.ui.design.RiffetTextButton(onClick = onRetryCatalog) {
                        Text(retryText)
                    }
                }
            }

            Column(Modifier.weight(1f).fillMaxWidth()) {
                LazyColumn(state = modelListState, modifier = Modifier.weight(1f).fillMaxWidth().padding(top = (metrics.controlInset / 4))) {
                    if (grouped) {
                        groups.forEach { group ->
                            val models = group.models
                            item(key = "group:${group.profileId}") { SectionLabel(group.name) }
                            when {
                                group.loading && models.isEmpty() -> item(key = "loading:${group.profileId}") {
                                    Text(
                                        text = catalogLoadingText,
                                        style = typography.bodySmall,
                                        color = colors.fg3,
                                        modifier = Modifier.fillMaxWidth().padding(horizontal = SheetInset, vertical = (metrics.controlInset / 2)),
                                    )
                                }
                                group.error != null -> item(key = "error:${group.profileId}") {
                                    Row(
                                        modifier = Modifier.fillMaxWidth().padding(horizontal = SheetInset, vertical = (metrics.controlInset / 2)),
                                        verticalAlignment = Alignment.CenterVertically,
                                    ) {
                                        Text(
                                            text = stringResource(Res.string.pmodel_load_failed, group.error),
                                            style = typography.bodySmall,
                                            color = colors.danger,
                                            modifier = Modifier.weight(1f),
                                        )
                                        riffet.ui.design.RiffetTextButton(onClick = {
                                            val retryGroup = onRetryGroup
                                            if (retryGroup != null) retryGroup(group.profileId) else onRetryCatalog()
                                        }) { Text(retryText) }
                                    }
                                }
                                !group.available && models.isEmpty() -> item(key = "unavailable:${group.profileId}") {
                                    Text(
                                        text = group.unavailableReason ?: unavailableText,
                                        style = typography.bodySmall,
                                        color = colors.fg3,
                                        modifier = Modifier.fillMaxWidth().padding(horizontal = SheetInset, vertical = (metrics.controlInset / 2)),
                                    )
                                }
                                models.isEmpty() -> item(key = "none:${group.profileId}") {
                                    Text(
                                        text = noModelsText,
                                        style = typography.bodySmall,
                                        color = colors.fg3,
                                        modifier = Modifier.fillMaxWidth().padding(horizontal = SheetInset, vertical = (metrics.controlInset / 2)),
                                    )
                                }
                                else -> {
                                    val reason = group.unavailableReason
                                    if (!group.available && !reason.isNullOrBlank()) {
                                        item(key = "reason:${group.profileId}") {
                                            Text(
                                                text = reason,
                                                style = typography.bodySmall,
                                                color = colors.fg3,
                                                modifier = Modifier.fillMaxWidth().padding(horizontal = SheetInset, vertical = (metrics.controlInset / 4)),
                                            )
                                        }
                                    }
                                    items(models, key = { "${group.profileId}:${it.value}" }) { model ->
                                        val blocked = disabledReason ?: if (!group.available) "" else null
                                        OptionRow(
                                            label = cleanLabel(model.name.ifEmpty { model.value }),
                                            selected = group.profileId == activeProfileId && model.value == parsed.model,
                                            onClick = {
                                                val next = selectionForModel(models, model.value)
                                                val choose = onSelectChoice
                                                if (choose != null) choose(group.profileId, next) else onSelect(next)
                                                dismiss()
                                            },
                                            disabledReason = blocked,
                                            trailing = if (group.profileId == activeProfileId) {
                                                usage?.models?.get(model.value)?.let { status -> { ModelStatusTags(status) } }
                                            } else {
                                                null
                                            },
                                        )
                                    }
                                }
                            }
                        }
                    } else {
                        items(catalog, key = { it.value }) { model ->
                            OptionRow(
                                label = cleanLabel(model.name.ifEmpty { model.value }),
                                selected = model.value == parsed.model,
                                onClick = {
                                    onSelect(selectionForModel(catalog, model.value))
                                    dismiss()
                                },
                                disabledReason = disabledReason,
                                trailing = usage?.models?.get(model.value)?.let { status -> { ModelStatusTags(status) } },
                            )
                        }
                    }
                }
                if (params.isNotEmpty()) {
                    ParamStrip(params = params, enabled = disabledReason == null, onChange = applyParam, onOpenList = { listParamId = it })
                } else {
                    Spacer(Modifier.height(metrics.controlInset))
                }
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
    val colors = LocalRiffetColors.current
    Column(Modifier.fillMaxWidth()) {
        HorizontalDivider(color = colors.line)
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState())
                .padding(horizontal = SheetInset, vertical = metrics.controlInset / 2),
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

