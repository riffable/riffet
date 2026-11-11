package riffet.ui.terminal

import riffet.ui.design.LocalRiffetSurfaces
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.surfaces
import androidx.compose.foundation.background
import riffet.ui.design.materialContentBackground
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEvent
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isAltPressed
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.key.utf16CodePoint
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import androidx.compose.material3.Text
import org.jetbrains.compose.resources.stringResource
import riffet.shared.TerminalConnection
import riffet.shared.TerminalLink
import riffet.terminal.KeyHandler
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet_mobile.shared.generated.resources.*

/** The web's key-repeat timing (`KEY_REPEAT_DELAY_MS` / `KEY_REPEAT_MS` in TerminalView.tsx). */
private const val KEY_REPEAT_DELAY_MS = 400L
private const val KEY_REPEAT_MS = 80L

/**
 * Turns keys, typed text and pastes into terminal input (docs/MOBILE-TERMINAL.md, 5.6).
 *
 * Ctrl and Alt on the key bar are sticky and apply to the next key or character only; leaving one
 * armed would turn the next letter into ^D and end the session.
 */
@Stable
internal class TerminalInputController(
    private val connection: TerminalConnection,
    /** The latest published frame: the modes keys and pastes are encoded for. */
    private val screen: () -> TerminalFrame,
) {
    var ctrl by mutableStateOf(false)
    var alt by mutableStateOf(false)

    internal val link get() = connection.link

    private fun stickyMods(): Int = (if (ctrl) KeyHandler.KEYMOD_CTRL else 0) or (if (alt) KeyHandler.KEYMOD_ALT else 0)

    private fun resetSticky() {
        ctrl = false
        alt = false
    }

    /** A special key, encoded for the program's current cursor/keypad modes. */
    fun key(keyCode: Int, mods: Int = 0) {
        val frame = screen()
        val code = KeyHandler.getCode(keyCode, mods or stickyMods(), frame.cursorKeysApplication, frame.keypadApplication)
        resetSticky()
        if (code != null) connection.sendInput(code)
    }

    /** Bytes that need no encoding (^C, a DEL). */
    fun raw(data: String) {
        resetSticky()
        connection.sendInput(data)
    }

    /** Text typed or committed by the keyboard; the sticky modifiers apply to its first character. */
    fun typed(text: String) {
        if (text.isEmpty()) return
        val out = StringBuilder()
        var first = true
        for (char in text) {
            val c = if (char == '\n') '\r' else char
            if (first && (ctrl || alt)) {
                if (alt) out.append('\u001b')
                out.append(if (ctrl) controlOf(c) ?: c else c)
            } else {
                out.append(c)
            }
            first = false
        }
        resetSticky()
        connection.sendInput(out.toString())
    }

    /** One paste; the server lets tmux bracket it when the program enabled bracketed paste. */
    fun paste(text: String, submit: Boolean = false) {
        if (text.isEmpty() && !submit) return
        resetSticky()
        connection.paste(text)
        if (submit) connection.sendInput("\r")
    }

    /**
     * A hardware key: true when it was sent here. Printable characters without Ctrl/Alt are left to
     * the text field, which already receives them; [fieldEmpty] decides Backspace and Enter.
     */
    fun hardwareKey(event: KeyEvent, fieldEmpty: Boolean): Boolean {
        if (event.type != KeyEventType.KeyDown) return false
        val mods = (if (event.isCtrlPressed) KeyHandler.KEYMOD_CTRL else 0) or
            (if (event.isAltPressed) KeyHandler.KEYMOD_ALT else 0) or
            (if (event.isShiftPressed) KeyHandler.KEYMOD_SHIFT else 0)
        val keyCode = when (event.key) {
            Key.DirectionUp -> KeyHandler.KEYCODE_DPAD_UP
            Key.DirectionDown -> KeyHandler.KEYCODE_DPAD_DOWN
            Key.DirectionLeft -> KeyHandler.KEYCODE_DPAD_LEFT
            Key.DirectionRight -> KeyHandler.KEYCODE_DPAD_RIGHT
            Key.Escape -> KeyHandler.KEYCODE_ESCAPE
            Key.Tab -> KeyHandler.KEYCODE_TAB
            Key.MoveHome -> KeyHandler.KEYCODE_MOVE_HOME
            Key.MoveEnd -> KeyHandler.KEYCODE_MOVE_END
            Key.PageUp -> KeyHandler.KEYCODE_PAGE_UP
            Key.PageDown -> KeyHandler.KEYCODE_PAGE_DOWN
            Key.Delete -> KeyHandler.KEYCODE_FORWARD_DEL
            Key.Insert -> KeyHandler.KEYCODE_INSERT
            Key.F1 -> KeyHandler.KEYCODE_F1
            Key.F2 -> KeyHandler.KEYCODE_F1 + 1
            Key.F3 -> KeyHandler.KEYCODE_F1 + 2
            Key.F4 -> KeyHandler.KEYCODE_F1 + 3
            Key.F5 -> KeyHandler.KEYCODE_F1 + 4
            Key.F6 -> KeyHandler.KEYCODE_F1 + 5
            Key.F7 -> KeyHandler.KEYCODE_F1 + 6
            Key.F8 -> KeyHandler.KEYCODE_F1 + 7
            Key.F9 -> KeyHandler.KEYCODE_F1 + 8
            Key.F10 -> KeyHandler.KEYCODE_F1 + 9
            Key.F11 -> KeyHandler.KEYCODE_F1 + 10
            Key.F12 -> KeyHandler.KEYCODE_F12
            Key.Backspace -> if (fieldEmpty || mods != 0) KeyHandler.KEYCODE_DEL else return false
            Key.Enter, Key.NumPadEnter -> if (fieldEmpty || mods != 0) KeyHandler.KEYCODE_ENTER else return false
            else -> null
        }
        if (keyCode != null) {
            key(keyCode, mods)
            return true
        }
        val codePoint = event.utf16CodePoint
        if ((event.isCtrlPressed || event.isAltPressed) && codePoint in 0x20..0x7E) {
            val char = codePoint.toChar()
            val out = StringBuilder()
            if (event.isAltPressed) out.append('\u001b')
            out.append(if (event.isCtrlPressed) controlOf(char) ?: char else char)
            raw(out.toString())
            return true
        }
        return false
    }
}

/** The C0 control a Ctrl chord produces, or null when the character has none. */
internal fun controlOf(char: Char): Char? = when (char) {
    in 'a'..'z' -> (char.code and 0x1f).toChar()
    in 'A'..'Z' -> (char.code and 0x1f).toChar()
    '@', ' ', '2' -> '\u0000'
    '[', '3' -> '\u001b'
    '\\', '4' -> '\u001c'
    ']', '5' -> '\u001d'
    '^', '6' -> '\u001e'
    '_', '7', '/' -> '\u001f'
    '?', '8' -> '\u007f'
    else -> null
}

/**
 * The keyboard's way in: an invisible text field. Nothing typed is drawn locally — the program's
 * echo is the truth — and a composition (pinyin being typed) never reaches the terminal; only
 * committed text does, as the difference from what was already sent: DEL for each character
 * removed from the end, then what was added. termish's input pipeline, docs/input-pipeline.md.
 */
@Composable
internal fun TerminalKeyboardField(controller: TerminalInputController, focusRequester: FocusRequester, modifier: Modifier = Modifier) {
    var value by remember { mutableStateOf(TextFieldValue("")) }
    var committed by remember { mutableStateOf("") }
    BasicTextField(
        value = value,
        onValueChange = { next ->
            if (next.composition != null) {
                value = next
                return@BasicTextField
            }
            val text = next.text
            val prefix = committed.commonPrefixWith(text).length
            val removed = committed.length - prefix
            if (removed > 0) controller.raw("\u007f".repeat(removed))
            controller.typed(text.substring(prefix))
            // A long buffer or a newline starts over, so a long paste or an Enter leaves nothing behind.
            if (text.length > 64 || text.contains('\n')) {
                committed = ""
                value = TextFieldValue("")
            } else {
                committed = text
                value = next
            }
        },
        keyboardOptions = KeyboardOptions(
            capitalization = KeyboardCapitalization.None,
            autoCorrectEnabled = false,
            keyboardType = KeyboardType.Text,
            imeAction = ImeAction.None,
        ),
        singleLine = false,
        modifier = modifier
            .size(1.dp)
            .alpha(0f)
            .focusRequester(focusRequester)
            .onPreviewKeyEvent { controller.hardwareKey(it, value.text.isEmpty()) },
    )
}

private class BarKey(val label: String, val repeat: Boolean = false, val active: (() -> Boolean)? = null, val onPress: () -> Unit)

/**
 * Two rows of keys a phone keyboard lacks, chosen for the CLIs Riffet drives: ⇧Tab cycles Claude
 * Code's permission mode, Esc interrupts, ^O expands the transcript, / opens slash commands.
 * Keys commit on a valid tap, or repeat after a hold, and never take focus. Scrolling the key rows
 * cancels the pending tap, and a tap neither opens nor closes the keyboard.
 */
@Composable
internal fun TerminalKeyBar(
    controller: TerminalInputController,
    onToggleKeyboard: () -> Unit,
    moreOpen: Boolean,
    onToggleMore: () -> Unit,
    moreActions: List<Pair<String, () -> Unit>>,
    modifier: Modifier = Modifier,
) {
    val designMetrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val c = controller
    val link by controller.link.collectAsState()
    val enabled = link !is TerminalLink.Exited && link != TerminalLink.Unauthenticated
    val rows = listOf(
        listOf(
            BarKey("Esc") { c.key(KeyHandler.KEYCODE_ESCAPE) },
            BarKey("Tab") { c.key(KeyHandler.KEYCODE_TAB) },
            BarKey("⇧Tab") { c.key(KeyHandler.KEYCODE_TAB, KeyHandler.KEYMOD_SHIFT) },
            BarKey("Ctrl", active = { c.ctrl }) { c.ctrl = !c.ctrl },
            BarKey("↑", repeat = true) { c.key(KeyHandler.KEYCODE_DPAD_UP) },
            BarKey("^C") { c.raw("\u0003") },
            BarKey("⏎") { c.raw("\r") },
            BarKey("⌨") { onToggleKeyboard() },
        ),
        listOf(
            BarKey("/") { c.typed("/") },
            BarKey("^R") { c.raw("\u0012") },
            BarKey("^O") { c.raw("\u000f") },
            BarKey("Alt", active = { c.alt }) { c.alt = !c.alt },
            BarKey("←", repeat = true) { c.key(KeyHandler.KEYCODE_DPAD_LEFT) },
            BarKey("↓", repeat = true) { c.key(KeyHandler.KEYCODE_DPAD_DOWN) },
            BarKey("→", repeat = true) { c.key(KeyHandler.KEYCODE_DPAD_RIGHT) },
            BarKey(
                if (moreOpen) stringResource(Res.string.timeline_collapse) else stringResource(Res.string.timeline_more),
                active = { moreOpen },
            ) { onToggleMore() },
        ),
    )
    Column(modifier.fillMaxWidth().background(materialContentBackground(LocalRiffetSurfaces.current.floating)).padding(horizontal = 4.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (moreOpen) {
            val extra = listOf(
                BarKey("^D") { c.raw("\u0004") }, BarKey("^L") { c.raw("\u000c") }, BarKey("^Z") { c.raw("\u001a") },
                BarKey("Home") { c.key(KeyHandler.KEYCODE_MOVE_HOME) }, BarKey("End") { c.key(KeyHandler.KEYCODE_MOVE_END) },
                BarKey("PgUp") { c.key(KeyHandler.KEYCODE_PAGE_UP) }, BarKey("PgDn") { c.key(KeyHandler.KEYCODE_PAGE_DOWN) },
                BarKey("Del") { c.key(KeyHandler.KEYCODE_FORWARD_DEL) },
                BarKey("|") { c.typed("|") }, BarKey("~") { c.typed("~") }, BarKey("-") { c.typed("-") },
            ) + (1..12).map { n -> BarKey("F$n") { c.key(KeyHandler.KEYCODE_F1 + n - 1) } } +
                moreActions.map { (label, action) -> BarKey(label) { action() } }
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                extra.forEach { KeyButton(it, Modifier.widthIn(min = designMetrics.controlHeight), enabled) }
            }
        }
        rows.forEach { row ->
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                row.forEach { KeyButton(it, Modifier.widthIn(min = designMetrics.controlHeight), enabled) }
            }
        }
    }
}

@Composable
private fun KeyButton(key: BarKey, modifier: Modifier, enabled: Boolean) {
    val designMetrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val active = key.active?.invoke() == true
    val press by rememberUpdatedState(key.onPress)
    var pressed by remember(key.label) { mutableStateOf(false) }
    val shape = RoundedCornerShape(LocalInterfaceStyle.current.controlRadius)
    val selected = surfaces.selected
    val selectedContent = surfaces.selectedContent
    val pressColor = surfaces.press
    val keyColor = if (!enabled) surfaces.card else if (active) selected else colors.bg
    Box(
        modifier
            .heightIn(min = designMetrics.controlHeight)
            .clip(shape)
            .background(if (pressed) pressColor.compositeOver(keyColor) else keyColor)
            .border(designMetrics.hairlineWidth, if (active) selected else colors.line, shape)
            // Accessibility activation sends one command without requesting IME focus.
            .semantics {
                role = Role.Button
                if (key.active != null) this.selected = active
                if (enabled) onClick {
                    press()
                    true
                } else disabled()
            }
            .pointerInput(key.label, key.repeat, enabled) {
                if (!enabled) return@pointerInput
                awaitEachGesture {
                    awaitFirstDown()
                    pressed = true
                    try {
                        if (!key.repeat) {
                            waitForUpOrCancellation()?.let { up ->
                                up.consume()
                                press()
                            }
                        } else {
                            var repeated = false
                            var waitMillis = KEY_REPEAT_DELAY_MS
                            while (true) {
                                // The pointer scope owns the timeout: no detached repeat job can
                                // send after scrolling, cancellation or release ends this gesture.
                                // false is cancellation; null alone means the hold timer expired.
                                val released = withTimeoutOrNull(waitMillis) {
                                    val up = waitForUpOrCancellation()
                                    up?.consume()
                                    up != null
                                }
                                if (released != null) {
                                    if (released && !repeated) press()
                                    break
                                }
                                repeated = true
                                press()
                                waitMillis = KEY_REPEAT_MS
                            }
                        }
                    } finally {
                        pressed = false
                    }
                }
            }
            .padding(horizontal = 6.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(key.label, style = typography.label, color = if (!enabled) surfaces.disabledContent else if (active) selectedContent else colors.fg2, maxLines = 1)
    }
}
