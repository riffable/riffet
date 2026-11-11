package riffet.ui.session

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import riffet.contracts.ModelInfo
import riffet.contracts.NativeBackendCapabilities
import riffet.contracts.NativeBackendId
import riffet.contracts.NativeRuntimeAction
import riffet.contracts.NativeBackendProfile
import riffet.contracts.NativeProfileContinuation
import riffet.contracts.NativeBackendUsage
import riffet.contracts.Session
import riffet.shared.SessionUpdate
import riffet.shared.RiffetApi
import riffet.shared.backendCatalog
import riffet.shared.backendUsage
import riffet.i18n.L10n
import riffet.shared.nativeRuntimeAction
import riffet.shared.nativeSetApproval
import riffet.shared.nativeSetMode
import riffet.shared.nativeSetModel
import riffet.shared.nativeSwitchProfile
import riffet.shared.sessionCatalog
import riffet.shared.updateSession

/** What the session detail surfaces render; see [SessionDetailController]. */
data class SessionDetailState(
    val sessionId: String,
    val catalog: List<ModelInfo> = emptyList(),
    val catalogLoading: Boolean = false,
    val catalogError: String? = null,
    val capabilities: NativeBackendCapabilities? = null,
    /** The backend's providers in configured order, and the other providers this conversation continues on in place. */
    val profiles: List<NativeBackendProfile> = emptyList(),
    val continuations: List<NativeProfileContinuation> = emptyList(),
    /** True while a model/mode/approval write is in flight; newer picks queue behind it. */
    val switching: Boolean = false,
    /** True while a metadata write (rename/pin/archive/tags) is in flight. */
    val actionBusy: Boolean = false,
    val runtimeActionPending: Boolean = false,
    /** The last failure, shown in the sheet it came from and cleared on the next attempt. */
    val error: String? = null,
    /** Picked but not yet confirmed by the server; see [intended]. */
    val pendingModel: String? = null,
    val pendingMode: String? = null,
    val pendingApproval: String? = null,
    /** The phone groups picked but not yet answered by the server; see [intended]. */
    val pendingToolGroups: List<String>? = null,
    /** The `mcp:` / `skill:` entries picked but not yet answered by the server; see [intended]. */
    val pendingExtensionsOff: List<String>? = null,
) {
    /** [session] as the user last chose it: unconfirmed picks overlay the server's values. */
    fun intended(session: Session): Session {
        if (session.id != sessionId) return session
        if (pendingModel == null && pendingMode == null && pendingApproval == null && pendingToolGroups == null && pendingExtensionsOff == null) return session
        return session.copy(
            model = pendingModel ?: session.model,
            mode = pendingMode ?: session.mode,
            approval = pendingApproval ?: session.approval,
            toolGroups = pendingToolGroups ?: session.toolGroups,
            extensionsOff = pendingExtensionsOff ?: session.extensionsOff,
        )
    }
}

/**
 * The write half of the session detail screen: the model catalog, the backend's own option lists,
 * and the four `Session` writes (model, mode, approval, metadata).
 *
 * It exists because [riffet.ui.state.SessionStore] is read-only: it mirrors the stream and owns the
 * composer's sends, but it exposes neither the [RiffetApi] nor the `native/…` config writes. Rather
 * than widen the store, this holds its own small state and every write goes straight to the server.
 *
 * ## Local intent, server truth
 *
 * A successful write returns the server's own `Session`, which this hands back through [onSession].
 * While a write is in flight the picked value is held as a local intent ([SessionDetailState.intended])
 * so a second quick change (Fast, then the thinking level) builds on the first instead of on the
 * stale session. Writes are serialised and only the newest intent per field is sent (latest wins);
 * when the server refuses one, the intent is dropped, the UI falls back to the session's value and
 * the error is surfaced. The stream's own `session` frame is the other half and lands in the store.
 *
 * ## The catalog is the CLI's, not ours
 *
 * `GET /api/backends/:id/catalog` returns `ModelInfo[]` (with `configOptions`) plus the backend's
 * `NativeBackendCapabilities` - the same call `Workbench.tsx` makes before handing `catalog` and
 * `backendCapabilities` to `NativeSession`. Both the model list and the mode/permission option
 * lists therefore come from the running CLI.
 */
class SessionDetailController(
    private val api: RiffetApi,
    private val scope: CoroutineScope,
    private val sessionId: String,
    private val onSession: (Session) -> Unit,
) {
    private val _state = MutableStateFlow(SessionDetailState(sessionId))
    val state: StateFlow<SessionDetailState> = _state.asStateFlow()

    /** The newest unsent value per field; the writer drains it in order, one request at a time. */
    private val unsent = LinkedHashMap<ConfigField, String>()
    private var writer: Job? = null
    private var launchWriter: Job? = null
    private var unsentToolGroups: List<String>? = null
    private var unsentExtensionsOff: List<String>? = null

    private var loadedKey: String? = null

    /** Loads the catalog once per (backend, profile, project) triple. */
    fun load(backendId: NativeBackendId, profileId: String?, projectId: String) {
        val key = keyOf(backendId, profileId, projectId)
        val current = _state.value
        if (loadedKey == key && (current.catalogLoading || current.catalogError != null || current.catalog.isNotEmpty())) return
        loadedKey = key
        fetchCatalog(backendId, profileId, projectId)
    }

    /** Quota and load for the profile and project this session runs on. */
    @Throws(Exception::class)
    suspend fun usage(backendId: NativeBackendId): NativeBackendUsage = api.backendUsage(backendId, sessionId = sessionId)

    fun retryCatalog(backendId: NativeBackendId, profileId: String?, projectId: String) {
        loadedKey = keyOf(backendId, profileId, projectId)
        fetchCatalog(backendId, profileId, projectId)
    }

    private fun keyOf(backendId: NativeBackendId, profileId: String?, projectId: String): String =
        "$backendId:${profileId ?: "default"}:$projectId"

    private fun fetchCatalog(backendId: NativeBackendId, profileId: String?, projectId: String) {
        scope.launch {
            _state.update { it.copy(catalogLoading = true, catalogError = null) }
            try {
                val entry = api.backendCatalog(backendId = backendId, profileId = profileId, projectId = projectId)
                _state.update { it.copy(catalog = entry.models, capabilities = entry.capabilities) }
                // Which providers this conversation can move to is the session's own answer; without it the picker stays one provider.
                val own = try {
                    api.sessionCatalog(sessionId)
                } catch (cancellation: CancellationException) {
                    throw cancellation
                } catch (_: Throwable) {
                    null
                }
                _state.update { it.copy(profiles = own?.profiles.orEmpty(), continuations = own?.continuations.orEmpty()) }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (failure: Throwable) {
                _state.update { it.copy(catalogError = failure.message ?: L10n.uiText("sessionDetail.catalogError")) }
            } finally {
                _state.update { it.copy(catalogLoading = false) }
            }
        }
    }

    fun setModel(value: String) = request(ConfigField.MODEL, value)

    /**
     * Continues the conversation on [profileId], one of [SessionDetailState.continuations], with
     * [selection] from that provider's own models. The catalog is read again once the session answers.
     */
    fun switchProfile(profileId: String, selection: String) {
        if (selection.isBlank() || writer?.isActive == true || _state.value.switching) return
        _state.update { it.copy(switching = true, pendingModel = selection, error = null) }
        scope.launch {
            try {
                val updated = api.nativeSwitchProfile(sessionId, profileId, selection)
                // The old provider's models must not show under the new provider while the next read is in flight.
                _state.update { it.copy(catalog = emptyList(), continuations = emptyList()) }
                onSession(updated)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (failure: Throwable) {
                _state.update { it.copy(error = failure.message ?: ConfigField.MODEL.fallback) }
            } finally {
                _state.update { it.copy(pendingModel = null, switching = false) }
            }
        }
    }

    fun setMode(value: String) = request(ConfigField.MODE, value)

    fun setApproval(value: String) = request(ConfigField.APPROVAL, value)

    /**
     * The full list of phone groups the CLI is launched with next. It shows at once; while a write is
     * in flight a newer pick replaces any older unsent one, so only the newest is answered for.
     */
    fun setToolGroups(groups: List<String>) = writeLaunchSettings(toolGroups = groups, extensionsOff = null)

    /** The full list of `mcp:` / `skill:` entries the CLI is launched without next; written like [setToolGroups]. */
    fun setExtensionsOff(items: List<String>) = writeLaunchSettings(toolGroups = null, extensionsOff = items)

    /**
     * Both lists apply at the next launch and share one writer: a pick of either kind shows at once,
     * and what is unsent when a write answers goes out together in the next request.
     */
    private fun writeLaunchSettings(toolGroups: List<String>?, extensionsOff: List<String>?) {
        toolGroups?.let { unsentToolGroups = it }
        extensionsOff?.let { unsentExtensionsOff = it }
        _state.update {
            it.copy(
                pendingToolGroups = toolGroups ?: it.pendingToolGroups,
                pendingExtensionsOff = extensionsOff ?: it.pendingExtensionsOff,
                error = null,
            )
        }
        if (launchWriter?.isActive == true) return
        launchWriter = scope.launch {
            try {
                while (true) {
                    val groups = unsentToolGroups
                    val off = unsentExtensionsOff
                    if (groups == null && off == null) break
                    unsentToolGroups = null
                    unsentExtensionsOff = null
                    try {
                        onSession(api.updateSession(sessionId, SessionUpdate(toolGroups = groups, extensionsOff = off)))
                    } catch (cancellation: CancellationException) {
                        throw cancellation
                    } catch (failure: Throwable) {
                        _state.update { it.copy(error = failure.message ?: L10n.uiText("sessionDetail.updateError")) }
                    }
                    // The server's answer (or its refusal) is what shows, unless a newer pick waits.
                    _state.update {
                        it.copy(
                            pendingToolGroups = if (unsentToolGroups == null) null else it.pendingToolGroups,
                            pendingExtensionsOff = if (unsentExtensionsOff == null) null else it.pendingExtensionsOff,
                        )
                    }
                }
            } finally {
                unsentToolGroups = null
                unsentExtensionsOff = null
                _state.update { it.copy(pendingToolGroups = null, pendingExtensionsOff = null) }
            }
        }
    }

    /** Rename, tags, pin and archive all go through the one metadata route. */
    fun update(body: SessionUpdate) {
        if (_state.value.actionBusy) return
        _state.update { it.copy(actionBusy = true, error = null) }
        scope.launch {
            try {
                onSession(api.updateSession(sessionId, body))
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (failure: Throwable) {
                _state.update { it.copy(error = failure.message ?: L10n.uiText("sessionDetail.updateError")) }
            } finally {
                _state.update { it.copy(actionBusy = false) }
            }
        }
    }

    fun runRuntimeAction(action: NativeRuntimeAction, revision: String) {
        if (_state.value.runtimeActionPending) return
        _state.update { it.copy(runtimeActionPending = true, error = null) }
        scope.launch {
            try {
                api.nativeRuntimeAction(sessionId, action.id, revision)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (failure: Throwable) {
                _state.update { it.copy(error = failure.message ?: L10n.uiText("sessionDetail.updateError")) }
            } finally {
                _state.update { it.copy(runtimeActionPending = false) }
            }
        }
    }

    fun clearError() {
        _state.update { it.copy(error = null) }
    }

    /**
     * Records [value] as the newest intent for [field] and makes sure the writer runs. A pick made
     * while an earlier write is in flight is not dropped: it replaces any older unsent value of the
     * same field and is sent once the earlier write has answered.
     */
    private fun request(field: ConfigField, value: String) {
        if (value.isBlank()) return
        unsent.remove(field)
        unsent[field] = value
        setPending(field, value)
        _state.update { it.copy(error = null) }
        if (writer?.isActive == true) return
        _state.update { it.copy(switching = true) }
        writer = scope.launch {
            try {
                while (true) {
                    val next = unsent.entries.firstOrNull() ?: break
                    val (current, selection) = next.key to next.value
                    unsent.remove(current)
                    try {
                        onSession(send(current, selection))
                    } catch (cancellation: CancellationException) {
                        throw cancellation
                    } catch (failure: Throwable) {
                        _state.update { it.copy(error = failure.message ?: current.fallback) }
                    }
                    // The server's answer (or its refusal) is now what shows, unless a newer pick waits.
                    if (current !in unsent) setPending(current, null)
                }
            } finally {
                unsent.clear()
                _state.update { it.copy(pendingModel = null, pendingMode = null, pendingApproval = null, switching = false) }
            }
        }
    }

    private suspend fun send(field: ConfigField, value: String): Session = when (field) {
        ConfigField.MODEL -> api.nativeSetModel(sessionId, value)
        ConfigField.MODE -> api.nativeSetMode(sessionId, value)
        ConfigField.APPROVAL -> api.nativeSetApproval(sessionId, value)
    }

    private fun setPending(field: ConfigField, value: String?) {
        _state.update {
            when (field) {
                ConfigField.MODEL -> it.copy(pendingModel = value)
                ConfigField.MODE -> it.copy(pendingMode = value)
                ConfigField.APPROVAL -> it.copy(pendingApproval = value)
            }
        }
    }

    private enum class ConfigField(val fallbackKey: String) {
        MODEL("sessionDetail.switchModel"),
        MODE("sessionDetail.switchMode"),
        APPROVAL("sessionDetail.switchApproval"),
        ;

        val fallback: String get() = L10n.uiText(fallbackKey)
    }
}
