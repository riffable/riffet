package riffet.ui.settings

import androidx.compose.foundation.layout.Box
import androidx.compose.material3.Text
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import org.jetbrains.compose.resources.stringResource
import riffet.contracts.AppSettingsUpdate
import riffet.contracts.NativeBackendDefaults
import riffet.contracts.NativeBackendId
import riffet.ui.app.PageBarAction
import riffet.ui.design.GroupRow
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.icons.AgentMark
import riffet.ui.icons.AgentMarks
import riffet.ui.icons.RiffetIcons
import riffet.ui.icons.Icon
import riffet.ui.settings.providers.AddProviderPage
import riffet.ui.settings.providers.ProviderEditorPage
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet.ui.timeline.Spinner
import riffet_mobile.shared.generated.resources.*
import kotlin.random.Random
import riffet.ui.design.agentMarkTint

/*
 * Agent backends: one CLI at a time, one provider card at a time, exactly the shape of the web's
 * `BackendProfilesSection.tsx`. Cursor is the exception the server enforces: it has a single
 * built-in `default` profile, cannot curate its model list, and carries an extra `agentEndpoint`.
 */

private val backendOrder = listOf(
    NativeBackendId.CURSOR,
    NativeBackendId.CODEX,
    NativeBackendId.CLAUDE,
    NativeBackendId.DSH,
    NativeBackendId.DROID,
    NativeBackendId.TRAEX,
    NativeBackendId.PI,
    NativeBackendId.ANTIGRAVITY,
)

internal fun backendLabel(id: NativeBackendId): String = when (id) {
    NativeBackendId.CURSOR -> "Cursor"
    NativeBackendId.CODEX -> "Codex"
    NativeBackendId.CLAUDE -> "Claude"
    NativeBackendId.DSH -> "DeepSeek"
    NativeBackendId.DROID -> "Droid"
    NativeBackendId.TRAEX -> "TRAE CLI"
    NativeBackendId.PI -> "pi"
    NativeBackendId.ANTIGRAVITY -> "Antigravity"
    NativeBackendId.CHAT -> "Quick chat"
}

/** Droid and TRAE CLI sign in on their own, so neither has a service address. Only Droid also hides the config directory. */
internal fun hasEndpoint(id: NativeBackendId): Boolean = id != NativeBackendId.DROID && id != NativeBackendId.TRAEX

internal fun hasConfigDir(id: NativeBackendId): Boolean = id != NativeBackendId.DROID && id != NativeBackendId.ANTIGRAVITY

@Composable
internal fun endpointPlaceholder(id: NativeBackendId): String = when (id) {
    NativeBackendId.CLAUDE -> "https://gateway.example.com"
    NativeBackendId.CODEX -> "https://gateway.example.com/v1"
    NativeBackendId.DSH -> "https://api.deepseek.com"
    NativeBackendId.DROID -> stringResource(Res.string.settings_extra_endpoint_placeholder_droid)
    NativeBackendId.TRAEX -> stringResource(Res.string.settings_extra_endpoint_placeholder_traex)
    NativeBackendId.CURSOR -> stringResource(Res.string.settings_extra_endpoint_placeholder_cursor)
    NativeBackendId.PI -> "https://"
    NativeBackendId.ANTIGRAVITY -> "https://"
    NativeBackendId.CHAT -> ""
}

@Composable
internal fun endpointHint(id: NativeBackendId): String? = when (id) {
    NativeBackendId.CLAUDE -> stringResource(Res.string.settings_extra_endpoint_hint_claude)
    NativeBackendId.CODEX -> stringResource(Res.string.settings_extra_endpoint_hint_codex)
    NativeBackendId.DSH -> stringResource(Res.string.settings_extra_endpoint_hint_dsh)
    NativeBackendId.DROID -> stringResource(Res.string.settings_extra_endpoint_hint_droid)
    NativeBackendId.TRAEX -> stringResource(Res.string.settings_extra_endpoint_hint_traex)
    NativeBackendId.CURSOR -> null
    NativeBackendId.PI -> null
    NativeBackendId.ANTIGRAVITY -> null
    NativeBackendId.CHAT -> null
}

/** The wire APIs pi can speak, in the order the editor offers them. */
internal val apiProtocols = listOf(
    "openai-completions" to "OpenAI Chat Completions",
    "openai-responses" to "OpenAI Responses",
    "anthropic-messages" to "Anthropic Messages",
    "google-generative-ai" to "Google Gemini",
)

internal const val DEFAULT_API_PROTOCOL = "openai-completions"

/** A profile id the server accepts (`[A-Za-z0-9][A-Za-z0-9._-]{0,99}`), generated client-side. */
internal fun newProfileId(): String = "p" + Random.nextLong().toULong().toString(36) + Random.nextLong().toULong().toString(36).take(8)

@Composable
internal fun BackendsSection(controller: SettingsController, onSelect: (NativeBackendId) -> Unit) {
    val state by controller.state.collectAsState()
    val settings = state.settings ?: return
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    SettingsGroup(stringResource(Res.string.settings_agent_backends)) {
        backendOrder.forEach { id ->
            val isDefault = (settings.defaultBackendId ?: NativeBackendId.CURSOR) == id
            // The mark sits bare in its own colour, not on a coloured tile.
            SettingsLinkRow(
                title = backendLabel(id),
                subtitle = if (isDefault) stringResource(Res.string.settings_new_session_default) else null,
                leading = AgentMarks.vector(id.name.lowercase())?.let { { AgentMark(backendId = id.name.lowercase(), size = 20.dp, tint = colors.agentMarkTint(id.name) ?: colors.fg2) } },
                onClick = { onSelect(id) },
            )
        }
    }
    SettingsFootnote(stringResource(Res.string.settings_backend_save_note))
    SettingsGroup(stringResource(Res.string.settings_new_session)) {
        DefaultApprovalRow(controller, settings.defaultBackendId ?: NativeBackendId.CURSOR)
    }
}

/** Same-provider changes preserve overrides; another provider gets its own model/mode defaults. */
internal fun defaultProfilePatch(settings: riffet.contracts.AppSettings, backendId: NativeBackendId, profileId: String): AppSettingsUpdate {
    val defaults = settings.nativeBackendDefaults.orEmpty()
    return AppSettingsUpdate(
        defaultBackendId = backendId,
        nativeBackendDefaults = defaults + (backendId to (defaults[backendId]?.takeIf { it.profileId == profileId } ?: NativeBackendDefaults()).copy(profileId = profileId)),
    )
}

/** A backend's providers (a directory page). */
@Composable
internal fun BackendProfilesPage(controller: SettingsController, backend: NativeBackendId, onBack: () -> Unit, onEdit: (String) -> Unit, onAdd: () -> Unit) {
    val state by controller.state.collectAsState()
    val settings = state.settings
    val loading = state.profilesLoading[backend] == true
    val profiles = state.profileLists[backend]
    val colors = LocalRiffetColors.current
    LaunchedEffect(controller, backend) { controller.loadProfiles(backend) }
    val setDefaultMessage = stringResource(Res.string.settings_set_as_default_done)
    SettingsPage(
        backendLabel(backend), onBack,
        refreshing = loading && profiles != null,
        onRefresh = { controller.loadProfiles(backend) },
        actions = {
            if (backend != NativeBackendId.CURSOR && hasEndpoint(backend)) {
                PageBarAction(RiffetIcons.Plus, stringResource(Res.string.settings_add_provider), onAdd, enabled = !state.saving)
            }
        },
    ) {
        ControllerMessages(controller)
        state.profilesErrors[backend]?.let { message ->
            PageBanner(message, SettingsNoticeKind.ERROR, stringResource(Res.string.settings_retry)) { controller.loadProfiles(backend) }
        }
        val defaultId = defaultProfileId(state, backend)
        when {
            profiles == null -> if (loading) Box(Modifier.fillMaxWidth().padding(vertical = 40.dp), contentAlignment = Alignment.Center) { Spinner(size = 20.dp) }
            profiles.isEmpty() -> Text(stringResource(Res.string.settings_no_providers), style = LocalRiffetTypography.current.bodySmall, color = colors.fg3, modifier = Modifier.padding(LocalInterfaceStyle.current.metrics.pageInset))
            else -> SettingsGroup(stringResource(Res.string.settings_provider)) {
                profiles.forEach { profile ->
                    GroupRow(
                        title = profile.name,
                        subtitle = profile.apiEndpoint ?: stringResource(Res.string.settings_cli_builtin_login),
                        value = if (profile.id == defaultId) stringResource(Res.string.settings_default) else null,
                        chevron = true,
                        onClick = { onEdit(profile.id) },
                    )
                }
            }
        }
        if (settings != null && defaultId != null) {
            val isDefaultBackend = (settings.defaultBackendId ?: NativeBackendId.CURSOR) == backend
            SettingsGroup(stringResource(Res.string.settings_new_session)) {
                if (isDefaultBackend) {
                    GroupRow(title = stringResource(Res.string.settings_current_backend, backendLabel(backend)), trailing = { Icon(RiffetIcons.Check, null, tint = colors.accent) })
                } else {
                    SettingsActionRow(stringResource(Res.string.settings_set_as_default), enabled = !state.saving, onClick = {
                        controller.saveSettings(defaultProfilePatch(settings, backend, defaultId), setDefaultMessage)
                    })
                }
                DefaultApprovalRow(controller, backend)
            }
        }
    }
}

/** One provider's settings. */
@Composable
internal fun BackendProfilePage(controller: SettingsController, backend: NativeBackendId, id: String, onBack: () -> Unit, onDeleted: () -> Unit) {
    ProviderEditorPage(controller, backend, id, onBack, onDeleted)
}

/** A new provider for [backend]. */
@Composable
internal fun AddProfilePage(controller: SettingsController, backend: NativeBackendId, onBack: () -> Unit, onCreated: () -> Unit) {
    AddProviderPage(controller, backend, onBack, onCreated)
}
