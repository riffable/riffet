package riffet.ui.assistant

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import riffet.contracts.AssistantDelegation
import riffet.contracts.AssistantInstructions
import riffet.contracts.AssistantMemory
import riffet.contracts.AssistantPack
import riffet.shared.RiffetApi
import riffet.shared.assistantDelegations
import riffet.shared.assistantInstructions
import riffet.shared.assistantMemory
import riffet.shared.assistantPacks
import riffet.shared.addAssistantPack
import riffet.shared.removeAssistantPack
import riffet.shared.endAssistantDelegation
import riffet.shared.saveAssistantInstructions

/** Memory, rules and delegations as the sheets and rows read them; one per server, read when first needed. */
@Stable
internal class AssistantSetup(private val api: RiffetApi?, private val scope: CoroutineScope) {
    var instructions by mutableStateOf<AssistantInstructions?>(null)
        private set
    var memory by mutableStateOf<AssistantMemory?>(null)
        private set
    var memoryFailed by mutableStateOf(false)
        private set
    var delegations by mutableStateOf<List<AssistantDelegation>?>(null)
        private set
    /** The capability packs (docs/ASSISTANT.md §8.2); the installed ones with an entry show above the composer. */
    var packs by mutableStateOf<List<AssistantPack>?>(null)
        private set
    private var loaded = false

    /** Reads the three once; the sheets call [refresh] when they open. */
    fun load() {
        if (loaded) return
        loaded = true
        refresh()
    }

    fun refresh() {
        val client = api ?: return
        scope.launch { runCatching { client.assistantInstructions() }.onSuccess { instructions = it } }
        scope.launch {
            runCatching { client.assistantMemory() }
                .onSuccess { memory = it; memoryFailed = false }
                .onFailure { if (it is CancellationException) throw it else memoryFailed = true }
        }
        scope.launch { runCatching { client.assistantDelegations() }.onSuccess { delegations = it } }
    }

    fun loadPacks() {
        val client = api ?: return
        scope.launch { runCatching { client.assistantPacks() }.onSuccess { packs = it } }
    }

    /** Adds or removes a pack; throws what the server says. */
    suspend fun setPack(id: String, on: Boolean) {
        val client = api ?: return
        packs = if (on) client.addAssistantPack(id) else client.removeAssistantPack(id)
    }

    /** Saves the rules, or restores the default for a null [text]; throws what the server says. */
    suspend fun saveInstructions(text: String?) {
        val client = api ?: return
        instructions = client.saveAssistantInstructions(text)
    }

    suspend fun end(id: String) {
        val client = api ?: return
        val ended = client.endAssistantDelegation(id)
        delegations = delegations?.map { if (it.id == id) ended else it }
    }
}
