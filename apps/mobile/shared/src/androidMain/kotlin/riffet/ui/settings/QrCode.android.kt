package riffet.ui.settings

import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import com.google.zxing.qrcode.encoder.Encoder

internal actual fun encodeQr(text: String): QrMatrix? = try {
    val modules = Encoder.encode(text, ErrorCorrectionLevel.M, mapOf(EncodeHintType.CHARACTER_SET to "UTF-8")).matrix
    val size = modules.width
    QrMatrix(size, BooleanArray(size * size) { modules.get(it % size, it / size).toInt() == 1 })
} catch (_: Exception) {
    null
}
