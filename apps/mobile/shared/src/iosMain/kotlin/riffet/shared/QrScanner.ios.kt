package riffet.shared

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier

/*
 * iOS is P4 (docs/MOBILE.md, 分期与验收). Like every other iOS seam in `Platform.ios.kt`, this is a
 * stub that exists so the iOS targets compile, not a working implementation.
 */

/**
 * TODO(ios, P4): `AVCaptureSession` + `AVCaptureMetadataOutput` with
 * `AVMetadataObject.ObjectType.qr` (which decodes a QR without a third-party library at all), behind
 * `AVCaptureDevice.requestAccessForMediaType` for the permission. Returning `Unsupported` is not a
 * scanner; until this exists the pairing screen's typed code field is the only iOS path.
 */
private object IosQrScanner : QrScanner {
    override val isSupported: Boolean = false

    @Composable
    override fun Preview(
        onDecoded: (String) -> Unit,
        onUnavailable: (QrScannerFailure) -> Unit,
        modifier: Modifier,
    ) {
        LaunchedEffect(Unit) { onUnavailable(QrScannerFailure.Unsupported) }
    }
}

actual fun createQrScanner(): QrScanner = IosQrScanner
