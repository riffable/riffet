package riffet.ui.home

import riffet.contracts.NativeBackendCatalogEntry
import riffet.contracts.NativeBackendDefaults
import riffet.contracts.NativeBackendId
import riffet.ui.pickers.resolveModelSelection

/**
 * What the next new session starts with: the reader's own picks, kept apart from the defaults.
 *
 * A null field is "follow the defaults" (the saved backend defaults, then the global default model
 * for Cursor's default profile, then the backend's own). A pick is kept across a catalog reload for
 * as long as the new catalog still offers it; one it no longer offers falls back to the default.
 * Android and iPhone resolve through [resolve], so both start a session with the same values.
 * A different backend starts a new draft: its picks do not carry over.
 */
data class NewSessionDraft(
    val profileId: String? = null,
    val model: String? = null,
    val mode: String? = null,
    val approval: String? = null,
) {
    /** The same draft with a model picked from [profileId]'s catalog. */
    fun withModel(profileId: String?, selection: String): NewSessionDraft = copy(profileId = profileId, model = selection)

    /**
     * The provider whose catalog to read: the pick if [listed] still has it, else the saved default
     * profile, else the one the server marks as default. Null when the backend lists none.
     */
    fun requestedProfile(listed: NativeBackendCatalogEntry?, saved: NativeBackendDefaults?): String? {
        val profiles = listed?.profiles.orEmpty()
        val known = { id: String? -> id != null && (profiles.isEmpty() || profiles.any { it.id == id }) }
        return profileId.takeIf(known)
            ?: saved?.profileId?.takeIf(known)
            ?: profiles.firstOrNull { it.isDefault == true }?.id
    }

    /**
     * The values a session would start with, given [catalog] (the requested provider's catalog), the
     * backend's [saved] defaults and the global [cursorModel] (the default model of Cursor's default
     * profile). [listed] is the backend's entry from the backend list, for the profiles and the
     * default model when the catalog does not carry them.
     */
    fun resolve(
        catalog: NativeBackendCatalogEntry,
        saved: NativeBackendDefaults?,
        cursorModel: String?,
        listed: NativeBackendCatalogEntry? = null,
    ): NewSessionChoice {
        val profiles = catalog.profiles.ifEmpty { listed?.profiles.orEmpty() }
        val defaultProfile = profiles.firstOrNull { it.isDefault == true }?.id
        val profile = requestedProfile(catalog.copy(profiles = profiles), saved)
        // The saved defaults belong to one provider; another provider's picks start from the backend's own.
        val savedApplies = saved != null && (profile ?: defaultProfile) == (saved.profileId ?: defaultProfile)
        val savedHere = saved.takeIf { savedApplies }

        val models = catalog.models
        val model = this.model?.takeIf { pick -> models.isEmpty() || models.any { it.value == resolveModelSelection(models, pick).model } }
            ?: savedHere?.model?.takeIf { it.isNotBlank() }
            // A provider switched to without a model starts on the one last picked there, while its catalog still has it.
            ?: saved?.profileModels?.get(profile ?: defaultProfile ?: "")?.takeIf { remembered ->
                remembered.isNotBlank() && models.any { it.value == resolveModelSelection(models, remembered).model }
            }
            ?: cursorModel?.takeIf { catalog.backendId == NativeBackendId.CURSOR && (profile == null || profile == "default") && it.isNotBlank() }
            ?: catalog.defaultModel
            ?: listed?.defaultModel
            ?: ""

        val modes = catalog.capabilities.modes
        val mode = this.mode?.takeIf { pick -> modes.isEmpty() || modes.any { it.id == pick } }
            ?: modes.firstOrNull { it.id == "agent" }?.id
            ?: modes.firstOrNull()?.id

        val permissions = catalog.capabilities.permissions
        val approval = this.approval?.takeIf { pick -> permissions.isEmpty() || permissions.any { it.id == pick } }
            ?: savedHere?.approval?.takeIf { id -> permissions.any { it.id == id } }
            ?: permissions.firstOrNull()?.id

        return NewSessionChoice(profile, model, mode, approval)
    }
}

/** A resolved [NewSessionDraft]: what `createSession` is sent. Mode and approval are null when the backend lists none. */
data class NewSessionChoice(
    val profileId: String?,
    val model: String,
    val mode: String?,
    val approval: String?,
)
