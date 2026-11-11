package riffet.ui.platform

import androidx.compose.runtime.Composable

/** An avatar ready to upload: square, at most `OWNER_AVATAR_SIDE` px, under `OWNER_AVATAR_MAX_BYTES`. */
class PreparedAvatar(val bytes: ByteArray, val type: String)

interface AvatarPicker {
    /** False where the host has no photo picker. */
    val available: Boolean
    fun launch()
}

/**
 * The system photo picker for the owner's avatar. The picked image is centre-cropped to a square,
 * scaled to `OWNER_AVATAR_SIDE` and encoded as JPEG (PNG when it has transparency) under 1 MiB
 * before [onPicked] runs; the server does not resize. A failure calls [onError] with a message.
 */
@Composable
expect fun rememberAvatarPicker(onError: (String) -> Unit, onPicked: (PreparedAvatar) -> Unit): AvatarPicker

internal object UnavailableAvatarPicker : AvatarPicker {
    override val available: Boolean = false
    override fun launch() = Unit
}
