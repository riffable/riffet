package riffet.ui.focus

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.geometry.Offset

/*
 * ============================================================================================
 * Who holds focus: the composer, a text selection, or nobody
 * ============================================================================================
 *
 * Compose has one focus owner per window, and on a screen with a composer and a selectable
 * transcript three states compete for it:
 *
 *  - the composer's text field is focused: the keyboard is up;
 *  - a `SelectionContainer` is focused: it takes focus when a long press starts a selection, shows
 *    the Copy menu only while it has focus, and drops the selection (menu included) the moment focus
 *    leaves it (`SelectionManager.modifier`: `onFocusChanged { if (!hasFocus) onRelease() }`);
 *  - nothing is focused: a tap on the conversation must end either of the two, as a browser does.
 *
 * So every `clearFocus()` is also "drop the selection", and every focus request elsewhere is too.
 * The rules below are the whole contract, each implemented once in this package:
 *
 *  1. **Only a real tap ends focus** (`Modifier.blurOnTap`): one finger, lifted before the
 *     long-press timeout, without leaving the touch slop. A press that became a long press or a drag
 *     stays disqualified until every finger is up — never re-judged halfway through.
 *  2. **A tap on a keeper keeps focus** (`Modifier.keepsFocusOnTap`): the composer dock and other
 *     inputs inside a blur area handle their own taps.
 *  3. **Keyboard space is held while a finger is down** (`Modifier.keyboardPadding`): a long press
 *     that moves focus from the composer to the transcript closes the keyboard mid-press, and the
 *     transcript growing under a finger that has not lifted would drag the new selection with it.
 *  4. **A selection pauses the transcript** ([selecting]): following the tail would scroll the
 *     selected row away, and a row scrolled out of the lazy list takes its selection with it.
 *  5. **Copy ends the selection and releases focus** (`SelectableText`): the platform menu already
 *     clears the selection; releasing focus as well returns the screen to rule 1's resting state.
 */

/** The focus state shared by the screens of one window; see the rules above. */
@Stable
class FocusCoordinator {
    /** A finger is down on a [blurOnTap] area; [keyboardPadding] holds the keyboard's space meanwhile. */
    var pressing: Boolean by mutableStateOf(false)
        internal set

    private val selections = mutableStateListOf<Any>()

    /** Some read-only text holds focus, i.e. it has a selection or just had one (rule 4). */
    val selecting: Boolean get() = selections.isNotEmpty()

    private val keepers = mutableListOf<FocusKeeper>()

    internal fun setSelecting(owner: Any, focused: Boolean) {
        if (focused) {
            if (owner !in selections) selections += owner
        } else {
            selections -= owner
        }
    }

    internal fun register(keeper: FocusKeeper) {
        keepers += keeper
    }

    internal fun unregister(keeper: FocusKeeper) {
        keepers -= keeper
    }

    /** Whether a press at [positionInWindow] landed on a control that owns its own taps. */
    internal fun isKept(positionInWindow: Offset): Boolean = keepers.any { it.contains(positionInWindow) }
}

internal interface FocusKeeper {
    fun contains(positionInWindow: Offset): Boolean
}

/**
 * Provided once at the root of the app. The fallback is one shared instance, not a new one per
 * read, so a preview or a test without a provider still sees its keepers and its selections.
 */
val LocalFocusCoordinator = staticCompositionLocalOf { fallbackCoordinator }

private val fallbackCoordinator = FocusCoordinator()
