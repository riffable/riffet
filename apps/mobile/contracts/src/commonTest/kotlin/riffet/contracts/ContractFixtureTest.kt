package riffet.contracts

import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertFails
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Decodes the Space fixtures of `scripts/gen-contracts.ts`: every `max` and `min` payload must
 * decode to the hand-written DTO and encode back without losing a field, and `future` payloads must
 * decode even though they carry a field (or an enum value) this build does not know.
 *
 * The request contracts have no Kotlin DTO; they are exercised by the server and the generated JSON.
 */
class ContractFixtureTest {

    private val json = RiffetJson.instance
    /**
     * Encoding the DTOs back must spell out a default (`state`, `mode`, `delivery`) too, or a field
     * this build dropped would look identical to one it merely left at its default.
     */
    private val roundTrip = Json(json) { encodeDefaults = true }
    private val max = CONTRACT_MAX_FIXTURES.toMap()

    @Test
    fun maxAndMinDecodeEveryModelledSpaceContractWithoutLosingFields() {
        val lost = (CONTRACT_MAX_FIXTURES + CONTRACT_MIN_FIXTURES).flatMap { (name, payload) ->
            val serializer = serializerFor(name) ?: return@flatMap emptyList()
            val wire = json.parseToJsonElement(payload)
            val value = roundTrip.decodeFromJsonElement(serializer, wire)
            lostFields(wire, roundTrip.encodeToJsonElement(serializer, value), name)
        }
        assertEquals(emptyList(), lost.filter { path -> UNMODELLED_CONTRACT_FIELDS.none { it in path } })
    }

    @Test
    fun futureUnknownFieldsAreIgnored() {
        val lost = CONTRACT_FUTURE_FIXTURES.filterNot { it.first.endsWith("#unknown-enum") }.flatMap { (name, payload) ->
            val serializer = serializerFor(name) ?: return@flatMap emptyList()
            val value = roundTrip.decodeFromString(serializer, payload)
            lostFields(json.parseToJsonElement(max.getValue(name)), roundTrip.encodeToJsonElement(serializer, value), name)
        }
        assertEquals(emptyList(), lost.filter { path -> UNMODELLED_CONTRACT_FIELDS.none { it in path } })
    }

    @Test
    fun futureEnumValuesAreKeptAsStrings() {
        val checked = CONTRACT_FUTURE_FIXTURES.filter { it.first.endsWith("#unknown-enum") }
        assertTrue(checked.isNotEmpty())
        for ((name, payload) in checked) {
            val serializer = serializerFor(name) ?: continue
            val wire = json.parseToJsonElement(payload)
            val value = roundTrip.decodeFromJsonElement(serializer, wire)
            assertEquals(wire, roundTrip.encodeToJsonElement(serializer, value), name)
        }
    }

    @Test
    fun optionalThemeDesignRoundTripsAndLegacyThemesOmitIt() {
        val legacy = CustomTheme("custom-test-theme-1", "Test", palette = ThemePalette(emptyMap(), emptyMap()), ansi = ThemeAnsi(emptyList(), emptyList()))
        val wire = json.encodeToString(CustomTheme.serializer(), legacy)
        assertTrue("design" !in wire)
        assertEquals(legacy, json.decodeFromString(CustomTheme.serializer(), wire))
        val theme = legacy.copy(design = ThemeDesign(tokens = ThemeDesignTokens(
            typography = mapOf("input" to ThemeTextStyle(size = 17.0, family = "system")),
            dimensions = mapOf("controlHeight" to 48.0),
            motion = mapOf("pressOpacity" to 0.4),
            colors = ThemeDesignColors(light = mapOf("card" to "#abcdef80")),
        ), styles = mapOf(
            "riffet" to ThemeDesignTokens(variants = mapOf("settingsIcons" to "plain")),
            "material3" to ThemeDesignTokens(colors = ThemeDesignColors(dark = mapOf("input" to "#123456"))),
        )))
        assertEquals(theme, json.decodeFromString(CustomTheme.serializer(), json.encodeToString(CustomTheme.serializer(), theme)))
        val invalid = listOf(
            """{"version":2}""", """{"tokens":{}}""", """{"version":1,"styles":{"android":{}}}""",
            """{"version":1,"tokens":{"dimensions":{"controlHeight":47}}}""",
            """{"version":1,"tokens":{"dimensions":{"drawerWidth":"304"}}}""",
            """{"version":1,"tokens":{"dimensions":{"menuMinWidth":400,"menuMaxWidth":200}}}""",
            """{"version":1,"tokens":{"variants":{"settingsIcons":"glass"}}}""",
            """{"version":1,"tokens":{"typography":{"input":{"family":"other"}}}}""",
            """{"version":1,"tokens":{"colors":{"light":{"card":"red"}}}}""",
            """{"version":1,"tokens":{"future":1}}""", """{"version":1,"tokens":null}""",
        )
        invalid.forEach { payload -> assertFails { json.decodeFromString(ThemeDesignSerializer, payload) } }
    }

    @Test
    fun optionalThemeSyntaxRoundTripsAndLegacyThemesOmitIt() {
        val legacy = CustomTheme("custom-test-theme-1", "Test", palette = ThemePalette(emptyMap(), emptyMap()), ansi = ThemeAnsi(emptyList(), emptyList()))
        val wire = json.encodeToString(CustomTheme.serializer(), legacy)
        assertTrue("syntax" !in wire)
        val half = ThemeSyntaxHalf(
            colors = mapOf("comment" to "#8c8c8c", "keyword" to "#0033b3"),
            commentItalic = false,
        )
        val withSyntax = legacy.copy(syntax = ThemeSyntax(light = half, dark = half.copy(commentItalic = true)))
        assertEquals(withSyntax, json.decodeFromString(CustomTheme.serializer(), json.encodeToString(CustomTheme.serializer(), withSyntax)))
    }

    @Suppress("UNCHECKED_CAST")
    private fun serializerFor(name: String): KSerializer<Any>? = when (name.substringBefore('#').substringBefore('~')) {
        "ShareDraftRequest" -> ShareDraftRequest.serializer()
        "ShareCapability" -> ShareCapability.serializer()
        "SessionShare" -> SessionShare.serializer()
        "ShareStatus" -> ShareStatus.serializer()
        "ShareDraft" -> ShareDraft.serializer()
        "ShareTurnCatalog" -> ShareTurnCatalog.serializer()
        "ShareDraftEvent" -> ShareDraftEvent.serializer()
        "DeviceReport" -> DeviceReport.serializer()
        "DeviceCall" -> DeviceCall.serializer()
        "DeviceCallOutcome" -> DeviceCallOutcome.serializer()
        "DeviceFile" -> DeviceFile.serializer()
        "DeviceLease" -> DeviceLease.serializer()
        "DeviceAdbStatus" -> DeviceAdbStatus.serializer()
        "DeviceAdbGrant" -> DeviceAdbGrant.serializer()
        else -> null
    } as KSerializer<Any>?

    /** Fields of the TS contract the phone does not model. Keep this short and explained. */
    private val UNMODELLED_CONTRACT_FIELDS = emptyList<String>()
}
