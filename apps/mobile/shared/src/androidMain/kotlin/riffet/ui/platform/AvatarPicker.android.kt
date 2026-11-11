package riffet.ui.platform

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import java.io.ByteArrayOutputStream
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import riffet.contracts.OWNER_AVATAR_MAX_BYTES
import riffet.contracts.OWNER_AVATAR_SIDE
import riffet.i18n.L10n
import riffet.shared.RiffetAndroid

@Composable
actual fun rememberAvatarPicker(onError: (String) -> Unit, onPicked: (PreparedAvatar) -> Unit): AvatarPicker {
    val context = RiffetAndroid.requireContext()
    val scope = rememberCoroutineScope()
    val picked = rememberUpdatedState(onPicked)
    val failed = rememberUpdatedState(onError)
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            try {
                picked.value(withContext(Dispatchers.IO) { prepareAvatar(context, uri) })
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (_: Exception) {
                failed.value(L10n.uiText("owner.avatarUnreadable"))
            }
        }
    }
    return remember(launcher) {
        object : AvatarPicker {
            override val available: Boolean = true
            override fun launch() = launcher.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
        }
    }
}

/** Decode sampled, apply the EXIF turn, crop the centre square and scale it in one pass, then encode. */
private fun prepareAvatar(context: Context, uri: Uri): PreparedAvatar {
    val resolver = context.contentResolver
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
    require(bounds.outWidth > 0 && bounds.outHeight > 0)
    var sample = 1
    while (minOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= OWNER_AVATAR_SIDE) sample *= 2
    val decoded = resolver.openInputStream(uri)?.use {
        BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample })
    } ?: error("undecodable")
    val orientation = resolver.openInputStream(uri)?.use {
        runCatching { ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) }.getOrNull()
    } ?: ExifInterface.ORIENTATION_NORMAL

    val side = minOf(decoded.width, decoded.height)
    val target = minOf(side, OWNER_AVATAR_SIDE)
    val matrix = Matrix().apply {
        when (orientation) {
            ExifInterface.ORIENTATION_ROTATE_90 -> postRotate(90f)
            ExifInterface.ORIENTATION_ROTATE_180 -> postRotate(180f)
            ExifInterface.ORIENTATION_ROTATE_270 -> postRotate(270f)
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> postScale(-1f, 1f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> postScale(1f, -1f)
            ExifInterface.ORIENTATION_TRANSPOSE -> { postRotate(90f); postScale(-1f, 1f) }
            ExifInterface.ORIENTATION_TRANSVERSE -> { postRotate(270f); postScale(-1f, 1f) }
        }
        postScale(target.toFloat() / side, target.toFloat() / side)
    }
    // A centred square is the same region before and after a quarter turn, so crop first.
    val square = Bitmap.createBitmap(decoded, (decoded.width - side) / 2, (decoded.height - side) / 2, side, side, matrix, true)

    if (square.hasAlpha()) encode(square, Bitmap.CompressFormat.PNG, 100)?.let { return PreparedAvatar(it, "image/png") }
    val opaque = if (square.hasAlpha()) {
        Bitmap.createBitmap(square.width, square.height, Bitmap.Config.ARGB_8888).also {
            Canvas(it).apply { drawColor(Color.WHITE); drawBitmap(square, 0f, 0f, null) }
        }
    } else square
    for (quality in intArrayOf(90, 80, 70, 55)) {
        encode(opaque, Bitmap.CompressFormat.JPEG, quality)?.let { return PreparedAvatar(it, "image/jpeg") }
    }
    error("too large")
}

private fun encode(bitmap: Bitmap, format: Bitmap.CompressFormat, quality: Int): ByteArray? {
    val output = ByteArrayOutputStream()
    if (!bitmap.compress(format, quality, output)) return null
    return output.toByteArray().takeIf { it.size <= OWNER_AVATAR_MAX_BYTES }
}
