package riffet.shared

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.*
import io.ktor.http.content.TextContent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.*
import riffet.contracts.*

class RiffetApiExtensionsTest {
    private val headers = headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString())
    @Test
    fun savesInTheSelectedProfileAndPreservesTheRevisionOnTheWire() = runTest {
        val seen = mutableListOf<HttpRequestData>()
        val http = HttpClient(MockEngine { request ->
            seen += request
            respond("""{"id":"file","path":"skills/a/SKILL.md","editable":true,"content":"saved","hash":"raw-revision","language":"markdown","applyEffect":"new session"}""", HttpStatusCode.OK, headers)
        }) { installRiffetClient() }
        try {
            val api = RiffetApi(http, "http://127.0.0.1:9")
            val response = api.saveExtensionDocument(ExtensionContext(NativeBackendId.CLAUDE, "work profile", "project-one"), "file", "new content", "old-revision")
            val request = seen.single()
            assertEquals(HttpMethod.Put, request.method)
            assertEquals("/api/backends/claude/extensions/documents/file", request.url.encodedPath)
            assertEquals("work profile", request.url.parameters["profileId"])
            assertEquals("project-one", request.url.parameters["projectId"])
            val body = RiffetJson.instance.parseToJsonElement((request.body as TextContent).text).jsonObject
            assertEquals("old-revision", body["expectedHash"]?.jsonPrimitive?.content)
            assertEquals("new content", body["content"]?.jsonPrimitive?.content)
            assertEquals("raw-revision", response.contentHash)
        } finally { http.close() }
    }

    @Test
    fun toleratesNewResourceKindsAndOmitsTheProjectInAUserOnlyContext() = runTest {
        val seen = mutableListOf<HttpRequestData>()
        val http = HttpClient(MockEngine { request ->
            seen += request
            respond("""{"backendId":"codex","profileId":"local","checkedAt":"now","items":[{"id":"x","kind":"future-kind","name":"new","scope":"future-scope","runtimeState":"future-state","extra":1}]}""", HttpStatusCode.OK, headers)
        }) { installRiffetClient() }
        try {
            val result = RiffetApi(http, "http://127.0.0.1:9").extensions(ExtensionContext(NativeBackendId.CODEX, "local"))
            assertEquals("future-kind", result.items.single().kind)
            assertNull(seen.single().url.parameters["projectId"])
            assertTrue(result.createTargets.isEmpty())
        } finally { http.close() }
    }

    @Test
    fun preservesNativeAuthorizationAndInstallationScopes() = runTest {
        val http = HttpClient(MockEngine { request ->
            val content = if (request.url.encodedPath.endsWith("/capabilities"))
                """{"actions":["install"],"kinds":{"plugin":["install"]},"installScopes":["user"]}"""
            else """{"success":true,"applyEffect":"authorize","authorizationUrl":"https://example.com/oauth"}"""
            respond(content, HttpStatusCode.OK, headers)
        }) { installRiffetClient() }
        try {
            val api = RiffetApi(http, "http://127.0.0.1:9")
            val context = ExtensionContext(NativeBackendId.CODEX, "local")
            assertEquals(listOf("user"), api.extensionCapabilities(context).installScopes)
            assertEquals("https://example.com/oauth", api.extensionAction(context, ExtensionActionRequest("login", target = "docs")).authorizationUrl)
        } finally { http.close() }
    }
}
