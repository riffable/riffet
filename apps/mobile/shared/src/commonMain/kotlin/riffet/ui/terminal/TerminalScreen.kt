package riffet.ui.terminal

import riffet.ui.gesture.riffetHorizontalScroll
import riffet.ui.theme.appearancePageBackground

import riffet.ui.design.ConfirmDialog
import riffet.ui.design.LocalRiffetSurfaces
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.app.PageBarAction
import riffet.ui.app.PageTopBar
import riffet.ui.app.RiffetPageScaffold
import riffet.ui.design.materialBackdropEnabled
import riffet.ui.design.materialContentBackground
import riffet.ui.app.snackbarBottomBar
import androidx.compose.ui.semantics.Role
import androidx.compose.foundation.background
import riffet.contracts.TERMINAL_KEPT_ROWS_PHONE
import riffet.contracts.TerminalState
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.runtime.mutableStateOf
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.Spacer
import kotlinx.coroutines.launch
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.clickable
import androidx.compose.foundation.border
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.HorizontalDivider
import riffet.ui.icons.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import org.jetbrains.compose.resources.stringResource
import riffet.shared.TerminalConnection
import riffet.shared.TerminalLink
import riffet.shared.RiffetApi
import riffet.terminal.TerminalEmulator
import riffet.terminal.TerminalOutput
import riffet.ui.composer.newClientId
import riffet.ui.composer.rememberAttachmentPicker
import riffet.ui.composer.readClipboardAttachments
import riffet.ui.composer.PickedAttachment
import riffet.ui.icons.RiffetIcons
import riffet.ui.pickers.RiffetDropdownMenu
import riffet.ui.pickers.RiffetMenuItem
import riffet.ui.settings.SettingsButton
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetDarkTheme
import riffet.ui.theme.LocalRiffetThemeEntry
import riffet.ui.theme.LocalRiffetTypography
import riffet.shared.interruptTerminal
import riffet_mobile.shared.generated.resources.*

/** The terminal's default size: about 52 columns on a 392dp-wide phone. */
private const val BASE_FONT_SP = 12.5f
/** A viewer squeezes a wider pane into the screen down to this size, then scrolls sideways. */
private const val MIN_FONT_SP = 8f

/**
 * A session's terminal on the phone (docs/MOBILE-TERMINAL.md, T2): the pane's live screen, read only.
 *
 * - The terminal text has its own size: the page uses a density with `fontScale = 1`, so neither the
 *   system font size nor the app's 文字大小 widens the cells. With them applied a 13sp grid was 30
 *   columns on a phone, too narrow for any agent CLI.
 * - The engine's grid is always the pane's size (`state` frames), never the page's: a viewer that
 *   interpreted a 100-column stream on a 54-column grid would scramble it, which is what the web's
 *   read-only view does today.
 * - Holding control (gained on connect when nobody else has it), the page asks the server to size the
 *   pane to what fits. As a viewer it shrinks the text to fit the pane's width, to [MIN_FONT_SP], and
 *   scrolls sideways beyond that.
 */
@Composable
internal fun TerminalScreen(
    api: RiffetApi,
    terminalId: String,
    title: String,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val entry = LocalRiffetThemeEntry.current
    val scope = rememberCoroutineScope()
    // The socket, frame decoding and parsing run here, one at a time, so
    // a flood of output (`cat` of a large file) never runs on the main thread. The emulator belongs
    // to this thread; the canvas draws the frames [TerminalSurfaceState] publishes from it.
    val worker = remember { Dispatchers.Default.limitedParallelism(1) }
    val workerScope = remember(scope, worker) { CoroutineScope(scope.coroutineContext + worker) }
    val clientId = remember(terminalId) { "app-${newClientId()}" }
    val replies = remember(terminalId) { ReplyOutput() }
    val surface = remember(terminalId) { TerminalSurfaceState(TerminalEmulator(replies, 100, 40, 10, 20, TERMINAL_KEPT_ROWS_PHONE, null), workerScope) }
    val scroll = remember(terminalId) { TerminalScrollState { surface.screen } }
    val connection = remember(terminalId) {
        TerminalConnection(api, terminalId, clientId, workerScope, onOutput = { data, fresh ->
            // On the worker. Each snapshot is a complete seed with its scrollback; start over from it.
            if (fresh) {
                surface.emulator.reset()
                scroll.toLiveNow()
            }
            val bytes = data.encodeToByteArray()
            surface.emulator.append(bytes, bytes.size)
            // Published at most once per frame, however many output frames arrive meanwhile.
            surface.invalidate()
        }, onSnapshotGrid = { cols, rows ->
            val emulator = surface.emulator
            emulator.resize(cols, rows, emulator.getCellWidthPixels(), emulator.getCellHeightPixels())
        })
    }
    // The engine's answers to the program's queries go out only while this page holds control.
    replies.sink = connection::sendReply
    val input = remember(connection) { TerminalInputController(connection) { surface.screen } }
    val focusRequester = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    var keyboardOpen by remember { mutableStateOf(false) }
    var moreOpen by remember { mutableStateOf(false) }
    var actionsOpen by remember(terminalId) { mutableStateOf(false) }
    var confirmInterrupt by remember(terminalId) { mutableStateOf(false) }
    var lineInput by remember { mutableStateOf(false) }
    @Suppress("DEPRECATION")
    val clipboard = LocalClipboardManager.current
    var attachmentError by remember(terminalId) { mutableStateOf<String?>(null) }
    var uploading by remember(terminalId) { mutableStateOf(false) }
    val unknownPaste = stringResource(Res.string.terminal_paste_unknown)
    fun pasteFiles(files: List<PickedAttachment>) {
        if (files.isEmpty() || uploading) return
        uploading = true
        attachmentError = null
        scope.launch {
            try {
                val lease = connection.acquirePasteLease()
                val result = connection.pasteAttachments(files, newClientId(), lease)
                if (result.status != "completed") attachmentError = unknownPaste
            } catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
            catch (error: Exception) { attachmentError = error.message }
            finally { uploading = false }
        }
    }
    val picker = rememberAttachmentPicker(onError = { attachmentError = it }, onPicked = ::pasteFiles)
    fun pasteClipboard() {
        if (uploading) return
        uploading = true
        attachmentError = null
        scope.launch {
            try {
                val lease = connection.acquirePasteLease()
                val files = readClipboardAttachments()
                if (files.isEmpty()) clipboard.getText()?.text?.let { connection.paste(it) }
                else {
                    val result = connection.pasteAttachments(files, newClientId(), lease)
                    if (result.status != "completed") attachmentError = unknownPaste
                }
            } catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
            catch (error: Exception) { attachmentError = error.message }
            finally { uploading = false }
        }
    }
    fun openKeyboard() {
        focusRequester.requestFocus()
        keyboardOpen = true
        // The input connection is set up asynchronously; an immediate show() is often ignored.
        scope.launch {
            delay(150)
            keyboard?.show()
        }
    }
    fun closeKeyboard() {
        keyboard?.hide()
        keyboardOpen = false
    }
    DisposableEffect(connection) {
        connection.start()
        onDispose { connection.close() }
    }
    val link by connection.link.collectAsState()
    val info by connection.info.collectAsState()
    val dark = LocalRiffetDarkTheme.current
    val appearance = riffet.contracts.TerminalAppearance.fromArgb(colors.fg.toArgb(), colors.bg.toArgb())
    val palette = remember(entry, dark, appearance) { TerminalPalette.from(entry, dark, appearance) }
    LaunchedEffect(connection, appearance) { connection.followAppearance() }
    val notice by connection.notice.collectAsState()
    val owner = info?.ownerId
    val mine = owner != null && owner == clientId

    val paneCols = info?.cols?.toInt()
    val paneRows = info?.rows?.toInt()
    LaunchedEffect(paneCols, paneRows) {
        if (paneCols != null && paneRows != null) {
            withContext(worker) {
                val emulator = surface.emulator
                if (emulator.getColumns() != paneCols || emulator.getRows() != paneRows) {
                    emulator.resize(paneCols, paneRows, emulator.getCellWidthPixels(), emulator.getCellHeightPixels())
                    surface.invalidate()
                }
            }
        }
    }

    RiffetPageScaffold(
        modifier = modifier.fillMaxSize().appearancePageBackground(LocalRiffetSurfaces.current.page),
        // Sizing the pane to the screen starts at once; only the grid waits for the slide.
        deferBody = false,
        topBar = {
            Column {
                val linkLabel = when (val current = link) {
                    TerminalLink.Connecting -> stringResource(Res.string.timeline_terminal_connecting)
                    TerminalLink.Live -> null
                    is TerminalLink.Reconnecting -> stringResource(Res.string.timeline_terminal_reconnecting)
                    is TerminalLink.Exited -> stringResource(Res.string.timeline_terminal_exited, current.exitCode ?: "?")
                    TerminalLink.Unauthenticated -> stringResource(Res.string.timeline_terminal_token_expired)
                }
                val leaseLabel = when {
                    link !is TerminalLink.Live -> null
                    mine -> null
                    owner != null -> stringResource(Res.string.timeline_terminal_other_controller)
                    else -> stringResource(Res.string.timeline_terminal_read_only)
                }
                PageTopBar(title = title, onBack = onBack, subtitle = listOfNotNull(linkLabel, leaseLabel).joinToString(" · ").ifEmpty { null }) {
                    if (uploading) { riffet.ui.design.RiffetProgressIndicator(Modifier.size(14.dp), strokeWidth = 1.5.dp) }
                    if (link is TerminalLink.Live && owner != null && !mine) {
                        SettingsButton(text = stringResource(Res.string.timeline_terminal_take_over), onClick = { connection.takeOver() })
                    }
                    Box {
                        PageBarAction(
                            icon = RiffetIcons.Ellipsis,
                            description = stringResource(Res.string.timeline_more_actions),
                            onClick = { actionsOpen = true },
                        )
                        RiffetDropdownMenu(expanded = actionsOpen, onDismissRequest = { actionsOpen = false }) {
                            RiffetMenuItem(
                                text = stringResource(Res.string.timeline_terminal_interrupt_process),
                                icon = RiffetIcons.OctagonX,
                                enabled = info?.state == TerminalState.RUNNING,
                                danger = true,
                                onClick = {
                                    actionsOpen = false
                                    confirmInterrupt = true
                                },
                            )
                        }
                    }
                    if (confirmInterrupt) {
                        ConfirmDialog(
                            title = stringResource(Res.string.confirm_interrupt_title, title),
                            confirmLabel = stringResource(Res.string.timeline_terminal_interrupt_process),
                            danger = true,
                            onConfirm = {
                                confirmInterrupt = false
                                scope.launch { runCatching { api.interruptTerminal(terminalId) } }
                            },
                            onDismiss = { confirmInterrupt = false },
                        )
                    }
                }
                (attachmentError ?: notice)?.let { Text(it, style = typography.caption, color = colors.danger, modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp)) }
            }
        },
        bottomBar = if (link !is TerminalLink.Exited && link != TerminalLink.Unauthenticated) ({
            Column(Modifier.fillMaxWidth().snackbarBottomBar()) {
                if (!materialBackdropEnabled) HorizontalDivider(color = colors.line)
                if (lineInput) LineInput(onSend = { text, submit -> input.paste(text, submit) })
                TerminalKeyBar(
                    controller = input,
                    onToggleKeyboard = { if (keyboardOpen) closeKeyboard() else openKeyboard() },
                    moreOpen = moreOpen,
                    onToggleMore = { moreOpen = !moreOpen },
                    moreActions = listOfNotNull(
                        stringResource(Res.string.timeline_terminal_paste) to { pasteClipboard() },
                        if (picker.available) stringResource(Res.string.timeline_attachment) to { if (!uploading) picker.launch() } else null,
                        (if (lineInput) {
                            stringResource(Res.string.timeline_terminal_line_input_off)
                        } else {
                            stringResource(Res.string.timeline_terminal_line_input_on)
                        }) to { lineInput = !lineInput },
                        if (mine) stringResource(Res.string.timeline_terminal_release_control) to { connection.release() } else null,
                    ),
                )
                TerminalKeyboardField(input, focusRequester)
            }
        }) else null,
    ) { contentInsets ->
        val density = LocalDensity.current
        CompositionLocalProvider(LocalDensity provides Density(density.density, 1f)) {
            // A small inset keeps the text off the screen's edges; the grid is fitted inside it.
            BoxWithConstraints(Modifier.fillMaxSize().background(androidx.compose.ui.graphics.Color(palette.background))
                .padding(contentInsets).padding(horizontal = 6.dp, vertical = 2.dp)) {
                val widthPx = constraints.maxWidth.toFloat()
                val heightPx = constraints.maxHeight.toFloat()
                val base = rememberTerminalCellMetrics(BASE_FONT_SP.sp)
                val fitCols = (widthPx / base.width).toInt().coerceAtLeast(20)
                val measuredRows = (heightPx / base.height).toInt().coerceAtLeast(5)
                // The soft keyboard shrinks the page but must not reflow the CLI on every open and
                // close: the pane keeps the rows it had. The viewport follows the cursor instead
                // of pulling the input upward by all of the blank rows below it.
                val imeOpen = WindowInsets.ime.getBottom(LocalDensity.current) > 0
                var fitRows by remember { mutableIntStateOf(measuredRows) }
                if (!imeOpen && measuredRows != fitRows) fitRows = measuredRows
                LaunchedEffect(fitCols, fitRows) {
                    delay(250)
                    connection.requestSize(fitCols, fitRows)
                }

                val cols = paneCols ?: fitCols
                val rows = paneRows ?: fitRows
                // Owner: the pane is being sized to fit at the base size. Viewer: shrink to the pane's width.
                val fontSp = if (mine || cols <= fitCols) BASE_FONT_SP else maxOf(MIN_FONT_SP, BASE_FONT_SP * fitCols / cols)
                val metrics = rememberTerminalCellMetrics(fontSp.sp)
                val gridWidth = with(LocalDensity.current) { (cols * metrics.width).toDp() }
                riffet.ui.app.PageBody(Modifier.fillMaxSize()) {
                    Box(Modifier.fillMaxSize().riffetHorizontalScroll(rememberScrollState())) {
                        TerminalScrollView(
                            surface = surface,
                            scroll = scroll,
                            palette = palette,
                            fontSize = fontSp.sp,
                            followCursor = imeOpen,
                            modifier = Modifier.width(gridWidth).fillMaxHeight(),
                            onTap = { if (link !is TerminalLink.Exited && link != TerminalLink.Unauthenticated) openKeyboard() },
                        )
                    }
                }
                if (!scroll.atBottom) {
                    riffet.ui.design.RiffetButton(
                        text = stringResource(Res.string.timeline_terminal_back_to_live),
                        onClick = { scope.launch { scroll.toLive() } },
                        modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 12.dp),
                    )
                }
                if (link is TerminalLink.Connecting) {
                    Text(stringResource(Res.string.timeline_terminal_connecting_message), style = typography.caption, color = colors.fg3, modifier = Modifier.align(Alignment.Center))
                }
            }
        }
    }
}

/** 整行输入: a visible field for long prompts, voice input and keyboards that compose whole phrases. */
@Composable
private fun LineInput(onSend: (text: String, submit: Boolean) -> Unit) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    var text by remember { mutableStateOf("") }
    Row(Modifier.fillMaxWidth().background(materialContentBackground(LocalRiffetSurfaces.current.floating)).padding(horizontal = 8.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        riffet.ui.design.RiffetTextField(
            value = text,
            onValueChange = { text = it },
            singleLine = false,
            maxLines = 5,
            modifier = Modifier.weight(1f),
        )
        Spacer(Modifier.width(6.dp))
        SettingsButton(text = stringResource(Res.string.timeline_terminal_insert), enabled = text.isNotEmpty(), onClick = { onSend(text, false); text = "" })
        Spacer(Modifier.width(6.dp))
        SettingsButton(text = stringResource(Res.string.timeline_terminal_send), primary = true, onClick = { onSend(text, true); text = "" })
    }
}

/** Forwards the engine's replies to [sink] ([TerminalConnection.sendReply], which drops them without control). */
private class ReplyOutput : TerminalOutput() {
    var sink: ((String) -> Unit)? = null
    override fun write(data: ByteArray, offset: Int, count: Int) {
        sink?.invoke(data.decodeToString(offset, offset + count))
    }
    override fun titleChanged(oldTitle: String?, newTitle: String?) = Unit
    override fun onCopyTextToClipboard(text: String) = Unit
    override fun onPasteTextFromClipboard() = Unit
    override fun onBell() = Unit
    override fun onColorsChanged() = Unit
}
