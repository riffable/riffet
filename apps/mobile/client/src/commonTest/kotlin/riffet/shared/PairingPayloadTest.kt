package riffet.shared

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs

class PairingPayloadTest {

    @Test
    fun parsesTheServerPayloadAndBuildsAPlainHttpBaseUrl() {
        val payload = PairingPayload.parse(
            """{"v":1,"host":"macbook.local","port":4310,"code":"7KQ2M4ZP","name":"MacBook Pro"}""",
        )

        assertEquals(1, payload.v)
        assertEquals("macbook.local", payload.host)
        assertEquals(4310, payload.port)
        assertEquals("7KQ2M4ZP", payload.code)
        assertEquals("MacBook Pro", payload.name)
        assertEquals("http://macbook.local:4310", payload.baseUrl)
    }

    @Test
    fun everyListedAddressIsACandidateWithTheHostFirst() {
        val payload = PairingPayload.parse(
            """{"v":1,"host":"10.0.0.2","hosts":["10.0.0.2","192.168.1.2","mac.local","evil/path","x@y"],"port":4337,"code":"7KQ2M4ZP"}""",
        )
        assertEquals(listOf("http://10.0.0.2:4337", "http://192.168.1.2:4337", "http://mac.local:4337"), payload.baseUrls)
        assertEquals(listOf("http://macbook.local:4310"), PairingPayload.parse("""{"v":1,"host":"macbook.local","port":4310,"code":"7KQ2M4ZP"}""").baseUrls)
    }

    @Test
    fun unknownVersionIsATypedFailureNotACrash() {
        val error = assertFailsWith<PairingPayloadException> {
            PairingPayload.parse("""{"v":2,"host":"macbook.local","port":4310,"code":"ABCDEFGH"}""")
        }

        assertIs<PairingPayloadException.UnknownVersion>(error)
        assertEquals(2, error.version)
    }

    @Test
    fun anHttpsFrontDoorSurvivesButNothingElseDoes() {
        val secure = PairingPayload.parse(
            """{"v":1,"scheme":"https","host":"mac.tailnet.ts.net","port":443,"code":"7KQ2M4ZP"}""",
        )
        assertEquals("https", secure.scheme)
        assertEquals("https://mac.tailnet.ts.net:443", secure.baseUrl)

        // Only the two schemes are ever accepted, so a hostile value cannot be spliced into the URL.
        val nonsense = PairingPayload.parse(
            """{"v":1,"scheme":"file","host":"mac.local","port":4310,"code":"7KQ2M4ZP"}""",
        )
        assertEquals("http", nonsense.scheme)
        assertEquals("http://mac.local:4310", nonsense.baseUrl)
    }

}
