package riffet.android

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import riffet.shared.AppLog
import riffet.shared.AppLanguages
import riffet.shared.DeviceControl

/**
 * Keeps the process in the foreground state while a conversation is mid-turn, or a session stream
 * is open with the app in front, so Android neither freezes it nor reclaims it once the app is in the background. The
 * stream and the list polling live in [RiffetHost]; this service keeps their process running, and
 * its notification is the live view of what is happening: the conversation, its current step and a
 * running clock ([LiveStatus]). Meanwhile it has the store refresh now and then, which prefetches
 * the conversations that moved onto the device.
 *
 * [RiffetHost] starts it while the app is in front and stops it once nothing is left to keep.
 */
class RiffetSyncService : Service() {
    private val scope = MainScope()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(NotificationManager::class.java)
        refreshChannel(manager)
        // In onCreate, not onStartCommand: a stop that races the start must still find the service
        // already in the foreground, or Android kills the app for a missed startForeground.
        enterForeground(notification(RiffetHost.live.value))
        running = true
        scope.launch {
            RiffetHost.live.collect { status -> refreshNotification(manager, status) }
        }
        scope.launch {
            AppLanguages.changes.collect {
                refreshChannel(manager)
                refreshNotification(manager, RiffetHost.live.value)
            }
        }
        // While the process is kept up anyway, the conversations that moved are brought to the
        // device in the background, so returning to one finds it current without waiting.
        scope.launch {
            while (true) {
                delay(BACKGROUND_REFRESH_MILLIS)
                RiffetHost.store.value?.refresh()
            }
        }
    }

    private fun refreshChannel(manager: NotificationManager) {
        val context = AppLanguages.localize(this)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, context.getString(riffet.shared.R.string.host_notification_channel_sync), NotificationManager.IMPORTANCE_LOW).apply {
                description = context.getString(riffet.shared.R.string.host_notification_channel_sync_desc)
                setShowBadge(false)
            },
        )
    }

    private fun refreshNotification(manager: NotificationManager, status: LiveStatus) {
        // Android permits dismissing an ongoing service notification; a locale update respects that.
        if (manager.activeNotifications.any { it.tag == null && it.id == NOTIFICATION_ID }) {
            manager.notify(NOTIFICATION_ID, notification(status))
        }
    }

    /**
     * `specialUse` from Android 14, where it exists and has no daily limit; `dataSync` (capped at six
     * hours a day from Android 15) only below that, where it is uncapped anyway. Both are declared.
     */
    private fun enterForeground(notification: Notification) {
        val base = when {
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE -> ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q -> ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            else -> {
                startForeground(NOTIFICATION_ID, notification)
                return
            }
        }
        // With location allowed, the `location` type is what lets a device call read a fix while the
        // app is in the background. Android refuses it when started from the background (a lease's
        // alarm, boot); the service then runs without it.
        if (DeviceControl.allowed.value && locationAllowed()) {
            try {
                startForeground(NOTIFICATION_ID, notification, base or ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
                locationTyped = true
                return
            } catch (failure: RuntimeException) {
                AppLog.log("app", "keep-alive without location type ${failure::class.simpleName}")
            }
        }
        startForeground(NOTIFICATION_ID, notification, base)
        locationTyped = false
    }

    private fun locationAllowed() =
        checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_REFRESH_TYPES) enterForeground(notification(RiffetHost.live.value))
        return START_NOT_STICKY
    }

    /**
     * Swiping the app away from recents is a request to quit; the stream ends with the process.
     * While the device may be called, the connection is what the owner asked for, so it stays.
     */
    override fun onTaskRemoved(rootIntent: Intent?) {
        if (!DeviceControl.allowed.value) stopSelf()
    }

    /**
     * A time-limited type ran out (`dataSync` on Android 15+, should an older build's service still
     * be running under it). Stopping at once is required; the next return to the app restarts it.
     */
    override fun onTimeout(startId: Int, fgsType: Int) {
        AppLog.log("app", "keep-alive timed out type=$fgsType")
        stopSelf()
    }

    override fun onDestroy() {
        running = false
        locationTyped = false
        scope.cancel()
        super.onDestroy()
    }

    private fun notification(status: LiveStatus): Notification {
        val builder = Notification.Builder(AppLanguages.localize(this), CHANNEL_ID)
            .setSmallIcon(riffet.shared.R.drawable.ic_stat_riffet)
            .setContentTitle(status.title.ifBlank { "Riffet" })
            .setContentText(status.text)
            .setContentIntent(RiffetHost.notifier.open(status.sessionId, RiffetHost.currentOrigin))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            // A group of its own: auto-grouped with the turn alerts, its ongoing flag would make
            // their summary ongoing too, so "clear all" could no longer clear them.
            .setGroup(GROUP_KEY)
            .setCategory(if (status.running) Notification.CATEGORY_PROGRESS else Notification.CATEGORY_SERVICE)
        val since = status.since
        if (status.running && since != null) {
            builder.setWhen(since).setShowWhen(true).setUsesChronometer(true).setProgress(0, 0, true)
            // Android 16's promoted ongoing notification: a live chip in the status bar and a place on
            // the lock screen. Older systems ignore the extra.
            builder.extras.putBoolean(EXTRA_REQUEST_PROMOTED_ONGOING, true)
            builder.setShortCriticalTextCompat(status)
        } else {
            builder.setShowWhen(false)
        }
        return builder.build()
    }

    /** The status-bar chip's text on Android 16; set by name because compileSdk predates the API. */
    private fun Notification.Builder.setShortCriticalTextCompat(status: LiveStatus) {
        if (Build.VERSION.SDK_INT < 36) return
        runCatching {
            Notification.Builder::class.java.getMethod("setShortCriticalText", String::class.java)
                .invoke(this, status.text.substringBefore(" · ").take(SHORT_TEXT_LIMIT))
        }
    }

    companion object {
        /** Whether the running service holds the `location` type; see [enterForeground]. */
        @Volatile
        var locationTyped = false
            private set

        @Volatile
        private var running = false

        private const val ACTION_REFRESH_TYPES = "riffet.keepalive.REFRESH_TYPES"

        /** A permission changed while the service runs (the app is in front): take up the matching types. */
        fun refreshTypes(context: Context) {
            if (!running) return
            try {
                context.startService(Intent(context, RiffetSyncService::class.java).setAction(ACTION_REFRESH_TYPES))
            } catch (_: RuntimeException) {
            }
        }

        private const val CHANNEL_ID = "riffet.keepalive"
        private const val GROUP_KEY = "riffet.keepalive"
        private const val NOTIFICATION_ID = 2
        private const val EXTRA_REQUEST_PROMOTED_ONGOING = "android.requestPromotedOngoing"
        private const val SHORT_TEXT_LIMIT = 12

        /** A refresh is one small request plus the deltas of what moved; this keeps it occasional. */
        private const val BACKGROUND_REFRESH_MILLIS = 5 * 60_000L
    }
}
