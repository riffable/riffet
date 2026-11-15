package riffet.ui.composer

import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import riffet.contracts.Attachment
import riffet.shared.AppPreferences
import riffet.shared.PromptContextReference
import riffet.shared.ThemeMode
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertSame
import kotlin.test.assertTrue

class ComposerDraftsTest {
    @Test
    fun acceptedSendClearsSharedAndPersistedDraftAfterScreenWaitIsCanceled() = runTest {
        val preferences = MemoryPreferences()
        val host = ComposerDrafts(preferences)
        val source = host.forServer("http://a:4317")
        val draft = source.draftFor("session")
        draft.text.value = "send once"
        source.save("session", draft)
        val response = CompletableDeferred<Boolean>()
        var requests = 0
        val completion = draft.submit(this, { source.save("session", draft) }) { text, _, _, onStored ->
            requests++
            assertEquals("send once", text)
            onStored()
            response.await()
        }
        // A cold host while the HTTP request is still pending must not restore a second draft.
        assertEquals("", ComposerDrafts(preferences).forServer("http://a:4317").draftFor("session").text.value)
        val screen = launch(start = CoroutineStart.UNDISPATCHED) { completion.await() }
        screen.cancelAndJoin()
        assertSame(draft, host.forServer("http://a:4317").draftFor("session"))
        response.complete(true)
        assertTrue(completion.await())
        assertEquals(1, requests)
        assertEquals("", draft.text.value)
        assertEquals("", ComposerDrafts(preferences).forServer("http://a:4317").draftFor("session").text.value)
    }

    @Test
    fun blankDraftIsNeitherKeptNorRestored() {
        val preferences = MemoryPreferences()
        // A draft of only a newline, saved before blank drafts were dropped.
        preferences.setString("server:http://a:4317:composer-draft:session", "{\"text\":\"\\n\"}")
        val source = ComposerDrafts(preferences).forServer("http://a:4317")
        val draft = source.draftFor("session")
        assertEquals("", draft.text.value)
        draft.text.value = " \n "
        source.save("session", draft)
        assertEquals(null, preferences.string("server:http://a:4317:composer-draft:session"))
    }

    @Test
    fun lateAcceptancePreservesNewEditsAndDoesNotTouchAnotherServer() = runTest {
        val preferences = MemoryPreferences()
        val host = ComposerDrafts(preferences)
        val source = host.forServer("http://a:4317")
        val draft = source.draftFor("same-session")
        val sent = attachment("sent")
        val added = attachment("added")
        val sentReference = PromptContextReference("old.kt")
        val addedReference = PromptContextReference("new.kt")
        draft.text.value = "original"
        draft.attachments.value = listOf(sent)
        draft.references.value = listOf(sentReference)
        val response = CompletableDeferred<Boolean>()
        val completion = draft.submit(this, { source.save("same-session", draft) }) { _, attachments, references, onStored ->
            assertEquals(listOf(sent), attachments)
            assertEquals(listOf(sentReference), references)
            onStored()
            response.await()
        }
        // A new screen over the same host edits the retained source draft while its POST is pending.
        val reopened = host.forServer("http://a:4317").draftFor("same-session")
        reopened.text.value = "new message"
        reopened.text.value = "original" // A later draft may intentionally repeat the submitted text.
        reopened.attachments.value += added
        reopened.references.value += addedReference
        val other = host.forServer("http://b:4317")
        other.draftFor("same-session").text.value = "other server"
        other.save("same-session", other.draftFor("same-session"))
        response.complete(true)
        assertTrue(completion.await())
        val restored = ComposerDrafts(preferences).forServer("http://a:4317").draftFor("same-session")
        assertEquals("original", restored.text.value)
        assertEquals(listOf(added), restored.attachments.value)
        assertEquals(listOf(addedReference), restored.references.value)
        assertEquals("other server", other.draftFor("same-session").text.value)
    }

    private fun attachment(id: String) = Attachment(id, id, "text/plain", 1, "/$id")

    private class MemoryPreferences : AppPreferences {
        private val values = mutableMapOf<String, String>()
        override fun themeMode() = ThemeMode.SYSTEM
        override fun setThemeMode(mode: ThemeMode) = Unit
        override fun string(key: String): String? = values[key]
        override fun setString(key: String, value: String?) {
            if (value == null) values.remove(key) else values[key] = value
        }
    }
}
