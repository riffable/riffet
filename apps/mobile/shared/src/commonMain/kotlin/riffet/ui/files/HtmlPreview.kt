package riffet.ui.files

import riffet.ui.design.LocalInterfaceStyle
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.jetbrains.compose.resources.getString
import org.jetbrains.compose.resources.stringResource
import riffet_mobile.shared.generated.resources.*
import riffet.shared.RiffetApi
import riffet.ui.settings.SettingsButton
import riffet.ui.settings.SettingsNoticeKind
import riffet.ui.settings.SettingsMessageBanner
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.timeline.Spinner
import riffet.shared.visualization
import riffet.shared.renderedPreview
import riffet.shared.fileSiteUrl
import riffet.ui.timeline.previewColorHex

internal fun isHtmlPreviewPath(path: String): Boolean =
    path.substringAfterLast('.').lowercase() in setOf("html", "htm")

/** The existing authenticated transport fetches the page; no credential reaches the WebView. */
@Composable
internal fun HtmlFilePreview(api: RiffetApi, projectId: String, path: String, interactive: Boolean, modifier: Modifier, generated: Boolean = false) {
    val designMetrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val scheme = if (colors.bg.luminance() < 0.5f) "dark" else "light"
    var html by remember(api, projectId, path, colors, interactive, generated) { mutableStateOf<String?>(null) }
    var failure by remember(api, projectId, path, colors, interactive, generated) { mutableStateOf<String?>(null) }
    var retry by remember { mutableStateOf(0) }
    LaunchedEffect(api, projectId, path, colors, interactive, generated, retry) {
        html = null
        failure = null
        try {
            val source = if (generated) api.renderedPreview(projectId, path, scheme, previewColorHex(colors.fg),
                previewColorHex(colors.bg), previewColorHex(colors.line), previewColorHex(colors.accent))
            else api.visualization(projectId, path, scheme)
            html = withContext(Dispatchers.Default) { htmlPreviewDocument(source, interactive || generated, generated) }
        }
        catch (cancellation: CancellationException) { throw cancellation }
        catch (error: Throwable) { failure = error.message ?: getString(Res.string.files_html_read_failed) }
    }
    val error = failure
    val content = html
    when {
        error != null -> Column(modifier.padding(designMetrics.rowPadding), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            SettingsMessageBanner(error, SettingsNoticeKind.ERROR)
            SettingsButton(stringResource(Res.string.files_retry), onClick = { retry++ })
        }
        content != null -> PlatformHtmlPreview(content, interactive || generated, modifier, onError = { failure = it }, generated = generated)
        else -> Box(modifier, contentAlignment = Alignment.Center) { Spinner(size = 20.dp) }
    }
}

/** The path segment after the token of `/api/file-sites/<token>/…`, wherever the server's base path puts it. */
private val sitePage = Regex("/api/file-sites/[^/]+/([^?#]*)")

/**
 * The project path of the page a site's main frame shows, for a site opened from [entry]; the
 * server resolves a folder to its index.html the same way. Mirrors `sitePagePath` on the Web.
 */
internal fun sitePagePath(entry: String, url: String): String? {
    val raw = sitePage.find(url)?.groupValues?.get(1) ?: return null
    val parts = raw.split('/').map { segment -> percentDecode(segment)?.takeIf { it != "." && it != ".." && '/' !in it && '\\' !in it } }
    if (parts.any { it == null }) return null
    var relative = parts.joinToString("/")
    if (relative.isEmpty() || relative.endsWith("/")) relative += "index.html"
    val slash = entry.lastIndexOf('/')
    return if (slash < 0) relative else entry.substring(0, slash) + "/" + relative
}

private fun percentDecode(segment: String): String? {
    if ('%' !in segment) return segment
    val bytes = ArrayList<Byte>()
    var i = 0
    while (i < segment.length) {
        val c = segment[i]
        if (c == '%') {
            val code = segment.substring(i + 1, minOf(i + 3, segment.length)).takeIf { it.length == 2 }?.toIntOrNull(16) ?: return null
            bytes.add(code.toByte())
            i += 3
        } else {
            bytes.addAll(c.toString().encodeToByteArray().toList())
            i++
        }
    }
    return runCatching { bytes.toByteArray().decodeToString(throwOnInvalidSequence = true) }.getOrNull()
}

private class SiteLoad(val page: String, val count: Int)

private class SiteState(var showing: String, var renewed: String? = null, var version: String?)

/**
 * A project HTML file served with its folder as the site, so links, styles and scripts resolve as
 * in a browser. The authenticated request only mints the address; the WebView never holds the
 * device credential. [onPage] reports the project path of the page shown; the page reloads when
 * [version] changes, and re-mints once when its token has expired.
 */
@Composable
internal fun HtmlSitePreview(api: RiffetApi, projectId: String, entry: String, version: String?, onPage: (String) -> Unit, modifier: Modifier) {
    val designMetrics = LocalInterfaceStyle.current.metrics
    val state = remember(api, projectId, entry) { SiteState(entry, version = version) }
    var load by remember(api, projectId, entry) { mutableStateOf(SiteLoad(entry, 0)) }
    var url by remember(api, projectId, entry) { mutableStateOf<String?>(null) }
    var failure by remember(api, projectId, entry) { mutableStateOf<String?>(null) }
    LaunchedEffect(version) {
        if (state.version == version) return@LaunchedEffect
        state.version = version
        load = SiteLoad(state.showing, load.count + 1)
    }
    LaunchedEffect(api, projectId, load) {
        failure = null
        // Cleared first: a token minted within the same hour is the same address, which the WebView would not load again.
        url = null
        // The site stays rooted at the folder of [entry]; another page is reopened inside it, keeping its `../` links.
        val folder = entry.substringBeforeLast('/', "")
        val relative = when {
            load.page == entry -> null
            folder.isEmpty() -> load.page
            else -> load.page.removePrefix("$folder/").takeIf { it != load.page }
        }
        try { url = api.fileSiteUrl(projectId, entry, relative) }
        catch (cancellation: CancellationException) { throw cancellation }
        catch (error: Throwable) { failure = error.message ?: getString(Res.string.files_html_read_failed) }
    }
    val error = failure
    val reportPage: (String, Int) -> Unit = { shown, status ->
        val page = sitePagePath(entry, shown)
        if (page != null) when (status) {
            401 -> if (state.renewed != page) {
                state.renewed = page
                state.showing = page
                load = SiteLoad(page, load.count + 1)
            }
            200 -> {
                state.renewed = null
                state.showing = page
                onPage(page)
            }
        }
    }
    if (error != null) Column(modifier.padding(designMetrics.rowPadding), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        SettingsMessageBanner(error, SettingsNoticeKind.ERROR)
        SettingsButton(stringResource(Res.string.files_retry), onClick = { load = SiteLoad(load.page, load.count + 1) })
    } else if (url == null) Box(modifier, contentAlignment = Alignment.Center) { Spinner(size = 20.dp) }
    else PlatformSitePreview(url, modifier, onPage = reportPage, onError = { failure = it })
}

internal expect val htmlPreviewSupported: Boolean

/** Loads [url], a tokenised site address; reports each main-frame page that finished loading and its HTTP status. */
@Composable
internal expect fun PlatformSitePreview(url: String?, modifier: Modifier, onPage: (url: String, status: Int) -> Unit, onError: (String) -> Unit)

/** Shows [document], built by [htmlPreviewDocument] or [htmlPreviewFrame] off the main thread. */
@Composable
internal expect fun PlatformHtmlPreview(document: String, interactive: Boolean, modifier: Modifier, onError: (String) -> Unit, generated: Boolean = false)

private const val previewResources = "data: blob: https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://esm.sh https://fonts.bunny.net https://fonts.googleapis.com https://fonts.gstatic.com https://unpkg.com"

/** Same opaque-frame contract as the Web and native iPhone preview, without an application origin. */
internal fun htmlPreviewDocument(source: String, interactive: Boolean, generated: Boolean = false): String =
    htmlPreviewFrame(htmlAttribute(source), interactive, generated)

/**
 * [htmlPreviewDocument] for a body already passed through [htmlAttribute]. Escaping is per
 * character, so a large body many previews share (a diagram renderer) is escaped once and reused.
 * Megabytes of string work: call it off the main thread.
 */
internal fun htmlPreviewFrame(escapedBody: String, interactive: Boolean, generated: Boolean = false): String {
    val resources = if (generated) "data: blob:" else previewResources
    val scripts = if (!interactive) "'none'" else if (generated) "'unsafe-inline' 'wasm-unsafe-eval' blob:" else "'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' $resources"
    val policy = "default-src 'none'; script-src $scripts; style-src 'unsafe-inline' $resources; img-src $resources; font-src $resources; media-src $resources; worker-src ${if (interactive) "blob:" else "'none'"}; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
    val childHead = "<!doctype html><html><head><meta http-equiv=\"Content-Security-Policy\" content=\"${htmlAttribute("$policy; frame-src 'none'")}\"><meta name=\"referrer\" content=\"no-referrer\"></head><body>"
    val head = "<!doctype html><html><head><meta http-equiv=\"Content-Security-Policy\" content=\"${htmlAttribute("$policy; frame-src 'self'")}\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"referrer\" content=\"no-referrer\"><style>html,body,iframe{margin:0;padding:0;border:0;width:100%;height:100%;background:transparent}iframe{display:block}</style></head><body><iframe sandbox=\"${if (interactive) "allow-scripts" else ""}\" referrerpolicy=\"no-referrer\" srcdoc=\""
    return buildString(escapedBody.length + 2048) {
        append(head)
        append(htmlAttribute(childHead))
        append(escapedBody)
        append(htmlAttribute("</body></html>"))
        append("\"></iframe></body></html>")
    }
}

/** One pass over [value]; most of a renderer bundle needs no escaping and is copied as is. */
internal fun htmlAttribute(value: String): String {
    val first = value.indexOfFirst { it == '&' || it == '"' || it == '<' || it == '>' }
    if (first < 0) return value
    val out = StringBuilder(value.length + value.length / 8)
    out.appendRange(value, 0, first)
    for (index in first until value.length) when (val char = value[index]) {
        '&' -> out.append("&amp;")
        '"' -> out.append("&quot;")
        '<' -> out.append("&lt;")
        '>' -> out.append("&gt;")
        else -> out.append(char)
    }
    return out.toString()
}
