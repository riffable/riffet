package riffet.ui.settings.extensions

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.getString
import org.jetbrains.compose.resources.stringResource
import riffet.contracts.ExtensionActionRequest
import riffet.contracts.ExtensionCreateTarget
import riffet.contracts.ExtensionDocument
import riffet.shared.createExtensionDocument
import riffet.shared.extensionAction
import riffet.shared.extensionDocument
import riffet.shared.saveExtensionDocument
import riffet.ui.app.LocalPageBack
import riffet.ui.app.LocalRiffetSnackbar
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.GroupField
import riffet.ui.design.RiffetTextField
import riffet.ui.settings.EditPage
import riffet.ui.settings.ExtensionsController
import riffet.ui.settings.PageBanner
import riffet.ui.settings.SettingsChoiceRow
import riffet.ui.settings.SettingsField
import riffet.ui.settings.SettingsFootnote
import riffet.ui.settings.SettingsGroup
import riffet.ui.settings.SettingsNoticeKind
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet_mobile.shared.generated.resources.*

/** Leave after a save: the guard has nothing left to ask, and recomposition has not told it yet. */
@Composable
private fun rememberLeaveAfterSave(onBack: () -> Unit): () -> Unit {
    val pageBack = LocalPageBack.current
    return { pageBack?.leaveConfirmed() ?: onBack() }
}

/** The code editor takes most of the page's height; the page itself scrolls beneath it on short screens. */
@Composable
private fun Modifier.editorHeight(): Modifier {
    val density = LocalDensity.current
    val height = with(density) { LocalWindowInfo.current.containerSize.height.toDp() }
    return this.fillMaxWidth().heightIn(min = height * 0.55f)
}

@Composable
internal fun ExtensionEditorPage(controller: ExtensionsController, documentId: String, onBack: () -> Unit) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val scope = rememberCoroutineScope()
    val snackbar = LocalRiffetSnackbar.current
    val leave = rememberLeaveAfterSave(onBack)
    var document by remember(documentId) { mutableStateOf<ExtensionDocument?>(null) }
    var text by remember(documentId) { mutableStateOf("") }
    var busy by remember(documentId) { mutableStateOf(true) }
    var error by remember(documentId) { mutableStateOf<String?>(null) }
    var loadFailed by remember(documentId) { mutableStateOf(false) }
    LaunchedEffect(documentId) {
        try { val loaded = controller.api.extensionDocument(controller.context, documentId); document = loaded; text = loaded.content }
        catch (cancel: CancellationException) { throw cancel }
        catch (failure: Throwable) { loadFailed = true; error = failure.message ?: getString(Res.string.settings_extra_ext_action_failed) }
        finally { busy = false }
    }
    val loaded = document
    val editable = loaded?.editable == true
    EditPage(
        title = if (loaded == null || editable) stringResource(Res.string.ext_edit_title) else stringResource(Res.string.ext_view_title),
        onBack = onBack,
        dirty = loaded != null && editable && text != loaded.content,
        busy = busy,
        canSave = loaded != null && editable && text != loaded.content,
        onSave = {
            val target = loaded ?: return@EditPage
            busy = true; error = null
            scope.launch {
                try {
                    val saved = controller.api.saveExtensionDocument(controller.context, target.id, text, target.contentHash)
                    document = saved; text = saved.content
                    if (saved.applyEffect.isNotBlank()) snackbar?.show(saved.applyEffect)
                    controller.refreshQuietly()
                    leave()
                } catch (cancel: CancellationException) { throw cancel }
                catch (failure: Throwable) { error = (failure.message ?: getString(Res.string.settings_extra_ext_action_failed)) + "\n" + getString(Res.string.ext_save_failed_hint) }
                finally { busy = false }
            }
        },
    ) {
        if (loaded != null) {
            SelectionContainer { Text(loaded.path, style = typography.monoSmall, color = colors.fg3, modifier = Modifier.padding(bottom = metrics.rowPadding / 2)) }
            RiffetTextField(
                value = text, onValueChange = { text = it }, mono = true, singleLine = false,
                readOnly = !editable || busy, modifier = Modifier.editorHeight(),
            )
            val notes = listOfNotNull(loaded.reason, loaded.validationNote, loaded.applyEffect).filter { it.isNotBlank() }.joinToString(" ")
            if (notes.isNotEmpty()) Text(notes, style = typography.caption, color = colors.fg3, modifier = Modifier.padding(top = metrics.rowPadding / 2))
        }
        error?.let { message ->
            SelectionContainer { Text(message, style = typography.caption, color = colors.danger, modifier = Modifier.padding(top = metrics.rowPadding / 2)) }
        }
        if (loaded == null && !loadFailed) CenteredSpinner()
    }
}

@Composable
internal fun ExtensionCreatePage(controller: ExtensionsController, target: ExtensionCreateTarget, onBack: () -> Unit) {
    val metrics = LocalInterfaceStyle.current.metrics
    val scope = rememberCoroutineScope()
    val snackbar = LocalRiffetSnackbar.current
    val leave = rememberLeaveAfterSave(onBack)
    val skillTemplate = stringResource(Res.string.settings_extra_ext_template_skill)
    val instructionsTemplate = stringResource(Res.string.settings_extra_ext_template_instructions)
    val initialPath = remember(target) {
        listOf(target.directory, if (target.kind == "skill") "my-skill/SKILL.md" else target.fileName ?: "my-extension.md").filter { it.isNotEmpty() }.joinToString("/")
    }
    val initialContent = remember(target, skillTemplate, instructionsTemplate) {
        target.template ?: when (target.kind) {
            "skill" -> skillTemplate
            "mcp" -> "{\n  \"mcpServers\": {}\n}\n"
            "hook" -> "{}\n"
            else -> instructionsTemplate
        }
    }
    var path by remember(target) { mutableStateOf(initialPath) }
    var content by remember(target) { mutableStateOf(initialContent) }
    var busy by remember(target) { mutableStateOf(false) }
    var error by remember(target) { mutableStateOf<String?>(null) }
    EditPage(
        title = stringResource(Res.string.ext_new_title, extensionKind(target.kind)),
        onBack = onBack,
        dirty = path != initialPath || content != initialContent,
        busy = busy,
        canSave = path.isNotBlank(),
        saveLabel = stringResource(Res.string.ext_create),
        onSave = {
            busy = true; error = null
            scope.launch {
                try {
                    val saved = controller.api.createExtensionDocument(controller.context, target.id, path, content)
                    if (saved.applyEffect.isNotBlank()) snackbar?.show(saved.applyEffect)
                    controller.refreshQuietly()
                    leave()
                } catch (cancel: CancellationException) { throw cancel }
                catch (failure: Throwable) { error = failure.message ?: getString(Res.string.settings_extra_ext_action_failed) }
                finally { busy = false }
            }
        },
    ) {
        error?.let { PageBanner(it, SettingsNoticeKind.ERROR) }
        SettingsGroup(stringResource(Res.string.ext_path)) {
            GroupField(path, { path = it }, enabled = !busy && target.fileName == null, mono = true)
        }
        if (target.directory.isNotEmpty()) SelectionContainer { SettingsFootnote(extensionScope(target.scope) + " · " + target.directory) }
        SettingsGroup(stringResource(Res.string.ext_content)) {
            GroupField(value = content, onValueChange = { content = it }, mono = true, singleLine = false, minLines = 12, enabled = !busy)
        }
    }
}

@Composable
internal fun ExtensionInstallPage(controller: ExtensionsController, onBack: () -> Unit) {
    val metrics = LocalInterfaceStyle.current.metrics
    val scope = rememberCoroutineScope()
    val snackbar = LocalRiffetSnackbar.current
    val leave = rememberLeaveAfterSave(onBack)
    var target by remember { mutableStateOf("") }
    var installScope by remember { mutableStateOf("user") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val projectInstall = controller.context.projectId != null && controller.capabilities?.installScopes?.contains("project") == true
    val effectiveScope = if (projectInstall) installScope else "user"
    EditPage(
        title = stringResource(Res.string.ext_install_title),
        onBack = onBack,
        dirty = target.isNotBlank(),
        busy = busy,
        canSave = target.isNotBlank(),
        saveLabel = stringResource(Res.string.ext_install),
        onSave = {
            busy = true; error = null
            scope.launch {
                try {
                    val response = controller.api.extensionAction(controller.context, ExtensionActionRequest("install", null, target.trim(), effectiveScope))
                    if (response.success) {
                        if (response.applyEffect.isNotBlank()) snackbar?.show(response.applyEffect)
                        controller.refreshQuietly()
                        leave()
                    } else {
                        error = response.diagnostics?.joinToString("\n")?.takeIf { it.isNotBlank() } ?: response.output?.takeIf { it.isNotBlank() }
                            ?: getString(Res.string.settings_extra_ext_action_failed)
                    }
                } catch (cancel: CancellationException) { throw cancel }
                catch (failure: Throwable) { error = failure.message ?: getString(Res.string.settings_extra_ext_action_failed) }
                finally { busy = false }
            }
        },
    ) {
        error?.let { PageBanner(it, SettingsNoticeKind.ERROR) }
        SettingsGroup("") {
            GroupField(target, { target = it }, placeholder = stringResource(Res.string.ext_install_placeholder), enabled = !busy)
        }
        if (projectInstall) {
            SettingsGroup("") {
                SettingsChoiceRow(
                    stringResource(Res.string.ext_install_scope),
                    listOf("user" to stringResource(Res.string.settings_extra_ext_scope_user), "project" to stringResource(Res.string.settings_extra_ext_scope_project)),
                    installScope, enabled = !busy,
                ) { installScope = it }
            }
        }
    }
}
