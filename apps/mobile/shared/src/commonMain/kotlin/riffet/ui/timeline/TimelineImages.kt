package riffet.ui.timeline

import riffet.ui.design.LocalInterfaceStyle
import androidx.compose.ui.semantics.Role
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import riffet.ui.design.RiffetProgressIndicator as CircularProgressIndicator
import riffet.ui.icons.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import coil3.ImageLoader
import coil3.SingletonImageLoader
import coil3.annotation.ExperimentalCoilApi
import coil3.compose.AsyncImagePainter
import coil3.compose.LocalPlatformContext
import coil3.compose.rememberAsyncImagePainter
import coil3.compose.setSingletonImageLoaderFactory
import coil3.network.ktor3.KtorNetworkFetcherFactory
import coil3.request.ImageRequest
import coil3.size.Precision
import coil3.size.Scale
import io.ktor.client.HttpClient
import io.ktor.client.plugins.HttpSend
import io.ktor.client.plugins.plugin
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.http.encodeURLParameter
import io.ktor.http.encodeURLPathPart
import io.ktor.http.isSuccess
import kotlinx.serialization.decodeFromString
import riffet.contracts.Attachment
import riffet.contracts.RiffetJson
import riffet.shared.createDeviceTokenStore
import riffet.shared.activeServerBaseUrl
import riffet.shared.createRiffetHttpClient
import riffet.shared.RiffetApi
import riffet.shared.serverOrigin
import riffet.shared.tokenFor
import riffet.ui.icons.RiffetIcons
import riffet_mobile.shared.generated.resources.*
import org.jetbrains.compose.resources.getString
import org.jetbrains.compose.resources.stringResource

private data class ImageViewerRequest(
    val url: String,
    val label: String,
    val detail: String?,
    val onDownload: (() -> Unit)? = null,
)

private val LocalOpenImageViewer = compositionLocalOf<(ImageViewerRequest) -> Unit> {
    { error("Images must be displayed inside ImageViewerHost") }
}

/** Own the window outside lazy rows, which can leave composition when the IME or transcript moves. */
@Composable
internal fun ImageViewerHost(owner: Any?, content: @Composable () -> Unit) {
    // A new page/session drops its predecessor's preview without replacing the content subtree.
    var request by remember(owner) { mutableStateOf<ImageViewerRequest?>(null) }
    val open: (ImageViewerRequest) -> Unit = remember(owner) { { request = it } }
    CompositionLocalProvider(LocalOpenImageViewer provides open, content = content)
    request?.let { image ->
        FullScreenImageViewer(
            url = image.url,
            label = image.label,
            detail = image.detail,
            onDownload = image.onDownload,
            onDismiss = { request = null },
        )
    }
}

/*
 * The pixels for the transcript's images — the half of `Attachments.kt` that used to be missing.
 *
 * `apps/web/src/app/session/MessageAttachments.tsx` is the specification. The geometry (`imageBox`)
 * is not touched here: this file only fills the box that [ImageSlot] used to leave empty, with the
 * same crop (`ContentScale.Crop` + the box's own alignment = the web's `object-fit: cover` +
 * `object-position`) and the same "never squeeze an extreme ratio" rule.
 *
 * Two sources reach this file:
 *  - a server attachment (`/api/attachments/{id}`), which needs `Authorization: Bearer <token>`;
 *  - an agent image block (`TimelineItem.Image.src`), either inline data or a session blob URL.
 *
 * ## Why the token is attached in an HTTP interceptor
 *
 * Both options in the brief were real; this is the first one, "wire Coil's HTTP client to the same
 * token source the rest of the app uses". Coil's Ktor fetcher is built on a [HttpClient], and the
 * app already has exactly one token source — [riffet.shared.DeviceTokenStore], which
 * `RiffetConnection` reads on every request through `RiffetApi`'s `tokenProvider`. So Coil is given
 * an [HttpClient] whose `HttpSend` interceptor adds the header per request, reading the store at
 * send time. That is the same guarantee `RiffetApi` has: revoking this device takes effect on the
 * next image load, without rebuilding anything. The alternative (fetch bytes through `RiffetApi`
 * and hand Coil the result) would have needed the timeline composables to see the API object, and
 * the call sites ([MessageAttachments], [ImageRow]) are fixed by other agents' files.
 *
 * `HttpSend.intercept` is used rather than `defaultRequest { header(...) }` because the latter is
 * not `suspend` and `DeviceTokenStore.load()` is; the interceptor is, so the token is read fresh
 * for every request instead of being frozen when the client is built.
 *
 * ## Limitation, stated rather than hidden
 *
 * Android's preferences and iOS's Keychain share saved pairings across store instances. Resource
 * requests read the selected service from that snapshot, just like connection restoration; saving
 * pairings removes the legacy server key. An in-memory host must call [RiffetImageAuth.install]
 * with its live connection's providers.
 */

/**
 * Where image requests get their base URL and bearer token.
 *
 * The default reads [DeviceTokenStore], the same source `RiffetApi` uses. A host that already holds
 * the live `RiffetConnection` may [install] the exact providers instead, which is the correct fix
 * on a platform whose token store is not process-wide.
 */
internal object RiffetImageAuth {
    private var apiProvider: (() -> RiffetApi?)? = null

    /** Replaces the platform-store default with the host's live source. */
    fun install(api: () -> RiffetApi?): () -> Unit {
        apiProvider = api
        return { if (apiProvider === api) apiProvider = null }
    }

    private var storedBaseUrl: String? = null

    suspend fun baseUrl(): String? {
        val provider = apiProvider
        return if (provider != null) provider()?.baseUrl else createDeviceTokenStore().activeServerBaseUrl().also { storedBaseUrl = it }
    }

    /** What [baseUrl] would return, if that is known without suspending. */
    fun knownBaseUrl(): String? = apiProvider?.let { it()?.baseUrl } ?: storedBaseUrl

    /** A host API controls both capabilities and authentication; standalone previews retain stored auth. */
    suspend fun headersFor(url: String): Map<String, String> {
        val provider = apiProvider
        if (provider != null) return provider()?.resourceHeaders(url).orEmpty()
        val origin = baseUrl()?.let(::serverOrigin) ?: return emptyMap()
        if (serverOrigin(url) != origin) return emptyMap()
        val token = createDeviceTokenStore().tokenFor(url)
        return if (token.isNullOrEmpty()) emptyMap() else mapOf(HttpHeaders.Authorization to "Bearer $token")
    }
}

/**
 * The subset of an attachment's upload metadata the transcript needs: the name, the MIME type and
 * the pixel size, all of which a CLI receipt can omit. Mirrors the web's `api.attachmentMetadata`.
 */
internal data class AttachmentMetadata(
    val name: String,
    val mimeType: String,
    val width: Long?,
    val height: Long?,
    val size: Long,
)

/**
 * `GET /api/attachments/{id}/metadata`, through [imageHttpClient] so it carries the bearer token.
 * Returns `null` on any failure — the caller keeps rendering whatever the receipt already provided,
 * exactly like the web's `.catch()` branch.
 */
internal suspend fun fetchAttachmentMetadata(id: String): AttachmentMetadata? {
    val base = RiffetImageAuth.baseUrl()?.takeIf { it.isNotBlank() } ?: return null
    val response = runCatching {
        imageHttpClient.get("${base.trimEnd('/')}/api/attachments/${id.encodeURLPathPart()}/metadata")
    }.getOrNull() ?: return null
    if (!response.status.isSuccess()) return null
    val attachment = runCatching {
        RiffetJson.instance.decodeFromString<Attachment>(response.bodyAsText())
    }.getOrNull() ?: return null
    return AttachmentMetadata(attachment.name, attachment.mimeType, attachment.width, attachment.height, attachment.size)
}

/** Fetch a server-owned preview through the same origin-checked bearer transport as images. */
internal suspend fun fetchServerPreview(path: String, parameters: List<Pair<String, String>> = emptyList()): String {
    require(path in setOf("/diagram", "/content-preview") || path.startsWith("/api/attachments/") || (path.startsWith("/api/projects/") && path.endsWith("/file/raw")))
    val base = RiffetImageAuth.baseUrl()?.takeIf { it.isNotBlank() } ?: error(getString(Res.string.timeline_not_connected))
    val query = parameters.joinToString("&") { (key, value) -> "${key.encodeURLParameter()}=${value.encodeURLParameter()}" }
    val response = imageHttpClient.get("${base.trimEnd('/')}$path${if (query.isEmpty()) "" else "?$query"}")
    check(response.status.isSuccess()) { getString(Res.string.timeline_preview_status_failed, response.status.value) }
    check(response.headers[HttpHeaders.ContentType]?.substringBefore(';')?.trim() == "text/html") { getString(Res.string.timeline_preview_not_html) }
    return response.bodyAsText()
}

/**
 * The one HTTP client every image uses. It is the app's ordinary Ktor client — same engine, same
 * timeouts, same `Accept-Encoding: identity` escape hatch — with the bearer header added at send
 * time. Process-lifetime on purpose: Coil caches decoded images against the loader, and rebuilding
 * the client would drop that cache on every recomposition.
 */
private val imageHttpClient: HttpClient by lazy {
    createRiffetHttpClient().apply {
        plugin(HttpSend).intercept { request ->
            // Re-evaluate every send, including redirects: credentials and capabilities must
            // not follow a server resource to an external image host.
            request.headers.remove(HttpHeaders.Authorization)
            request.headers.remove("X-Riffet-Features")
            val url = request.url.buildString()
            RiffetImageAuth.headersFor(url).forEach { (name, value) -> request.header(name, value) }
            execute(request)
        }
    }
}

/**
 * Coil's process-wide loader, wired to [imageHttpClient], not one loader per image slot.
 *
 * `remember(context)` alone would still create a loader for every slot — a gallery of five photos
 * would get five memory caches and five disk caches, which is the opposite of what a phone needs.
 * The singleton is the right owner: on Android `SingletonImageLoader.get` builds it from
 * `context.applicationContext` (verified in `coil3/SingletonImageLoader_androidKt`), so caching it
 * process-wide cannot pin an Activity. The factory is idempotent, so recomposition is harmless.
 */
@OptIn(ExperimentalCoilApi::class)
@Composable
internal fun rememberRiffetImageLoader(): ImageLoader {
    setSingletonImageLoaderFactory { context ->
        ImageLoader.Builder(context)
            // The eager `HttpClient` overload: the no-arg and lambda overloads are ambiguous with
            // each other because the factory's defaults make both applicable to a bare lambda.
            .components { add(KtorNetworkFetcherFactory(imageHttpClient)) }
            .build()
    }
    return SingletonImageLoader.get(LocalPlatformContext.current)
}

/** The renderer already supports paragraph images; reuse the existing Coil/auth transport. */
internal class TranscriptImageTransformer : com.mikepenz.markdown.model.ImageTransformer {
    @Composable
    override fun transform(link: String): com.mikepenz.markdown.model.ImageData? {
        val files = LocalFileAccess.current
        val path = localImagePath(link)
        val source = when {
            link.startsWith("data:image/") -> ImageSource.DataUrl(link)
            path != null && files != null -> ImageSource.ProjectFile(files.projectId, path)
            link.startsWith("/api/") -> ImageSource.ServerPath(link)
            path == null -> ImageSource.Web(link)
            else -> return null
        }
        val url = (rememberImageUrl(source) as? ResolvedUrl.Ready)?.url
        val context = LocalPlatformContext.current
        val request = remember(url, context) {
            url?.let { ImageRequest.Builder(context).data(it).size(1_024, 1_024).scale(Scale.FIT).build() }
        }
        val painter = rememberAsyncImagePainter(model = request, imageLoader = rememberRiffetImageLoader())
        return com.mikepenz.markdown.model.ImageData(
            painter,
            modifier = Modifier.size(width = 240.dp, height = 180.dp),
            contentDescription = link,
            contentScale = ContentScale.Fit,
        )
    }
}

/** What an [AttachmentImage]'s box should draw. */
internal sealed interface ImageSource {
    /** A server attachment, addressed by id. `null` means the receipt had no id, so there is nothing to fetch. */
    data class Remote(val id: String?) : ImageSource

    /** A `data:` URL from the agent's own image block. Coil's `DataUriFetcher` decodes it with no network. */
    data class DataUrl(val url: String) : ImageSource

    /** A file in the project, through the server's read-only image route (the web's `projectImageSource`). */
    data class ProjectFile(val projectId: String, val path: String) : ImageSource

    /** Session blob and other authenticated image paths carried by the timeline. */
    data class ServerPath(val path: String) : ImageSource

    /** An image on the web, linked from markdown. Loaded without credentials. */
    data class Web(val url: String) : ImageSource
}

/** The state of an image's URL: the base URL is read from a suspend store, so it is not instant. */
private sealed interface ResolvedUrl {
    data object Loading : ResolvedUrl
    data object Unavailable : ResolvedUrl
    data class Ready(val url: String) : ResolvedUrl
}

@Composable
private fun rememberImageUrl(source: ImageSource): ResolvedUrl {
    when (source) {
        is ImageSource.DataUrl -> return ResolvedUrl.Ready(source.url)
        is ImageSource.Web -> return ResolvedUrl.Ready(source.url)
        is ImageSource.Remote -> if (source.id.isNullOrEmpty()) return ResolvedUrl.Unavailable
        is ImageSource.ProjectFile, is ImageSource.ServerPath -> Unit
    }
    // A known server resolves in the first frame, so a recomposed image finds Coil's memory cache at
    // once instead of showing its empty frame until the effect below runs.
    var state by remember(source) {
        mutableStateOf(RiffetImageAuth.knownBaseUrl()?.let { resolveImageUrl(source, it) } ?: ResolvedUrl.Loading)
    }
    LaunchedEffect(source) {
        state = resolveImageUrl(source, runCatching { RiffetImageAuth.baseUrl() }.getOrNull())
    }
    return state
}

private fun resolveImageUrl(source: ImageSource, server: String?): ResolvedUrl {
    val base = server?.trimEnd('/')
    return when {
        base.isNullOrBlank() -> ResolvedUrl.Unavailable
        // `encodeURLPathPart` is the same percent-encoding `RiffetApi` uses; an id can hold `/`.
        source is ImageSource.Remote -> ResolvedUrl.Ready("$base/api/attachments/${source.id.orEmpty().encodeURLPathPart()}")
        source is ImageSource.ProjectFile -> ResolvedUrl.Ready(
            "$base/api/projects/${source.projectId.encodeURLPathPart()}/file/image?path=${source.path.encodeURLParameter()}",
        )
        source is ImageSource.ServerPath && source.path.startsWith("/api/") -> ResolvedUrl.Ready("$base${source.path}")
        else -> ResolvedUrl.Unavailable
    }
}

/**
 * A real image in the box [imageBox] computed. This is the replacement for the empty [ImageSlot]:
 * the box, its crop and its alignment are unchanged, the pixels are new.
 *
 * The decode is restricted to the box's pixel size (`ImageRequest.size` + [Scale.FILL]), so a
 * 4000 px phone photo is not decoded at full resolution into a 72 dp tile. [Scale.FILL] rather than
 * `FIT` because the box crops with [ContentScale.Crop]: `FIT` would hand the crop a bitmap that is
 * already too small on one axis.
 */
@Composable
internal fun AttachmentImage(
    box: ImageBox,
    source: ImageSource,
    label: String,
    detail: String?,
    modifier: Modifier = Modifier,
) {
    riffet.ui.app.TraceLifecycle("image")
    val colors = TimelineTheme.colors
    val context = LocalPlatformContext.current
    val loader = rememberRiffetImageLoader()
    val density = LocalDensity.current

    val resolved = rememberImageUrl(source)
    val url: String? = (resolved as? ResolvedUrl.Ready)?.url
    // Still resolving the base URL, versus genuinely having none: the two must not look the same.
    val resolving = resolved is ResolvedUrl.Loading

    // A decode size of zero is rejected by Coil; the box is at least 1 dp, but a density below 1
    // could still round it down.
    val widthPx = with(density) { box.width.roundToPx() }.coerceAtLeast(1)
    val heightPx = with(density) { box.height.roundToPx() }.coerceAtLeast(1)
    val request = remember(url, widthPx, heightPx, context) {
        url?.let {
            ImageRequest.Builder(context)
                .data(it)
                .size(widthPx, heightPx)
                .scale(Scale.FILL)
                .build()
        }
    }
    // Crop + the box's own alignment is the web's `object-fit: cover` + `object-position`: a very
    // tall image keeps its top, a very wide one its left, everything else its centre.
    val painter = rememberAsyncImagePainter(
        model = request,
        imageLoader = loader,
        contentScale = ContentScale.Crop,
    )
    val state by painter.state.collectAsState()
    val openViewer = LocalOpenImageViewer.current

    val succeeded = state is AsyncImagePainter.State.Success
    val failed = state is AsyncImagePainter.State.Error
    Box(
        modifier = modifier
            .size(box.width, box.height)
            .clip(RoundedCornerShape(LocalInterfaceStyle.current.rowRadius))
            .background(colors.bgMuted)
            .clickable(enabled = succeeded || failed, role = Role.Button) {
                if (succeeded && url != null) openViewer(ImageViewerRequest(url, label, detail))
                // A failure can be transient; a tap retries rather than doing nothing.
                else if (failed) painter.restart()
            },
        contentAlignment = box.alignment,
    ) {
        when {
            resolving -> LoadingBox()
            url == null -> UnavailableBox(label = label)
            state is AsyncImagePainter.State.Error -> FailedBox(label = label, detail = detail)
            else -> {
                Image(
                    painter = painter,
                    contentDescription = label,
                    contentScale = ContentScale.Crop,
                    alignment = box.alignment,
                    modifier = Modifier.fillMaxSize(),
                )
                // Not on `Empty`: a memory-cache hit leaves it within the same frame.
                if (state is AsyncImagePainter.State.Loading) LoadingBox()
            }
        }
    }
}

/**
 * An image whose size is not known up front — a tool's screenshot, a markdown image — has a
 * stable frame. The decoded pixels fit inside it, so loading and cache hits measure identically
 * and do not move a transcript row after the page opens.
 */
@Composable
internal fun FlexibleImage(
    source: ImageSource,
    label: String,
    maxHeight: Dp,
    modifier: Modifier = Modifier,
    detail: String? = null,
    onDownload: (() -> Unit)? = null,
) {
    riffet.ui.app.TraceLifecycle("image")
    val colors = TimelineTheme.colors
    val context = LocalPlatformContext.current
    val loader = rememberRiffetImageLoader()
    val resolved = rememberImageUrl(source)
    val url = (resolved as? ResolvedUrl.Ready)?.url
    val request = remember(url, context) {
        url?.let {
            ImageRequest.Builder(context)
                .data(it)
                .size(MAX_INLINE_DECODE)
                .scale(Scale.FIT)
                // Inexact: a small screenshot decodes at its own size instead of being blown up.
                .precision(Precision.INEXACT)
                .build()
        }
    }
    val painter = rememberAsyncImagePainter(model = request, imageLoader = loader, contentScale = ContentScale.Fit)
    val state by painter.state.collectAsState()
    val openViewer = LocalOpenImageViewer.current
    val succeeded = state is AsyncImagePainter.State.Success
    val failed = state is AsyncImagePainter.State.Error
    val shape = RoundedCornerShape(LocalInterfaceStyle.current.controlRadius)

    BoxWithConstraints(modifier.fillMaxWidth()) {
        val frameWidth = minOf(maxWidth, 320.dp)
        Box(
            Modifier
                .size(width = frameWidth, height = minOf(maxHeight, 240.dp))
                .clip(shape)
                .background(colors.bgMuted)
                .border(LocalInterfaceStyle.current.metrics.hairlineWidth, colors.line, shape)
                .clickable(enabled = succeeded || failed, role = Role.Button) {
                    if (succeeded && url != null) openViewer(ImageViewerRequest(url, label, detail, onDownload))
                    else if (failed) painter.restart()
                },
            contentAlignment = Alignment.Center,
        ) {
            when {
                resolved is ResolvedUrl.Loading -> LoadingBox()
                url == null -> UnavailableBox(label = label)
                state is AsyncImagePainter.State.Error -> FailedBox(label = label, detail = null)
                else -> {
                    Image(painter = painter, contentDescription = label, contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize())
                    if (state is AsyncImagePainter.State.Loading) LoadingBox()
                }
            }
        }
    }
}

private const val MAX_INLINE_DECODE = 1440

/**
 * The viewer's own window: [ImageViewerPage], drawn across the whole screen.
 *
 * Going edge to edge is the point of this wrapper ([viewerDialogProperties], because Android and the
 * skiko targets spell it differently). The page is black and full-bleed on purpose — a photo framed
 * by two strips of the app's own background, with a toolbar over its first row of pixels, was the
 * shape this replaced. With the window's insets off, [ImageViewerInfoBar] is what keeps the buttons
 * clear of the gesture bar.
 *
 * Ported from `apps/web/src/app/session/ImageViewer.tsx`, adapted to touch: pinch to zoom, drag to
 * pan while zoomed, tap the image to dismiss. Project files keep the web's download action; it sits
 * in the info bar with the close action instead of in a toolbar over the image.
 */
@Composable
private fun FullScreenImageViewer(
    url: String,
    label: String,
    detail: String? = null,
    onDismiss: () -> Unit,
    onDownload: (() -> Unit)? = null,
) {
    Dialog(
        onDismissRequest = onDismiss,
        // Edge to edge; each platform names that differently, so the platform seam answers.
        properties = viewerDialogProperties(),
    ) {
        ImageViewerPage(url = url, label = label, detail = detail, onDismiss = onDismiss, onDownload = onDownload)
    }
}

/**
 * The page itself, with no window around it, so a snapshot probe can render it off-device.
 *
 * The image owns the whole frame and is never cropped ([ContentScale.Fit]). The only chrome is one
 * bar at the bottom: the file's name, its path in mono, and the actions — the top of the screen is
 * image, all the way up. Tapping the image still dismisses, which is the whole-page gesture the
 * viewer has always had; the bar's own buttons consume their taps, so aiming at 下载 or 关闭 cannot
 * dismiss the page instead.
 */
@Composable
internal fun ImageViewerPage(
    url: String,
    label: String,
    detail: String? = null,
    onDismiss: () -> Unit,
    onDownload: (() -> Unit)? = null,
) {
    val context = LocalPlatformContext.current
    val loader = rememberRiffetImageLoader()
    var scale by remember(url) { mutableStateOf(1f) }
    var offset by remember(url) { mutableStateOf(Offset.Zero) }
    val transformState = rememberTransformableState { zoomChange, panChange, _ ->
        scale = (scale * zoomChange).coerceIn(1f, 6f)
        offset = if (scale <= 1f) Offset.Zero else offset + panChange
    }

    // BoxWithConstraints, not WindowInfo.containerSize: the latter is a skiko-only default and
    // does not exist on the Android target this app actually ships. The layout's own constraints
    // are the portable, and more honest, answer.
    BoxWithConstraints(modifier = Modifier.fillMaxSize().background(Color.Black)) {
        val widthPx = constraints.maxWidth
        val heightPx = constraints.maxHeight
        val request = remember(url, widthPx, heightPx, context) {
            ImageRequest.Builder(context)
                .data(url)
                .apply {
                    // 2x the viewport gives pinch-zoom real pixels to reveal without decoding
                    // a 4000 px photo whole. The range check rejects an unbounded constraint.
                    if (widthPx in 1..20_000 && heightPx in 1..20_000) {
                        size(widthPx * 2, heightPx * 2)
                    }
                }
                .scale(Scale.FIT)
                .build()
        }
        val painter = rememberAsyncImagePainter(
            model = request,
            imageLoader = loader,
            contentScale = ContentScale.Fit,
        )
        val state by painter.state.collectAsState()

        Box(
            modifier = Modifier
                .fillMaxSize()
                .transformable(state = transformState, lockRotationOnZoomPan = true)
                .pointerInput(Unit) { detectTapGestures { onDismiss() } },
            contentAlignment = Alignment.Center,
        ) {
            Image(
                painter = painter,
                contentDescription = label,
                contentScale = ContentScale.Fit,
                modifier = Modifier
                    .fillMaxSize()
                    .graphicsLayer {
                        scaleX = scale
                        scaleY = scale
                        translationX = offset.x
                        translationY = offset.y
                    },
            )
            when (state) {
                is AsyncImagePainter.State.Success -> Unit
                // A spinner that never resolves is the dishonest failure this viewer must not
                // have; say the image could not be loaded instead.
                is AsyncImagePainter.State.Error -> Text(
                    text = stringResource(Res.string.timeline_image_load_failed),
                    style = TimelineTheme.type.caption,
                    color = Color.White.copy(alpha = 0.85f),
                )
                else -> CircularProgressIndicator(
                    modifier = Modifier.size(28.dp),
                    color = Color.White.copy(alpha = 0.7f),
                    strokeWidth = 2.dp,
                )
            }
        }

        ImageViewerInfoBar(
            label = label,
            detail = detail,
            onDownload = onDownload,
            onDismiss = onDismiss,
            modifier = Modifier.align(Alignment.BottomCenter),
        )
    }
}

/**
 * The viewer's only chrome: what the file is, and the two things that can be done with it.
 *
 * A gradient rather than an opaque bar, so the image keeps the full height of the screen. The bottom
 * system inset is this bar's own business because the window draws under the gesture bar
 * ([viewerDialogProperties]); [WindowInsets.safeDrawing] is the portable way to ask for it and is
 * zero on a platform that has no such bar.
 */
@Composable
private fun ImageViewerInfoBar(
    label: String,
    detail: String?,
    onDownload: (() -> Unit)?,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) {
    // A project file's label is its path; the name is what the reader recognises, the rest is the
    // line below it. An attachment's label is already a name, and its detail carries the type.
    val name = label.substringAfterLast('/').ifEmpty { label }
    val secondary = listOfNotNull(detail, label.takeIf { it != name }).joinToString(" · ")
    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(
                Brush.verticalGradient(
                    0f to Color.Transparent,
                    0.5f to Color.Black.copy(alpha = 0.16f),
                    1f to Color.Black.copy(alpha = 0.38f),
                ),
            )
            .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom + WindowInsetsSides.Horizontal))
            .padding(start = 20.dp, end = 20.dp, top = 20.dp, bottom = 12.dp),
    ) {
        Text(
            text = name,
            style = TimelineTheme.type.body,
            color = Color.White,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (secondary.isNotEmpty()) {
            Spacer(Modifier.height(3.dp))
            Text(
                text = secondary,
                style = TimelineTheme.type.monoSmall,
                color = Color.White.copy(alpha = 0.6f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Spacer(Modifier.height(12.dp))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            if (onDownload != null) {
                ViewerAction(stringResource(Res.string.timeline_download), RiffetIcons.Download, primary = true, onClick = onDownload)
            }
            ViewerAction(stringResource(Res.string.timeline_close), RiffetIcons.Close, primary = false, onClick = onDismiss)
        }
    }
}

/** A pill in the info bar: filled white for the action that saves a copy, glass for closing. */
@Composable
private fun ViewerAction(text: String, icon: ImageVector, primary: Boolean, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .clip(CircleShape)
            .background(if (primary) Color.White else Color.White.copy(alpha = 0.14f))
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(
            icon,
            contentDescription = null,
            tint = if (primary) Color.Black else Color.White,
            modifier = Modifier.size(15.dp),
        )
        Text(text, style = TimelineTheme.type.label, color = if (primary) Color.Black else Color.White, maxLines = 1)
    }
}

@Composable
private fun LoadingBox() {
    val designMetrics = LocalInterfaceStyle.current.metrics
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        CircularProgressIndicator(
            modifier = Modifier.size(designMetrics.smallIconSize),
            color = TimelineTheme.colors.fg4,
            strokeWidth = 2.dp,
        )
    }
}

/** The bytes are known to exist but the app cannot address them. Honest, not an empty box. */
@Composable
private fun UnavailableBox(label: String) {
    StatusBox(label = label, message = stringResource(Res.string.timeline_attachment_unavailable))
}

/** The request was made and failed. Says so, rather than looking like a rendering bug. */
@Composable
private fun FailedBox(label: String, detail: String?) {
    StatusBox(label = label, message = stringResource(Res.string.timeline_image_load_failed), detail = detail)
}

@Composable
private fun StatusBox(label: String, message: String, detail: String? = null) {
    val colors = TimelineTheme.colors
    Column(
        modifier = Modifier.fillMaxSize().padding(8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            text = message,
            style = TimelineTheme.type.caption,
            color = colors.fg3,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.Center,
        )
        Text(
            text = detail ?: label,
            style = TimelineTheme.type.caption,
            color = colors.fg4,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}
