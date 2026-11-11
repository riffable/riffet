package riffet.ui.composer

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import riffet.shared.R
import riffet.shared.AppLanguages
import riffet.shared.RiffetAndroid
import java.io.ByteArrayOutputStream
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Android attachment picker and image downscaler.
 *
 * `OpenMultipleDocuments` accepts every ordinary file, including archives and documents,
 * and gives a stable, readable URI whose
 * `DISPLAY_NAME` can be shown on the chip.
 *
 * Downscaling is documented on the `expect` declaration in commonMain; the short version is that a
 * decoded modern photo at full size can exhaust a low-end heap and its bytes base64-encode past the
 * server's limit, so the image is sampled during decode and re-encoded at [MAX_UPLOAD_EDGE].
 */
@Composable
actual fun rememberAttachmentPicker(onError: (String) -> Unit, onPicked: (List<PickedAttachment>) -> Unit): AttachmentPicker {
    val context = RiffetAndroid.requireContext()
    val scope = rememberCoroutineScope()
    val latest = rememberUpdatedState(onPicked)
    val latestError = rememberUpdatedState(onError)
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        if (uris.size > MAX_ATTACHMENTS_PER_MESSAGE) {
            latestError.value(AppLanguages.localize(context).getString(R.string.host_attachment_batch_limit, MAX_ATTACHMENTS_PER_MESSAGE))
            return@rememberLauncherForActivityResult
        }
        scope.launch {
            try {
                // Refuse the whole selection if a single file is unreadable or over the limit.
                val picked = withContext(Dispatchers.IO) { uris.map { readPickedAttachment(context, it) } }
                latest.value(picked)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Exception) {
                latestError.value(error.message ?: AppLanguages.localize(context).getString(R.string.host_attachment_read_failed))
            }
        }
    }
    return remember(launcher) {
        object : AttachmentPicker {
            override val available: Boolean = true

            override fun launch() = launcher.launch(
                arrayOf("*/*"),
            )
        }
    }
}

private class PreparedImage(
    val bytes: ByteArray,
    val mimeType: String,
    val width: Int,
    val height: Int,
    val thumbnail: ImageBitmap,
)

/**
 * Reads one Uri into the same prepared attachment the picker produces, including the image
 * downscale. The quick chat entry uses it for an `ACTION_SEND` image.
 */
fun readPickedAttachment(context: Context, uri: Uri): PickedAttachment {
    val resolver = context.contentResolver
    val declaredType = (resolver.getType(uri) ?: "").substringBefore(';').trim().lowercase()
    val mimeType = declaredType.takeIf { Regex("^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+$").matches(it) } ?: "application/octet-stream"
    val name = displayName(context, uri) ?: "attachment"
    val raw = resolver.openInputStream(uri)?.use { input ->
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(8192)
        var total = 0
        while (true) {
            val count = input.read(buffer, 0, minOf(buffer.size, MAX_ATTACHMENT_BYTES + 1 - total))
            if (count < 0) break
            total += count
            if (total > MAX_ATTACHMENT_BYTES) {
                throw IllegalArgumentException(AppLanguages.localize(context).getString(R.string.host_attachment_too_large, name))
            }
            output.write(buffer, 0, count)
        }
        output.toByteArray()
    } ?: throw IllegalArgumentException(AppLanguages.localize(context).getString(R.string.host_attachment_unreadable, name))
    if (mimeType.startsWith("image/")) {
        downscaleImage(raw, mimeType)?.let { prepared ->
            return PickedAttachment(
                name = name,
                mimeType = prepared.mimeType,
                bytes = prepared.bytes,
                width = prepared.width,
                height = prepared.height,
                thumbnail = prepared.thumbnail,
            )
        }
    }
    return PickedAttachment(name, mimeType, raw)
}

private fun displayName(context: Context, uri: Uri): String? = runCatching {
    context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) cursor.getString(0) else null
    }
}.getOrNull()

/**
 * Decode with `inSampleSize` (so the full-size bitmap is never materialised), scale the long edge
 * to [MAX_UPLOAD_EDGE], and re-encode. Returns null when the bytes are not a decodable bitmap, in
 * which case the caller keeps the original file.
 */
private fun downscaleImage(raw: ByteArray, mimeType: String): PreparedImage? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(raw, 0, raw.size, bounds)
    val sourceWidth = bounds.outWidth
    val sourceHeight = bounds.outHeight
    if (sourceWidth <= 0 || sourceHeight <= 0) return null

    // Halve until the sampled long edge is still at least the target, then scale exactly below.
    var sample = 1
    while (max(sourceWidth, sourceHeight) / (sample * 2) >= MAX_UPLOAD_EDGE) sample *= 2
    val decoded = runCatching {
        BitmapFactory.decodeByteArray(raw, 0, raw.size, BitmapFactory.Options().apply { inSampleSize = sample })
    }.getOrNull() ?: return null

    val longEdge = max(decoded.width, decoded.height)
    val scaled = if (longEdge > MAX_UPLOAD_EDGE) {
        val ratio = MAX_UPLOAD_EDGE.toFloat() / longEdge
        Bitmap.createScaledBitmap(
            decoded,
            (decoded.width * ratio).roundToInt().coerceAtLeast(1),
            (decoded.height * ratio).roundToInt().coerceAtLeast(1),
            true,
        )
    } else {
        decoded
    }

    val output = ByteArrayOutputStream()
    // PNG keeps transparency for screenshots; everything else becomes JPEG, which is where the
    // size actually falls from megabytes to a few hundred KiB.
    val format = if (mimeType == "image/png") Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG
    if (!scaled.compress(format, 85, output)) return null
    return PreparedImage(
        bytes = output.toByteArray(),
        mimeType = if (format == Bitmap.CompressFormat.PNG) "image/png" else "image/jpeg",
        width = scaled.width,
        height = scaled.height,
        thumbnail = scaled.asImageBitmap(),
    )
}

actual suspend fun readClipboardAttachments(): List<PickedAttachment> {
    val context = RiffetAndroid.requireContext()
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
    val clip = clipboard.primaryClip ?: return emptyList()
    val uris = (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }.distinct()
    require(uris.size <= MAX_ATTACHMENTS_PER_MESSAGE) { AppLanguages.localize(context).getString(R.string.host_attachment_batch_limit, MAX_ATTACHMENTS_PER_MESSAGE) }
    return withContext(Dispatchers.IO) { uris.map { readPickedAttachment(context, it) } }
}
