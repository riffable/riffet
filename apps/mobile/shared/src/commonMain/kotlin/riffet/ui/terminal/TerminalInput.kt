package riffet.ui.terminal

import riffet.ui.gesture.horizontalSwipeChild
import riffet.ui.gesture.riffetHorizontalScroll
import riffet.ui.design.LocalRiffetSurfaces
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.surfaces
import androidx.compose.foundation.background
import riffet.ui.design.materialContentBackground
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.material3.Text
import org.jetbrains.compose.resources.stringResource
import riffet.shared.TerminalConnection
import riffet.shared.TerminalLink
import riffet.shared.TerminalQuickKey
import riffet.terminal.KeyHandler
import riffet.ui.design.AlertDialog
import riffet.ui.design.RiffetTextButton
import riffet.ui.icons.RiffetIcons
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

/** [primary]: the key that submits, filled like the composer's send button. */
private class BarKey(val label: String, val repeat: Boolean = false, val active: (() -> Boolean)? = null, val primary: Boolean = false, val onPress: () -> Unit)

/**
 * Two rows of keys a phone keyboard lacks, chosen for the CLIs Riffet drives: ⇧Tab cycles Claude
 * Code's permission mode, Esc interrupts, ^O expands the transcript, / opens slash commands, and
 * 换行 sends LF (Ctrl+J), which Claude Code and Codex take as a newline rather than a submit.
 * Both rows share eight columns so ↑ sits above ↓. The columns always split the width evenly and
 * never scroll, so ⏎ at the end of the first row stays in reach on the narrowest phone.
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
    quickKeys: List<TerminalQuickKey> = TerminalQuickKey.DEFAULT,
    modifier: Modifier = Modifier,
) {
    val c = controller
    val link by controller.link.collectAsState()
    val enabled = link !is TerminalLink.Exited && link != TerminalLink.Unauthenticated
    val newlineLabel = stringResource(Res.string.timeline_terminal_newline)
    val effectiveQuickKeys = quickKeys.ifEmpty { TerminalQuickKey.DEFAULT }
    val firstRow = effectiveQuickKeys.map { it.toBarKey(c, newlineLabel) }
    val secondRow = listOf(
        BarKey("Ctrl", active = { c.ctrl }) { c.ctrl = !c.ctrl },
        BarKey("Alt", active = { c.alt }) { c.alt = !c.alt },
        BarKey("^O") { c.raw("\u000f") },
        BarKey("←", repeat = true) { c.key(KeyHandler.KEYCODE_DPAD_LEFT) },
        BarKey("↓", repeat = true) { c.key(KeyHandler.KEYCODE_DPAD_DOWN) },
        BarKey("→", repeat = true) { c.key(KeyHandler.KEYCODE_DPAD_RIGHT) },
        BarKey("⌨") { onToggleKeyboard() },
        BarKey(
            if (moreOpen) stringResource(Res.string.timeline_collapse) else stringResource(Res.string.timeline_more),
            active = { moreOpen },
        ) { onToggleMore() },
    )
    Column(modifier.fillMaxWidth().background(materialContentBackground(LocalRiffetSurfaces.current.floating)).padding(horizontal = 4.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (moreOpen) {
            // The text actions lead: they are what a reader opens 更多 for most often.
            val extra = moreActions.map { (label, action) -> BarKey(label) { action() } } + listOf(
                BarKey("^R") { c.raw("\u0012") },
                BarKey("^D") { c.raw("\u0004") }, BarKey("^L") { c.raw("\u000c") }, BarKey("^Z") { c.raw("\u001a") },
                BarKey("Home") { c.key(KeyHandler.KEYCODE_MOVE_HOME) }, BarKey("End") { c.key(KeyHandler.KEYCODE_MOVE_END) },
                BarKey("PgUp") { c.key(KeyHandler.KEYCODE_PAGE_UP) }, BarKey("PgDn") { c.key(KeyHandler.KEYCODE_PAGE_DOWN) },
                BarKey("Del") { c.key(KeyHandler.KEYCODE_FORWARD_DEL) },
                BarKey("|") { c.typed("|") }, BarKey("~") { c.typed("~") }, BarKey("-") { c.typed("-") },
            ) + (1..12).map { n -> BarKey("F$n") { c.key(KeyHandler.KEYCODE_F1 + n - 1) } }
            Row(Modifier.fillMaxWidth().riffetHorizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(KeyGap)) {
                extra.forEach { KeyButton(it, Modifier.widthIn(min = MinKeyWidth), enabled) }
            }
        }
        if (firstRow.size <= 8) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(KeyGap)) {
                firstRow.forEach { KeyButton(it, Modifier.weight(1f), enabled, inset = 2.dp) }
            }
        } else {
            Row(Modifier.fillMaxWidth().riffetHorizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(KeyGap)) {
                firstRow.forEach { KeyButton(it, Modifier.widthIn(min = MinKeyWidth), enabled) }
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(KeyGap)) {
            secondRow.forEach { KeyButton(it, Modifier.weight(1f), enabled, inset = 2.dp) }
        }
    }
}

private fun TerminalQuickKey.label(newlineLabel: String): String = when (this) {
    TerminalQuickKey.ESC -> "Esc"
    TerminalQuickKey.TAB -> "Tab"
    TerminalQuickKey.SHIFT_TAB -> "⇧Tab"
    TerminalQuickKey.CTRL_C -> "^C"
    TerminalQuickKey.UP -> "↑"
    TerminalQuickKey.SLASH -> "/"
    TerminalQuickKey.NEWLINE -> newlineLabel
    TerminalQuickKey.ENTER -> "⏎"
    TerminalQuickKey.CTRL_D -> "^D"
    TerminalQuickKey.CTRL_Z -> "^Z"
    TerminalQuickKey.CTRL_L -> "^L"
    TerminalQuickKey.CTRL_R -> "^R"
    TerminalQuickKey.HOME -> "Home"
    TerminalQuickKey.END -> "End"
    TerminalQuickKey.PGUP -> "PgUp"
    TerminalQuickKey.PGDN -> "PgDn"
    TerminalQuickKey.PIPE -> "|"
    TerminalQuickKey.TILDE -> "~"
    TerminalQuickKey.DASH -> "-"
}

private fun TerminalQuickKey.toBarKey(c: TerminalInputController, newlineLabel: String): BarKey {
    val label = label(newlineLabel)
    return when (this) {
        TerminalQuickKey.ESC -> BarKey(label) { c.key(KeyHandler.KEYCODE_ESCAPE) }
        TerminalQuickKey.TAB -> BarKey(label) { c.key(KeyHandler.KEYCODE_TAB) }
        TerminalQuickKey.SHIFT_TAB -> BarKey(label) { c.key(KeyHandler.KEYCODE_TAB, KeyHandler.KEYMOD_SHIFT) }
        TerminalQuickKey.CTRL_C -> BarKey(label) { c.raw("\u0003") }
        TerminalQuickKey.UP -> BarKey(label, repeat = true) { c.key(KeyHandler.KEYCODE_DPAD_UP) }
        TerminalQuickKey.SLASH -> BarKey(label) { c.typed("/") }
        TerminalQuickKey.NEWLINE -> BarKey(label) { c.raw("\n") }
        TerminalQuickKey.ENTER -> BarKey(label, primary = true) { c.raw("\r") }
        TerminalQuickKey.CTRL_D -> BarKey(label) { c.raw("\u0004") }
        TerminalQuickKey.CTRL_Z -> BarKey(label) { c.raw("\u001a") }
        TerminalQuickKey.CTRL_L -> BarKey(label) { c.raw("\u000c") }
        TerminalQuickKey.CTRL_R -> BarKey(label) { c.raw("\u0012") }
        TerminalQuickKey.HOME -> BarKey(label) { c.key(KeyHandler.KEYCODE_MOVE_HOME) }
        TerminalQuickKey.END -> BarKey(label) { c.key(KeyHandler.KEYCODE_MOVE_END) }
        TerminalQuickKey.PGUP -> BarKey(label) { c.key(KeyHandler.KEYCODE_PAGE_UP) }
        TerminalQuickKey.PGDN -> BarKey(label) { c.key(KeyHandler.KEYCODE_PAGE_DOWN) }
        TerminalQuickKey.PIPE -> BarKey(label) { c.typed("|") }
        TerminalQuickKey.TILDE -> BarKey(label) { c.typed("~") }
        TerminalQuickKey.DASH -> BarKey(label) { c.typed("-") }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun TerminalQuickKeysDialog(
    keys: List<TerminalQuickKey>,
    onChange: (List<TerminalQuickKey>) -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val shape = RoundedCornerShape(LocalInterfaceStyle.current.controlRadius)
    val hairline = LocalInterfaceStyle.current.metrics.hairlineWidth
    val newlineLabel = stringResource(Res.string.timeline_terminal_newline)
    val available = remember(keys) { TerminalQuickKey.entries.filter { it !in keys } }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(Res.string.timeline_terminal_customize_keys)) },
        text = {
            Column(
                Modifier.fillMaxWidth().heightIn(max = 420.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                // Portrait phone mockup showing the live quick-key bar arrangement.
                val frameRadius = RoundedCornerShape(LocalInterfaceStyle.current.metrics.groupRadius)
                Column(
                    modifier = Modifier
                        .align(Alignment.CenterHorizontally)
                        .widthIn(max = 220.dp)
                        .fillMaxWidth()
                        .clip(frameRadius)
                        .background(colors.bg)
                        .border(hairline, colors.line, frameRadius)
                        .padding(6.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(shape)
                            .background(surfaces.card)
                            .padding(horizontal = 8.dp, vertical = 6.dp),
                        verticalArrangement = Arrangement.spacedBy(2.dp),
                    ) {
                        Text("~/riffet main", style = typography.caption, color = colors.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text("❯ claude", style = typography.label, color = colors.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    if (keys.size <= 8) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                            keys.forEach { key ->
                                val isPrimary = key == TerminalQuickKey.ENTER
                                Box(
                                    modifier = Modifier
                                        .weight(1f)
                                        .height(24.dp)
                                        .clip(shape)
                                        .background(if (isPrimary) surfaces.primaryAction else surfaces.card)
                                        .border(hairline, if (isPrimary) surfaces.primaryAction else colors.line, shape),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Text(
                                        key.label(newlineLabel),
                                        style = typography.caption,
                                        color = if (isPrimary) surfaces.primaryActionContent else colors.fg2,
                                        maxLines = 1,
                                        softWrap = false,
                                        overflow = TextOverflow.Clip,
                                    )
                                }
                            }
                        }
                    } else {
                        Row(
                            Modifier.fillMaxWidth().riffetHorizontalScroll(rememberScrollState()),
                            horizontalArrangement = Arrangement.spacedBy(3.dp),
                        ) {
                            keys.forEach { key ->
                                val isPrimary = key == TerminalQuickKey.ENTER
                                Box(
                                    modifier = Modifier
                                        .widthIn(min = 28.dp)
                                        .height(24.dp)
                                        .clip(shape)
                                        .background(if (isPrimary) surfaces.primaryAction else surfaces.card)
                                        .border(hairline, if (isPrimary) surfaces.primaryAction else colors.line, shape)
                                        .padding(horizontal = 4.dp),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Text(
                                        key.label(newlineLabel),
                                        style = typography.caption,
                                        color = if (isPrimary) surfaces.primaryActionContent else colors.fg2,
                                        maxLines = 1,
                                        softWrap = false,
                                        overflow = TextOverflow.Clip,
                                    )
                                }
                            }
                        }
                    }
                }
                Text(stringResource(Res.string.timeline_terminal_quick_keys_active), style = typography.caption, color = colors.fg3)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    keys.forEachIndexed { index, key ->
                        Row(
                            modifier = Modifier
                                .clip(shape)
                                .background(surfaces.card)
                                .border(hairline, colors.line, shape)
                                .padding(horizontal = 6.dp, vertical = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(4.dp),
                        ) {
                            if (index > 0) {
                                Icon(
                                    imageVector = RiffetIcons.ChevronLeft,
                                    contentDescription = null,
                                    tint = colors.fg3,
                                    modifier = Modifier.size(16.dp).clickable {
                                        val next = keys.toMutableList()
                                        val moved = next.removeAt(index)
                                        next.add(index - 1, moved)
                                        onChange(next)
                                    },
                                )
                            }
                            Text(key.label(newlineLabel), style = typography.label, color = colors.fg)
                            if (index < keys.lastIndex) {
                                Icon(
                                    imageVector = RiffetIcons.ChevronRight,
                                    contentDescription = null,
                                    tint = colors.fg3,
                                    modifier = Modifier.size(16.dp).clickable {
                                        val next = keys.toMutableList()
                                        val moved = next.removeAt(index)
                                        next.add(index + 1, moved)
                                        onChange(next)
                                    },
                                )
                            }
                            if (keys.size > 1) {
                                Icon(
                                    imageVector = RiffetIcons.Close,
                                    contentDescription = null,
                                    tint = colors.fg3,
                                    modifier = Modifier.size(14.dp).clickable {
                                        onChange(keys.filter { it != key })
                                    },
                                )
                            }
                        }
                    }
                }
                if (available.isNotEmpty()) {
                    Spacer(Modifier.height(4.dp))
                    Text(stringResource(Res.string.timeline_terminal_quick_keys_available), style = typography.caption, color = colors.fg3)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        available.forEach { key ->
                            Row(
                                modifier = Modifier
                                    .clip(shape)
                                    .background(colors.bg)
                                    .border(hairline, colors.line, shape)
                                    .clickable { onChange(keys + key) }
                                    .padding(horizontal = 8.dp, vertical = 4.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(4.dp),
                            ) {
                                Icon(imageVector = RiffetIcons.Plus, contentDescription = null, tint = colors.fg3, modifier = Modifier.size(12.dp))
                                Text(key.label(newlineLabel), style = typography.label, color = colors.fg2)
                            }
                        }
                    }
                }
            }
        },
        dismissButton = {
            RiffetTextButton(onClick = { onChange(TerminalQuickKey.DEFAULT) }) {
                Text(stringResource(Res.string.timeline_terminal_quick_keys_reset))
            }
        },
        confirmButton = {
            RiffetTextButton(onClick = onDismiss) {
                Text(stringResource(Res.string.timeline_terminal_quick_keys_done))
            }
        },
    )
}

private val KeyGap = 4.dp

/** The 更多 row scrolls; its keys keep at least a touch target's width. */
private val MinKeyWidth = 40.dp

@Composable
private fun KeyButton(key: BarKey, modifier: Modifier, enabled: Boolean, inset: Dp = 6.dp) {
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
    val keyColor = if (!enabled) surfaces.card else if (key.primary) surfaces.primaryAction else if (active) selected else colors.bg
    Box(
        modifier
            .heightIn(min = designMetrics.controlHeight)
            .clip(shape)
            .background(if (pressed) pressColor.compositeOver(keyColor) else keyColor)
            .border(designMetrics.hairlineWidth, if (key.primary && enabled) surfaces.primaryAction else if (active) selected else colors.line, shape)
            // Accessibility activation sends one command without requesting IME focus.
            .semantics {
                role = Role.Button
                if (key.active != null) this.selected = active
                if (enabled) onClick {
                    press()
                    true
                } else disabled()
            }
            // A held key repeats from the press: sliding off it is not a page swipe.
            .horizontalSwipeChild { enabled }
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
            .padding(horizontal = inset),
        contentAlignment = Alignment.Center,
    ) {
        val content = when {
            !enabled -> surfaces.disabledContent
            key.primary -> surfaces.primaryActionContent
            active -> selectedContent
            else -> colors.fg2
        }
        Text(key.label, style = typography.label, color = content, maxLines = 1, softWrap = false, overflow = TextOverflow.Clip)
    }
}
