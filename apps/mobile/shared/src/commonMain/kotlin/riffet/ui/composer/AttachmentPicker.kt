package riffet.ui.composer

import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.ImageBitmap

/**
 * The attachment source seam. Picking a file and shrinking an image are the two things Compose
 * Multiplatform cannot express in `commonMain` without a platform API, so they are one `expect`
 * `@Composable` factory with three actuals, exactly like `createQrScanner()`/`RiffetSystemBars`.
 *
 * **Downscaling happens inside the picker, on purpose.** The server caps an attachment at 24 MiB
 * (`MAX_ATTACHMENT_BYTES` in `apps/server/src/workspace/index.ts`) and takes it as base64, which is
 * another third on top. A modern phone photo is 8–15 MiB and 4000–8000 px on its long edge, so the
 * unmodified bytes are both near that cap and far more pixels than the transcript will ever show —
 * decoding one to scale it can exhaust a low-end device's heap. The Android actual therefore
 * decodes with an `inSampleSize` that lands the long edge near [MAX_UPLOAD_EDGE] px and re-encodes,
 * which is why the 24 MiB limit is not hit: what leaves the phone is a few hundred KiB, not the
 * original. Image pixel dimensions are declared from the **downscaled** bitmap, because that is
 * what the server actually stores.
 */

/**
 * A file the user picked, already prepared for upload.
 *
 * [thumbnail] is best-effort local pixels for an image. Generic files and images the host cannot
 * decode still upload their original bytes, with no thumbnail.
 */
data class PickedAttachment(
    override val name: String,
    override val mimeType: String,
    override val bytes: ByteArray,
    override val width: Int? = null,
    override val height: Int? = null,
    val thumbnail: ImageBitmap? = null,
) : UploadableAttachment

/** A launcher for the host's document picker. */
interface AttachmentPicker {
    /**
     * False when this host has no picker (the JVM test target). The composer hides the attach
     * affordance rather than showing a button that cannot do anything.
     */
    val available: Boolean

    fun launch()
}

/**
 * Remembers this host's picker. [onPicked] is called once per completed pick with every selected
 * file. A failed selection calls [onError] and publishes no partial batch.
 */
@Composable
expect fun rememberAttachmentPicker(
    onError: (String) -> Unit = {},
    onPicked: (List<PickedAttachment>) -> Unit,
): AttachmentPicker

const val MAX_ATTACHMENTS_PER_MESSAGE = 20

/**
 * Why a whole picked batch was refused. The message is resolved by the caller, which owns the
 * Compose resource catalog; carrying a string here would freeze the source locale into this
 * platform seam.
 */
internal sealed interface AttachmentIntakeError {
    data class TooMany(val limit: Int) : AttachmentIntakeError
    data class TooLarge(val name: String) : AttachmentIntakeError
}

/** Same whole-batch admission as the web: generic files share the image count and byte limits. */
internal fun attachmentIntakeError(files: List<PickedAttachment>, existing: Int): AttachmentIntakeError? {
    if (existing + files.size > MAX_ATTACHMENTS_PER_MESSAGE) return AttachmentIntakeError.TooMany(MAX_ATTACHMENTS_PER_MESSAGE)
    return files.firstOrNull { it.bytes.size > MAX_ATTACHMENT_BYTES }?.let { AttachmentIntakeError.TooLarge(it.name) }
}

/** Shared no-picker used by hosts that cannot launch one. */
internal class UnavailableAttachmentPicker : AttachmentPicker {
    override val available: Boolean = false
    override fun launch() = Unit
}

/** Image/file clipboard items; an empty result leaves ordinary text to the terminal. */
expect suspend fun readClipboardAttachments(): List<PickedAttachment>
