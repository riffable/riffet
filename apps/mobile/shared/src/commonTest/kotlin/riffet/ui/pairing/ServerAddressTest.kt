package riffet.ui.pairing

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * One focused test for the pairing screen's non-UI logic — [normalizeServerAddress] and the pairing
 * code helpers. Everything accepted and rejected here is a rule, and a regression silently points
 * the app at the wrong host/port or accepts a code the server can never have issued.
 *
 * The screen itself is deliberately untested (the owner asked to stop writing broad suites).
 */
class ServerAddressTest {

    @Test
    fun normalizesTypedInput() {
        // Bare host and mDNS name fall back to the default port.
        assertEquals(ServerAddress("192.168.1.10", 4337), normalizeServerAddress("192.168.1.10"))
        assertEquals(ServerAddress("mac.local", 4337), normalizeServerAddress("  mac.local  "))

        // An explicit port always wins over the default.
        assertEquals(ServerAddress("192.168.1.10", 8080), normalizeServerAddress("192.168.1.10:8080"))
        assertEquals(ServerAddress("mac.local", 9000), normalizeServerAddress("mac.local:9000"))

        // A full base URL is accepted; path/query/fragment are dropped. The scheme is KEPT, because
        // `https://` is how a person says "there is a TLS front door in front of this server".
        assertEquals(ServerAddress("192.168.1.10", 4337), normalizeServerAddress("http://192.168.1.10:4337"))
        assertEquals(ServerAddress("mac.local", 4337), normalizeServerAddress("http://mac.local:4337/"))
        assertEquals(ServerAddress("mac.local", 4337, "https"), normalizeServerAddress("HTTPS://mac.local:4337/api?x=1#f"))
        assertEquals("https://mac.local:4337", normalizeServerAddress("https://mac.local:4337")?.baseUrl)
        // `https://host` with no port is a TLS front door on 443, not the plain-HTTP default.
        assertEquals(ServerAddress("mac.tailnet.ts.net", 443, "https"), normalizeServerAddress("https://mac.tailnet.ts.net"))
        // A bare address stays plain HTTP: nothing was said about TLS.
        assertEquals("http://mac.local:4337", normalizeServerAddress("mac.local")?.baseUrl)

        // Hostnames are case-insensitive.
        assertEquals(ServerAddress("macbook.local", 4337), normalizeServerAddress("MacBook.LOCAL"))

        // IPv6 must be bracketed, and the brackets survive into the base URL.
        assertEquals("http://[fe80::1]:4337", normalizeServerAddress("[fe80::1]:4337")?.baseUrl)
        assertEquals(ServerAddress("[fe80::1]", 4337), normalizeServerAddress("[fe80::1]"))

        // Rejected: empty, a bare unbracketed IPv6 (ambiguous), a malformed port, a port out of range.
        assertNull(normalizeServerAddress(""))
        assertNull(normalizeServerAddress("   "))
        assertNull(normalizeServerAddress("fe80::1:4337"))
        assertNull(normalizeServerAddress("mac.local:abc"))
        assertNull(normalizeServerAddress("mac.local:0"))
        assertNull(normalizeServerAddress("mac.local:70000"))
        assertNull(normalizeServerAddress("http://"))

        // Pairing codes are case- and whitespace-tolerant, and checked against the server's alphabet.
        assertEquals("7KQ2M4ZP", normalizePairingCode(" 7kq2m4zp\n"))
        assertTrue(isPlausiblePairingCode("7kq2m4zp"))
        // I, L, O and U are not in the server's alphabet, so a code containing them is a typo.
        assertTrue(!isPlausiblePairingCode("O1234567"))
        assertTrue(!isPlausiblePairingCode("7KQ2M4Z"))
    }
}
