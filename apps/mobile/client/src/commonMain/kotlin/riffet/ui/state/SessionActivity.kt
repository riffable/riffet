package riffet.ui.state

import riffet.contracts.NativeInteraction
import riffet.contracts.Session
import riffet.contracts.SessionState
import riffet.core.TimelineItem
import riffet.core.isUnreceivedSteer
import riffet.core.toolView
import riffet.i18n.L10n
import riffet.ui.interaction.carriesSelection
import riffet.ui.interaction.interactionSelectsOptions

/** Why a conversation that is not on screen deserves the reader's attention. */
enum class SessionAlertKind { FINISHED, WAITING, FAILED, INTERRUPTED }

data class SessionAlert(val session: Session, val kind: SessionAlertKind)

/**
 * One read of the session list: every conversation as the server reports it, and the transitions
 * since the previous read that are worth telling the reader about.
 */
class SessionActivity(val sessions: List<Session>, val alerts: List<SessionAlert>)

/** A turn is under way, or the CLI is waiting on the reader in the middle of one. */
val SessionState.active: Boolean
    get() = this == SessionState.STARTING || this == SessionState.RUNNING ||
        this == SessionState.WAITING || this == SessionState.CANCELLING

/**
 * The web's `noticeBackground` (`Workbench.tsx`): a conversation is reported when its state *moved*
 * to one the reader acts on. A first sighting is not a transition, so a fresh process does not
 * announce everything that finished while it was gone.
 */
fun sessionAlerts(previous: Map<String, SessionState>, incoming: List<Session>): List<SessionAlert> {
    val alerts = mutableListOf<SessionAlert>()
    for (session in incoming) {
        val before = previous[session.id] ?: continue
        val state = session.state
        if (before == state || session.archivedAt != null) continue
        val wasRunning = before == SessionState.RUNNING || before == SessionState.STARTING ||
            before == SessionState.CANCELLING || before == SessionState.WAITING
        val kind = when {
            state == SessionState.WAITING -> SessionAlertKind.WAITING
            state == SessionState.FAILED -> SessionAlertKind.FAILED
            state == SessionState.INTERRUPTED && wasRunning -> SessionAlertKind.INTERRUPTED
            state == SessionState.IDLE && wasRunning -> SessionAlertKind.FINISHED
            else -> null
        } ?: continue
        alerts += SessionAlert(session, kind)
    }
    return alerts
}

/** One button a notification can offer for a dialog; pressing it is [SessionStore.respondFor]. */
data class InteractionChoice(val label: String, val action: String, val selectedIds: List<String>? = null)

/**
 * The dialog's answers as at most [limit] buttons, or none when buttons cannot answer it honestly:
 * a multi-select, a free-text question, or more choices than fit, all of which need the card.
 *
 * An interaction that submits a selection (a protocol question, or DSH's plan review whose options
 * are `Approve` / `Keep planning`) only becomes buttons one option at a time, because the answer
 * carries the chosen id. Offering its `submit` action directly — as this used to — posted an empty
 * selection, which is exactly the answer this work exists to stop sending.
 */
fun interactionChoices(interaction: NativeInteraction, limit: Int = 3): List<InteractionChoice> {
    if (interactionSelectsOptions(interaction)) {
        if (interaction.multiple == true) return emptyList()
        val submit = interaction.actions.firstOrNull { carriesSelection(interaction, it.id) } ?: return emptyList()
        if (interaction.options.isEmpty() || interaction.options.size > limit) return emptyList()
        return interaction.options.map { InteractionChoice(it.label, submit.id, listOf(it.id)) }
    }
    if (interaction.actions.isEmpty() || interaction.actions.size > limit) return emptyList()
    // Notification buttons have nowhere to show the scope of a persistent grant. Keep the
    // complete decision in the card instead of offering a shortened, unreviewable permission.
    if (interaction.actions.any { !it.detail.isNullOrBlank() }) return emptyList()
    return interaction.actions.map { InteractionChoice(it.shortLabel ?: it.label, it.id) }
}

/** The last thing the agent said, as one line of plain text for a notification. */
fun latestReply(timeline: List<TimelineItem>): String? {
    val text = timeline.lastOrNull { it is TimelineItem.Assistant && it.text.isNotBlank() } as? TimelineItem.Assistant
    return text?.text?.let(::plainSummary)
}

/** What a running turn is doing right now, for the progress notification. */
fun currentStep(timeline: List<TimelineItem>): String? {
    for (index in timeline.indices.reversed()) {
        when (val item = timeline[index]) {
            is TimelineItem.Tool -> return toolView(item.event.base).title.takeIf { it.isNotBlank() }?.let(::plainSummary)
            is TimelineItem.Thought -> return L10n.uiText("session.currentStep.thinking")
            is TimelineItem.Assistant -> return L10n.uiText("session.currentStep.replying")
            is TimelineItem.User -> if (!isUnreceivedSteer(item)) return null
            else -> Unit
        }
    }
    return null
}

private val summaryFences = Regex("```[\\s\\S]*?(```|$)")
private val summaryLinks = Regex("!?\\[([^\\]]*)]\\([^)]*\\)")
private val summaryMarks = Regex("[`*_#>|~]+")
private val summarySpaces = Regex("\\s+")

/** Markdown reduced to a single readable line: no fences, emphasis, links or line breaks. */
fun plainSummary(markdown: String, limit: Int = 280): String {
    val text = markdown
        .replace(summaryFences, " ")
        .replace(summaryLinks, "$1")
        .replace(summaryMarks, "")
        .replace(summarySpaces, " ")
        .trim()
    return if (text.length > limit) text.take(limit - 1).trimEnd() + "…" else text
}
