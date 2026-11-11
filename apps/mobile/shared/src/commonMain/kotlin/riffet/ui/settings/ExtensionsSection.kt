package riffet.ui.settings

import riffet.ui.design.LocalInterfaceStyle
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import riffet.ui.design.RiffetTextButton
import riffet.ui.icons.Icon
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.getString
import org.jetbrains.compose.resources.stringResource
import riffet_mobile.shared.generated.resources.*
import riffet.contracts.*
import riffet.shared.RiffetApi
import riffet.ui.pickers.RiffetDropdownMenu
import riffet.ui.pickers.RiffetMenuItem
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet.ui.theme.LocalRiffetMotion
import riffet.shared.backendProfiles
import riffet.shared.createExtensionDocument
import riffet.shared.extension
import riffet.shared.extensionAction
import riffet.shared.extensionCapabilities
import riffet.shared.extensionDocument
import riffet.shared.extensionRuntime
import riffet.shared.extensions
import riffet.shared.saveExtensionDocument

/** One active operation at a time keeps an edit pinned to its original server/profile. */
internal class ExtensionsController(private val api: RiffetApi, private val scope: CoroutineScope, private val projectId: String?) {
    var backend by mutableStateOf(NativeBackendId.CURSOR)
    var profiles by mutableStateOf<List<NativeBackendProfileSettings>>(emptyList())
    var profileId by mutableStateOf("")
    var inventory by mutableStateOf<ExtensionInventory?>(null)
    var detail by mutableStateOf<ExtensionDetail?>(null)
    var document by mutableStateOf<ExtensionDocument?>(null)
    var text by mutableStateOf("")
    var creating by mutableStateOf<ExtensionCreateTarget?>(null)
    var path by mutableStateOf("")
    var busy by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var notice by mutableStateOf<String?>(null)
    var capabilities by mutableStateOf<ExtensionManagementCapabilities?>(null)
    var runtime by mutableStateOf<ExtensionRuntimeReport?>(null)
    val dirty get() = creating != null || (document != null && text != document!!.content)
    val context get() = ExtensionContext(backend, profileId, projectId)
    val serverUrl get() = api.baseUrl
    fun matches(api: RiffetApi, projectId: String?) = this.api === api && this.projectId == projectId

    private fun perform(block: suspend () -> Unit) {
        if (busy) return
        busy = true; error = null
        scope.launch {
            try { block() }
            catch (cancel: CancellationException) { throw cancel }
            catch (failure: Throwable) { error = failure.message ?: getString(Res.string.settings_extra_ext_action_failed) }
            finally { busy = false }
        }
    }
    fun clear() { detail = null; document = null; text = ""; creating = null; path = "" }
    fun chooseBackend(value: NativeBackendId) = perform {
        clear(); backend = value; profiles = emptyList(); profileId = ""; inventory = null; capabilities = null; runtime = null
        val response = api.backendProfiles(value)
        profiles = response.profiles
        profileId = response.defaultProfileId ?: profiles.firstOrNull { it.isDefault == true }?.id ?: profiles.firstOrNull()?.id.orEmpty()
        if (profileId.isNotEmpty()) load()
    }
    private suspend fun load() {
        inventory = api.extensions(context)
        capabilities = try { api.extensionCapabilities(context) } catch (cancel: CancellationException) { throw cancel } catch (_: Throwable) { null }
    }
    fun chooseProfile(id: String) = perform { clear(); profileId = id; inventory = null; capabilities = null; runtime = null; load() }
    fun refresh() = perform { clear(); load() }
    fun open(id: String) = perform {
        clear(); detail = api.extension(context, id)
        val file = detail?.files?.firstOrNull { it.id == detail?.item?.documentId } ?: detail?.files?.firstOrNull()
        if (file != null) { document = api.extensionDocument(context, file.id); text = document!!.content }
    }
    fun openFile(id: String) = perform { document = api.extensionDocument(context, id); text = document!!.content; creating = null }
    suspend fun create(target: ExtensionCreateTarget) {
        clear(); creating = target
        path = listOf(target.directory, if (target.kind == "skill") "my-skill/SKILL.md" else target.fileName ?: "my-extension.md").filter { it.isNotEmpty() }.joinToString("/")
        text = target.template ?: when (target.kind) {
            "skill" -> getString(Res.string.settings_extra_ext_template_skill)
            "mcp" -> "{\n  \"mcpServers\": {}\n}\n"
            "hook" -> "{}\n"
            else -> getString(Res.string.settings_extra_ext_template_instructions)
        }
    }
    fun save(onSaved: () -> Unit = {}) = perform {
        val target = creating
        val previous = document
        val saved = if (target != null) api.createExtensionDocument(context, target.id, path, text)
            else if (previous?.editable == true) api.saveExtensionDocument(context, previous.id, text, previous.contentHash)
            else return@perform
        document = saved; text = saved.content; creating = null; notice = saved.applyEffect
        try { inventory = api.extensions(context) } catch (cancel: CancellationException) { throw cancel } catch (_: Throwable) { notice = getString(Res.string.settings_extra_ext_saved_refresh_failed) }
        onSaved()
    }
    fun action(action: String, target: String? = null, installScope: String = "user") = perform {
        val response = api.extensionAction(context, ExtensionActionRequest(action, if (target == null && action != "reload") detail?.item?.id else null, target, if (target != null && action == "install") installScope else null))
        notice = listOfNotNull(response.applyEffect, response.authorizationUrl, response.output, response.diagnostics?.joinToString("\n")).joinToString("\n")
        if (response.success) { clear(); load() }
    }
    fun readRuntime() = perform { runtime = api.extensionRuntime(context) }
}

@Composable
internal fun ExtensionsSection(api: RiffetApi, projectId: String?) {
    val metrics = LocalInterfaceStyle.current.metrics
    val motion = LocalRiffetMotion.current
    val coroutineScope = rememberCoroutineScope()
    var controller by remember { mutableStateOf(ExtensionsController(api, coroutineScope, projectId)) }
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val reloadMcpConfirm = stringResource(Res.string.settings_reload_mcp_confirm)
    val startMcpAuthConfirm = stringResource(Res.string.settings_start_mcp_auth_confirm)
    var pending by remember { mutableStateOf<(() -> Unit)?>(null) }
    var confirmation by remember { mutableStateOf<Pair<String, () -> Unit>?>(null) }
    var preview by remember { mutableStateOf(false) }
    var search by remember { mutableStateOf("") }
    var installTarget by remember { mutableStateOf("") }
    var installScope by remember { mutableStateOf("user") }
    var kind by remember { mutableStateOf("") }
    var showDiagnostics by remember { mutableStateOf(false) }
    var showInstall by remember { mutableStateOf(false) }
    var visibleCount by remember { mutableStateOf(40) }
    LaunchedEffect(search, kind, controller.backend, controller.profileId) { visibleCount = 40 }
    fun navigate(action: () -> Unit) { if (!controller.busy) { if (controller.dirty) pending = action else { preview = false; action() } } }
    LaunchedEffect(controller) { controller.chooseBackend(controller.backend) }
    LaunchedEffect(api, projectId, controller.busy, controller.dirty) {
        if (!controller.matches(api, projectId) && !controller.busy && !controller.dirty) controller = ExtensionsController(api, coroutineScope, projectId)
    }
    UnsavedSettingsGuard(controller.dirty, controller.busy, onSave = controller::save)
    val inDetail = controller.document != null || controller.creating != null || controller.detail != null
    if (!controller.matches(api, projectId)) {
        PageBanner(stringResource(Res.string.settings_extension_connection_changed, controller.serverUrl), SettingsNoticeKind.INFO)
        SettingsButton(stringResource(Res.string.settings_extension_switch_connection), enabled = !controller.busy, onClick = { navigate { controller = ExtensionsController(api, coroutineScope, projectId) } })
        Spacer(Modifier.height(16.dp))
    }
    controller.error?.let { PageBanner(it, SettingsNoticeKind.ERROR); Spacer(Modifier.height(12.dp)) }
    controller.notice?.let { SelectionContainer { Text(it, style = typography.caption, color = colors.fg3) }; Spacer(Modifier.height(12.dp)) }
    if (!inDetail) {
        SettingsGroup(stringResource(Res.string.settings_agent_backends)) {
            SettingsRow("CLI") { ExtensionMenu(backendLabel(controller.backend), NativeBackendId.entries.filter { it != NativeBackendId.CHAT }.map { it.name to backendLabel(it) }, !controller.busy) { id -> navigate { controller.chooseBackend(NativeBackendId.valueOf(id)) } } }
            SettingsRow(stringResource(Res.string.settings_config)) { ExtensionMenu(controller.profiles.firstOrNull { it.id == controller.profileId }?.name ?: stringResource(Res.string.settings_select_config), controller.profiles.map { it.id to it.name }, !controller.busy) { id -> navigate { controller.chooseProfile(id) } } }
        }
        Spacer(Modifier.height(16.dp))
        SettingsField(search, { search = it }, placeholder = stringResource(Res.string.settings_search_extensions))
        Spacer(Modifier.height(12.dp))
        val items = controller.inventory?.items.orEmpty().filter { (kind.isEmpty() || it.kind == kind) && "${it.name} ${it.sourcePath}".contains(search, true) }
        SettingsGroup(stringResource(Res.string.settings_discovered_extensions), action = {
            ExtensionMenu(stringResource(Res.string.settings_new), controller.inventory?.createTargets.orEmpty().map { it.id to "${extensionKind(it.kind)} · ${extensionScope(it.scope)}" }, !controller.busy) { id -> controller.inventory?.createTargets?.find { it.id == id }?.let { target -> coroutineScope.launch { controller.create(target) } } }
        }) {
            SettingsRow(stringResource(Res.string.settings_type)) { ExtensionMenu(if (kind.isEmpty()) stringResource(Res.string.settings_all_types) else extensionKind(kind), listOf("" to stringResource(Res.string.settings_all_types)) + listOf("skill", "mcp", "plugin", "hook", "rule", "command", "config").map { it to extensionKind(it) }, true) { kind = it } }
            if (controller.busy && controller.inventory == null) Text(stringResource(Res.string.settings_reading_extensions), modifier = Modifier.padding(metrics.pageInset), style = typography.body, color = colors.fg3)
            if (!controller.busy && items.isEmpty()) Text(if (controller.inventory != null) stringResource(Res.string.settings_no_matching_extensions) else stringResource(Res.string.settings_no_extension_dir), modifier = Modifier.padding(metrics.pageInset), style = typography.body, color = colors.fg3)
            items.take(visibleCount).forEach { item ->
                val baseSummary = "${extensionKind(item.kind)} · ${extensionScope(item.scope)}"
                val summary = if (item.enabled == false) stringResource(Res.string.settings_extension_disabled_summary, baseSummary) else baseSummary
                SettingsNavigationRow(item.name, summary) { navigate { controller.open(item.id) } }
            }
        }
        Spacer(Modifier.height(12.dp))
        if (items.size > visibleCount) SettingsButton(stringResource(Res.string.settings_show_more, items.size - visibleCount), onClick = { visibleCount += 40 })
        SettingsButton(stringResource(Res.string.settings_refresh_list), enabled = !controller.busy && controller.profileId.isNotEmpty(), onClick = controller::refresh)
        if (!controller.inventory?.diagnostics.isNullOrEmpty()) {
            SettingsButton(if (showDiagnostics) stringResource(Res.string.settings_hide_load_notes) else stringResource(Res.string.settings_load_notes, controller.inventory!!.diagnostics.size), onClick = { showDiagnostics = !showDiagnostics })
            if (showDiagnostics) controller.inventory?.diagnostics?.forEach { Text(it, style = typography.caption, color = colors.fg3, modifier = Modifier.padding(vertical = 4.dp)) }
        }
    } else {
        SettingsButton(stringResource(Res.string.settings_back_to_extensions), enabled = !controller.busy, onClick = { navigate { controller.clear() } })
        Text("${backendLabel(controller.backend)} · ${controller.profiles.firstOrNull { it.id == controller.profileId }?.name.orEmpty()}", style = typography.caption, color = colors.fg3, modifier = Modifier.padding(top = 8.dp))
        controller.detail?.item?.let { item ->
            SettingsGroup(stringResource(Res.string.settings_extension_info)) {
                SettingsRow(item.name, "${extensionKind(item.kind)} · ${extensionScope(item.scope)}") { item.enabled?.let { Text(if (it) stringResource(Res.string.settings_enabled) else stringResource(Res.string.settings_disabled), style = typography.caption, color = colors.fg3) } }
                item.readOnlyReason?.let { Text(it, style = typography.caption, color = colors.fg3, modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) }
                item.description?.let { Text(it, style = typography.body, color = colors.fg2, modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) }
                item.sourcePath?.let { source -> Column(Modifier.padding(metrics.pageInset)) { Text(stringResource(Res.string.settings_source), style = typography.caption, color = colors.fg3); Spacer(Modifier.height(4.dp)); SelectionContainer { Text(source, style = typography.mono, color = colors.fg2) } } }
                item.ownerPluginId?.let { owner -> SettingsNavigationRow(stringResource(Res.string.settings_owner_plugin), stringResource(Res.string.settings_view_plugin)) { navigate { controller.open(owner) } } }
            }
            val eligible = item.scope in listOf("user", "project") && item.ownerPluginId == null && (item.kind !in listOf("plugin", "mcp") || item.nativeId != null) && (item.kind != "skill" || item.readOnlyReason == null)
            val actions = if (eligible) controller.capabilities?.kinds?.get(item.kind).orEmpty().filter { it != "install" && !(it == "enable" && item.enabled == true) && !(it == "disable" && item.enabled == false) } else emptyList()
            if (actions.isNotEmpty()) {
                SettingsGroup(stringResource(Res.string.settings_extension_management)) { actions.forEach { action ->
                    val actionLabel = extensionAction(action)
                    val confirmNote = if (item.kind == "skill") stringResource(Res.string.settings_extra_ext_confirm_skill_note) else ""
                    val confirmTitle = stringResource(Res.string.settings_extra_ext_confirm_title, actionLabel, item.name) + confirmNote
                    SettingsRow(actionLabel) { SettingsButton(actionLabel, enabled = !controller.busy && !controller.dirty, onClick = { confirmation = confirmTitle to { controller.action(action) } }) }
                } }
            }
        }
        controller.creating?.let { target -> SettingsGroup(stringResource(Res.string.settings_new_extension)) {
            SettingsValueRow(stringResource(Res.string.settings_type), "${extensionKind(target.kind)} · ${extensionScope(target.scope)}")
            Column(Modifier.padding(metrics.pageInset)) { Text(stringResource(Res.string.settings_file_name), style = typography.caption, color = colors.fg3); Spacer(Modifier.height(8.dp)); SettingsField(controller.path, { controller.path = it }, enabled = !controller.busy && target.fileName == null, mono = true) }
        } }
        if (controller.document != null || controller.creating != null) {
            val editable = controller.creating != null || controller.document?.editable == true
            SettingsGroup(if (preview) stringResource(Res.string.settings_save_preview) else stringResource(Res.string.settings_file_content)) {
                if (controller.detail?.files.orEmpty().size > 1) SettingsRow(stringResource(Res.string.settings_config_file)) { ExtensionMenu(stringResource(Res.string.settings_select_file), controller.detail!!.files.map { it.id to it.path }, !controller.busy) { id -> navigate { controller.openFile(id) } } }
                Column(Modifier.padding(metrics.pageInset), verticalArrangement = Arrangement.spacedBy(metrics.sectionGap / 2)) {
                    if (preview && controller.document != null) {
                        Text(stringResource(Res.string.settings_before_save), style = typography.caption, color = colors.fg3)
                        SelectionContainer { Text(controller.document!!.content, style = typography.mono, color = colors.fg3) }
                        Text(stringResource(Res.string.settings_after_save), style = typography.caption, color = colors.fg3)
                    }
                    riffet.ui.design.RiffetTextField(
                        value = controller.text, onValueChange = { controller.text = it },
                        readOnly = !editable || preview || controller.busy, mono = true, singleLine = false,
                        modifier = Modifier.fillMaxWidth().heightIn(min = 240.dp, max = 520.dp),
                    )
                    controller.document?.let { Text(it.reason ?: it.applyEffect, style = typography.caption, color = colors.fg3); it.validationNote?.let { note -> Text(note, style = typography.caption, color = colors.fg3) } }
                    Row(horizontalArrangement = Arrangement.spacedBy(metrics.controlInset / 2)) {
                        if (preview) SettingsButton(stringResource(Res.string.settings_keep_editing), enabled = !controller.busy, onClick = { preview = false })
                        else controller.document?.let { doc -> SettingsButton(stringResource(Res.string.settings_reread), enabled = !controller.busy, onClick = { navigate { controller.openFile(doc.id) } }) }
                        Spacer(Modifier.weight(1f))
                        if (editable) SettingsButton(if (preview) stringResource(Res.string.settings_confirm_save) else stringResource(Res.string.settings_preview_save), enabled = !controller.busy && controller.dirty, primary = true, onClick = { if (preview) controller.save { preview = false } else preview = true })
                    }
                }
            }
        }
    }
    if (controller.creating == null) SettingsGroup(stringResource(Res.string.settings_manage)) {
        if (!inDetail && controller.capabilities?.actions?.contains("install") == true) {
            SettingsRow(stringResource(Res.string.settings_install_plugin)) { SettingsButton(if (showInstall) stringResource(Res.string.settings_cancel) else stringResource(Res.string.settings_install), enabled = !controller.busy, onClick = { showInstall = !showInstall }) }
            AnimatedVisibility(showInstall, enter = motion.expandIn(), exit = motion.collapseOut()) { Column(Modifier.padding(metrics.pageInset), verticalArrangement = Arrangement.spacedBy(metrics.sectionGap / 2)) {
                SettingsField(installTarget, { installTarget = it }, placeholder = "name@marketplace", enabled = !controller.busy)
                val projectInstall = controller.context.projectId != null && controller.capabilities?.installScopes?.contains("project") == true
                val effectiveScope = if (projectInstall) installScope else "user"
                if (projectInstall) ExtensionMenu(extensionScope(installScope), listOf("user" to stringResource(Res.string.settings_user_scope), "project" to stringResource(Res.string.settings_project_scope)), !controller.busy) { installScope = it }
                val installConfirm = stringResource(Res.string.settings_extra_ext_install_confirm, installTarget, extensionScope(effectiveScope))
                SettingsButton(stringResource(Res.string.settings_install_plugin), primary = true, enabled = !controller.busy && installTarget.isNotBlank(), onClick = { confirmation = installConfirm to { controller.action("install", installTarget, effectiveScope) } })
            } }
        }
        SettingsRow(stringResource(Res.string.settings_extension_runtime)) { SettingsButton(stringResource(Res.string.settings_check), enabled = !controller.busy && controller.profileId.isNotEmpty(), onClick = controller::readRuntime) }
        if (controller.capabilities?.actions?.contains("reload") == true) { SettingsRow(stringResource(Res.string.settings_mcp_config)) { SettingsButton(stringResource(Res.string.settings_reload), enabled = !controller.busy && !controller.dirty, onClick = { confirmation = reloadMcpConfirm to { controller.action("reload") } }) } }
    }
    controller.runtime?.let { report ->
        SettingsGroup(stringResource(Res.string.settings_check_results)) {
            report.entries.forEach { entry ->
                SettingsRow(entry.name, extensionRuntimeState(entry.state)) { if (entry.kind == "mcp" && controller.capabilities?.kinds?.get("mcp")?.contains("login") == true) SettingsButton(stringResource(Res.string.settings_authenticate), enabled = !controller.busy && !controller.dirty, onClick = { confirmation = startMcpAuthConfirm to { controller.action("login", entry.name) } }) }
            }
            report.diagnostics.forEach { Text(it, style = typography.caption, color = colors.fg3, modifier = Modifier.padding(metrics.pageInset)) }
        }
    }
    if (pending != null) AlertDialog(onDismissRequest = { pending = null }, title = { Text(stringResource(Res.string.settings_discard_unsaved_title)) }, confirmButton = { RiffetTextButton(onClick = { val next = pending; pending = null; preview = false; next?.invoke() }) { Text(stringResource(Res.string.settings_discard_changes)) } }, dismissButton = { RiffetTextButton(onClick = { pending = null }) { Text(stringResource(Res.string.settings_keep_editing)) } })
    confirmation?.let { request -> AlertDialog(onDismissRequest = { confirmation = null }, title = { Text(request.first) }, text = { Text(stringResource(Res.string.settings_confirmation_note)) }, confirmButton = { RiffetTextButton(onClick = { confirmation = null; request.second() }) { Text(stringResource(Res.string.settings_execute)) } }, dismissButton = { RiffetTextButton(onClick = { confirmation = null }) { Text(stringResource(Res.string.settings_cancel)) } }) }
}

@Composable
private fun ExtensionMenu(label: String, choices: List<Pair<String, String>>, enabled: Boolean, onSelect: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        SettingsButton(label, enabled = enabled && choices.isNotEmpty(), onClick = { open = true })
        RiffetDropdownMenu(expanded = open, onDismissRequest = { open = false }) { choices.forEach { (id, title) -> RiffetMenuItem(title, onClick = { open = false; onSelect(id) }) } }
    }
}

@Composable
private fun extensionKind(value: String): String = when (value) {
    "skill" -> stringResource(Res.string.settings_extra_ext_kind_skill)
    "mcp" -> "MCP"
    "plugin" -> stringResource(Res.string.settings_extra_ext_kind_plugin)
    "hook" -> "Hooks"
    "rule" -> stringResource(Res.string.settings_extra_ext_kind_rule)
    "command" -> stringResource(Res.string.settings_extra_ext_kind_command)
    else -> stringResource(Res.string.settings_extra_ext_kind_config)
}
@Composable
private fun extensionScope(value: String): String = when (value) {
    "user" -> stringResource(Res.string.settings_extra_ext_scope_user)
    "project" -> stringResource(Res.string.settings_extra_ext_scope_project)
    "managed" -> stringResource(Res.string.settings_extra_ext_scope_managed)
    "builtin" -> stringResource(Res.string.settings_extra_ext_scope_builtin)
    else -> value
}
@Composable
private fun extensionAction(value: String): String = when (value) {
    "enable" -> stringResource(Res.string.settings_extra_ext_action_enable)
    "disable" -> stringResource(Res.string.settings_extra_ext_action_disable)
    "uninstall" -> stringResource(Res.string.settings_extra_ext_action_uninstall)
    "update" -> stringResource(Res.string.settings_extra_ext_action_update)
    "login" -> stringResource(Res.string.settings_extra_ext_action_login)
    else -> value
}
@Composable
private fun extensionRuntimeState(value: String): String = when (value) {
    "loaded" -> stringResource(Res.string.settings_extra_ext_runtime_loaded)
    "error" -> stringResource(Res.string.settings_extra_ext_runtime_error)
    "pending" -> stringResource(Res.string.settings_extra_ext_runtime_pending)
    else -> stringResource(Res.string.settings_extra_ext_runtime_unknown)
}
