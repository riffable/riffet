package riffet.ui.settings

import riffet.contracts.AppSettings
import riffet.contracts.NativeBackendDefaults
import riffet.contracts.NativeBackendId
import kotlin.test.Test
import kotlin.test.assertEquals

class DefaultProfileTest {
    @Test
    fun changingProviderKeepsAgentApprovalAndDoesNotChangeDefaultAgent() {
        val claude = NativeBackendDefaults(profileId = "company", model = "claude-model", mode = "plan")
        val settings = AppSettings(defaultBackendId = NativeBackendId.CLAUDE, nativeBackendDefaults = mapOf(
            NativeBackendId.CODEX to NativeBackendDefaults(profileId = "local", model = "local-only[effort=high,fast=true]", approval = "yolo"),
            NativeBackendId.CLAUDE to claude,
        ))
        val patch = defaultProfilePatch(settings, NativeBackendId.CODEX, "gateway")
        assertEquals(null, patch.defaultBackendId)
        assertEquals(NativeBackendDefaults(profileId = "gateway", approval = "yolo"), patch.nativeBackendDefaults?.get(NativeBackendId.CODEX))
        assertEquals(claude, patch.nativeBackendDefaults?.get(NativeBackendId.CLAUDE))
    }

    @Test
    fun removingDefaultProviderClearsItsModelAndKeepsAgentPreferences() {
        val current = NativeBackendDefaults(profileId = "gateway", model = "model[effort=high,fast=true]", mode = "plan", approval = "on-request")
        assertEquals(current, selectDefaultProfile(current, "gateway"))
        assertEquals(NativeBackendDefaults(mode = "plan", approval = "on-request"), selectDefaultProfile(current, null))
    }
}
