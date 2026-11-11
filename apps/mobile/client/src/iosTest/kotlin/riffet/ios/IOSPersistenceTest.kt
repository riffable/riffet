package riffet.ios

import kotlinx.coroutines.test.runTest
import platform.Foundation.NSTemporaryDirectory
import platform.Foundation.NSUUID
import riffet.cache.DirectoryLocalFiles
import riffet.shared.NativeMessageInput
import riffet.ui.composer.OutboxEntry
import riffet.ui.composer.createIosOutboxStore
import riffet.shared.IosKeychainTokenStore
import riffet.shared.createAppPreferences
import riffet.shared.tokenFor
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertFailsWith

class IOSPersistenceTest {
    @kotlin.test.Ignore // Requires hosted Keychain environment: standalone test.kexe receives errSecNotAvailable (-25291).
    @Test fun keychainCredentialSurvivesNewStoreAndStaysOriginBound() = runTest {
        val service = "io.github.riffetai.ios-tests.${NSUUID().UUIDString}"
        val first = IosKeychainTokenStore(service)
        try {
            first.save("test-token", "http://mac.local:8080")
            first.saveServer("http://mac.local:8080")
            val restored = IosKeychainTokenStore(service)
            assertEquals("test-token", restored.tokenFor("http://mac.local:8080/api/sessions"))
            assertNull(restored.tokenFor("http://other.local:8080/api/sessions"))
            assertEquals("http://mac.local:8080", restored.loadServer())
            restored.clear()
            assertNull(first.load())
            assertNull(first.loadServer())
        } finally { first.clear() }
    }

    @Test fun atomicFilesSurviveNewInstanceAndRejectParentPaths() {
        val root = "${NSTemporaryDirectory()}/riffet-tests-${NSUUID().UUIDString}"
        val first = DirectoryLocalFiles(root)
        try {
            first.write("transcript/one.log", "你好")
            first.append("transcript/one.log", "\nrestored")
            assertEquals("你好\nrestored", DirectoryLocalFiles(root).read("transcript/one.log"))
            assertEquals(listOf("one.log"), first.list("transcript"))
            assertFailsWith<IllegalArgumentException> { first.write("../outside", "denied") }
        } finally { first.deleteTree(".") }
    }

    @Test fun outboxRestoresTheExactCommandAndStaysServerScoped() {
        val server = "http://test-${NSUUID().UUIDString}.local:8080"
        val entry = OutboxEntry("session", NativeMessageInput(commandId = "original-command", text = "send once"), "2026-10-15T08:00:00Z")
        val first = createIosOutboxStore(server)
        try {
            first.save(entry)
            assertEquals(listOf(entry), createIosOutboxStore(server).list("session"))
            assertEquals(emptyList(), createIosOutboxStore("$server-other").list("session"))
            first.remove("session", "original-command")
            assertEquals(emptyList(), createIosOutboxStore(server).list("session"))
        } finally { first.remove("session", "original-command") }
    }

    @Test fun preferencesSurviveNewInstance() {
        val key = "test-${NSUUID().UUIDString}"
        val first = createAppPreferences()
        try {
            first.setString(key, "draft")
            assertEquals("draft", createAppPreferences().string(key))
        } finally { first.setString(key, null) }
    }
}
