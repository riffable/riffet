package riffet.shared

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** The command route and the task confirmation against what the server sends (docs/design/plugin-system.md §4.3). */
class RiffetApiCommandsTest {
    private val json = headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString())
    private fun bodyOf(request: HttpRequestData): String = (request.body as TextContent).text

    @Test
    fun runsACommandWithTypedArgsAndDecodesItsResult() = runTest {
        val seen = mutableListOf<HttpRequestData>()
        val client = HttpClient(MockEngine { request ->
            seen += request
            respond("""{"kind":"open","view":"riffet.android/builds","path":"app/build.gradle","futureField":1}""", HttpStatusCode.OK, json)
        }) { installRiffetClient() }
        val params = listOf(
            TaskParamField(key = "flavor", kind = "choice", options = listOf("debug", "release"), default = JsonPrimitive("debug")),
            TaskParamField(key = "clean", kind = "boolean"),
            TaskParamField(key = "note", kind = "text"),
        )
        val run = RiffetApi(client, "http://127.0.0.1:9").runCommand("riffet.android/assemble-debug", "r1", "p1", null, mapOf("clean" to "true", "note" to ""), params, null)
        assertEquals("/api/integrations/riffet.android/commands/assemble-debug", seen.single().url.encodedPath)
        assertEquals("""{"requestId":"r1","projectId":"p1","args":{"flavor":"debug","clean":true}}""", bodyOf(seen.single()))
        assertEquals("open", run.result!!.kind)
        assertEquals("riffet.android/builds", run.result!!.view)
        assertNull(run.confirmation)
        client.close()
    }

    @Test
    fun anUnapprovedPlanComesBackAsAConfirmationForTasksAndCommands() = runTest {
        val refusal = """{"error":{"code":"TASK_CONFIRM_REQUIRED","message":"Confirm first","details":{"fingerprint":"abc","plan":{"file":"gradlew","args":["assemble Debug"],"cwd":".","env":{"A":"1"}}}}}"""
        val client = HttpClient(MockEngine { respond(refusal, HttpStatusCode.Conflict, json) }) { installRiffetClient() }
        val api = RiffetApi(client, "http://127.0.0.1:9")

        val started = api.startTask(TaskCreate("r1", "p1", "x/y", "build"))
        val plan = started.confirmation!!
        assertNull(started.task)
        assertEquals("abc", plan.fingerprint)
        assertEquals(listOf("assemble Debug"), plan.args)
        assertEquals(mapOf("A" to "1"), plan.env)

        val run = api.runCommand("x/go", "r2", null, null, emptyMap(), emptyList(), null)
        assertEquals("abc", run.confirmation!!.fingerprint)
        assertNull(run.result)
        client.close()
    }

    @Test
    fun pluginUploadUsesTheServiceCredentialAndReturnsVersionGrants() = runTest {
        val seen = mutableListOf<HttpRequestData>()
        val client = HttpClient(MockEngine { request ->
            seen += request
            respond("""{"error":{"code":"PLUGIN_GRANT_REQUIRED","message":"grant required","details":{"id":"acme.view","version":"1.0.0","capabilities":["sessions.read"]}}}""", HttpStatusCode.Conflict, json)
        }) { installRiffetClient() }
        val api = RiffetApi(client, "http://127.0.0.1:9", tokenProvider = { "test-device-token" })
        val reply = api.installPluginPackage(byteArrayOf(1, 2, 3), "sample.tgz", emptyList())
        assertNull(reply.plugin)
        assertEquals(listOf("sessions.read"), reply.grant!!.capabilities)
        assertEquals("Bearer test-device-token", seen.single().headers[HttpHeaders.Authorization])
        assertEquals("/api/integrations/install", seen.single().url.encodedPath)
        assertEquals("multipart", seen.single().body.contentType?.contentType)
        client.close()
    }

    @Test
    fun pluginConfigurationCarriesTheRevisionAndOnlyTheEditedFields() = runTest {
        val seen = mutableListOf<HttpRequestData>()
        val client = HttpClient(MockEngine { request ->
            seen += request
            respond("""{"id":"acme.demo","configRevision":"next","settings":[{"key":"token","label":"Token","kind":"secret","set":true}]}""", HttpStatusCode.OK, json)
        }) { installRiffetClient() }
        val api = RiffetApi(client, "http://127.0.0.1:9")
        val result = api.updatePlugin("acme.demo", PluginUpdate(settings = mapOf("token" to "replacement"), configRevision = "before"))
        assertEquals("next", result.configRevision)
        assertNull(result.settings.single().value)
        val body = WireJson.parseToJsonElement(bodyOf(seen.single())).toString()
        assertEquals("""{"settings":{"token":"replacement"},"configRevision":"before"}""", body)
        client.close()
    }
}
