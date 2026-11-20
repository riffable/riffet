package riffet.mac

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import riffet.shared.ForegroundAppearance
import riffet.shared.RiffetApi
import riffet.shared.installRiffetClient
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** The Mac's control switch decides whether T0 capabilities are reported at all (docs/DEVICES.md「实现（Mac，T0）」). */
class MacDeviceTest {
    private class Actions : MacDeviceActions {
        var started = 0
        override fun capabilities() = listOf("notify", "clipboard.read", "clipboard.write", "open_url", "window.capture")
        override fun notify(callId: String, sessionId: String, title: String?, body: String, reply: MacActionReply) { started++ }
        override fun clipboardRead(callId: String, reply: MacActionReply) { started++ }
        override fun clipboardWrite(callId: String, text: String, reply: MacActionReply) { started++ }
        override fun openUrl(callId: String, url: String, reply: MacActionReply) { started++ }
        override fun listWindows(callId: String, reply: MacActionReply) { started++ }
        override fun captureWindow(callId: String, windowId: Long, attempt: Int, reply: MacActionReply) { started++ }
        override fun cancel(callId: String) = Unit
        override fun cancelAll() = Unit
    }

    private val reports = mutableListOf<String>()
    private val client = HttpClient(MockEngine { request ->
        if (request.method == HttpMethod.Put) {
            reports += (request.body as TextContent).text
            respond("""{"id":"d","name":"Mac","createdAt":"2026-11-20T00:00:00Z"}""", headers = headersOf(HttpHeaders.ContentType, "application/json"))
        } else {
            respond(": connected\n\n", headers = headersOf(HttpHeaders.ContentType, "text/event-stream"))
        }
    }) { installRiffetClient() }
    private val api = RiffetApi(client, "http://localhost", { "wkn_0123456789abcdef_secret" })

    private suspend fun until(done: () -> Boolean) = withTimeout(10_000) { while (!done()) delay(10) }

    @Test
    fun noT0CapabilityIsReportedOrServedWhileTheSwitchIsOff() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val actions = Actions()
        val device = MacDevice(scope, ForegroundAppearance(scope, "mac"))
        device.configure("test", actions)
        device.install(api) { true }
        try {
            device.setControlAllowed(api, false)
            delay(500)
            assertEquals(emptyList(), reports)

            device.setControlAllowed(api, true)
            until { reports.isNotEmpty() }
            assertTrue(reports.last().contains("clipboard.read") && reports.last().contains("\"allowControl\":true"), reports.last())

            device.setControlAllowed(api, false)
            until { reports.size >= 2 }
            assertTrue(!reports.last().contains("clipboard") && reports.last().contains("\"allowControl\":false"), reports.last())
            assertEquals(0, actions.started)
        } finally {
            device.setControlAllowed(api, false)
            device.clear()
            scope.cancel()
        }
    }
}
