package riffet.ui.timeline

import kotlin.test.Test
import kotlin.test.assertEquals

class BareUrlsTest {
    private fun links(text: String): List<Pair<String, String>> =
        findBareUrls(text).map { text.substring(it.start, it.end) to it.url }

    @Test
    fun `extracts bare URLs with Chinese punctuation, commas, queries and balanced delimiters`() {
        val sample = "看一下，\nhttps://example.com/wiki/Abc123?t=1795504601857,\nhttps://example.com/docx/Def456?t=1795504633404, 讨论"
        assertEquals(
            listOf(
                "https://example.com/wiki/Abc123?t=1795504601857" to "https://example.com/wiki/Abc123?t=1795504601857",
                "https://example.com/docx/Def456?t=1795504633404" to "https://example.com/docx/Def456?t=1795504633404",
            ),
            links(sample),
        )
        assertEquals(
            listOf("https://example.com" to "https://example.com"),
            links("访问https://example.com看看效果"),
        )
        assertEquals(
            listOf(
                "https://a.com/x" to "https://a.com/x",
                "https://b.com/y" to "https://b.com/y",
            ),
            links("(https://a.com/x)和(https://b.com/y)"),
        )
        assertEquals(
            listOf(
                "https://a.com/x" to "https://a.com/x",
                "https://b.com/y" to "https://b.com/y",
            ),
            links("[https://a.com/x](https://b.com/y)"),
        )
        assertEquals(
            listOf("https://en.wikipedia.org/wiki/Swift_(programming_language)" to "https://en.wikipedia.org/wiki/Swift_(programming_language)"),
            links("(see https://en.wikipedia.org/wiki/Swift_(programming_language))."),
        )
        assertEquals(
            listOf(
                "http://[::1]:8080/api?filter[a]=1" to "http://[::1]:8080/api?filter[a]=1",
                "HTTPS://Example.COM/Path" to "https://Example.COM/Path",
                "WWW.example.com/docs" to "http://WWW.example.com/docs",
            ),
            links("[http://[::1]:8080/api?filter[a]=1], HTTPS://Example.COM/Path WWW.example.com/docs"),
        )
        assertEquals(
            listOf(
                "https://example.com" to "https://example.com",
                "http://example.com" to "http://example.com",
            ),
            links("https://example.com.: 说明, http://example.com,a@example.com"),
        )
    }

    @Test
    fun `rejects malformed hosts, bad ports, mid-word prefixes, non-http schemes and emails`() {
        val samples = listOf(
            "把http://改成https://",
            "http:// https:///foo https://. https://a..b.com https://-a.com",
            "http://localhost:99999 http://localhost:0 http://localhost:80abc",
            "xhttp://a.com foo_https://a.com a.www.a.com path/www.a.com user@www.example.com",
            "www.x www.foo.1 www..com",
            "javascript:alert(1) file:///etc/passwd ftp://a.com mailto:a@example.com user@example.com",
        )
        for (sample in samples) {
            assertEquals(emptyList(), links(sample), sample)
        }
    }
}
