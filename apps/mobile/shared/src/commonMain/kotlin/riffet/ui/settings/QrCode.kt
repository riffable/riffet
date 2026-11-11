package riffet.ui.settings

/** Dark modules of a QR symbol, row by row, without the quiet zone. */
internal class QrMatrix(val size: Int, private val dark: BooleanArray) {
    fun isDark(x: Int, y: Int): Boolean = dark[y * size + x]
}

/** Encodes [text] at error-correction level M, or null where this target has no encoder. */
internal expect fun encodeQr(text: String): QrMatrix?
