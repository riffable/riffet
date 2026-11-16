package riffet.ui.settings

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import riffet.contracts.NativeBackendId
import riffet.contracts.NativeBackendProfileSettings
import riffet.shared.WireJson
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Credential omission and explicit clears must preserve the server's PATCH semantics. */
class BackendProfilePatchTest {

    private fun saved(
        name: String = "公司网关",
        apiEndpoint: String = "https://gateway.example.com",
        enabledModels: List<String>? = listOf("a", "b"),
        modelInputModalities: Map<String, List<String>>? = null,
    ) = NativeBackendProfileSettings(
        id = "default",
        backendId = NativeBackendId.CLAUDE,
        name = name,
        apiEndpoint = apiEndpoint,
        enabledModels = enabledModels,
        modelInputModalities = modelInputModalities,
        hasApiKey = true,
    )

    private fun JsonObject.has(key: String) = containsKey(key)

    @Test
    fun untouchedKeySendsNoApiKeyField() {
        val profile = saved()
        val draft = editableDraft(profile).copy(name = "新名字")
        val patch = backendProfilePatch(profile, draft)!!
        assertNull(patch.apiKey, "an untouched key must stay absent from the patch")
        val encoded = WireJson.encodeToJsonElement(patch) as JsonObject
        assertFalse(encoded.has("apiKey"), "encoded patch must not carry an apiKey key at all")
        assertEquals("新名字", encoded["name"]?.jsonPrimitive?.content)
    }

    @Test
    fun changingGatewayTypeKeepsConnectionKeyAndModelSelection() {
        val profile = saved()
        val patch = backendProfilePatch(profile, editableDraft(profile).copy(modelSource = "gateway.adapter"))!!
        assertEquals(JsonPrimitive("gateway.adapter"), patch.modelSource)
        assertNull(patch.apiEndpoint)
        assertNull(patch.apiKey)
        assertNull(patch.enabledModels)
        val adapterProfile = profile.copy(modelSource = "gateway.adapter")
        val generic = backendProfilePatch(adapterProfile, editableDraft(adapterProfile).copy(modelSource = null))!!
        assertEquals(JsonNull, generic.modelSource)
        assertNull(generic.apiEndpoint)
        assertNull(generic.apiKey)
    }

    @Test
    fun clearingSendsJsonNull() {
        val profile = saved()
        val draft = editableDraft(profile).copy(clearApiKey = true)
        val patch = backendProfilePatch(profile, draft)!!
        assertIs<JsonNull>(patch.apiKey)
        val encoded = WireJson.encodeToJsonElement(patch) as JsonObject
        assertEquals(JsonNull, encoded["apiKey"], "clear must be an explicit JSON null, not an absence")
    }

    @Test
    fun emptySelectionAndWholeCatalogStayDifferent() {
        val profile = saved(enabledModels = listOf("a"))
        val all = backendProfilePatch(profile, editableDraft(profile).copy(enabledModels = null))!!
        assertIs<JsonNull>(all.enabledModels)
        assertEquals(JsonNull, (WireJson.encodeToJsonElement(all) as JsonObject)["enabledModels"])

        val none = backendProfilePatch(profile, editableDraft(profile).copy(enabledModels = emptyList()))!!
        assertTrue(assertIs<kotlinx.serialization.json.JsonArray>(none.enabledModels).isEmpty())
        assertEquals(0, (WireJson.encodeToJsonElement(none) as JsonObject)["enabledModels"]?.jsonArray?.size)
    }

    // DSH matches a model by exact id against its own catalog and treats an unknown id as text-only,
    // swapping every image for a placeholder before the request leaves. A declaration that never
    // reaches the server is therefore invisible: the turn succeeds and simply has no image in it.
    /** `null` is the server's only "drop every declaration" value; `{}` would be a silent no-op. */
    @Test
    fun droppingEveryDeclarationSendsJsonNull() {
        val profile = saved(modelInputModalities = mapOf("a" to listOf("image")))
        val patch = backendProfilePatch(profile, editableDraft(profile).copy(modelInputModalities = emptyMap()))!!
        assertIs<JsonNull>(patch.modelInputModalities)
        assertEquals(JsonNull, (WireJson.encodeToJsonElement(patch) as JsonObject)["modelInputModalities"])
    }

    /** The two sets are unordered on the wire, so an order-only edit must not look like a change. */
}
