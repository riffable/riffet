package riffet.ui.files

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class HtmlPreviewTest {
    @Test
    fun interactivePagesHaveAnOpaqueSandboxAndNoApplicationAccess() {
        val html = htmlPreviewDocument("<button onclick=\"this.textContent='done'\">Choose</button>", interactive = true)
        assertTrue(html.contains("sandbox=\"allow-scripts\""))
        assertFalse(html.contains("allow-same-origin"))
        assertTrue(html.contains("connect-src 'none'"))
        assertTrue(html.contains("form-action 'none'"))
        assertTrue(html.contains("frame-src 'none'"))
        assertTrue(html.contains("frame-src 'self'"))
        val static = htmlPreviewDocument("<script>bad()</script>", interactive = false)
        assertTrue(static.contains("script-src 'none'"))
        assertFalse(static.contains("allow-scripts"))
    }

    @Test
    fun anUntrustedDocumentCannotEscapeTheFrameAttributeOrPrecedeThePolicy() {
        val source = "\" onload=\"bad()\"><script>bad()</script>&"
        val html = htmlPreviewDocument(source, interactive = true)
        assertFalse(html.contains(source))
        assertTrue(html.indexOf("Content-Security-Policy") < html.indexOf("&lt;script&gt;bad()"))
        assertTrue(html.contains("&amp;"))
    }

    @Test
    fun generatedPreviewsKeepNetworkDisabledWhileAllowingEmbeddedAssetsAndWorkers() {
        val html = htmlPreviewDocument("<script>render()</script>", interactive = true, generated = true)
        assertTrue(html.contains("sandbox=\"allow-scripts\""))
        assertTrue(html.contains("worker-src blob:"))
        assertTrue(html.contains("media-src data: blob:"))
        assertTrue(html.contains("connect-src 'none'"))
        assertFalse(html.contains("allow-same-origin"))
        assertFalse(html.contains("https://"))
        assertFalse(html.contains("'unsafe-eval'"))
    }

}
