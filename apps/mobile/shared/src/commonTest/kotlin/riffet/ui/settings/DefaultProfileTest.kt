package riffet.ui.settings

import riffet.contracts.AppSettings
import riffet.contracts.NativeBackendDefaults
import riffet.contracts.NativeBackendId
import kotlin.test.Test
import kotlin.test.assertEquals

class DefaultProfileTest {
    @Test
    fun changingProviderDoesNotCarryModelsOrPermissionsAcrossProviders() {
        val claude = NativeBackendDefaults(profileId = "company", model = "claude-model", mode = "plan")
        val settings = AppSettings(nativeBackendDefaults = mapOf(
            NativeBackendId.CODEX to NativeBackendDefaults(profileId = "local", model = "local-only", approval = "yolo"),
            NativeBackendId.CLAUDE to claude,
        ))
        val patch = defaultProfilePatch(settings, NativeBackendId.CODEX, "gateway")
        assertEquals(NativeBackendId.CODEX, patch.defaultBackendId)
        assertEquals(NativeBackendDefaults(profileId = "gateway"), patch.nativeBackendDefaults?.get(NativeBackendId.CODEX))
        assertEquals(claude, patch.nativeBackendDefaults?.get(NativeBackendId.CLAUDE))
    }

}
