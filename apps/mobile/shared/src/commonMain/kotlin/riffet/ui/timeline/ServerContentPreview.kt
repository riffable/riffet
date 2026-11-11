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
import kotlinx.serialization.encodeToString
import org.jetbrains.compose.resources.getString
import org.jetbrains.compose.resources.stringResource
import riffet.contracts.RiffetJson
import riffet.ui.files.PlatformHtmlPreview
import riffet.ui.settings.SettingsButton
import riffet.ui.theme.LocalRiffetColors
import riffet_mobile.shared.generated.resources.*

internal val contentPreviewLanguages = setOf("html", "htm", "svg")
internal val diagramLanguages = setOf("mermaid", "mmd", "dot", "graphviz", "gv", "plantuml", "puml", "uml", "wsd", "d2", "vega", "vega-lite", "vegalite", "vl")

/** Authenticated bytes, an opaque sandbox, no bridge, no host origin or network privileges. */
@Composable
internal fun ServerContentPreview(path: String, source: String? = null, language: String? = null, modifier: Modifier = Modifier, parameters: List<Pair<String, String>> = emptyList()) {
    val designMetrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    var html by remember(path, source, language, colors, parameters) { mutableStateOf<String?>(null) }
    var failure by remember(path, source, language, colors, parameters) { mutableStateOf<String?>(null) }
    var retry by remember { mutableStateOf(0) }
    LaunchedEffect(path, source, language, colors, parameters, retry) {
        html = null; failure = null
        val theme = listOf("scheme" to if (colors.bg.luminance() < 0.5f) "dark" else "light",
            "color" to previewColorHex(colors.fg), "background" to previewColorHex(colors.bg),
            "line" to previewColorHex(colors.line), "accent" to previewColorHex(colors.accent))
        try {
            if (source != null && language != null) {
                val fragment = (theme + listOf("source" to source, "language" to language)).joinToString("&") { (key, value) -> "${key.encodeURLParameter()}=${value.encodeURLParameter()}" }
                val encoded = RiffetJson.instance.encodeToString("#" + fragment).replace("<", "\\u003c")
                html = "<script>location.hash=$encoded;</script>" + fetchServerPreview(path, if (path == "/diagram") listOf("engine" to language) else emptyList())
            } else html = fetchServerPreview(path, parameters + theme + ("render" to "preview"))
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
