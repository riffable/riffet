package riffet.ui.settings

import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.withContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.Dispatchers
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockEngineConfig
import io.ktor.client.engine.mock.MockRequestHandleScope
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.client.request.HttpResponseData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import riffet.contracts.AppSettingsUpdate
import riffet.contracts.AppSettings
import riffet.contracts.NativeBackendDefaults
import riffet.contracts.NativeBackendId
import riffet.contracts.NativeBackendProfileSettings
import riffet.contracts.NativeBackendProfileSettingsUpdate
import riffet.shared.RiffetApi
import riffet.shared.installRiffetClient
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * [riffet.shared.RiffetApi] decodes bodies on Dispatchers.Default, outside the virtual scheduler, so
 * "idle" also has to wait for those decodes to hand their result back.
 */
internal suspend fun TestScope.settle() {
    repeat(4) {
        advanceUntilIdle()
        withContext(Dispatchers.Default) { delay(25) }
    }
}

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class SettingsControllerTest {
    private val headers = headersOf(HttpHeaders.ContentType, "application/json")
    private val profiles = """{"backendId":"codex","profiles":[{"id":"local","backendId":"codex","name":"Local","hasApiKey":true}]}"""
    private fun client(dispatcher: CoroutineDispatcher, handler: suspend MockRequestHandleScope.(HttpRequestData) -> HttpResponseData) =
        HttpClient(MockEngine(MockEngineConfig().apply { this.dispatcher = dispatcher; addHandler(handler) })) { installRiffetClient() }

    @Test
    fun settingsDoNotWaitForDiagnosticsAndProfileFailuresAreNotEmptyLists() = runTest {
        val requests = mutableListOf<String>()
        var failProfiles = true
        val client = client(UnconfinedTestDispatcher(testScheduler)) { request ->
            requests += request.url.encodedPath
            when (request.url.encodedPath) {
                "/api/settings" -> respond("""{"editorCommand":"code"}""", headers = headers)
                "/api/backends/codex/profiles" -> if (failProfiles) respond("{}", HttpStatusCode.ServiceUnavailable, headers) else respond(profiles, headers = headers)
                else -> respond("{}", HttpStatusCode.ServiceUnavailable, headers)
            }
        }
        val controller = SettingsController(RiffetApi(client, "http://127.0.0.1:9"), CoroutineScope(UnconfinedTestDispatcher(testScheduler)), "p1")
        controller.load()
        settle()
        assertEquals(listOf("/api/settings"), requests)
        assertEquals("code", controller.state.value.settings?.editorCommand)

        controller.loadDiagnostics()
        controller.loadProfiles(NativeBackendId.CODEX)
        settle()
        assertNotNull(controller.state.value.diagnosticsError)
        assertNull(controller.state.value.profileLists[NativeBackendId.CODEX])
        assertNotNull(controller.state.value.profilesErrors[NativeBackendId.CODEX])
        assertNull(controller.state.value.error, "an independent diagnostic failure must not disable editable settings")
        failProfiles = false
        controller.loadProfiles(NativeBackendId.CODEX)
        settle()
        assertEquals("Local", controller.state.value.profileLists[NativeBackendId.CODEX]?.single()?.name)
        assertNull(controller.state.value.profilesErrors[NativeBackendId.CODEX])
        failProfiles = true
        controller.loadProfiles(NativeBackendId.CODEX)
        settle()
        assertEquals("Local", controller.state.value.profileLists[NativeBackendId.CODEX]?.single()?.name, "failed refresh keeps the last known list")
        client.close()
    }

    @Test
    fun failedSavesStayEditableAndOnlySuccessfulReceiptsCloseTheEditor() = runTest {
        var fail = true
        var closed = 0
        val requests = mutableListOf<HttpRequestData>()
        val client = client(UnconfinedTestDispatcher(testScheduler)) { request ->
            requests += request
            if (request.method == HttpMethod.Get) respond(profiles, headers = headers)
            else if (fail) respond("{}", HttpStatusCode.ServiceUnavailable, headers)
            else respond("""{"backendId":"codex","profiles":[{"id":"local","backendId":"codex","name":"Renamed","hasApiKey":true}]}""", headers = headers)
        }
        val controller = SettingsController(RiffetApi(client, "http://127.0.0.1:9"), CoroutineScope(UnconfinedTestDispatcher(testScheduler)), null)
        val profile = riffet.contracts.NativeBackendProfileSettings("local", NativeBackendId.CODEX, "Local", hasApiKey = true)
        controller.loadProfiles(NativeBackendId.CODEX)
        settle()
        controller.updateProfile(NativeBackendId.CODEX, "local", NativeBackendProfileSettingsUpdate(name = "Renamed")) { closed++ }
        settle()
        assertEquals(0, closed)
        assertEquals(profile, controller.state.value.profileLists[NativeBackendId.CODEX]?.single())
        assertNotNull(controller.state.value.error)
        assertFalse(controller.state.value.saving)
        fail = false
        controller.updateProfile(NativeBackendId.CODEX, "local", NativeBackendProfileSettingsUpdate(name = "Renamed")) { closed++ }
        settle()
        assertEquals(1, closed)
        assertEquals("Renamed", controller.state.value.profileLists[NativeBackendId.CODEX]?.single()?.name)
        assertNull(controller.state.value.error)
        assertEquals(HttpMethod.Patch, requests.last().method)
        client.close()
    }

    @Test
    fun deletingTheDefaultProviderPublishesSettingsAndDoesNotRestoreAnOlderProfileRead() = runTest {
        val releaseOldRead = CompletableDeferred<Unit>()
        var reads = 0
        val fallback = NativeBackendProfileSettings("local", NativeBackendId.CODEX, "CLI", isDefault = true)
        val team = NativeBackendProfileSettings("team", NativeBackendId.CODEX, "Team", isDefault = true)
        val client = client(UnconfinedTestDispatcher(testScheduler)) { request ->
            when {
                request.url.encodedPath == "/api/settings" -> respond("""{"nativeBackendDefaults":{"codex":{"profileId":"team","model":"saved-model","approval":"read-only"},"cursor":{"approval":"allowlist"}}}""", headers = headers)
                request.method == HttpMethod.Delete -> respond("""{"profiles":[]}""", headers = headers)
                ++reads == 1 -> {
                    releaseOldRead.await()
                    respond("""{"profiles":[{"id":"team","backendId":"codex","name":"Team","isDefault":true}]}""", headers = headers)
                }
                else -> respond("""{"profiles":[{"id":"local","backendId":"codex","name":"CLI","isDefault":true}]}""", headers = headers)
            }
        }
        var published: AppSettings? = null
        val controller = SettingsController(RiffetApi(client, "http://127.0.0.1:9"), CoroutineScope(UnconfinedTestDispatcher(testScheduler)), null, onSettingsSaved = { published = it })
        controller.load()
        settle()
        controller.loadProfiles(NativeBackendId.CODEX)
        settle()
        var closed = false
        controller.deleteProfile(NativeBackendId.CODEX, "team") { closed = true }
        settle()
        assertTrue(closed)
        assertEquals(NativeBackendDefaults(model = "saved-model", approval = "read-only"), published?.nativeBackendDefaults?.get(NativeBackendId.CODEX))
        assertEquals(NativeBackendDefaults(approval = "allowlist"), published?.nativeBackendDefaults?.get(NativeBackendId.CURSOR))
        assertEquals(listOf(fallback), controller.state.value.profileLists[NativeBackendId.CODEX])
        assertEquals("local", defaultProfileId(controller.state.value, NativeBackendId.CODEX))
        releaseOldRead.complete(Unit)
        settle()
        assertEquals(listOf(fallback), controller.state.value.profileLists[NativeBackendId.CODEX], "a pre-delete response must not put the removed default provider back")
        assertFalse(controller.state.value.profilesLoading[NativeBackendId.CODEX] == true)
        client.close()
    }

    @Test
    fun profileModelChangesOnlyPublishForTheEffectiveDefault() = runTest {
        var savedSettings = """{"nativeBackendDefaults":{"codex":{"model":"local-account-model","approval":"read-only"}}}"""
        var receipt = """{"profiles":[{"id":"team","backendId":"codex","name":"Team","defaultModel":"team-only-model"}]}"""
        val client = client(UnconfinedTestDispatcher(testScheduler)) { request ->
            respond(
                when {
                    request.url.encodedPath == "/api/settings" -> savedSettings
                    request.method == HttpMethod.Get -> """{"profiles":[{"id":"local","backendId":"codex","name":"CLI","isDefault":true},{"id":"team","backendId":"codex","name":"Team"}]}"""
                    else -> receipt
                },
                headers = headers,
            )
        }
        val published = mutableListOf<AppSettings>()
        val controller = SettingsController(RiffetApi(client, "http://127.0.0.1:9"), CoroutineScope(UnconfinedTestDispatcher(testScheduler)), null, onSettingsSaved = { published += it })
        controller.load()
        settle()
        controller.loadProfiles(NativeBackendId.CODEX)
        settle()

        controller.updateProfile(NativeBackendId.CODEX, "team", NativeBackendProfileSettingsUpdate(defaultModel = "team-only-model"))
        settle()
        assertTrue(published.isEmpty())
        assertEquals("local-account-model", controller.state.value.settings?.nativeBackendDefaults?.get(NativeBackendId.CODEX)?.model)

        receipt = """{"profiles":[{"id":"local","backendId":"codex","name":"CLI","defaultModel":"local-next-model"}]}"""
        controller.updateProfile(NativeBackendId.CODEX, "local", NativeBackendProfileSettingsUpdate(defaultModel = "local-next-model"))
        settle()
        assertEquals(NativeBackendDefaults(model = "local-next-model", approval = "read-only"), published.last().nativeBackendDefaults?.get(NativeBackendId.CODEX))
        receipt = """{"profiles":[{"id":"local","backendId":"codex","name":"CLI"}]}"""
        controller.updateProfile(NativeBackendId.CODEX, "local", NativeBackendProfileSettingsUpdate(defaultModel = ""))
        settle()
        assertEquals(NativeBackendDefaults(approval = "read-only"), published.last().nativeBackendDefaults?.get(NativeBackendId.CODEX))

        savedSettings = """{"nativeBackendDefaults":{"codex":{"profileId":"team","model":"team-saved-model","approval":"read-only"}}}"""
        controller.load()
        settle()
        val previousPublishes = published.size
        controller.updateProfile(NativeBackendId.CODEX, "local", NativeBackendProfileSettingsUpdate(defaultModel = "local-only-model"))
        settle()
        assertEquals(previousPublishes, published.size, "the explicit provider takes precedence over a cached built-in default")
        receipt = """{"profiles":[{"id":"team","backendId":"codex","name":"Team","defaultModel":"team-next-model"}]}"""
        controller.updateProfile(NativeBackendId.CODEX, "team", NativeBackendProfileSettingsUpdate(defaultModel = "team-next-model"))
        settle()
        assertEquals(NativeBackendDefaults(profileId = "team", model = "team-next-model", approval = "read-only"), published.last().nativeBackendDefaults?.get(NativeBackendId.CODEX))
        receipt = """{"profiles":[{"id":"team","backendId":"codex","name":"Team"}]}"""
        controller.updateProfile(NativeBackendId.CODEX, "team", NativeBackendProfileSettingsUpdate(defaultModel = ""))
        settle()
        assertEquals(NativeBackendDefaults(profileId = "team", approval = "read-only"), published.last().nativeBackendDefaults?.get(NativeBackendId.CODEX))
        client.close()
    }

    @Test
    fun repeatedTapsCannotQueueConflictingWrites() = runTest {
        val release = CompletableDeferred<Unit>()
        val requests = mutableListOf<HttpRequestData>()
        val client = client(UnconfinedTestDispatcher(testScheduler)) { request ->
            requests += request
            release.await()
            respond("""{"editorCommand":"code"}""", headers = headers)
        }
        val controller = SettingsController(RiffetApi(client, "http://127.0.0.1:9"), this, null)
        controller.saveSettings(AppSettingsUpdate(editorCommand = "code"))
        controller.saveSettings(AppSettingsUpdate(editorCommand = "other"))
        controller.updateProfile(NativeBackendId.CODEX, "local", NativeBackendProfileSettingsUpdate(name = "Changed"))
        assertTrue(controller.state.value.saving, "the busy flag must be set before the coroutine starts")
        release.complete(Unit)
        settle()
        assertEquals(1, requests.size)
        assertEquals("code", controller.state.value.settings?.editorCommand)
        assertFalse(controller.state.value.saving)
        client.close()
    }
}
