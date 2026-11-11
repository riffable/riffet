package riffet.ui.state

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import riffet.contracts.NativeInteraction
import riffet.contracts.NativeInteractionAction
import riffet.contracts.NativeInteractionKind
import riffet.contracts.NativeInteractionOption
import riffet.contracts.Session
import riffet.contracts.SessionKind
import riffet.contracts.SessionState
import riffet.contracts.WorkbenchEvent

class SessionActivityTest {

    @Test
    fun `only a move into a state the reader acts on is reported`() {
        val previous = mapOf(
            "done" to SessionState.RUNNING,
            "asks" to SessionState.RUNNING,
            "broke" to SessionState.RUNNING,
            "stopped" to SessionState.CANCELLING,
            "answered" to SessionState.WAITING,
            "resumed" to SessionState.WAITING,
            "still" to SessionState.RUNNING,
            "archived" to SessionState.RUNNING,
            "idleAgain" to SessionState.IDLE,
        )
        val incoming = listOf(
            session("done", SessionState.IDLE),
            session("asks", SessionState.WAITING),
            session("broke", SessionState.FAILED),
            session("stopped", SessionState.INTERRUPTED),
            session("answered", SessionState.IDLE),
            session("resumed", SessionState.RUNNING),
            session("still", SessionState.RUNNING),
            session("archived", SessionState.IDLE, archived = true),
            session("idleAgain", SessionState.INTERRUPTED),
            session("new", SessionState.WAITING),
        )
        val alerts = sessionAlerts(previous, incoming).associate { it.session.id to it.kind }
        assertEquals(
            mapOf(
                "done" to SessionAlertKind.FINISHED,
                "asks" to SessionAlertKind.WAITING,
                "broke" to SessionAlertKind.FAILED,
                "stopped" to SessionAlertKind.INTERRUPTED,
                "answered" to SessionAlertKind.FINISHED,
            ),
            alerts,
        )
    }

    @Test
    fun `a dialog becomes buttons only when buttons can answer it`() {
        val permission = interaction(
            NativeInteractionKind.PERMISSION,
            actions = listOf(NativeInteractionAction("allow", "允许"), NativeInteractionAction("deny", "拒绝")),
        )
        assertEquals(
            listOf(InteractionChoice("允许", "allow"), InteractionChoice("拒绝", "deny")),
            interactionChoices(permission),
        )

        val question = interaction(
            NativeInteractionKind.QUESTION,
            options = listOf(NativeInteractionOption("a", "方案 A", false), NativeInteractionOption("b", "方案 B", false)),
            actions = listOf(NativeInteractionAction("answer", "提交")),
        )
        assertEquals(
            listOf(InteractionChoice("方案 A", "answer", listOf("a")), InteractionChoice("方案 B", "answer", listOf("b"))),
            interactionChoices(question),
        )

        assertTrue(interactionChoices(question.copy(multiple = true)).isEmpty(), "a multi-select needs the card")
        val crowded = question.copy(options = (1..4).map { NativeInteractionOption("o$it", "选项 $it", false) })
        assertTrue(interactionChoices(crowded).isEmpty(), "a choice that does not fit is not offered in part")
        assertTrue(interactionChoices(question.copy(actions = emptyList())).isEmpty())

        // A protocol question submits with `submit`, and a plan review is one option per button: a
        // bare "Submit" button would answer with an empty selection.
        val protocolQuestion = interaction(
            NativeInteractionKind.QUESTION,
            options = listOf(NativeInteractionOption("a", "方案 A", false), NativeInteractionOption("b", "方案 B", false)),
            actions = listOf(NativeInteractionAction("submit", "Submit", "primary"), NativeInteractionAction("cancel", "Cancel", "danger")),
        )
        assertEquals(
            listOf(InteractionChoice("方案 A", "submit", listOf("a")), InteractionChoice("方案 B", "submit", listOf("b"))),
            interactionChoices(protocolQuestion),
        )

        val planReview = interaction(
            NativeInteractionKind.PLAN,
            options = listOf(NativeInteractionOption("option:0", "Approve", false), NativeInteractionOption("option:1", "Keep planning", false)),
            actions = listOf(NativeInteractionAction("submit", "Submit", "primary"), NativeInteractionAction("cancel", "Cancel", "danger")),
        )
        assertEquals(
            listOf(
                InteractionChoice("Approve", "submit", listOf("option:0")),
                InteractionChoice("Keep planning", "submit", listOf("option:1")),
            ),
            interactionChoices(planReview),
        )

        // Free text has no button that could carry it.
        val freeText = protocolQuestion.copy(allowOther = true, options = emptyList())
        assertTrue(interactionChoices(freeText).isEmpty(), "a free-text question needs the card")
    }

    private fun session(id: String, state: SessionState, archived: Boolean = false) = Session(
        id = id,
        projectId = "p",
        kind = SessionKind.NATIVE,
        title = id,
        tags = emptyList(),
        state = state,
        mode = "agent",
        archivedAt = if (archived) "2024-01-02T00:00:00.000Z" else null,
        createdAt = "2024-01-01T00:00:00.000Z",
        updatedAt = "2024-01-01T00:00:00.000Z",
    )

    private fun interaction(
        kind: NativeInteractionKind,
        options: List<NativeInteractionOption> = emptyList(),
        actions: List<NativeInteractionAction> = emptyList(),
    ) = NativeInteraction(id = "i", revision = "r", kind = kind, title = "?", options = options, actions = actions)
}
