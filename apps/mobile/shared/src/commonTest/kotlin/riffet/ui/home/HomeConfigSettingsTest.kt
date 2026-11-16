package riffet.ui.home

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockEngineConfig
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.headersOf
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.encodeToString
import io.ktor.http.HttpStatusCode
import riffet.contracts.AppSettings
import riffet.contracts.ModelInfo
import riffet.contracts.NativeBackendCapabilities
import riffet.contracts.NativeBackendCatalogEntry
import riffet.contracts.NativeBackendDefaults
import riffet.contracts.NativeBackendId
import riffet.contracts.NativeBackendOption
import riffet.contracts.NativeBackendProfile
import riffet.contracts.NativeInteractionTransport
import riffet.shared.WireJson
import riffet.shared.RiffetApi
import kotlin.test.Test
import riffet.ui.pickers.selectionForDefaultModel
import kotlin.test.assertNull
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class HomeConfigSettingsTest {
    private fun catalog(id: NativeBackendId) = NativeBackendCatalogEntry(
        backendId = id, label = id.name, available = true,
        profiles = listOf(NativeBackendProfile("default", id, "Default", isDefault = true)),
        defaultModel = "server-default",
        capabilities = NativeBackendCapabilities(
            backendId = id, label = id.name,
            modes = listOf(NativeBackendOption("agent", "Agent"), NativeBackendOption("plan", "Plan")),
            permissions = listOf(NativeBackendOption("on-request", "Default"), NativeBackendOption("read-only", "Read only")),
            interactionTransport = NativeInteractionTransport.PROTOCOL,
            supportsResume = true, supportsInterrupt = true, supportsHistory = true,
            supportsModelSelection = true, supportsModeSelection = true, supportsPermissionSelection = true,
        ),
    )

    @Test
    fun fixingInheritedModelKeepsAllParametersAndSwitchingModelDropsThem() {
        val catalog = listOf(ModelInfo("model", "Model"), ModelInfo("other", "Other"))
        val inherited = "model[effort=high,fast=true,context=1m]"
        assertEquals(inherited, selectionForDefaultModel(catalog, inherited, "model"))
        assertEquals("other", selectionForDefaultModel(catalog, inherited, "other"))
        assertNull(selectionForDefaultModel(catalog, inherited, ""))
    }

    @Test
    fun savedDefaultsUpdateTheRetainedComposerButUnrelatedSettingsKeepItsSelection() = runTest {
        val cursor = catalog(NativeBackendId.CURSOR)
        val codex = catalog(NativeBackendId.CODEX)
        val releaseOld = CompletableDeferred<Unit>()
        var holdNextCatalog = false
        val paths = mutableListOf<String>()
        val client = HttpClient(MockEngine(MockEngineConfig().apply {
            dispatcher = UnconfinedTestDispatcher(testScheduler)
            addHandler { request ->
                val path = request.url.encodedPath
                paths += path
                if (path.endsWith("/catalog") && holdNextCatalog) {
                    holdNextCatalog = false
                    releaseOld.await()
                }
                val body = if (path == "/api/backends") WireJson.encodeToString(listOf(cursor, codex))
                    else WireJson.encodeToString(if (path.contains("codex")) codex else cursor)
                respond(body, headers = headersOf(HttpHeaders.ContentType, "application/json"))
            }
        }))
        val config = HomeConfig(RiffetApi(client, "http://127.0.0.1:9", parseContext = UnconfinedTestDispatcher(testScheduler)), CoroutineScope(UnconfinedTestDispatcher(testScheduler)))
        val settings = AppSettings(defaultBackendId = NativeBackendId.CURSOR, defaultModel = "old", nativeBackendDefaults = mapOf(NativeBackendId.CURSOR to NativeBackendDefaults(mode = "plan", approval = "read-only")))
        config.load("p1", settings)
        advanceUntilIdle()
        assertEquals("old", config.model)
        assertEquals(emptyList(), config.providerGroups(), "one provider stays a flat model list")
        assertEquals("agent", config.mode, "new sessions keep the same agent-mode behavior as the web")
        assertEquals("read-only", config.approval)
        config.model = "my draft selection"
        config.approval = "on-request"
        val count = paths.size
        config.load("p1", settings.copy(editorCommand = "code"))
        advanceUntilIdle()
        assertEquals("my draft selection", config.model)
        assertEquals("on-request", config.approval)
        assertEquals(count, paths.size)

        holdNextCatalog = true
        config.load("p1", settings.copy(defaultModel = "slow old response"))
        config.load("p1", settings.copy(defaultBackendId = NativeBackendId.CODEX, nativeBackendDefaults = mapOf(NativeBackendId.CODEX to NativeBackendDefaults(model = "new-default[effort=high,fast=true]"))))
        advanceUntilIdle()
        assertEquals("new-default[effort=high,fast=true]", config.model)
        releaseOld.complete(Unit)
        advanceUntilIdle()
        assertEquals(NativeBackendId.CODEX, config.backendId)
        assertEquals("new-default[effort=high,fast=true]", config.model, "the previous catalog must not overwrite the new backend's defaults")
        val codexDefaults = settings.copy(defaultBackendId = NativeBackendId.CODEX, nativeBackendDefaults = mapOf(NativeBackendId.CODEX to NativeBackendDefaults(model = "new-default[effort=high,fast=true]", approval = "read-only")))
        config.load("p1", codexDefaults)
        advanceUntilIdle()
        assertEquals("read-only", config.approval, "saved approval defaults reach the retained new-session composer")
        config.load("p1", codexDefaults.copy(nativeBackendDefaults = mapOf(NativeBackendId.CODEX to NativeBackendDefaults(model = "new-default[effort=high,fast=true]"))))
        advanceUntilIdle()
        assertEquals("on-request", config.approval, "clearing the override restores the backend's default permission")
        client.close()
    }

    @Test
    fun picksSurviveAReloadWhileTheCatalogStillOffersThemAndDefaultsKeepFollowingSettings() = runTest {
        val started = openHome { entry(listOf(ModelInfo("local-model", "Local"), ModelInfo("other", "Other")), "local-model") }
        val config = started.config
        val settings = AppSettings(defaultBackendId = NativeBackendId.CODEX)
        config.load("p1", settings)
        advanceUntilIdle()
        config.mode = "plan"
        config.approval = "read-only"
        config.model = "other"
        config.load("p1", settings.copy(nativeBackendDefaults = mapOf(NativeBackendId.CODEX to NativeBackendDefaults(model = "local-model"))))
        advanceUntilIdle()
        assertEquals("plan", config.mode)
        assertEquals("read-only", config.approval)
        assertEquals("other", config.model)
        config.model = "gone"
        assertEquals("local-model", config.model, "a pick the catalog does not offer falls back to the default")
        started.client.close()
    }

    @Test
    fun choosingAnotherProvidersModelPointsTheNextSessionAtThatProvider() = runTest {
        val requested = mutableListOf<String?>()
        val started = openHome(requested) { profile ->
            val models = if (profile == "gateway") listOf(ModelInfo("gw-model", "Gateway")) else listOf(ModelInfo("local-model", "Local"))
            entry(models, models.single().value)
        }
        val config = started.config
        config.load("p1", AppSettings(defaultBackendId = NativeBackendId.CODEX))
        advanceUntilIdle()
        assertEquals(listOf<String?>("local", "gateway"), requested)
        assertEquals("local", config.profileId)
        assertEquals("local-model", config.model)
        assertEquals(listOf("CLI", "网关"), config.providerGroups().map { it.name })
        assertEquals(listOf("gw-model"), config.providerGroups().first { it.profileId == "gateway" }.models.map { it.value })

        config.selectProviderModel("gateway", "gw-model")
        assertEquals("gateway", config.profileId)
        assertEquals("gw-model", config.model)
        assertEquals("gw-model", config.catalog.single().value)
        started.client.close()
    }

    @Test
    fun aProviderWhoseCatalogFailedStaysOutOfTheNextSession() = runTest {
        val started = openHome { profile ->
            if (profile == "gateway") null else entry(listOf(ModelInfo("local-model", "Local")), "local-model")
        }
        val config = started.config
        config.load("p1", AppSettings(defaultBackendId = NativeBackendId.CODEX))
        advanceUntilIdle()
        val gateway = config.providerGroups().first { it.profileId == "gateway" }
        assertNotNull(gateway.error)
        assertTrue(gateway.models.isEmpty())
        config.selectProviderModel("gateway", "gw-model")
        assertEquals("local", config.profileId)
        assertEquals("local-model", config.model)
        started.client.close()
    }

    private fun entry(models: List<ModelInfo>, defaultModel: String) = catalog(NativeBackendId.CODEX).copy(
        profiles = listOf(
            NativeBackendProfile("local", NativeBackendId.CODEX, "CLI", isDefault = true),
            NativeBackendProfile("gateway", NativeBackendId.CODEX, "网关"),
        ),
        models = models,
        defaultModel = defaultModel,
    )

    /** [catalogFor] returns null to fail that provider's catalog read. */
    private fun TestScope.openHome(
        requested: MutableList<String?> = mutableListOf(),
        catalogFor: (String?) -> NativeBackendCatalogEntry?,
    ): StartedHome {
        val listed = entry(listOf(ModelInfo("local-model", "Local")), "local-model")
        val headers = headersOf(HttpHeaders.ContentType, "application/json")
        val client = HttpClient(MockEngine(MockEngineConfig().apply {
            dispatcher = UnconfinedTestDispatcher(testScheduler)
            addHandler { request ->
                if (request.url.encodedPath == "/api/backends") {
                    respond(WireJson.encodeToString(listOf(listed)), headers = headers)
                } else {
                    val profile = request.url.parameters["profileId"]
                    requested += profile
                    val body = catalogFor(profile)
                    if (body == null) respond("{}", HttpStatusCode.ServiceUnavailable, headers)
                    else respond(WireJson.encodeToString(body), headers = headers)
                }
            }
        }))
        val config = HomeConfig(RiffetApi(client, "http://127.0.0.1:9", parseContext = UnconfinedTestDispatcher(testScheduler)), CoroutineScope(UnconfinedTestDispatcher(testScheduler)))
        return StartedHome(config, client)
    }

    private class StartedHome(val config: HomeConfig, val client: HttpClient)
}
