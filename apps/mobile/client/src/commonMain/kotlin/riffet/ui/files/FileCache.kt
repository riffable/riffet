package riffet.ui.files

import riffet.contracts.FileEntry
import riffet.contracts.FilePreview

/**
 * What the files panel last saw, kept for the life of the process.
 *
 * The panel is torn down whenever it closes, so without this every visit started from an empty
 * tree and a spinner. A cached listing or preview is shown at once and then revalidated: agents
 * edit files while the reader is away, so a cached copy is only ever a placeholder for the fresh one.
 */
object FileCache {
    class Listing(val entries: List<FileEntry>, val hasMore: Boolean)

    private val listings = HashMap<String, Listing>()
    private val directories = HashMap<String, String>()
    private val previews = LinkedHashMap<String, FilePreview>()

    fun listing(projectId: String, path: String): Listing? = listings[key(projectId, path)]

    fun putListing(projectId: String, path: String, listing: Listing) {
        listings[key(projectId, path)] = listing
    }

    /** The directory the reader was in, so reopening the panel lands there again. */
    fun directory(projectId: String): String = directories[projectId].orEmpty()

    fun putDirectory(projectId: String, path: String) {
        directories[projectId] = path
    }

    fun preview(projectId: String, path: String): FilePreview? = previews[key(projectId, path)]

    fun putPreview(projectId: String, path: String, preview: FilePreview) {
        val key = key(projectId, path)
        previews.remove(key)
        previews[key] = preview
        while (previews.size > MAX_PREVIEWS) previews.remove(previews.keys.first())
    }

    private fun key(projectId: String, path: String) = "$projectId\u0000$path"

    /** Previews hold whole file bodies; listings are small and are kept without a bound. */
    private const val MAX_PREVIEWS = 12
}
