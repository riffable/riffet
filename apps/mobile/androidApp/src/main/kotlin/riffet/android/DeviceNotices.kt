package riffet.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import riffet.shared.AppLanguages
import riffet.shared.R

/**
 * Screen-control notifications (docs/DEVICES.md §5): the ongoing one with 停止 while a control call
 * runs, the hand-off of a payment to the owner, and the request to unlock.
 */
internal object DeviceNotices {
    private const val CHANNEL_CONTROL = "riffet.device.control"
    /** The app's high-importance channel, created by RiffetNotifier. */
    private const val CHANNEL_ATTENTION = "riffet.attention"
    private const val CONTROL_ID = 20
    private const val HANDOFF_ID = 21
    private const val LOCKED_ID = 22
    private const val LOCKED_EVERY_MILLIS = 60_000L
    private const val LOCKED_TIMEOUT_MILLIS = 5 * 60_000L

    @Volatile
    private var lockedAt = 0L

    private class Posted(val recordedAt: Long, val expiresAt: Long?, val render: (Context) -> Notification.Builder)
    private val posted = mutableMapOf<Int, Posted>()

    private fun manager(context: Context) = context.getSystemService(NotificationManager::class.java)

    private fun refreshChannel(context: Context) {
        val manager = manager(context) ?: return
        manager.createNotificationChannel(NotificationChannel(CHANNEL_CONTROL, context.getString(R.string.host_device_control_channel), NotificationManager.IMPORTANCE_LOW))
    }

    /** Re-render existing notices without repeating a control call, handoff, or unlock request. */
    @Synchronized
    fun refreshLanguage(rawContext: Context) {
        val context = AppLanguages.localize(rawContext)
        val manager = manager(context) ?: return
        if (manager.getNotificationChannel(CHANNEL_CONTROL) != null) refreshChannel(context)
        val visible = manager.activeNotifications.filter { it.tag == null }.associateBy { it.id }
        val now = SystemClock.elapsedRealtime()
        posted.entries.removeAll { (id, entry) -> id !in visible && now - entry.recordedAt >= 1_000L }
        for ((id, entry) in posted) {
            val previous = visible[id] ?: continue
            val remaining = entry.expiresAt?.minus(SystemClock.elapsedRealtime())
            if (remaining != null && remaining <= 0) continue
            val builder = entry.render(context).setWhen(previous.notification.`when`).setOnlyAlertOnce(true)
            remaining?.let(builder::setTimeoutAfter)
            runCatching { manager.notify(id, builder.build()) }
        }
    }

    @Synchronized
    private fun post(rawContext: Context, id: Int, timeoutMillis: Long? = null, render: (Context) -> Notification.Builder) {
        val context = AppLanguages.localize(rawContext)
        val manager = manager(context) ?: return
        val builder = render(context)
        timeoutMillis?.let(builder::setTimeoutAfter)
        if (runCatching { manager.notify(id, builder.build()) }.isSuccess) {
            val now = SystemClock.elapsedRealtime()
            posted[id] = Posted(now, timeoutMillis?.let { now + it }, render)
        }
    }

    fun controlStarted(rawContext: Context) {
        refreshChannel(AppLanguages.localize(rawContext))
        post(rawContext, CONTROL_ID) { context ->
            val stop = PendingIntent.getBroadcast(
                context, CONTROL_ID,
                Intent(context, DeviceReceiver::class.java).setAction(DeviceReceiver.ACTION_STOP),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            Notification.Builder(context, CHANNEL_CONTROL)
                .setSmallIcon(R.drawable.ic_stat_riffet)
                .setContentTitle(context.getString(R.string.host_device_control_running))
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setCategory(Notification.CATEGORY_STATUS)
                .addAction(Notification.Action.Builder(null, context.getString(R.string.host_device_control_stop), stop).build())
        }
    }

    @Synchronized
    fun controlEnded(context: Context) {
        manager(context)?.cancel(CONTROL_ID)
        posted.remove(CONTROL_ID)
    }

    /** Paying is the owner's: the notification opens the app the agent stopped in. */
    fun handoff(rawContext: Context, packageName: String?, app: String?, target: String?) {
        post(rawContext, HANDOFF_ID) { context ->
            val launch = packageName?.let { context.packageManager.getLaunchIntentForPackage(it) }
            val builder = Notification.Builder(context, CHANNEL_ATTENTION)
                .setSmallIcon(R.drawable.ic_stat_riffet)
                .setContentTitle(context.getString(R.string.host_device_handoff_title))
                .setCategory(Notification.CATEGORY_REMINDER)
                .setAutoCancel(true)
            listOfNotNull(app, target).joinToString(" · ").takeIf { it.isNotEmpty() }?.let(builder::setContentText)
            launch?.let { builder.setContentIntent(PendingIntent.getActivity(context, HANDOFF_ID, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)) }
            builder
        }
    }

    /** At most once a minute: a run of calls against a locked phone is one request to unlock. */
    fun locked(context: Context) {
        val now = SystemClock.uptimeMillis()
        if (lockedAt != 0L && now - lockedAt < LOCKED_EVERY_MILLIS) return
        lockedAt = now
        post(context, LOCKED_ID, LOCKED_TIMEOUT_MILLIS) { localized ->
            Notification.Builder(localized, CHANNEL_ATTENTION)
                .setSmallIcon(R.drawable.ic_stat_riffet)
                .setContentTitle(localized.getString(R.string.host_device_locked_title))
                .setCategory(Notification.CATEGORY_REMINDER)
                .setAutoCancel(true)
        }
    }
}
