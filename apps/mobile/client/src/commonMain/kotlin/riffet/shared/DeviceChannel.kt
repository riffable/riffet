package riffet.shared

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import riffet.contracts.DeviceCall
import riffet.contracts.DeviceCallOutcome
import riffet.contracts.DeviceCapability
import riffet.contracts.DeviceErrorCode
import riffet.contracts.DeviceLease
import riffet.contracts.DeviceReport
import riffet.contracts.RiffetJson
import kotlin.random.Random
import kotlin.time.Clock
import kotlin.time.Instant

/*
 * The device side of the device channel (docs/DEVICES.md §3 and §5): one entry point for every call
 * the server sends ([DeviceGate]), the loop that holds the stream and reports ([DeviceChannel]), and
 * the seams a platform fills in. Nothing here knows Android; the host supplies [DeviceExecutor] and
 * [DeviceLeaseScheduler].
 */

/** What this platform can do for a call. */
interface DeviceExecutor {
    /** Capabilities usable right now: permission granted, hardware and a handling app present. */
    fun capabilities(): List<String>

    /**
     * Carries out [call]. Cancelled when its deadline passes or the server withdraws it, so anything
     * it put on screen must be taken down in a `finally`.
     */
    suspend fun execute(call: DeviceCall, api: RiffetApi): DeviceCallOutcome

    /** The screen is locked or off, so screen control cannot work. */
    fun screenLocked(): Boolean = false
}

/** Wakes the device shortly before each lease (an exact alarm on Android) and survives a restart. */
interface DeviceLeaseScheduler {
    fun schedule(lease: DeviceLease)
    fun cancel(id: String)
    fun held(): Set<String>
}

/** Runtime permissions a capability may be waiting on; [EXACT_ALARM] is the leases' own, [ACCESSIBILITY] the T1 service. */
enum class DevicePermission { NOTIFICATIONS, LOCATION, CAMERA, EXACT_ALARM, ACCESSIBILITY, RESTRICTED_SETTINGS }

/**
 * Where the T1 accessibility service stands. [RESTRICTED]: Android 13+ blocks turning a sideloaded
 * app's service on until its restricted settings are allowed. [NOT_RUNNING]: listed as enabled, but
 * the system has not bound it (or it was killed).
 */
enum class AccessibilityState { OFF, RESTRICTED, NOT_RUNNING, RUNNING }

/** [canWriteSecure]: `WRITE_SECURE_SETTINGS` was granted over adb, so the app can switch the service itself. */
data class DeviceAccessibility(val state: AccessibilityState, val canWriteSecure: Boolean = false)

/** The maker's settings differ where the instructions do (docs/DEVICES.md §4). */
enum class DeviceMaker { OPPO, XIAOMI, OTHER }

/** One capability as the settings page shows it. [missing] is what would make it usable, or more so. */
data class DeviceCapabilityState(val id: String, val usable: Boolean, val missing: DevicePermission? = null)

data class DevicePlatformState(
    val capabilities: List<DeviceCapabilityState> = emptyList(),
    /** False when leases fall back to inexact alarms. */
    val exactAlarms: Boolean = true,
    /** Null where the platform has no screen control. */
    val accessibility: DeviceAccessibility? = null,
)

/** The platform half of the settings page: what is usable and how to ask for the rest. */
interface DevicePlatform {
    val state: StateFlow<DevicePlatformState>

    /** Read the permissions again, e.g. on the way back from a system dialog. */
    fun refresh()

    fun request(permission: DevicePermission)

    /**
     * A random id for this installation, kept where a device-to-device transfer does not copy it (a
     * copy would make the server revoke the phone it came from). Null: [DeviceControl] keeps its own.
     */
    val installationId: String? get() = null

    /** The app's id, which the server's adb grant names. Null where there is nothing to grant. */
    val packageName: String? get() = null

    val maker: DeviceMaker get() = DeviceMaker.OTHER

    /** Puts the accessibility service in the system's enabled list; true once it is running. Needs `canWriteSecure`. */
    suspend fun enableAccessibility(): Boolean = false

    /** Takes the service out of the enabled list and puts it back; true once it is running. Needs `canWriteSecure`. */
    suspend fun restartAccessibility(): Boolean = false
}

/**
 * 允许 Agent 调用这台设备: this device's own switch, which no server setting overrides (docs/DEVICES.md
 * §3「设备侧开关」). Stored on the device only. [platform] is set by a host that can serve calls.
 */
object DeviceControl {
    private const val KEY = "device.allow-control"
    private const val INSTALLATION_KEY = "device.installation-id"
    private val preferences by lazy { createAppPreferences() }
    private val stored by lazy { MutableStateFlow(preferences.string(KEY) == "true") }

    val allowed: StateFlow<Boolean> get() = stored.asStateFlow()

    /** Turning it on must follow a successful owner verification; the caller does that. */
    fun setAllowed(on: Boolean) {
        preferences.setString(KEY, if (on) "true" else null)
        stored.value = on
    }

    var platform: DevicePlatform? = null

    /** Random, made once and kept on this device; the server keeps one record per installation. */
    val installationId: String get() = platform?.installationId
        ?: preferences.string(INSTALLATION_KEY) ?: newInstallationId().also { preferences.setString(INSTALLATION_KEY, it) }

    fun newInstallationId(): String = Random.nextBytes(16).joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }

    /** Per-app policies for screen control, and the apps it has touched. */
    val apps: DeviceAppPolicies by lazy { DeviceAppPolicies(preferences) }
}

/** A finished call's outcome, kept so a replayed call is answered again instead of run twice. */
@Serializable
private data class JournalEntry(val callId: String, val at: Long, val outcome: DeviceCallOutcome)

/** The last [LIMIT] finished calls, in [AppPreferences]; a day is far past any call's deadline. */
class DeviceCallJournal(private val preferences: AppPreferences, private val now: () -> Long = { Clock.System.now().toEpochMilliseconds() }) {
    private val serializer = ListSerializer(JournalEntry.serializer())
    private var entries: List<JournalEntry> = runCatching {
        preferences.string(KEY)?.let { RiffetJson.instance.decodeFromString(serializer, it) }
    }.getOrNull().orEmpty()

    fun outcome(callId: String): DeviceCallOutcome? = entries.firstOrNull { it.callId == callId }?.outcome

    fun record(callId: String, outcome: DeviceCallOutcome) {
        val at = now()
        entries = (entries.filter { it.callId != callId && at - it.at < RETAIN_MILLIS } + JournalEntry(callId, at, outcome)).takeLast(LIMIT)
        preferences.setString(KEY, RiffetJson.instance.encodeToString(serializer, entries))
    }

    private companion object {
        const val KEY = "device.calls"
        const val LIMIT = 100
        const val RETAIN_MILLIS = 24 * 60 * 60 * 1000L
    }
}

/**
 * The single way a call is carried out: guard (deadline, duplicate) → allowed on this device →
 * capability usable now → execute → record → answer. Every call goes through [handle]; executors
 * are never reached any other way. A call already answered is answered again with the same outcome
 * (the server keeps the first), one in progress is not started twice, and [cancel] stops it.
 */
class DeviceGate(
    private val api: RiffetApi,
    private val executor: DeviceExecutor,
    private val journal: DeviceCallJournal,
    private val scope: CoroutineScope,
    private val allowed: () -> Boolean = { DeviceControl.allowed.value },
    private val now: () -> Long = { Clock.System.now().toEpochMilliseconds() },
) {
    private val running = mutableMapOf<String, Job>()
    private val lock = Mutex()

    fun handle(call: DeviceCall) {
        scope.launch { run(call) }
    }

    fun cancel(callId: String) {
        scope.launch {
            lock.withLock { running.remove(callId) }?.let {
                AppLog.log(TAG, "cancel ${call(callId)}")
                it.cancel()
            }
        }
    }

    private suspend fun run(call: DeviceCall) {
        journal.outcome(call.callId)?.let { answered ->
            AppLog.log(TAG, "replayed ${call(call.callId)}: answering again")
            answer(call, answered)
            return
        }
        val deadline = runCatching { Instant.parse(call.deadline).toEpochMilliseconds() }.getOrNull()
        val remaining = deadline?.let { it - now() }
        if (remaining != null && remaining <= 0) {
            AppLog.log(TAG, "expired ${call(call.callId)} ${call.capability}")
            return
        }
        val job = lock.withLock {
            if (running.containsKey(call.callId)) return
            scope.launch(start = kotlinx.coroutines.CoroutineStart.LAZY) { execute(call, remaining) }.also { running[call.callId] = it }
        }
        try {
            job.join()
        } finally {
            lock.withLock { if (running[call.callId] === job) running.remove(call.callId) }
        }
    }

    private suspend fun execute(call: DeviceCall, remaining: Long?) {
        val outcome = when {
            !allowed() -> DeviceCallOutcome.failure(DeviceErrorCode.NOT_ALLOWED, "This device does not allow calls")
            call.capability !in executor.capabilities() -> DeviceCallOutcome.failure(DeviceErrorCode.CAPABILITY_MISSING, "${call.capability} is not available on this device")
            // Screen control (docs/DEVICES.md §5): the owner's stop holds for a minute; a locked screen cannot be read or driven.
            call.capability in CONTROL && DeviceStop.active(now()) -> DeviceCallOutcome.failure(DeviceErrorCode.STOPPED, "The owner stopped screen control on the device; try again in a minute or ask the user")
            call.capability in DeviceCapability.T1 && executor.screenLocked() -> DeviceCallOutcome.failure(DeviceErrorCode.LOCKED, "The screen is locked or off; ask the user to unlock the phone")
            else -> {
                AppLog.log(TAG, "run ${call(call.callId)} ${call.capability}")
                val result = try {
                    if (remaining == null) executor.execute(call, api) else withTimeoutOrNull(remaining) { executor.execute(call, api) }
                } catch (cancellation: CancellationException) {
                    throw cancellation
                } catch (failure: Throwable) {
                    AppLog.log(TAG, "failed ${call(call.callId)} ${failure::class.simpleName}: ${failure.message}")
                    DeviceCallOutcome.failure(DeviceErrorCode.FAILED, failure.message ?: failure::class.simpleName)
                }
                // Past the deadline the server has already answered DEVICE_TIMEOUT; nothing to send.
                result ?: run {
                    AppLog.log(TAG, "deadline passed ${call(call.callId)}")
                    return
                }
            }
        }
        AppLog.log(TAG, "done ${call(call.callId)} ok=${outcome.ok} ${outcome.code ?: ""}")
        journal.record(call.callId, outcome)
        answer(call, outcome)
    }

    /**
     * Retries a lost answer until a little past the deadline. A 404 or 409 means the server no longer
     * waits for it (unknown, closed or timed out), so it is dropped.
     */
    private suspend fun answer(call: DeviceCall, outcome: DeviceCallOutcome) {
        val deadline = runCatching { Instant.parse(call.deadline).toEpochMilliseconds() }.getOrNull() ?: (now() + ANSWER_GRACE_MILLIS)
        var attempt = 0
        while (true) {
            try {
                api.postDeviceCallResult(call.callId, outcome)
                return
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (failure: RiffetHttpException) {
                AppLog.log(TAG, "answer ${call(call.callId)} rejected ${failure.status} ${failure.code}")
                if (failure.status in 400..499) return
            } catch (failure: RiffetUnauthenticatedException) {
                return
            } catch (failure: Throwable) {
                AppLog.log(TAG, "answer ${call(call.callId)} failed ${failure::class.simpleName}")
            }
            if (now() > deadline + ANSWER_GRACE_MILLIS) return
            delay(RetryPolicy().delayFor(attempt++))
        }
    }

    private fun call(callId: String) = "call=" + callId.take(8)

    private companion object {
        const val TAG = "device"
        /** What the stop refuses; reading the screen stays possible. */
        val CONTROL = setOf(DeviceCapability.SCREEN_ACT, DeviceCapability.APP_LAUNCH)
        const val ANSWER_GRACE_MILLIS = 60_000L
    }
}

/**
 * Holds `/api/devices/me/stream` for one server while [run] is collected: reports before each dial,
 * passes calls to [gate] and leases to [leases]. After a dial's replay (up to its first heartbeat)
 * a lease the server no longer sent is dropped, since its cancel may have gone out while offline.
 */
class DeviceChannel(
    private val api: RiffetApi,
    private val executor: DeviceExecutor,
    private val gate: DeviceGate,
    private val leases: DeviceLeaseScheduler,
    private val platform: String,
    private val appVersion: String,
    private val allowed: () -> Boolean = { DeviceControl.allowed.value },
    private val installationId: () -> String = { DeviceControl.installationId },
    /** After each successful report, e.g. to leave the installation id where the server's adb can read it. */
    private val afterReport: (DeviceReport) -> Unit = {},
) {
    private var session: DeviceStreamSession? = null
    private var reported: DeviceReport? = null
    private val _self = MutableStateFlow<PublicDevice?>(null)

    /** This device as the server last returned it. */
    val self: StateFlow<PublicDevice?> = _self.asStateFlow()

    private fun current() = DeviceReport(platform, appVersion, executor.capabilities(), allowed(), installationId())

    /** `PUT /api/devices/me`; failures propagate so a dial waits out its backoff instead of opening blind. */
    suspend fun report() {
        val next = current()
        _self.value = api.reportDevice(next)
        reported = next
        afterReport(next)
        AppLog.log("device", "reported ${next.capabilities.joinToString(",")} allow=${next.allowControl}")
    }

    /** Sends the report again if a permission or the switch changed since the last one. */
    suspend fun reportIfChanged() {
        if (reported == null || reported == current()) return
        try {
            report()
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (failure: Throwable) {
            AppLog.log("device", "report failed ${failure::class.simpleName}: ${failure.message}")
        }
    }

    fun kick() {
        session?.kick()
    }

    suspend fun run() {
        val opened = api.deviceStream(beforeDial = ::report)
        session = opened
        val seen = mutableSetOf<String>()
        var replaying = false
        try {
            opened.events.collect { event ->
                when (event) {
                    is DeviceStreamEvent.Call -> gate.handle(event.call)
                    is DeviceStreamEvent.Cancel -> gate.cancel(event.callId)
                    is DeviceStreamEvent.Lease -> {
                        if (replaying) seen += event.lease.id
                        leases.schedule(event.lease)
                    }
                    is DeviceStreamEvent.LeaseCancel -> leases.cancel(event.id)
                    DeviceStreamEvent.Connected -> {
                        replaying = true
                        seen.clear()
                    }
                    DeviceStreamEvent.Heartbeat -> if (replaying) {
                        replaying = false
                        (leases.held() - seen).forEach(leases::cancel)
                    }
                }
            }
        } finally {
            session = null
        }
    }
}
