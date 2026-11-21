package riffet.ui.timeline

import riffet.ui.design.LocalInterfaceStyle
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.unit.dp
import io.ktor.http.encodeURLParameter
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import org.jetbrains.compose.resources.getString
import org.jetbrains.compose.resources.stringResource
import riffet.contracts.RiffetJson
import riffet.ui.files.PlatformHtmlPreview
import riffet.ui.files.htmlAttribute
import riffet.ui.files.htmlPreviewDocument
import riffet.ui.files.htmlPreviewFrame
import riffet.ui.platform.CacheRegistry
import riffet.ui.platform.RegisteredCache
import riffet.contracts.TEXT_CACHE_BYTES_PHONE
import riffet.ui.settings.SettingsButton
import riffet.ui.theme.LocalRiffetColors
import riffet_mobile.shared.generated.resources.*

internal val contentPreviewLanguages = setOf("html", "htm", "svg")
internal val diagramLanguages = setOf("mermaid", "mmd", "dot", "graphviz", "gv", "plantuml", "puml", "uml", "wsd", "d2", "vega", "vega-lite", "vegalite", "vl")

/**
 * A renderer page (`/diagram?engine=…`) is the same for every block of that engine — the source
 * travels in the frame's hash — and is megabytes of script. Each block used to fetch, decode and
 * escape it again on the main thread whenever its row came back into view. Keep the escaped page:
 * always the newest, older ones while they fit half the phone's text budget.
 */
private object RendererShells {
    private val lock = Mutex()
    private val pages = LinkedHashMap<String, String>()

    init {
        CacheRegistry.register(RegisteredCache("renderer-pages", TEXT_CACHE_BYTES_PHONE / 2, ::bytes) { clear() })
    }

    suspend fun escaped(path: String, parameters: List<Pair<String, String>>): String = lock.withLock {
        val key = (RiffetImageAuth.baseUrl() ?: "") + path + parameters
        pages.remove(key)?.let { pages[key] = it; return it }
        val page = fetchServerPreview(path, parameters)
        val escaped = withContext(Dispatchers.Default) { htmlAttribute(page) }  // compose-pitfalls: allow the renderer page is escaped once per engine; the block holds its 320dp
        pages[key] = escaped
        while (pages.size > 1 && bytes() > TEXT_CACHE_BYTES_PHONE / 2) pages.remove(pages.keys.first())
        escaped
    }

    // UTF-16 upper bound; renderer bundles are mostly ASCII.
    private fun bytes(): Long = pages.values.sumOf { it.length * 2L }

    private fun clear() { if (lock.tryLock()) try { pages.clear() } finally { lock.unlock() } }
}

/**
 * Whether the list holding the preview has stopped scrolling. A preview starts its WebView and
 * loads its page only once the list settles: a fling past a dozen diagrams otherwise creates a
 * dozen WebViews and hands each megabytes of script on the main thread. Outside a list it is
 * always settled. The State itself never changes, so a static local is enough.
 */
internal val LocalListSettled = staticCompositionLocalOf<State<Boolean>> { mutableStateOf(true) }

/** Authenticated bytes, an opaque sandbox, no bridge, no host origin or network privileges. */
@Composable
internal fun ServerContentPreview(path: String, source: String? = null, language: String? = null, modifier: Modifier = Modifier, parameters: List<Pair<String, String>> = emptyList()) {
    val designMetrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    var html by remember(path, source, language, colors, parameters) { mutableStateOf<String?>(null) }
    var failure by remember(path, source, language, colors, parameters) { mutableStateOf<String?>(null) }
    var retry by remember { mutableStateOf(0) }
    val settled = LocalListSettled.current
    LaunchedEffect(path, source, language, colors, parameters, retry) {
        html = null; failure = null
        snapshotFlow { settled.value }.first { it }
        val theme = listOf("scheme" to if (colors.bg.luminance() < 0.5f) "dark" else "light",
            "color" to previewColorHex(colors.fg), "background" to previewColorHex(colors.bg),
            "line" to previewColorHex(colors.line), "accent" to previewColorHex(colors.accent))
        try {
            html = if (source != null && language != null) {
                val fragment = (theme + listOf("source" to source, "language" to language)).joinToString("&") { (key, value) -> "${key.encodeURLParameter()}=${value.encodeURLParameter()}" }
                val encoded = RiffetJson.instance.encodeToString("#" + fragment).replace("<", "\\u003c")
                val shell = RendererShells.escaped(path, if (path == "/diagram") listOf("engine" to language) else emptyList())
                withContext(Dispatchers.Default) { htmlPreviewFrame(htmlAttribute("<script>location.hash=$encoded;</script>") + shell, interactive = true, generated = true) }  // compose-pitfalls: allow the preview box keeps its fixed 320dp while the page is built
            } else {
                val page = fetchServerPreview(path, parameters + theme + ("render" to "preview"))
                withContext(Dispatchers.Default) { htmlPreviewDocument(page, interactive = true, generated = true) }  // compose-pitfalls: allow the preview box keeps its fixed 320dp while the page is built
            }
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (error: Throwable) { failure = error.message ?: getString(Res.string.timeline_preview_failed) }
    }
    val content = html
    val error = failure
    when {
        error != null -> Column(modifier.padding(designMetrics.rowPadding), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(error, color = colors.fg3)
            SettingsButton(stringResource(Res.string.timeline_retry), onClick = { retry++ })
        }
        content != null -> PlatformHtmlPreview(content, interactive = true, modifier = modifier, onError = { failure = it }, generated = true)
        else -> Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Spinner() }
    }
}
