package riffet.ui.interaction

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf

/**
 * The answer card's state ([InteractionCardState]: the draft and what was sent), shared by every
 * composition of an interaction.
 *
 * A card can leave composition while the reader opens another page or switches sessions. A phone
 * has no `sessionStorage` to fall back on (see the note at the top of `InteractionDraft.kt`), so
 * keeping its state here preserves the reader's text and an answer still awaiting its retry when
 * the conversation returns. This is the phone's equivalent of the web persisting the draft and the
 * submission per interaction.
 *
 * The app shell keeps one holder per server, and a server names each dialog it observes with a fresh
 * random token, so the interaction id alone cannot collide across its sessions. A few entries are
 * kept so that switching between sessions that each wait on a question does not lose either.
 */
class InteractionDrafts {
    private var cards by mutableStateOf<Map<String, InteractionCardState>>(emptyMap())

    /** The card stored for [interactionId], or null when this is its first composition. */
    fun cardFor(interactionId: String): InteractionCardState? = cards[interactionId]

    fun publish(interactionId: String, state: InteractionCardState) {
        if (cards[interactionId] == state) return
        // Re-inserted last, so the oldest card is the one that goes.
        cards = (cards - interactionId + (interactionId to state)).entries.toList().takeLast(KEPT).associate { it.key to it.value }
    }

    private companion object {
        const val KEPT = 8
    }
}

/**
 * Null outside the app shell (a preview, a test), where a card keeps its own state.
 */
internal val LocalInteractionDrafts = staticCompositionLocalOf<InteractionDrafts?> { null }
