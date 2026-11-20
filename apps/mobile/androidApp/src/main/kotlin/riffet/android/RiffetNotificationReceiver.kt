package riffet.android

import android.app.RemoteInput
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.widget.Toast
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout
import riffet.contracts.NativeInteractionKind
import riffet.contracts.NativeInteractionResultStatus
import riffet.shared.AppLanguages
import riffet.ui.platform.ApprovalVerification
import riffet.ui.state.SessionStore

/**
 * What a notification's buttons and reply field do: answer the CLI's dialog, or send the next
 * message, without opening the app. The work outlives [onReceive] through [goAsync], and runs on
 * [RiffetHost]'s process scope, which also restores the paired store when the press started the
 * process.
 */
class RiffetNotificationReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val sessionId = intent.getStringExtra(EXTRA_SESSION) ?: return
        val origin = intent.getStringExtra(EXTRA_ORIGIN) ?: run {
            // Notifications created before origins were recorded cannot safely identify a server.
            Toast.makeText(context, AppLanguages.localize(context).getString(riffet.shared.R.string.host_notification_expired), Toast.LENGTH_SHORT).show()
            return
        }
        val pending = goAsync()
        val notifier = RiffetHost.notifier
        RiffetHost.launch {
            var store: SessionStore? = null
            fun title() = store?.list?.value?.sessions?.firstOrNull { it.id == sessionId }?.shownTitle
            fun problem(resource: Int) {
                val message = { AppLanguages.localize(context).getString(resource) }
                notifier.problem(sessionId, title(), message(), origin, localizeText = message)
            }
            try {
                withTimeout(RECEIVER_BUDGET_MILLIS) {
                    val open = RiffetHost.awaitStore() ?: run {
                        problem(riffet.shared.R.string.host_notification_unpaired)
                        return@withTimeout
                    }
                    if (RiffetHost.currentOrigin != origin || !RiffetHost.isCurrentStore(open)) {
                        problem(riffet.shared.R.string.host_notification_other_server)
                        return@withTimeout
                    }
                    // Capture this store once. A switch during the request must never redirect the
                    // write or its receipt to a newly installed store with the same session id.
                    store = open
                    when (intent.action) {
                        ACTION_RESPOND -> respond(context, open, notifier, sessionId, intent, origin, ::title)
                        ACTION_REPLY -> reply(context, open, notifier, sessionId, intent, origin, ::title)
                    }
                }
            } catch (_: TimeoutCancellationException) {
                problem(riffet.shared.R.string.host_notification_timeout)
            } finally {
                pending.finish()
            }
        }
    }

    private suspend fun respond(context: Context, store: SessionStore, notifier: RiffetNotifier, sessionId: String, intent: Intent, origin: String, title: () -> String?) {
        val interaction = intent.getStringExtra(EXTRA_INTERACTION) ?: return
        val revision = intent.getStringExtra(EXTRA_REVISION) ?: return
        val action = intent.getStringExtra(EXTRA_ACTION) ?: return
        val selected = intent.getStringArrayExtra(EXTRA_SELECTED)?.toList()
        // A button posted before 确认操作前验证本人 was turned on (or by a build that did not record
        // the kind) is not answered from here: the alert is kept, and opening it leads to the prompt.
        val kind = intent.getStringExtra(EXTRA_KIND)?.let { wire -> NativeInteractionKind.entries.firstOrNull { it.wire == wire } }
        if (ApprovalVerification.required && (kind == null || ApprovalVerification.guards(kind))) {
            val message = { AppLanguages.localize(context).getString(riffet.shared.R.string.host_notification_verify_in_app) }
            notifier.problem(sessionId, title(), message(), origin, localizeText = message)
            return
        }
        try {
            val result = store.respondFor(sessionId, interaction, revision, action, selected)
            val next = result.interaction
            when {
                result.status == NativeInteractionResultStatus.UNCERTAIN -> {
                    val detail = result.message
                    val message = { detail ?: AppLanguages.localize(context).getString(riffet.shared.R.string.host_notification_unconfirmed) }
                    notifier.problem(sessionId, title(), message(), origin, localizeText = message)
                }
                // A questionnaire moves on to its next question, which becomes the alert.
                next != null && (next.id != interaction || next.revision != revision) -> {
                    val session = store.list.value.sessions.firstOrNull { it.id == sessionId }
                    if (session != null) notifier.postInteraction(store, session, next, origin) else notifier.cancel(sessionId, origin)
                }
                else -> {
                    val message = { AppLanguages.localize(context).getString(riffet.shared.R.string.host_notification_submitted) }
                    notifier.settle(sessionId, title(), message(), origin, localizeText = message)
                }
            }
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Throwable) {
            val message = {
                val localized = AppLanguages.localize(context)
                localized.getString(
                    riffet.shared.R.string.host_notification_submit_failed,
                    error.message ?: localized.getString(riffet.shared.R.string.host_network_error),
                )
            }
            notifier.problem(sessionId, title(), message(), origin, localizeText = message)
        }
    }

    private suspend fun reply(context: Context, store: SessionStore, notifier: RiffetNotifier, sessionId: String, intent: Intent, origin: String, title: () -> String?) {
        val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(KEY_REPLY)?.toString()?.trim()
        if (text.isNullOrEmpty()) {
            notifier.cancel(sessionId, origin)
            return
        }
        try {
            store.replyFor(sessionId, text)
            val message = { AppLanguages.localize(context).getString(riffet.shared.R.string.host_notification_sent, text) }
            notifier.settle(sessionId, title(), message(), origin, localizeText = message)
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Throwable) {
            val message = {
                val localized = AppLanguages.localize(context)
                localized.getString(
                    riffet.shared.R.string.host_notification_send_incomplete,
                    error.message ?: localized.getString(riffet.shared.R.string.host_network_error),
                )
            }
            notifier.problem(sessionId, title(), message(), origin, localizeText = message)
        }
    }

    companion object {
        const val ACTION_RESPOND = "riffet.android.RESPOND"
        const val ACTION_REPLY = "riffet.android.REPLY"
        const val EXTRA_SESSION = "riffet.session"
        const val EXTRA_ORIGIN = "riffet.origin"
        const val EXTRA_INTERACTION = "riffet.interaction"
        const val EXTRA_REVISION = "riffet.revision"
        const val EXTRA_ACTION = "riffet.action"
        const val EXTRA_SELECTED = "riffet.selected"
        const val EXTRA_KIND = "riffet.kind"
        const val KEY_REPLY = "riffet.reply"

        /** A broadcast gets about ten seconds; anything slower is reported instead of left spinning. */
        private const val RECEIVER_BUDGET_MILLIS = 9_000L
    }
}
