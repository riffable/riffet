package riffet.shared

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.ContentType
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The project/directory endpoints the phone needs to bind a directory nobody registered before.
 * The web already had these; this pins the wire shapes the mobile client now sends, because a typo
 * in a JSON key here fails at runtime on a phone, not at compile time.
 */
class RiffetApiProjectsTest {

    private val jsonHeaders = headersOf(io.ktor.http.HttpHeaders.ContentType, ContentType.Application.Json.toString())

    private fun bodyOf(request: HttpRequestData): String = (request.body as TextContent).text

    private fun project(id: String = "p1", cwd: String = "/tmp/one", archivedAt: String? = null): String =
        """{"id":"$id","name":"one","cwd":"$cwd","createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"${archivedAt?.let { ""","archivedAt":"$it"""" } ?: ""}}"""

    @Test
    fun createProjectPostsTheDirectoryAndDecodesTheProject() = runTest {
        val seen = mutableListOf<HttpRequestData>()
        val engine = MockEngine { request ->
            seen += request
            respond(project(), HttpStatusCode.OK, jsonHeaders)
        }
        val client = HttpClient(engine) { installRiffetClient() }
        val api = RiffetApi(client, "http://127.0.0.1:9")

        val created = api.createProject(cwd = "/home/ana/workspace")

        val request = seen.single()
        assertEquals(HttpMethod.Post, request.method)
        assertEquals("/api/projects", request.url.encodedPath)
        assertEquals("""{"cwd":"/home/ana/workspace"}""", bodyOf(request))
        assertEquals("one", created.name)
        assertEquals("/tmp/one", created.cwd)
        client.close()
    }

    @Test
    fun createProjectCarriesAnExplicitNameAndUpdateProjectRestoresIt() = runTest {
        val seen = mutableListOf<HttpRequestData>()
        val engine = MockEngine { request ->
            seen += request
            respond(
                if (request.method == HttpMethod.Patch) project(archivedAt = null) else project(archivedAt = "2026-02-02T00:00:00.000Z"),
                HttpStatusCode.OK,
                jsonHeaders,
            )
        }
        val client = HttpClient(engine) { installRiffetClient() }
        val api = RiffetApi(client, "http://127.0.0.1:9")

        val archived = api.createProject(cwd = "/tmp/one", name = "One")
        assertEquals("2026-02-02T00:00:00.000Z", archived.archivedAt)
        assertEquals("""{"cwd":"/tmp/one","name":"One"}""", bodyOf(seen[0]))

        val restored = api.updateProject(archived.id, archived = false)
        val patch = seen[1]
        assertEquals(HttpMethod.Patch, patch.method)
        assertEquals("/api/projects/p1", patch.url.encodedPath)
        assertEquals("""{"archived":false}""", bodyOf(patch))
        assertEquals(null, restored.archivedAt)
        client.close()
    }

    @Test
    fun browseOmitsAnAbsentPathAndDecodesHiddenDirectories() = runTest {
        val seen = mutableListOf<HttpRequestData>()
        val engine = MockEngine { request ->
            seen += request
            respond(
                """{"path":"/home/ana","home":"/home/ana","entries":[{"name":".config","kind":"directory","hidden":true},{"name":"workspace","kind":"directory","hidden":false}]}""",
                HttpStatusCode.OK,
                jsonHeaders,
            )
        }
        val client = HttpClient(engine) { installRiffetClient() }
        val api = RiffetApi(client, "http://127.0.0.1:9")

        val home = api.browse()
        assertEquals("""{}""", bodyOf(seen[0]))
        assertEquals("/home/ana", home.path)
        // The root has no parent; the field must be absent rather than empty.
        assertEquals(null, home.parent)
        assertTrue(home.entries.first().hidden)
        assertEquals("workspace", home.entries.last().name)

        api.browse("/home/ana/workspace")
        assertEquals("""{"path":"/home/ana/workspace"}""", bodyOf(seen[1]))
        client.close()
    }
}
