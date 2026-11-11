package riffet.shared

import android.content.ClipData
import android.content.ContentResolver
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileNotFoundException
import java.io.FileOutputStream
import java.io.OutputStream
import java.util.UUID

private const val FOLDER = "Riffet"

/**
 * Android 10+ writes into the shared Downloads collection through MediaStore, which needs no
 * permission; the row stays pending, invisible to other apps, until [DownloadSink.commit]. Older
 * versions would need WRITE_EXTERNAL_STORAGE for that folder, so they save into the app's own
 * Downloads directory instead.
 */
actual suspend fun createDownloadSink(name: String, mimeType: String?): DownloadSink = withContext(Dispatchers.IO) {
    val context = RiffetAndroid.requireContext()
    val type = downloadMimeType(name, mimeType)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        val resolver = context.contentResolver
        fun open(displayName: String): Pair<Uri, OutputStream> {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, displayName)
                put(MediaStore.Downloads.MIME_TYPE, type)
                put(MediaStore.Downloads.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/$FOLDER")
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: error(AppLanguages.localize(context).getString(R.string.host_download_create_failed))
            return try {
                uri to (resolver.openOutputStream(uri) ?: error(AppLanguages.localize(context).getString(R.string.host_download_write_failed)))
            } catch (failure: Throwable) {
                resolver.delete(uri, null, null)
                throw failure
            }
        }
        val (uri, stream) = try {
            open(name)
        } catch (failure: Exception) {
            // MediaStore tries only 32 numbered names. An often-downloaded APK can exhaust them;
            // retry that conflict with a unique stem without replacing any existing file.
            val collision = generateSequence<Throwable>(failure) { it.cause }
                .any { it.message?.contains("Failed to build unique file", ignoreCase = true) == true ||
                    it.message?.contains("Failed to create unique file", ignoreCase = true) == true }
            if (!collision) throw failure
            val extension = name.substringAfterLast('.', "").takeIf { it.isNotEmpty() }?.let { ".$it" }.orEmpty()
            val stem = name.removeSuffix(extension)
            open("$stem-${UUID.randomUUID()}$extension")
        }
        StreamDownloadSink(
            stream,
            onCommit = {
                resolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
                // MediaStore may have added a suffix to avoid a duplicate name. Keep its actual
                // name so a later system file-picker authorization identifies the right download.
                val savedName = runCatching { downloadMetadata(resolver, uri)?.name }.getOrNull() ?: name
                // The MediaStore row is also the handle the downloads page opens and deletes the file with.
                // `location` is a path-like record shown beside the download, not UI copy: the
                // Chinese segment is kept verbatim so existing saved records and this one agree.
                SavedDownload(location = "下载/$FOLDER/$savedName", uri = uri.toString(), mimeType = type)
            },
            onDiscard = { resolver.delete(uri, null, null) },
        )
    } else {
        val parent = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
            ?: error(AppLanguages.localize(context).getString(R.string.host_download_dir_unavailable))
        val directory = File(parent, FOLDER).apply { mkdirs() }.canonicalFile
        require(name.isNotBlank() && name != "." && name != ".." && File(name).name == name) {
            AppLanguages.localize(context).getString(R.string.host_download_invalid_name)
        }
        // Distinct download records must never share a path: deleting an older record would
        // otherwise delete a newer same-name file. createNewFile reserves the name atomically.
        var file = File(directory, name)
        var suffix = 1
        val extension = file.extension.takeIf { it.isNotEmpty() }?.let { ".$it" } ?: ""
        val stem = name.removeSuffix(extension)
        while (!file.createNewFile()) file = File(directory, "$stem (${suffix++})$extension")
        val stream = try {
            FileOutputStream(file)
        } catch (failure: Throwable) {
            file.delete()
            throw failure
        }
        StreamDownloadSink(
            stream,
            // Legacy paths are converted to a scoped FileProvider URI when opened.
            onCommit = { SavedDownload(location = file.absolutePath, uri = null, mimeType = type) },
            onDiscard = { file.delete() },
        )
    }
}

/** An [OutputStream] as a [DownloadSink]. Every call blocks on storage, so each runs on [Dispatchers.IO]. */
private class StreamDownloadSink(
    stream: OutputStream,
    private val onCommit: () -> SavedDownload,
    private val onDiscard: () -> Unit,
) : DownloadSink {
    private val output = stream.buffered(SINK_BUFFER_BYTES)

    override suspend fun write(bytes: ByteArray, offset: Int, length: Int) {
        withContext(Dispatchers.IO) { output.write(bytes, offset, length) }
    }

    override suspend fun commit(): SavedDownload = withContext(Dispatchers.IO) {
        output.close()
        onCommit()
    }

    override suspend fun discard() {
        withContext(Dispatchers.IO) {
            runCatching { output.close() }
            onDiscard()
        }
    }
}

private const val SINK_BUFFER_BYTES = 64 * 1024

actual val downloadsSupported: Boolean = true

actual fun openDownload(item: DownloadItem): Boolean {
    val context = RiffetAndroid.requireContext()
    return runCatching {
        val uri = item.uri?.let(Uri::parse) ?: run {
            val file = ownedDownloadFile(item.location) ?: return false
            FileProvider.getUriForFile(context, "${context.packageName}.downloads", file)
        }
        if (uri.scheme != "content") return false
        val type = downloadMimeType(item.name, item.mimeType)
        val view = if (type == APK_MIME_TYPE) {
            Intent(context, InstallDownloadActivity::class.java).setDataAndType(uri, type)
        } else {
            Intent.createChooser(Intent(Intent.ACTION_VIEW).setDataAndType(uri, type)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                .apply { clipData = ClipData.newRawUri(item.name, uri) }, item.name)
        }
        context.startActivity(view.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION))
    }.isSuccess
}

actual fun shareSavedFile(saved: SavedDownload, title: String): Boolean {
    val context = RiffetAndroid.requireContext()
    val uri = Uri.parse(saved.uri ?: return false)
    // The grant travels with the ClipData; through the chooser `EXTRA_STREAM` alone may not carry it.
    val send = Intent(Intent.ACTION_SEND)
        .setType(saved.mimeType ?: "application/octet-stream")
        .putExtra(Intent.EXTRA_STREAM, uri)
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        .apply { clipData = ClipData.newRawUri(title, uri) }
    return runCatching { context.startActivity(Intent.createChooser(send, title).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        .isSuccess
}

actual suspend fun deleteDownload(item: DownloadItem): Boolean = withContext(Dispatchers.IO) {
    val context = RiffetAndroid.requireContext()
    item.uri?.let { savedUri ->
        val uri = Uri.parse(savedUri)
        val resolver = context.contentResolver
        val original = runCatching { downloadMetadata(resolver, uri) }.getOrNull()
        if (!verificationRequired(context, item, uri)) {
            try {
                // Content providers own deletion semantics. A MediaStore/FUSE descriptor's link
                // count is not a portable way to verify the provider's result.
                currentCoroutineContext().ensureActive()
                if (resolver.delete(uri, null, null) > 0) {
                    clearVerificationRequired(context, uri)
                    return@withContext true
                }
            } catch (_: SecurityException) {
                // An older installation may no longer own this Downloads row. Request one file.
            } catch (_: FileNotFoundException) {
                // A stale row can coexist with a file left in Downloads by an earlier deletion.
            } catch (_: IllegalArgumentException) {
                // Some providers report a stale content URI as an unknown URI.
            }
        }
        // A failed verification is also a decision for the next attempt: direct deletion could not
        // prove the file was gone, so remember the row and go straight to the picker next time.
        fun verificationFailed(message: String): Nothing {
            markVerificationRequired(context, uri)
            error(message)
        }
        val expectedName = original?.name ?: item.location?.substringAfterLast('/')?.takeIf { it.isNotBlank() } ?: item.name
        val expectedSize = original?.size ?: item.total ?: item.received.takeIf { it > 0 }
        val initial = runCatching { MediaStore.getDocumentUri(context, uri) }.getOrNull()
        val picked = DownloadDeletionPermission.select(expectedName, initial)
        if (!DocumentsContract.isDocumentUri(context, picked)) {
            verificationFailed(AppLanguages.localize(context).getString(R.string.host_download_delete_pick_original))
        }
        val selected = downloadMetadata(resolver, picked, document = true)
            ?: verificationFailed(AppLanguages.localize(context).getString(R.string.host_download_metadata_failed))
        if (selected.name != expectedName || (expectedSize != null && selected.size != expectedSize)) {
            verificationFailed(AppLanguages.localize(context).getString(R.string.host_download_mismatch_name, expectedName))
        }
        // Access granted by the picker may make the old row readable again. A genuinely missing
        // row can be recreated under a new ID, so only compare IDs while the original still exists.
        val originalStillVisible = original != null || runCatching { downloadMetadata(resolver, uri) }.getOrNull() != null
        if (originalStillVisible && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val mediaUri = runCatching { MediaStore.getMediaUri(context, picked) }.getOrNull()
            if (mediaUri != null && differentMediaItem(uri, mediaUri)) {
                verificationFailed(AppLanguages.localize(context).getString(R.string.host_download_mismatch_original))
            }
        }
        if (selected.flags and DocumentsContract.Document.FLAG_SUPPORTS_DELETE == 0) {
            verificationFailed(AppLanguages.localize(context).getString(R.string.host_download_delete_not_allowed))
        }
        currentCoroutineContext().ensureActive()
        val deleted = DocumentsContract.deleteDocument(resolver, picked)
        if (deleted) clearVerificationRequired(context, uri) else markVerificationRequired(context, uri)
        return@withContext deleted
    }
    val file = ownedDownloadFile(item.location) ?: return@withContext false
    currentCoroutineContext().ensureActive()
    file.delete()
}

/*
 * `DownloadItem.error` persists display copy, so it carries whatever language was active when the
 * failure happened and cannot decide how the next deletion runs. The saved content URI of a row
 * whose deletion already had to go through the document picker is recorded separately, with no
 * localized text involved. URIs are keyed rather than download ids because a re-downloaded file
 * receives a new MediaStore row.
 *
 * The Chinese literals below are old persisted error values read only for compatibility; they are
 * data, not copy shown from this file.
 */
private const val LEGACY_STILL_ON_DEVICE = "文件仍在设备上"
private const val LEGACY_CANNOT_VERIFY = "无法核验"
private const val VERIFICATION_REQUIRED_KEY = "download-delete-verification-uris"
private const val VERIFICATION_REQUIRED_LIMIT = 32

private fun verificationRequired(context: Context, item: DownloadItem, uri: Uri): Boolean {
    val legacy = item.error?.let { LEGACY_STILL_ON_DEVICE in it || LEGACY_CANNOT_VERIFY in it } == true
    return legacy || uri.toString() in verificationRequiredUris(context)
}

private fun verificationRequiredUris(context: Context): List<String> =
    createAppPreferences().string(VERIFICATION_REQUIRED_KEY)
        ?.lineSequence()?.filter { it.isNotBlank() }?.toList().orEmpty()

private fun markVerificationRequired(context: Context, uri: Uri) {
    runCatching {
        val key = uri.toString()
        val uris = (verificationRequiredUris(context) - key + key).takeLast(VERIFICATION_REQUIRED_LIMIT)
        createAppPreferences().setString(VERIFICATION_REQUIRED_KEY, uris.joinToString("\n"))
    }
}

private fun clearVerificationRequired(context: Context, uri: Uri) {
    runCatching {
        val key = uri.toString()
        val uris = verificationRequiredUris(context)
        if (key in uris) createAppPreferences().setString(VERIFICATION_REQUIRED_KEY, (uris - key).joinToString("\n"))
    }
}

private data class DownloadMetadata(val name: String?, val size: Long?, val flags: Int)

private fun downloadMetadata(resolver: ContentResolver, uri: Uri, document: Boolean = false): DownloadMetadata? {
    val projection = buildList {
        add(OpenableColumns.DISPLAY_NAME)
        add(OpenableColumns.SIZE)
        if (document) add(DocumentsContract.Document.COLUMN_FLAGS)
    }.toTypedArray()
    return resolver.query(uri, projection, null, null, null)?.use { cursor ->
        if (!cursor.moveToFirst()) return@use null
        val name = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        val size = cursor.getColumnIndex(OpenableColumns.SIZE)
        val flags = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_FLAGS)
        DownloadMetadata(
            name = if (name >= 0 && !cursor.isNull(name)) cursor.getString(name) else null,
            size = if (size >= 0 && !cursor.isNull(size)) cursor.getLong(size) else null,
            flags = if (flags >= 0 && !cursor.isNull(flags)) cursor.getInt(flags) else 0,
        )
    }
}

/** A generic `external` URI and its concrete volume share IDs; table names may also differ. */
private fun differentMediaItem(original: Uri, selected: Uri): Boolean {
    if (original.authority != MediaStore.AUTHORITY || selected.authority != MediaStore.AUTHORITY) return false
    val originalId = original.lastPathSegment?.toLongOrNull() ?: return false
    val selectedId = selected.lastPathSegment?.toLongOrNull() ?: return false
    val originalVolume = original.pathSegments.firstOrNull() ?: return false
    val selectedVolume = selected.pathSegments.firstOrNull() ?: return false
    if (originalVolume == selectedVolume || originalVolume == "external" || selectedVolume == "external") {
        return originalId != selectedId
    }
    return true
}

/** Register before STARTED so the same key receives a pending picker result after recreation. */
fun registerDownloadDeletion(activity: ComponentActivity) {
    DownloadDeletionPermission.register(activity)
}

/** One system picker at a time; cancelling its caller never hands its result to another deletion. */
private object DownloadDeletionPermission {
    private val lock = Mutex()
    private var launcher: ActivityResultLauncher<Intent>? = null
    private var activity: ComponentActivity? = null
    private var pending: CompletableDeferred<Uri?>? = null

    fun register(owner: ComponentActivity) {
        val previous = activity
        if (previous != null && previous !== owner && !previous.isChangingConfigurations) {
            pending?.complete(null)
            pending = null
        }
        val registered = owner.activityResultRegistry.register(
            "riffet.download.delete", owner, ActivityResultContracts.StartActivityForResult(),
        ) { result ->
            if (activity !== owner) return@register
            val waiting = pending
            pending = null
            waiting?.complete(result.data?.data.takeIf { result.resultCode == android.app.Activity.RESULT_OK })
        }
        launcher = registered
        activity = owner
        owner.lifecycle.addObserver(LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_DESTROY && activity === owner) {
                launcher = null
                activity = null
                if (!owner.isChangingConfigurations) {
                    val waiting = pending
                    pending = null
                    waiting?.complete(null)
                }
            }
        })
    }

    suspend fun select(name: String, initial: Uri?): Uri = withContext(Dispatchers.Main.immediate) {
        lock.withLock {
            val context = RiffetAndroid.requireContext()
            check(pending == null) { AppLanguages.localize(context).getString(R.string.host_download_picker_busy) }
            val owner = activity
            check(owner != null && !owner.isFinishing && owner.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) {
                AppLanguages.localize(context).getString(R.string.host_download_picker_background)
            }
            val request = checkNotNull(launcher) { AppLanguages.localize(context).getString(R.string.host_download_picker_unavailable) }
            val waiting = CompletableDeferred<Uri?>()
            pending = waiting
            var launched = false
            try {
                Toast.makeText(owner, AppLanguages.localize(owner).getString(R.string.host_download_picker_prompt, name), Toast.LENGTH_LONG).show()
                request.launch(Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "*/*"
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                    if (initial != null) putExtra(DocumentsContract.EXTRA_INITIAL_URI, initial)
                })
                launched = true
                waiting.await() ?: throw CancellationException(AppLanguages.localize(owner).getString(R.string.host_download_delete_cancelled))
            } catch (failure: Throwable) {
                waiting.cancel()
                // A cancelled caller leaves a tombstone until the old picker returns. Otherwise
                // the fixed-key callback could authorize a later request with this selection.
                if (!launched && pending === waiting) pending = null
                throw failure
            }
        }
    }
}

/** Legacy Android downloads may only access files inside this app's download directory. */
private fun ownedDownloadFile(location: String?): File? {
    val context = RiffetAndroid.requireContext()
    val parent = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: return null
    val root = File(parent, FOLDER).canonicalFile
    val file = location?.let { File(it).canonicalFile } ?: return null
    return file.takeIf { it.isFile && it.path.startsWith(root.path + File.separator) }
}
