package riffet.shared

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import riffet.i18n.L10n
import riffet.contracts.TerminalAppearance
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull

class RiffetApiAuthTest {

    private val jsonHeaders = headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString())

    @Test
    fun resourceRequestsShareNegotiatedFeaturesAndLiveTokenOnlyOnTheApiOrigin() = runTest {
        val seen = mutableListOf<HttpRequestData>()
        val client = HttpClient(MockEngine { request ->
            seen += request
            respond("[]", HttpStatusCode.OK, jsonHeaders)
        }) { installRiffetClient() }
        var token: String? = "first-token"
        var tokenReads = 0
        val api = RiffetApi(client, "https://riffet.example:8443", tokenProvider = { tokenReads++; token },
            config = RiffetClientConfig(features = listOf("quick-chat", "pi-agent", "projectless-tasks")))
        api.sessions()
        val resource = "https://riffet.example:8443/api/sessions/task/blobs/image"
        val headers = api.resourceHeaders(resource)
        assertEquals(seen.single().headers[FeaturesHeader], headers[FeaturesHeader])
        assertEquals("Bearer first-token", headers[HttpHeaders.Authorization])
        token = "replacement-token"
        assertEquals("Bearer replacement-token", api.resourceHeaders(resource)[HttpHeaders.Authorization])
        val readsBeforeExternal = tokenReads
        assertEquals(emptyMap(), api.resourceHeaders("https://images.example/image.png"))
        assertEquals(emptyMap(), api.resourceHeaders("https://riffet.example/api/image"))
        assertEquals(readsBeforeExternal, tokenReads)
        token = null
        assertNull(api.resourceHeaders(resource)[HttpHeaders.Authorization])
        client.close()
    }

    @Test
    fun terminalLaunchColoursAreReadForEachCreationAndReopenRequest() = runTest {
        val seen = mutableListOf<HttpRequestData>()
        val client = HttpClient(MockEngine { request ->
            seen += request
            respond("{}", HttpStatusCode.OK, jsonHeaders)
        }) { installRiffetClient() }
        val api = RiffetApi(client, "http://127.0.0.1:9")
        api.post("/api/sessions")
        api.terminalAppearance = TerminalAppearance("#252525", "#fafafa")
        api.post("/api/sessions")
        api.terminalAppearance = TerminalAppearance("#d2d4d7", "#141416")
        api.post("/api/sessions/s1/reopen")
        api.terminalAppearance = TerminalAppearance("invalid", "#141416")
        api.post("/api/sessions")
        val name = "X-Riffet-Terminal-Appearance"
        assertNull(seen[0].headers[name])
        assertEquals("#252525;#fafafa", seen[1].headers[name])
        assertEquals("#d2d4d7;#141416", seen[2].headers[name])
        assertNull(seen[3].headers[name])
        client.close()
    }

    @Test
    fun bearerTokenAndIdentityEncodingAreAttached() = runTest {
        val seen = mutableListOf<HttpRequestData>()
        val engine = MockEngine { request ->
            seen += request
            respond("[]", HttpStatusCode.OK, jsonHeaders)
        }
        val client = HttpClient(engine) { installRiffetClient() }
        val api = RiffetApi(client, "http://127.0.0.1:9", tokenProvider = { "wkn_0123456789abcdef_secret" })

        assertEquals(0, api.sessions().size)

        val request = seen.single()
        assertEquals("Bearer wkn_0123456789abcdef_secret", request.headers[HttpHeaders.Authorization])
        // The identity encoding escape hatch is on by default; see RiffetClientConfig.
        assertEquals("identity", request.headers[HttpHeaders.AcceptEncoding])
        client.close()
    }

    @Test
    fun conditionalListReadsSendTheValidatorAndTreat304AsUnchanged() = runTest {
        val seen = mutableListOf<HttpRequestData>()
        val engine = MockEngine { request ->
            seen += request
            if (request.headers[HttpHeaders.IfNoneMatch] == "W/\"7\"") respond("", HttpStatusCode.NotModified, headersOf(HttpHeaders.ETag, "W/\"7\""))
            else respond("[]", HttpStatusCode.OK, headersOf(HttpHeaders.ContentType to listOf(ContentType.Application.Json.toString()), HttpHeaders.ETag to listOf("W/\"7\"")))
        }
        val client = HttpClient(engine) { installRiffetClient() }
        val api = RiffetApi(client, "http://127.0.0.1:9")

        val first = api.sessionsIfChanged(null)
        assertEquals(0, first.items?.size)
        assertEquals("W/\"7\"", first.etag)
        assertNull(seen[0].headers[HttpHeaders.IfNoneMatch])

        val again = api.terminalsIfChanged(first.etag)
        assertNull(again.items, "304 keeps the list held")
        assertEquals("W/\"7\"", again.etag)
        client.close()
    }

    @Test
    fun identityEncodingFlagCanBeTurnedOff() = runTest {
        val seen = mutableListOf<HttpRequestData>()
        val engine = MockEngine { request ->
            seen += request
            respond("[]", HttpStatusCode.OK, jsonHeaders)
        }
        val client = HttpClient(engine) { installRiffetClient(RiffetClientConfig(identityEncoding = false)) }
        val api = RiffetApi(client, "http://127.0.0.1:9")

        api.sessions()

        assertNull(seen.single().headers[HttpHeaders.AcceptEncoding])
        client.close()
    }

    @Test
    fun unauthorizedBecomesTypedError() = runTest {
        val engine = MockEngine {
            respond(
                """{"error":{"code":"UNAUTHENTICATED","message":"Sign in with the local access token"}}""",
                HttpStatusCode.Unauthorized,
                jsonHeaders,
            )
        }
        val client = HttpClient(engine) { installRiffetClient() }
        val api = RiffetApi(client, "http://127.0.0.1:9", tokenProvider = { "wkn_0123456789abcdef_revoked" })

        val error = assertFailsWith<RiffetUnauthenticatedException> { api.bootstrap() }

        assertEquals("UNAUTHENTICATED", error.code)
        client.close()
    }

    @Test
    fun otherFailuresCarryTheirServerCode() = runTest {
        val engine = MockEngine {
            respond(
                """{"error":{"code":"ARCHIVED_SESSION","message":"Restore this conversation before running it"}}""",
                HttpStatusCode.Conflict,
                jsonHeaders,
            )
        }
        val client = HttpClient(engine) { installRiffetClient() }
        val api = RiffetApi(client, "http://127.0.0.1:9")

        val error = assertFailsWith<RiffetHttpException> { api.sessions() }

        assertEquals(409, error.status)
        assertEquals("ARCHIVED_SESSION", error.code)
        client.close()
    }

    @Test
    fun serverErrorsReadInTheInterfaceLanguage() = runTest {
        val engine = MockEngine {
            respond(
                """{"error":{"code":"EXTENSION_NOT_FOUND","message":"The skill is not in the current configuration","params":{"subject":"skill"}}}""",
                HttpStatusCode.NotFound,
                jsonHeaders,
            )
        }
        val client = HttpClient(engine) { installRiffetClient() }
        val api = RiffetApi(client, "http://127.0.0.1:9")
        val locale = L10n.locale
        try {
            val error = assertFailsWith<RiffetHttpException> { api.sessions() }
            L10n.locale = "zh-Hans"
            assertEquals("Skill 不在当前配置中", error.message)
            L10n.locale = "en"
            assertEquals("The skill is not in the current configuration", error.message)
            // A code without a text, and a message still worded in Chinese, read as the server sent them.
            assertEquals("No such route", L10n.serverError("NOT_FOUND", emptyMap(), "No such route"))
            assertEquals("会话正在归档", L10n.serverError("ARCHIVED_SESSION", emptyMap(), "会话正在归档"))
        } finally {
            L10n.locale = locale
            client.close()
        }
    }
}
