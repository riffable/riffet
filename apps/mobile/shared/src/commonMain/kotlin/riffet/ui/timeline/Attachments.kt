package riffet.ui.timeline

import riffet.ui.design.LocalInterfaceStyle
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.background
import androidx.compose.material3.Text
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import riffet.ui.files.htmlPreviewSupported
import io.ktor.http.encodeURLPathPart
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import org.jetbrains.compose.resources.stringResource
import riffet.core.UserAttachment
import riffet.ui.files.formatBytes
import riffet_mobile.shared.generated.resources.*

/*
 * Ported from apps/web/src/app/session/MessageAttachments.tsx.
 *
 * The part that is genuinely behaviour rather than taste is [imageBox]: a lone image is clamped to
 * a readable size, an extreme aspect ratio is *cropped* rather than squeezed into a strip, and a
 * small screenshot is never upscaled past its own pixels. Those rules keep thumbnails readable
 * when dimensions are present.
 *
 * The pixels are drawn by [AttachmentImage] (TimelineImages.kt): the same box, filled with a real
 * image through Coil, cropped with the box's own alignment. A message that carries an image with no
 * id, or an image whose bytes are gone, falls back to a chip or an honest failure label rather than
 * an empty box.
 */

/** Uniform square tile used whenever a message carries more than one image. */
private const val TILE = 72

/** Long edge of a lone image, clamped like DeepSeek Chat: extreme ratios are cropped, never squeezed. */
private const val SINGLE_LONG_EDGE = 240

/** Aspect ratios outside this band are cropped to keep a usable box. */
private const val MIN_RATIO = 0.25
private const val MAX_RATIO = 4.0

/** Where the crop keeps the content: the top of a tall image, the left of a wide one. */
internal data class ImageBox(val width: Dp, val height: Dp, val alignment: Alignment)

/**
 * One image's box: [tile] crops to a square, otherwise the natural ratio is honoured inside the
 * clamp band.
 *
 * An unknown pixel size gets a square slot. The caller keeps that slot for this row's lifetime,
 * even when metadata arrives later, so an image cannot move the surrounding transcript.
 */
internal fun imageBox(tile: Boolean, width: Long?, height: Long?): ImageBox {
    if (tile) return ImageBox(TILE.dp, TILE.dp, Alignment.Center)
    val declaredWidth = pixelEdge(width)
    val declaredHeight = pixelEdge(height)
    if (declaredWidth == null || declaredHeight == null) {
        return ImageBox(SINGLE_LONG_EDGE.dp, SINGLE_LONG_EDGE.dp, Alignment.Center)
    }
    val natural = declaredWidth.toDouble() / declaredHeight.toDouble()
    val ratio = natural.coerceIn(MIN_RATIO, MAX_RATIO)
    val boxWidth = if (ratio >= 1.0) SINGLE_LONG_EDGE.toDouble() else SINGLE_LONG_EDGE * ratio
    val boxHeight = if (ratio >= 1.0) SINGLE_LONG_EDGE / ratio else SINGLE_LONG_EDGE.toDouble()
    // Never upscale past the original pixels; a small screenshot stays small and crisp.
    val scale = minOf(1.0, declaredWidth / boxWidth, declaredHeight / boxHeight)
    return ImageBox(
        // `.toInt()` first: Compose defines `dp` on Int/Float/Double, not on Long.
        width = maxOf(1L, kotlin.math.round(boxWidth * scale).toLong()).toInt().dp,
        height = maxOf(1L, kotlin.math.round(boxHeight * scale).toLong()).toInt().dp,
        alignment = when {
            natural < MIN_RATIO -> Alignment.TopCenter
            natural > MAX_RATIO -> Alignment.CenterStart
            else -> Alignment.Center
        },
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun MessageAttachments(attachments: List<UserAttachment>) {
    if (attachments.isEmpty()) return
    // Decide gallery geometry from the receipt once. Resolving a missing MIME type must not
    // rearrange the other thumbnails after the reader has landed on the page.
    val tile = remember(attachments) { imageAttachmentCount(attachments) > 1 }
    FlowRow(
        // Right-aligned, like the bubble they belong to (`justify-end` on the web).
        horizontalArrangement = Arrangement.End,
        verticalArrangement = Arrangement.spacedBy(6.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        attachments.forEach { attachment ->
            AttachmentView(attachment, tile)
        }
    }
}

internal fun imageAttachmentCount(attachments: List<UserAttachment>): Int =
    attachments.count { it.mimeType?.startsWith("image/", ignoreCase = true) != false }

@Composable
private fun AttachmentView(attachment: UserAttachment, tile: Boolean) {
    val designMetrics = LocalInterfaceStyle.current.metrics
    val id = attachment.id
    // Older receipts may omit MIME type and name. An untyped receipt keeps its original image
    // placeholder, so resolving its metadata never grows a file chip into a thumbnail.
    var metadata by remember(attachment) { mutableStateOf<AttachmentMetadata?>(null) }
    val needsType = attachment.mimeType == null && attachment.type != "image" && !id.isNullOrEmpty()
    LaunchedEffect(attachment, id) {
        if (!needsType) return@LaunchedEffect
        metadata = fetchAttachmentMetadata(id)
    }
    val mimeType = metadata?.mimeType ?: attachment.mimeType
    // The web shows "附件" when the metadata name is just the id.
    val rawName = metadata?.name ?: attachment.name
    val name = if (rawName == id) stringResource(Res.string.timeline_attachment) else rawName

    val files = LocalFileAccess.current
    val path = attachment.path
    val isImage = mimeType?.startsWith("image/", ignoreCase = true)
        ?: (attachment.type == "image" || (needsType && attachment.type != "file"))
    // Uploaded images keep their stable id; a native CLI path is read through the project route.
    val imageSource = when {
        !id.isNullOrEmpty() -> ImageSource.Remote(id)
        path != null && files != null -> ImageSource.ProjectFile(files.projectId, path)
        else -> null
    }
    val download = files?.downloadAttachment?.takeIf { files.canDownload && !id.isNullOrEmpty() }
    val label = metadata?.size?.let { "$name · ${formatBytes(it)}" } ?: name
    var preview by remember(id) { mutableStateOf(false) }
    val fileChip: @Composable () -> Unit = {
        Chip(text = label, onClick = if (htmlPreviewSupported && !id.isNullOrEmpty()) ({ preview = true }) else download?.let { action -> { action(checkNotNull(id), name) } })
    }
    if (imageSource != null && isImage) {
        // Image geometry comes from the receipt, so delayed pixel dimensions do not resize a thumbnail.
        val box = remember(attachment, tile) { imageBox(tile, attachment.width, attachment.height) }
        AttachmentImage(
            box = box,
            source = imageSource,
            label = name,
            detail = mimeType ?: attachment.type.orEmpty(),
        )
    } else {
        fileChip()
    }
    if (preview && !id.isNullOrEmpty()) {
        Dialog(onDismissRequest = { preview = false }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
            Column(Modifier.fillMaxSize().background(TimelineTheme.colors.bg).padding(designMetrics.rowPadding), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Text(name, Modifier.weight(1f), style = TimelineTheme.type.body, color = TimelineTheme.colors.fg, maxLines = 1)
                    Chip(stringResource(Res.string.timeline_close), onClick = { preview = false })
                }
                Box(Modifier.weight(1f).fillMaxWidth()) {
                    ServerContentPreview("/api/attachments/${id.encodeURLPathPart()}", modifier = Modifier.fillMaxSize())
                }
                if (download != null) Chip(stringResource(Res.string.timeline_download), onClick = { download(id, name) })
            }
        }
    }
}

/** The agent's own image block: inline data or the server's session blob path. */
@Composable
internal fun ImageRow(src: String) {
    val mimeType = src.substringAfter("data:", "").substringBefore(";").takeIf { it.startsWith("image/") }
    val source = if (src.startsWith("/api/")) ImageSource.ServerPath(src) else ImageSource.DataUrl(src)
    AttachmentImage(
        box = imageBox(tile = false, width = null, height = null),
        source = source,
        label = stringResource(Res.string.timeline_image),
        detail = mimeType ?: stringResource(Res.string.timeline_unknown_type),
    )
}
