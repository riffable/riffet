package riffet.ui.settings

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import riffet.contracts.AppSettings
import riffet.contracts.AppSettingsUpdate
import riffet.contracts.AuxiliaryModelRef
import riffet.contracts.CapabilityReport
import riffet.contracts.CursorCliSettings
import riffet.contracts.ModelInfo
import riffet.contracts.NativeBackendCapabilities
import riffet.contracts.NativeBackendCatalogEntry
import riffet.contracts.NativeBackendDefaults
import riffet.contracts.NativeBackendId
import riffet.contracts.NativeBackendProfileSettings
import riffet.contracts.NativeBackendProfileSettingsUpdate
import riffet.contracts.PatchValue
import riffet.contracts.QuickChatPreset
import riffet.shared.ProbeBackendModelsBody
import riffet.shared.RiffetApi
import riffet.shared.RiffetUnauthenticatedException
import riffet.shared.backendCatalog
import riffet.shared.backendProfiles
import riffet.shared.backends
import riffet.shared.plugins
import riffet.shared.backendUsage
import riffet.shared.capabilities
import riffet.shared.createBackendProfile
import riffet.i18n.L10n
import riffet.shared.deleteBackendProfile
import riffet.shared.probeBackendModels
import riffet.shared.setAuxiliaryModel
import riffet.shared.setPluginModel
import riffet.shared.settings
import riffet.shared.updateBackendProfile
import riffet.shared.updateQuickChat
import riffet.shared.updateSettings

/**
 * Editable snapshot of one backend profile, held by the editor while the server copy stays
 * untouched. `apiKeyDraft` is never seeded from the server — there is no key to seed it with — and
 * `clearApiKey` is a separate intent so "typed nothing" cannot be confused with "delete the key".
 */
data class BackendProfileDraft(
    val name: String = "",
    val executable: String = "",
    val configDir: String = "",
    val sourceDir: String = "",
    val apiEndpoint: String = "",
    val agentEndpoint: String = "",
    val defaultModel: String = "",
    val disableAutoUpdate: Boolean = false,
    /** `null` means the whole catalog, `[]` an explicit empty selection. */
    val enabledModels: List<String>? = null,
    /** Input types per model id; an absent id keeps the backend's own answer. */
    val modelInputModalities: Map<String, List<String>> = emptyMap(),
    /** Declared context windows in tokens per model id (Claude Code and pi); an absent id keeps the gateway's figure. */
    val modelContextWindows: Map<String, Long> = emptyMap(),
    /** Wire API a custom pi provider speaks; absent keeps the backend's own default. */
    val apiProtocol: String? = null,
    val modelSource: String? = null,
    /** Editor-only selection, including an API whose address has not been typed yet. */
    val connectionMethod: String? = null,
    val apiKeyDraft: String = "",
    val clearApiKey: Boolean = false,
)

fun editableDraft(profile: NativeBackendProfileSettings): BackendProfileDraft = BackendProfileDraft(
    name = profile.name,
    executable = profile.executable.orEmpty(),
    configDir = profile.configDir.orEmpty(),
    sourceDir = profile.sourceDir.orEmpty(),
    apiEndpoint = profile.apiEndpoint.orEmpty(),
    agentEndpoint = profile.agentEndpoint.orEmpty(),
    defaultModel = profile.defaultModel.orEmpty(),
    disableAutoUpdate = profile.disableAutoUpdate == true,
    enabledModels = profile.enabledModels,
    modelInputModalities = profile.modelInputModalities.orEmpty(),
    modelContextWindows = profile.modelContextWindows.orEmpty(),
    apiProtocol = profile.apiProtocol,
    modelSource = profile.modelSource,
)

/** `null` and `[]` are different selections: one is the whole catalog, the other is nothing. */
fun sameModels(a: List<String>?, b: List<String>?): Boolean = a == b

/** Declarations are order-free, so only the ids and the set of types behind each id matter. */
fun sameModalities(a: Map<String, List<String>>, b: Map<String, List<String>>): Boolean =
    a.keys == b.keys && a.all { (id, types) -> types.toSet() == b[id]?.toSet() }

/** Shared Cursor endpoints follow a gateway edit; an explicitly separate Agent endpoint stays. */
fun updateCursorProfileGateway(draft: BackendProfileDraft, endpoint: String): BackendProfileDraft =
    draft.copy(apiEndpoint = endpoint, agentEndpoint = if (draft.agentEndpoint.trim() == draft.apiEndpoint.trim()) endpoint else draft.agentEndpoint)

/**
 * Builds the PATCH body for one profile from the editor's draft, or `null` when nothing changed.
 *
 * This is the one place the API-key guarantee lives:
 *  - `apiKeyDraft` is written to the body **only** when the reader typed something, so a save that
 *    touched other fields can never overwrite the stored key with a redaction placeholder or an
 *    empty string;
 *  - `clearApiKey` sends JSON `null`, the server's explicit "drop it" signal;
 *  - an untouched key contributes no `apiKey` field at all, which the server reads as "keep".
 *
 * Text fields compare as strings and are sent verbatim (the server trims and treats an empty string
 * as "clear this option"). `name` rides along with any change so the CLI's own profile name is not
 * rewritten to its id by an unrelated edit, matching `BackendProfilesSection.tsx`.
 */
fun backendProfilePatch(
    saved: NativeBackendProfileSettings,
    draft: BackendProfileDraft,
): NativeBackendProfileSettingsUpdate? {
    val baseline = editableDraft(saved)
    var changed = false
    val patch = NativeBackendProfileSettingsUpdate(
        name = draft.name.takeIf { it != baseline.name },
        executable = draft.executable.takeIf { it != baseline.executable },
        configDir = draft.configDir.takeIf { it != baseline.configDir },
        sourceDir = draft.sourceDir.takeIf { it != baseline.sourceDir },
        apiEndpoint = draft.apiEndpoint.takeIf { it != baseline.apiEndpoint },
        agentEndpoint = draft.agentEndpoint.takeIf { it != baseline.agentEndpoint },
        defaultModel = draft.defaultModel.takeIf { it != baseline.defaultModel },
        disableAutoUpdate = draft.disableAutoUpdate.takeIf { it != baseline.disableAutoUpdate },
        enabledModels = if (sameModels(draft.enabledModels, baseline.enabledModels)) {
            null
        } else {
            changed = true
            PatchValue.list(draft.enabledModels)
        },
        // `null` is the only value that restores the backend's own answer, so an emptied map clears.
        modelInputModalities = if (sameModalities(draft.modelInputModalities, baseline.modelInputModalities)) {
            null
        } else {
            changed = true
            PatchValue.modalities(draft.modelInputModalities.ifEmpty { null })
        },
        modelContextWindows = if (draft.modelContextWindows == baseline.modelContextWindows) {
            null
        } else {
            changed = true
            PatchValue.contextWindows(draft.modelContextWindows.ifEmpty { null })
        },
        apiProtocol = if (draft.apiProtocol != baseline.apiProtocol) PatchValue.key(draft.apiProtocol) else null,
        modelSource = if (draft.modelSource != baseline.modelSource) PatchValue.key(draft.modelSource) else null,
    ).also {
        changed = changed ||
            it.name != null || it.executable != null || it.configDir != null || it.sourceDir != null ||
            it.apiEndpoint != null || it.agentEndpoint != null || it.defaultModel != null ||
            it.disableAutoUpdate != null || it.apiProtocol != null || it.modelSource != null
    }
    if (draft.apiKeyDraft.isNotEmpty() || draft.clearApiKey) changed = true
    if (!changed) return null
    return patch.copy(
        // Any change carries the name, so a rename-less edit keeps what the CLI calls this profile.
        name = patch.name ?: draft.name,
        apiKey = when {
            draft.apiKeyDraft.isNotEmpty() -> PatchValue.key(draft.apiKeyDraft)
            draft.clearApiKey -> PatchValue.key(null)
            else -> null
        },
    )
}

/** Provider-specific model parameters never move to another provider or survive its removal. */
fun selectDefaultProfile(current: NativeBackendDefaults?, profileId: String?): NativeBackendDefaults =
    (current ?: NativeBackendDefaults()).copy(profileId = profileId, model = current?.model?.takeIf { profileId != null && current.profileId == profileId })

/** Everything the settings surface reads from the server, as one snapshot. */
data class SettingsState(
    val settings: AppSettings? = null,
    val capabilities: CapabilityReport? = null,
    val loading: Boolean = false,
    val diagnosticsLoading: Boolean = false,
    val diagnosticsError: String? = null,
    val profileLists: Map<NativeBackendId, List<NativeBackendProfileSettings>> = emptyMap(),
    val profilesLoading: Map<NativeBackendId, Boolean> = emptyMap(),
    val profilesErrors: Map<NativeBackendId, String> = emptyMap(),
    val saving: Boolean = false,
    val error: String? = null,
    val notice: String? = null,
)

/** The provider new sessions of [backendId] use: the saved choice, else the CLI's own default. */
fun defaultProfileId(state: SettingsState, backendId: NativeBackendId): String? =
    state.settings?.nativeBackendDefaults?.get(backendId)?.profileId
        ?: state.profileLists[backendId]?.firstOrNull { it.isDefault == true }?.id
        ?: if (backendId == NativeBackendId.CURSOR) "default" else null

/**
 * Loads and saves the settings surface and holds the small amount of shared state its sections read.
 * One instance is made per screen; it never outlives it.
 */
class SettingsController(
    private val api: RiffetApi,
    private val scope: CoroutineScope,
    /** The project a model catalog is read through; server catalogs are project-scoped. */
    val projectId: String?,
    private val onSettingsSaved: (AppSettings) -> Unit = {},
    private val onProfilesChanged: () -> Unit = {},
) {
    private val _state = MutableStateFlow(SettingsState())
    val state: StateFlow<SettingsState> = _state.asStateFlow()

    private val profileReads = mutableMapOf<NativeBackendId, Long>()

    fun clearMessages() {
        _state.update { it.copy(error = null, notice = null) }
    }

    fun consumeNotice(message: String) {
        _state.update { if (it.notice == message) it.copy(notice = null) else it }
    }

    fun load() {
        val current = _state.value
        if (current.loading || current.saving) return
        _state.update { it.copy(loading = true) }
        scope.launch {
            _state.update { it.copy(error = null) }
            try {
                val loaded = api.settings()
                _state.update { it.copy(settings = loaded) }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (failure: Throwable) {
                _state.update { it.copy(error = failure.settingsMessage(L10n.uiText("settings.loadFailed"))) }
            } finally {
                _state.update { it.copy(loading = false) }
            }
        }
    }

    fun loadDiagnostics() {
        if (_state.value.diagnosticsLoading) return
        _state.update { it.copy(diagnosticsLoading = true) }
        scope.launch {
            _state.update { it.copy(diagnosticsError = null) }
            try {
                val report = api.capabilities()
                _state.update { it.copy(capabilities = report) }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (failure: Throwable) {
                _state.update { it.copy(diagnosticsError = failure.settingsMessage(L10n.uiText("settings.diagnosticsFailed"))) }
            } finally {
                _state.update { it.copy(diagnosticsLoading = false) }
            }
        }
    }

    fun loadProfiles(backendId: NativeBackendId) {
        if (_state.value.profilesLoading[backendId] == true) return
        val read = (profileReads[backendId] ?: 0L) + 1
        profileReads[backendId] = read
        _state.update { it.copy(profilesLoading = it.profilesLoading + (backendId to true)) }
        scope.launch {
            _state.update { it.copy(profilesErrors = it.profilesErrors - backendId) }
            try {
                val profiles = api.backendProfiles(backendId).profiles
                if (profileReads[backendId] == read) _state.update { it.copy(profileLists = it.profileLists + (backendId to profiles)) }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (failure: Throwable) {
                if (profileReads[backendId] == read) {
                    _state.update { it.copy(profilesErrors = it.profilesErrors + (backendId to failure.settingsMessage(L10n.uiText("settings.providersLoadFailed")))) }
                }
            } finally {
                if (profileReads[backendId] == read) _state.update { it.copy(profilesLoading = it.profilesLoading + (backendId to false)) }
            }
        }
    }

    private fun invalidateProfileRead(backendId: NativeBackendId) {
        profileReads[backendId] = (profileReads[backendId] ?: 0L) + 1
        _state.update {
            it.copy(profilesLoading = it.profilesLoading + (backendId to false), profilesErrors = it.profilesErrors - backendId)
        }
    }

    private fun setProfiles(backendId: NativeBackendId, transform: (List<NativeBackendProfileSettings>) -> List<NativeBackendProfileSettings>) {
        _state.update { it.copy(profileLists = it.profileLists + (backendId to transform(it.profileLists[backendId].orEmpty()))) }
    }

    private fun publish(updated: AppSettings) {
        _state.update { it.copy(settings = updated) }
        onSettingsSaved(updated)
    }

    /** Starts a write unless one is in flight; the busy flag is set before the coroutine runs. */
    private fun beginWrite(): Boolean {
        if (_state.value.saving) return false
        _state.update { it.copy(saving = true) }
        return true
    }

    fun saveSettings(patch: AppSettingsUpdate, successMessage: String? = null, failureMessage: String = L10n.uiText("settings.saveFailed"), onSaved: () -> Unit = {}) {
        if (!beginWrite()) return
        scope.launch {
            _state.update { it.copy(error = null, notice = null) }
            try {
                publish(api.updateSettings(patch))
                successMessage?.let { message -> _state.update { it.copy(notice = message) } }
                onSaved()
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (failure: Throwable) {
                _state.update { it.copy(error = failure.settingsMessage(failureMessage)) }
            } finally {
                _state.update { it.copy(saving = false) }
            }
        }
    }

    /**
     * Writes quick chat settings. Only the supplied keys change; [resetPresets] restores the server's
     * default presets instead of [presets] (the two are mutually exclusive).
     */
    fun saveQuickChat(
        retentionDays: Int? = null,
        openMode: String? = null,
        presets: List<QuickChatPreset>? = null,
        resetPresets: Boolean = false,
        successMessage: String? = null,
        failureMessage: String = L10n.uiText("settings.saveFailed"),
        onSaved: () -> Unit = {},
    ) {
        if (!beginWrite()) return
        scope.launch {
            _state.update { it.copy(error = null, notice = null) }
            try {
                publish(api.updateQuickChat(retentionDays, openMode, presets, resetPresets))
                successMessage?.let { message -> _state.update { it.copy(notice = message) } }
                onSaved()
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (failure: Throwable) {
                _state.update { it.copy(error = failure.settingsMessage(failureMessage)) }
            } finally {
                _state.update { it.copy(saving = false) }
            }
        }
    }

    /** Writes one of the 助理's background-run settings (`RiffetApiAssistant.kt`'s setters); [onSaved] runs once it is stored. */
    fun saveAssistant(write: suspend (RiffetApi) -> AppSettings, onSaved: () -> Unit = {}) {
        if (!beginWrite()) return
        scope.launch {
            _state.update { it.copy(error = null, notice = null) }
            try {
                publish(write(api))
                onSaved()
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (failure: Throwable) {
                _state.update { it.copy(error = failure.settingsMessage(L10n.uiText("settings.saveFailed"))) }
            } finally {
                _state.update { it.copy(saving = false) }
            }
        }
    }

    /** Sets one auxiliary purpose (`title`, `handoff`, `chat`) or clears it; other purposes stay as they are. */
    fun saveAuxiliaryModel(purpose: String, ref: AuxiliaryModelRef?, onSaved: () -> Unit = {}) {
        if (!beginWrite()) return
        scope.launch {
            _state.update { it.copy(error = null, notice = null) }
            try {
                publish(api.setAuxiliaryModel(purpose, ref))
                onSaved()
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (failure: Throwable) {
                _state.update { it.copy(error = failure.settingsMessage(L10n.uiText("settings.saveFailed"))) }
            } finally {
                _state.update { it.copy(saving = false) }
            }
        }
    }

    /** Sets the model of one plugin-declared use (`<pluginId>/<name>`) or clears it; other uses stay as they are. */
    fun savePluginModel(use: String, ref: AuxiliaryModelRef?, onSaved: () -> Unit = {}) {
        if (!beginWrite()) return
        scope.launch {
            _state.update { it.copy(error = null, notice = null) }
            try {
                publish(api.setPluginModel(use, ref))
                onSaved()
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (failure: Throwable) {
                _state.update { it.copy(error = failure.settingsMessage(L10n.uiText("settings.saveFailed"))) }
            } finally {
                _state.update { it.copy(saving = false) }
            }
        }
    }

    fun updateProfile(
        backendId: NativeBackendId,
        profileId: String,
        body: NativeBackendProfileSettingsUpdate,
        onSaved: () -> Unit = {},
    ) {
        if (!beginWrite()) return
        scope.launch {
            _state.update { it.copy(error = null, notice = null) }
            try {
                val response = api.updateBackendProfile(backendId, profileId, body)
                invalidateProfileRead(backendId)
                setProfiles(backendId) { list ->
                    list.map { if (it.id == profileId) response.copy(isDefault = response.isDefault ?: it.isDefault) else it }
                }
                if (backendId == NativeBackendId.CURSOR) {
                    val saved = _state.value.settings
                    if (saved != null) {
                        val defaults = saved.nativeBackendDefaults.orEmpty()
                        val cursor = defaults[backendId] ?: NativeBackendDefaults()
                        publish(
                            saved.copy(
                                cursorCli = CursorCliSettings(
                                    executable = response.executable, configDir = response.configDir,
                                    apiEndpoint = response.apiEndpoint, agentEndpoint = response.agentEndpoint,
                                    disableAutoUpdate = response.disableAutoUpdate, hasApiKey = response.hasApiKey,
                                ),
                                defaultModel = if (body.defaultModel != null) response.defaultModel else saved.defaultModel,
                                nativeBackendDefaults = if (body.defaultModel != null) defaults + (backendId to cursor.copy(model = response.defaultModel)) else saved.nativeBackendDefaults,
                            ),
                        )
                    }
                } else if (body.defaultModel != null) {
                    val saved = _state.value.settings
                    val defaults = saved?.nativeBackendDefaults.orEmpty()
                    val current = defaults[backendId]
                    if (saved != null && current?.model != null && defaultProfileId(_state.value, backendId) == profileId) {
                        publish(saved.copy(nativeBackendDefaults = defaults + (backendId to current.copy(model = response.defaultModel))))
                    }
                }
                onProfilesChanged()
                _state.update { it.copy(notice = L10n.uiText("settings.saved")) }
                onSaved()
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (failure: Throwable) {
                _state.update { it.copy(error = failure.settingsMessage(L10n.uiText("settings.providerSaveFailed"))) }
            } finally {
                _state.update { it.copy(saving = false) }
            }
        }
    }

    fun createProfile(
        backendId: NativeBackendId,
        id: String,
        body: NativeBackendProfileSettingsUpdate,
        onCreated: (String) -> Unit,
    ) {
        if (!beginWrite()) return
        scope.launch {
            _state.update { it.copy(error = null, notice = null) }
            try {
                val created = api.createBackendProfile(backendId, id, body)
                invalidateProfileRead(backendId)
                setProfiles(backendId) { it + created }
                loadProfiles(backendId)
                onProfilesChanged()
                _state.update { it.copy(notice = L10n.uiText("settings.added")) }
                onCreated(created.id)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (failure: Throwable) {
                _state.update { it.copy(error = failure.settingsMessage(L10n.uiText("settings.providerAddFailed"))) }
            } finally {
                _state.update { it.copy(saving = false) }
            }
        }
    }

    fun deleteProfile(
        backendId: NativeBackendId,
        profileId: String,
        onDeleted: () -> Unit,
    ) {
        if (!beginWrite()) return
        scope.launch {
            _state.update { it.copy(error = null, notice = null) }
            try {
                api.deleteBackendProfile(backendId, profileId)
                invalidateProfileRead(backendId)
                setProfiles(backendId) { list -> list.filterNot { it.id == profileId } }
                val saved = _state.value.settings
                val defaults = saved?.nativeBackendDefaults?.get(backendId)
                if (saved != null && defaults?.profileId == profileId) {
                    publish(saved.copy(nativeBackendDefaults = saved.nativeBackendDefaults.orEmpty() + (backendId to defaults.copy(profileId = null))))
                }
                // Mutation receipts contain stored profiles only; reload the CLI's built-in fallback.
                loadProfiles(backendId)
                onProfilesChanged()
                _state.update { it.copy(notice = L10n.uiText("settings.deleted")) }
                onDeleted()
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (failure: Throwable) {
                _state.update { it.copy(error = failure.settingsMessage(L10n.uiText("settings.providerDeleteFailed"))) }
            } finally {
                _state.update { it.copy(saving = false) }
            }
        }
    }

    /**
     * The saved profile's full model catalog. Best-effort: a CLI that cannot be interrogated is a
     * state the editor shows, not an error that closes it.
     */
    suspend fun catalog(
        backendId: NativeBackendId,
        profileId: String,
    ): Result<NativeBackendCatalogEntry> = settingsResult {
        api.backendCatalog(backendId, profileId = profileId, projectId = projectId, allModels = true)
    }

    /** Launch defaults use the selected provider's enabled catalog without requiring a project. */
    suspend fun launchCatalog(backendId: NativeBackendId, profileId: String): Result<NativeBackendCatalogEntry> = settingsResult {
        api.backendCatalog(backendId, profileId = profileId, allModels = false, global = true)
    }

    suspend fun providerPlugins(): Result<List<riffet.shared.PluginDescriptor>> = settingsResult {
        api.plugins()
    }

    suspend fun usage(backendId: NativeBackendId, profileId: String): Result<riffet.contracts.NativeBackendUsage> = settingsResult {
        api.backendUsage(backendId, profileId = profileId, global = true)
    }

    /** The default provider's options do not require a project or a model catalog. */
    suspend fun backendCapabilities(backendId: NativeBackendId): Result<NativeBackendCapabilities> = settingsResult {
        api.backends().firstOrNull { it.backendId == backendId }?.capabilities
            ?: error(L10n.uiText("settings.providerMissing"))
    }

    /** Asks a gateway what it serves using the editor's unsaved values; persists nothing. */
    suspend fun probeModels(
        backendId: NativeBackendId,
        apiEndpoint: String,
        apiKey: String,
        profileId: String?,
        apiProtocol: String? = null,
        clearApiKey: Boolean = false,
        modelSource: String? = null,
    ): Result<List<ModelInfo>> = settingsResult {
        api.probeBackendModels(
            backendId,
            ProbeBackendModelsBody(
                apiEndpoint = apiEndpoint,
                apiKey = if (clearApiKey) "" else apiKey.takeIf { it.isNotEmpty() },
                profileId = profileId,
                apiProtocol = apiProtocol,
                modelSource = modelSource,
            ),
        )
    }
}

/** Coroutine cancellation is navigation/lifecycle, never a failed model probe. */
private suspend fun <T> settingsResult(block: suspend () -> T): Result<T> = try {
    Result.success(block())
} catch (cancellation: CancellationException) {
    throw cancellation
} catch (failure: Throwable) {
    Result.failure(failure)
}

/** A 401 is a real answer ("this device was revoked"), so it reads differently from a network error. */
fun Throwable.settingsMessage(fallback: String): String = when (this) {
    is RiffetUnauthenticatedException -> L10n.uiText("auth.deviceRevoked")
    else -> message?.takeIf { it.isNotBlank() } ?: fallback
}
