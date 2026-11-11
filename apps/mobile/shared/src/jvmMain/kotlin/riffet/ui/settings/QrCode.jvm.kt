package riffet.ui.settings

// The JVM target exists only to compile and test shared logic; there is no desktop pairing screen.
internal actual fun encodeQr(text: String): QrMatrix? = null
