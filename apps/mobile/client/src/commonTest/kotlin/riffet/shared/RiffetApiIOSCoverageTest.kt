package riffet.shared

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.headersOf
import io.ktor.http.content.TextContent
import kotlinx.coroutines.test.runTest
import riffet.contracts.NativeBackendId
import riffet.contracts.NativeInteractionKind
import riffet.contracts.NativeBackendProfileSettingsUpdate
import riffet.contracts.PatchValue
import riffet.contracts.RiffetJson
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull

class RiffetApiIOSCoverageTest {
    private val headers = headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString())

    @Test fun extendsTheExactInteractionAndDecodesTheAuthoritativeExpiry() = runTest {
        var seen: HttpRequestData? = null
        val http = HttpClient(MockEngine { request ->
            seen = request
            respond("""{"id":"approval-1","revision":"revision-2","transport":"protocol","kind":"permission","title":"Run tests","expiresAt":"2026-10-15T09:00:00Z"}""", headers = headers)
        }) { installRiffetClient() }
        try {
            val result = RiffetApi(http, "http://mac:8080").nativeExtendInteraction("session/one", "approval-1")
            val request = requireNotNull(seen)
            assertEquals(HttpMethod.Post, request.method)
            assertEquals("/api/sessions/session%2Fone/native/interaction/extend", request.url.encodedPath)
            val body = RiffetJson.instance.parseToJsonElement((request.body as TextContent).text).jsonObject
            assertEquals("approval-1", body["interactionId"]?.jsonPrimitive?.content)
            assertEquals("revision-2", result.revision)
            assertEquals("2026-10-15T09:00:00Z", result.expiresAt)
            assertEquals(NativeInteractionKind.PERMISSION, result.kind)
        } finally { http.close() }
    }

    @Test fun readsSessionSpecificCapabilities() = runTest {
        var seen: HttpRequestData? = null
        val http = HttpClient(MockEngine { request ->
            seen = request
            respond("""{"backendId":"codex","label":"Codex","available":true,"capabilities":{"backendId":"codex","label":"Codex","interactionTransport":"protocol","supportsResume":true,"supportsInterrupt":true,"supportsHistory":true,"supportsModelSelection":false,"supportsModeSelection":false,"supportsPermissionSelection":false,"supportsTerminal":false}}""", headers = headers)
        }) { installRiffetClient() }
        try {
            val result = RiffetApi(http, "http://mac:8080").sessionCatalog("session one")
            assertEquals(HttpMethod.Get, seen?.method)
            assertEquals("/api/sessions/session%20one/native/catalog", seen?.url?.encodedPath)
            assertEquals(NativeBackendId.CODEX, result.backendId)
            assertFalse(result.capabilities.supportsModelSelection)
            assertEquals(false, result.capabilities.supportsTerminal)
        } finally { http.close() }
    }

    @Test fun modelSourcesPreservePatchStatesAndAnExplicitlyClearedProbeCredential() = runTest {
        val requests = mutableListOf<HttpRequestData>()
        val http = HttpClient(MockEngine { request ->
            requests += request
            respond(if (request.url.encodedPath.endsWith("model-probe")) """{"models":[]}"""
                else """{"profiles":[{"id":"main","backendId":"codex","name":"Models","modelSource":"gateway"}]}""", headers = headers)
        }) { installRiffetClient() }
        try {
            val api = RiffetApi(http, "http://mac:8080")
            val saved = api.updateBackendProfile(NativeBackendId.CODEX, "main", NativeBackendProfileSettingsUpdate(modelSource = PatchValue.key("gateway")))
            assertEquals("gateway", saved.modelSource)
            api.updateBackendProfile(NativeBackendId.CODEX, "main", NativeBackendProfileSettingsUpdate(name = "Models"))
            api.updateBackendProfile(NativeBackendId.CODEX, "main", NativeBackendProfileSettingsUpdate(modelSource = PatchValue.key(null), apiKey = PatchValue.key(null)))
            api.probeBackendModels(NativeBackendId.CODEX, ProbeBackendModelsBody(modelSource = "gateway", profileId = "main", apiKey = ""))
            val bodies = requests.map { RiffetJson.instance.parseToJsonElement((it.body as TextContent).text).jsonObject }
            assertEquals("gateway", bodies[0]["modelSource"]?.jsonPrimitive?.content)
            assertFalse(bodies[1].containsKey("modelSource"))
            assertEquals(JsonNull, bodies[2]["modelSource"])
            assertEquals(JsonNull, bodies[2]["apiKey"])
            assertEquals("", bodies[3]["apiKey"]?.jsonPrimitive?.content)
            assertEquals("gateway", bodies[3]["modelSource"]?.jsonPrimitive?.content)
            assertFalse(bodies[3].containsKey("apiEndpoint"))
        } finally { http.close() }
    }

    @Test fun pluginsDecodeDescriptorDefaultsAndUnknownActionSteps() = runTest {
        val requests = mutableListOf<HttpRequestData>()
        val steps = ArrayDeque(listOf(
            """{"kind":"show-code","flowId":"flow 1","verificationUri":"https://sso.example/device","intervalMs":5000,"expiresAt":1767225600000}""",
            """{"kind":"slow_down"}""",
            """{"kind":"failed","message":"denied"}""",
            """{"kind":"open-url","url":"https://sso.example"}""",
        ))
        val http = HttpClient(MockEngine { request ->
            requests += request
            respond(
                if (request.method == HttpMethod.Get) """{"integrations":[{"id":"acme.gateway","vendor":"acme","name":"Gateway","enabled":true,"enablement":"later","status":{"state":"new-state"},"settings":[],"actions":[{"id":"login","label":"Sign in","kind":"device-flow"}],"contributes":{"modelSources":[{"id":"gateway","label":"Gateway","backends":["claude","future"],"loginAction":"login"}]}}]}"""
                else steps.removeFirst(),
                headers = headers,
            )
        }) { installRiffetClient() }
        try {
            val api = RiffetApi(http, "http://mac:8080")
            val plugin = api.plugins().single()
            assertEquals("later", plugin.enablement)
            val source = plugin.contributes.modelSources.single()
            assertEquals(listOf("claude", "future"), source.backends)
            assertEquals(listOf("apiEndpoint", "apiKey"), source.overridable)
            assertEquals("login", source.loginAction)
            assertNull(source.defaultEndpoint)
            assertNull(source.hint)

            val code = assertIs<ActionStep.ShowCode>(api.runPluginAction("acme.gateway", "login"))
            assertEquals("/api/integrations/acme.gateway/actions/login", requests[1].url.encodedPath)
            assertNull(code.userCode)
            assertEquals(5000L, code.intervalMs)
            assertEquals(1767225600000L, code.expiresAt)
            assertEquals(ActionStep.SlowDown, api.pollPluginFlow("acme.gateway", code.flowId))
            assertEquals("/api/integrations/acme.gateway/flows/flow%201/poll", requests[2].url.encodedPath)
            assertEquals(ActionStep.Failed("denied"), api.pollPluginFlow("acme.gateway", code.flowId))
            assertEquals("open-url", assertIs<ActionStep.Unknown>(api.pollPluginFlow("acme.gateway", code.flowId)).kind)
        } finally { http.close() }
    }
}
