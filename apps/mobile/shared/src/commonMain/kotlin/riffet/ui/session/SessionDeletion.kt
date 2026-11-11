package riffet.ui.session

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.getString
import org.jetbrains.compose.resources.stringResource
import riffet.contracts.Session
import riffet.shared.RiffetHttpException
import riffet.shared.SessionDeletionPreview
import riffet.ui.app.LocalRiffetSnackbar
import riffet.ui.design.AlertDialog
import riffet.ui.design.RiffetTextButton
import riffet.ui.state.SessionStore
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet_mobile.shared.generated.resources.Res
import riffet_mobile.shared.generated.resources.app_operation_failed
import riffet_mobile.shared.generated.resources.session_cancel
import riffet_mobile.shared.generated.resources.session_delete_body
import riffet_mobile.shared.generated.resources.session_delete_confirm
import riffet_mobile.shared.generated.resources.session_delete_discussions
import riffet_mobile.shared.generated.resources.session_delete_schedules
import riffet_mobile.shared.generated.resources.session_delete_title

private const val SCOPE_CHANGED = "SESSION_DELETE_SCOPE_CHANGED"

/**
 * Deleting a conversation: the preview, the confirmation and the request, held once for the app so
 * the list's menu and the details pane share one dialog. [request] asks the server what the delete
 * would remove; a blocker or a failure is told where the action started (the snackbar), anything
 * else opens the dialog. Nothing is removed from the list here: [SessionStore.deleteSession] does it
 * once the server has confirmed.
 */
internal class SessionDeletion(
    private val store: SessionStore,
    private val scope: CoroutineScope,
    private val notify: (String) -> Unit,
) {
    internal class Pending(val session: Session, val preview: SessionDeletionPreview)

    /** The conversation whose preview is loading; only that entry is disabled meanwhile. */
    var preparing: String? by mutableStateOf(null)
        private set
    var pending: Pending? by mutableStateOf(null)
        private set
    var submitting: Boolean by mutableStateOf(false)
        private set
    var error: String? by mutableStateOf(null)
        private set

    fun request(session: Session) {
        if (preparing != null || pending != null) return
        preparing = session.id
        scope.launch {
            try {
                val preview = store.deletionPreview(session.id)
                val blocker = preview.blocker
                if (blocker != null) notify(blocker.text) else pending = Pending(session, preview)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (failure: Throwable) {
                notify(failure.message?.takeIf { it.isNotBlank() } ?: getString(Res.string.app_operation_failed))
            } finally {
                preparing = null
            }
        }
    }

    fun dismiss() {
        if (submitting) return
        pending = null
        error = null
    }

    fun confirm() {
        val target = pending ?: return
        if (submitting) return
        submitting = true
        error = null
        scope.launch {
            try {
                store.deleteSession(target.session.id, target.preview.sessionIds)
                pending = null
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (failure: Throwable) {
                error = failure.message?.takeIf { it.isNotBlank() } ?: getString(Res.string.app_operation_failed)
                // The set changed under the confirmation: show the new one for a fresh confirmation.
                if ((failure as? RiffetHttpException)?.code == SCOPE_CHANGED) refresh(target)
            } finally {
                submitting = false
            }
        }
    }

    private suspend fun refresh(target: Pending) {
        try {
            val preview = store.deletionPreview(target.session.id)
            val blocker = preview.blocker
            if (blocker != null) {
                pending = null
                error = null
                notify(blocker.text)
            } else if (pending === target) {
                pending = Pending(target.session, preview)
            }
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (_: Throwable) {
            // The scope error above stays; confirming again fails the same way until a preview succeeds.
        }
    }

    /** A conversation left (here or on another device): a confirmation for it has nothing to confirm. */
    fun forget(ids: List<String>) {
        val target = pending ?: return
        if (target.session.id in ids) {
            pending = null
            error = null
        }
    }
}

@Composable
internal fun rememberSessionDeletion(store: SessionStore, scope: CoroutineScope): SessionDeletion {
    val snackbar by rememberUpdatedState(LocalRiffetSnackbar.current)
    return remember(store, scope) { SessionDeletion(store, scope) { message -> snackbar?.show(message) } }
}

/** The confirmation; default focus is on 取消. State lives in [deletion], the caller of the entries. */
@Composable
internal fun SessionDeletionDialog(deletion: SessionDeletion) {
    val target = deletion.pending ?: return
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val submitting = deletion.submitting
    val effects = target.preview.effects
    AlertDialog(
        onDismissRequest = deletion::dismiss,
        title = { Text(stringResource(Res.string.session_delete_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(Res.string.session_delete_body))
                if (effects.discussions > 0) Text(stringResource(Res.string.session_delete_discussions, effects.discussions))
                if (effects.schedules > 0) Text(stringResource(Res.string.session_delete_schedules, effects.schedules))
                deletion.error?.let { Text(it, style = typography.caption, color = colors.danger) }
            }
        },
        confirmButton = {
            RiffetTextButton(enabled = !submitting, danger = true, onClick = deletion::confirm) {
                Text(stringResource(Res.string.session_delete_confirm), color = colors.danger)
            }
        },
        dismissButton = {
            val focus = remember { FocusRequester() }
            LaunchedEffect(target) { focus.requestFocus() }
            RiffetTextButton(enabled = !submitting, onClick = deletion::dismiss, modifier = Modifier.focusRequester(focus)) {
                Text(stringResource(Res.string.session_cancel))
            }
        },
    )
}
