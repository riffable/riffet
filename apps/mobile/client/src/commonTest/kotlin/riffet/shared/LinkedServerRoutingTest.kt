package riffet.shared

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockEngineConfig
import io.ktor.client.engine.mock.respond
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlin.coroutines.EmptyCoroutineContext
import riffet.contracts.LinkedServerStatus
import riffet.contracts.NativeBackendId
import riffet.contracts.ServerInfo
import riffet.contracts.Session
import riffet.contracts.SessionKind
import riffet.contracts.SessionOrigin
import riffet.contracts.SessionState
import riffet.ui.composer.InMemoryOutboxStore
import riffet.ui.home.ServerScopeKind
import riffet.ui.home.buildHomeServerOptions
import riffet.ui.home.inServerScope
import riffet.ui.state.SessionStore
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class LinkedServerRoutingTest {

    @Test
    fun routesPathAndQueryByLocatedObjectAndExplicitServer() {
        val locator = ObjectServerLocator()
        locator.locate(listOf("proj-remote", "sess-remote"), "peer-1")

        assertEquals(
            "/api/servers/peer-1/projects/proj-remote/files",
            resolveServerPath("/api/projects/proj-remote/files", locator = locator),
        )
        assertEquals(
            "/api/servers/peer-1/v3/sessions/sess-remote/sync",
            resolveServerPath("/api/v3/sessions/sess-remote/sync", locator = locator),
        )
        assertEquals(
            "/api/servers/peer-1/backends/claude/catalog",
            resolveServerPath("/api/backends/claude/catalog", query = listOf("projectId" to "proj-remote"), locator = locator),
        )
        assertEquals(
            "/api/servers/peer-2/browse",
            resolveServerPath("/api/browse", targetServerId = "peer-2", locator = locator),
        )
        assertEquals(
            "/api/projects/local-proj/files",
            resolveServerPath("/api/projects/local-proj/files", locator = locator),
        )
        // Already-addressed paths pass through unchanged.
        assertEquals(
            "/api/servers/peer-1/projects",
            resolveServerPath("/api/servers/peer-1/projects", targetServerId = "peer-2", locator = locator),
        )

        locator.forgetServer("peer-1")
        assertNull(locator.serverOf("proj-remote"))
    }

    @Test
    fun mergesLinkedPeerListsAndRoutesDirectoryAndSessionCreation() = runTest {
        val dispatcher = UnconfinedTestDispatcher(testScheduler)
        val storeScope = CoroutineScope(dispatcher)
        val paths = mutableListOf<String>()
        val jsonHeaders = headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString())

        val engine = MockEngine(MockEngineConfig().apply {
            this.dispatcher = dispatcher
            addHandler { request ->
            val path = request.url.encodedPath
            paths += "${request.method.value} $path"
            when ("${request.method.value} $path") {
                "GET /api/bootstrap" -> respond(
                    """
                    {
                      "serverId": "self-1",
                      "servers": [
                        {"id":"self-1","name":"My Mac","self":true,"online":true,"compatible":true,"inbound":true,"outbound":true},
                        {"id":"peer-1","name":"Devbox","alias":"dev","online":true,"compatible":true,"inbound":false,"outbound":true}
                      ],
                      "projects": [
                        {"id":"p-local","name":"local-app","cwd":"/Users/me/local","createdAt":"2026-11-20T00:00:00Z","updatedAt":"2026-11-20T00:00:00Z"}
                      ],
                      "sessions": [],
                      "terminals": [],
                      "settings": {}
                    }
                    """.trimIndent(),
                    HttpStatusCode.OK,
                    jsonHeaders,
                )
                "GET /api/servers/peer-1/bootstrap" -> respond(
                    """
                    {
                      "projects": [
                        {"id":"p-remote","name":"remote-app","cwd":"/srv/remote","createdAt":"2026-11-20T00:00:00Z","updatedAt":"2026-11-20T00:00:00Z"},
                        {"id":"p-remote-sys","name":"Assistant","cwd":"/srv/sys","system":"assistant","createdAt":"2026-11-20T00:00:00Z","updatedAt":"2026-11-20T00:00:00Z"}
                      ],
                      "sessions": [
                        {"id":"s-remote","projectId":"p-remote","kind":"native","backendId":"claude","title":"Remote task","tags":[],"mode":"agent","state":"idle","createdAt":"2026-11-20T01:00:00Z","updatedAt":"2026-11-20T01:00:00Z"},
                        {"id":"s-remote-sys","projectId":"p-remote-sys","kind":"native","backendId":"claude","title":"Peer assistant","tags":[],"mode":"agent","state":"idle","createdAt":"2026-11-20T01:00:00Z","updatedAt":"2026-11-20T01:00:00Z"}
                      ],
                      "terminals": [],
                      "settings": {}
                    }
                    """.trimIndent(),
                    HttpStatusCode.OK,
                    jsonHeaders,
                )
                "POST /api/servers/peer-1/projects" -> respond(
                    """{"id":"p-remote-new","name":"new-repo","cwd":"/srv/new-repo","createdAt":"2026-11-20T02:00:00Z","updatedAt":"2026-11-20T02:00:00Z"}""",
                    HttpStatusCode.OK,
                    jsonHeaders,
                )
                "POST /api/servers/peer-1/sessions" -> respond(
                    """
                    {
                      "session": {
                        "id":"s-created",
                        "projectId":"p-remote-new",
                        "kind":"native",
                        "backendId":"claude",
                        "title":"Hello remote",
                        "tags":[],
                        "mode":"agent",
                        "state":"running",
                        "origin":{"kind":"link","serverId":"self-1"},
                        "createdAt":"2026-11-20T03:00:00Z",
                        "updatedAt":"2026-11-20T03:00:00Z"
                      },
                      "run": {
                        "id":"r-1",
                        "sessionId":"s-created",
                        "commandId":"cmd-1",
                        "prompt":"Hello remote",
                        "state":"running",
                        "createdAt":"2026-11-20T03:00:00Z",
                        "updatedAt":"2026-11-20T03:00:00Z"
                      }
                    }
                    """.trimIndent(),
                    HttpStatusCode.OK,
                    jsonHeaders,
                )
                else -> respond("""{"error":{"code":"NOT_FOUND","message":"unexpected $path"}}""", HttpStatusCode.NotFound, jsonHeaders)
            }
            }
        })

        val http = HttpClient(engine) { installRiffetClient() }
        val api = RiffetApi(http = http, baseUrl = "http://mac.local:4337", parseContext = EmptyCoroutineContext)
        val store = SessionStore(api = api, scope = storeScope, outboxStore = InMemoryOutboxStore(), background = EmptyCoroutineContext)

        store.refresh()
        testScheduler.advanceUntilIdle()

        val state = store.list.value
        // Entry + peer non-system projects; peer's system project & its session are excluded.
        assertEquals(listOf("p-local", "p-remote"), state.projects.map { it.id })
        assertEquals(listOf("s-remote"), state.sessions.map { it.id })
        assertEquals("peer-1", store.serverOf("p-remote"))
        assertEquals("peer-1", store.serverOf("s-remote"))
        assertEquals(LinkedServerStatus.FRESH, state.linkedStatus["peer-1"])

        // Opening a directory on peer-1 hits `/api/servers/peer-1/projects` and locates it.
        val createdProject = store.openDirectory("/srv/new-repo", serverId = "peer-1")
        assertEquals("p-remote-new", createdProject.id)
        assertEquals("peer-1", store.serverOf("p-remote-new"))
        assertTrue(store.list.value.projects.any { it.id == "p-remote-new" })

        // Creating a session in that remote project automatically routes to `/api/servers/peer-1/sessions`.
        val createdSession = store.createSession(
            projectId = createdProject.id,
            prompt = "Hello remote",
            attachments = emptyList(),
            backendId = NativeBackendId.CLAUDE,
            backendProfileId = null,
            model = null,
            mode = null,
            approval = null,
        )
        assertEquals("s-created", createdSession.id)
        assertEquals("peer-1", store.serverOf("s-created"))
        assertTrue("POST /api/servers/peer-1/projects" in paths)
        assertTrue("POST /api/servers/peer-1/sessions" in paths)

        // Relevant scope includes local sessions and peer sessions started from self-1, excluding peer-native ones.
        val objectServers = store.list.value.objectServers
        assertTrue(inServerScope(createdSession, ServerScopeKind.RELEVANT, null, "self-1", objectServers))
        assertFalse(inServerScope(state.sessions.first(), ServerScopeKind.RELEVANT, null, "self-1", objectServers))
        assertTrue(inServerScope(state.sessions.first(), ServerScopeKind.ALL, null, "self-1", objectServers))

        store.clear()
        http.close()
    }

    @Test
    fun ordersHomeServerOptionsSelfThenUsableThenUnavailable() {
        val options = buildHomeServerOptions(
            servers = listOf(
                ServerInfo(id = "offline", name = "Offline Box", online = false, compatible = true, inbound = false, outbound = true),
                ServerInfo(id = "self", name = "My Mac", self = true, online = true, compatible = true, inbound = true, outbound = true),
                ServerInfo(id = "no-out", name = "Readonly", online = true, compatible = true, inbound = false, outbound = false),
                ServerInfo(id = "dev", name = "Devbox", online = true, compatible = true, inbound = false, outbound = true),
            ),
            linkedStatus = mapOf("dev" to LinkedServerStatus.FRESH),
        )
        assertEquals(listOf("", "dev", "offline", "no-out"), options.map { it.id })
        assertTrue(options[0].usable && options[0].self)
        assertTrue(options[1].usable && !options[1].self)
        assertFalse(options[2].usable)
        assertFalse(options[3].usable)
    }
}
