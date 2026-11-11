package riffet.shared

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier

/**
 * The sixth platform seam of the `expect`/`actual` family in [Platform], alongside
 * [ServerDiscovery]: a camera that reads the pairing QR `riffet status` prints, so a device can be
 * paired without typing an 8-symbol code and an address.
 *
 * ## Why the seam is a composable, not a `suspend fun`
 *
 * The shape is dictated by the Android implementation. CameraX binds a use case to a
 * `LifecycleOwner`, and the `CAMERA` permission is a runtime permission that can only be requested
 * through an Activity-result launcher — both of which exist only inside a composition. A
 * `suspend fun scan(): String?` would have to smuggle a lifecycle owner and an Activity through its
 * own signature (or reach for a global Activity), and it would still have to hold a surface to draw
 * the preview on. Exposing `Preview` as a `@Composable` lets the Android actual use the composition
 * it is already in (`LocalContext`, `DisposableEffect`, `AndroidView`) and keeps the factory itself
 * platform-free, exactly like the other seams.
 *
 * ## Typing stays first-class
 *
 * Scanning is an *additional* way in. [isSupported] is false wherever there is no implementation, so
 * the caller can simply not offer the affordance; every failure inside [Preview] arrives as one
 * [QrScannerFailure] and means "hide the scanner and stay on the typed form", never a modal dead end
 * (docs/MOBILE.md, 目标与非目标: 手机扫码即可连接 Mac is an addition to, not a replacement for,
 * typing a code read off the Mac).
 */
interface QrScanner {
    /**
     * Whether this device can scan at all. Android answers from `PackageManager.FEATURE_CAMERA_ANY`;
     * the JVM and iOS actuals answer false, which is the honest answer for a stub.
     */
    val isSupported: Boolean

    /**
     * Renders the live camera preview and reports at most one decoded QR payload.
     *
     * [onDecoded] fires at most once per entry into the composition: analysis stops after the first
     * successful decode, so one QR in front of the lens cannot pair the device over and over.
     * [onUnavailable] fires at most once, when the preview cannot run; it is a signal to hide the
     * scanner, not an error to display.
     *
     * The caller owns whether this is composed at all — leaving the composition is what unregisters
     * the analyzer and closes the camera (see the Android actual).
     */
    @Composable
    fun Preview(
        onDecoded: (String) -> Unit,
        onUnavailable: (QrScannerFailure) -> Unit,
        modifier: Modifier = Modifier,
    )
}

/**
 * Why a preview could not run. None of these is a pairing error: each one lands the user back on the
 * typed form with everything they had typed still there.
 */
enum class QrScannerFailure {
    /** The camera permission was refused this time. */
    PermissionDenied,

    /** The camera permission was refused with "don't ask again"; only Settings can re-grant it. */
    PermissionPermanentlyDenied,

    /** No usable camera: no hardware, or the one available is held by another app. */
    CameraUnavailable,

    /** This platform has no scanner implementation (JVM and iOS today). */
    Unsupported,
}

expect fun createQrScanner(): QrScanner

/**
 * How often a frame may be handed to the decoder. A live preview produces ~30 frames/second; zxing
 * on all of them would burn the battery and add nothing, because a QR does not move that fast.
 */
internal const val MIN_ANALYSIS_INTERVAL_MILLIS: Long = 250L

/**
 * The two decisions that make a live-preview decoder behave: analyse at most every
 * [minIntervalMillis], and stop after the first successful decode.
 *
 * It lives in `commonMain` — and therefore in the JVM target — because it is the one part of the
 * scanner that is pure logic and worth a test that does not need a camera or an Android device. It
 * is called only from the analyzer, which CameraX runs on a single-threaded executor, so the two
 * fields need no synchronisation; do not call it from two threads.
 */
internal class ScanThrottle(private val minIntervalMillis: Long = MIN_ANALYSIS_INTERVAL_MILLIS) {
    private var lastAnalysisMillis = Long.MIN_VALUE
    private var decoded = false

    /** Whether the frame that arrived at [nowMillis] should be handed to the decoder. */
    fun shouldAnalyze(nowMillis: Long): Boolean {
        if (decoded) return false
        val last = lastAnalysisMillis
        if (last != Long.MIN_VALUE && nowMillis - last < minIntervalMillis) return false
        lastAnalysisMillis = nowMillis
        return true
    }

    /**
     * Records a successful decode. Returns true exactly once, for the first caller, so a decode is
     * delivered to the handler once even if a later frame of the same QR slips through.
     */
    fun markDecoded(): Boolean {
        if (decoded) return false
        decoded = true
        return true
    }
}
