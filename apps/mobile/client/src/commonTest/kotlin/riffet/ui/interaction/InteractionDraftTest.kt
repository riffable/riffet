package riffet.ui.interaction

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import riffet.contracts.NativeInteraction
import riffet.contracts.NativeInteractionAction
import riffet.contracts.NativeInteractionKind
import riffet.contracts.NativeInteractionOption

/**
 * The phone's half of `apps/web/src/app/session/nativeInteractionDraft.test.ts`: the same two
 * decisions, because both clients build the response the server's bridge turns into an answer.
 */
class InteractionDraftTest {
    private fun interaction(
        kind: NativeInteractionKind,
        options: List<NativeInteractionOption> = emptyList(),
        actions: List<NativeInteractionAction> = emptyList(),
        allowOther: Boolean? = null,
    ) = NativeInteraction(
        id = "i1",
        revision = "1",
        kind = kind,
        title = "Question",
        options = options,
        actions = actions,
        allowOther = allowOther,
    )

    private fun option(id: String, label: String, selected: Boolean = false) =
        NativeInteractionOption(id = id, label = label, selected = selected)

    /** The plan review DSH sends when the model calls `exit_plan_mode`. */
    private val planReview = interaction(
        kind = NativeInteractionKind.PLAN,
        options = listOf(option("option:0", "Approve"), option("option:1", "Keep planning")),
        actions = listOf(
            NativeInteractionAction(id = "submit", label = "Submit", tone = "primary"),
            NativeInteractionAction(id = "cancel", label = "Cancel", tone = "danger"),
        ),
    )

    /** A dialog lifted from a CLI's own screen: rows are pressed directly, not submitted. */
    private val liftedDialog = interaction(
        kind = NativeInteractionKind.CHOICE,
        options = listOf(option("option-0", "No, exit", selected = true), option("option-1", "Yes, I trust this folder")),
        actions = listOf(
            NativeInteractionAction(id = "option:option-0", label = "No, exit"),
            NativeInteractionAction(id = "option:option-1", label = "Yes, I trust this folder"),
        ),
    )

    @Test
    fun `only a submission carries the selection — and a plan review has no text field`() {
        assertTrue(carriesSelection(planReview, "submit"))
        assertFalse(carriesSelection(planReview, "cancel"))
        assertFalse(carriesSelection(liftedDialog, "option:option-1"))
        assertNull(planReview.allowOther)
    }

    @Test
    fun `free text is sanitized before it is posted`() {
        assertEquals("ab", sanitizeOtherText("a\u0000b"))
    }

}
