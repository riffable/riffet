package riffet.android

import android.Manifest
import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.database.ContentObserver
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import riffet.contracts.DeviceReport
import riffet.shared.AppLog
import riffet.shared.DeviceAccessibility
import riffet.shared.DeviceCallJournal
import riffet.shared.DeviceChannel
import riffet.shared.DeviceControl
import riffet.shared.DeviceMaker
import riffet.shared.DeviceGate
import riffet.shared.DevicePermission
import riffet.shared.DevicePlatform
import riffet.shared.DevicePlatformState
import riffet.shared.RiffetAndroid
import riffet.shared.RiffetApi
import riffet.shared.createAppPreferences
import riffet.shared.reportDevice
import riffet.ui.state.ListsFeed
import riffet.ui.state.SessionMarks
import riffet.ui.state.SessionStore
import java.io.File

/**
 * This phone as a device (docs/DEVICES.md §3): while 允许 Agent 调用这台设备 is on, the device
 * stream of the paired server is held here (and [RiffetHost] keeps [RiffetSyncService] up for it);
 * every call it brings goes through one [DeviceGate]. The lists stream's `notice` events become
 * notifications whether or not the switch is on.
 */
internal object RiffetDevice {
    private lateinit var context: Context
    private val scope = MainScope()

    val leases by lazy { AndroidLeaseScheduler(context) }
    private val executor by lazy { AndroidDeviceExecutor(context) }
    private val journal by lazy { DeviceCallJournal(createAppPreferences()) }
    val platform by lazy { AndroidDevicePlatform(context) }

    private var channel: DeviceChannel? = null
    private var feed: ListsFeed? = null

    fun initialize(context: Context) {
        this.context = context.applicationContext
        DeviceControl.platform = platform
    }

    /**
     * For one installed store, until it is replaced: the lists stream always, the device stream
     * while the switch is on. [viewing] tells whether the reader is looking at that conversation;
     * [reading] whether list changes may be read now (the app is in front or kept alive).
     */
    suspend fun watch(
        store: SessionStore,
        api: RiffetApi,
        origin: String,
        marks: SessionMarks?,
        reading: () -> Boolean,
        viewing: (String) -> Boolean,
    ): Unit = coroutineScope {
        launch { showNotices(store, api, origin, marks, reading, viewing) }
        var wasOn = false
        DeviceControl.allowed.collectLatest { on ->
            if (on) {
                wasOn = true
                // A service already up for an open stream takes on the location type now.
                RiffetSyncService.refreshTypes(context)
                // Its own scope, so turning the switch off also stops the calls in progress.
                coroutineScope { serve(api, this) }
            } else {
                leases.clear()
                // Tell the server once, so its tools fail early with DEVICE_NOT_ALLOWED.
                if (wasOn) reportOff(api)
                wasOn = false
            }
        }
    }

    private suspend fun serve(api: RiffetApi, scope: CoroutineScope) {
        val gate = DeviceGate(api, executor, journal, scope)
        val next = DeviceChannel(
            api, executor, gate, leases, platform = "android", appVersion = appVersion(),
            afterReport = { report -> report.installationId?.let(::leaveInstallationId) },
        )
        channel = next
        try {
            next.run()
        } finally {
            if (channel === next) channel = null
        }
    }

    /**
     * The server's adb reads this file to tell which attached phone is this device. Best effort: the
     * folder is the app's own external files directory, which `adb shell` can read.
     */
    private fun leaveInstallationId(id: String) {
        scope.launch(Dispatchers.IO) {
            runCatching {
                val file = File(context.getExternalFilesDir(null) ?: return@runCatching, INSTALLATION_FILE)
                if (!file.exists() || file.readText() != id) file.writeText(id)
            }
        }
    }

    private suspend fun reportOff(api: RiffetApi) {
        try {
            api.reportDevice(DeviceReport("android", appVersion(), executor.capabilities(), allowControl = false))
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (failure: Throwable) {
            AppLog.log("device", "off report failed ${failure::class.simpleName}: ${failure.message}")
        }
    }

    /** One lists stream carries both: list changes go to the store, `notice` events become notifications. */
    private suspend fun showNotices(
        store: SessionStore,
        api: RiffetApi,
        origin: String,
        marks: SessionMarks?,
        reading: () -> Boolean,
        viewing: (String) -> Boolean,
    ) = coroutineScope {
        val shown = ArrayDeque<String>()
        val lists = ListsFeed(api, store, this, active = reading, onMarks = { marks?.poll() }, onNotice = { notice ->
            if (notice.id !in shown) {
                shown.addLast(notice.id)
                if (shown.size > 50) shown.removeFirst()
                if (!viewing(notice.sessionId)) {
                    val title = store.list.value.sessions.firstOrNull { it.id == notice.sessionId }?.title
                    RiffetHost.notifier.agentMessage("notice-${notice.id}", notice.sessionId, notice.title, notice.body, title, origin)
                }
            }
        })
        feed = lists
        try {
            lists.run()
        } finally {
            if (feed === lists) feed = null
        }
    }

    /** The network came back or the app came to the front: redial now. */
    fun kick() {
        channel?.kick()
        feed?.kick()
    }

    /** A permission or the switch changed: the server's copy of the capabilities follows. */
    fun capabilitiesChanged() {
        scope.launch { channel?.reportIfChanged() }
    }

    /** The accessibility service connected or went away: the settings page and the report follow. */
    fun accessibilityChanged() {
        if (!::context.isInitialized) return
        scope.launch {
            platform.refresh()
            channel?.reportIfChanged()
        }
    }

    /** A lease's alarm or a reboot: up the keep-alive service (allowed from those) and restore the pairing. */
    fun wake(context: Context) {
        try {
            context.startForegroundService(Intent(context, RiffetSyncService::class.java))
        } catch (failure: RuntimeException) {
            AppLog.log("device", "wake: service refused ${failure::class.simpleName}")
        }
        RiffetHost.start(null)
        kick()
    }

    private const val INSTALLATION_FILE = "riffet-installation-id"

    private fun appVersion(): String =
        runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull() ?: "0"
}

/** The settings page's view of the capabilities, and the system dialogs that grant them. */
internal class AndroidDevicePlatform(private val context: Context) : DevicePlatform {
    private val preferences by lazy { createAppPreferences() }
    private val _state = MutableStateFlow(read())
    override val state: StateFlow<DevicePlatformState> = _state.asStateFlow()

    private fun read() = DevicePlatformState(
        DeviceCapabilities.states(context),
        RiffetDevice.leases.exact(),
        DeviceAccessibility(AccessibilityControl.state(context), AccessibilityControl.canWriteSecure(context)),
    )

    init {
        // The system page, adb and this app all edit the enabled list; the settings page follows without a focus change.
        context.contentResolver.registerContentObserver(
            Settings.Secure.getUriFor(Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES),
            false,
            object : ContentObserver(Handler(Looper.getMainLooper())) {
                override fun onChange(selfChange: Boolean) = refresh()
            },
        )
    }

    // `riffet.device` holds the device token too, and is excluded from backups and device transfer.
    override val installationId: String by lazy {
        val prefs = context.getSharedPreferences("riffet.device", Context.MODE_PRIVATE)
        prefs.getString("installation-id", null) ?: DeviceControl.newInstallationId().also { prefs.edit().putString("installation-id", it).apply() }
    }

    override val packageName: String get() = context.packageName

    override val maker: DeviceMaker = Build.MANUFACTURER.lowercase().let { maker ->
        when {
            listOf("oppo", "oneplus", "realme").any { it in maker } -> DeviceMaker.OPPO
            listOf("xiaomi", "redmi", "poco").any { it in maker } -> DeviceMaker.XIAOMI
            else -> DeviceMaker.OTHER
        }
    }

    override suspend fun enableAccessibility(): Boolean = AccessibilityControl.enable(context).also { refresh() }

    override suspend fun restartAccessibility(): Boolean = AccessibilityControl.restart(context).also { refresh() }

    override fun refresh() {
        val next = read()
        if (next == _state.value) return
        _state.value = next
        RiffetDevice.capabilitiesChanged()
        RiffetSyncService.refreshTypes(context)
    }

    override fun request(permission: DevicePermission) {
        val activity = RiffetAndroid.currentActivity() ?: return
        when (permission) {
            DevicePermission.NOTIFICATIONS ->
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !DeviceCapabilities.granted(context, Manifest.permission.POST_NOTIFICATIONS)) {
                    ask(activity, Manifest.permission.POST_NOTIFICATIONS)
                } else {
                    activity.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName))
                }
            DevicePermission.LOCATION -> ask(activity, Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
            DevicePermission.CAMERA -> ask(activity, Manifest.permission.CAMERA)
            DevicePermission.EXACT_ALARM -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                open(activity, Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:${context.packageName}")))
            }
            // This service's own page where the system has one, else the accessibility list.
            DevicePermission.ACCESSIBILITY -> {
                val component = ComponentName(context, RiffetAccessibilityService::class.java).flattenToString()
                val details = Intent("android.settings.ACCESSIBILITY_DETAILS_SETTINGS").putExtra(Intent.EXTRA_COMPONENT_NAME, component)
                try {
                    activity.startActivity(details)
                } catch (_: RuntimeException) {
                    open(activity, Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
                }
            }
            // 允许受限制的设置 is in the app info page's overflow menu.
            DevicePermission.RESTRICTED_SETTINGS -> open(activity, Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")))
        }
    }

    /**
     * The system dialog, unless it was refused for good: Android then answers without showing it,
     * so the app's details page is opened instead. The result is read when the window regains focus.
     */
    private fun ask(activity: Activity, vararg permissions: String) {
        val key = "device.asked.${permissions.first()}"
        val refusedForGood = preferences.string(key) == "true" && permissions.none { activity.shouldShowRequestPermissionRationale(it) }
        if (refusedForGood) {
            open(activity, Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")))
            return
        }
        preferences.setString(key, "true")
        activity.requestPermissions(permissions, REQUEST_CODE)
    }

    private fun open(activity: Activity, intent: Intent) {
        try {
            activity.startActivity(intent)
        } catch (_: RuntimeException) {
            activity.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")))
        }
    }

    private companion object {
        const val REQUEST_CODE = 0x5744
    }
}
