package riffet.contracts

import kotlinx.serialization.decodeFromString
import kotlin.test.*

class NativeSteerContractTest {
    @Test fun `native model usage preserves daily decimals and weekly compatibility`() {
        val usage = RiffetJson.instance.decodeFromString<NativeBackendUsage>("""{
            "models": {
                "Orange-O55": {"quotaLimited":true,"quota":{"usedPercent":0,"windowMinutes":10080,"remaining":300,"limit":300}},
                "GPT-6.1-Sol": {"quotaLimited":false,"dailyQuotaKey":"gpt_6_1","dailyQuota":{"usedPercent":57,"windowMinutes":1440,"remaining":25.16621,"limit":58,"depleted":false}},
                "unavailable": {"quotaLimited":true,"dailyQuotaKey":"gpt_6"}
            }
        }""")
        assertEquals(300, usage.models.getValue("Orange-O55").quota?.remaining)
        val daily = usage.models.getValue("GPT-6.1-Sol")
        assertEquals("gpt_6_1", daily.dailyQuotaKey)
        assertEquals(25.16621, daily.dailyQuota?.remaining)
        assertNull(daily.quota)
        val unavailable = usage.models.getValue("unavailable")
        assertEquals(true, unavailable.quotaLimited)
        assertNull(unavailable.quota)
        assertNull(unavailable.dailyQuota)
        val model = RiffetJson.instance.decodeFromString<ModelInfo>("""{"value":"Orange-O55","name":"Orange-O55","aliases":["openrouter-4o"]}""")
        assertEquals(listOf("openrouter-4o"), model.aliases)
        val old = RiffetJson.instance.decodeFromString<ModelStatus>("""{"loadPercent":123}""")
        assertNull(old.quotaLimited)
        assertNull(old.dailyQuotaKey)
    }

    @Test fun `old settings and status cannot opt a client into steering`() {
        assertNull(RiffetJson.instance.decodeFromString<AppSettings>("{}").composerRunningBehavior)
        val status = RiffetJson.instance.decodeFromString<NativeStatus>("""{"phase":"busy","activeTurnId":"display-run"}""")
        assertNull(status.activeTurn)
        assertNull(status.connection)
        assertEquals("display-run", status.activeTurnId)
        val caps = RiffetJson.instance.decodeFromString<NativeBackendCapabilities>("""{"backendId":"codex","label":"Codex","interactionTransport":"none","supportsResume":true,"supportsInterrupt":true,"supportsHistory":true,"supportsModelSelection":true,"supportsModeSelection":true,"supportsPermissionSelection":true}""")
        assertFalse(caps.supportsSteer)
    }
}
