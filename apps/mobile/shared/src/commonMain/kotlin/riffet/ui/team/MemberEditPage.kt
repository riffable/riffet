package riffet.ui.team

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.stringResource
import riffet.contracts.AgentIds
import riffet.contracts.AgentMember
import riffet.contracts.AgentMemberAvatarInput
import riffet.contracts.AgentMemberCreate
import riffet.contracts.AgentMemberScope
import riffet.contracts.AgentMemberTarget
import riffet.contracts.Project
import riffet.shared.RiffetApi
import riffet.shared.assistantProject
import riffet.shared.assistantSettings
import riffet.shared.isAssistant
import riffet.shared.createTeamMember
import riffet.ui.icons.AgentMark
import riffet.ui.design.GroupField
import riffet.ui.design.GroupRow
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.home.HomeConfigModelSheet
import riffet.ui.home.ProjectPickerSheet
import riffet.ui.home.homeConfigSummary
import riffet.ui.home.rememberMemberConfig
import riffet.ui.settings.EditPage
import riffet.ui.settings.PageBanner
import riffet.ui.settings.SettingsChoiceRow
import riffet.ui.settings.SettingsFootnote
import riffet.ui.settings.SettingsGroup
import riffet.ui.design.agentMarkTint
import androidx.compose.ui.graphics.isSpecified
import riffet.ui.settings.SettingsNoticeKind
import riffet.ui.state.SessionStore
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet_mobile.shared.generated.resources.Res
import riffet_mobile.shared.generated.resources.team_agent_model
import riffet_mobile.shared.generated.resources.team_avatar
import riffet_mobile.shared.generated.resources.team_create
import riffet_mobile.shared.generated.resources.team_footer_web
import riffet_mobile.shared.generated.resources.team_mode_continuous
import riffet_mobile.shared.generated.resources.team_mode_fresh
import riffet_mobile.shared.generated.resources.team_name
import riffet_mobile.shared.generated.resources.team_new_member
import riffet_mobile.shared.generated.resources.team_project
import riffet_mobile.shared.generated.resources.team_role
import riffet_mobile.shared.generated.resources.team_role_footer
import riffet_mobile.shared.generated.resources.team_fact_scope
import riffet_mobile.shared.generated.resources.team_scope_global
import riffet_mobile.shared.generated.resources.team_scope_personal
import riffet_mobile.shared.generated.resources.team_scope_project
import riffet_mobile.shared.generated.resources.team_session_mode
import riffet_mobile.shared.generated.resources.app_operation_failed

private val Emoji = listOf("🙂", "🤖", "💻", "🛠️", "📦", "🔍", "📈", "📚", "🧪", "🎨", "📝", "🧭", "🚀", "🧠", "🦉", "🐴")

/**
 * 新建成员 (mobile.md §2.3, §9.12): avatar, name, role, scope, how its conversations go and its Agent. What the
 * scope implies (capabilities, the daily run limit) takes the server's defaults and is changed on the web.
 */
@OptIn(ExperimentalLayoutApi::class, ExperimentalFoundationApi::class)
@Composable
internal fun MemberEditPage(
    store: SessionStore,
    api: RiffetApi?,
    onBack: () -> Unit,
    onCreated: (AgentMember) -> Unit,
) {
    val list by store.list.collectAsState()
    val scope = rememberCoroutineScope()
    val colors = LocalRiffetColors.current
    val metrics = LocalInterfaceStyle.current.metrics
    var emoji by remember { mutableStateOf(Emoji.first()) }
    var picking by remember { mutableStateOf(false) }
    var name by remember { mutableStateOf("") }
    var role by remember { mutableStateOf("") }
    var scopeKind by remember { mutableStateOf("personal") }
    var projectId by remember { mutableStateOf<String?>(null) }
    var modeChoice by remember { mutableStateOf<String?>(null) }
    var projectSheet by remember { mutableStateOf(false) }
    var modelSheet by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val failed = stringResource(Res.string.app_operation_failed)

    val projects = remember(list.projects) {
        list.projects.filter { it.archivedAt == null && !it.isAssistant && it.system != "task-workspace" && it.worktree == null }
    }
    val project: Project? = projects.firstOrNull { it.id == projectId } ?: projects.firstOrNull().takeIf { scopeKind == "project" }
    // Fresh by default for a project's member, which is a place to run things; continuous for the rest.
    val mode = modeChoice ?: if (scopeKind == "project") "fresh" else "continuous"

    // The catalog is read against the project the member would start in.
    val config = rememberMemberConfig(api, "new-member")
    val catalogProject = if (scopeKind == "project") project?.id else assistantProject(list.projects)?.id
    val settings = remember(list.settings, config.backends) { assistantSettings(list.settings, config.backends) }
    LaunchedEffect(config, catalogProject, settings, list.backendRevision) {
        catalogProject?.let { config.sync(it, settings, list.backendRevision) }
    }

    fun create() {
        val client = api ?: return
        if (busy) return
        busy = true
        error = null
        scope.launch {
            try {
                val made = client.createTeamMember(
                    AgentMemberCreate(
                        name = name.trim(),
                        avatar = AgentMemberAvatarInput("emoji", emoji),
                        instructions = role.trim().takeIf { it.isNotEmpty() },
                        scope = AgentMemberScope(scopeKind, projectIds = if (scopeKind == "project") listOfNotNull(project?.id) else null),
                        sessionMode = mode,
                        target = AgentMemberTarget(
                            backendId = AgentIds.wire(config.backendId),
                            profileId = config.profileId,
                            model = config.model.takeIf { it.isNotBlank() },
                        ),
                    ),
                )
                store.applyTeamMember(made)
                onCreated(made)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (failure: Throwable) {
                error = failure.message?.takeIf { it.isNotBlank() } ?: failed
            } finally {
                busy = false
            }
        }
    }

    EditPage(
        title = stringResource(Res.string.team_new_member),
        onBack = onBack,
        dirty = name.isNotBlank() || role.isNotBlank(),
        busy = busy,
        onSave = ::create,
        canSave = name.isNotBlank() && api != null && (scopeKind != "project" || project != null),
        saveLabel = stringResource(Res.string.team_create),
    ) {
        error?.let { PageBanner(it, SettingsNoticeKind.ERROR) }
        val avatarLabel = stringResource(Res.string.team_avatar)
        Box(Modifier.fillMaxWidth().padding(top = metrics.controlInset), contentAlignment = Alignment.Center) {
            Box(
                Modifier.size(80.dp).clip(CircleShape).background(colors.bgActive)
                    .clickable(role = Role.Button, onClickLabel = avatarLabel) { picking = !picking },
                contentAlignment = Alignment.Center,
            ) { Text(emoji, style = LocalRiffetTypography.current.headline.copy(fontSize = 40.sp, lineHeight = 48.sp)) }
        }
        if (picking) SettingsGroup("") {
            FlowRow(
                Modifier.fillMaxWidth().padding(metrics.controlInset),
                horizontalArrangement = Arrangement.spacedBy(metrics.controlInset / 2),
                verticalArrangement = Arrangement.spacedBy(metrics.controlInset / 2),
            ) {
                Emoji.forEach { option ->
                    Box(
                        Modifier.size(metrics.controlHeight).clip(CircleShape)
                            .background(if (option == emoji) colors.bgActive else androidx.compose.ui.graphics.Color.Transparent)
                            .clickable(role = Role.Button) { emoji = option; picking = false },
                        contentAlignment = Alignment.Center,
                    ) { Text(option, style = LocalRiffetTypography.current.headline) }
                }
            }
        }
        SettingsGroup("") { GroupField(value = name, onValueChange = { name = it }, placeholder = stringResource(Res.string.team_name), enabled = !busy) }
        SettingsGroup(stringResource(Res.string.team_role)) {
            GroupField(value = role, onValueChange = { role = it }, singleLine = false, minLines = 4, enabled = !busy)
        }
        SettingsFootnote(stringResource(Res.string.team_role_footer))
        SettingsGroup("") {
            SettingsChoiceRow(
                title = stringResource(Res.string.team_fact_scope),
                options = listOf(
                    "personal" to stringResource(Res.string.team_scope_personal),
                    "project" to stringResource(Res.string.team_scope_project),
                    "global" to stringResource(Res.string.team_scope_global),
                ),
                value = scopeKind, enabled = !busy,
                onSelect = { scopeKind = it },
            )
            if (scopeKind == "project") GroupRow(
                title = stringResource(Res.string.team_project), value = project?.name, chevron = true, enabled = !busy,
                onClick = { projectSheet = true },
            )
            SettingsChoiceRow(
                title = stringResource(Res.string.team_session_mode),
                options = listOf("continuous" to stringResource(Res.string.team_mode_continuous), "fresh" to stringResource(Res.string.team_mode_fresh)),
                value = mode, enabled = !busy,
                onSelect = { modeChoice = it },
            )
            // The summary (model, effort, profile) runs long: under the title rather than squeezing it. The mark goes at
            // the end so the card's dividers keep one inset.
            GroupRow(
                title = stringResource(Res.string.team_agent_model),
                subtitle = homeConfigSummary(config),
                trailing = { AgentMark(config.backendId.name.lowercase(), size = metrics.iconSize, tint = colors.agentMarkTint(config.backendId.name.lowercase())?.takeIf { it.isSpecified } ?: colors.fg2) },
                chevron = true,
                enabled = !busy && catalogProject != null,
                onClick = { modelSheet = true },
            )
        }
        SettingsFootnote(stringResource(Res.string.team_footer_web))
    }

    if (projectSheet) ProjectPickerSheet(
        projects = projects, selectedId = project?.id,
        onSelect = { picked -> if (picked != null) projectId = picked.id },
        onDismiss = { projectSheet = false },
    )
    val target = catalogProject
    if (modelSheet && target != null) HomeConfigModelSheet(config, target, settings, onDismiss = { modelSheet = false })
}
