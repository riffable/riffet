package riffet.ui.timeline

import riffet.ui.design.LocalRiffetSurfaces
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.theme.LocalRiffetMotion
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import riffet.ui.design.ConfirmDialog
import riffet.ui.design.RiffetTextButton as TextButton
import androidx.compose.runtime.rememberCoroutineScope
import kotlinx.coroutines.launch
import riffet.ui.state.messageRecovery
import riffet.shared.NativeRunRecovery
import riffet.ui.icons.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.LinkInteractionListener
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import riffet.ui.focus.SelectableText
import riffet.core.ReasoningChannel
import riffet.contracts.NativeDeliveryState
import riffet.core.TimelineItem
import riffet.core.timelineItemTime
import riffet.ui.icons.RiffetIcons
import riffet.ui.state.canRestoreUnsentMessage
import riffet.ui.state.markable
import riffet_mobile.shared.generated.resources.*
import org.jetbrains.compose.resources.rememberResourceEnvironment
import org.jetbrains.compose.resources.stringResource

/*
 * The three rows that carry human and model prose: the prompt, the answer, and the reasoning.
 *
 * The web renders narration **inline, at the same size and line height as the answer**,
 * distinguished only by colour (`--fg-2` against `--fg`), and folds raw thinking to one row.
 */

private val IN_FLIGHT = setOf(NativeDeliveryState.QUEUED, NativeDeliveryState.PREPARING, NativeDeliveryState.DISPATCHING, NativeDeliveryState.INPUT_SENT)

/** Plain prompt text with bare web links annotated and optional find highlight overlaid. */
private fun userMessageText(
    text: String,
    highlight: FindHighlight?,
    mark: Color,
    linkColor: Color,
    linkListener: LinkInteractionListener,
): AnnotatedString {
    val links = findBareUrls(text)
    val findAt = findOccurrenceOffset(text, highlight)
    if (links.isEmpty() && findAt < 0) return AnnotatedString(text)
    val linkStyles = TextLinkStyles(style = SpanStyle(color = linkColor))
    return buildAnnotatedString {
        append(text)
        for (link in links) {
            addLink(LinkAnnotation.Url(link.url, linkStyles, linkListener), link.start, link.end)
        }
        if (findAt >= 0 && highlight != null) {
            addStyle(SpanStyle(background = mark), findAt, findAt + highlight.needle.length)
        }
    }
}

/** The prompt: right-aligned bubble, attachments, delivery state and time. */
@Composable
internal fun UserRow(item: TimelineItem.User, stopShown: Boolean = true, hasTurnOutput: Boolean = false) {
    // An answer another member handed back reads as theirs; a called conversation's first message shows the request, not the brief.
    val callDelivery = remember(item.text) { riffet.shared.parseCallDelivery(item.text) }
    if (callDelivery != null) {
        CallDeliveryRow(item, callDelivery)
        return
    }
    val shownText = remember(item.text) { riffet.shared.stripCallBrief(item.text) }
    rememberResourceEnvironment()
    val designMetrics = LocalInterfaceStyle.current.metrics
    val motion = LocalRiffetMotion.current
    val colors = TimelineTheme.colors
    val type = TimelineTheme.type
    val time = formatDateTime(timelineItemTime(item))
    // A turn stopped after the prompt arrived says so where it ends; only a prompt left with no output says it here.
    val delivery = if (item.failureShown) null else deliveryLabel(item.run, stopShown, hasTurnOutput)
    val deliveryError = if (item.failureShown) null else deliveryErrorDetails(item.run)
    // While it is on its way the status says enough; the time returns once it has arrived or settled.
    val sending = delivery != null && item.run?.let { run -> run.native?.delivery in IN_FLIGHT && !messageRecovery(run).needsCheck } == true
    var errorOpen by rememberSaveable(item.key, deliveryError) { mutableStateOf(false) }
    val restore = LocalRestoreNativeRun.current
    val recoverableRun = item.run?.takeIf(::canRestoreUnsentMessage)
    val recoveryStore = LocalRunRecoveryStore.current
    val scope = rememberCoroutineScope()
    var checking by remember(item.key) { mutableStateOf(false) }
    var checked by remember(item.key) { mutableStateOf<NativeRunRecovery?>(null) }
    var confirmContinue by remember(item.key) { mutableStateOf(false) }

    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.End,
    ) {
        Box(
            modifier = Modifier
                // The web caps this at `min(82%, 560px)`. On a phone the percentage is the binding
                // half, and a fixed cap keeps a one-word prompt from being a full-width band.
                .widthIn(max = 300.dp)
                .clip(RoundedCornerShape(LocalInterfaceStyle.current.groupRadius))
                .background(LocalRiffetSurfaces.current.selected)
                .padding(horizontal = 14.dp, vertical = 10.dp),
        ) {
            // The prompt is selectable: a browser gives the web this for free, and on Compose
            // `SelectionContainer` is that same native long-press/handles/Copy menu. It wraps
            // the bubble's text — one row, not the `LazyColumn` — so lazy item reuse is
            // untouched and a row that scrolls off simply unregisters its own selection.
            val find = LocalFindHighlight.current
            val findMark = colors.warningSoft
            val linkColor = colors.accent
            val uriHandler = LocalUriHandler.current
            val linkListener = remember(uriHandler) {
                LinkInteractionListener { annotation ->
                    if (annotation is LinkAnnotation.Url) runCatching { uriHandler.openUri(annotation.url) }
                }
            }
            val text = remember(shownText, find, findMark, linkColor, linkListener) {
                userMessageText(shownText, find, findMark, linkColor, linkListener)
            }
            // The marked line, for find to bring it into view in a prompt taller than the screen.
            val markedAt = remember(shownText, find) { findOccurrenceOffset(shownText, find).takeIf { it >= 0 } }
            val markLine = remember { FloatArray(2) }
            val anchor = LocalFindAnchor.current
            SelectableText {
                Text(
                    text = text,
                    style = TimelineTheme.prose.body,
                    color = colors.fg,
                    onTextLayout = { layout ->
                        val line = markedAt?.takeIf { it < layout.layoutInput.text.length }?.let(layout::getLineForOffset)
                        markLine[0] = line?.let(layout::getLineTop) ?: 0f
                        markLine[1] = line?.let(layout::getLineBottom) ?: 0f
                    },
                    modifier = Modifier.findAnchor(anchor, markedAt != null, remember(markLine) { { markLine[0] to markLine[1] } }),
                )
            }
        }
        item.references.forEach { reference ->
            SessionReferenceChip(reference, item.event.sessionId)
        }
        if (item.attachments.isNotEmpty()) {
            Spacer(Modifier.height(6.dp))
            MessageAttachments(item.attachments)
        }
        // Copy leads the delivery/time line under the bubble, the mirror of the answer's action row.
        // Delivery stays compact beside the time; the complete failure is opened below this row.
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.End,
            modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
        ) {
            if (recoverableRun != null && restore != null) {
                MessageMenuButton(shownText, onRestore = { restore(recoverableRun) })
            } else {
                CopyTextButton(shownText, stringResource(Res.string.timeline_copy_message))
            }
            if (delivery != null || time != null || item.from != null) {
                Spacer(Modifier.width(4.dp))
                if (item.from != null) {
                    Icon(RiffetIcons.Bot, null, modifier = Modifier.size(12.dp), tint = colors.fg3)
                    Spacer(Modifier.width(4.dp))
                    Text(
                        text = stringResource(if (item.from == "peer") Res.string.timeline_from_peer else Res.string.timeline_from_coordinator),
                        style = type.caption,
                        color = colors.fg3,
                        maxLines = 1,
                        softWrap = false,
                    )
                    Spacer(Modifier.width(4.dp))
                }
                if (item.run?.native?.intent == "steer") {
                    Icon(RiffetIcons.Steer, stringResource(Res.string.timeline_steer), modifier = Modifier.size(12.dp), tint = colors.fg3)
                    Spacer(Modifier.width(4.dp))
                }
                if (delivery != null) {
                    if (deliveryError != null) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(4.dp),
                            modifier = Modifier.weight(1f, fill = false)
                                .heightIn(min = designMetrics.controlHeight)
                                .clickable(
                                    role = Role.Button,
                                    onClickLabel = stringResource(if (errorOpen) Res.string.settings_collapse else Res.string.settings_expand),
                                ) { errorOpen = !errorOpen }
                                .padding(horizontal = 4.dp),
                        ) {
                            Text(
                                text = delivery,
                                style = type.caption,
                                color = colors.fg3,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f, fill = false),
                            )
                            Chevron(open = errorOpen, size = 12.dp)
                        }
                        Spacer(Modifier.width(8.dp))
                    } else {
                        Text(
                            text = delivery,
                            style = type.caption,
                            color = colors.fg3,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f, fill = false).padding(end = 8.dp),
                        )
                    }
                }
                if (time != null && !sending) {
                    Text(text = time, style = type.caption, color = colors.fg3, softWrap = false)
                }
            }
        }
        val run = item.run
        if (run != null && recoveryStore != null && messageRecovery(run).needsCheck) {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                TextButton(enabled = !checking, onClick = {
                    checking = true
                    scope.launch { try { checked = recoveryStore.checkRun(run) } finally { checking = false } }
                }) { Text(stringResource(Res.string.composer_check_status), style = type.caption) }
                if (messageRecovery(run).canRetry) {
                    TextButton(enabled = !checking, onClick = {
                        checking = true
                        scope.launch { try { recoveryStore.retryRun(run) } finally { checking = false } }
                    }) { Text(stringResource(Res.string.composer_retry_request), style = type.caption) }
                }
                if (checked?.canContinue == true) {
                    TextButton(enabled = !checking, onClick = { confirmContinue = true }) {
                        Text(if (checked!!.queuedRunIds.isEmpty()) stringResource(Res.string.composer_continue) else stringResource(Res.string.composer_continue_queued, checked!!.queuedRunIds.size), style = type.caption)
                    }
                }
            }
        }
        if (confirmContinue && checked != null && recoveryStore != null) {
            val result = checked!!
            ConfirmDialog(
                title = if (result.queuedRunIds.isEmpty()) stringResource(Res.string.confirm_continue_title) else stringResource(Res.string.confirm_continue_queued_title, result.queuedRunIds.size),
                message = stringResource(Res.string.composer_continue_unknown),
                confirmLabel = stringResource(Res.string.composer_continue),
                onConfirm = {
                    confirmContinue = false
                    checking = true
                    scope.launch { try { recoveryStore.continueRun(result.run, result.queuedRunIds); checked = null } finally { checking = false } }
                },
                onDismiss = { confirmContinue = false },
            )
        }
        AnimatedVisibility(visible = errorOpen && deliveryError != null, enter = motion.expandIn(), exit = motion.collapseOut()) {
            Box(Modifier.widthIn(max = 300.dp).padding(top = 4.dp)) {
                SelectableText {
                    Text(text = deliveryError.orEmpty(), style = type.caption, color = colors.fg2)
                }
            }
        }
    }
}

/**
 * The answer.
 *
 * The copy/timestamp row sits under it and only appears once the turn is over, matching the web:
 * a timestamp under a paragraph that is still streaming is a claim about when it ended that has
 * not happened yet.
 */
@Composable
internal fun AssistantRow(
    item: TimelineItem.Assistant,
    settled: Boolean,
    speed: SpeedTag?,
    /** The answer ends a stopped turn: 已停止 leads its time. */
    stopped: Boolean = false,
    streaming: Boolean = !settled,
) {
    val motion = LocalRiffetMotion.current
    val colors = TimelineTheme.colors
    val type = TimelineTheme.type
    val markActions = LocalMarkActions.current
    val marked = markActions?.marked(item) == true
    Column(Modifier.fillMaxWidth()) {
        PlainText(
            text = item.text,
            color = colors.fg,
            style = TimelineTheme.prose.body,
            codeStyle = TimelineTheme.prose.code,
            // Markdown, but parsed only up to the last finished paragraph while the turn is live:
            // see PlainText.kt for why a whole-document re-parse per stream chunk is not affordable.
            streaming = streaming,
        )
        // Opens in place when the turn ends: the row appearing in one frame would push a followed
        // list's newest line out of view.
        AnimatedVisibility(visible = settled, enter = motion.expandIn(), exit = ExitTransition.None) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.Start,
                modifier = Modifier.padding(top = 4.dp).offset(x = -MessageMenuInkInset),
            ) {
                MessageMenuButton(
                    text = item.text,
                    marked = marked,
                    onToggleMark = markActions?.takeIf { markable(item) }?.let { { it.toggle(item, item.text) } },
                )
                if (marked) {
                    Icon(
                        imageVector = RiffetIcons.Bookmark,
                        contentDescription = null,
                        tint = colors.accent,
                        modifier = Modifier.padding(start = 2.dp).size(14.dp),
                    )
                }
                if (stopped) {
                    Text(
                        text = stoppedLabel(),
                        style = type.caption,
                        color = colors.fg3,
                        modifier = Modifier.padding(start = 2.dp, end = 4.dp),
                    )
                }
                formatDateTime(timelineItemTime(item))?.let { time ->
                    Text(
                        text = time,
                        style = type.caption,
                        color = colors.fg3,
                        modifier = Modifier.padding(start = 2.dp, end = 4.dp),
                    )
                }
                // Beside the timestamp rather than only in the turn's process row: a turn that
                // produced nothing but prose has no process row at all, and that is exactly the
                // kind of turn whose speed you would still want to read back later.
                SpeedLabel(speed)
            }
        }
    }
}

/**
 * Reasoning, as the web's `ThoughtRow` renders it.
 *
 * Narration — the CLI's short summary in the reader's language — is the answer's markdown in `fg2`
 * with no label row. Raw thinking is long, English and rarely what anyone came to read, so it folds
 * to one row like a tool call: the brain icon, and the first sentence as the title. It stays
 * expandable because for models that never narrate it is the only reasoning there is.
 */
@Composable
internal fun ThoughtRow(item: TimelineItem.Thought, streaming: Boolean = false) {
    val colors = TimelineTheme.colors
    val type = TimelineTheme.type
    if (item.channel == ReasoningChannel.NARRATION) {
        PlainText(
            text = item.text,
            color = colors.fg2,
            style = TimelineTheme.prose.body,
            codeStyle = TimelineTheme.prose.code,
            streaming = streaming,
        )
        return
    }
    var open by rememberSaveable(item.key) { mutableStateOf(false) }
    // While streaming, the preview reads only finished lines, so it is recomputed per line rather
    // than per chunk — unless nothing but blank lines has finished, when the line being written is
    // the preview.
    val lineEnd = if (streaming) item.text.lastIndexOf('\n') else -1
    val finishedText = lineEnd >= 0 && item.text.indexOfFirst { !it.isWhitespace() }.let { it in 0 until lineEnd }
    val preview = remember(if (finishedText) lineEnd else item.text, streaming) { reasoningPreview(item.text, streaming) }
    TimelineDisclosure(
        open = open,
        onToggle = { open = !open },
        leading = { ToolIcon(RiffetIcons.Brain) },
        title = {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    text = "Think",
                    style = type.codeSmall.copy(fontWeight = FontWeight.Medium),
                    color = colors.fg3,
                    maxLines = 1,
                    softWrap = false,
                    modifier = Modifier.widthIn(min = 48.dp),
                )
                if (!open && preview.isNotEmpty()) {
                    Text(
                        text = preview,
                        style = type.bodySmall,
                        color = colors.fg3,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                }
            }
        },
    ) {
        PlainText(
            text = item.text,
            color = colors.fg2,
            style = type.bodySmall,
            codeStyle = type.codeSmall,
            streaming = streaming,
        )
    }
}

/**
 * The folded title: the first sentence or line, `**` stripped, at most 160 characters. While the
 * reasoning streams it follows the first line of the latest finished paragraph, so it advances
 * without flickering on a half-written line.
 */
internal fun reasoningPreview(text: String, running: Boolean = false): String {
    val line = (if (running) streamingReasoningLine(text) else "").ifEmpty {
        text.lineSequence().map { it.trim() }.firstOrNull { it.isNotEmpty() }.orEmpty()
    }
    val stop = Regex("[.。!！?？](\\s|$)").find(line)?.range?.first ?: -1
    val sentence = (if (stop > 0) line.substring(0, stop + 1) else line).replace("**", "")
    return if (sentence.length > 160) sentence.take(160) + "…" else sentence
}

private fun streamingReasoningLine(text: String): String {
    val paragraphs = text.split(Regex("\\r?\\n[\\t ]*\\r?\\n"))
    for (index in paragraphs.indices.reversed()) {
        val paragraph = paragraphs[index]
        val newline = paragraph.indexOf('\n')
        // The last paragraph is still being written unless a line of it has already ended.
        if (index == paragraphs.lastIndex && newline < 0) continue
        val line = (if (newline < 0) paragraph else paragraph.substring(0, newline)).trim()
        if (line.isNotEmpty()) return line
    }
    return ""
}

@Composable
private fun SessionReferenceChip(reference: riffet.contracts.CapturedSessionReference, recipientId: String) {
    val store = LocalSessionReferenceStore.current
    val openSource = LocalSessionReferenceOpen.current
    val scope = rememberCoroutineScope()
    var opened by remember(reference.snapshotRef) { mutableStateOf(false) }
    var original by remember(reference.snapshotRef) { mutableStateOf<List<String>?>(null) }
    var page by remember(reference.snapshotRef) { mutableStateOf(0) }
    var loading by remember(reference.snapshotRef) { mutableStateOf(false) }
    var failure by remember(reference.snapshotRef) { mutableStateOf<String?>(null) }
    TextButton(onClick = { opened = true }) {
        Icon(RiffetIcons.Message, null, Modifier.size(14.dp))
        Spacer(Modifier.width(4.dp))
        Text(reference.title, style = TimelineTheme.type.caption)
    }
    if (opened) riffet.ui.pickers.PickerOverlay(title = reference.title, onDismiss = { opened = false }, fullHeight = true) {
        val colors = riffet.ui.theme.LocalRiffetColors.current
        val inset = riffet.ui.pickers.SheetInset
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = inset)) {
            Text(stringResource(Res.string.session_reference_captured, formatDateTime(reference.capturedAt) ?: reference.capturedAt), style = TimelineTheme.type.caption)
            if (reference.coverage.completeness == "partial") Text(stringResource(Res.string.session_reference_partial), style = TimelineTheme.type.caption)
            if (reference.coverage.activeTurnIncomplete == true) Text(stringResource(Res.string.session_reference_unfinished), style = TimelineTheme.type.caption)
            Spacer(Modifier.height(8.dp))
            SelectableText {
                rememberResourceEnvironment()
                Text(original?.getOrNull(page) ?: riffet.shared.sessionReferenceExcerpt(reference.excerpt))
            }
            Spacer(Modifier.height(12.dp))
            Text(stringResource(Res.string.session_reference_retention), style = TimelineTheme.type.caption)
            Text(stringResource(Res.string.session_reference_scope), style = TimelineTheme.type.caption)
            failure?.let { Text(it, color = TimelineTheme.colors.danger) }
        }
        original?.takeIf { it.size > 1 }?.let { pages ->
            Row(Modifier.fillMaxWidth().padding(horizontal = inset), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center) {
                riffet.ui.design.RiffetIconButton(onClick = { page-- }, enabled = page > 0) {
                    Icon(RiffetIcons.ChevronLeft, stringResource(Res.string.session_reference_previous), Modifier.size(20.dp))
                }
                Text("${page + 1} / ${pages.size}", style = TimelineTheme.type.caption.copy(fontFeatureSettings = "tnum"))
                riffet.ui.design.RiffetIconButton(onClick = { page++ }, enabled = page < pages.lastIndex) {
                    Icon(RiffetIcons.ChevronRight, stringResource(Res.string.session_reference_next), Modifier.size(20.dp))
                }
            }
        }
        if (original == null) riffet.ui.design.GroupRow(
            title = stringResource(Res.string.session_reference_original),
            enabled = store != null && !loading,
            titleColor = colors.accent,
            onClick = {
                scope.launch {
                    loading = true
                    try { original = store?.sessionReferencePages(recipientId, reference.snapshotRef); page = 0; failure = null }
                    catch (error: kotlinx.coroutines.CancellationException) { throw error }
                    catch (error: Throwable) { failure = error.message }
                    finally { loading = false }
                }
            },
        )
        if (openSource != null) riffet.ui.design.GroupRow(
            title = stringResource(Res.string.session_reference_source),
            titleColor = colors.accent,
            onClick = { opened = false; openSource(reference.sessionId) },
        )
    }
}
