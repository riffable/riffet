package riffet.ui.composer

import riffet.contracts.SessionGoal
import riffet.ui.design.riffetMaterial
import riffet.ui.design.materialContentBackground
import riffet.ui.design.MaterialRole
import riffet.ui.design.RiffetMaterialContent

import riffet.ui.design.cardEdge
import riffet.ui.design.floatingShadow
import riffet.ui.design.LocalRiffetSurfaces
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.ComponentBackend
import androidx.compose.foundation.LocalIndication
import riffet.ui.timeline.Chevron
import riffet.ui.theme.LocalRiffetMotion
import androidx.compose.ui.graphics.Color
import androidx.compose.animation.togetherWith
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.Crossfade
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.AnimatedContent
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import riffet.i18n.L10n
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.horizontalScroll
import riffet.ui.design.RiffetProgressIndicator as CircularProgressIndicator
import riffet.ui.icons.Icon
import riffet.ui.design.RiffetIconButton as IconButton
import androidx.compose.material3.Text
import riffet.ui.design.RiffetTextButton as TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import riffet.ui.haptics.rememberAppHaptics
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isAltPressed
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.isMetaPressed
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.getString
import org.jetbrains.compose.resources.stringResource
import org.jetbrains.compose.resources.rememberResourceEnvironment
import riffet_mobile.shared.generated.resources.*
import riffet.contracts.Attachment
import riffet.contracts.NativeDeliveryState
import riffet.contracts.NativeSlashCatalog
import riffet.contracts.Run
import riffet.contracts.Session
import riffet.shared.PromptContextReference
import riffet.shared.rankedSessionReferences
import riffet.shared.sessionReference
import riffet.ui.focus.keepsFocusOnTap
import riffet.ui.icons.RiffetIcons
import riffet.ui.pickers.RiffetDropdownMenu
import riffet.ui.pickers.RiffetMenuItem
import riffet.ui.state.SessionStore
import riffet.ui.state.inQueue
import riffet.ui.state.RiffetConnectionState
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ime
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.rememberUpdatedState

/*
 * The message composer, ported from `apps/web/src/app/session/Composer.tsx` and `ComposerDock.tsx`.
 *
 * ## Layout (the web's mobile composer)
 *
 * One rounded card: the input on top, then a footer row with the attach button, a single "发送设置"
 * chip (the permission's short name + the model's name; it opens the sheet with mode, permission and model), the
 * context ring, and the send button — which turns into a stop button while a turn runs and the
 * draft is empty. The agent's todo list (`TodoDock`) and queued runs sit above
 * the card, like `ComposerDock`.
 *
 * An empty, unfocused session dock keeps its compact input height. The edit surface retains
 * its fill and shadow; model and action controls expand when the editor is focused.
 *
 * ## What is reproduced
 *
 *  - a queued message is a real `Run` in `queued` delivery state, listed in a card above the input
 *    with a primary steer/send action and a menu for the remaining actions: "停止并发送" interrupts
 *    the current turn and promotes that run, "编辑" restores its draft, and "移出队列" removes it;
 *  - while a turn is in flight, the send button means "加入队列"; interrupting is the queue's
 *    "停止并发送", so the input row keeps its width for the model chip (the web's phone layout);
 *  - an unknown HTTP result stays in the durable outbox; exact retries reuse its command identity.
 *    Recovery actions belong to the corresponding message and never silently release the queue.
 *
 * ## The phone decisions
 *
 *  - **The input is never disabled.** A disabled `BasicTextField` drops focus, and the stream flips
 *    through `Reconnecting` on every SSE redial — which used to close the keyboard mid-sentence.
 *    Only the send button reflects the connection.
 *  - **Enter.** A hardware Enter sends; Shift/Ctrl/Alt+Enter and the soft keyboard's return key
 *    insert a newline. On a phone the return key must stay a newline, so the send button is always
 *    visible.
 *  - **Slash commands.** The `/` menu (`SlashMenu.kt`) opens inside the card above the input: the
 *    backend's built-in commands for the leading token, its skills anywhere it loads them. A pick
 *    inserts the literal `/name `; there is no keyboard navigation, a row is tapped.
 */

/** The "发送设置" chip's content; null hides the chip. */
class ComposerSettings(
    val label: String,
    val icon: ImageVector?,
    val enabled: Boolean,
    val onOpen: () -> Unit,
    /** The model catalog is being read: the chevron spins. */
    val loading: Boolean = false,
    /** A model, mode or approval write is in flight: the chevron spins too, announced as switching. */
    val switching: Boolean = false,
    /** The catalog could not be read: the chevron becomes a warning; the chip still opens the sheet. */
    val error: Boolean = false,
    /** `Color.Unspecified` keeps an agent mark's own colours (the Codex gradient). */
    val iconTint: Color? = null,
    /** The permission's short name, shown before the model with a muted `·`; null shows none. */
    val prefix: String? = null,
    /** The permission is a risky one: the prefix takes the warning colour. */
    val prefixRisky: Boolean = false,
)

/** A message to quote into the draft; [token] lets the same text be quoted twice. */
data class ComposerQuote(val text: String, val token: Long)

@Composable
fun Composer(
    store: SessionStore,
    session: Session,
    modifier: Modifier = Modifier,
    settings: ComposerSettings? = null,
    /** The newest plan, projected by the caller; it becomes the todo dock above the input card. */
    todos: List<TodoEntry> = emptyList(),
    /** The session's goal, projected by the caller; it sits above the todo dock. */
    goal: SessionGoal? = null,
    quote: ComposerQuote? = null,
    restoreRun: Run? = null,
    onRestoreHandled: (Run) -> Unit = {},
    supportsSteer: Boolean = false,
    supportsSessionReferences: Boolean = false,
    supportsTargetedStop: Boolean = false,
    acceptsMessages: Boolean = true,
    /** Background subagents running while the main agent is idle ([riffet.ui.timeline.TimelinePresentation.backgroundSubagents]). */
    background: Int = 0,
    /** A message is on its way: the transcript resumes following its tail. */
    onSubmit: () -> Unit = {},
    writeScope: CoroutineScope? = null,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val scope = rememberCoroutineScope()
    val haptics = rememberAppHaptics()

    val working by store.working.collectAsState()
    val status by store.status.collectAsState()
    val sessionList by store.list.collectAsState()
    val queued by store.queued.collectAsState()
    val uncertain by store.uncertain.collectAsState()
    val sendState by store.sendState.collectAsState()
    val connection by store.connection.collectAsState()
    val connected = acceptsMessages && (connection is RiffetConnectionState.Live || connection is RiffetConnectionState.Connecting)

    val drafts = LocalComposerDrafts.current
    val draft = remember(drafts, session.id) { drafts?.draftFor(session.id) ?: ComposerDraft() }
    var text by draft.text
    var attachments by draft.attachments
    var references by draft.references
    SideEffect { drafts?.save(session.id, draft) }
    DisposableEffect(drafts, session.id) {
        onDispose { drafts?.save(session.id, draft) }
    }
    var thumbnails by remember(session.id) { mutableStateOf<Map<String, ImageBitmap>>(emptyMap()) }
    val inputFocus = remember { FocusRequester() }
    var uploading by remember(session.id) { mutableStateOf(false) }
    // Keep renderable copy rather than freezing the language when a validation or upload fails.
    var localError by remember(session.id) { mutableStateOf<(@Composable () -> String)?>(null) }
    var slash by remember(session.id) { mutableStateOf<NativeSlashCatalog?>(null) }

    // Discovery can spawn the backend's CLI; the menu simply stays closed until it answers.
    LaunchedEffect(session.id, session.backendId, session.backendProfileId) {
        slash = try {
            store.slashCatalog(session)
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (_: Throwable) {
            null
        }
    }

    LaunchedEffect(quote) {
        val quoted = quote ?: return@LaunchedEffect
        val block = quoted.text.lines().joinToString("\n") { "> $it" }
        text = if (text.isBlank()) "$block\n\n" else "${text.trimEnd()}\n\n$block\n\n"
        drafts?.save(session.id, draft)
        inputFocus.requestFocus()
    }

    LaunchedEffect(restoreRun?.id) {
        val run = restoreRun ?: return@LaunchedEffect
        try {
            val restored = store.takeBackQueued(run) ?: return@LaunchedEffect
            if (text.isBlank()) text = restored.text else if (text != restored.text) text += "\n\n${restored.text}"
            attachments = attachments + restored.attachments.filter { saved -> attachments.none { it.id == saved.id } }
            references = riffet.shared.mergeRestoredReferences(references, restored.context)
            inputFocus.requestFocus()
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Throwable) {
            localError = { error.message ?: stringResource(Res.string.composer_restore_failed) }
        } finally {
            drafts?.save(session.id, draft)
            onRestoreHandled(run)
        }
    }

    val picker = rememberAttachmentPicker(onError = { message -> localError = { message } }) { picked ->
        if (picked.isEmpty()) return@rememberAttachmentPicker
        if (uploading) {
            localError = { stringResource(Res.string.composer_attachment_uploading) }
            return@rememberAttachmentPicker
        }
        if (attachments.size + picked.size > MAX_ATTACHMENTS_PER_MESSAGE) {
            localError = { stringResource(Res.string.composer_attachments_limit, MAX_ATTACHMENTS_PER_MESSAGE) }
            return@rememberAttachmentPicker
        }
        val tooLarge = picked.firstOrNull { it.bytes.size > MAX_ATTACHMENT_BYTES }
        if (tooLarge != null) {
            localError = { stringResource(Res.string.composer_attachment_too_large, tooLarge.name) }
            return@rememberAttachmentPicker
        }
        scope.launch {
            uploading = true
            localError = null
            try {
                val uploaded = picked.map { store.uploadAttachment(it) }
                attachments = attachments + uploaded
                picked.zip(uploaded).forEach { (item, attachment) ->
                    item.thumbnail?.let { thumbnails = thumbnails + (attachment.id to it) }
                }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Throwable) {
                localError = { error.message ?: stringResource(Res.string.composer_attachment_upload_failed) }
            } finally {
                drafts?.save(session.id, draft)
                uploading = false
            }
        }
    }

    val awaitingSubmission = uncertain.any { it.native?.stage == "http_unknown" }

    fun submit(enqueue: Boolean = false) {
        val prompt = text.trim()
        if (prompt.isEmpty() || uploading || !connected || awaitingSubmission) return
        localError = null
        store.clearComposerMessages()
        onSubmit()
        val completion = draft.submit(writeScope ?: scope, { drafts?.save(session.id, draft) }) { submitted, sent, sentContext, onStored ->
            if (enqueue) store.enqueue(submitted, sent, sentContext, onStored) else store.send(submitted, sent, sentContext, false, onStored)
        }
        scope.launch {
            if (completion.await()) {
                val retained = attachments.mapTo(mutableSetOf()) { it.id }
                thumbnails = thumbnails.filterKeys { it in retained }
                haptics.performHapticFeedback(HapticFeedbackType.Confirm)
            }
        }
    }

    val busy = sendState.sending || sendState.interrupting
    Column(
        modifier = modifier
            .fillMaxWidth()
            // The docks above the card too: expanding the todo list or editing a queued message
            // mid-sentence must not close the keyboard.
            .keepsFocusOnTap()
            .padding(start = maxOf(24.dp, metrics.pageInset), end = maxOf(24.dp, metrics.pageInset),
                top = metrics.controlInset / 2, bottom = maxOf(12.dp, metrics.tabBarBottomInset)),
        verticalArrangement = Arrangement.spacedBy(metrics.controlInset / 3),
    ) {
        // Dock order matches the web's `ComposerDock`: the goal, then the todos, then the queue. A
        // goal is what the session is *for*, so it reads above the checklist that serves it.
        goal?.let { GoalDock(goal = it) }
        TodoDock(todos = todos)

        if (queued.isNotEmpty()) {
            QueueSection(
                queued = queued,
                running = working && supportsTargetedStop,
                unconfirmed = status?.queue?.held?.reason == riffet.contracts.NativeQueueHoldReason.UNCONFIRMED,
                pendingRunIds = sendState.pendingRunIds,
                enabled = connected && !busy,
                onSendNow = { run -> if (supportsTargetedStop) scope.launch { store.sendQueuedNow(run) } },
                onSteer = if (supportsSteer && status?.activeTurn != null) ({ run ->
                    val target = status?.activeTurn?.target()
                    if (target != null) { scope.launch { store.steerQueued(run, target) } }
                }) else null,
                steerEnabled = connection is RiffetConnectionState.Live && status?.phase == riffet.contracts.NativeStatusPhase.BUSY && status?.interaction == null && uncertain.isEmpty(),
                onEdit = { run ->
                    scope.launch {
                        val restored = store.takeBackQueued(run) ?: return@launch
                        // The web's restoreDraft: the queued text goes first, anything typed meanwhile stays.
                        text = if (text.isBlank()) restored.text else "${restored.text}\n$text"
                        attachments = restored.attachments.filter { saved -> attachments.none { it.id == saved.id } } + attachments
                        references = riffet.shared.mergeRestoredReferences(references, restored.context)
                        drafts?.save(session.id, draft)
                        inputFocus.requestFocus()
                    }
                },
                onCancel = { run -> scope.launch { store.cancelRun(run) } },
            )
        }

        // A terminal holding the conversation is its only writer: the bar takes the card's place.
        if (session.terminalHold != null) TerminalHoldBar(store = store, sessionId = session.id) else ComposerCard(
            text = text,
            onTextChange = { text = it },
            placeholder = stringResource(if (!connected) Res.string.composer_placeholder_offline else if (store.prefersSteerWhileRunning()) Res.string.composer_placeholder_steer else if (working) Res.string.composer_placeholder_queued else Res.string.composer_placeholder_online),
            attachments = attachments,
            thumbnails = thumbnails,
            uploading = uploading,
            onRemoveAttachment = { id ->
                attachments = attachments.filterNot { it.id == id }
                thumbnails = thumbnails - id
            },
            onAttach = if (picker.available) ({ picker.launch() }) else null,
            settings = settings,
            running = working,
            background = background,
            onStop = if (supportsTargetedStop) ({ scope.launch { store.interrupt() }; Unit }) else null,
            stopping = sendState.interrupting,
            stopEnabled = (working || background > 0) && connected && !busy,
            sendEnabled = connected && text.isNotBlank() && !uploading && !busy && !awaitingSubmission,
            sendBusy = sendState.sending,
            onSend = { submit() },
            onQueue = if (store.prefersSteerWhileRunning()) ({ submit(enqueue = true) }) else null,
            sendDescription = if (sessionList.settings?.composerRunningBehavior == "steer" && store.prefersSteerWhileRunning()) stringResource(Res.string.composer_steer_action) else if (working) stringResource(Res.string.composer_send_queued) else stringResource(Res.string.composer_send),
            allowCompact = true,
            focusRequester = inputFocus,
            slash = slash,
            sessionCandidates = if (supportsSessionReferences) sessionList.sessions else emptyList(),
            sessionProjects = sessionList.projects,
            referenceSessionId = session.id,
            referenceProjectId = session.projectId,
            sessionReferences = references.filter { it.kind == "session" },
            onReferenceSession = { selected: Session ->
                if (references.count { it.kind == "session" } >= 5) localError = { stringResource(Res.string.session_reference_limit) }
                else if (references.none { it.sessionId == selected.id }) references = references + sessionReference(selected)
            }.takeIf { supportsSessionReferences },
            onOpenSessionReference = riffet.ui.timeline.LocalSessionReferenceOpen.current?.let { open -> { reference ->
                drafts?.save(session.id, draft)
                reference.sessionId?.let(open)
            } },
            onRemoveSessionReference = { reference -> references = references - reference },
        )

        // One block, so the column's gap below the card is paid once, and only while it is open.
        Reveal(ComposerNotices(references, localError?.invoke(), sendState.error).takeIf { it.any }) { notices ->
            Column(verticalArrangement = Arrangement.spacedBy(metrics.controlInset / 3)) {
                notices.references.filter { it.kind != "session" }.forEach { reference ->
                    riffet.ui.design.RiffetTextButton(onClick = { references = references - reference }) {
                        Text(stringResource(Res.string.composer_quote_reference, reference.path + reference.line?.let { ":$it" }.orEmpty()))
                    }
                }
                notices.local?.let { message ->
                    Text(text = message, style = typography.caption, color = colors.danger)
                }
                notices.send?.let { message ->
                    Text(text = message, style = typography.caption, color = colors.danger)
                }
            }
        }
        // Submission recovery is attached to its timeline message. Composer notices must not
        // repeat it or survive after an incoming receipt has corrected that message.
    }
}

/** What sits under the input card: quoted references and the two error lines; [any] is whether there is something to show. */
private data class ComposerNotices(val references: List<PromptContextReference>, val local: String?, val send: String?) {
    val any: Boolean get() = references.isNotEmpty() || local != null || send != null
}

/**
 * A shared light outline for the goal and todo docks above the filled composer.
 */
internal val ComposerOutline = 0.75.dp

/**
 * The composer card itself, shared by the session dock and the project home's hero composer.
 *
 * @param running a turn is in flight: the send button queues, and with an empty draft it is a stop.
 * @param background background work alone (no turn) also offers the stop; the send button stays a send.
 * @param allowCompact collapse to the input alone while unfocused and empty (the dock only).
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun ComposerCard(
    text: String,
    onTextChange: (String) -> Unit,
    placeholder: String,
    attachments: List<Attachment>,
    thumbnails: Map<String, ImageBitmap>,
    uploading: Boolean,
    onRemoveAttachment: (String) -> Unit,
    onAttach: (() -> Unit)?,
    settings: ComposerSettings?,
    sendEnabled: Boolean,
    sendBusy: Boolean,
    onSend: () -> Unit,
    sendDescription: String? = null,
    modifier: Modifier = Modifier,
    hero: Boolean = false,
    /** Minimum visible editor lines on the new-session page; session composers keep their own size. */
    heroMinLines: Int = 1,
    running: Boolean = false,
    /** Background subagents running while idle: the stop button shows for them too, as "停止后台任务". */
    background: Int = 0,
    onStop: (() -> Unit)? = null,
    onQueue: (() -> Unit)? = null,
    stopping: Boolean = false,
    stopEnabled: Boolean = false,
    allowCompact: Boolean = false,
    focusRequester: FocusRequester = remember { FocusRequester() },
    /** The `/` menu's catalog; null offers no menu. */
    slash: NativeSlashCatalog? = null,
    sessionCandidates: List<Session> = emptyList(),
    sessionProjects: List<riffet.contracts.Project> = emptyList(),
    referenceSessionId: String? = null,
    referenceProjectId: String? = null,
    sessionReferences: List<PromptContextReference> = emptyList(),
    onReferenceSession: ((Session) -> Unit)? = null,
    onOpenSessionReference: ((PromptContextReference) -> Unit)? = null,
    onRemoveSessionReference: ((PromptContextReference) -> Unit)? = null,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val motion = LocalRiffetMotion.current
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    rememberResourceEnvironment()
    val stoppable = stopping || running || background > 0
    val stopDescription = if (stopping) L10n.uiText("activity.state.stopping") else if (running) stringResource(Res.string.composer_stop) else stringResource(Res.string.composer_stop_background)
    val shape = RoundedCornerShape(LocalInterfaceStyle.current.composerRadius)
    val interactionSource = remember { MutableInteractionSource() }
    val scrollState = rememberScrollState()
    var focused by remember { mutableStateOf(false) }
    val compact = allowCompact && !focused && text.isEmpty() && attachments.isEmpty() && sessionReferences.isEmpty() && !uploading
    // The tonal composer's size describes the whole capsule, including its action row.
    // Applying composerMinHeight to the text field alone made an empty hero unnecessarily tall.
    val tonalHero = hero && LocalInterfaceStyle.current.components.composer.tonal
    val footerHeight = metrics.controlHeight + metrics.controlInset
    val inputMinHeight = (if (tonalHero) metrics.composerMinHeight - footerHeight else metrics.inputMinHeight)
        .coerceAtLeast(metrics.inputMinHeight)
    val inputMaxHeight = (metrics.composerMaxHeight - footerHeight)
        .coerceAtLeast(inputMinHeight)
    // The caller owns the text; the selection lives here, because the `/` menu reads the caret.
    // A text set from outside (a quote, a cleared draft) puts the caret at its end.
    var field by remember { mutableStateOf(TextFieldValue(text, TextRange(text.length))) }
    val value = if (field.text == text) field else TextFieldValue(text, TextRange(text.length))
    val trigger = if (slash != null && focused && value.selection.collapsed) detectSlashTrigger(value.text, value.selection.start) else null
    val slashGroups = if (slash != null && trigger != null) slash.groupsFor(trigger) else emptyList()
    var referenceHighlight by remember { mutableStateOf(0) }
    var dismissedMention by remember { mutableStateOf<Pair<String, Int>?>(null) }
    val mention = if (onReferenceSession != null && focused && value.selection.collapsed && dismissedMention != (value.text to value.selection.start))
        Regex("(?:^|\\s)@([^\\s@]*)$").find(value.text.take(value.selection.start)) else null
    val mentionQuery = mention?.groupValues?.get(1)
    val mentionStart = mentionQuery?.let { value.selection.start - it.length - 1 }
    val referenceItems = rankedSessionReferences(sessionCandidates, sessionProjects, mentionQuery.orEmpty(), referenceSessionId, referenceProjectId)

    LaunchedEffect(text) {
        if (scrollState.maxValue > 0) scrollState.scrollTo(scrollState.maxValue)
    }

    // Android keeps focus in the field when the keyboard is put away (back, the keyboard's own hide
    // key), so the dock stayed open around an empty draft. Putting the keyboard away is leaving the
    // composer: focus goes, and so does a draft of nothing but blank lines (a return the keyboard
    // commits around a send), so the dock folds back to its resting state. A hardware keyboard never
    // shows the soft one and is left alone.
    if (allowCompact) {
        val ime = WindowInsets.ime
        val density = LocalDensity.current
        val focusManager = LocalFocusManager.current
        val currentText by rememberUpdatedState(text)
        val textChange by rememberUpdatedState(onTextChange)
        val hasFocus by rememberUpdatedState(focused)
        LaunchedEffect(ime, density) {
            var shown = false
            snapshotFlow { ime.getBottom(density) > 0 }.collect { open ->
                if (shown && !open && hasFocus) {
                    focusManager.clearFocus()
                    if (currentText.isNotEmpty() && currentText.isBlank()) textChange("")
                }
                shown = open
            }
        }
    }

    // On the session page, the body yields space to the footer and scrolls when the keyboard shrinks
    // the viewport. The home composer keeps its intrinsic input height inside its scrolling page.
    Column(
        modifier = modifier
            .fillMaxWidth()
            .keepsFocusOnTap()
            // The home's composer is the page itself, not a layer over it: nothing scrolls behind it
            // to blur, so it is the page's solid card (the settings cards' fill), the strongest
            // surface on the page, and the tools under it stay quieter. In a session it floats over
            // the transcript as glass.
            .then(if (hero) Modifier else Modifier.floatingShadow(shape, lifted = focused))
            .clip(shape)
            .then(if (hero) Modifier.background(materialContentBackground(LocalRiffetSurfaces.current.card), shape)
                else Modifier.riffetMaterial(MaterialRole.COMPOSER, shape, LocalRiffetSurfaces.current.floating)),
    ) {
        RiffetMaterialContent {
        Column(if (hero) Modifier else Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())) {
        if (sessionReferences.isNotEmpty()) {
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = metrics.controlInset, vertical = metrics.controlInset / 3)) {
                sessionReferences.forEach { reference ->
                    if (LocalInterfaceStyle.current.components.controls.chips != ComponentBackend.MATERIAL) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            TextButton(onClick = { onOpenSessionReference?.invoke(reference) }, enabled = onOpenSessionReference != null) {
                                Icon(RiffetIcons.Message, null, modifier = Modifier.size(16.dp))
                                Spacer(Modifier.width(6.dp))
                                Text(reference.title ?: reference.sessionId.orEmpty(), maxLines = 1, overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.widthIn(max = 180.dp))
                            }
                            IconButton(onClick = { onRemoveSessionReference?.invoke(reference) }, enabled = onRemoveSessionReference != null) {
                                Icon(RiffetIcons.Close, stringResource(Res.string.session_reference_remove), modifier = Modifier.size(14.dp))
                            }
                        }
                    } else androidx.compose.material3.InputChip(
                        selected = false,
                        onClick = { onOpenSessionReference?.invoke(reference) },
                        label = { Text(reference.title ?: reference.sessionId.orEmpty(), maxLines = 1) },
                        trailingIcon = { IconButton(onClick = { onRemoveSessionReference?.invoke(reference) }, modifier = Modifier.size(28.dp)) {
                            Icon(RiffetIcons.Close, contentDescription = stringResource(Res.string.session_reference_remove), Modifier.size(14.dp))
                        } },
                    )
                }
            }
        }
        if (mention != null) {
            Column(Modifier.fillMaxWidth().heightIn(max = 220.dp).verticalScroll(rememberScrollState()).padding(horizontal = metrics.controlInset / 2)) {
                Text(stringResource(Res.string.session_reference_group), style = typography.caption, color = colors.fg4, modifier = Modifier.padding(8.dp))
                referenceItems.forEach { candidate ->
                    riffet.ui.design.RiffetTextButton(onClick = {
                        onReferenceSession?.invoke(candidate)
                        if (mentionStart != null) {
                            val next = value.text.removeRange(mentionStart, value.selection.start)
                            field = TextFieldValue(next, TextRange(mentionStart)); onTextChange(next)
                        }
                    }, modifier = Modifier.fillMaxWidth()) {
                        Column(Modifier.fillMaxWidth()) {
                            Text(candidate.title, color = colors.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(listOfNotNull(sessionProjects.firstOrNull { it.id == candidate.projectId }?.name, candidate.agent).joinToString(" · "),
                                style = typography.caption, color = colors.fg3, maxLines = 1)
                        }
                    }
                }
                if (referenceItems.isEmpty()) Text(stringResource(Res.string.session_reference_no_match), style = typography.caption, color = colors.fg3, modifier = Modifier.padding(8.dp))
            }
            SlashMenuDivider()
        }

        Reveal(attachments.takeIf { it.isNotEmpty() }) { shown ->
            AttachmentChips(
                attachments = shown,
                thumbnails = thumbnails,
                onRemove = onRemoveAttachment,
                modifier = Modifier.padding(start = metrics.controlInset, end = metrics.controlInset, top = metrics.controlInset * 5 / 6),
            )
        }

        Reveal(if (trigger != null && slashGroups.isNotEmpty()) trigger to slashGroups else null) { (open, groups) ->
            Column {
                SlashMenu(
                    groups = groups,
                    onPick = pick@{ item ->
                        // The menu may still be on its way out with the trigger it opened for: ignore a
                        // pick the draft no longer matches.
                        val caret0 = value.selection.start
                        if (!value.selection.collapsed || open.start !in 0..caret0 || caret0 > value.text.length) return@pick
                        val (next, caret) = applySlashPick(value.text, caret0, open, item)
                        field = TextFieldValue(next, TextRange(caret))
                        onTextChange(next)
                    },
                )
                SlashMenuDivider()
            }
        }

        Row(verticalAlignment = Alignment.CenterVertically) {
            BasicTextField(
                value = value,
                minLines = if (hero) heroMinLines else 1,
                onValueChange = { next ->
                    field = next
                    if (next.text != text) onTextChange(next.text)
                },
                textStyle = typography.input.copy(color = colors.fg),
                cursorBrush = SolidColor(LocalRiffetSurfaces.current.focus),
                interactionSource = interactionSource,
                modifier = Modifier
                    .weight(1f)
                    .heightIn(min = inputMinHeight, max = inputMaxHeight)
                    .focusRequester(focusRequester)
                    // `hasFocus`: the scroll container below is its own focus group, so the text field
                    // inside it is never the node this observer reports as `isFocused`.
                    .onFocusChanged { focused = it.hasFocus }
                    .verticalScroll(scrollState)
                    .onPreviewKeyEvent { event ->
                        // Hardware Enter sends; the soft keyboard's return key is not a key event and
                        // keeps inserting a newline.
                        val plainEnter = event.type == KeyEventType.KeyDown && event.key == Key.Enter &&
                            !event.isShiftPressed && !event.isCtrlPressed && !event.isMetaPressed && !event.isAltPressed
                        if (event.type == KeyEventType.KeyDown && mention != null && referenceItems.isNotEmpty() && event.key in listOf(Key.DirectionDown, Key.DirectionUp)) {
                            referenceHighlight = (referenceHighlight + (if (event.key == Key.DirectionDown) 1 else -1) + referenceItems.size) % referenceItems.size
                            true
                        } else if (event.type == KeyEventType.KeyDown && event.key == Key.Escape && mention != null) {
                            dismissedMention = value.text to value.selection.start
                            true
                        } else if (plainEnter && mention != null && referenceItems.isNotEmpty()) {
                            onReferenceSession?.invoke(referenceItems[referenceHighlight.coerceIn(referenceItems.indices)])
                            val start = mentionStart ?: value.selection.start
                            val next = value.text.removeRange(start, value.selection.start)
                            field = TextFieldValue(next, TextRange(start)); onTextChange(next)
                            true
                        } else if (plainEnter && sendEnabled) {
                            onSend()
                            true
                        } else {
                            false
                        }
                    },
                decorationBox = { inner ->
                    // The card owns the container and the editor's height. A native filled-field
                    // decoration adds another minimum height and unnecessary space above the text.
                    // The single-line dock centres its text, and with it the placeholder, in the field's
                    // minimum height; the multi-line hero keeps its text at the top.
                    Box(Modifier.heightIn(min = if (hero) 0.dp else inputMinHeight)
                        .padding(horizontal = metrics.inputInset, vertical = metrics.controlInset * 2 / 3),
                        contentAlignment = if (hero) Alignment.TopStart else Alignment.CenterStart) {
                        if (value.text.isEmpty()) {
                            Text(text = placeholder, style = typography.input, color = colors.fg3,
                                maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        inner()
                    }
                },
            )
            AnimatedVisibility(visible = compact && stoppable && onStop != null, enter = motion.popIn(), exit = motion.popOut()) {
                Box(Modifier.padding(end = 4.dp)) {
                    RoundAction(
                        icon = RiffetIcons.Stop,
                        description = stopDescription,
                        enabled = stopEnabled && !stopping,
                        busy = stopping,
                        background = LocalRiffetSurfaces.current.primaryAction,
                        tint = LocalRiffetSurfaces.current.primaryActionContent,
                        onClick = { onStop?.invoke() },
                    )
                }
            }
        }
        }

        // The footer opens with the keyboard's own motion instead of appearing in the middle of it.
        AnimatedVisibility(visible = !compact, enter = motion.expandIn(), exit = motion.collapseOut()) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(start = metrics.controlInset * 2 / 3, end = metrics.controlInset * 2 / 3, bottom = metrics.controlInset * 2 / 3, top = metrics.controlInset / 6),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (onAttach != null) {
                    IconButton(onClick = onAttach, enabled = !uploading) {
                        if (uploading) {
                            val uploadingLabel = stringResource(Res.string.composer_uploading)
                            CircularProgressIndicator(Modifier.size(metrics.buttonIconSize).semantics { stateDescription = uploadingLabel },
                                strokeWidth = metrics.focusWidth, color = colors.fg3)
                        } else Icon(RiffetIcons.Plus, stringResource(Res.string.composer_add_attachment),
                            tint = colors.fg, modifier = Modifier.size(metrics.iconSize))
                    }
                    Spacer(Modifier.width(metrics.controlInset * 2 / 3))
                }
                // The settings chip takes whatever the send button leaves and truncates only then.
                // Context occupancy is not here: it is a detail of the model, so it lives in the
                // sheet this chip opens.
                Box(modifier = Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
                    if (settings != null) SettingsChip(settings)
                }
                Spacer(Modifier.width(metrics.controlInset * 2 / 3))
                // Send and stop trade places with a quick scale and fade, not a cut.
                AnimatedContent(
                    targetState = stoppable && (stopping || text.isBlank()) && onStop != null,
                    transitionSpec = { motion.popIn() togetherWith motion.popOut() using null },
                    label = "sendOrStop",
                ) { showStop ->
                    if (showStop) {
                        RoundAction(
                            icon = RiffetIcons.Stop,
                            description = stopDescription,
                            enabled = stopEnabled && !stopping,
                            busy = stopping,
                            background = LocalRiffetSurfaces.current.primaryAction,
                            tint = LocalRiffetSurfaces.current.primaryActionContent,
                            onClick = { onStop?.invoke() },
                        )
                    } else {
                        var menuOpen by remember { mutableStateOf(false) }
                        Box {
                            RoundAction(
                                icon = RiffetIcons.Send,
                                description = sendDescription ?: if (running) stringResource(Res.string.composer_send_queued) else stringResource(Res.string.composer_send),
                                enabled = sendEnabled,
                                busy = sendBusy,
                                background = LocalRiffetSurfaces.current.primaryAction,
                                tint = LocalRiffetSurfaces.current.primaryActionContent,
                                onClick = onSend,
                                onLongClick = if (onQueue != null || running && onStop != null) ({ menuOpen = true }) else null,
                            )
                            RiffetDropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                                if (onQueue != null) RiffetMenuItem(text = stringResource(Res.string.composer_send_queued), icon = RiffetIcons.Send, enabled = sendEnabled, onClick = { menuOpen = false; onQueue() })
                                if (running && onStop != null) RiffetMenuItem(text = stopDescription, icon = RiffetIcons.Stop, enabled = stopEnabled && !stopping, onClick = { menuOpen = false; onStop() })
                            }
                        }
                    }
                }
            }
        }
    }
    }
}

/**
 * The model as plain text with its mark: no fill and no chevron, because the footer is narrow and
 * the label already reads as the thing to tap. While the catalog loads or fails, the mark's slot
 * holds the spinner or the warning, so the label never shifts.
 */
@Composable
private fun SettingsChip(settings: ComposerSettings, modifier: Modifier = Modifier) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val style = LocalInterfaceStyle.current
    val settingsSurface = style.components.composer.settingsSurface
    val ink = if (!settings.enabled) LocalRiffetSurfaces.current.disabledContent else if (settingsSurface) colors.fg2 else colors.accent
    Row(
        modifier = modifier
            .heightIn(min = metrics.controlHeight)
            .clip(RoundedCornerShape(style.controlRadius))
            .clickable(enabled = settings.enabled, onClickLabel = stringResource(Res.string.composer_send_settings), role = Role.Button, onClick = settings.onOpen)
            .padding(horizontal = metrics.controlInset / 2),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // A chip with an icon shows the catalog's state in the icon's place; one without (the
        // conversation's, led by the permission's name) shows it after the model, so the name
        // never moves while the catalog loads.
        val leading = settings.icon != null
        val status = settings.loading || settings.switching || settings.error
        val indicator: @Composable () -> Unit = {
            Box(modifier = Modifier.size(metrics.smallIconSize), contentAlignment = Alignment.Center) {
                when {
                    settings.loading || settings.switching -> {
                        val loadingLabel = if (settings.loading) stringResource(Res.string.pickers_catalog_loading) else stringResource(Res.string.pickers_switching)
                        CircularProgressIndicator(
                            modifier = Modifier.size(14.dp).semantics { stateDescription = loadingLabel },
                            strokeWidth = 1.5.dp,
                            color = colors.fg3,
                        )
                    }
                    settings.error -> {
                        val failedLabel = stringResource(Res.string.session_catalog_read_failed)
                        Icon(RiffetIcons.Warning, contentDescription = null, tint = colors.danger,
                            modifier = Modifier.size(metrics.smallIconSize).semantics { stateDescription = failedLabel })
                    }
                    else -> settings.icon?.let { Icon(it, contentDescription = null, tint = settings.iconTint ?: ink, modifier = Modifier.size(metrics.smallIconSize)) }
                }
            }
        }
        if (leading) {
            indicator()
            Spacer(Modifier.width(metrics.controlInset / 2))
        }
        settings.prefix?.let { prefix ->
            Text(text = prefix, style = typography.buttonSmall, color = if (settings.prefixRisky && settings.enabled) colors.warning else ink, maxLines = 1)
            Text(text = " · ", style = typography.buttonSmall, color = if (settings.enabled) colors.fg4 else ink, maxLines = 1)
        }
        Text(text = settings.label, style = typography.buttonSmall, color = ink, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        if (!leading && status) {
            Spacer(Modifier.width(metrics.controlInset / 2))
            indicator()
        }
    }
}

@Composable
private fun RoundAction(
    icon: ImageVector,
    description: String,
    enabled: Boolean,
    background: androidx.compose.ui.graphics.Color,
    tint: androidx.compose.ui.graphics.Color,
    onClick: () -> Unit,
    busy: Boolean = false,
    onLongClick: (() -> Unit)? = null,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val motion = LocalRiffetMotion.current
    val colors = LocalRiffetColors.current
    val style = LocalInterfaceStyle.current
    val recipe = style.components.composer
    val actionShape = if (recipe.rectangularAction) RoundedCornerShape(style.controlRadius) else CircleShape
    val source = remember { MutableInteractionSource() }
    val focused by source.collectIsFocusedAsState()
    val plainStop = !recipe.tonal && icon == RiffetIcons.Stop
    // Enabled and disabled controls share the active style state layers.
    val fill = animateColorAsState(if (plainStop) Color.Transparent else if (enabled) background else LocalRiffetSurfaces.current.press, motion.effects(), label = "actionFill")
    val iconTint by animateColorAsState(if (!enabled) LocalRiffetSurfaces.current.disabledContent else if (plainStop) colors.danger else tint, motion.effects(), label = "actionTint")
    Box(
        modifier = Modifier
            .size(metrics.controlHeight)
            .clip(actionShape)
            .drawBehind {
                val visual = minOf(metrics.sendButtonSize.toPx(), size.minDimension)
                if (recipe.rectangularAction) drawRoundRect(fill.value,
                    topLeft = Offset((size.width - visual) / 2, (size.height - visual) / 2),
                    size = Size(visual, visual), cornerRadius = CornerRadius(style.controlRadius.toPx()))
                else drawCircle(fill.value, radius = visual / 2)
            }
            .then(if (focused) Modifier.border(metrics.focusWidth, LocalRiffetSurfaces.current.focus, actionShape) else Modifier)
            .semantics { if (busy) stateDescription = description }
            .combinedClickable(interactionSource = source, indication = LocalIndication.current,
                role = Role.Button, enabled = enabled, onClick = onClick, onLongClick = onLongClick,
                onLongClickLabel = stringResource(Res.string.timeline_more_actions)),
        contentAlignment = Alignment.Center,
    ) {
        Crossfade(targetState = busy, animationSpec = motion.short(), label = "actionBusy") { working ->
            if (working) {
                CircularProgressIndicator(modifier = Modifier.size(metrics.buttonIconSize), strokeWidth = metrics.focusWidth, color = colors.fg3)
            } else {
                Icon(icon, contentDescription = description, tint = iconTint, modifier = Modifier.size(metrics.buttonIconSize))
            }
        }
    }
}

@Composable
private fun QueueSection(
    queued: List<Run>,
    running: Boolean,
    /** An earlier message whose delivery is unconfirmed holds the queue; it is settled on that message. */
    unconfirmed: Boolean = false,
    pendingRunIds: Set<String>,
    enabled: Boolean,
    onSendNow: (Run) -> Unit,
    onSteer: ((Run) -> Unit)? = null,
    steerEnabled: Boolean = false,
    onEdit: (Run) -> Unit,
    onCancel: (Run) -> Unit,
) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        if (queued.isNotEmpty()) {
            QueueDock(
                runs = queued,
                running = running,
                unconfirmed = unconfirmed,
                pendingRunIds = pendingRunIds,
                enabled = enabled,
                onSendNow = onSendNow,
                onSteer = onSteer,
                steerEnabled = steerEnabled,
                onEdit = onEdit,
                onRemove = onCancel,
            )
        }


    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AttachmentChips(
    attachments: List<Attachment>,
    thumbnails: Map<String, ImageBitmap>,
    onRemove: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val motion = LocalRiffetMotion.current
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    FlowRow(
        modifier = modifier.fillMaxWidth().animateContentSize(motion.spatial()),
        horizontalArrangement = Arrangement.spacedBy(metrics.controlInset / 3),
        verticalArrangement = Arrangement.spacedBy(metrics.controlInset / 3),
    ) {
        attachments.forEach { attachment ->
            val thumbnail = thumbnails[attachment.id]
            Row(
                modifier = Modifier
                    .background(if (LocalInterfaceStyle.current.components.composer.tonal) LocalRiffetSurfaces.current.card else Color.Transparent, RoundedCornerShape(LocalInterfaceStyle.current.controlRadius))
                    .padding(start = 6.dp, end = 2.dp, top = 2.dp, bottom = 2.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (thumbnail != null) {
                    Image(
                        bitmap = thumbnail,
                        contentDescription = null,
                        modifier = Modifier.size(metrics.iconSize).background(colors.bg, RoundedCornerShape(metrics.controlRadius / 2)),
                    )
                } else {
                    Icon(
                        if (attachment.mimeType.startsWith("image/")) RiffetIcons.Image else RiffetIcons.Message,
                        contentDescription = null,
                        tint = colors.fg3,
                        modifier = Modifier.size(14.dp),
                    )
                }
                Spacer(Modifier.width(6.dp))
                Text(
                    text = attachment.name,
                    style = typography.caption,
                    color = colors.fg2,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.width(120.dp),
                )
                IconAction(
                    icon = RiffetIcons.Close,
                    description = stringResource(Res.string.composer_remove_attachment),
                    enabled = true,
                    onClick = { onRemove(attachment.id) },
                )
            }
        }
    }
}

/**
 * The web's `QueueDock`: one card above the input. A single message is one row; several fold
 * under a "N 条排队消息" header. Each row keeps its actions as always-visible icons — 停止并发送
 * (only while a turn runs, since it interrupts it), 编辑 (back into the input) and 移出队列.
 */
@Composable
private fun QueueDock(
    runs: List<Run>,
    running: Boolean,
    /** An earlier message whose delivery is unconfirmed holds the queue; it is settled on that message. */
    unconfirmed: Boolean = false,
    pendingRunIds: Set<String>,
    enabled: Boolean,
    onSendNow: (Run) -> Unit,
    onSteer: ((Run) -> Unit)? = null,
    steerEnabled: Boolean = false,
    onEdit: (Run) -> Unit,
    onRemove: (Run) -> Unit,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val motion = LocalRiffetMotion.current
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    var open by remember { mutableStateOf(false) }
    val expandable = runs.size > 1
    val shape = RoundedCornerShape(LocalInterfaceStyle.current.groupRadius)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(LocalRiffetSurfaces.current.card)
            .cardEdge(shape)
            .padding(horizontal = 6.dp, vertical = 2.dp),
    ) {
        if (expandable) {
            val toggleLabel = if (open) stringResource(Res.string.composer_collapse) else stringResource(Res.string.composer_expand)
            val header: @Composable RowScope.() -> Unit = {
                Icon(RiffetIcons.Message, contentDescription = null, tint = colors.fg4, modifier = Modifier.size(14.dp))
                Spacer(Modifier.width(8.dp))
                Text(
                    text = stringResource(Res.string.composer_queued_count, runs.size),
                    style = if (LocalInterfaceStyle.current.components.composer.tonal) typography.label else typography.body,
                    color = if (LocalInterfaceStyle.current.components.composer.tonal) colors.fg else colors.accent,
                    modifier = Modifier.weight(1f),
                )
                Chevron(open, size = 14.dp, tint = colors.fg4, icon = RiffetIcons.ChevronDown, openAngle = 180f)
            }
            if (!LocalInterfaceStyle.current.components.composer.tonal) {
                TextButton(
                    onClick = { open = !open },
                    modifier = Modifier.fillMaxWidth().semantics {
                        stateDescription = toggleLabel
                    },
                    contentPadding = PaddingValues(horizontal = 6.dp),
                    content = header,
                )
            } else Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = metrics.controlHeight)
                    .clip(RoundedCornerShape(LocalInterfaceStyle.current.controlRadius))
                    .clickable(role = Role.Button, onClickLabel = if (open) stringResource(Res.string.composer_collapse) else stringResource(Res.string.composer_expand)) { open = !open }
                    .padding(horizontal = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                content = header,
            )
        }
        AnimatedVisibility(visible = !expandable || open, enter = motion.expandIn(), exit = motion.collapseOut()) {
            Column(Modifier.heightIn(max = 180.dp).verticalScroll(rememberScrollState())) {
                runs.forEach { run ->
                    // A send still submitting has no run on the server to act on yet.
                    val blocked = run.id in pendingRunIds || !enabled || !inQueue(run)
                    Row(
                        modifier = Modifier.fillMaxWidth().heightIn(min = metrics.controlHeight).padding(start = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        if (!expandable) {
                            Icon(RiffetIcons.Message, contentDescription = null, tint = colors.fg4, modifier = Modifier.size(14.dp))
                            Spacer(Modifier.width(8.dp))
                        }
                        Text(
                            text = run.prompt,
                            style = typography.bodySmall,
                            color = colors.fg2,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                        val usesSteer = onSteer != null && running && steerEnabled
                        if (usesSteer) {
                            IconAction(RiffetIcons.Steer, stringResource(Res.string.composer_steer_action), enabled = !blocked && running && steerEnabled, onClick = { onSteer(run) }, size = 44.dp)
                        } else {
                            IconAction(RiffetIcons.Send, stringResource(Res.string.composer_send_now), enabled = !blocked && running, onClick = { onSendNow(run) }, size = 44.dp)
                        }
                        var menuOpen by remember(run.id) { mutableStateOf(false) }
                        Box {
                            IconAction(RiffetIcons.Ellipsis, stringResource(Res.string.timeline_more_actions), enabled = !blocked, onClick = { menuOpen = true }, size = 44.dp)
                            RiffetDropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                                if (usesSteer) {
                                    RiffetMenuItem(
                                        text = stringResource(Res.string.composer_send_now),
                                        icon = RiffetIcons.Send,
                                        enabled = !blocked && running,
                                        onClick = { menuOpen = false; onSendNow(run) },
                                    )
                                } else if (onSteer != null) {
                                    RiffetMenuItem(
                                        text = stringResource(Res.string.composer_steer_action),
                                        icon = RiffetIcons.Steer,
                                        enabled = !blocked && running && steerEnabled,
                                        onClick = { menuOpen = false; onSteer(run) },
                                    )
                                }
                                RiffetMenuItem(
                                    text = stringResource(Res.string.composer_edit),
                                    icon = RiffetIcons.Pencil,
                                    enabled = !blocked,
                                    onClick = { menuOpen = false; onEdit(run) },
                                )
                                RiffetMenuItem(
                                    text = stringResource(Res.string.composer_remove_queued),
                                    icon = RiffetIcons.Trash,
                                    danger = true,
                                    enabled = !blocked,
                                    onClick = { menuOpen = false; onRemove(run) },
                                )
                            }
                        }
                    }
                }
            }
        }
        if (unconfirmed) {
            Text(
                text = stringResource(Res.string.composer_queue_unconfirmed),
                style = typography.caption,
                color = colors.fg3,
                modifier = Modifier.padding(start = 6.dp, bottom = 4.dp),
            )
        }
    }
}

@Composable
private fun IconAction(
    icon: ImageVector,
    description: String,
    enabled: Boolean,
    onClick: () -> Unit,
    size: androidx.compose.ui.unit.Dp = 36.dp,
) {
    val colors = LocalRiffetColors.current
    if (!LocalInterfaceStyle.current.components.composer.tonal) {
        IconButton(onClick = onClick, enabled = enabled) {
            Icon(icon, description, tint = if (enabled) colors.accent else LocalRiffetSurfaces.current.disabledContent, modifier = Modifier.size(16.dp))
        }
        return
    }
    Box(
        modifier = Modifier
            .size(size)
            .clip(CircleShape)
            .clickable(role = Role.Button, enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            icon,
            contentDescription = description,
            tint = if (enabled) colors.fg3 else LocalRiffetSurfaces.current.disabledContent,
            modifier = Modifier.size(16.dp),
        )
    }
}
