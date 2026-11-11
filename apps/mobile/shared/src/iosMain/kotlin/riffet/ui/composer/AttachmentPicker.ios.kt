package riffet.ui.composer

import androidx.compose.runtime.Composable

/* The shipping iOS app uses its native document importer. This Compose host keeps its
 * existing unavailable picker, while explicit terminal paste can read a clipboard image. */

@Composable
actual fun rememberAttachmentPicker(onError: (String) -> Unit, onPicked: (List<PickedAttachment>) -> Unit): AttachmentPicker =
    UnavailableAttachmentPicker()

@OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)
actual suspend fun readClipboardAttachments(): List<PickedAttachment> {
    val image = platform.UIKit.UIPasteboard.generalPasteboard.image ?: return emptyList()
    val data = platform.UIKit.UIImagePNGRepresentation(image) ?: return emptyList()
    val bytes = riffet.ios.byteArrayFromData(data)
    require(bytes.size <= MAX_ATTACHMENT_BYTES) { riffet.i18n.L10n.uiText("terminal.paste.tooLarge") }
    return listOf(PickedAttachment("paste.png", "image/png", bytes))
}
