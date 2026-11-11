package riffet.stats

import riffet.cache.LocalFiles
import riffet.contracts.RiffetJson
import riffet.contracts.StatsDashboard

/**
 * The last dashboard response, kept on the device the way transcripts are: one replace-whole-file
 * write under the app's private storage. A corrupt file reads as nothing so the page falls back
 * to the network (or the empty state) instead of crashing on yesterday's shape.
 */
class StatsDashboardCache(
    private val files: LocalFiles,
    private val path: String = "stats/dashboard.json",
) {
    fun load(): StatsDashboard? {
        val text = files.read(path) ?: return null
        return runCatching { RiffetJson.instance.decodeFromString(StatsDashboard.serializer(), text) }.getOrNull()
    }

    fun save(dashboard: StatsDashboard) {
        files.write(path, RiffetJson.instance.encodeToString(StatsDashboard.serializer(), dashboard))
    }
}
