package riffet.ui.composer

import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.staticCompositionLocalOf
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import riffet.contracts.Attachment
import riffet.contracts.RiffetJson
import riffet.shared.AppPreferences
import riffet.shared.PromptContextReference

@Serializable
private data class SavedComposerDraft(
    val text: String = "",
    val attachments: List<Attachment> = emptyList(),
    val references: List<PromptContextReference> = emptyList(),
)

internal class ComposerDraft {
    private var textRevision = 0L
    private val textValue = mutableStateOf("")
    val text: MutableState<String> = object : MutableState<String> by textValue {
        override var value: String
            get() = textValue.value
            set(value) { if (value != textValue.value) textRevision++; textValue.value = value }
    }
    val attachments = mutableStateOf<List<Attachment>>(emptyList())
    val references = mutableStateOf<List<PromptContextReference>>(emptyList())

    fun clearSubmitted(prompt: String, attachmentIds: Set<String>, context: List<PromptContextReference>, revision: Long = textRevision) {
        // A draft left with only blank lines (a return the keyboard committed around the send) is spent too.
        if ((textRevision == revision && text.value.trim() == prompt) || text.value.isBlank()) text.value = ""
        attachments.value = attachments.value.filterNot { it.id in attachmentIds }
        references.value = references.value.filterNot { it in context }
    }

    /** The host owns completion; a canceled screen only stops waiting for haptic feedback. */
    fun submit(
        scope: CoroutineScope,
        persist: () -> Unit,
        send: suspend (String, List<Attachment>, List<PromptContextReference>, () -> Unit) -> Boolean,
    ): Deferred<Boolean> {
        val revision = textRevision
        val prompt = text.value.trim()
        val sent = attachments.value.toList()
        val sentContext = references.value.toList()
        return scope.async(start = CoroutineStart.UNDISPATCHED) {
            var stored = false
            val accepted = send(prompt, sent, sentContext) {
                clearSubmitted(prompt, sent.mapTo(HashSet()) { it.id }, sentContext, revision)
                persist()
                stored = true
            }
            if (accepted) {
                if (!stored) clearSubmitted(prompt, sent.mapTo(HashSet()) { it.id }, sentContext, revision)
                persist()
            }
            accepted
        }
    }
}

/** The host retains this container across Activity recreation; each origin owns one child store. */
class ComposerDrafts private constructor(private val preferences: AppPreferences, private val prefix: String) {
    constructor(preferences: AppPreferences) : this(preferences, "")

    private val servers = mutableMapOf<String?, ComposerDrafts>()

    fun forServer(origin: String?): ComposerDrafts = servers.getOrPut(origin) {
        ComposerDrafts(preferences, "server:${origin.orEmpty()}:")
    }

    private val drafts = mutableMapOf<String, ComposerDraft>()
    private val saved = mutableMapOf<String, String?>()
    /** Deleted conversations: a composer still on screen saving on its way out writes nothing back. */
    private val forgotten = mutableSetOf<String>()

    /** A conversation deleted on the server: its draft goes, here and on the device. */
    fun forget(sessionId: String) {
        forgotten += sessionId
        drafts.remove(sessionId)
        saved.remove(sessionId)
        preferences.setString("${prefix}composer-draft:$sessionId", null)
    }

    internal fun draftFor(sessionId: String): ComposerDraft = drafts.getOrPut(sessionId) {
        val raw = preferences.string("${prefix}composer-draft:$sessionId")
        saved[sessionId] = raw
        val restored = raw?.let { runCatching { RiffetJson.instance.decodeFromString<SavedComposerDraft>(it) }.getOrNull() }
        ComposerDraft().apply {
            if (restored != null) {
                // Blank lines alone are no draft: one saved earlier held the dock open on an empty prompt.
                text.value = restored.text.takeIf { it.isNotBlank() }.orEmpty()
                attachments.value = restored.attachments
                references.value = restored.references
            }
        }
    }

    internal fun save(sessionId: String, draft: ComposerDraft) {
        if (sessionId in forgotten) return
        val value = SavedComposerDraft(draft.text.value.takeIf { it.isNotBlank() }.orEmpty(), draft.attachments.value, draft.references.value)
        val encoded = if (value == SavedComposerDraft()) null else RiffetJson.instance.encodeToString(value)
        if (saved[sessionId] != encoded) {
            preferences.setString("${prefix}composer-draft:$sessionId", encoded)
            saved[sessionId] = encoded
        }
    }
}

internal val LocalComposerDrafts = staticCompositionLocalOf<ComposerDrafts?> { null }
