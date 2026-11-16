package riffet.ui.state

import riffet.ui.settings.settle
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockEngineConfig
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import riffet.contracts.AppSettings
import riffet.contracts.NativeBackendId
import riffet.shared.RiffetApi
import kotlin.coroutines.EmptyCoroutineContext
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class SessionStoreSettingsTest {
    @Test
    fun projectPushRevisionSkipsSessionActivityAndRetriesFailedReads() = runTest {
        var projectReads = 0
        var failProjects = false
        var sessionRevision = 1
        var projectUpdatedAt = "2026-10-21T00:00:00.000Z"
        val client = HttpClient(MockEngine(MockEngineConfig().apply {
            dispatcher = UnconfinedTestDispatcher(testScheduler)
            addHandler { request ->
                when (request.url.encodedPath) {
                    "/api/projects" -> {
                        projectReads++
                        if (failProjects) respond("unavailable", HttpStatusCode.ServiceUnavailable)
                        else respond(
                            """[{"id":"p1","name":"riffet","cwd":"/repo","createdAt":"2026-10-21T00:00:00.000Z","updatedAt":"$projectUpdatedAt"}]""",
                            headers = headersOf(HttpHeaders.ContentType, "application/json"),
                        )
                    }
                    "/api/sessions" -> respond(
                        "[]",
                        headers = headersOf(
                            HttpHeaders.ContentType to listOf("application/json"),
                            HttpHeaders.ETag to listOf("W/\"$sessionRevision\""),
                        ),
                    )
                    else -> error("Unexpected request: ${request.url.encodedPath}")
                }
            }
        }))
        val store = SessionStore(
            RiffetApi(client, "http://127.0.0.1:9"),
            CoroutineScope(UnconfinedTestDispatcher(testScheduler)),
            background = EmptyCoroutineContext,
        )

        store.listsChanged("""{"revision":1,"projects":1}""")
        settle()
        assertEquals(1, projectReads)
        val held = store.list.value.projects
        assertEquals("p1", held.single().id)

        sessionRevision = 2
        store.listsChanged("""{"revision":2,"projects":1}""")
        settle()
        assertEquals(1, projectReads, "session activity keeps the existing project snapshot")

        failProjects = true
        store.listsChanged("""{"revision":2,"projects":2}""")
        settle()
        assertEquals(2, projectReads)
        assertEquals(held, store.list.value.projects, "a failed project read keeps the visible projects")

        failProjects = false
        projectUpdatedAt = "2026-10-21T00:01:00.000Z"
        store.listsChanged("""{"revision":2,"projects":2}""")
        settle()
        assertEquals(3, projectReads, "the failed project revision is retried on the next push")
        assertEquals(projectUpdatedAt, store.list.value.projects.single().updatedAt)
        client.close()
    }

    @Test
    fun coldStartPollRecoverySharesBootstrapWithWakeAndPreservesAcceptedSettings() = runTest {
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        var serverSettings = """{"defaultBackendId":"cursor","editorCommand":"cursor"}"""
        var requests = 0
        val client = HttpClient(MockEngine(MockEngineConfig().apply {
            dispatcher = UnconfinedTestDispatcher(testScheduler)
            addHandler { request ->
                requests++
                if (requests == 1) return@addHandler respond("unavailable", HttpStatusCode.ServiceUnavailable)
                val reply = serverSettings
                started.complete(Unit)
                release.await()
                respond("""{"projects":[],"sessions":[],"terminals":[],"settings":$reply}""", headers = headersOf(HttpHeaders.ContentType, "application/json"))
            }
        }))
        val store = SessionStore(
            RiffetApi(client, "http://127.0.0.1:9"),
            CoroutineScope(UnconfinedTestDispatcher(testScheduler)),
            background = EmptyCoroutineContext,
        )
        store.refresh()
        settle()
        assertTrue(store.list.value.loaded)
        assertNull(store.list.value.settings)
        assertNotNull(store.list.value.error)

        val recovery = async(UnconfinedTestDispatcher(testScheduler)) { store.pollSessions() }
        started.await()
        store.wake()
        store.refresh()
        val anotherPoll = async(UnconfinedTestDispatcher(testScheduler)) { store.pollSessions() }
        assertEquals(2, requests, "foreground wake, refresh and concurrent polling share one recovery request")
        val saved = AppSettings(defaultBackendId = NativeBackendId.CODEX, editorCommand = "code")
        store.applySavedSettings(saved)
        store.invalidateBackendCatalog()
        assertEquals(saved, store.list.value.settings)
        release.complete(Unit)
        recovery.await()
        anotherPoll.await()
        settle()
        assertEquals(saved, store.list.value.settings)
        assertEquals(1L, store.list.value.backendRevision)
        assertTrue(store.list.value.loaded)
        assertNull(store.list.value.error)

        serverSettings = """{"defaultBackendId":"codex","editorCommand":"latest"}"""
        store.refresh()
        settle()
        assertEquals("latest", store.list.value.settings?.editorCommand, "a subsequent refresh can read changes from another client")
        assertEquals(1L, store.list.value.backendRevision)
        client.close()
    }

    @Test
    fun bootstrapRevisionsStartSessionDeltasThatMergeInServerOrder() = runTest {
        fun session(id: String, activity: String, updatedAt: String = activity, title: String = id) =
            """{"id":"$id","projectId":"p1","kind":"native","title":"$title","tags":[],"state":"idle","mode":"default","lastActivityAt":"$activity","createdAt":"2026-10-21T00:00:00.000Z","updatedAt":"$updatedAt"}"""
        val json = headersOf(HttpHeaders.ContentType, "application/json")
        val since = mutableListOf<String?>()
        var delta = ""
        val client = HttpClient(MockEngine(MockEngineConfig().apply {
            dispatcher = UnconfinedTestDispatcher(testScheduler)
            addHandler { request ->
                when (request.url.encodedPath) {
                    "/api/bootstrap" -> respond(
                        """{"projects":[],"sessions":[${session("a", "2026-10-21T00:03:00.000Z")},${session("b", "2026-10-21T00:02:00.000Z")},${session("c", "2026-10-21T00:01:00.000Z")}],""" +
                            """"terminals":[],"settings":{},"protocol":{"version":1,"features":["list-delta"]},"revisions":{"sessions":10,"terminals":3,"projects":7}}""",
                        headers = json,
                    )
                    "/api/sessions" -> {
                        since += request.url.parameters["since"]
                        if (delta.isEmpty()) respond("", HttpStatusCode.NotModified)
                        else respond(delta, headers = headersOf(HttpHeaders.ContentType to listOf("application/json"), HttpHeaders.ETag to listOf("W/\"11\"")))
                    }
                    else -> error("Unexpected request: ${request.url.encodedPath}")
                }
            }
        }))
        val store = SessionStore(
            RiffetApi(client, "http://127.0.0.1:9"),
            CoroutineScope(UnconfinedTestDispatcher(testScheduler)),
            background = EmptyCoroutineContext,
        )
        store.refresh()
        settle()
        assertEquals(null, store.list.value.error)
        assertEquals(listOf("a", "b", "c"), store.list.value.sessions.map { it.id })

        // The bootstrap's revisions are held already: a push naming them reads nothing.
        store.listsChanged("""{"revision":10,"projects":7}""")
        settle()
        assertEquals(emptyList(), since)

        delta = """{"revision":11,"sessions":[${session("c", "2026-10-21T00:05:00.000Z", title = "c2")},${session("d", "2026-10-21T00:04:00.000Z")}],"removed":["b"]}"""
        store.pollSessions()
        assertEquals(listOf("c", "d", "a"), store.list.value.sessions.map { it.id })
        assertEquals("c2", store.list.value.sessions.first().title)
        assertEquals(listOf<String?>("10"), since)

        // The same revision again: the server answers 304 and the list is not rewritten.
        val held = store.list.value
        delta = ""
        store.pollSessions()
        assertEquals(held, store.list.value)
        assertEquals(listOf<String?>("10", "11"), since)
        client.close()
    }
}
