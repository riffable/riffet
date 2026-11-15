// `:client` has an `InteractionCard.kt` in this package too (the state machine); one facade per file.
@file:JvmName("InteractionCardViewKt")

package riffet.ui.interaction

import riffet.ui.design.LocalRiffetSurfaces
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.interaction.MutableInteractionSource
import riffet.ui.design.LocalInterfaceStyle
import androidx.compose.foundation.LocalIndication
import riffet.ui.theme.LocalRiffetMotion
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.selectable
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.draw.alpha
import riffet.ui.design.RiffetProgressIndicator as CircularProgressIndicator
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import riffet.ui.design.RiffetCheckbox as Checkbox
import riffet.ui.icons.Icon
import riffet.ui.design.RiffetRadioButton as RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlin.jvm.JvmName
import org.jetbrains.compose.resources.getString
import org.jetbrains.compose.resources.stringResource
import riffet.contracts.NativeInteraction
import riffet.ui.focus.keepsFocusOnTap
import riffet.ui.focus.SelectableText
import riffet.ui.pickers.PickerOverlay
import riffet.ui.timeline.MarkdownBody
import riffet.contracts.NativeInteractionAction
import riffet.contracts.NativeInteractionKind
import riffet.contracts.NativeInteractionResponse
import riffet.contracts.NativeInteractionResult
import riffet.shared.RiffetHttpException
import riffet.ui.composer.newClientId
import riffet.ui.icons.RiffetIcons
import riffet.ui.platform.ApprovalVerification
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet_mobile.shared.generated.resources.*

/*
 * A port of `apps/web/src/app/session/NativeInteractionCard.tsx`, adapted to a phone.
 *
 * Two rules from the web are kept exactly because breaking either writes real keystrokes into a
 * real CLI:
 *
 *  - a submitted request is frozen. While it is posting or its result is unknown/uncertain the card
 *    keeps rendering *that* interaction and *that* request, and "重试" re-sends the identical
 *    `requestId`. The server keys idempotency on `sessionId:requestId` and rejects a reused key with
 *    a different payload, so a retry can never answer a different question.
 *  - `advanced` with the same interaction id and revision is treated as uncertain, not success: the
 *    CLI redrew the same dialog, which is not evidence that the answer landed.
 *
 * The phone difference is the layout: everything is a full-width touch row, `Other` is a plain
 * multi-line-capable field, and each question of a multi-question set is a page whose "下一题" / "提交"
 * button comes straight from the server's own `answer` action.
 */

@Composable
fun InteractionCard(
    interaction: NativeInteraction,
    connected: Boolean,
    onRespond: suspend (NativeInteractionResponse) -> NativeInteractionResult,
    onSync: suspend () -> NativeInteraction?,
    modifier: Modifier = Modifier,
) {
    val designMetrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val scope = rememberCoroutineScope()

    if (!isInteractionRenderable(interaction)) {
        TerminalFallbackCard(interaction, modifier)
        return
    }

    // The state is the shared machine's (`riffet.ui.interaction.InteractionCardState` in `:client`); this
    // card only renders it and performs the requests it asks for. `LocalInteractionDrafts` keeps the
    // question's draft and submission across navigation and session switches. A transition always
    // starts from what the slot holds now, never from a value captured earlier, so a result landing
    // late cannot undo what happened meanwhile.
    val sharedCards = LocalInteractionDrafts.current
    var ownCard by remember(interaction.id) {
        mutableStateOf(sharedCards?.cardFor(interaction.id)?.interactionChanged(interaction) ?: restoreInteractionCard(interaction))
    }
    fun update(transition: (InteractionCardState) -> InteractionCardState?): InteractionCardState? {
        val next = transition(sharedCards?.cardFor(interaction.id) ?: ownCard) ?: return null
        ownCard = next
        sharedCards?.publish(interaction.id, next)
        return next
    }
    // Every value the server sends goes through the machine, which decides whether it applies now or
    // waits behind an answer that is still out. Derived here as well so the frame never lags it.
    val state = (sharedCards?.cardFor(interaction.id) ?: ownCard).interactionChanged(interaction)
    LaunchedEffect(interaction) { update { it.interactionChanged(interaction) } }

    // 确认操作前验证本人 (`ApprovalVerification`): nothing is sent while the system prompt is up, so
    // this is the card's own state, not the shared machine's.
    var verifying by remember(interaction.id) { mutableStateOf(false) }
    var verifyNotice by remember(interaction.id) { mutableStateOf<String?>(null) }
    val latest by rememberUpdatedState(interaction)
    val latestConnected by rememberUpdatedState(connected)

    val submission = state.submission
    val shown = state.shown
    val currentDraft = state.currentDraft
    val busy = state.busy || verifying
    val isQuestion = shown.kind == NativeInteractionKind.QUESTION
    /**
     * A question and a plan review both pick one of the options and submit them. They differ in where
     * the submit lives (`answer` versus a named `submit` action) and in what the text field means, so
     * the payload is built by `carriesSelection` and only the presentation branches on the kind.
     */
    val selectsOptions = interactionSelectsOptions(shown)
    val selected = currentDraft.selectedIds.toSet()
    val answerPresent = selected.isNotEmpty() || currentDraft.otherText.isNotBlank()

    /**
     * Posts what a transition asked for and feeds the outcome back. A card that goes away with the
     * answer out never hears back, so its request is UNKNOWN and is retried as the same request.
     */
    fun post(next: InteractionCardState?) {
        val sent = next?.submission ?: return
        val requestId = sent.request.requestId
        scope.launch {
            try {
                val result = onRespond(sent.request)
                update { it.responded(requestId, result.status, result.message) }
            } catch (cancellation: CancellationException) {
                update { it.failed(requestId, null) }
                throw cancellation
            } catch (cause: Throwable) {
                update { it.failed(requestId, (cause as? RiffetHttpException)?.status, cause.message) }
            }
        }
    }

    /**
     * Runs [send] at once, or after the owner passes the system prompt when the setting is on and
     * [kind] lets the Agent act. [asked] is the dialog on screen at the tap; if it moved meanwhile
     * nothing is sent, as on iPhone. A retry re-sends its frozen request and passes null.
     */
    fun verified(kind: NativeInteractionKind, asked: NativeInteraction?, send: () -> Unit) {
        verifyNotice = null
        if (!ApprovalVerification.required || !ApprovalVerification.guards(kind)) {
            send()
            return
        }
        if (verifying) return
        verifying = true
        scope.launch {
            val passed = try {
                ApprovalVerification.verify(kind, getString(Res.string.approval_verify_reason))
            } finally {
                verifying = false
            }
            when {
                !passed -> verifyNotice = getString(Res.string.approval_verify_failed)
                asked != null && (latest.id != asked.id || latest.revision != asked.revision) ->
                    verifyNotice = getString(Res.string.approval_verify_changed)
                latestConnected -> send()
            }
        }
    }

    fun submit(action: String) {
        val asked = shown
        if (!latestConnected) return
        verified(asked.kind, asked) {
            // A remembered action id can be offered by a later revision with a different scope.
            // Send only against the exact snapshot the reader saw, with or without device verification.
            if (latest.id != asked.id || latest.revision != asked.revision || latest.actions.none { it.id == action }) {
                scope.launch { verifyNotice = getString(Res.string.approval_verify_changed) }
            } else {
                post(update {
                    if (it.shown.id != asked.id || it.shown.revision != asked.revision) null
                    else it.submit(action, newClientId())
                })
            }
        }
    }

    fun retry() {
        if (!connected) return
        verified(shown.kind, null) { post(update { it.retry() }) }
    }

    fun sync() {
        update { if (it.syncing) null else it.syncStarted() } ?: return
        scope.launch {
            try {
                val fresh = onSync()
                update { it.synced(fresh) }
            } catch (cancellation: CancellationException) {
                // Abandoned with the card, not failed: the copy that stays must not be left syncing.
                update { it.copy(syncing = false) }
                throw cancellation
            } catch (cause: Throwable) {
                update { it.syncFailed(cause.message) }
            }
        }
    }

    fun changeOption(optionId: String) {
        update { it.interactionChanged(interaction).selectOption(optionId) }
    }

    // A single-choice question without free text is answered by the tap itself; multi-select and
    // free text keep their submit button.
    val answerAction = shown.actions.firstOrNull { carriesSelection(shown, it.id) }?.id
    val tapAnswers = isQuestion && shown.multiple != true && shown.allowOther != true && shown.options.isNotEmpty() && answerAction != null

    fun changeOther(value: String) {
        update { it.interactionChanged(interaction).changeOtherText(value) }
    }

    val questionIndex = shown.questionIndex
    val questionCount = shown.questionCount
    val lastQuestion = questionIndex != null && questionCount != null && questionIndex >= questionCount
    var showingApproval by remember(interaction.id) { mutableStateOf(false) }
    val approval = shown.kind == NativeInteractionKind.PERMISSION || shown.kind == NativeInteractionKind.PLAN ||
        shown.kind == NativeInteractionKind.CONFIRMATION || shown.kind == NativeInteractionKind.CHOICE
    if (approval) {
        ApprovalCard(
            shown = shown,
            state = state,
            connected = connected,
            busy = busy,
            verifyNotice = verifyNotice,
            showingDetails = showingApproval,
            onOpen = { showingApproval = true },
            onDismiss = { showingApproval = false },
            onSubmit = ::submit,
            onSelectOption = ::changeOption,
            onChangeOther = ::changeOther,
            onRetry = ::retry,
            onSync = ::sync,
            modifier = modifier,
        )
        return
    }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 8.dp)
            .background(LocalRiffetSurfaces.current.card, RoundedCornerShape(LocalInterfaceStyle.current.groupRadius))
            // Long questions keep the transcript and composer visible; only the reading
            // area scrolls, while submission and recovery controls stay outside it.
            .heightIn(max = 320.dp)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Column(Modifier.fillMaxWidth().weight(1f, fill = false).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = shown.title.ifBlank {
                        stringResource(if (isQuestion) Res.string.timeline_interaction_need_answer else Res.string.timeline_interaction_need_choice)
                    },
                    style = typography.label,
                    color = colors.fg,
                    maxLines = Int.MAX_VALUE,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (isQuestion && shown.questionCount != null) {
                    Text(
                        text = "${shown.questionIndex?.coerceAtLeast(1) ?: 1} / ${shown.questionCount}",
                        style = typography.caption,
                        color = colors.fg3,
                    )
                }
            }
            val message = shown.message
            if (!message.isNullOrBlank()) {
                if (isQuestion || selectsOptions) {
                    Text(text = message, style = typography.bodySmall, color = colors.fg2)
                } else {
                    // A permission/plan preview is terminal output: keep it monospaced. The card's own
                    // scroll handles a long preview, so this box deliberately does not scroll itself.
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(LocalRiffetSurfaces.current.floating, RoundedCornerShape(LocalInterfaceStyle.current.controlRadius))
                            .padding(8.dp),
                    ) {
                        Text(
                            text = message,
                            style = typography.monoSmall,
                            color = colors.fg2,
                        )
                    }
                }
            }

            if (isQuestion || selectsOptions) {
                val options = shown.options
                if (options.isNotEmpty()) {
                    val recipe = LocalInterfaceStyle.current.components.lists
                    Column(Modifier.then(if (shown.multiple != true) Modifier.selectableGroup() else Modifier)) {
                        options.forEach { option ->
                            val checked = selected.contains(option.id)
                            val interactive = connected && !busy
                            val source = remember(option.id) { MutableInteractionSource() }
                            val focused by source.collectIsFocusedAsState()
                            val shape = RoundedCornerShape(LocalInterfaceStyle.current.selectionRadius)
                            val selection = if (shown.multiple == true) {
                                Modifier.toggleable(value = checked, interactionSource = source,
                                    indication = LocalIndication.current, enabled = interactive, role = Role.Checkbox) { changeOption(option.id) }
                            } else {
                                Modifier.selectable(selected = checked, interactionSource = source,
                                    indication = LocalIndication.current, enabled = interactive, role = Role.RadioButton) {
                                    changeOption(option.id)
                                    if (tapAnswers) submit(answerAction!!)
                                }
                            }
                            val mark: @Composable () -> Unit = {
                                if (shown.multiple == true) Checkbox(checked, onCheckedChange = null, enabled = interactive)
                                else if (recipe.selectionAtEnd) riffet.ui.design.SelectionMark(checked, enabled = interactive)
                                else RadioButton(checked, onClick = null, enabled = interactive)
                            }
                            // The row owns activation; marks only render its state.
                            Row(
                                modifier = Modifier.fillMaxWidth().heightIn(min = designMetrics.controlHeight)
                                    .clip(shape)
                                    .then(if (recipe.focusBorder && focused) Modifier.border(designMetrics.focusWidth, LocalRiffetSurfaces.current.focus, shape) else Modifier)
                                    .then(selection).padding(vertical = 2.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                if (!recipe.selectionAtEnd) mark()
                                Text(option.label, style = if (recipe.grouped) typography.body else typography.bodySmall,
                                    color = when {
                                        !interactive -> LocalRiffetSurfaces.current.disabledContent
                                        // The mark says which is chosen; the label stays ink.
                                        else -> colors.fg
                                    }, modifier = Modifier.weight(1f))
                                if (recipe.selectionAtEnd) {
                                    Spacer(Modifier.width(12.dp))
                                    mark()
                                }
                            }
                        }
                    }
                }

                if (isQuestion && (shown.allowOther == true || options.isEmpty())) {
                    val locked = otherTextLocked(shown)
                    val inputSource = remember { MutableInteractionSource() }
                    val inputFocused by inputSource.collectIsFocusedAsState()
                    BasicTextField(
                        value = currentDraft.otherText,
                        interactionSource = inputSource,
                        onValueChange = ::changeOther,
                        enabled = connected && !busy,
                        textStyle = typography.bodySmall.copy(color = if (connected && !busy) colors.fg else LocalRiffetSurfaces.current.disabledContent),
                        cursorBrush = SolidColor(colors.accent),
                        modifier = Modifier
                            .fillMaxWidth()
                            .keepsFocusOnTap()
                            .heightIn(min = designMetrics.inputMinHeight, max = designMetrics.composerMaxHeight)
                            .background(LocalRiffetSurfaces.current.floating, RoundedCornerShape(LocalInterfaceStyle.current.controlRadius))
                            .border(BorderStroke(if (inputFocused) designMetrics.focusWidth else designMetrics.hairlineWidth, if (inputFocused) LocalRiffetSurfaces.current.focus else LocalRiffetSurfaces.current.hairline), RoundedCornerShape(LocalInterfaceStyle.current.controlRadius))
                            .padding(horizontal = 10.dp, vertical = 8.dp),
                        decorationBox = { inner ->
                            if (currentDraft.otherText.isEmpty()) {
                                Text(
                                    text = if (options.isEmpty()) {
                                        stringResource(Res.string.timeline_interaction_answer_placeholder)
                                    } else {
                                        stringResource(Res.string.timeline_interaction_other_placeholder)
                                    },
                                    style = typography.bodySmall,
                                    color = colors.fg4,
                                )
                            }
                            inner()
                        },
                    )
                    if (locked) {
                        Text(text = stringResource(Res.string.timeline_interaction_other_locked), style = typography.caption, color = colors.fg3)
                    }
                }
            }

            val notice = when (state.notice) {
                InteractionNotice.DRAFT_STALE -> stringResource(Res.string.timeline_interaction_draft_stale)
                InteractionNotice.UNCONFIRMED -> stringResource(Res.string.timeline_interaction_sync_unconfirmed)
                null -> null
            }
            if (notice != null) {
                Text(text = notice, style = typography.caption, color = colors.warning)
            }
            val outcome = when (submission?.phase) {
                SubmissionPhase.UNKNOWN -> stringResource(Res.string.timeline_interaction_result_unknown)
                SubmissionPhase.STALE -> stringResource(Res.string.timeline_interaction_changed)
                SubmissionPhase.UNCERTAIN -> stringResource(Res.string.timeline_interaction_result_uncertain)
                SubmissionPhase.SUCCESS -> submission?.message
                SubmissionPhase.POSTING, null -> null
            }
            if (outcome != null) {
                Text(
                    text = outcome,
                    style = typography.caption,
                    color = if (submission?.phase == SubmissionPhase.SUCCESS) colors.success else colors.warning,
                )
            }
            // The provider's reason is diagnostic detail, often in English; the reader first needs what to do.
            val reason = submission?.message?.takeIf { submission?.phase == SubmissionPhase.UNCERTAIN && it.isNotBlank() && it != outcome }
            if (reason != null) {
                Text(text = reason, style = typography.caption, color = colors.fg3)
            }
            val error = state.error?.let {
                it.message ?: when (it.kind) {
                    InteractionErrorKind.SUBMIT -> stringResource(Res.string.timeline_interaction_submit_failed)
                    InteractionErrorKind.SYNC -> stringResource(Res.string.timeline_interaction_sync_failed)
                }
            }
            if (error != null) {
                Text(text = error, style = typography.caption, color = colors.danger)
            }
            verifyNotice?.let { Text(text = it, style = typography.caption, color = colors.warning) }
        }

        // The pressed button carries the spinner; the caption is only for an action no button shows.
        val postingAction = submission?.takeIf { it.phase == SubmissionPhase.POSTING }?.request?.action
        // A tap-to-answer question hides its answer button, so posting that answer shows the caption.
        val buttonActions = shown.actions.map { it.id }
            .filter { it != "next" || (!isQuestion && !selectsOptions) }
            .filter { !(tapAnswers && it == answerAction) }

        if (!isQuestion && !selectsOptions) {
            // The CLI's own choices, in its own order. The focused row leads; a clearly negative
            // row is tinted as destructive and a clearly affirmative one as safe, so the two are
            // never mistaken for each other on a small screen.
            val focusedId = shown.options.firstOrNull { it.selected }?.id
            shown.actions.forEach { action ->
                ActionButton(
                    action = action,
                    tone = actionTone(action, focusedId),
                    enabled = connected && !busy,
                    onClick = { submit(action.id) },
                    posting = action.id == postingAction,
                )
            }
        } else {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                shown.actions.filter { it.id != "next" && !(tapAnswers && it.id == answerAction) }.forEach { action ->
                    // A submit carries the draft, an `answer` is a question's own submit: both are the
                    // primary action and both wait for a selection, whether the kind is question or plan.
                    val submitsSelection = carriesSelection(shown, action.id)
                    val label = when (action.id) {
                        "previous" -> stringResource(Res.string.timeline_interaction_previous)
                        "answer", "submit" ->
                            // i18n-ignore: the backend labels its own actions; this is a wire value,
                            // not copy this app renders in place of a resource. Next and submit both
                            // use id `answer` (the protocol's own `submit` is a plan action), and a
                            // protocol question without counters carries no other signal, so its
                            // label is what tells a final "提交" apart from "下一题".
                            if (lastQuestion || action.label.contains("提交")) {
                                stringResource(Res.string.timeline_interaction_submit)
                            } else {
                                stringResource(Res.string.timeline_interaction_next)
                            }
                        "skip" -> stringResource(Res.string.timeline_interaction_skip)
                        else -> action.label
                    }
                    val danger = action.tone == "danger"
                    PlainAction(
                        label = label,
                        tone = if (danger) ActionTone.DANGER else if (submitsSelection) ActionTone.PRIMARY else ActionTone.NORMAL,
                        enabled = connected && !busy && (!submitsSelection || answerPresent),
                        onClick = { submit(action.id) },
                        posting = action.id == postingAction,
                    )
                }
            }
        }

        if (postingAction != null && postingAction !in buttonActions) {
            Text(text = stringResource(Res.string.timeline_interaction_submitting), style = typography.caption, color = colors.fg3)
        }
        if (state.canSync) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (submission?.phase == SubmissionPhase.UNKNOWN) {
                    PlainAction(stringResource(Res.string.timeline_retry), ActionTone.PRIMARY, state.canRetry && connected) { retry() }
                }
                PlainAction(
                    if (state.syncing) stringResource(Res.string.timeline_interaction_syncing) else stringResource(Res.string.timeline_interaction_sync),
                    ActionTone.NORMAL,
                    !state.syncing,
                ) { sync() }
            }
        }

        if (!connected) {
            Text(text = stringResource(Res.string.timeline_interaction_disconnected), style = typography.caption, color = colors.fg3)
        }
    }
}

/** The summary and reader share the parent card's frozen submission and verification gate. */
@Composable
private fun ApprovalCard(
    shown: NativeInteraction,
    state: InteractionCardState,
    connected: Boolean,
    busy: Boolean,
    verifyNotice: String?,
    showingDetails: Boolean,
    onOpen: () -> Unit,
    onDismiss: () -> Unit,
    onSubmit: (String) -> Unit,
    onSelectOption: (String) -> Unit,
    onChangeOther: (String) -> Unit,
    onRetry: () -> Unit,
    onSync: () -> Unit,
    modifier: Modifier,
) {
    val style = LocalInterfaceStyle.current
    val surfaces = LocalRiffetSurfaces.current
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val title = shown.title.ifBlank { stringResource(Res.string.timeline_interaction_approval) }
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    val posting = state.submission?.takeIf { it.phase == SubmissionPhase.POSTING }?.request?.action
    val selectsOptions = interactionSelectsOptions(shown)
    val selectedOptions = state.currentDraft.selectedIds.toSet()
    val answerPresent = selectedOptions.isNotEmpty() || state.currentDraft.otherText.isNotBlank()
    val oneOffActionIds = setOf("approve", "allow", "allow-once", "accept")
    val refusalActionIds = setOf("deny", "decline", "reject", "cancel")
    val quickActionIds = oneOffActionIds + refusalActionIds
    val directAuxiliaryActionIds = setOf("cancel", "previous", "skip")
    val auxiliaryActions = shown.actions.filter { !carriesSelection(shown, it.id) && it.id != "next" }
    val reviewedAuxiliaryActions = auxiliaryActions.filter { it.id !in directAuxiliaryActionIds || !it.detail.isNullOrBlank() }
    var selectedAction by remember(shown.id, shown.revision) {
        mutableStateOf(shown.actions.firstOrNull { it.id in oneOffActionIds }?.id)
    }

    BoxWithConstraints(
        modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp)
            .background(surfaces.card, RoundedCornerShape(style.groupRadius)).padding(12.dp),
    ) {
        val width = with(density) { maxWidth.roundToPx() }.coerceAtLeast(1)
        fun labelFits(label: String) = !measurer.measure(label, typography.label, maxLines = 1,
            constraints = Constraints(maxWidth = (width / 2).coerceAtLeast(1))).hasVisualOverflow
        // A protocol request names its one-off approval and refusal by id; a permission lifted from a terminal
        // marks its plain Yes and No by tone. How long the request is does not decide which answers are offered.
        // Unknown or long labels and remembered rules (`detail`) keep their exact text in the reader.
        val permission = shown.kind == NativeInteractionKind.PERMISSION
        fun refuses(action: NativeInteractionAction) = action.id in refusalActionIds || (permission && action.tone == "danger")
        val quick = shown.actions.filter { action -> action.detail.isNullOrBlank() && labelFits(action.shortLabel ?: action.label) &&
            (action.id in quickActionIds || (permission && action.tone in setOf("primary", "danger"))) }
        val quickAllowed = permission && !selectsOptions
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(title, style = typography.label, color = colors.fg, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (!shown.message.isNullOrBlank()) {
                Text(shown.message.orEmpty(), style = typography.monoSmall, color = colors.fg2,
                    maxLines = 3, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.fillMaxWidth().background(surfaces.floating, RoundedCornerShape(style.controlRadius)).padding(8.dp))
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                PlainAction(stringResource(Res.string.session_details), ActionTone.NORMAL, true, neutral = true, onClick = onOpen)
                quick.filter { quickAllowed || refuses(it) }.sortedBy { !refuses(it) }.forEach { action ->
                    PlainAction(action.shortLabel ?: action.label, if (refuses(action)) ActionTone.NORMAL else ActionTone.PRIMARY, connected && !busy,
                        posting = action.id == posting, neutral = true, onClick = { onSubmit(action.id) })
                }
            }
            ApprovalNotices(state, connected, verifyNotice, onRetry, onSync)
        }
    }

    if (showingDetails) {
        PickerOverlay(title = stringResource(Res.string.timeline_interaction_approval), onDismiss = onDismiss, fullHeight = true) {
            Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp)) {
                SelectableText { Text(title, style = typography.title, color = colors.fg) }
                if (!shown.message.isNullOrBlank()) {
                    SelectableText {
                        if (shown.kind == NativeInteractionKind.PLAN) {
                            MarkdownBody(shown.message.orEmpty(), color = colors.fg, style = typography.body, codeStyle = typography.mono,
                                modifier = Modifier.fillMaxWidth())
                        } else {
                            Text(shown.message.orEmpty(), style = typography.mono, color = colors.fg,
                                modifier = Modifier.fillMaxWidth().background(surfaces.floating, RoundedCornerShape(style.controlRadius)).padding(12.dp))
                        }
                    }
                }
                if (selectsOptions) {
                    Column(Modifier.selectableGroup(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        shown.options.forEach { option ->
                            val checked = option.id in selectedOptions
                            Row(Modifier.fillMaxWidth().heightIn(min = style.metrics.controlHeight)
                                .selectable(checked, enabled = connected && !busy,
                                    role = if (shown.multiple == true) Role.Checkbox else Role.RadioButton,
                                    onClick = { selectedAction = null; onSelectOption(option.id) }).padding(vertical = 4.dp),
                                verticalAlignment = Alignment.Top) {
                                if (shown.multiple == true) Checkbox(checked, onCheckedChange = null, enabled = connected && !busy)
                                else RadioButton(checked, onClick = null, enabled = connected && !busy)
                                Text(option.label, style = typography.body, color = colors.fg,
                                    modifier = Modifier.weight(1f).padding(start = 8.dp))
                            }
                        }
                    }
                    if (shown.allowOther == true) {
                        val source = remember { MutableInteractionSource() }
                        val focused by source.collectIsFocusedAsState()
                        val shape = RoundedCornerShape(style.controlRadius)
                        BasicTextField(
                            value = state.currentDraft.otherText,
                            onValueChange = { selectedAction = null; onChangeOther(it) },
                            interactionSource = source,
                            enabled = connected && !busy,
                            textStyle = typography.bodySmall.copy(color = if (connected && !busy) colors.fg else surfaces.disabledContent),
                            cursorBrush = SolidColor(colors.accent),
                            modifier = Modifier.fillMaxWidth().keepsFocusOnTap()
                                .heightIn(min = style.metrics.inputMinHeight, max = style.metrics.composerMaxHeight)
                                .background(surfaces.floating, shape)
                                .border(BorderStroke(if (focused) style.metrics.focusWidth else style.metrics.hairlineWidth,
                                    if (focused) surfaces.focus else surfaces.hairline), shape)
                                .padding(horizontal = 10.dp, vertical = 8.dp),
                            decorationBox = { inner ->
                                if (state.currentDraft.otherText.isEmpty()) {
                                    Text(stringResource(if (shown.options.isEmpty()) Res.string.timeline_interaction_answer_placeholder else Res.string.timeline_interaction_other_placeholder),
                                        style = typography.bodySmall, color = colors.fg4)
                                }
                                inner()
                            },
                        )
                        if (otherTextLocked(shown)) {
                            Text(stringResource(Res.string.timeline_interaction_other_locked), style = typography.caption, color = colors.fg3)
                        }
                    }
                    // Unknown or scoped auxiliary decisions are reviewed with their full text;
                    // the fixed footer never has to contain an arbitrarily long provider label.
                    auxiliaryActions.filter { it !in reviewedAuxiliaryActions }.forEach { action ->
                        val compactLabel = when (action.id) {
                            "cancel" -> stringResource(Res.string.timeline_cancel)
                            "previous" -> stringResource(Res.string.timeline_interaction_previous)
                            else -> stringResource(Res.string.timeline_interaction_skip)
                        }
                        if (action.label != compactLabel) {
                            SelectableText { Text(action.label, style = typography.body, color = colors.fg2) }
                        }
                    }
                    reviewedAuxiliaryActions.forEach { action ->
                        val checked = selectedAction == action.id
                        Row(Modifier.fillMaxWidth().heightIn(min = style.metrics.controlHeight)
                            .selectable(checked, enabled = connected && !busy, role = Role.RadioButton,
                                onClick = { selectedAction = action.id }).padding(vertical = 4.dp),
                            verticalAlignment = Alignment.Top) {
                            RadioButton(checked, onClick = null, enabled = connected && !busy)
                            Text(action.shortLabel ?: action.label, style = typography.body, color = colors.fg,
                                modifier = Modifier.weight(1f).padding(start = 8.dp))
                        }
                        val explanation = action.detail?.takeIf { it.isNotBlank() }
                            ?: action.label.takeIf { action.shortLabel != null && action.shortLabel != action.label }
                        if (explanation != null) {
                            SelectableText { Text(explanation, style = typography.monoSmall, color = colors.fg2) }
                        }
                    }
                }
                if (shown.actions.isNotEmpty() && !selectsOptions) {
                    Text(stringResource(if (shown.kind == NativeInteractionKind.PERMISSION) Res.string.timeline_interaction_scope else Res.string.timeline_interaction_need_choice),
                        style = typography.caption, color = colors.fg3)
                    Column(Modifier.selectableGroup(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        shown.actions.forEach { action ->
                            val chosen = selectedAction == action.id
                            Row(Modifier.fillMaxWidth().heightIn(min = style.metrics.controlHeight)
                                .selectable(chosen, enabled = connected && !busy, role = Role.RadioButton,
                                    onClick = { selectedAction = action.id }).padding(vertical = 4.dp),
                                verticalAlignment = Alignment.Top) {
                                RadioButton(chosen, onClick = null, enabled = connected && !busy)
                                Column(Modifier.weight(1f).padding(start = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                    Text(action.shortLabel ?: action.label, style = typography.body, color = colors.fg)
                                    if (!action.detail.isNullOrBlank()) {
                                        SelectableText { Text(action.detail.orEmpty(), style = typography.monoSmall, color = colors.fg2) }
                                    } else if (action.shortLabel != null && action.shortLabel != action.label) {
                                        SelectableText { Text(action.label, style = typography.body, color = colors.fg2) }
                                    }
                                }
                            }
                        }
                    }
                }
                ApprovalNotices(state, connected, verifyNotice, onRetry, onSync, compact = false)
            }
            val chosen = if (selectsOptions) reviewedAuxiliaryActions.firstOrNull { it.id == selectedAction }
                ?: shown.actions.firstOrNull { carriesSelection(shown, it.id) }
                else shown.actions.firstOrNull { it.id == selectedAction }
            BoxWithConstraints(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp)) {
                val availableWidth = with(density) { maxWidth.roundToPx() }.coerceAtLeast(1)
                val known = chosen?.id in quickActionIds || chosen?.id == "approveForSession" || chosen?.detail != null
                val label = (chosen?.shortLabel ?: chosen?.label)?.takeIf { known && !measurer.measure(it, typography.label, maxLines = 1,
                    constraints = Constraints(maxWidth = availableWidth)).hasVisualOverflow }
                    ?: stringResource(Res.string.timeline_interaction_submit)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (selectsOptions) auxiliaryActions.filter { it !in reviewedAuxiliaryActions }.forEach { action ->
                        val auxiliaryLabel = when (action.id) {
                            "cancel" -> stringResource(Res.string.timeline_cancel)
                            "previous" -> stringResource(Res.string.timeline_interaction_previous)
                            else -> stringResource(Res.string.timeline_interaction_skip)
                        }
                        PlainAction(auxiliaryLabel, ActionTone.NORMAL, connected && !busy, posting = action.id == posting, neutral = true, singleLine = true) { onSubmit(action.id) }
                    }
                    PlainAction(label,
                        if (chosen?.id in refusalActionIds) ActionTone.NORMAL else ActionTone.PRIMARY,
                        chosen != null && connected && !busy && (!carriesSelection(shown, chosen.id) || answerPresent), posting = posting != null, neutral = true, singleLine = true) {
                        chosen?.let { onSubmit(it.id) }
                    }
                }
            }
        }
    }
}

@Composable
private fun ApprovalNotices(
    state: InteractionCardState,
    connected: Boolean,
    verifyNotice: String?,
    onRetry: () -> Unit,
    onSync: () -> Unit,
    compact: Boolean = true,
) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val notice = when (state.notice) {
        InteractionNotice.DRAFT_STALE -> stringResource(Res.string.timeline_interaction_draft_stale)
        InteractionNotice.UNCONFIRMED -> stringResource(Res.string.timeline_interaction_sync_unconfirmed)
        null -> null
    }
    val outcome = when (state.submission?.phase) {
        SubmissionPhase.UNKNOWN, SubmissionPhase.UNCERTAIN -> stringResource(Res.string.timeline_interaction_result_unknown)
        SubmissionPhase.STALE -> stringResource(Res.string.timeline_interaction_changed)
        SubmissionPhase.SUCCESS -> state.submission?.message
        SubmissionPhase.POSTING, null -> null
    }
    val error = state.error?.message ?: state.error?.let {
        stringResource(if (it.kind == InteractionErrorKind.SUBMIT) Res.string.timeline_interaction_submit_failed else Res.string.timeline_interaction_sync_failed)
    }
    val text = error ?: verifyNotice ?: outcome ?: notice
    if (text != null) riffet.ui.design.Notice(text, if (error != null) riffet.ui.design.NoticeKind.ERROR else riffet.ui.design.NoticeKind.WARNING,
        // Inside the card, a faint ink tint sets it apart; the selection tone would read as a chosen option.
        background = LocalRiffetSurfaces.current.press, maxLines = if (compact) 3 else Int.MAX_VALUE)
    val reason = state.submission?.message?.takeIf { state.submission?.phase == SubmissionPhase.UNCERTAIN && it.isNotBlank() && it != text }
    if (!compact && reason != null) Text(reason, style = typography.caption, color = colors.fg3)
    if (state.canSync) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            if (state.submission?.phase == SubmissionPhase.UNKNOWN) {
                PlainAction(stringResource(Res.string.timeline_retry), ActionTone.NORMAL, state.canRetry && connected, neutral = true, onClick = onRetry)
            }
            PlainAction(stringResource(if (state.syncing) Res.string.timeline_interaction_syncing else Res.string.timeline_interaction_sync),
                ActionTone.NORMAL, !state.syncing, neutral = true, onClick = onSync)
        }
    }
    if (!connected) Text(stringResource(Res.string.timeline_interaction_disconnected), style = typography.caption, color = colors.fg3)
}

private enum class ActionTone { DANGER, SAFE, PRIMARY, NORMAL }

/**
 * The server does not label a permission option's tone, so the distinction is read from the CLI's
 * own wording — the same labels a reader would judge by. Only unambiguous prefixes count; an
 * unknown label stays neutral rather than being guessed into "safe".
 */
private fun actionTone(action: NativeInteractionAction, focusedOptionId: String?): ActionTone {
    if (action.tone == "danger") return ActionTone.DANGER
    if (action.id.startsWith("option:")) {
        val label = action.label.lowercase()
        if (looksDestructive(label)) return ActionTone.DANGER
        if (looksAffirmative(label)) return ActionTone.SAFE
        return if (action.id.removePrefix("option:") == focusedOptionId) ActionTone.PRIMARY else ActionTone.NORMAL
    }
    return if (action.tone == "primary" || action.id == "answer") ActionTone.PRIMARY else ActionTone.NORMAL
}

private val numberedNo = Regex("^\\d+\\.\\s*no\\b")
private val numberedYes = Regex("^\\d+\\.\\s*yes\\b")

private fun looksDestructive(label: String): Boolean =
    label.startsWith("no,") || label.startsWith("no ") || numberedNo.containsMatchIn(label) ||
        label.startsWith("quit") || label.startsWith("cancel") || label.startsWith("deny") ||
        label.startsWith("reject") || label.contains("without approval") ||
        label.contains("propose changes") || label.contains("don't") || label.contains("do not")

private fun looksAffirmative(label: String): Boolean =
    label.startsWith("yes") || numberedYes.containsMatchIn(label) || label.startsWith("trust") ||
        label.startsWith("approve") || label.startsWith("allow") || label.startsWith("build")

@Composable
private fun ActionButton(
    action: NativeInteractionAction,
    tone: ActionTone,
    enabled: Boolean,
    onClick: () -> Unit,
    posting: Boolean = false,
) {
    val designMetrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    if (LocalInterfaceStyle.current.components.lists.grouped) {
        riffet.ui.design.RiffetTextButton(onClick = onClick, enabled = enabled, danger = tone == ActionTone.DANGER, modifier = Modifier.fillMaxWidth()) {
            Text(
                action.label,
                color = if (!enabled) LocalRiffetSurfaces.current.disabledContent else if (tone == ActionTone.SAFE) colors.success else if (tone == ActionTone.DANGER) colors.danger else colors.accent,
                fontWeight = if (tone == ActionTone.PRIMARY) FontWeight.SemiBold else FontWeight.Normal,
                modifier = Modifier.weight(1f),
            )
            if (posting) SubmittingSpinner(colors.fg3)
        }
        return
    }
    val background = when (tone) {
        ActionTone.DANGER -> colors.dangerSoft
        ActionTone.SAFE -> colors.successSoft
        ActionTone.PRIMARY -> LocalRiffetSurfaces.current.selected
        ActionTone.NORMAL -> LocalRiffetSurfaces.current.floating
    }
    // No frame: the soft tint (or the elevated fill on the card's subtle ground) is the boundary.
    // The same-tone outline this used to draw was the "逐选项边框" the interaction card dropped on
    // the web.
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = designMetrics.controlHeight)
            // Clipped before it is filled, so the press ripple stays inside the rounded shape.
            .clip(RoundedCornerShape(LocalInterfaceStyle.current.controlRadius))
            .background(if (enabled) background else LocalRiffetSurfaces.current.press)
            .clickable(role = Role.Button, enabled = enabled, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = action.label,
            style = typography.label.copy(fontWeight = FontWeight.Medium),
            color = if (!enabled) LocalRiffetSurfaces.current.disabledContent else if (tone == ActionTone.PRIMARY) LocalRiffetSurfaces.current.selectedContent else colors.fg,
            modifier = Modifier.weight(1f),
        )
        if (posting) SubmittingSpinner(colors.fg3)
    }
}

/** Stands in the pressed button while its answer posts; announced as 提交中. */
@Composable
private fun SubmittingSpinner(color: androidx.compose.ui.graphics.Color) {
    val label = stringResource(Res.string.timeline_interaction_submitting)
    CircularProgressIndicator(
        modifier = Modifier.size(14.dp).semantics { stateDescription = label },
        strokeWidth = 1.5.dp,
        color = color,
    )
}

@Composable
private fun PlainAction(label: String, tone: ActionTone, enabled: Boolean, posting: Boolean = false, neutral: Boolean = false, singleLine: Boolean = false, onClick: () -> Unit) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val surfaces = LocalRiffetSurfaces.current
    if (LocalInterfaceStyle.current.components.lists.grouped) {
        riffet.ui.design.RiffetTextButton(onClick = onClick, enabled = enabled, danger = tone == ActionTone.DANGER) {
            Box(contentAlignment = Alignment.Center) {
                Text(
                    label,
                    color = if (!enabled) surfaces.disabledContent else if (neutral) colors.fg else if (tone == ActionTone.SAFE) colors.success else if (tone == ActionTone.DANGER) colors.danger else colors.accent,
                    fontWeight = if (tone == ActionTone.PRIMARY) FontWeight.SemiBold else FontWeight.Normal,
                    maxLines = if (singleLine) 1 else Int.MAX_VALUE,
                    overflow = TextOverflow.Ellipsis,
                    modifier = if (posting) Modifier.alpha(0f) else Modifier,
                )
                if (posting) SubmittingSpinner(colors.fg3)
            }
        }
        return
    }
    val background = if (neutral) {
        if (tone == ActionTone.PRIMARY) surfaces.selected else surfaces.floating
    } else when (tone) {
        ActionTone.DANGER -> colors.dangerSoft
        ActionTone.SAFE -> colors.successSoft
        ActionTone.PRIMARY -> colors.accent
        ActionTone.NORMAL -> LocalRiffetSurfaces.current.floating
    }
    val foreground = if (neutral) {
        if (tone == ActionTone.PRIMARY) surfaces.selectedContent else colors.fg
    } else when (tone) {
        ActionTone.PRIMARY -> colors.accentFg
        ActionTone.DANGER -> colors.danger
        ActionTone.SAFE -> colors.success
        ActionTone.NORMAL -> colors.fg
    }
    Box(
        modifier = Modifier
            .sizeIn(minWidth = 48.dp, minHeight = 48.dp)
            .clip(RoundedCornerShape(LocalInterfaceStyle.current.controlRadius))
            .background(if (enabled) background else LocalRiffetSurfaces.current.press)
            .clickable(role = Role.Button, enabled = enabled, onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 10.dp),
        contentAlignment = Alignment.Center,
    ) {
        // The label keeps its space under the spinner, so the button does not change size.
        Text(text = label, style = typography.label, color = if (enabled) foreground else LocalRiffetSurfaces.current.disabledContent,
            maxLines = if (singleLine) 1 else Int.MAX_VALUE, overflow = TextOverflow.Ellipsis,
            modifier = if (posting) Modifier.alpha(0f) else Modifier)
        if (posting) SubmittingSpinner(foreground)
    }
}

/**
 * Opens the session's terminal page; provided by the session screen when the session has a terminal.
 */
internal val LocalTerminalOpen = staticCompositionLocalOf<(() -> Unit)?> { null }

/**
 * The degradation for an interaction this build cannot draw as a card: answer it in the terminal.
 * With a terminal ([LocalTerminalOpen]) the button opens it; without one (a protocol-only backend)
 * it explains where to answer instead of pretending to switch views.
 */
@Composable
private fun TerminalFallbackCard(interaction: NativeInteraction, modifier: Modifier = Modifier) {
    val motion = LocalRiffetMotion.current
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    var expanded by remember(interaction.id) { mutableStateOf(false) }
    val openTerminal = LocalTerminalOpen.current
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 8.dp)
            .background(colors.warningSoft, RoundedCornerShape(LocalInterfaceStyle.current.groupRadius))
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(RiffetIcons.Warning, contentDescription = null, tint = colors.warning, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(8.dp))
            Text(
                text = interaction.title.ifBlank { stringResource(Res.string.timeline_interaction_terminal_required) },
                style = typography.label,
                color = colors.fg,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
        }
        val fallbackMessage = interaction.message
        if (!fallbackMessage.isNullOrBlank()) {
            Text(text = fallbackMessage, style = typography.bodySmall, color = colors.fg2, maxLines = 4, overflow = TextOverflow.Ellipsis)
        }
        if (LocalInterfaceStyle.current.components.lists.grouped) {
            riffet.ui.design.RiffetTextButton(
                onClick = { if (openTerminal != null) openTerminal() else expanded = !expanded },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Icon(RiffetIcons.Terminal, null, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(6.dp))
                Text(stringResource(Res.string.timeline_interaction_answer_in_terminal), modifier = Modifier.weight(1f))
            }
        } else Row(
            modifier = Modifier
                .sizeIn(minWidth = 48.dp, minHeight = 48.dp)
                .clip(RoundedCornerShape(LocalInterfaceStyle.current.controlRadius))
                .background(LocalRiffetSurfaces.current.floating)
                .clickable(role = Role.Button) { if (openTerminal != null) openTerminal() else expanded = !expanded }
                .padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(RiffetIcons.Terminal, contentDescription = null, tint = colors.fg2, modifier = Modifier.size(14.dp))
            Spacer(Modifier.width(6.dp))
            Text(text = stringResource(Res.string.timeline_interaction_answer_in_terminal), style = typography.label, color = colors.fg)
        }
        AnimatedVisibility(visible = expanded, enter = motion.expandIn(), exit = motion.collapseOut()) {
            Text(
                text = stringResource(Res.string.timeline_interaction_terminal_fallback),
                style = typography.caption,
                color = colors.fg2,
            )
        }
    }
}
