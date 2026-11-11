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
import riffet.ui.timeline.previewColorHex

internal fun isHtmlPreviewPath(path: String): Boolean =
    path.substringAfterLast('.').lowercase() in setOf("html", "htm")

/** The existing authenticated transport fetches the page; no credential reaches the WebView. */
@Composable
internal fun HtmlFilePreview(api: RiffetApi, projectId: String, path: String, interactive: Boolean, modifier: Modifier, generated: Boolean = false) {
    val designMetrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val scheme = if (colors.bg.luminance() < 0.5f) "dark" else "light"
    var html by remember(api, projectId, path, colors, generated) { mutableStateOf<String?>(null) }
    var failure by remember(api, projectId, path, colors, generated) { mutableStateOf<String?>(null) }
    var retry by remember { mutableStateOf(0) }
    LaunchedEffect(api, projectId, path, colors, generated, retry) {
        html = null
        failure = null
        try {
            html = if (generated) api.renderedPreview(projectId, path, scheme, previewColorHex(colors.fg),
                previewColorHex(colors.bg), previewColorHex(colors.line), previewColorHex(colors.accent))
            else api.visualization(projectId, path, scheme)
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

internal expect val htmlPreviewSupported: Boolean

@Composable
internal expect fun PlatformHtmlPreview(html: String, interactive: Boolean, modifier: Modifier, onError: (String) -> Unit, generated: Boolean = false)

private const val previewResources = "data: blob: https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://esm.sh https://fonts.bunny.net https://fonts.googleapis.com https://fonts.gstatic.com https://unpkg.com"

/** Same opaque-frame contract as the Web and native iPhone preview, without an application origin. */
internal fun htmlPreviewDocument(source: String, interactive: Boolean, generated: Boolean = false): String {
    val resources = if (generated) "data: blob:" else previewResources
    val scripts = if (!interactive) "'none'" else if (generated) "'unsafe-inline' 'wasm-unsafe-eval' blob:" else "'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' $resources"
    val policy = "default-src 'none'; script-src $scripts; style-src 'unsafe-inline' $resources; img-src $resources; font-src $resources; media-src $resources; worker-src ${if (interactive) "blob:" else "'none'"}; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
    val child = "<!doctype html><html><head><meta http-equiv=\"Content-Security-Policy\" content=\"${htmlAttribute("$policy; frame-src 'none'")}\"><meta name=\"referrer\" content=\"no-referrer\"></head><body>$source</body></html>"
    return "<!doctype html><html><head><meta http-equiv=\"Content-Security-Policy\" content=\"${htmlAttribute("$policy; frame-src 'self'")}\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"referrer\" content=\"no-referrer\"><style>html,body,iframe{margin:0;padding:0;border:0;width:100%;height:100%;background:transparent}iframe{display:block}</style></head><body><iframe sandbox=\"${if (interactive) "allow-scripts" else ""}\" referrerpolicy=\"no-referrer\" srcdoc=\"${htmlAttribute(child)}\"></iframe></body></html>"
}

private fun htmlAttribute(value: String): String =
    value.replace("&", "&amp;").replace("\"", "&quot;").replace("<", "&lt;").replace(">", "&gt;")
