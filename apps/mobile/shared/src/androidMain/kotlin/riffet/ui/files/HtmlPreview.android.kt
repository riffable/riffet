package riffet.ui.files

import android.annotation.SuppressLint
import android.graphics.Color
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.net.Uri
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import riffet.ui.design.RiffetMaterialPlatformView
import java.io.ByteArrayInputStream

internal actual val htmlPreviewSupported: Boolean = true

private val previewHosts = setOf("cdnjs.cloudflare.com", "cdn.jsdelivr.net", "esm.sh", "fonts.bunny.net", "fonts.googleapis.com", "fonts.gstatic.com", "unpkg.com")

@SuppressLint("SetJavaScriptEnabled")
@Composable
internal actual fun PlatformHtmlPreview(html: String, interactive: Boolean, modifier: Modifier, onError: (String) -> Unit, generated: Boolean) {
    val document = remember(html, interactive, generated) { htmlPreviewDocument(html, interactive, generated) }
    val reportError by rememberUpdatedState(onError)
    val generatedPage by rememberUpdatedState(generated)
    RiffetMaterialPlatformView { AndroidView(
        modifier = modifier,
        factory = { context ->
            WebView(context).apply {
                // A wrap-content WebView gives the full-height srcdoc frame a zero CSS viewport.
                layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                setBackgroundColor(Color.TRANSPARENT)
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                settings.domStorageEnabled = false
                settings.javaScriptCanOpenWindowsAutomatically = false
                settings.setSupportMultipleWindows(false)
                settings.cacheMode = WebSettings.LOAD_NO_CACHE
                CookieManager.getInstance().setAcceptThirdPartyCookies(this, false)
                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                        request.url.scheme != "about" || request.url.schemeSpecificPart.substringBefore('#') !in setOf("blank", "srcdoc")

                    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                        val url = request.url
                        if (url.scheme in setOf("about", "data", "blob")) return null
                        if (!generatedPage && url.scheme == "https" && url.host?.lowercase() in previewHosts && url.port in setOf(-1, 443) && url.userInfo == null) return null
                        return WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))
                    }

                    override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                        if (request.isForMainFrame) reportError(error.description.toString())
                    }
                }
            }
        },
        update = { view ->
            if (view.tag != document) {
                view.tag = document
                view.settings.javaScriptEnabled = interactive
                view.loadDataWithBaseURL(null, document, "text/html", "utf-8", null)
            }
        },
        onRelease = { view ->
            view.stopLoading()
            view.destroy()
        },
    ) }
}

private fun Uri.isSiteOf(origin: Uri?): Boolean =
    origin != null && scheme == origin.scheme && host.equals(origin.host, ignoreCase = true) && port == origin.port &&
        path.orEmpty().contains("/api/file-sites/")

/** A project site served by the connected server; its address carries the only credential the page has. */
@SuppressLint("SetJavaScriptEnabled")
@Composable
internal actual fun PlatformSitePreview(url: String?, modifier: Modifier, onPage: (url: String, status: Int) -> Unit, onError: (String) -> Unit) {
    val reportPage by rememberUpdatedState(onPage)
    val reportError by rememberUpdatedState(onError)
    val origin = remember(url) { url?.let(Uri::parse) }
    val currentOrigin by rememberUpdatedState(origin)
    RiffetMaterialPlatformView { AndroidView(
        modifier = modifier,
        factory = { context ->
            WebView(context).apply {
                layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                settings.javaScriptEnabled = true
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                settings.domStorageEnabled = false
                settings.javaScriptCanOpenWindowsAutomatically = false
                settings.setSupportMultipleWindows(false)
                settings.cacheMode = WebSettings.LOAD_NO_CACHE
                CookieManager.getInstance().setAcceptThirdPartyCookies(this, false)
                webViewClient = object : WebViewClient() {
                    /** The main-frame address the server last refused, and how; WebView may report it before or after the page starts. */
                    private var refused: Pair<String, Int>? = null

                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                        !request.url.isSiteOf(currentOrigin)

                    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                        val target = request.url
                        if (target.scheme in setOf("about", "data", "blob")) return null
                        if (target.isSiteOf(currentOrigin)) return null
                        if (target.scheme == "https" && target.host?.lowercase() in previewHosts && target.port in setOf(-1, 443) && target.userInfo == null) return null
                        return WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))
                    }

                    override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
                        if (request.isForMainFrame) refused = request.url.toString() to errorResponse.statusCode
                    }

                    override fun onPageFinished(view: WebView, url: String) {
                        val status = refused?.takeIf { it.first == url }?.second ?: 200
                        refused = null
                        if (url.contains("/api/file-sites/")) reportPage(url, status)
                    }

                    override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                        if (request.isForMainFrame) reportError(error.description.toString())
                    }
                }
            }
        },
        update = { view ->
            if (url != null && view.tag != url) {
                view.tag = url
                view.loadUrl(url)
            }
        },
        onRelease = { view ->
            view.stopLoading()
            view.destroy()
        },
    ) }
}
