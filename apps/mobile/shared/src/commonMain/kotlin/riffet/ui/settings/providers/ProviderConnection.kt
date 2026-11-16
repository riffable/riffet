package riffet.ui.settings.providers

import androidx.compose.runtime.*
import riffet.ui.design.GroupRow
import riffet.ui.timeline.Spinner
import org.jetbrains.compose.resources.stringResource
import riffet.contracts.NativeBackendId
import riffet.contracts.NativeBackendProfileSettings
import riffet.contracts.NativeBackendUsage
import riffet.shared.ModelSourceDescriptor
import riffet.ui.settings.*
import riffet_mobile.shared.generated.resources.*

@Composable
internal fun rememberProviderSources(controller: SettingsController, backend: NativeBackendId): Triple<List<ModelSourceDescriptor>, Set<String>, Boolean> {
    var sources by remember(controller, backend) { mutableStateOf(emptyList<ModelSourceDescriptor>()) }
    var loaded by remember(controller, backend) { mutableStateOf(false) }
    var available by remember(controller, backend) { mutableStateOf(emptySet<String>()) }
    LaunchedEffect(controller, backend) {
        val plugins = controller.providerPlugins().getOrNull() ?: return@LaunchedEffect
        available = plugins.filter { it.enabled }.flatMap { it.contributes.modelSources }.map { it.id }.toSet()
        val consumes = controller.backendCapabilities(backend).getOrNull()?.consumesProtocols
        sources = plugins.flatMap { it.contributes.modelSources }.filter { source ->
            if (consumes != null && source.protocols != null) consumes.any { it in source.protocols.orEmpty() }
            else backend.name.lowercase() in source.backends
        }
        loaded = true
    }
    return Triple(sources, available, loaded)
}

internal fun connectionChoice(draft: BackendProfileDraft, sources: List<ModelSourceDescriptor>): String =
    draft.connectionMethod ?: draft.modelSource?.takeUnless { id -> sources.any { it.id == id && it.role == "adapter" } }
        ?: if (draft.modelSource != null || draft.apiEndpoint.isNotEmpty()) "api" else "login"

internal fun isApiConnection(choice: String, sources: List<ModelSourceDescriptor>): Boolean =
    choice == "api" || sources.any { it.id == choice && it.role == "adapter" }

@Composable
internal fun ProviderConnectionChoices(
    draft: BackendProfileDraft,
    sources: List<ModelSourceDescriptor>,
    enabled: Boolean,
    available: Set<String>,
    onChange: (BackendProfileDraft) -> Unit,
) {
    val choice = connectionChoice(draft, sources)
    val choices = listOf("login" to stringResource(Res.string.settings_cli_builtin_login), "api" to stringResource(Res.string.settings_custom_api)) +
        sources.filter { it.role != "adapter" && it.id in available }.map { it.id to it.label } +
        listOfNotNull(draft.modelSource?.takeIf { id -> id !in available && sources.none { it.id == id && it.role == "adapter" } }?.let { it to "$it · ${stringResource(Res.string.prov_unavailable)}" })
    SettingsChoiceRow(stringResource(Res.string.prov_connection_method), choices, choice, enabled = enabled) { next ->
        if (next != choice) onChange(draft.copy(
            connectionMethod = next, modelSource = next.takeUnless { it == "login" || it == "api" }, apiEndpoint = "",
            defaultModel = "", enabledModels = null, modelInputModalities = emptyMap(), modelContextWindows = emptyMap(),
        ))
    }
    if (choice == "api") {
        SettingsChoiceRow(
            stringResource(Res.string.prov_gateway_type),
            listOf("" to stringResource(Res.string.prov_generic_gateway)) + sources.filter { it.role == "adapter" && it.id in available }.map { it.id to it.label } +
                listOfNotNull(draft.modelSource?.takeIf { it !in available }?.let { it to "$it · ${stringResource(Res.string.prov_unavailable)}" }),
            draft.modelSource.orEmpty(), enabled = enabled,
        ) { onChange(draft.copy(modelSource = it.ifEmpty { null })) }
    }
}

@Composable
internal fun ProviderQuota(controller: SettingsController, backend: NativeBackendId, profile: NativeBackendProfileSettings, dirty: Boolean) {
    val (sources, available) = rememberProviderSources(controller, backend)
    val hasUsage = sources.firstOrNull { it.id == profile.modelSource }?.usage == true
    val active = profile.modelSource in available
    var usage by remember(controller, backend, profile) { mutableStateOf<NativeBackendUsage?>(null) }
    var error by remember(controller, backend, profile) { mutableStateOf(false) }
    var loading by remember(controller, backend, profile) { mutableStateOf(false) }
    var retry by remember { mutableStateOf(0) }
    LaunchedEffect(controller, backend, profile, dirty, hasUsage, active, retry) {
        if (dirty) { usage = null; error = false }
        if (dirty || !hasUsage || !active) { loading = false; return@LaunchedEffect }
        loading = true
        controller.usage(backend, profile.id).onSuccess { usage = it; error = false }.onFailure { error = true }
        loading = false
    }
    if (!hasUsage) return
    val summary = usage?.account?.let { riffet.ui.pickers.accountSummary(it) }
    SettingsGroup(stringResource(Res.string.prov_quota)) {
        GroupRow(title = summary?.takeIf { it.isNotBlank() } ?: "—", trailing = { if (loading) Spinner() })
        if (!active) SettingsFootnote(stringResource(Res.string.prov_unavailable))
        else if (error) SettingsFootnote(stringResource(Res.string.prov_quota_failed))
        SettingsActionRow(stringResource(if (error) Res.string.settings_retry else Res.string.prov_refresh_quota), enabled = !dirty && active && !loading, onClick = { retry++ })
    }
}
