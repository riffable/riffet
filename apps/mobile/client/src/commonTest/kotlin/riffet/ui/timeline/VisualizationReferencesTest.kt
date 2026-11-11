package riffet.ui.timeline

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs

class VisualizationReferencesTest {
    private fun marker(json: String = "{\"path\":\".riffet/previews/chart.html\"}") = "\uE200visualize\uE202$json\uE201"

    @Test fun untrustedUrlsAndNulPathsNeverBecomeInteractiveReferences() {
        for (source in listOf(marker("{\"path\":\"https://example.com/index.html\"}"), marker("{\"path\":\"data:text/html,index.html\"}"), marker("{\"path\":\"foo\\u0000.html\"}"))) {
            assertEquals(source, assertIs<MarkdownSegment.Text>(splitVisualizationReferences(source).single()).text)
        }
    }
}
