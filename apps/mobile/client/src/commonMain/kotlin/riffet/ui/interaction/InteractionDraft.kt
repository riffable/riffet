package riffet.ui.interaction

import riffet.contracts.NativeInteraction
import riffet.contracts.NativeInteractionKind

/*
 * A port of `apps/web/src/app/session/nativeInteractionDraft.ts`.
 *
 * The draft is what the user has chosen but not yet submitted. It is keyed by `revision`, because
 * the CLI redraws the dialog constantly (a spinner tick changes it) and a draft from an older
 * revision must never be posted against a newer question. The web also persists it in
 * `sessionStorage`; this build keeps it in composition state, since the store's platform seam
 * budget is spent on the send outbox, which is the one that protects a real message.
 */

/** Selected option ids and free text for one interaction revision. */
data class InteractionDraft(
    val revision: String,
    val selectedIds: List<String>,
    val otherText: String,
)

/**
 * The CLI's current answer expressed as a draft. A single-select interaction whose "Other" row is
 * active carries its `otherValue` instead of a selection; a multi-select keeps both.
 */
fun snapshotInteractionDraft(interaction: NativeInteraction): InteractionDraft {
    val selected = interaction.options.filter { it.selected }.map { it.id }
    val otherSelected = interaction.otherSelected == true
    return InteractionDraft(
        revision = interaction.revision,
        selectedIds = when {
            interaction.multiple == true -> selected
            otherSelected -> emptyList()
            else -> selected.take(1)
        },
        otherText = if (otherSelected) interaction.otherValue.orEmpty() else "",
    )
}

/**
 * The server refuses control characters in `otherText` (`NativeInteractions.respond` validates
 * `\\x00-\\x1f` away and caps the length at 2000), so they are dropped here rather than submitted
 * and bounced back.
 */
fun sanitizeOtherText(value: String): String =
    value.filterNot { it.code < 0x20 || it.code in 0x7f..0x9f }.take(2000)

/** `Other` text cannot be cleared once the CLI has it selected in a multi-select, per the server. */
fun otherTextLocked(interaction: NativeInteraction): Boolean =
    interaction.multiple == true && interaction.otherSelected == true

/**
 * Whether the phone can render this surface at all. Anything that fails this test is shown as an
 * honest "answer in the terminal" card rather than a half-drawn set of controls, because pressing
 * the wrong control writes real keys into a real CLI.
 */
fun isInteractionRenderable(interaction: NativeInteraction): Boolean {
    if (interaction.kind == NativeInteractionKind.QUESTION) {
        // A protocol question submits with `submit` (DSH) and the terminal one with `answer` (Cursor);
        // both are renderable here, but only when there is something to answer.
        val hasSubmit = interaction.actions.any { it.id == "answer" || it.id == "submit" }
        return hasSubmit && (interaction.options.isNotEmpty() || interaction.allowOther == true)
    }
    return interaction.actions.isNotEmpty()
}

/** The two actions that carry a selection; every other action is a plain keystroke. */
private val SELECTING_ACTIONS = setOf("answer", "submit")

/**
 * Whether this interaction selects before submitting. A question does, and so does the plan review
 * DSH sends — `options: [Approve, Keep planning]` with one `submit` action and no `answer` — whose
 * answer has to name the chosen option, or the CLI receives an empty selection and the model's
 * blocked `exit_plan_mode` never returns. A question with no options at all still selects: its
 * answer is the free-text field.
 *
 * A dialog lifted from a CLI's own screen is deliberately *not* selecting: its rows are pressed as
 * `option:*` actions, which is what moves the CLI's own focus and key.
 */
fun interactionSelectsOptions(interaction: NativeInteraction): Boolean {
    val hasSomethingToAnswer = interaction.options.isNotEmpty() || interaction.allowOther == true
    return hasSomethingToAnswer && interaction.actions.any { it.id in SELECTING_ACTIONS }
}

/** Whether this action submits the draft's selection rather than pressing a key. */
fun carriesSelection(interaction: NativeInteraction, action: String): Boolean =
    action in SELECTING_ACTIONS && interactionSelectsOptions(interaction)
