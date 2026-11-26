package riffet.shared

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient
import kotlinx.serialization.builtins.ListSerializer
import org.jetbrains.compose.resources.getString
import riffet.contracts.RiffetJson
import riffet.ui.timeline.platformNowMillis
import riffet_mobile.shared.generated.resources.*
import kotlin.time.TimeSource

/**
 * Where a finished download landed.
 *
 * [location] is for the reader ("下载/Riffet/report.pdf"). [uri] is what the *system* needs to open
 * it again — a `content://` URI on Android — and is null when the platform has no such handle.
 */
data class SavedDownload(val location: String, val uri: String? = null, val mimeType: String? = null)

/**
 * A file being written where the user can find it. Nothing is visible until [commit]; [discard]
 * removes whatever was written, after a failure or a cancel. Exactly one of the two is called.
 */
interface DownloadSink : DownloadWriter {
    suspend fun commit(): SavedDownload
    suspend fun discard()
}

/** Opens [name] for writing in the user's downloads. Throws when the platform cannot save. */
expect suspend fun createDownloadSink(name: String, mimeType: String?): DownloadSink

/** Saves bytes that are already in memory, e.g. an exported log, the way a download is saved. */
suspend fun saveDownload(name: String, mimeType: String?, bytes: ByteArray): SavedDownload {
    val sink = createDownloadSink(name, mimeType)
    try {
        sink.write(bytes, 0, bytes.size)
        return sink.commit()
    } catch (failure: Throwable) {
        sink.discardQuietly()
        throw failure
    }
}

/** Runs even in a cancelled coroutine: a cancelled download must not leave a half-written file. */
private suspend fun DownloadSink.discardQuietly() {
    withContext(NonCancellable) {
        try {
            discard()
        } catch (_: Throwable) {
        }
    }
}

/** False where [saveDownload] throws (iOS today): the download buttons are hidden there. */
expect val downloadsSupported: Boolean

/** Hands a saved file to the system to open; false when nothing can (or there is no handle). */
expect fun openDownload(item: DownloadItem): Boolean

/** Deletes a saved file from the device; false when it was already gone or cannot be deleted. */
expect suspend fun deleteDownload(item: DownloadItem): Boolean

internal const val APK_MIME_TYPE = "application/vnd.android.package-archive"

/**
 * The stable marker a download row carries when the process died mid-transfer. The UI renders it in
 * the current language; older rows may still hold the Chinese text, which the UI maps too.
 */
internal const val INTERRUPTED_DOWNLOAD_ERROR = "download.interrupted"

/** Older download records may have the server's generic binary/ZIP MIME type. */
internal fun downloadMimeType(name: String, supplied: String?): String =
    if (name.endsWith(".apk", ignoreCase = true)) APK_MIME_TYPE else supplied ?: "application/octet-stream"

enum class DownloadState { RUNNING, SAVED, FAILED, CANCELLED }

/**
 * One download, as the downloads page lists it. Kept across launches (except the bytes, which are
 * in the saved file); a download still running when the process died comes back as failed.
 */
@Serializable
data class DownloadItem(
    /**
     * The project and the path inside it: asking for the same file again reuses the row, unless
     * the row holds a saved file. That row stays under its own id so the file can still be deleted.
     */
    val id: String,
    val projectId: String,
    val path: String,
    val name: String,
    val state: DownloadState,
    val received: Long = 0,
    /** Null while the server has not declared a length. */
    val total: Long? = null,
    val location: String? = null,
    val uri: String? = null,
    val mimeType: String? = null,
    val error: String? = null,
    val startedAt: Long,
    val finishedAt: Long? = null,
    /** Which start of the row this is, so a cancelled run cannot finish the row started after it. */
    @Transient val run: Long = 0,
    /** Uploaded attachments have their own route and can be retried without a project path. */
    val attachmentId: String? = null,
    /** A team member's `files/` entry: [path] is inside that folder, and [projectId] is empty. */
    val memberId: String? = null,
)

/** What the in-app notice says when a download starts or ends. */
data class DownloadEvent(val item: DownloadItem)

/**
 * Every download of this app, in one place the downloads page reads: started from a transcript row
 * or the files panel, run on their own scope so leaving the screen does not stop them, and kept as
 * a history the reader can open, retry, delete or clear.
 */
class DownloadCenter internal constructor(
    private val preferences: AppPreferences?,
    private val openSink: suspend (name: String, mimeType: String?) -> DownloadSink = ::createDownloadSink,
    private val deleteSaved: suspend (DownloadItem) -> Boolean = ::deleteDownload,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /** Started from the UI, cancelled from [deleteFile]'s background coroutine too: changed only by compare-and-set. */
    private val jobs = MutableStateFlow(Jobs())

    private val _items = MutableStateFlow(restore())
    /** Newest first. */
    val items: StateFlow<List<DownloadItem>> = _items.asStateFlow()

    private val _events = MutableSharedFlow<DownloadEvent>(extraBufferCapacity = 8)
    /** A download started, saved or failed; the app shows a short notice for each. */
    val events: SharedFlow<DownloadEvent> = _events.asSharedFlow()

    /** Downloads [path] of [projectId]; asking again while it runs does nothing. */
    fun start(api: RiffetApi, projectId: String, path: String) = start(api, projectId, path, null, null)

    fun startAttachment(api: RiffetApi, attachmentId: String, name: String) = start(api, "", "", attachmentId, name)

    /** Downloads [path] of a team member's `files/` folder. */
    fun startMemberFile(api: RiffetApi, memberId: String, path: String) = start(api, "", path, null, null, memberId)

    private fun start(
        api: RiffetApi, projectId: String, path: String, attachmentId: String?, name: String?, memberId: String? = null,
    ) {
        val id = when {
            attachmentId != null -> "attachment\u0000$attachmentId"
            memberId != null -> "member\u0000$memberId\u0000$path"
            else -> "$projectId\u0000$path"
        }
        lateinit var item: DownloadItem
        val job = scope.launch(start = CoroutineStart.LAZY) { run(api, item) }
        val run = claim(id, job) ?: return
        item = DownloadItem(
            id = id,
            projectId = projectId,
            path = path,
            // No name to show yet (UI copy is resolved there); the path normally supplies one.
            name = name ?: path.substringAfterLast('/'),
            state = DownloadState.RUNNING,
            startedAt = platformNowMillis(),
            run = run,
            attachmentId = attachmentId,
            memberId = memberId,
        )
        _items.update { list ->
            listOf(item) + list.mapNotNull {
                when {
                    it.id != id -> it
                    it.state == DownloadState.SAVED -> it.copy(id = "$id\u0000${it.startedAt}")
                    else -> null
                }
            }
        }
        _events.tryEmit(DownloadEvent(item))
        job.invokeOnCompletion { cause ->
            jobs.update { current -> if (current.byId[id]?.run == run) current.copy(byId = current.byId - id) else current }
            if (cause is CancellationException) finish(id, run) { it.copy(state = DownloadState.CANCELLED) }
        }
        job.start()
    }

    /** Registers [job] as [id]'s run and returns its number; null, cancelling it, while another runs. */
    private fun claim(id: String, job: Job): Long? {
        while (true) {
            val current = jobs.value
            if (current.byId[id]?.job?.let { !it.isCancelled && !it.isCompleted } == true) {
                job.cancel()
                return null
            }
            val next = Jobs(current.next + 1, current.byId + (id to Running(current.next, job)))
            if (jobs.compareAndSet(current, next)) return current.next
        }
    }

    /** Starts [item] again, from the beginning. */
    fun retry(api: RiffetApi, item: DownloadItem) = start(api, item.projectId, item.path, item.attachmentId, item.name, item.memberId)

    fun cancel(id: String) {
        jobs.value.byId[id]?.job?.cancel()
    }

    /** Takes the row off the list; the saved file stays where it is. */
    fun remove(id: String) {
        cancel(id)
        change { list -> list.filterNot { it.id == id } }
    }

    /** Deletes the saved file and the row with it; a file that could not be deleted keeps its row. */
    fun deleteFile(item: DownloadItem) {
        if (item.state != DownloadState.SAVED || _items.value.firstOrNull { it.id == item.id } != item) return
        // Reserve this row like a download, so a retry cannot overwrite the file being deleted.
        val job = scope.launch(start = CoroutineStart.LAZY) {
            if (_items.value.firstOrNull { it.id == item.id } != item) return@launch
            val error = try {
                if (deleteSaved(item)) null else getString(Res.string.downloads_delete_failed)
            } catch (cancellation: CancellationException) {
                currentCoroutineContext().ensureActive()
                // Dismissing the system file-access prompt cancels this deletion, not the saved
                // download. Clear a previous failure so cancellation does not keep advertising it.
                change { list -> list.map { if (it == item) it.copy(error = null) else it } }
                return@launch
            } catch (failure: Throwable) {
                failure.message?.takeIf { it.isNotBlank() } ?: getString(Res.string.downloads_delete_failed)
            }
            change { list ->
                if (error == null) list.filterNot { it == item }
                else list.map { if (it == item) it.copy(error = error) else it }
            }
        }
        val run = claim(item.id, job) ?: return
        job.invokeOnCompletion {
            jobs.update { current -> if (current.byId[item.id]?.run == run) current.copy(byId = current.byId - item.id) else current }
        }
        job.start()
    }

    /** Clears every row that is no longer running. */
    fun clearFinished() {
        change { list -> list.filter { it.state == DownloadState.RUNNING } }
    }

    private suspend fun run(api: RiffetApi, item: DownloadItem) {
        val gate = DownloadProgressGate()
        var sink: DownloadSink? = null
        try {
            val onProgress: (Long, Long?) -> Unit = { received, total ->
                if (gate.accepts(received, total)) update(item.id, item.run) { it.copy(received = received, total = total) }
            }
            val open: suspend (String, String?) -> DownloadWriter = { name, mimeType ->
                // Not cancellable: a sink opened by a cancelled call would never reach [sink] to be discarded.
                withContext(NonCancellable) { openSink(name, mimeType).also { sink = it } }
            }
            val file = when {
                item.attachmentId != null -> api.downloadAttachment(item.attachmentId, item.name, onProgress, open)
                item.memberId != null -> api.downloadMemberFile(item.memberId, item.path, onProgress, open)
                else -> api.downloadFile(item.projectId, item.path, onProgress, open)
            }
            val saved = checkNotNull(sink).commit()
            sink = null
            finish(item.id, item.run) {
                it.copy(
                    state = DownloadState.SAVED,
                    name = file.name,
                    received = file.size,
                    total = file.size,
                    location = saved.location,
                    uri = saved.uri,
                    mimeType = saved.mimeType,
                )
            }
        } catch (cancellation: CancellationException) {
            sink?.discardQuietly()
            // The completion handler in [start] marks the row; it also sees a run cancelled before it began.
            throw cancellation
        } catch (failure: Throwable) {
            sink?.discardQuietly()
            val error = failure.message ?: getString(Res.string.downloads_unknown_error)
            finish(item.id, item.run) { it.copy(state = DownloadState.FAILED, error = error) }
        }
    }

    private fun update(id: String, run: Long, transform: (DownloadItem) -> DownloadItem) {
        _items.update { list -> list.map { if (it.id == id && it.run == run) transform(it) else it } }
    }

    private fun finish(id: String, run: Long, transform: (DownloadItem) -> DownloadItem) {
        val next = change { list ->
            list.map { if (it.id == id && it.run == run && it.state == DownloadState.RUNNING) transform(it).copy(finishedAt = platformNowMillis()) else it }
        }
        next.firstOrNull { it.id == id && it.run == run }?.let { _events.tryEmit(DownloadEvent(it)) }
    }

    /** A change worth keeping: written through, newest [HISTORY_LIMIT] rows. */
    private fun change(transform: (List<DownloadItem>) -> List<DownloadItem>): List<DownloadItem> {
        val next = _items.updateAndGet { transform(it).take(HISTORY_LIMIT) }
        preferences?.let { stored ->
            runCatching { stored.setString(PREFERENCE_KEY, RiffetJson.instance.encodeToString(ListSerializer(DownloadItem.serializer()), next)) }
        }
        return next
    }

    private fun restore(): List<DownloadItem> {
        val text = preferences?.string(PREFERENCE_KEY) ?: return emptyList()
        val stored = runCatching { RiffetJson.instance.decodeFromString(ListSerializer(DownloadItem.serializer()), text) }.getOrNull()
            ?: return emptyList()
        // Nothing survives the process that ran it.
        return stored.map { if (it.state == DownloadState.RUNNING) it.copy(state = DownloadState.FAILED, error = INTERRUPTED_DOWNLOAD_ERROR) else it }
    }

    private fun MutableStateFlow<List<DownloadItem>>.updateAndGet(transform: (List<DownloadItem>) -> List<DownloadItem>): List<DownloadItem> {
        while (true) {
            val current = value
            val next = transform(current)
            if (compareAndSet(current, next)) return next
        }
    }

    private class Running(val run: Long, val job: Job)

    /** The run of each row still going, and the number the next start gets. */
    private data class Jobs(val next: Long = 1, val byId: Map<String, Running> = emptyMap())

    companion object {
        /** The app's downloads; the history is kept in the local preferences. */
        val shared: DownloadCenter by lazy { DownloadCenter(createAppPreferences()) }

        private const val PREFERENCE_KEY = "downloads"
        private const val HISTORY_LIMIT = 100
    }
}

/** The whole percent done, or null while the total is unknown. */
internal fun downloadPercent(received: Long, total: Long?): Int? =
    total?.takeIf { it > 0 }?.let { ((received * 100) / it).toInt().coerceIn(0, 100) }

/** One report per half megabyte while the length is unknown: there is no percentage to move. */
private const val UNKNOWN_TOTAL_STEP = 512L * 1024

/**
 * The shortest gap between two progress updates. A megabyte arrives in ~128 reads, and repainting
 * the downloads page on each would be busy work; a few updates a second already looks live.
 */
private const val PROGRESS_INTERVAL_MS = 250L

/** A monotonic clock, so the cadence never depends on the wall clock being sane. */
private fun monotonicMillis(): () -> Long {
    val origin = TimeSource.Monotonic.markNow()
    return { origin.elapsedNow().inWholeMilliseconds }
}

/**
 * Which of the download loop's callbacks are worth an update: something new to say (a new whole
 * percent, or another [UNKNOWN_TOTAL_STEP] bytes when the length is unknown) *and* at least
 * [intervalMillis] since the last one. Stateful but pure, with the clock a parameter, so the
 * cadence is a unit test.
 */
internal class DownloadProgressGate(
    private val intervalMillis: Long = PROGRESS_INTERVAL_MS,
    private val nowMillis: () -> Long = monotonicMillis(),
) {
    private var lastPercent = -1
    private var lastUnknownStep = 0L
    private var lastReportAt = Long.MIN_VALUE

    fun accepts(received: Long, total: Long?): Boolean {
        val percent = downloadPercent(received, total)
        val news = if (percent == null) received - lastUnknownStep >= UNKNOWN_TOTAL_STEP else percent != lastPercent
        if (!news) return false
        val now = nowMillis()
        // Too soon: leave the state alone, so the *next* callback — with a later percentage — is the
        // one that gets reported rather than this one being silently counted as said.
        if (lastReportAt != Long.MIN_VALUE && now - lastReportAt < intervalMillis) return false
        lastReportAt = now
        if (percent == null) lastUnknownStep = received else lastPercent = percent
        return true
    }
}

/** Hands a saved file to the system share sheet; false where there is none or it cannot be shared. */
expect fun shareSavedFile(saved: SavedDownload, title: String): Boolean
