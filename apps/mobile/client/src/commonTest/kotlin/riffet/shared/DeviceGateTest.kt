package riffet.shared

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.test.runTest
import riffet.contracts.DeviceCall
import riffet.contracts.DeviceCallOutcome
import riffet.contracts.DeviceCapability
import riffet.contracts.DeviceErrorCode
import riffet.contracts.DeviceLease
import riffet.contracts.DeviceReport
import riffet.contracts.RiffetJson
import kotlin.test.Test
import kotlin.test.assertEquals

/** The device's single entry point (docs/DEVICES.md §3, §5): side effects happen once per call id. */
class DeviceGateTest {
    private class MemoryPreferences : AppPreferences {
        private val values = mutableMapOf<String, String>()
        override fun themeMode() = ThemeMode.SYSTEM
        override fun setThemeMode(mode: ThemeMode) {}
        override fun string(key: String) = values[key]
        override fun setString(key: String, value: String?) {
            if (value == null) values.remove(key) else values[key] = value
        }
    }

    private class CountingExecutor(private val block: suspend () -> DeviceCallOutcome = { DeviceCallOutcome.success() }) : DeviceExecutor {
        var runs = 0
        override fun capabilities() = listOf(DeviceCapability.NOTIFY)
        override suspend fun execute(call: DeviceCall, api: RiffetApi): DeviceCallOutcome {
            runs++
            return block()
        }
    }

    private val answers = mutableListOf<Pair<String, DeviceCallOutcome>>()
    private val client = HttpClient(MockEngine { request ->
        val callId = request.url.encodedPath.removePrefix("/api/devices/me/calls/").removeSuffix("/result")
        answers += callId to RiffetJson.instance.decodeFromString(DeviceCallOutcome.serializer(), (request.body as TextContent).text)
        respond("{}", headers = headersOf(HttpHeaders.ContentType, "application/json"))
    }) { installRiffetClient() }
    private val api = RiffetApi(client, "http://localhost", { "wkn_0123456789abcdef_secret" })

    /** The answers go out on the mock engine's own threads; wait for them in real time. */
    private suspend fun until(done: () -> Boolean) = withContext(Dispatchers.Default) { withTimeout(5_000) { while (!done()) delay(5) } }

    private suspend fun settle() = withContext(Dispatchers.Default) { delay(200) }

    private fun call(id: String, capability: String = DeviceCapability.NOTIFY) =
        DeviceCall(id, "s1", capability, deadline = "2999-01-01T00:00:00Z", createdAt = "2026-11-04T00:00:00Z")

    @Test
    fun aReplayedCallIsAnsweredAgainWithoutRunningTwice() = runTest {
        val executor = CountingExecutor()
        val gate = DeviceGate(api, executor, DeviceCallJournal(MemoryPreferences()), backgroundScope, allowed = { true })
        gate.handle(call("c1"))
        until { answers.size == 1 }
        gate.handle(call("c1"))
        until { answers.size == 2 }
        assertEquals(1, executor.runs)
        assertEquals(listOf("c1" to DeviceCallOutcome.success(), "c1" to DeviceCallOutcome.success()), answers)
    }

    @Test
    fun theDeviceSwitchAndMissingCapabilitiesRefuseWithoutRunning() = runTest {
        val executor = CountingExecutor()
        var allowed = false
        val gate = DeviceGate(api, executor, DeviceCallJournal(MemoryPreferences()), backgroundScope, allowed = { allowed })
        gate.handle(call("off"))
        until { answers.size == 1 }
        allowed = true
        gate.handle(call("missing", DeviceCapability.LOCATION))
        until { answers.size == 2 }
        assertEquals(0, executor.runs)
        assertEquals(listOf("off" to DeviceErrorCode.NOT_ALLOWED, "missing" to DeviceErrorCode.CAPABILITY_MISSING), answers.map { it.first to it.second.code })
    }

    @Test
    fun aDuplicateWhileRunningIsIgnoredAndACancelSendsNothing() = runTest {
        val started = CompletableDeferred<Unit>()
        val executor = CountingExecutor { started.complete(Unit); awaitCancellation() }
        val gate = DeviceGate(api, executor, DeviceCallJournal(MemoryPreferences()), backgroundScope, allowed = { true })
        gate.handle(call("c2"))
        started.await()
        gate.handle(call("c2"))
        gate.cancel("c2")
        settle()
        assertEquals(1, executor.runs)
        assertEquals(emptyList(), answers)
    }
    @Test
    fun capabilityReportsFollowTheLatestForegroundState() = runTest {
        val offlineStarted = CompletableDeferred<Unit>()
        val finishOffline = CompletableDeferred<Unit>()
        val reports = mutableListOf<List<String>>()
        val http = HttpClient(MockEngine { request ->
            val report = RiffetJson.instance.decodeFromString(DeviceReport.serializer(), (request.body as TextContent).text)
            reports += report.capabilities
            if (report.capabilities.isEmpty()) {
                offlineStarted.complete(Unit)
                finishOffline.await()
            }
            respond("""{"id":"device","name":"Riffet","createdAt":"now","online":true}""",
                headers = headersOf(HttpHeaders.ContentType, "application/json"))
        }) { installRiffetClient() }
        try {
            val on = listOf(DeviceCapability.RIFFET_APPEARANCE)
            var capabilities = on
            val deviceApi = RiffetApi(http, "http://localhost", { "wkn_0123456789abcdef_secret" })
            val executor = object : DeviceExecutor {
                override fun capabilities() = capabilities
                override suspend fun execute(call: DeviceCall, api: RiffetApi) = DeviceCallOutcome.success()
            }
            val gate = DeviceGate(deviceApi, executor, DeviceCallJournal(MemoryPreferences()), backgroundScope)
            val leases = object : DeviceLeaseScheduler {
                override fun schedule(lease: DeviceLease) {}
                override fun cancel(id: String) {}
                override fun held() = emptySet<String>()
            }
            val channel = DeviceChannel(deviceApi, executor, gate, leases, "android", "test",
                allowed = { true }, installationId = { "test" })
            channel.report()
            capabilities = emptyList()
            val leaving = launch { channel.reportIfChanged() }
            offlineStarted.await()
            capabilities = on
            val returning = launch(start = CoroutineStart.UNDISPATCHED) { channel.reportIfChanged() }
            finishOffline.complete(Unit)
            leaving.join()
            returning.join()
            assertEquals(listOf(on, emptyList(), on), reports)
        } finally {
            http.close()
        }
    }

}
