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
 * The agents the assistant runs on, first the one it starts on: those that launch it isolated from the
 * owner's own configuration, `ASSISTANT_BACKENDS` of `packages/contracts`.
 */
val ASSISTANT_BACKENDS = listOf(NativeBackendId.CLAUDE, NativeBackendId.CODEX)

fun isAssistantBackend(id: NativeBackendId): Boolean = id in ASSISTANT_BACKENDS

/**
 * The agent the assistant's composer starts with, `assistantChoice` of `packages/contracts`: the saved
 * choice while its agent is still offered and one it runs on, else the first of [ASSISTANT_BACKENDS] that
 * can run. A saved provider that is gone falls back to the agent's default one, and its model with it.
 */
fun assistantChoice(saved: AssistantSettings?, backends: List<NativeBackendCatalogEntry>): AssistantChoice? {
    val backend = saved?.backendId?.takeIf { it in ASSISTANT_BACKENDS }?.let { id -> backends.firstOrNull { it.backendId == id } }
        ?: ASSISTANT_BACKENDS.firstNotNullOfOrNull { id -> backends.firstOrNull { it.backendId == id && it.available } }
        ?: return null
    // A saved provider and model belong to the saved agent only.
    val kept = backend.backendId == saved?.backendId && (saved.profileId == null || backend.profiles.any { it.id == saved.profileId })
    return AssistantChoice(backend.backendId, saved?.profileId.takeIf { kept }, saved?.model.takeIf { kept })
}

/** [settings] with the assistant's choice standing in for the agent's own, as the composer reads them; null while unread. */
fun assistantSettings(settings: AppSettings?, backends: List<NativeBackendCatalogEntry>): AppSettings? {
    settings ?: return null
    val saved = settings.assistant
    // Before the agent list is read, the saved agent or Claude Code, so the first catalog read is the right one.
    val choice = assistantChoice(saved, backends)
        ?: saved?.backendId?.takeIf { it in ASSISTANT_BACKENDS }?.let { AssistantChoice(it, saved.profileId, saved.model) }
        ?: AssistantChoice(ASSISTANT_BACKENDS.first(), null, null)
    return settings.withAssistantChoice(choice)
}

class AssistantChoice(val backendId: NativeBackendId, val profileId: String?, val model: String?)

/** The settings a composer reads its opening model from, with the assistant's choice in the agent's place. */
fun AppSettings.withAssistantChoice(choice: AssistantChoice): AppSettings {
    val saved = nativeBackendDefaults?.get(choice.backendId)
    val replaced = (saved ?: NativeBackendDefaults()).copy(profileId = choice.profileId, model = choice.model)
    return copy(defaultBackendId = choice.backendId, nativeBackendDefaults = (nativeBackendDefaults ?: emptyMap()) + (choice.backendId to replaced))
}

