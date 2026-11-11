package riffet.shared

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import riffet.contracts.RiffetJson
import java.security.MessageDigest
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ServerRoutesTest {
    private val jsonHeaders = headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString())
    private val token = "wkn_0123456789abcdef_c2VjcmV0LXRoYXQtbXVzdC1zdGF5"

    @AfterTest
    fun reset() = ServerRoutes.replace(emptyMap())

    /** What `Auth.proveDevice` answers: HMAC-SHA256 keyed by the stored hash, base64url(sha256(token)). */
    private fun serverProof(token: String, nonce: String): String {
        val url = Base64.getUrlEncoder().withoutPadding()
        val key = url.encodeToString(MessageDigest.getInstance("SHA-256").digest(token.toByteArray()))
        val mac = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(key.toByteArray(), "HmacSHA256")) }
        return url.encodeToString(mac.doFinal(nonce.toByteArray()))
    }

    @Test
    fun aCandidateProvesItHoldsTheRecordWithoutTheTokenBeingSent() = runTest {
        val bodies = mutableListOf<String>()
        var holder = token
        val client = HttpClient(MockEngine { request ->
            val body = (request.body as TextContent).text
            bodies += body
            val fields = RiffetJson.instance.parseToJsonElement(body).jsonObject
            assertEquals("0123456789abcdef", fields["device"]?.jsonPrimitive?.content)
            respond("""{"proof":"${serverProof(holder, fields["nonce"]!!.jsonPrimitive.content)}"}""", HttpStatusCode.OK, jsonHeaders)
        }) { installRiffetClient() }
        assertTrue(client.provesDevice("http://192.168.1.229:4337", token))
        holder = "wkn_0123456789abcdef_another-record"
        assertFalse(client.provesDevice("http://192.168.1.229:4337", token))
        assertTrue(bodies.none { "c2VjcmV0" in it })
        client.close()
    }

    @Test
    fun requestsForAPairedOriginGoToItsRouteUnlessDirect() = runTest {
        val seen = mutableListOf<HttpRequestData>()
        val client = HttpClient(MockEngine { request ->
            seen += request
            respond("""{"proof":"x"}""", HttpStatusCode.OK, jsonHeaders)
        }) { installRiffetClient() }
        ServerRoutes.replace(mapOf("http://10.0.0.5:4337" to "http://192.168.1.229:4337"))
        val api = RiffetApi(client, "http://10.0.0.5:4337", tokenProvider = { token })
        api.get("/api/sessions")
        client.provesDevice("http://10.0.0.5:4337", token)
        assertEquals("http://192.168.1.229:4337/api/sessions", seen[0].url.toString())
        assertEquals("Bearer $token", seen[0].headers[HttpHeaders.Authorization])
        assertEquals("10.0.0.5", seen[1].url.host)
        client.close()
    }
}
