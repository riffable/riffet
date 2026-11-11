package riffet.shared

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.LifecycleOwner
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.LuminanceSource
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import java.nio.ByteBuffer
import java.util.concurrent.Executor
import java.util.concurrent.Executors

/**
 * The Android side of [QrScanner]: CameraX for the preview and the frame pipeline, zxing for the
 * decode.
 *
 * ## Why this stack
 *
 * `com.google.mlkit:barcode-scanning` is deliberately **not** used. It either requires Google Play
 * Services or makes the app bundle a model, and Riffet's whole position is local-first with no cloud
 * dependency (docs/MOBILE.md, 通知 / 非目标). zxing is a plain Java QR decoder with no Play Services
 * and no model, and `camera-view`'s Gradle metadata confirms it does not drag `camera-mlkit-vision`
 * in either. `androidx.camera` is used only for the camera itself.
 *
 * ## Lifecycle
 *
 * CameraX binds a `Preview` and an `ImageAnalysis` use case to a `LifecycleOwner`, so:
 *
 *  - the use cases are bound on `ON_START` and **unbound, with the analyzer cleared, on `ON_STOP`**,
 *    which covers the app being backgrounded (the screen going off, the phone switching apps) — the
 *    camera is released rather than left holding the device;
 *  - `onDispose` removes the lifecycle observer, unbinds again and shuts the decoder executor down,
 *    which covers navigating away from the pairing screen;
 *  - `ImageProxy.close()` runs in a `finally`, because an unclosed proxy stalls the pipeline forever
 *    after the first frame.
 *
 * A `LifecycleOwner`-driven `bindToLifecycle` also releases the camera by itself below STARTED; the
 * explicit unbind here is not redundant so much as *stated*: this file is where the reader should be
 * able to see the camera being closed.
 */
private class AndroidQrScanner(private val context: Context) : QrScanner {

    /**
     * `FEATURE_CAMERA_ANY` is exactly "there is some camera". False hides the scan affordance rather
     * than opening a screen that can only fail.
     */
    override val isSupported: Boolean =
        context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)

    @Composable
    override fun Preview(
        onDecoded: (String) -> Unit,
        onUnavailable: (QrScannerFailure) -> Unit,
        modifier: Modifier,
    ) {
        // The Activity is both the Activity-result-registry owner `rememberLauncherForActivityResult`
        // needs and the LifecycleOwner CameraX binds to. `LocalContext.current` is usually a
        // ContextWrapper (theme, locale) rather than the Activity, hence the unwrap.
        val activity = LocalContext.current.findActivity()
        val lifecycleOwner = activity as? LifecycleOwner
        if (activity == null || lifecycleOwner == null) {
            LaunchedEffect(Unit) { onUnavailable(QrScannerFailure.Unsupported) }
            return
        }

        var granted by remember {
            mutableStateOf(
                context.checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED,
            )
        }

        val permissionLauncher = rememberLauncherForActivityResult(
            ActivityResultContracts.RequestPermission(),
        ) { allowed ->
            granted = allowed
            if (!allowed) {
                // Silence is the contract: the typed form is right behind this, and a camera the user
                // refused must not become a sixth error state. The only thing worth distinguishing is
                // "you will never be asked again", which only Settings can fix.
                val permanent = !activity.shouldShowRequestPermissionRationale(Manifest.permission.CAMERA)
                onUnavailable(
                    if (permanent) QrScannerFailure.PermissionPermanentlyDenied
                    else QrScannerFailure.PermissionDenied,
                )
            }
        }

        // Ask on the way in. A black preview from a declared-but-ungranted permission is the bug this
        // exists to avoid.
        LaunchedEffect(Unit) {
            if (!granted) permissionLauncher.launch(Manifest.permission.CAMERA)
        }
        if (!granted) return

        // Read outside `remember`: `LocalContext.current` is a composable read and `remember`'s lambda
        // is not a composable context. The composition's context (the Activity's) is the themed one a
        // View should be built with.
        val previewContext = LocalContext.current
        val previewView = remember {
            PreviewView(previewContext).apply {
                // COMPATIBLE renders through a TextureView, which is the mode that respects the
                // rounded clip and the Compose drawing order; the default SurfaceView can draw over
                // them. A slightly higher power cost for a preview that is on screen for seconds.
                implementationMode = PreviewView.ImplementationMode.COMPATIBLE
            }
        }
        // zxing is CPU-bound; it does not run on the main thread and it does not run on the camera's.
        val analysisExecutor = remember { Executors.newSingleThreadExecutor() }
        val throttle = remember { ScanThrottle() }

        AndroidView(
            factory = { previewView },
            modifier = modifier,
        )

        DisposableEffect(lifecycleOwner, previewView) {
            val cameraProvider = ProcessCameraProvider.getInstance(context)
            var provider: ProcessCameraProvider? = null
            var analysis: ImageAnalysis? = null
            var bound = false
            var disposed = false

            fun unbind() {
                if (!bound) return
                // Riffet binds no other CameraX use case, so this is exactly this preview.
                runCatching { provider?.unbindAll() }
                analysis?.clearAnalyzer()
                bound = false
            }

            fun bind() {
                if (bound) return
                val cameraProviderInstance = provider ?: return
                val preview = Preview.Builder().build().also {
                    it.setSurfaceProvider(previewView.surfaceProvider)
                }
                val imageAnalysis = ImageAnalysis.Builder()
                    // A live preview at ~30 fps must not queue up behind a slow decode.
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_YUV_420_888)
                    .build()
                imageAnalysis.setAnalyzer(analysisExecutor) { proxy ->
                    analyzeFrame(proxy, throttle, onDecoded)
                }
                // Rear camera first; a front-only device, or a rear camera a phone call is holding,
                // needs the fallback. Both failing is a silent return to the typed form.
                val ok = runCatching {
                    cameraProviderInstance.bindToLifecycle(
                        lifecycleOwner,
                        CameraSelector.DEFAULT_BACK_CAMERA,
                        preview,
                        imageAnalysis,
                    )
                }.isSuccess || runCatching {
                    cameraProviderInstance.bindToLifecycle(
                        lifecycleOwner,
                        CameraSelector.DEFAULT_FRONT_CAMERA,
                        preview,
                        imageAnalysis,
                    )
                }.isSuccess
                if (ok) {
                    analysis = imageAnalysis
                    bound = true
                } else {
                    imageAnalysis.clearAnalyzer()
                    onUnavailable(QrScannerFailure.CameraUnavailable)
                }
            }

            // Backgrounding must release the camera; returning to the foreground must rebind it.
            val observer = LifecycleEventObserver { _, event ->
                when (event) {
                    Lifecycle.Event.ON_START -> bind()
                    Lifecycle.Event.ON_STOP -> unbind()
                    else -> Unit
                }
            }

            cameraProvider.addListener(
                {
                    // `ProcessCameraProvider.getInstance` is asynchronous, so this can land after the
                    // preview has already left the composition. Binding then would attach a camera
                    // whose executor is shut down, which is exactly the leak this guard prevents.
                    if (disposed) return@addListener
                    provider = runCatching { cameraProvider.get() }.getOrNull()
                    if (provider == null) {
                        onUnavailable(QrScannerFailure.CameraUnavailable)
                        return@addListener
                    }
                    lifecycleOwner.lifecycle.addObserver(observer)
                    if (lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) bind()
                },
                MainThreadExecutor(),
            )

            onDispose {
                disposed = true
                lifecycleOwner.lifecycle.removeObserver(observer)
                unbind()
                // Cleared and unbound above, so nothing new is submitted; shutdown only lets an
                // in-flight decode finish. An executor that outlives its preview is a leaked thread.
                analysisExecutor.shutdown()
            }
        }
    }
}

/** A main-thread [Executor] without pulling `androidx.core`'s `ContextCompat` in for one line. */
private class MainThreadExecutor : Executor {
    private val handler = Handler(Looper.getMainLooper())

    override fun execute(command: Runnable) {
        handler.post(command)
    }
}

/** zxing is told QR only: this is a pairing-code reader, not a general barcode scanner. */
private val QR_HINTS: Map<DecodeHintType, Any> = mapOf(
    DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE),
)

/**
 * Runs on the single-thread [analysisExecutor]. Decode off the main thread, at most a few frames a
 * second ([ScanThrottle]), stop at the first hit, and close the proxy on every path.
 */
private fun analyzeFrame(proxy: ImageProxy, throttle: ScanThrottle, onDecoded: (String) -> Unit) {
    try {
        if (!throttle.shouldAnalyze(SystemClock.elapsedRealtime())) return
        val text = decodeQr(proxy) ?: return
        if (throttle.markDecoded()) onDecoded(text)
    } catch (_: Throwable) {
        // A decoder failure is not worth a message: the next frame gets another chance. Reaching the
        // user is the caller's [QrScanner] contract, and it only reports *unavailability*.
    } finally {
        // Mandatory. An unclosed proxy means the analyzer never gets another frame.
        proxy.close()
    }
}

/**
 * `@ExperimentalGetImage` is applied directly rather than through `@OptIn`: the marker is
 * `androidx.annotation.RequiresOptIn`, not `kotlin.RequiresOptIn`, so the Kotlin compiler reports
 * "`@OptIn` has no effect" (verified in this build) while Android Lint is the thing that actually
 * checks it — and lint recognises the marker annotation on the declaration.
 */
@ExperimentalGetImage
private fun decodeQr(proxy: ImageProxy): String? {
    val source = luminanceSource(proxy) ?: return null
    val upright = source.rotateToUpright(proxy.imageInfo.rotationDegrees)
    val reader = MultiFormatReader().apply { setHints(QR_HINTS) }
    return try {
        reader.decodeWithState(BinaryBitmap(HybridBinarizer(upright))).text
    } catch (_: Throwable) {
        // NotFoundException on most frames, which is the expected answer for "no QR here".
        null
    } finally {
        reader.reset()
    }
}

/**
 * The Y (luminance) plane as a zxing source, tried two ways as the task requires:
 *
 *  1. through `ImageProxy.image`, the raw `android.media.Image` behind the proxy;
 *  2. through `ImageProxy.planes`.
 *
 * With `OUTPUT_IMAGE_FORMAT_YUV_420_888` both are the same bytes, but `image` is not always present
 * (and is `@ExperimentalGetImage` because of that), so the plane path is the fallback rather than a
 * duplicate.
 */
@ExperimentalGetImage
private fun luminanceSource(proxy: ImageProxy): LuminanceSource? {
    proxy.image?.let { image ->
        val plane = image.planes.getOrNull(0)
        yPlaneSource(plane?.buffer, plane?.rowStride ?: 0, image.width, image.height)?.let { return it }
    }
    val plane = proxy.planes.getOrNull(0) ?: return null
    return yPlaneSource(plane.buffer, plane.rowStride, proxy.width, proxy.height)
}

/**
 * Copies a row-strided Y plane into the packed buffer zxing wants.
 *
 * `rowStride` is normally larger than `width` — the camera pads each row — and handing zxing the raw
 * buffer as if it were packed shears the image, so the padding is dropped row by row. The last row is
 * only `width` long, which is why the size check is `stride * (height - 1) + width` and not
 * `stride * height`.
 */
private fun yPlaneSource(
    buffer: ByteBuffer?,
    rowStride: Int,
    width: Int,
    height: Int,
): LuminanceSource? {
    if (buffer == null || width <= 0 || height <= 0) return null
    val stride = if (rowStride >= width) rowStride else width
    val source = buffer.duplicate()
    source.rewind()
    if (source.remaining() < stride * (height - 1) + width) return null

    val data = ByteArray(stride * height)
    for (row in 0 until height) {
        val count = minOf(width, source.remaining())
        if (count <= 0) break
        source.get(data, row * stride, count)
        val padding = minOf(stride - count, source.remaining())
        if (padding > 0) source.position(source.position() + padding)
    }
    return PlanarYUVLuminanceSource(
        data,
        /* dataWidth = */ stride,
        /* dataHeight = */ height,
        /* left = */ 0,
        /* top = */ 0,
        /* width = */ width,
        /* height = */ height,
        /* reverseHorizontal = */ false,
    )
}

/**
 * `ImageInfo.rotationDegrees` is the clockwise rotation that makes the frame upright; zxing only
 * rotates counter-clockwise, so 90° clockwise is three counter-clockwise quarter turns.
 */
private fun LuminanceSource.rotateToUpright(degrees: Int): LuminanceSource {
    if (!isRotateSupported) return this
    var source = this
    repeat(counterClockwiseTurns(degrees)) { source = source.rotateCounterClockwise() }
    return source
}

private fun counterClockwiseTurns(degrees: Int): Int = when (((degrees % 360) + 360) % 360) {
    90 -> 3
    180 -> 2
    270 -> 1
    else -> 0
}

/**
 * Walks a `ContextWrapper` chain to the Activity. Duplicated from `RiffetSystemBars.android.kt`
 * rather than shared, because both are six lines and the alternative is widening that function's
 * visibility for a caller in another package.
 */
private fun Context.findActivity(): Activity? {
    var current: Context? = this
    while (current is ContextWrapper) {
        if (current is Activity) return current
        current = current.baseContext
    }
    return null
}

actual fun createQrScanner(): QrScanner = AndroidQrScanner(RiffetAndroid.requireContext())
