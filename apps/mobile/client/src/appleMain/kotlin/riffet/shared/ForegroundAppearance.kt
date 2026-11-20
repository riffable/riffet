package riffet.shared

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import riffet.contracts.DeviceCall
import riffet.contracts.DeviceCallOutcome
import riffet.contracts.DeviceCapability
import riffet.contracts.DeviceErrorCode
import riffet.contracts.DevicePushRegistration
import riffet.contracts.DeviceReport
import riffet.contracts.RiffetJson

@Serializable
data class DeviceAppearanceOption(val id: String, val name: String)

/** Native Swift setters provide these saved values before a device call is acknowledged. */
@Serializable
data class DeviceAppearanceSnapshot(
    val themeId: String,
    val mode: String,
    val themes: List<DeviceAppearanceOption>,
    val activePaletteId: String? = null,
    val interfaceStyle: String? = null,
    val interfaceStyles: List<DeviceAppearanceOption>? = null,
)

/** One foreground client serves its own appearance for the explicitly permitted pairing. */
internal class ForegroundAppearance(private val scope: CoroutineScope, private val platform: String) {
    private class Target(val api: RiffetApi, val authorized: () -> Boolean)
    private class Settings(
        val appVersion: String,
        val installationId: String,
        val apply: (String?, String?, String?) -> DeviceAppearanceSnapshot?,
    )

    private val preferences by lazy { createAppPreferences() }
    private val journal by lazy { DeviceCallJournal(preferences) }
    private val reports = Mutex()
    private var settings: Settings? = null
    private var target: Target? = null
    private var foreground = false
    private var allowedDevice: String? = null
    private var work: Job? = null
    private var stream: DeviceStreamSession? = null

    /**
     * Set by a host that runs the one device stream itself (the Mac, which also serves T0 calls): state
     * changes are passed to it instead of opening a stream here, and it asks [usableExecutor] what to serve.
     */
    internal var hosted: (() -> Unit)? = null

    fun configure(appVersion: String, installationId: String, apply: (String?, String?, String?) -> DeviceAppearanceSnapshot?) {
        settings = Settings(appVersion, installationId, apply)
        allowedDevice = preferences.string(permissionKey)
        refresh()
    }

    fun install(api: RiffetApi, authorized: () -> Boolean) {
        target = Target(api, authorized)
        refresh()
    }

    fun clear() {
        target = null
        refresh()
    }

    fun foreground(active: Boolean) {
        if (foreground == active) return
        foreground = active
        refresh()
    }

    fun kick() = stream?.kick()

    suspend fun isAllowed(api: RiffetApi): Boolean {
        val selected = target?.takeIf { it.api === api && it.authorized() } ?: return false
        val id = api.readToken()?.let(::deviceIdOf)
        return target === selected && selected.authorized() && id != null && id == allowedDevice
    }

    suspend fun setAllowed(api: RiffetApi, enabled: Boolean): Boolean {
        val selected = target?.takeIf { it.api === api && it.authorized() } ?: return false
        val id = api.readToken()?.let(::deviceIdOf) ?: return false
        if (target !== selected || !selected.authorized()) return false
        if (!enabled && allowedDevice != id) return false
        allowedDevice = if (enabled) id else null
        preferences.setString(permissionKey, allowedDevice)
        refresh()
        return enabled
    }

    /** Push registration and foreground capability reports share one ordered writer. */
    suspend fun report(
        api: RiffetApi,
        appVersion: String,
        installationId: String,
        push: DevicePushRegistration? = null,
        clearPush: Boolean = false,
    ): PublicDevice = reports.withLock {
        val id = api.readToken()?.let(::deviceIdOf)
        val current = target
        val allowed = current != null && canExecute(current, id)
            && serverOrigin(api.baseUrl)?.let { it == serverOrigin(current.api.baseUrl) } == true
        val capabilities = if (allowed) listOf(DeviceCapability.RIFFET_APPEARANCE) else emptyList()
        val report = DeviceReport(platform, appVersion, capabilities, allowControl = allowed, installationId = installationId, push = push)
        if (clearPush) api.reportDeviceClearingPush(report) else api.reportDevice(report)
    }

    private fun canExecute(selected: Target, id: String?): Boolean =
        foreground && target === selected && selected.authorized() && id != null && id == allowedDevice

    /** The appearance executor when this client may serve appearance calls right now, else null. */
    internal suspend fun usableExecutor(): DeviceExecutor? {
        val selected = target ?: return null
        val config = settings ?: return null
        val id = selected.api.readToken()?.let(::deviceIdOf)
        return if (canExecute(selected, id)) executor(config, selected, id) else null
    }

    private fun refresh() {
        hosted?.let { it(); return }
        val previous = work
        val wasListening = previous?.isActive == true
        previous?.cancel()
        val selected = target ?: return
        if (allowedDevice == null && !wasListening) return
        val config = settings ?: return
        work = scope.launch {
            previous?.join()
            val api = selected.api
            val pairId = api.readToken()?.let(::deviceIdOf)
            if (!canExecute(selected, pairId)) {
                if (selected === target) report(api, config.appVersion, config.installationId)
                return@launch
            }
            coroutineScope {
                val gate = DeviceGate(api, executor(config, selected, pairId), journal, this, allowed = { canExecute(selected, pairId) })
                val opened = api.deviceStream(beforeDial = { report(api, config.appVersion, config.installationId) })
                stream = opened
                try {
                    opened.events.collect { event ->
                        when (event) {
                            is DeviceStreamEvent.Call -> gate.handle(event.call)
                            is DeviceStreamEvent.Cancel -> gate.cancel(event.callId)
                            else -> Unit
                        }
                    }
                } finally {
                    if (stream === opened) stream = null
                }
            }
        }
    }

    private val fields = if (platform == "mac") setOf("themeId", "mode", "interfaceStyle") else setOf("themeId", "mode")
    private val permissionKey = "$platform.appearance.allowed-device"

    private fun executor(config: Settings, selected: Target, pairId: String?) = object : DeviceExecutor {
        override fun capabilities() = listOf(DeviceCapability.RIFFET_APPEARANCE)
        override suspend fun execute(call: DeviceCall, api: RiffetApi): DeviceCallOutcome {
            val id = api.readToken()?.let(::deviceIdOf)
            if (id != pairId || !canExecute(selected, id)) {
                return DeviceCallOutcome.failure(DeviceErrorCode.NOT_ALLOWED, "This Riffet workbench does not allow appearance calls")
            }
            if (call.args.keys.any { it !in fields }) {
                return DeviceCallOutcome.failure(DeviceErrorCode.CAPABILITY_MISSING, "An appearance option is not available in this Riffet workbench")
            }
            val values = call.args.mapValues { (_, value) -> (value as? JsonPrimitive)?.takeIf { it.isString }?.content }
            if (values.values.any { it == null }) return DeviceCallOutcome.failure(DeviceErrorCode.FAILED, "Appearance values must be strings")
            val result = config.apply(values["themeId"], values["mode"], values["interfaceStyle"])
                ?: return DeviceCallOutcome.failure(DeviceErrorCode.FAILED, "Appearance was not applied in the selected Riffet workbench")
            return DeviceCallOutcome.success(RiffetJson.instance.encodeToJsonElement(result).jsonObject)
        }
    }
}
