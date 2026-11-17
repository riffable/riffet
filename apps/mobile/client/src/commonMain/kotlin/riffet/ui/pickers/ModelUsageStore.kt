package riffet.ui.pickers

import kotlin.time.Clock
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import riffet.contracts.MODEL_PICKER_BUDGET_STORED_MAX_AGE_MS
import riffet.contracts.MODEL_PICKER_BUDGET_STORED_SCOPES
import riffet.contracts.NativeBackendUsage
import riffet.contracts.RiffetJson
import riffet.shared.AppPreferences

/**
 * The last successful quota/load read per scope (`backend|project|provider`), kept on this device so
 * the model picker shows figures at once and replaces them with the fresh read.
 *
 * At most [MODEL_PICKER_BUDGET_STORED_SCOPES] scopes, least recently written dropped first; a scope
 * older than [MODEL_PICKER_BUDGET_STORED_MAX_AGE_MS] is not shown. A failed or corrupt stored value reads as absent.
 */
class ModelUsageStore internal constructor(
    private val preferences: AppPreferences,
    private val now: () -> Long,
) {
    constructor(preferences: AppPreferences) : this(preferences, { Clock.System.now().toEpochMilliseconds() })

    @Serializable
    private class Entry(val scope: String, val at: Long, val usage: NativeBackendUsage)

    private fun read(): List<Entry> {
        val text = preferences.string(KEY) ?: return emptyList()
        val entries = runCatching { RiffetJson.instance.decodeFromString<List<Entry>>(text) }.getOrNull() ?: return emptyList()
        val oldest = now() - MODEL_PICKER_BUDGET_STORED_MAX_AGE_MS
        return entries.filter { it.at >= oldest }
    }

    fun load(scope: String): NativeBackendUsage? = read().firstOrNull { it.scope == scope }?.usage

    fun save(scope: String, usage: NativeBackendUsage) {
        val kept = read().filter { it.scope != scope } + Entry(scope, now(), usage)
        val bounded = kept.takeLast(MODEL_PICKER_BUDGET_STORED_SCOPES)
        preferences.setString(KEY, RiffetJson.instance.encodeToString(bounded))
    }

    /** Forgets every stored figure, e.g. after a provider credential changed. */
    fun clear() = preferences.setString(KEY, null)

    private companion object {
        const val KEY = "model-usage-v1"
    }
}
