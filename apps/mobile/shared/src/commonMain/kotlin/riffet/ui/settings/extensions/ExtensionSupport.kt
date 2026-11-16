package riffet.ui.settings.extensions

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.ui.unit.dp
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.getString
import org.jetbrains.compose.resources.stringResource
import riffet.contracts.ExtensionActionRequest
import riffet.contracts.ExtensionContext
import riffet.contracts.ExtensionCreateTarget
import riffet.ui.icons.Icon
import riffet.shared.RiffetApi
import riffet.shared.extensionAction
import riffet.ui.app.RiffetSnackbar
import riffet.ui.design.IconTile
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.SettingsIconPresentation
import riffet.ui.icons.RiffetIcons
import riffet.ui.theme.LocalRiffetColors
import riffet_mobile.shared.generated.resources.*

/** The pages above the extension directory. Each is its own page of the nested stack. */
internal sealed interface ExtRoute {
    data object Directory : ExtRoute
    data class Detail(val itemId: String) : ExtRoute
    data class Editor(val documentId: String) : ExtRoute
    data class Create(val target: ExtensionCreateTarget) : ExtRoute
    data object Install : ExtRoute
    data object Runtime : ExtRoute
    data object Diagnostics : ExtRoute
}

internal val extensionKindOrder = listOf("skill", "mcp", "plugin", "hook", "rule", "command", "config")

@Composable
internal fun extensionKind(value: String): String = when (value) {
    "skill" -> stringResource(Res.string.settings_extra_ext_kind_skill)
    "mcp" -> "MCP"
    "plugin" -> stringResource(Res.string.settings_extra_ext_kind_plugin)
    "hook" -> "Hooks"
    "rule" -> stringResource(Res.string.settings_extra_ext_kind_rule)
    "command" -> stringResource(Res.string.settings_extra_ext_kind_command)
    else -> stringResource(Res.string.settings_extra_ext_kind_config)
}

@Composable
internal fun extensionScope(value: String): String = when (value) {
    "user" -> stringResource(Res.string.settings_extra_ext_scope_user)
    "project" -> stringResource(Res.string.settings_extra_ext_scope_project)
    "managed" -> stringResource(Res.string.settings_extra_ext_scope_managed)
    "builtin" -> stringResource(Res.string.settings_extra_ext_scope_builtin)
    "riffet" -> "Riffet"
    else -> value
}

@Composable
internal fun extensionAction(value: String): String = when (value) {
    "enable" -> stringResource(Res.string.settings_extra_ext_action_enable)
    "disable" -> stringResource(Res.string.settings_extra_ext_action_disable)
    "uninstall" -> stringResource(Res.string.settings_extra_ext_action_uninstall)
    "update" -> stringResource(Res.string.settings_extra_ext_action_update)
    "login" -> stringResource(Res.string.settings_extra_ext_action_login)
    else -> value
}

/** Null when the state says nothing worth showing. */
@Composable
internal fun extensionRuntimeState(value: String): String? = when (value) {
    "", "unknown" -> null
    "loaded" -> stringResource(Res.string.settings_extra_ext_runtime_loaded)
    "error" -> stringResource(Res.string.settings_extra_ext_runtime_error)
    "pending" -> stringResource(Res.string.settings_extra_ext_runtime_pending)
    else -> value
}

internal fun extensionGlyph(kind: String): ImageVector = when (kind) {
    "skill" -> RiffetIcons.Zap
    "mcp" -> RiffetIcons.Link
    "plugin" -> RiffetIcons.Puzzle
    "hook" -> RiffetIcons.Wrench
    "rule" -> RiffetIcons.Pencil
    "command" -> RiffetIcons.Terminal
    else -> RiffetIcons.FileText
}

/** The leading mark of an extension row, in the same presentation the settings rows use. */
@Composable
internal fun ExtensionIcon(kind: String) {
    val style = LocalInterfaceStyle.current
    val colors = LocalRiffetColors.current
    if (style.variants.settingsIcons == SettingsIconPresentation.TONAL) IconTile(extensionGlyph(kind), colors.accent)
    else Icon(extensionGlyph(kind), null, Modifier.size(style.metrics.iconSize), colors.fg2)
}

/**
 * One server action at a time on a page. A success is reported through the snackbar; a failure stays
 * on the page, with the server's output only then.
 */
internal class ExtensionActionRunner(
    private val api: RiffetApi,
    private val scope: CoroutineScope,
    private val snackbar: RiffetSnackbar?,
) {
    var busy by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var authorization by mutableStateOf<String?>(null)

    fun run(context: ExtensionContext, request: ExtensionActionRequest, onSuccess: () -> Unit = {}) {
        if (busy) return
        busy = true; error = null; authorization = null
        scope.launch {
            try {
                val response = api.extensionAction(context, request)
                authorization = response.authorizationUrl?.takeIf { it.startsWith("https://", true) || it.startsWith("http://", true) }
                if (response.success) {
                    if (response.applyEffect.isNotBlank()) snackbar?.show(response.applyEffect)
                    onSuccess()
                } else {
                    error = response.diagnostics?.joinToString("\n")?.takeIf { it.isNotBlank() } ?: response.output?.takeIf { it.isNotBlank() }
                        ?: getString(Res.string.settings_extra_ext_action_failed)
                }
            } catch (cancel: CancellationException) { throw cancel }
            catch (failure: Throwable) { error = failure.message ?: getString(Res.string.settings_extra_ext_action_failed) }
            finally { busy = false }
        }
    }
}

/** Whole-page loading: a spinner in the middle, no words. */
@Composable
internal fun CenteredSpinner() {
    androidx.compose.foundation.layout.Box(
        Modifier.fillMaxWidth().padding(vertical = LocalInterfaceStyle.current.metrics.sectionGap * 3),
        contentAlignment = androidx.compose.ui.Alignment.Center,
    ) { riffet.ui.timeline.Spinner(size = 24.dp) }
}
