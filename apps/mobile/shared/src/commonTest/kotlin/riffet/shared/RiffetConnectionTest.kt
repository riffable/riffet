package riffet.shared

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockEngineConfig
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import riffet.contracts.RiffetJson
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

/**
 * The device token goes only to the origin that issued it. A typed address, a discovered or scanned
 * server and a pairing attempt are all reached without it, and none of them moves the connection
 * away from the server it was on until a pairing actually succeeds.
 */
class RiffetConnectionTest {

    private class MemoryTokenStore(
        var token: String? = null,
        var origin: String? = null,
        var server: String? = null,
    ) : DeviceTokenStore {
        var pairings: String? = null
        var failWrites = false

        override suspend fun loadPairings(): String? = pairings
        override suspend fun savePairings(value: String) {
            check(!failWrites) { "disk unavailable" }
            pairings = value
            token = null
            origin = null
            server = null
        }

        override suspend fun load(): String? = token
        override suspend fun loadOrigin(): String? = origin
        override suspend fun save(token: String, origin: String) {
            this.token = token
            this.origin = origin
        }
        override suspend fun clear() {
            pairings = null
            token = null
            origin = null
            server = null
        }
        override suspend fun loadServer(): String? = server
        override suspend fun saveServer(baseUrl: String) {
            server = baseUrl
        }
    }

    private class TestDevice : DeviceInfo {
        override val deviceName: String = "test phone"
    }

    private val jsonHeaders = headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString())
    private val seen = mutableListOf<HttpRequestData>()

    private fun TestScope.connectionFor(
        store: DeviceTokenStore,
        pairStatus: HttpStatusCode = HttpStatusCode.OK,
        pairing: suspend () -> Unit = {},
        bootstrap: suspend (HttpRequestData) -> HttpStatusCode = { HttpStatusCode.OK },
    ): RiffetConnection {
        val engine = MockEngine(MockEngineConfig().apply {
            // Network responses and the switch deadline must share the test's virtual clock.
            dispatcher = StandardTestDispatcher(testScheduler)
            addHandler { request ->
                if (request.url.encodedPath == "/api/devices/prove") {
                    assertNull(request.authorization(), "TLS proof probe must never carry a device token")
                    return@addHandler respond("""{"error":{"code":"DEVICE_NOT_FOUND","message":"not found"}}""", HttpStatusCode.NotFound, jsonHeaders)
                }
                seen += request
                when (request.url.encodedPath) {
                    "/api/devices/pair" -> {
                        pairing()
                        if (pairStatus == HttpStatusCode.OK) {
                            respond(
                                """{"device":{"id":"d2","name":"test phone","createdAt":"2026-10-13T00:00:00Z"},"token":"$NEW_TOKEN"}""",
                                pairStatus,
                                jsonHeaders,
                            )
                        } else {
                            respond("""{"error":{"code":"INVALID_PAIRING_CODE","message":"expired"}}""", pairStatus, jsonHeaders)
                        }
                    }
                    "/api/bootstrap" -> {
                        val status = bootstrap(request)
                        respond(
                            if (status == HttpStatusCode.OK) """{"projects":[],"sessions":[],"terminals":[],"settings":{}}"""
                            else """{"error":{"code":"UNAUTHORIZED","message":"revoked"}}""",
                            status,
                            jsonHeaders,
                        )
                    }
                    "/api/auth/status" -> respond("""{"authenticated":false,"tokenRequired":true}""", HttpStatusCode.OK, jsonHeaders)
                    else -> respond("[]", HttpStatusCode.OK, jsonHeaders)
                }
            }
        })
        return RiffetConnection(store, TestDevice(), HttpClient(engine) { installRiffetClient() }, parseContext = StandardTestDispatcher(testScheduler))
    }

    private fun payload(host: String, port: Int = 4317) =
        PairingPayload(v = PairingPayload.CURRENT_VERSION, host = host, port = port, code = "ABCDEFGH")

    private fun HttpRequestData.authorization(): String? = headers[HttpHeaders.Authorization]

    @Test
    fun `legacy credentials migrate once and survive a restart without changing their origin`() = runTest {
        val store = MemoryTokenStore(OLD_TOKEN, "http://mac.local:4317", "http://mac.local:4317")
        val first = connectionFor(store)
        first.restore()!!.sessions()

        assertNotNull(store.pairings)
        assertNull(store.token)
        assertNull(store.origin)
        assertNull(store.server)
        assertEquals("http://mac.local:4317", store.activeServerBaseUrl())
        assertEquals("Bearer $OLD_TOKEN", seen.single().authorization())

        val restarted = connectionFor(store)
        restarted.restore()!!.sessions()
        assertEquals("http://mac.local:4317", restarted.baseUrl)
        assertEquals(listOf("http://mac.local:4317"), restarted.pairedServers().map { it.origin })
        assertEquals("Bearer $OLD_TOKEN", seen.last().authorization())
    }

    @Test
    fun `probing another address sends no token and leaves the connection where it was`() = runTest {
        val store = MemoryTokenStore(OLD_TOKEN, "http://mac.local:4317", "http://mac.local:4317")
        val connection = connectionFor(store)
        val restored = connection.restore()!!

        connection.probe("http://evil.local:4317").authStatus()

        assertNull(seen.single().authorization())
        assertEquals("evil.local", seen.single().url.host)
        assertSame(restored, connection.apiOrNull())
        assertEquals("http://mac.local:4317", connection.baseUrl)
    }

    @Test
    fun `pairing elsewhere sends no token and switches only once the server answers`() = runTest {
        val store = MemoryTokenStore(OLD_TOKEN, "http://mac.local:4317", "http://mac.local:4317")
        val connection = connectionFor(store)
        val previous = connection.restore()!!

        connection.pair(payload("other.local", 9000))

        val pairRequest = seen.single()
        assertNull(pairRequest.authorization(), "the old token must not reach the address being paired with")
        assertEquals(NEW_TOKEN, store.tokenFor("http://other.local:9000"))
        assertEquals("http://other.local:9000", store.boundOrigin())
        assertEquals(listOf("http://other.local:9000", "http://mac.local:4317"), connection.pairedServers().map { it.origin })
        assertEquals("http://other.local:9000", connection.baseUrl)

        connection.requireApi().sessions()
        assertEquals("Bearer $NEW_TOKEN", seen.last().authorization())
        previous.sessions()
        assertEquals("mac.local", seen.last().url.host)
        assertEquals("Bearer $OLD_TOKEN", seen.last().authorization(), "an old API keeps its own service's credential")
    }

    @Test
    fun `a failed pairing leaves the previous connection and token untouched`() = runTest {
        val store = MemoryTokenStore(OLD_TOKEN, "http://mac.local:4317", "http://mac.local:4317")
        val connection = connectionFor(store, pairStatus = HttpStatusCode.Unauthorized)
        val restored = connection.restore()!!

        assertFailsWith<RiffetUnauthenticatedException> { connection.pair(payload("other.local")) }

        assertNull(seen.single().authorization())
        assertSame(restored, connection.apiOrNull())
        assertEquals("http://mac.local:4317", connection.baseUrl)
        assertEquals(OLD_TOKEN, store.tokenFor("http://mac.local:4317"))
        assertEquals("http://mac.local:4317", store.boundOrigin())
        assertEquals(listOf("http://mac.local:4317"), connection.pairedServers().map { it.origin })
    }

    @Test
    fun `a remembered server other than the token's origin is reached without the token`() = runTest {
        val store = MemoryTokenStore(OLD_TOKEN, "http://mac.local:4317", "http://mac.local:4317")
        val api = connectionFor(store).connectAndRemember("http://evil.local:4317")

        api.sessions()

        assertNull(seen.single().authorization())
        assertEquals("http://mac.local:4317", store.boundOrigin(), "the token stays bound to the server that issued it")
        assertEquals("http://mac.local:4317", connectionFor(store).restore()!!.baseUrl)
    }

    @Test
    fun `a token stored before origins were recorded is bound to its stored server`() = runTest {
        val store = MemoryTokenStore(token = OLD_TOKEN, origin = null, server = "http://Mac.local:4317/")
        val connection = connectionFor(store)

        connection.restore()!!.sessions()
        assertEquals("Bearer $OLD_TOKEN", seen.single().authorization())
        assertEquals("http://mac.local:4317", store.boundOrigin())

        connection.connectAndRemember("http://evil.local:4317").sessions()
        assertNull(seen.last().authorization())
        assertEquals("http://mac.local:4317", store.boundOrigin())
    }

    @Test
    fun `an unknown override cannot replace the service selected for the next launch`() = runTest {
        val store = MemoryTokenStore(token = OLD_TOKEN, origin = null, server = "http://mac.local:4317")

        connectionFor(store).connectAndRemember("http://evil.local:4317").sessions()

        assertNull(seen.single().authorization())
        assertEquals("http://mac.local:4317", store.boundOrigin())
        assertEquals("http://mac.local:4317", connectionFor(store).restore()!!.baseUrl)
        assertEquals(listOf("http://mac.local:4317"), connectionFor(store).pairedServers().map { it.origin })
    }

    @Test
    fun `failed target validation and persistence preserve the current service`() = runTest {
        val store = MemoryTokenStore(OLD_TOKEN, "http://mac.local:4317", "http://mac.local:4317")
        var failure: String? = null
        val connection = connectionFor(store, bootstrap = { request ->
            when (failure.takeIf { request.url.host == "other.local" }) {
                "auth" -> HttpStatusCode.Unauthorized
                "network" -> throw IllegalStateException("offline")
                else -> HttpStatusCode.OK
            }
        })
        connection.restore()
        connection.pair(payload("other.local"))
        val previous = connection.switchServer("http://mac.local:4317")
        val saved = store.pairings

        failure = "auth"
        assertFailsWith<RiffetUnauthenticatedException> { connection.switchServer("http://other.local:4317") }
        assertSame(previous, connection.apiOrNull())
        assertEquals(saved, store.pairings)

        failure = "network"
        assertFailsWith<RiffetNetworkException> { connection.switchServer("http://other.local:4317") }
        assertSame(previous, connection.apiOrNull())
        assertEquals(saved, store.pairings)

        failure = null
        store.failWrites = true
        assertFailsWith<IllegalStateException> { connection.switchServer("http://other.local:4317") }
        assertSame(previous, connection.apiOrNull())
        assertEquals(saved, store.pairings)
        assertEquals("http://mac.local:4317", store.boundOrigin())
    }

    @Test
    fun `a successful switch persists selection and forgetting removes only its own service`() = runTest {
        val store = MemoryTokenStore(OLD_TOKEN, "http://mac.local:4317", "http://mac.local:4317")
        val connection = connectionFor(store)
        connection.restore()
        connection.pair(payload("other.local"))

        assertEquals("http://other.local:4317", store.activeServerBaseUrl())
        val current = connection.switchServer("http://mac.local:4317")
        assertEquals("http://mac.local:4317", store.activeServerBaseUrl())
        assertEquals("Bearer $OLD_TOKEN", seen.last().authorization())
        assertEquals("http://mac.local:4317", connectionFor(store).restore()!!.baseUrl)
        assertFalse(connection.forgetServer("http://other.local:4317"))
        assertSame(current, connection.apiOrNull())
        assertNull(store.tokenFor("http://other.local:4317"))
        assertEquals(listOf("http://mac.local:4317"), connection.pairedServers().map { it.origin })

        connection.pair(payload("other.local"))
        connection.switchServer("http://mac.local:4317")
        assertTrue(connection.forgetServer("http://mac.local:4317"))
        assertNull(connection.apiOrNull())
        assertNull(connectionFor(store).restore(), "forgetting the current service must not select another one")
        assertNull(store.activeServerBaseUrl(), "resource requests must not select another saved service")
        assertEquals(listOf("http://other.local:4317"), connection.pairedServers().map { it.origin })
        assertEquals(NEW_TOKEN, store.tokenFor("http://other.local:4317"))
    }

    @Test
    fun `pairing the same origin updates credentials without losing the saved name`() = runTest {
        val store = MemoryTokenStore()
        val connection = connectionFor(store)
        connection.pair(payload("mac.local").copy(name = "Work Mac"))

        connection.pair("http://MAC.local:4317/", "ABCDEFGH", "test phone")

        val saved = connection.pairedServers().single()
        assertEquals("http://mac.local:4317", saved.origin)
        assertEquals("Work Mac", saved.name)
        assertEquals(NEW_TOKEN, store.tokenFor("http://mac.local:4317"))

        connection.renameServer(saved.origin, "Home Mac")
        connection.pair(payload("mac.local").copy(name = "Detected Mac"))
        assertEquals("Home Mac", connection.pairedServers().single().name)

        connection.renameServer(saved.origin, "  ")
        connection.pair(payload("mac.local").copy(name = "Detected Mac"))
        val cleared = connection.pairedServers().single()
        assertEquals("", cleared.name)
        assertEquals("mac.local:4317", cleared.displayName)
    }

    @Test
    fun `renaming an offline service persists without changing authorization or selection`() = runTest {
        val store = MemoryTokenStore()
        val connection = connectionFor(store)
        connection.pair(payload("mac.local").copy(name = "Work Mac"))
        connection.pair(payload("other.local"))
        val before = RiffetJson.instance.parseToJsonElement(store.pairings!!)
        val installed = connection.requireApi()
        val requests = seen.size

        val renamed = connection.renameServer("http://mac.local:4317", "  家里的 Mac  ")

        assertEquals("家里的 Mac", renamed.displayName)
        assertEquals(requests, seen.size, "a local name change must work without network access")
        assertSame(installed, connection.requireApi())
        val after = RiffetJson.instance.parseToJsonElement(store.pairings!!).jsonObject
        val originalNames = after.getValue("servers").jsonArray.map { record ->
            val server = record.jsonObject
            if (server.getValue("origin").jsonPrimitive.content == renamed.origin) {
                JsonObject(server + ("name" to JsonPrimitive("Work Mac")))
            } else server
        }
        assertEquals(before, JsonObject(after + ("servers" to JsonArray(originalNames))),
            "only the target service's name may change")
        val restarted = connectionFor(store)
        assertEquals("http://other.local:4317", restarted.restore()!!.baseUrl)
        assertEquals("家里的 Mac", restarted.pairedServers().first { it.origin == renamed.origin }.displayName)
        assertEquals(NEW_TOKEN, store.tokenFor(renamed.baseUrl))
        assertNull(store.tokenFor("http://unknown.local:4317"))
    }

    @Test
    fun `invalid names and failed name persistence preserve saved services`() = runTest {
        val store = MemoryTokenStore()
        val connection = connectionFor(store)
        connection.pair(payload("mac.local"))
        val origin = "http://mac.local:4317"
        val emojiName = "\uD83D\uDDA5".repeat(64)
        connection.renameServer(origin, emojiName)
        val saved = store.pairings
        val installed = connection.requireApi()

        assertFailsWith<IllegalArgumentException> { connection.renameServer("http://unknown.local:4317", "Other") }
        for (name in listOf("x".repeat(65), emojiName + "x", "Home\nMac", "Home\u2028Mac")) {
            assertFailsWith<IllegalArgumentException> { connection.renameServer(origin, name) }
        }
        assertEquals(saved, store.pairings)
        store.failWrites = true
        assertFailsWith<IllegalStateException> { connection.renameServer(origin, "New name") }
        assertEquals(saved, store.pairings)
        assertSame(installed, connection.requireApi())
        assertEquals(emojiName, connection.pairedServers().single().name)
        assertEquals(NEW_TOKEN, store.tokenFor(origin))
    }

    @Test
    fun `failed migration and failed pairing persistence leave previous credentials intact`() = runTest {
        val store = MemoryTokenStore(OLD_TOKEN, "http://mac.local:4317", "http://mac.local:4317")
        val connection = connectionFor(store)
        store.failWrites = true
        assertFailsWith<IllegalStateException> { connection.restore() }
        assertNull(connection.apiOrNull())
        assertNull(store.pairings)
        assertEquals(OLD_TOKEN, store.token)
        assertEquals("http://mac.local:4317", store.server)

        store.failWrites = false
        val previous = connection.restore()!!
        val saved = store.pairings
        store.failWrites = true
        assertFailsWith<IllegalStateException> { connection.pair(payload("other.local")) }
        assertSame(previous, connection.apiOrNull())
        assertEquals(saved, store.pairings)
        assertEquals("http://mac.local:4317", store.boundOrigin())
        assertNull(store.tokenFor("http://other.local:4317"))
    }

    @Test
    fun `switches serialize validation and commit even while the first server is slow`() = runTest {
        val store = MemoryTokenStore(OLD_TOKEN, "http://mac.local:4317", "http://mac.local:4317")
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val connection = connectionFor(store, bootstrap = { request ->
            if (request.url.host == "other.local") {
                entered.complete(Unit)
                release.await()
            }
            HttpStatusCode.OK
        })
        connection.restore()
        connection.pair(payload("other.local"))
        connection.connectAndRemember("http://mac.local:4317")
        val previous = connection.requireApi()

        val first = async { connection.switchServer("http://other.local:4317") }
        entered.await()
        val second = async(start = CoroutineStart.UNDISPATCHED) { connection.switchServer("http://mac.local:4317") }
        assertSame(previous, connection.apiOrNull())
        assertEquals("http://mac.local:4317", store.boundOrigin())
        assertEquals(listOf("other.local"), seen.filter { it.url.encodedPath == "/api/bootstrap" }.map { it.url.host })

        release.complete(Unit)
        first.await()
        val final = second.await()
        assertSame(final, connection.apiOrNull())
        assertEquals("http://mac.local:4317", store.boundOrigin())
        assertEquals(listOf("other.local", "mac.local"), seen.filter { it.url.encodedPath == "/api/bootstrap" }.map { it.url.host })
        assertEquals(2, connection.pairedServers().size)
    }

    @Test
    fun `a timed out service switch preserves the current connection and selection`() = runTest {
        val store = MemoryTokenStore(OLD_TOKEN, "http://mac.local:4317", "http://mac.local:4317")
        val blocked = CompletableDeferred<Unit>()
        val connection = connectionFor(store, bootstrap = {
            blocked.await()
            HttpStatusCode.OK
        })
        connection.restore()
        connection.pair(payload("other.local"))
        val previous = connection.connectAndRemember("http://mac.local:4317")
        val saved = store.pairings

        assertFailsWith<RiffetNetworkException> { connection.switchServer("http://other.local:4317") }

        assertSame(previous, connection.apiOrNull())
        assertEquals(saved, store.pairings)
        assertEquals("http://mac.local:4317", store.boundOrigin())
        assertEquals(2, connection.pairedServers().size)
    }

    @Test
    fun `a timed out pairing retains the previous credential and connection`() = runTest {
        val store = MemoryTokenStore(OLD_TOKEN, "http://mac.local:4317", "http://mac.local:4317")
        val blocked = CompletableDeferred<Unit>()
        val connection = connectionFor(store, pairing = { blocked.await() })
        val previous = connection.restore()
        val saved = store.pairings

        assertFailsWith<RiffetNetworkException> { connection.pair(payload("other.local")) }

        assertSame(previous, connection.apiOrNull())
        assertEquals(saved, store.pairings)
        assertEquals(OLD_TOKEN, store.tokenFor("http://mac.local:4317"))
        assertNull(store.tokenFor("http://other.local:4317"))
    }

    @Test
    fun `forgetting the saved service does not disconnect an unknown runtime override`() = runTest {
        val store = MemoryTokenStore(OLD_TOKEN, "http://mac.local:4317", "http://mac.local:4317")
        val connection = connectionFor(store)
        val override = connection.connectAndRemember("http://other.local:4317")

        assertFalse(connection.forgetServer("http://mac.local:4317"))

        assertSame(override, connection.apiOrNull())
        assertEquals("http://other.local:4317", connection.baseUrl)
        override.sessions()
        assertNull(seen.single().authorization())
        assertTrue(connection.pairedServers().isEmpty())
        assertNull(connectionFor(store).restore())
    }

    @Test
    fun `origins compare scheme, host and port`() {
        assertEquals("http://mac.local:80", serverOrigin("http://MAC.local/"))
        assertEquals("https://mac.local:443", serverOrigin("https://mac.local/api/x"))
        assertEquals("http://10.0.0.2:4317", serverOrigin("ws://10.0.0.2:4317/api/terminals/t/ws"))
        assertEquals("https://mac.local:8443", serverOrigin("wss://mac.local:8443"))
        assertNull(serverOrigin("ftp://mac.local"))
        assertNull(serverOrigin("not a url"))
    }

    private companion object {
        const val OLD_TOKEN = "wkn_0123456789abcdef_old"
        const val NEW_TOKEN = "wkn_fedcba9876543210_new"
    }
}
