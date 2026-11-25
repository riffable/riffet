package riffet.ui.pickers

import kotlin.time.Clock
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import riffet.contracts.MODEL_PICKER_BUDGET_STORED_MAX_AGE_MS
import riffet.contracts.MODEL_PICKER_BUDGET_STORED_SCOPES
import riffet.contracts.NativeBackendCatalogEntry
import riffet.contracts.RiffetJson
import riffet.shared.AppPreferences

/**
 * The last usable model list per scope (`backend|project|provider`), kept on this device so the model
 * picker paints a switched-to agent or provider at once and replaces it with the fresh read (the web's
 * `catalog-cache.ts`). Only usable lists are kept: one that failed, is unavailable or came back empty is
 * something to report, not to replay.
 *
 * At most [MODEL_PICKER_BUDGET_STORED_SCOPES] scopes, least recently written dropped first; a scope
 * older than [MODEL_PICKER_BUDGET_STORED_MAX_AGE_MS] is not shown. A corrupt stored value reads as absent.
 */
class ModelCatalogStore internal constructor(
    private val preferences: AppPreferences,
    private val now: () -> Long,
) {
    constructor(preferences: AppPreferences) : this(preferences, { Clock.System.now().toEpochMilliseconds() })

    @Serializable
    private class Entry(val scope: String, val at: Long, val catalog: NativeBackendCatalogEntry)

    /** Decoded once per store: a picker saves each provider it reads, and re-reading the stored value every time costs more than writing it. */
    private var entries: List<Entry>? = null

    private fun read(): List<Entry> {
        val decoded = entries ?: preferences.string(KEY)
            ?.let { text -> runCatching { RiffetJson.instance.decodeFromString<List<Entry>>(text) }.getOrNull() }
            .orEmpty()
        val oldest = now() - MODEL_PICKER_BUDGET_STORED_MAX_AGE_MS
        return decoded.filter { it.at >= oldest }.also { entries = it }
    }

    /** Every kept list by scope, read once: a picker looks several up while it paints. */
    fun loadAll(): Map<String, NativeBackendCatalogEntry> = read().associate { it.scope to it.catalog }

    fun save(scope: String, catalog: NativeBackendCatalogEntry) {
        if (!catalog.available || catalog.models.isEmpty()) return
        val kept = (read().filter { it.scope != scope } + Entry(scope, now(), catalog)).takeLast(MODEL_PICKER_BUDGET_STORED_SCOPES)
        entries = kept
        preferences.setString(KEY, RiffetJson.instance.encodeToString(kept))
    }

    private companion object {
        const val KEY = "model-catalogs-v1"
    }
}
