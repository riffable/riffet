package riffet.ui.settings

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import org.jetbrains.compose.resources.stringResource
import riffet_mobile.shared.generated.resources.*
import riffet.ui.app.LocalPageActive
import riffet.ui.app.LocalPageBack
import riffet.ui.app.PageLeaveGuard
import riffet.ui.app.PageBackHandler
import riffet.ui.design.ConfirmDialog

/**
 * A single guard shared by the bar's cancel or back, system back and the app's swipe: with unsaved
 * changes it asks to discard them. Saving is the page's own button, so the question has one answer.
 */
@Composable
internal fun UnsavedSettingsGuard(dirty: Boolean, busy: Boolean) {
    val back = LocalPageBack.current
    var asking by remember { mutableStateOf(false) }
    PageLeaveGuard {
        when {
            busy -> false
            dirty -> { asking = true; false }
            else -> true
        }
    }
    if (asking && LocalPageActive.current) {
        PageBackHandler { asking = false }
        DiscardChangesDialog(onDiscard = { asking = false; back?.leaveConfirmed() }, onDismiss = { asking = false })
    }
}

/** The one wording for leaving unsaved changes, used by the guard and by pages that swap content. */
@Composable
internal fun DiscardChangesDialog(onDiscard: () -> Unit, onDismiss: () -> Unit) {
    ConfirmDialog(
        title = stringResource(Res.string.settings_discard_unsaved_title),
        confirmLabel = stringResource(Res.string.app_discard),
        cancelLabel = stringResource(Res.string.settings_keep_editing),
        danger = true,
        onConfirm = onDiscard,
        onDismiss = onDismiss,
    )
}
