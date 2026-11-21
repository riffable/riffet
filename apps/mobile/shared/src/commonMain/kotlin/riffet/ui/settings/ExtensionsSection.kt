package riffet.ui.settings

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.getString
import org.jetbrains.compose.resources.stringResource
import riffet.contracts.ExtensionContext
import riffet.contracts.ExtensionInventory
import riffet.contracts.ExtensionManagementCapabilities
import riffet.contracts.ExtensionActionRequest
import riffet.contracts.NativeBackendId
import riffet.contracts.NativeBackendProfileSettings
import riffet.shared.RiffetApi
import riffet.shared.backendProfiles
import riffet.shared.extensionAction
import riffet.shared.extensionCapabilities
import riffet.shared.extensions
import riffet.ui.app.LocalRiffetSnackbar
import riffet.ui.app.PageBarAction
import riffet.ui.app.PageBarProgress
import riffet.ui.app.PageHost
import riffet.ui.app.PageMoreAction
import riffet.ui.app.PageSearch
import riffet.ui.app.PageStack
import riffet.ui.design.ChipButton
import riffet.ui.design.ChipItem
import riffet.ui.design.ChipRow
import riffet.ui.design.ConfirmDialog
import riffet.ui.design.GroupRow
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.RiffetTextButton
import riffet.ui.icons.RiffetIcons
import riffet.ui.pickers.RiffetDropdownMenu
import riffet.ui.pickers.RiffetMenuItem
import riffet.ui.settings.extensions.CenteredSpinner
import riffet.ui.settings.extensions.ExtRoute
import riffet.ui.settings.extensions.ExtensionCreatePage
import riffet.ui.settings.extensions.ExtensionDetailPage
import riffet.ui.settings.extensions.ExtensionDiagnosticsPage
import riffet.ui.settings.extensions.ExtensionEditorPage
import riffet.ui.settings.extensions.ExtensionIcon
import riffet.ui.settings.extensions.ExtensionInstallPage
import riffet.ui.settings.extensions.ExtensionRuntimePage
import riffet.ui.settings.extensions.extensionKind
import riffet.ui.settings.extensions.extensionKindOrder
import riffet.ui.settings.extensions.extensionScope
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet_mobile.shared.generated.resources.*

/** What the pages of the extension directory share: the agent and config in scope, and what the server lists for them. */
internal class ExtensionsController(
    val api: RiffetApi, private val scope: CoroutineScope, private val projectId: String?,
    initialBackend: NativeBackendId = NativeBackendId.CLAUDE,
) {
    var backend by mutableStateOf(initialBackend)
    var profiles by mutableStateOf<List<NativeBackendProfileSettings>>(emptyList())
    var profileId by mutableStateOf("")
    var inventory by mutableStateOf<ExtensionInventory?>(null)
    var capabilities by mutableStateOf<ExtensionManagementCapabilities?>(null)
    /** True from the first frame, so the page opens on a spinner rather than an empty list. */
    var loading by mutableStateOf(true)
    var error by mutableStateOf<String?>(null)
    val context get() = ExtensionContext(backend, profileId, projectId)
    private var job: Job? = null

    private fun launch(block: suspend () -> Unit) {
        job?.cancel()
        loading = true; error = null
        job = scope.launch {
            try { block() }
            catch (cancel: CancellationException) { throw cancel }
            catch (failure: Throwable) { error = failure.message ?: getString(Res.string.settings_extra_ext_action_failed) }
            finally { loading = false }
        }
    }

    private suspend fun load() {
        val scoped = context
        val listed = api.extensions(scoped)
        val allowed = try { api.extensionCapabilities(scoped) } catch (cancel: CancellationException) { throw cancel } catch (_: Throwable) { null }
        inventory = listed; capabilities = allowed
    }

    fun chooseBackend(value: NativeBackendId) {
        backend = value; profiles = emptyList(); profileId = ""; inventory = null; capabilities = null
        launch {
            val response = api.backendProfiles(value)
            profiles = response.profiles
            profileId = response.defaultProfileId ?: profiles.firstOrNull { it.isDefault == true }?.id ?: profiles.firstOrNull()?.id.orEmpty()
            if (profileId.isNotEmpty()) load()
        }
    }

    fun chooseProfile(id: String) {
        profileId = id; inventory = null; capabilities = null
        launch { load() }
    }

    /** Pull to refresh, retry, and after a change: the list stays while it is read again. */
    fun reload() {
        if (profileId.isEmpty()) chooseBackend(backend) else launch { load() }
    }

    /** After a file or install changed what the server lists: a failure here is not the change's failure. */
    suspend fun refreshQuietly() {
        try { inventory = api.extensions(context) } catch (cancel: CancellationException) { throw cancel } catch (_: Throwable) {}
    }
}

private const val PREVIEW = 5

/** The extensions page and the pages above it, each its own page of a nested stack (mobile.md §2.1). */
@Composable
internal fun ExtensionsPage(
    api: RiffetApi, projectId: String?, title: String, onBack: () -> Unit,
    /** The agent the page opens on; the assistant's is Claude Code. */
    backend: NativeBackendId = NativeBackendId.CLAUDE,
) {
    val scope = rememberCoroutineScope()
    key(api, projectId) {
        val controller = remember { ExtensionsController(api, scope, projectId, backend) }
        val pages = remember { PageStack<ExtRoute>(ExtRoute.Directory) }
        LaunchedEffect(controller) { controller.chooseBackend(controller.backend) }
        PageHost(pages) { route, back ->
            when (route) {
                ExtRoute.Directory -> ExtensionDirectory(controller, title, onBack, pages::push)
                is ExtRoute.Detail -> ExtensionDetailPage(controller, route.itemId, pages::push, back)
                is ExtRoute.Editor -> ExtensionEditorPage(controller, route.documentId, back)
                is ExtRoute.Create -> ExtensionCreatePage(controller, route.target, back)
                ExtRoute.Install -> ExtensionInstallPage(controller, back)
                ExtRoute.Runtime -> ExtensionRuntimePage(controller, back)
                ExtRoute.Diagnostics -> ExtensionDiagnosticsPage(controller.inventory?.diagnostics.orEmpty(), back)
            }
        }
    }
}

@Composable
private fun ExtensionDirectory(controller: ExtensionsController, title: String, onBack: () -> Unit, push: (ExtRoute) -> Unit) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val metrics = LocalInterfaceStyle.current.metrics
    val scope = rememberCoroutineScope()
    val snackbar = LocalRiffetSnackbar.current
    var query by remember { mutableStateOf("") }
    var kindFilter by remember { mutableStateOf("") }
    var reloadConfirm by remember { mutableStateOf(false) }
    var reloading by remember { mutableStateOf(false) }
    val inventory = controller.inventory
    val needle = query.trim()
    val items = inventory?.items.orEmpty().filter {
        needle.isEmpty() || it.name.contains(needle, true) || it.kind.contains(needle, true)
    }
    val extraKinds = items.map { it.kind }.toSet() - extensionKindOrder.toSet()
    val kinds = (extensionKindOrder + extraKinds.sorted()).filter { kind -> items.any { it.kind == kind } }
    // A kind that left with a scope change falls back to every kind.
    val kind = if (kindFilter in kinds) kindFilter else ""
    val shownKinds = if (kind.isEmpty()) kinds else listOf(kind)
    val capped = kind.isEmpty() && needle.isEmpty()
    val targets = inventory?.createTargets.orEmpty()
    val canInstall = controller.capabilities?.actions?.contains("install") == true
    val canReload = controller.capabilities?.actions?.contains("reload") == true
    val diagnostics = inventory?.diagnostics.orEmpty()
    val unsupportedReason = controller.capabilities?.reason
    val addEntries = targets.map { target -> (extensionKind(target.kind) + " · " + extensionScope(target.scope)) to ExtRoute.Create(target) } +
        (if (canInstall) listOf(stringResource(Res.string.settings_install_plugin) to ExtRoute.Install) else emptyList())
    val reloadTitle = stringResource(Res.string.settings_reload_mcp_confirm)

    SettingsPage(
        title, onBack,
        search = PageSearch(query, { query = it }, stringResource(Res.string.ext_search_placeholder)),
        refreshing = controller.loading && inventory != null,
        onRefresh = controller::reload,
        actions = {
            if (controller.loading && inventory == null || reloading) PageBarProgress()
            if (addEntries.isNotEmpty()) AddMenu(addEntries, push)
            PageMoreAction { close ->
                RiffetMenuItem(stringResource(Res.string.settings_extension_runtime), onClick = { close(); push(ExtRoute.Runtime) })
                if (diagnostics.isNotEmpty()) RiffetMenuItem(stringResource(Res.string.ext_diagnostics_count, diagnostics.size), onClick = { close(); push(ExtRoute.Diagnostics) })
                if (canReload) RiffetMenuItem(stringResource(Res.string.ext_reload_mcp), onClick = { close(); reloadConfirm = true })
            }
        },
    ) {
        ChipRow(
            items = emptyList(), selected = "", onSelect = {}, modifier = Modifier.bleed(),
            leading = {
                ScopeChip(backendLabel(controller.backend), NativeBackendId.entries.filter { it != NativeBackendId.CHAT }.map { it.name to backendLabel(it) }) {
                    controller.chooseBackend(NativeBackendId.valueOf(it))
                }
                ScopeChip(
                    controller.profiles.firstOrNull { it.id == controller.profileId }?.name ?: stringResource(Res.string.settings_select_config),
                    controller.profiles.map { it.id to it.name },
                ) { controller.chooseProfile(it) }
            },
        )
        if (kinds.size > 1) ChipRow(
            items = listOf(ChipItem("", stringResource(Res.string.ext_all))) + kinds.map { ChipItem(it, extensionKind(it), items.count { item -> item.kind == it }) },
            selected = kind, onSelect = { kindFilter = it }, modifier = Modifier.bleed(),
        )
        controller.error?.let { message ->
            PageBanner(message, SettingsNoticeKind.ERROR, stringResource(Res.string.settings_retry), controller::reload)
        }
        shownKinds.forEach { group ->
            val members = items.filter { it.kind == group }
            val shown = if (capped) members.take(PREVIEW) else members
            SettingsGroup(extensionKind(group)) {
                shown.forEach { item ->
                    GroupRow(
                        title = item.name,
                        subtitle = listOfNotNull(extensionScope(item.scope), item.description?.takeIf { it.isNotBlank() }).joinToString(" · "),
                        leading = { ExtensionIcon(item.kind) },
                        value = if (item.enabled == false) stringResource(Res.string.settings_disabled) else null,
                        chevron = true,
                        onClick = { push(ExtRoute.Detail(item.id)) },
                    )
                }
                if (shown.size < members.size) SettingsActionRow(stringResource(Res.string.ext_show_all, members.size), onClick = { kindFilter = group })
            }
        }
        if (controller.loading && inventory == null) CenteredSpinner()
        else if (items.isEmpty() && controller.error == null) {
            ExtensionsEmpty(searching = needle.isNotEmpty(), entries = if (needle.isEmpty()) addEntries else emptyList(), push = push)
        }
        unsupportedReason?.let { SettingsFootnote(it) }
    }

    if (reloadConfirm) ConfirmDialog(
        title = reloadTitle,
        message = stringResource(Res.string.ext_reload_mcp_effect),
        confirmLabel = stringResource(Res.string.settings_reload),
        onConfirm = {
            reloadConfirm = false
            reloading = true
            scope.launch {
                try {
                    val response = controller.api.extensionAction(controller.context, ExtensionActionRequest("reload"))
                    val note = if (response.success) response.applyEffect else response.diagnostics?.joinToString("\n") ?: response.output
                    if (!note.isNullOrBlank()) snackbar?.show(note)
                } catch (cancel: CancellationException) { throw cancel }
                catch (failure: Throwable) { snackbar?.show(failure.message ?: getString(Res.string.settings_extra_ext_action_failed)) }
                finally { reloading = false }
            }
        },
        onDismiss = { reloadConfirm = false },
    )
}

/** The `+` of the bar: one entry per kind of new file, and the plugin install. */
@Composable
private fun AddMenu(entries: List<Pair<String, ExtRoute>>, push: (ExtRoute) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        PageBarAction(RiffetIcons.Plus, stringResource(Res.string.settings_add), { open = true })
        RiffetDropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            entries.forEach { (label, route) -> RiffetMenuItem(label, onClick = { open = false; push(route) }) }
        }
    }
}

/** A scope of the list as a chip that shows the current value and opens a menu of the others. */
@Composable
private fun ScopeChip(label: String, choices: List<Pair<String, String>>, onSelect: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        ChipButton(label, active = false, onClick = { if (choices.isNotEmpty()) open = true })
        RiffetDropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            choices.forEach { (id, text) -> RiffetMenuItem(text, onClick = { open = false; onSelect(id) }) }
        }
    }
}

/** An empty list says so and offers the way to the first extension; a search with no match only says so. */
@Composable
private fun ExtensionsEmpty(searching: Boolean, entries: List<Pair<String, ExtRoute>>, push: (ExtRoute) -> Unit) {
    var open by remember { mutableStateOf(false) }
    riffet.ui.design.EmptyState(
        message = if (searching) stringResource(Res.string.settings_no_matching_extensions) else stringResource(Res.string.ext_empty),
        icon = RiffetIcons.Puzzle,
        fill = false,
        actions = if (entries.isEmpty()) null else ({
            Box {
                RiffetTextButton(onClick = { open = true }) { Text(stringResource(Res.string.settings_new)) }
                RiffetDropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                    entries.forEach { (label, route) -> RiffetMenuItem(label, onClick = { open = false; push(route) }) }
                }
            }
        }),
    )
}
