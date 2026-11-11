package riffet.android

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import kotlinx.serialization.builtins.ListSerializer
import riffet.contracts.DeviceLease
import riffet.contracts.RiffetJson
import riffet.shared.AppLog
import riffet.shared.DeviceControl
import riffet.shared.DeviceStop
import riffet.shared.DeviceLeaseScheduler
import riffet.shared.createAppPreferences
import java.time.Instant

/**
 * Leases as alarms (docs/DEVICES.md §3「预约唤醒」): each wakes the device [LEAD_MILLIS] before its
 * `at`, starts the keep-alive service and redials, so a scheduled call finds the phone online even
 * if the process had been killed. Leases are stored, so a reboot or an update re-arms them.
 *
 * Exact alarms need 闹钟和提醒 (SCHEDULE_EXACT_ALARM, off by default from Android 14); without it
 * the alarm is inexact and may fire late, which the settings page says.
 */
internal class AndroidLeaseScheduler(private val context: Context) : DeviceLeaseScheduler {
    private val preferences by lazy { createAppPreferences() }
    private val serializer = ListSerializer(DeviceLease.serializer())
    private val alarms get() = context.getSystemService(AlarmManager::class.java)

    private fun stored(): List<DeviceLease> = runCatching {
        preferences.string(KEY)?.let { RiffetJson.instance.decodeFromString(serializer, it) }
    }.getOrNull().orEmpty()

    private fun store(leases: List<DeviceLease>) {
        preferences.setString(KEY, if (leases.isEmpty()) null else RiffetJson.instance.encodeToString(serializer, leases))
    }

    @Synchronized
    override fun schedule(lease: DeviceLease) {
        val at = at(lease) ?: return
        if (at <= System.currentTimeMillis()) return
        store(stored().filter { it.id != lease.id } + lease)
        arm(lease, at)
    }

    @Synchronized
    override fun cancel(id: String) {
        store(stored().filter { it.id != id })
        alarms?.cancel(pending(id))
        AppLog.log("device", "lease ${id.take(8)} cancelled")
    }

    @Synchronized
    override fun held(): Set<String> = stored().map { it.id }.toSet()

    /** After a reboot or an update: re-arm what is still ahead, forget the rest. */
    @Synchronized
    fun restore() {
        val now = System.currentTimeMillis()
        val ahead = stored().filter { (at(it) ?: 0) > now }
        store(ahead)
        ahead.forEach { lease -> at(lease)?.let { arm(lease, it) } }
        AppLog.log("device", "leases restored ${ahead.size}")
    }

    /** The switch went off: nothing may wake for calls any more. */
    @Synchronized
    fun clear() {
        stored().forEach { alarms?.cancel(pending(it.id)) }
        store(emptyList())
    }

    /** A fired lease is spent. */
    @Synchronized
    fun fired(id: String) {
        store(stored().filter { it.id != id })
    }

    fun exact(): Boolean = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarms?.canScheduleExactAlarms() == true

    private fun arm(lease: DeviceLease, at: Long) {
        val manager = alarms ?: return
        val trigger = maxOf(System.currentTimeMillis() + 1_000L, at - LEAD_MILLIS)
        val exact = exact()
        try {
            if (exact) manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, trigger, pending(lease.id))
            else manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, trigger, pending(lease.id))
        } catch (_: SecurityException) {
            // Revoked between the check and the call.
            manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, trigger, pending(lease.id))
        }
        AppLog.log("device", "lease ${lease.id.take(8)} armed in ${(trigger - System.currentTimeMillis()) / 1000}s exact=$exact")
    }

    private fun pending(id: String): PendingIntent = PendingIntent.getBroadcast(
        context,
        id.hashCode(),
        Intent(context, DeviceReceiver::class.java).setAction(DeviceReceiver.ACTION_LEASE).setData(Uri.parse("riffet://lease/$id")).putExtra(DeviceReceiver.EXTRA_LEASE, id),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun at(lease: DeviceLease): Long? = runCatching { Instant.parse(lease.at).toEpochMilli() }.getOrNull()

    private companion object {
        const val KEY = "device.leases"
        const val LEAD_MILLIS = 60_000L
    }
}

/** This app's own PendingIntents: a lease's alarm and a dismissed device request. Not exported. */
class DeviceReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            ACTION_LEASE -> {
                val id = intent.getStringExtra(EXTRA_LEASE) ?: return
                AppLog.log("device", "lease ${id.take(8)} fired")
                RiffetDevice.leases.fired(id)
                if (DeviceControl.allowed.value) RiffetDevice.wake(context)
            }
            ACTION_DENY -> intent.getStringExtra(DeviceActionActivity.EXTRA_CALL)?.let { DeviceRequests.complete(it, DeviceActionResult.Denied) }
            ACTION_STOP -> {
                AppLog.log("device", "stop pressed")
                DeviceStop.stop()
                DeviceNotices.controlEnded(context)
            }
        }
    }

    companion object {
        const val ACTION_LEASE = "riffet.device.LEASE"
        const val ACTION_DENY = "riffet.device.DENY"
        const val ACTION_STOP = "riffet.device.STOP"
        const val EXTRA_LEASE = "riffet.device.lease"
    }
}

/** Boot and app updates drop every alarm; leases are re-armed and, with the switch on, the connection comes back. */
class DeviceBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        RiffetDevice.leases.restore()
        if (DeviceControl.allowed.value) RiffetDevice.wake(context)
    }
}
