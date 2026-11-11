package riffet.ui.focus

import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusManager
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalTextToolbar
import androidx.compose.ui.platform.TextToolbar
import androidx.compose.ui.platform.TextToolbarStatus
import riffet.ui.haptics.WithoutSelectionHaptics

/**
 * Read-only text the reader can long-press to select and copy: the platform's own handles and
 * menu (`SelectionContainer`), wired into the [FocusCoordinator] rules.
 *
 *  - Its focus is reported as [FocusCoordinator.selecting], which pauses the transcript's tail.
 *  - Copy from the menu releases focus after the platform has cleared the selection, so nothing
 *    is left holding focus with nothing selected.
 *  - Compose's `TextHandleMove` tick on every selection change is dropped (see
 *    [WithoutSelectionHaptics]).
 *
 * Wrap the smallest unit that should be selectable as a whole — a message, a code block, a line —
 * and never a `LazyColumn`, whose lazy composition a container above it is known to break.
 */
@Composable
internal fun SelectableText(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val coordinator = LocalFocusCoordinator.current
    val focusManager = LocalFocusManager.current
    val platform = LocalTextToolbar.current
    val owner = remember { Any() }
    DisposableEffect(coordinator) {
        onDispose { coordinator.setSelecting(owner, false) }
    }
    val toolbar = remember(platform, focusManager) { ReleasingTextToolbar(platform, focusManager) }
    WithoutSelectionHaptics {
        CompositionLocalProvider(LocalTextToolbar provides toolbar) {
            SelectionContainer(
                modifier = modifier.onFocusChanged { coordinator.setSelecting(owner, it.hasFocus) },
                content = content,
            )
        }
    }
}

/** The platform toolbar, with Copy followed by releasing focus. */
private class ReleasingTextToolbar(
    private val platform: TextToolbar,
    private val focusManager: FocusManager,
) : TextToolbar {
    override val status: TextToolbarStatus get() = platform.status

    override fun hide() = platform.hide()

    override fun showMenu(
        rect: Rect,
        onCopyRequested: (() -> Unit)?,
        onPasteRequested: (() -> Unit)?,
        onCutRequested: (() -> Unit)?,
        onSelectAllRequested: (() -> Unit)?,
    ) = showMenu(rect, onCopyRequested, onPasteRequested, onCutRequested, onSelectAllRequested, null)

    override fun showMenu(
        rect: Rect,
        onCopyRequested: (() -> Unit)?,
        onPasteRequested: (() -> Unit)?,
        onCutRequested: (() -> Unit)?,
        onSelectAllRequested: (() -> Unit)?,
        onAutofillRequested: (() -> Unit)?,
    ) = platform.showMenu(
        rect = rect,
        onCopyRequested = onCopyRequested?.let { copy -> { copy(); focusManager.clearFocus() } },
        onPasteRequested = onPasteRequested,
        onCutRequested = onCutRequested,
        onSelectAllRequested = onSelectAllRequested,
        onAutofillRequested = onAutofillRequested,
    )
}
