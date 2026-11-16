package riffet.shared

import riffet.contracts.AppSettings
import riffet.contracts.AssistantSettings
import riffet.contracts.NativeBackendCatalogEntry
import riffet.contracts.NativeBackendDefaults
import riffet.contracts.NativeBackendId
import riffet.contracts.Project
import riffet.contracts.Session

/** The assistant's project, once the server has made it. */
fun assistantProject(projects: List<Project>): Project? = projects.firstOrNull { it.isAssistant && it.archivedAt == null }

/**
 * The one long conversation (docs/ASSISTANT.md §3): the project's `mainSessionId`, unless it names a
 * session that is gone or archived, which counts as none.
 */
fun assistantMain(project: Project?, sessions: List<Session>): Session? {
    val id = project?.mainSessionId ?: return null
    return sessions.firstOrNull { it.id == id && it.projectId == project.id && it.archivedAt == null }
}

/**
 * The agent the assistant's composer starts with, `assistantChoice` of `packages/contracts`: the saved
 * choice while its agent is still offered, else Claude Code where it can run. A saved provider that is
 * gone falls back to the agent's default one, and its model with it.
 */
fun assistantChoice(saved: AssistantSettings?, backends: List<NativeBackendCatalogEntry>): AssistantChoice? {
    val backend = saved?.backendId?.let { id -> backends.firstOrNull { it.backendId == id } }
        ?: backends.firstOrNull { it.backendId == NativeBackendId.CLAUDE && it.available }
        ?: return null
    val kept = saved?.profileId == null || backend.profiles.any { it.id == saved.profileId }
    return AssistantChoice(backend.backendId, saved?.profileId.takeIf { kept }, saved?.model.takeIf { kept })
}

/** [settings] with the assistant's choice standing in for the agent's own, as the composer reads them; null while unread. */
fun assistantSettings(settings: AppSettings?, backends: List<NativeBackendCatalogEntry>): AppSettings? {
    settings ?: return null
    val saved = settings.assistant
    // Before the agent list is read, the saved agent or Claude Code, so the first catalog read is the right one.
    val choice = assistantChoice(saved, backends) ?: AssistantChoice(saved?.backendId ?: NativeBackendId.CLAUDE, saved?.profileId, saved?.model)
    return settings.withAssistantChoice(choice)
}

class AssistantChoice(val backendId: NativeBackendId, val profileId: String?, val model: String?)

/** The settings a composer reads its opening model from, with the assistant's choice in the agent's place. */
fun AppSettings.withAssistantChoice(choice: AssistantChoice): AppSettings {
    val saved = nativeBackendDefaults?.get(choice.backendId)
    val replaced = (saved ?: NativeBackendDefaults()).copy(profileId = choice.profileId, model = choice.model)
    return copy(defaultBackendId = choice.backendId, nativeBackendDefaults = (nativeBackendDefaults ?: emptyMap()) + (choice.backendId to replaced))
}

