package riffet.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.RemoteInput
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import kotlinx.coroutines.CancellationException
import riffet.contracts.NativeInteraction
import riffet.contracts.Session
import riffet.contracts.SessionState
import riffet.shared.AppLanguages
import riffet.ui.state.SessionAlert
import riffet.ui.state.SessionAlertKind
import riffet.ui.state.SessionStore
import riffet.ui.state.interactionChoices
import riffet.ui.platform.ApprovalVerification

/**
 * The notifications that bring the reader back to a conversation: a turn that finished, failed or
 * was interrupted, and a dialog the CLI is waiting on. Each server/conversation pair has one
 * notification slot, so a newer alert replaces its older one instead of stacking.
 *
 * A dialog with few enough answers gets them as buttons, and every alert can be replied to from the
 * shade; both go through [RiffetNotificationReceiver].
 */
class RiffetNotifier(private val rawContext: Context) {
    private val context get() = AppLanguages.localize(rawContext)
    private val manager = rawContext.getSystemService(NotificationManager::class.java)

    /** Conversations whose slot holds a waiting dialog, cleared once the dialog is gone. */
    private val waiting = mutableSetOf<Pair<String, String>>()

    /** Rendering inputs only: a language change never re-fetches or repeats an alert's action. */
    private class Posted(val recordedAt: Long, val expiresAt: Long?, val render: () -> Notification.Builder)
    private val posted = mutableMapOf<Pair<String, Int>, Posted>()

    init {
        refreshChannels()
        // Downloads report on their own in-app page now; drop the channel older builds created.
        manager.deleteNotificationChannel("riffet.downloads")
    }

    private fun refreshChannels() {
        manager.createNotificationChannels(
            listOf(
                NotificationChannel(CHANNEL_ATTENTION, context.getString(riffet.shared.R.string.host_notification_channel_attention), NotificationManager.IMPORTANCE_HIGH).apply {
                    description = context.getString(riffet.shared.R.string.host_notification_channel_attention_desc)
                },
                NotificationChannel(CHANNEL_TURNS, context.getString(riffet.shared.R.string.host_notification_channel_turns), NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = context.getString(riffet.shared.R.string.host_notification_channel_turns_desc)
                },
                NotificationChannel(CHANNEL_AGENT, context.getString(riffet.shared.R.string.host_notification_channel_agent), NotificationManager.IMPORTANCE_HIGH).apply {
                    description = context.getString(riffet.shared.R.string.host_notification_channel_agent_desc)
                },
            ),
        )
    }

    /** Refresh only notifications still visible, preserving their timestamps and expiration. */
    @Synchronized
    fun refreshLanguage() {
        refreshChannels()
        val visible = manager.activeNotifications.associateBy { it.tag to it.id }
        val now = SystemClock.elapsedRealtime()
        // A just-enqueued notification may not be visible yet; the application retries once.
        posted.entries.removeAll { (key, entry) -> key !in visible && now - entry.recordedAt >= POST_VISIBILITY_GRACE_MILLIS }
        for ((key, entry) in posted) {
            val previous = visible[key] ?: continue
            val remaining = entry.expiresAt?.minus(SystemClock.elapsedRealtime())
            if (remaining != null && remaining <= 0) continue
            val builder = entry.render().setWhen(previous.notification.`when`).setOnlyAlertOnce(true)
            remaining?.let(builder::setTimeoutAfter)
            manager.notify(key.first, key.second, builder.build())
        }
    }

    @Synchronized
    private fun post(tag: String, id: Int, timeoutMillis: Long? = null, render: () -> Notification.Builder) {
        val timeout = timeoutMillis?.takeIf { it > 0 }
        val builder = render()
        timeout?.let(builder::setTimeoutAfter)
        manager.notify(tag, id, builder.build())
        // System-dismissed notifications do not retain their rendering inputs indefinitely.
        val visible = manager.activeNotifications.mapTo(HashSet()) { it.tag to it.id }
        val now = SystemClock.elapsedRealtime()
        // Enqueueing is asynchronous; retain very recent posts until the system can report them.
        posted.entries.removeAll { (key, entry) -> key !in visible && now - entry.recordedAt >= POST_VISIBILITY_GRACE_MILLIS }
        posted[tag to id] = Posted(now, timeout?.let { now + it }, render)
    }

    suspend fun alert(store: SessionStore, alert: SessionAlert, origin: String) {
        val session = alert.session
        when (alert.kind) {
            SessionAlertKind.WAITING -> {
                val interaction = try {
                    store.currentInteraction(session.id)
                } catch (cancellation: CancellationException) {
                    throw cancellation
                } catch (_: Throwable) {
                    null
                }
                postInteraction(store, session, interaction, origin)
            }
            SessionAlertKind.FINISHED -> postTurn(store, session, riffet.shared.R.string.host_notification_turn_finished, reply(store, session), origin)
            SessionAlertKind.FAILED -> postTurn(store, session, riffet.shared.R.string.host_notification_turn_failed, session.error, origin)
            SessionAlertKind.INTERRUPTED -> postTurn(store, session, riffet.shared.R.string.host_notification_turn_interrupted, session.error, origin)
        }
    }

    /** [interaction] as the conversation's alert; null still says that something is waiting. */
    fun postInteraction(store: SessionStore, session: Session, interaction: NativeInteraction?, origin: String) {
        val project = store.list.value.projects.firstOrNull { it.id == session.projectId }?.name
        post(tag(origin, session.id), ALERT_ID) { interactionNotification(project, session, interaction, origin) }
        waiting += origin to session.id
    }

    private fun interactionNotification(project: String?, session: Session, interaction: NativeInteraction?, origin: String): Notification.Builder {
        val body = listOfNotNull(interaction?.title, interaction?.message).joinToString("\n").ifBlank { context.getString(riffet.shared.R.string.host_notification_waiting_body) }
        val builder = base(project, session, CHANNEL_ATTENTION, context.getString(riffet.shared.R.string.host_notification_attention_title, session.shownTitle), body, origin)
            .setCategory(Notification.CATEGORY_REMINDER)
            // The dialog text is often the command being approved; the lock screen shows only this.
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setPublicVersion(
                Notification.Builder(context, CHANNEL_ATTENTION)
                    .setSmallIcon(riffet.shared.R.drawable.ic_stat_riffet)
                    .setContentTitle("Riffet")
                    .setContentText(context.getString(riffet.shared.R.string.host_notification_attention_public))
                    .build(),
            )
        // With 确认操作前验证本人 on, an approval is answered in the app, behind the system prompt;
        // the notification only opens it. A question is still answered from the shade.
        interaction?.takeUnless { ApprovalVerification.required && ApprovalVerification.guards(it.kind) }?.let { dialog ->
            interactionChoices(dialog).forEachIndexed { index, choice ->
                val intent = Intent(context, RiffetNotificationReceiver::class.java)
                    .setAction(RiffetNotificationReceiver.ACTION_RESPOND)
                    .setData(notificationUri(origin, session.id, "respond.$index"))
                    .putExtra(RiffetNotificationReceiver.EXTRA_ORIGIN, origin)
                    .putExtra(RiffetNotificationReceiver.EXTRA_SESSION, session.id)
                    .putExtra(RiffetNotificationReceiver.EXTRA_INTERACTION, dialog.id)
                    .putExtra(RiffetNotificationReceiver.EXTRA_KIND, dialog.kind.wire)
                    .putExtra(RiffetNotificationReceiver.EXTRA_REVISION, dialog.revision)
                    .putExtra(RiffetNotificationReceiver.EXTRA_ACTION, choice.action)
                    .putExtra(RiffetNotificationReceiver.EXTRA_SELECTED, choice.selectedIds?.toTypedArray())
                val pending = PendingIntent.getBroadcast(
                    context,
                    "$origin#${session.id}#$index".hashCode(),
                    intent,
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                )
                builder.addAction(Notification.Action.Builder(icon(), choice.label, pending).unlockedOnly().build())
            }
        }
        return builder
    }

    private fun postTurn(store: SessionStore, session: Session, outcomeId: Int, detail: String?, origin: String) {
        val project = store.list.value.projects.firstOrNull { it.id == session.projectId }?.name
        post(tag(origin, session.id), ALERT_ID) {
            val outcome = context.getString(outcomeId)
            base(project, session, CHANNEL_TURNS, session.shownTitle, detail?.takeIf { it.isNotBlank() }?.let { "$outcome · $it" } ?: outcome, origin)
                .setCategory(Notification.CATEGORY_MESSAGE)
                .addAction(replyAction(session.id, origin))
        }
        waiting -= origin to session.id
    }

    /** Replaces the conversation's alert with a short receipt that clears itself. */
    fun settle(sessionId: String, title: String?, text: String, origin: String, localizeText: (() -> String)? = null) {
        post(tag(origin, sessionId), ALERT_ID, SETTLED_TIMEOUT_MILLIS) {
            Notification.Builder(context, CHANNEL_TURNS)
                .setSmallIcon(riffet.shared.R.drawable.ic_stat_riffet)
                .setContentTitle(title ?: "Riffet")
                .setContentText(localizeText?.invoke() ?: text)
                .setContentIntent(open(sessionId, origin))
                .setOnlyAlertOnce(true)
                .setAutoCancel(true)
        }
        waiting -= origin to sessionId
    }

    /** Keeps the alert, saying what went wrong, so it can still be opened and handled in the app. */
    fun problem(sessionId: String, title: String?, text: String, origin: String, localizeText: (() -> String)? = null) {
        post(tag(origin, sessionId), ALERT_ID) {
            val body = localizeText?.invoke() ?: text
            Notification.Builder(context, CHANNEL_TURNS)
                .setSmallIcon(riffet.shared.R.drawable.ic_stat_riffet)
                .setContentTitle(title ?: "Riffet")
                .setContentText(body)
                .setStyle(Notification.BigTextStyle().bigText(body))
                .setContentIntent(open(sessionId, origin))
                .setOnlyAlertOnce(true)
                .setAutoCancel(true)
        }
        waiting -= origin to sessionId
    }

    /** Drops waiting alerts whose dialog the server no longer reports, e.g. answered on the Mac. */
    fun resolve(sessions: List<Session>, origin: String) {
        if (waiting.isEmpty()) return
        val states = sessions.associate { it.id to it.state }
        waiting.filter { (source, sessionId) -> source == origin && states[sessionId] != SessionState.WAITING }
            .forEach { (_, sessionId) -> cancel(sessionId, origin) }
    }

    @Synchronized
    fun cancel(sessionId: String, origin: String) {
        manager.cancel(tag(origin, sessionId), ALERT_ID)
        posted.remove(tag(origin, sessionId) to ALERT_ID)
        waiting -= origin to sessionId
    }

    private suspend fun reply(store: SessionStore, session: Session): String? = try {
        store.latestReply(session)
    } catch (cancellation: CancellationException) {
        throw cancellation
    } catch (_: Throwable) {
        null
    }

    private fun base(project: String?, session: Session, channel: String, title: String, text: String, origin: String): Notification.Builder {
        return Notification.Builder(context, channel)
            .setSmallIcon(riffet.shared.R.drawable.ic_stat_riffet)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setSubText(project)
            .setContentIntent(open(session.id, origin))
            .setAutoCancel(true)
            .setShowWhen(true)
            .setWhen(System.currentTimeMillis())
    }

    private fun replyAction(sessionId: String, origin: String): Notification.Action {
        val intent = Intent(context, RiffetNotificationReceiver::class.java)
            .setAction(RiffetNotificationReceiver.ACTION_REPLY)
            .setData(notificationUri(origin, sessionId, "reply"))
            .putExtra(RiffetNotificationReceiver.EXTRA_ORIGIN, origin)
            .putExtra(RiffetNotificationReceiver.EXTRA_SESSION, sessionId)
        // Mutable: the system writes the typed reply into this intent.
        val pending = PendingIntent.getBroadcast(
            context,
            "$origin#$sessionId#reply".hashCode(),
            intent,
            PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val input = RemoteInput.Builder(RiffetNotificationReceiver.KEY_REPLY).setLabel(context.getString(riffet.shared.R.string.host_notification_reply_hint)).build()
        return Notification.Action.Builder(icon(), context.getString(riffet.shared.R.string.host_notification_reply), pending)
            .addRemoteInput(input)
            .setAllowGeneratedReplies(false)
            .unlockedOnly()
            .build()
    }

    /**
     * An approval or a prompt sent from the shade acts on the Mac, so on Android 12+ the device has
     * to be unlocked first. Older versions have no such flag; there the private visibility above is
     * what keeps the buttons off a secure lock screen that hides sensitive content.
     */
    private fun Notification.Action.Builder.unlockedOnly(): Notification.Action.Builder {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) setAuthenticationRequired(true)
        return this
    }

    /** Opens the app on [sessionId]; the extra is read by [RiffetActivity]. */
    fun open(sessionId: String?, origin: String? = null): PendingIntent {
        val intent = Intent(context, RiffetActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        if (sessionId != null && origin != null) {
            intent.setData(notificationUri(origin, sessionId, "open"))
                .putExtra(RiffetActivity.EXTRA_SESSION, sessionId)
                .putExtra(RiffetNotificationReceiver.EXTRA_ORIGIN, origin)
        }
        return PendingIntent.getActivity(
            context,
            if (sessionId != null && origin != null) "$origin#$sessionId#open".hashCode() else 0,
            intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }

    /**
     * What an agent asked to show: a `notice` from the lists stream (`notify_user`, a wake-up that
     * could not run) or a `device_notify` call. Each [key] is its own notification; a tap opens the
     * conversation.
     */
    fun agentMessage(key: String, sessionId: String, title: String?, body: String, sessionTitle: String?, origin: String) {
        val heading = title?.takeIf { it.isNotBlank() }
        val builder = Notification.Builder(context, CHANNEL_AGENT)
            .setSmallIcon(riffet.shared.R.drawable.ic_stat_riffet)
            .setContentTitle(heading ?: sessionTitle ?: "Riffet")
            .setContentText(body)
            .setStyle(Notification.BigTextStyle().bigText(body))
            .setSubText(if (heading != null) sessionTitle else null)
            .setContentIntent(open(sessionId, origin))
            .setCategory(Notification.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setShowWhen(true)
            .setWhen(System.currentTimeMillis())
        manager.notify("$origin/agent/$key", AGENT_ID, builder.build())
    }

    /**
     * A call that needs the owner at the phone (a photo, a clipboard read from the background): a
     * heads-up whose tap is [action] and whose dismissal is [deny]. It goes when the call ends.
     */
    fun deviceRequest(
        callId: String, title: String, text: String?, action: PendingIntent, deny: PendingIntent, timeoutMillis: Long?,
        localizeTitle: (() -> String)? = null, localizeText: (() -> String?)? = null,
    ) {
        post("device/$callId", DEVICE_REQUEST_ID, timeoutMillis) {
            val builder = Notification.Builder(context, CHANNEL_ATTENTION)
                .setSmallIcon(riffet.shared.R.drawable.ic_stat_riffet)
                .setContentTitle(localizeTitle?.invoke() ?: title)
                .setContentIntent(action)
                .setDeleteIntent(deny)
                .setCategory(Notification.CATEGORY_REMINDER)
                .setAutoCancel(true)
                .setShowWhen(true)
                .setWhen(System.currentTimeMillis())
            (localizeText?.invoke() ?: text)?.takeIf { it.isNotBlank() }?.let { builder.setContentText(it) }
            builder
        }
    }

    @Synchronized
    fun cancelDeviceRequest(callId: String) {
        manager.cancel("device/$callId", DEVICE_REQUEST_ID)
        posted.remove("device/$callId" to DEVICE_REQUEST_ID)
    }

    private fun tag(origin: String, sessionId: String) = "$origin/session/$sessionId"

    // PendingIntent equality ignores extras. A data URI prevents actions for two services (or
    // colliding hash codes) from updating one another's captured origin and session.
    private fun notificationUri(origin: String, sessionId: String, action: String): Uri = Uri.Builder()
        .scheme("riffet")
        .authority("notification")
        .appendPath(origin)
        .appendPath(sessionId)
        .appendPath(action)
        .build()

    private fun icon(): Icon = Icon.createWithResource(context, riffet.shared.R.drawable.ic_stat_riffet)

    private companion object {
        const val CHANNEL_ATTENTION = "riffet.attention"
        const val CHANNEL_TURNS = "riffet.turns"
        const val CHANNEL_AGENT = "riffet.agent"
        const val ALERT_ID = 10
        const val AGENT_ID = 11
        const val DEVICE_REQUEST_ID = 12
        const val SETTLED_TIMEOUT_MILLIS = 4_000L
        const val POST_VISIBILITY_GRACE_MILLIS = 1_000L
    }
}
