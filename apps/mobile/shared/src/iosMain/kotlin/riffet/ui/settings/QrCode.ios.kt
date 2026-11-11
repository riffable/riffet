package riffet.ui.settings

// The iPhone app draws its own pairing QR in SwiftUI (PairDeviceView); this Compose section is not shown on iOS.
internal actual fun encodeQr(text: String): QrMatrix? = null
