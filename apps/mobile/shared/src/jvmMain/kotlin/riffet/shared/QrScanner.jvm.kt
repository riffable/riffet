package riffet.shared

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier

/*
 * The JVM target exists only so the shared logic can be compiled and tested without an Android SDK
 * (`Platform.jvm.kt`). There is no desktop camera product, so this is honest the same way the other
 * JVM seams are: it says it cannot scan instead of pretending.
 *
 * The camera stack is Android-only on purpose. `commonMain` — and therefore the JVM and iOS
 * compilations — must not reference `androidx.camera`, zxing or `android.*` at all; only
 * `shared/androidMain` and `androidApp` may.
 */

private object UnsupportedQrScanner : QrScanner {
    override val isSupported: Boolean = false

    /** Nothing to render; if the caller composes it anyway, it says so immediately. */
    @Composable
    override fun Preview(
        onDecoded: (String) -> Unit,
        onUnavailable: (QrScannerFailure) -> Unit,
        modifier: Modifier,
    ) {
        LaunchedEffect(Unit) { onUnavailable(QrScannerFailure.Unsupported) }
    }
}

actual fun createQrScanner(): QrScanner = UnsupportedQrScanner
