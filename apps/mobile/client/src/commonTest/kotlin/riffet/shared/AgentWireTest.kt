package riffet.shared

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import riffet.contracts.AppSettings
import riffet.contracts.CapturedSessionReference
import riffet.contracts.NativeBackendCatalogEntry
import riffet.contracts.NativeBackendId
import riffet.contracts.Session
import riffet.contracts.RiffetJson
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertFailsWith

/** A plugin Agent id reaches the macOS client in a sidecar; every other client never meets one. */
class AgentWireTest {
    private val session = """{"id":"s1","projectId":"p","kind":"native","title":"t","tags":[],"state":"idle","mode":"agent","backendId":"acme.gemini","createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}"""
    private val capabilities = """{"backendId":"acme.gemini","label":"Gemini","interactionTransport":"protocol","supportsResume":true,"supportsInterrupt":true,"supportsHistory":true,"supportsModelSelection":false,"supportsModeSelection":false,"supportsPermissionSelection":false}"""

    @Test
    fun aPluginAgentLandsInTheSidecar() {
        val decoded = AgentWire.decode("[$session]", kotlinx.serialization.builtins.ListSerializer(Session.serializer())).single()
        assertEquals("acme.gemini", decoded.agent)
        assertEquals("acme.gemini", decoded.agentId)

        val entry = AgentWire.decode(
            """{"backendId":"acme.gemini","label":"Gemini","available":true,"profiles":[{"id":"default","backendId":"acme.gemini","name":"Gemini"}],"capabilities":$capabilities}""",
            NativeBackendCatalogEntry.serializer(),
        )
        assertEquals("acme.gemini", entry.agent)
        assertEquals("acme.gemini", entry.capabilities.agent)
        assertEquals("acme.gemini", entry.profiles.single().agent)

        val settings = AgentWire.decode(
            """{"defaultBackendId":"acme.gemini","nativeBackendDefaults":{"codex":{"model":"m"},"acme.gemini":{"model":"g"}}}""",
            AppSettings.serializer(),
        )
        assertEquals("acme.gemini", settings.defaultAgent)
        assertEquals("g", settings.defaultsFor("acme.gemini")?.model)
        assertEquals("m", settings.defaultsFor("codex")?.model)

        // A built-in receiving session may reference a plugin's history created on another client.
        val reference = """{"sessionId":"source","title":"Source","backendId":"acme.gemini","projectName":"p","capturedAt":"now","snapshotRef":"hash","excerpt":"excerpt","coverage":{"source":"journal","completeness":"partial","messages":1,"bytes":7}}"""
        assertEquals("acme.gemini", AgentWire.decode(reference, CapturedSessionReference.serializer()).agent)
        assertEquals("acme.gemini", RiffetJson.instance.decodeFromString(CapturedSessionReference.serializer(), reference).agent)
    }

    @Test
    fun aBuiltInAgentIsUntouchedAndAClientWithoutTheFeatureStaysStrict() {
        val builtIn = AgentWire.decode(session.replace("acme.gemini", "codex"), Session.serializer())
        assertEquals(NativeBackendId.CODEX, builtIn.backendId)
        assertNull(builtIn.agentId)
        assertEquals("codex", builtIn.agent)
        assertFailsWith<Exception> { RiffetJson.instance.decodeFromString(Session.serializer(), session) }
    }

    @Test
    fun theSidecarGoesBackToTheFieldTheServerReads() {
        val body = buildJsonObject {
            put("agentId", "acme.gemini")
            put("projectId", "p")
            put("defaultAgentId", "acme.gemini")
            put("agentDefaults", buildJsonObject { put("acme.gemini", buildJsonObject { put("model", "g") }) })
            put("nativeBackendDefaults", buildJsonObject { put("codex", buildJsonObject { put("model", "m") }) })
        }
        val lowered = AgentWire.lower(body) as JsonObject
        assertEquals(JsonPrimitive("acme.gemini"), lowered["backendId"])
        assertEquals(JsonPrimitive("acme.gemini"), lowered["defaultBackendId"])
        assertNull(lowered["agentId"])
        assertNull(lowered["agentDefaults"])
        assertEquals(setOf("codex", "acme.gemini"), (lowered["nativeBackendDefaults"] as JsonObject).keys)
    }
}
