package riffet.ui.pickers

import riffet.contracts.ModelConfigOption
import riffet.contracts.ModelConfigOptionValue
import riffet.contracts.ModelInfo
import riffet.contracts.NativeModelVariant
import kotlin.test.Test
import kotlin.test.assertEquals

class GeminiEffortSelectionTest {

    private val geminiNeon = ModelInfo(
        value = "gemini-4-neon",
        name = "Gemini 4 Neon",
        configOptions = listOf(
            ModelConfigOption(
                id = "effort",
                name = "Effort",
                category = "thought_level",
                type = "select",
                currentValue = "low",
                options = listOf(
                    ModelConfigOptionValue("low", "Low"),
                    ModelConfigOptionValue("medium", "Medium"),
                    ModelConfigOptionValue("high", "High"),
                ),
            ),
            ModelConfigOption(
                id = "context",
                name = "Context",
                category = "model_config",
                type = "select",
                currentValue = "300k",
                options = listOf(
                    ModelConfigOptionValue("300k", "300K"),
                    ModelConfigOptionValue("1m", "1M"),
                ),
            ),
        ),
        nativeVariants = listOf(
            NativeModelVariant("gemini-4-neon-low", "Gemini 4 Neon Low"),
            NativeModelVariant("gemini-4-neon-medium", "Gemini 4 Neon Medium"),
            NativeModelVariant("gemini-4-neon-high", "Gemini 4 Neon High"),
        ),
    )

    @Test
    fun translatesReasoningEffortAliasReturnedByCursorForGemini() {
        val catalog = listOf(geminiNeon)
        val normalizedFromServer = "gemini-4-neon[context=1m,reasoning_effort=high]"

        val resolved = resolveModelSelection(catalog, normalizedFromServer)
        assertEquals("gemini-4-neon", resolved.model)
        assertEquals(mapOf("context" to "1m", "effort" to "high"), resolved.params)

        val params = catalogParams(catalog, resolved.model, resolved.params)
        assertEquals("high", params.first { it.id == "effort" }.value)
        assertEquals("1m", params.first { it.id == "context" }.value)

        // Changing context must keep effort=high instead of dropping back to catalog currentValue (low).
        assertEquals(
            "gemini-4-neon[context=300k,effort=high]",
            selectionWithParam(catalog, normalizedFromServer, "context", "300k"),
        )
        // Changing effort must emit deterministic sorted keys with the picked effort.
        assertEquals(
            "gemini-4-neon[context=1m,effort=medium]",
            selectionWithParam(catalog, normalizedFromServer, "effort", "medium"),
        )
    }
}
