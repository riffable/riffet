package riffet.shared

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse

class RiffetApiVisualizationTest {
    @Test
    fun interactiveHtmlUsesAnAuthenticatedEncodedRequest() = runTest {
        val seen = mutableListOf<HttpRequestData>()
        val html = "<!doctype html><html><body>交互预览<script>window.ready = true</script></body></html>"
        val client = HttpClient(MockEngine { request ->
            seen += request
            respond(html, HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "text/html; charset=utf-8"))
        }) { installRiffetClient() }
        try {
            val token = "wkn_visualization_secret"
            val api = RiffetApi(client, "http://127.0.0.1:9", tokenProvider = { token })
            val path = "work/预览 + demo/chart?#1.html"

            assertEquals(html, api.visualization("project /+#", path, "light"))
            val request = seen.last()
            assertEquals(HttpMethod.Get, request.method)
            assertEquals("/api/projects/project%20%2F+%23/file/raw", request.url.encodedPath)
            assertEquals(path, request.url.parameters["path"])
            assertEquals("visualize", request.url.parameters["render"])
            assertEquals("Bearer $token", request.headers[HttpHeaders.Authorization])
            assertEquals("", request.url.fragment)
            assertFalse(request.url.toString().contains(token))
            assertEquals(1, seen.size)
        } finally {
            client.close()
        }
    }

    @Test
    fun aSiteAddressIsMintedWithoutFollowingTheRedirect() = runTest {
        val seen = mutableListOf<HttpRequestData>()
        val client = HttpClient(MockEngine { request ->
            seen += request
            if (request.url.encodedPath.startsWith("/api/file-sites/")) respond("page", HttpStatusCode.OK)
            else respond("", HttpStatusCode.Found, headersOf(HttpHeaders.Location, "../../../file-sites/tok/index.html"))
        }) { installRiffetClient() }
        try {
            val api = RiffetApi(client, "http://127.0.0.1:9", tokenProvider = { "wkn_site_secret" })
            assertEquals("http://127.0.0.1:9/api/file-sites/tok/index.html", api.fileSiteUrl("p1", "a/index.html"))
            assertEquals(1, seen.size)
            assertEquals("site", seen[0].url.parameters["render"])
            assertEquals("Bearer wkn_site_secret", seen[0].headers[HttpHeaders.Authorization])
            assertEquals("http://h:1/x/y/c.html?q=1", resolveLocation("http://h:1/x/y/z/raw", "../c.html?q=1"))
        } finally { client.close() }
    }
}
