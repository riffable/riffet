package riffet.shared

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull

/** The task endpoints against what `apps/server/src/tasks` sends (docs/TASKS.md): a typo in a key fails on a Mac, not at compile time. */
class RiffetApiTasksTest {
    private val json = headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString())

    private val finished = """{"id":"t1","requestId":"r1","projectId":"p1","pluginId":"riffet.android","providerId":"riffet.android/gradle","providerVersion":"0.1.0","actionId":"assembleDebug",
        "title":{"zh-Hans":"构建 Debug APK","en":"Build Debug APK"},"params":{},"state":"succeeded","exitCode":0,"startedAt":"2026-11-05T18:42:01.157Z","endedAt":"2026-11-05T18:45:24.516Z","logSize":15703,
        "diagnostics":[{"severity":"warning","message":"Cast is redundant.","file":"app/src/main/java/A.kt","line":250,"column":15},{"severity":"error","message":"Execution failed"}],
        "artifacts":[{"id":"7d5a935cb9d16841","name":"app-debug.apk","path":"app/build/outputs/apk/debug/app-debug.apk","size":62958568,"sha256":"f603"}],"futureField":true}"""

    private fun bodyOf(request: HttpRequestData): String = (request.body as TextContent).text

    @Test
    fun decodesATaskWithDiagnosticsAndArtifactsAndSendsTheRequestBody() = runTest {
        val seen = mutableListOf<HttpRequestData>()
        val client = HttpClient(MockEngine { request ->
            seen += request
            when (request.url.encodedPath) {
                "/api/projects/p1/task-actions" -> respond("""{"actions":[{"providerId":"riffet.android/gradle","pluginId":"riffet.android","id":"assembleDebug","title":{"en":"Build"}}],"projectTypes":["android"]}""", HttpStatusCode.OK, json)
                "/api/tasks/t1/log" -> respond("""{"from":0,"to":9,"text":"构建","eof":true}""", HttpStatusCode.OK, json)
                else -> respond(finished, HttpStatusCode.OK, json)
            }
        }) { installRiffetClient() }
        val api = RiffetApi(client, "http://127.0.0.1:9")

        val actions = api.taskActions("p1")
        assertEquals(listOf("android"), actions.projectTypes)
        assertEquals("assembleDebug", actions.actions.single().id)

        val started = api.startTask(TaskCreate("r1", "p1", "riffet.android/gradle", "assembleDebug"))
        assertEquals("""{"requestId":"r1","projectId":"p1","providerId":"riffet.android/gradle","actionId":"assembleDebug","params":{}}""", bodyOf(seen.last()))
        val task = started.task!!
        assertEquals(HttpMethod.Post, seen.last().method)
        assertEquals("succeeded", task.state)
        assertEquals(0, task.exitCode)
        assertEquals(15703L, task.logSize)
        assertEquals(listOf("warning", "error"), task.diagnostics!!.map { it.severity })
        assertEquals(250, task.diagnostics[0].line)
        assertNull(task.diagnostics[1].file)
        assertEquals(62958568L, task.artifacts!!.single().size)

        assertEquals("构建", api.taskLog("t1", 0).text)
        assertEquals("from=0&limit=65536", seen.last().url.encodedQuery)
        assertEquals("http://127.0.0.1:9/api/tasks/t1/artifacts/a%2Fb", api.taskArtifactUrl("t1", "a/b"))
        client.close()
    }

    @Test
    fun aBusyProjectReturnsTheHolderAndAnyOtherRefusalIsThrown() = runTest {
        val busy = HttpClient(MockEngine {
            respond("""{"error":{"code":"TASK_BUSY","message":"Another task of this project holds the same lock","details":{"taskId":"t9","lock":"gradle"}}}""", HttpStatusCode.Conflict, json)
        }) { installRiffetClient() }
        val started = RiffetApi(busy, "http://127.0.0.1:9").startTask(TaskCreate("r2", "p1", "riffet.android/gradle", "assembleDebug"))
        assertNull(started.task)
        assertEquals("t9", started.holderId)
        busy.close()

        val conflict = HttpClient(MockEngine {
            respond("""{"error":{"code":"TASK_REQUEST_CONFLICT","message":"This request id was already used for a different task","details":{"taskId":"t1"}}}""", HttpStatusCode.Conflict, json)
        }) { installRiffetClient() }
        val error = assertFailsWith<RiffetHttpException> { RiffetApi(conflict, "http://127.0.0.1:9").startTask(TaskCreate("r1", "p1", "x", "y")) }
        assertEquals("TASK_REQUEST_CONFLICT", error.code)
        conflict.close()
    }
}
