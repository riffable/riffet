package riffet.ui.settings

import riffet.ui.design.AlertDialog
import androidx.compose.material3.Text
import riffet.ui.design.RiffetTextButton
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

/** A single guard shared by title-bar, system and app-swipe back. Failed saves stay on the page. */
@Composable
internal fun UnsavedSettingsGuard(
    dirty: Boolean,
    busy: Boolean,
    canSave: Boolean = true,
    onSave: ((() -> Unit) -> Unit),
) {
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
        AlertDialog(
            onDismissRequest = { asking = false },
            title = { Text(stringResource(Res.string.settings_unsaved_title)) },
            confirmButton = {
                RiffetTextButton(enabled = !busy && canSave, onClick = {
                    asking = false
                    onSave { back?.leaveConfirmed() }
                }) { Text(stringResource(Res.string.settings_save_and_back)) }
            },
            dismissButton = {
                RiffetTextButton(enabled = !busy, danger = true, onClick = { asking = false; back?.leaveConfirmed() }) { Text(stringResource(Res.string.settings_discard_changes)) }
                RiffetTextButton(onClick = { asking = false }) { Text(stringResource(Res.string.settings_keep_editing)) }
            },
        )
    }
}
