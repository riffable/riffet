package riffet.shared

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context

private const val CHANNEL_ID = "riffet.connection"
private const val NOTIFICATION_ID = 1

/**
 * Posts a local notification. Requires `POST_NOTIFICATIONS` on Android 13+; the host requests it,
 * this class only checks whether the channel exists.
 */
private class AndroidNotifier(private val context: Context) : Notifier {
    override fun notify(title: String, body: String) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Riffet", NotificationManager.IMPORTANCE_DEFAULT),
        )
        val notification = Notification.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_riffet)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .build()
        manager.notify(NOTIFICATION_ID, notification)
    }
}

actual fun createNotifier(): Notifier = AndroidNotifier(RiffetAndroid.requireContext())
