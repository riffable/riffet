package riffet.ui.files

import android.graphics.Bitmap
import android.graphics.Color as AndroidColor
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import androidx.compose.foundation.Image
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.RememberObserver
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import riffet.contracts.FILE_BUDGET_PDF_PAGE_MAX_PIXELS
import riffet.shared.DownloadWriter
import riffet.shared.RiffetApi
import riffet.shared.downloadFile
import riffet.ui.timeline.Spinner
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicBoolean

internal actual val nativePdfSupported: Boolean = true


/** Pages are drawn this much wider than the screen so a pinch zoom stays legible. */
private const val RENDER_SCALE = 1.5f
private const val MAX_ZOOM = 3f
private const val STALE_AFTER_MS = 60L * 60 * 1000

/**
 * The PDF as [PdfRenderer] reads it; its one open page at a time makes every call take [lock], and all
 * of them run on the document's own thread, which [close] ends after the renderer is closed.
 */
private class PdfPages(private val file: File, private val renderer: PdfRenderer, val sizes: List<Pair<Int, Int>>) {
    private val lock = Any()
    private val executor = Executors.newSingleThreadExecutor { Thread(it, "pdf-render").apply { isDaemon = true } }
    private val dispatcher = executor.asCoroutineDispatcher()
    private val closing = AtomicBoolean(false)
    private var closed = false

    /** Draws [index] into a new bitmap of [width] x [height]; null when the document has been closed meanwhile. */
    suspend fun render(index: Int, width: Int, height: Int): Bitmap? = withContext(dispatcher) {
        synchronized(lock) {
            if (closing.get() || closed) return@synchronized null
            // A page scrolled away while it waited for the lock is not drawn.
            coroutineContext.ensureActive()
            val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            try {
                bitmap.eraseColor(AndroidColor.WHITE)
                renderer.openPage(index).use { it.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY) }
                bitmap
            } catch (failure: Throwable) { bitmap.recycle(); throw failure }
        }
    }

    /** Never blocks the caller: the renderer is closed and the file deleted on the document's thread, behind the renders already running. */
    fun close() {
        if (!closing.compareAndSet(false, true)) return
        try {
            executor.execute {
                synchronized(lock) {
                    closed = true
                    runCatching { renderer.close() }
                    file.delete()
                }
                executor.shutdown()
            }
        } catch (_: RejectedExecutionException) {}
    }

    companion object {
        fun open(file: File): PdfPages {
            val descriptor = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
            val renderer = try { PdfRenderer(descriptor) } catch (failure: Throwable) { descriptor.close(); throw failure }
            val sizes = (0 until renderer.pageCount).map { renderer.openPage(it).use { page -> page.width to page.height } }
            return PdfPages(file, renderer, sizes)
        }
    }
}

/** Ends the document it was given when the composition forgets it, even if that happens before any effect ran. */
private class PdfHolder : RememberObserver {
    var document by mutableStateOf<PdfPages?>(null)
        private set
    private var forgotten = false

    fun offer(opened: PdfPages) { if (forgotten) opened.close() else document = opened }

    override fun onRemembered() {}
    override fun onForgotten() { forgotten = true; document?.close() }
    override fun onAbandoned() = onForgotten()
}

@Composable
internal actual fun PlatformPdfPreview(api: RiffetApi, projectId: String, path: String, version: String, modifier: Modifier, onUnavailable: () -> Unit) {
    val directory = File(LocalContext.current.cacheDir, "pdf-preview")
    val holder = remember(api, projectId, path, version) { PdfHolder() }
    val unavailable by rememberUpdatedState(onUnavailable)
    // The private copy goes with the page: closing the document deletes its file.
    LaunchedEffect(api, projectId, path, version) {
        val file = withContext(Dispatchers.IO) {
            directory.mkdirs()
            val now = System.currentTimeMillis()
            directory.listFiles()?.forEach { if (now - it.lastModified() > STALE_AFTER_MS) it.delete() }
            File(directory, "${UUID.randomUUID()}.pdf")
        }
        var opened: PdfPages? = null
        try {
            var out: FileOutputStream? = null
            try {
                api.downloadFile(projectId, path) { _, _ ->
                    val stream = withContext(Dispatchers.IO) { FileOutputStream(file) }
                    out = stream
                    DownloadWriter { bytes, offset, length -> withContext(Dispatchers.IO) { stream.write(bytes, offset, length) } }
                }
            } finally { withContext(NonCancellable) { out?.close() } }
            // Opening is short and not interrupted, so a document that was opened is always either offered or closed below.
            opened = withContext(Dispatchers.IO + NonCancellable) { PdfPages.open(file) }
            currentCoroutineContext().ensureActive()
            holder.offer(opened)
        } catch (cancellation: CancellationException) {
            if (opened == null) file.delete() else opened.close()
            throw cancellation
        } catch (_: Throwable) {
            if (opened == null) file.delete() else opened.close()
            unavailable()
        }
    }
    val document = holder.document
    if (document == null) {
        Box(modifier, contentAlignment = Alignment.Center) { Spinner(size = 20.dp) }
        return
    }
    PdfPageList(document, modifier)
}

@Composable
private fun PdfPageList(document: PdfPages, modifier: Modifier) {
    var zoom by remember(document) { mutableFloatStateOf(1f) }
    BoxWithConstraints(modifier.fillMaxSize().pdfPinch { factor -> zoom = (zoom * factor).coerceIn(1f, MAX_ZOOM) }) {
        val density = LocalDensity.current
        val viewWidth = maxWidth
        val renderWidth = with(density) { (viewWidth.toPx() * RENDER_SCALE).toInt() }
        // Zooming widens the pages inside a horizontal scroll; the bitmaps keep their size.
        Box(Modifier.fillMaxSize().horizontalScroll(rememberScrollState())) {
            LazyColumn(Modifier.width(viewWidth * zoom).fillMaxSize(), contentPadding = PaddingValues(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(document.sizes.size, key = { it }) { index ->
                    val (width, height) = document.sizes[index]
                    PdfPage(document, index, renderWidth, width, height)
                }
            }
        }
    }
}

/** A two-finger pinch is taken before the list sees it; one finger scrolls as usual. */
private fun Modifier.pdfPinch(onZoom: (Float) -> Unit): Modifier = pointerInput(Unit) {
    awaitEachGesture {
        awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
        do {
            val event = awaitPointerEvent(PointerEventPass.Initial)
            if (event.changes.count { it.pressed } >= 2) {
                val factor = event.calculateZoom()
                if (factor != 1f) onZoom(factor)
                event.changes.forEach { it.consume() }
            }
        } while (event.changes.any { it.pressed })
    }
}

/** Holds a page's bitmap so it is recycled once, and only after its render has finished. */
private class PageBitmap {
    var bitmap: Bitmap? = null
    var released = false

    fun release() {
        released = true
        bitmap?.recycle()
        bitmap = null
    }
}

/** One page, drawn while it is on screen and recycled when it leaves. */
@Composable
private fun PdfPage(document: PdfPages, index: Int, renderWidth: Int, pageWidth: Int, pageHeight: Int) {
    val held = remember(document, index, renderWidth) { PageBitmap() }
    var image by remember(held) { mutableStateOf<ImageBitmap?>(null) }
    DisposableEffect(held) { onDispose { image = null; held.release() } }
    // A page without a size has nothing to draw; its box takes a portrait ratio.
    val drawable = pageWidth > 0 && pageHeight > 0
    LaunchedEffect(held) {
        if (!drawable) return@LaunchedEffect
        // A very large page is drawn smaller rather than at the full width.
        val scale = minOf(1.0, Math.sqrt(FILE_BUDGET_PDF_PAGE_MAX_PIXELS.toDouble() / (renderWidth.toDouble() * renderWidth * pageHeight / pageWidth)))
        val width = (renderWidth * scale).toInt().coerceAtLeast(1)
        val height = (width.toLong() * pageHeight / pageWidth).toInt().coerceAtLeast(1)
        val bitmap = document.render(index, width, height) ?: return@LaunchedEffect
        if (held.released) { bitmap.recycle(); return@LaunchedEffect }
        held.bitmap = bitmap
        image = bitmap.asImageBitmap()
    }
    Box(Modifier.fillMaxWidth().aspectRatio(if (drawable) pageWidth.toFloat() / pageHeight else 0.7071f)) {
        image?.let { Image(it, contentDescription = null, contentScale = ContentScale.FillWidth, modifier = Modifier.fillMaxSize()) }
    }
}
