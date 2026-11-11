package riffet.ui.settings

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.getString
import org.jetbrains.compose.resources.stringResource
import riffet.contracts.DeviceAdbState
import riffet.contracts.DeviceCapability
import riffet.shared.AccessibilityState
import riffet.shared.AppPolicy
import riffet.shared.DeviceAccessibility
import riffet.shared.DeviceCapabilityState
import riffet.shared.DeviceControl
import riffet.shared.DeviceMaker
import riffet.shared.DevicePermission
import riffet.shared.DevicePlatform
import riffet.shared.RiffetApi
import riffet.shared.RiffetHttpException
import riffet.shared.deviceAdbStatus
import riffet.shared.grantDeviceAdb
import riffet.ui.app.LocalPageActive
import riffet.ui.design.Group
import riffet.ui.design.GroupRow
import riffet.ui.design.GroupSpacer
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.icons.Icon
import riffet.ui.icons.RiffetIcons
import riffet.ui.pickers.PickerOverlay
import riffet.ui.platform.ApprovalVerification
import riffet.ui.platform.VerificationAvailability
import riffet.ui.platform.approvalVerificationAvailability
import riffet.ui.pickers.RiffetDropdownMenu
import riffet.ui.pickers.RiffetMenuItem
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet_mobile.shared.generated.resources.*

/** 能力与设备 (docs/DEVICES.md §3): this device's own 允许 Agent 调用 switch and what it can serve. */
@Composable
internal fun DevicesSection(api: RiffetApi) {
    DeviceControl.platform?.let { ThisDeviceGroup(it, api) }
}

@Composable
private fun ThisDeviceGroup(platform: DevicePlatform, api: RiffetApi) {
    val availability = remember { approvalVerificationAvailability() }
    val scope = rememberCoroutineScope()
    val on by DeviceControl.allowed.collectAsState()
    val state by platform.state.collectAsState()
    var busy by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<String?>(null) }
    // Back from a permission dialog or a system page.
    val focused = LocalWindowInfo.current.isWindowFocused
    LaunchedEffect(focused) { if (focused) platform.refresh() }

    SettingsGroup(stringResource(Res.string.settings_device_group)) {
        SettingsSwitchRow(
            stringResource(Res.string.settings_device_allow),
            failure ?: if (availability == VerificationAvailability.NOT_ENROLLED && !on) {
                stringResource(Res.string.settings_verify_unavailable)
            } else {
                stringResource(Res.string.settings_device_allow_desc)
            },
            checked = on,
            enabled = !busy && (on || availability != VerificationAvailability.NOT_ENROLLED),
            onCheckedChange = { enable ->
                failure = null
                if (!enable) {
                    DeviceControl.setAllowed(false)
                    return@SettingsSwitchRow
                }
                busy = true
                scope.launch {
                    try {
                        // Where nothing can verify the owner (no biometric seam), the switch is the consent.
                        val passed = availability == VerificationAvailability.UNSUPPORTED ||
                            ApprovalVerification.authenticate(getString(Res.string.settings_device_allow))
                        if (passed) DeviceControl.setAllowed(true) else failure = getString(Res.string.settings_verify_enable_failed)
                    } finally {
                        busy = false
                    }
                }
            },
        )
    }
    if (!on) return
    state.accessibility?.let { AccessibilityGroup(it, platform, api) }
    val capabilities = state.capabilities.associateBy { it.id }
    val rows = listOf(
        Res.string.settings_device_cap_notify to capabilities[DeviceCapability.NOTIFY],
        Res.string.settings_device_cap_clipboard to capabilities[DeviceCapability.CLIPBOARD_READ],
        Res.string.settings_device_cap_location to capabilities[DeviceCapability.LOCATION],
        Res.string.settings_device_cap_photo to capabilities[DeviceCapability.PHOTO],
        Res.string.settings_device_cap_open_url to capabilities[DeviceCapability.OPEN_URL],
        Res.string.settings_device_cap_alarm to capabilities[DeviceCapability.ALARM],
    ).mapNotNull { (label, capability) -> capability?.let { label to it } }
    SettingsGroup(stringResource(Res.string.settings_device_capabilities)) {
        rows.forEach { (label, capability) ->
            SettingsRow(stringResource(label)) { CapabilityControl(capability, platform) }
        }
        SettingsRow(
            stringResource(Res.string.settings_device_exact_alarm),
            if (state.exactAlarms) null else stringResource(Res.string.settings_device_exact_alarm_off),
        ) {
            if (state.exactAlarms) {
                SettingsStatusLine(stringResource(Res.string.settings_allowed), LocalRiffetColors.current.success)
            } else {
                SettingsButton(stringResource(Res.string.settings_keepalive_allow), onClick = { platform.request(DevicePermission.EXACT_ALARM) })
            }
        }
    }
    SettingsFootnote(stringResource(Res.string.settings_device_background_note))
    if (state.accessibility != null) AppPoliciesGroup()
}

/** 无障碍 is what T1 screen control stands on; the rows below it say only what is left to do. */
@Composable
private fun AccessibilityGroup(accessibility: DeviceAccessibility, platform: DevicePlatform, api: RiffetApi) {
    val scope = rememberCoroutineScope()
    val pageActive = LocalPageActive.current
    var busy by remember { mutableStateOf(false) }
    var sheet by remember { mutableStateOf(false) }
    val running = accessibility.state == AccessibilityState.RUNNING
    // Whatever turned it on, the sheet has nothing left to say.
    LaunchedEffect(running) { if (running) sheet = false }

    fun turnOn() {
        if (!accessibility.canWriteSecure) {
            sheet = true
            return
        }
        scope.launch {
            busy = true
            try {
                if (!platform.enableAccessibility()) sheet = true
            } finally {
                busy = false
            }
        }
    }

    fun restart() {
        if (!accessibility.canWriteSecure) {
            platform.request(DevicePermission.ACCESSIBILITY)
            return
        }
        scope.launch {
            busy = true
            try {
                if (!platform.restartAccessibility()) platform.request(DevicePermission.ACCESSIBILITY)
            } finally {
                busy = false
            }
        }
    }

    val stalled = accessibility.state == AccessibilityState.NOT_RUNNING
    SettingsGroup(stringResource(Res.string.settings_device_accessibility)) {
        SettingsRow(
            stringResource(Res.string.settings_device_accessibility),
            if (stalled) stringResource(Res.string.settings_device_a11y_stalled) else null,
        ) {
            when {
                running -> SettingsStatusLine(stringResource(Res.string.settings_device_a11y_running), LocalRiffetColors.current.success)
                stalled -> SettingsButton(stringResource(Res.string.settings_device_a11y_restart), onClick = ::restart, enabled = !busy)
                else -> SettingsButton(stringResource(Res.string.settings_device_a11y_enable), onClick = ::turnOn, enabled = !busy)
            }
        }
    }
    if (sheet && pageActive) AccessibilitySheet(accessibility, platform, api) { sheet = false }
}

/** 开启无障碍 for a phone that cannot switch it itself: over a computer's adb when there is one, else by hand. */
@Composable
private fun AccessibilitySheet(accessibility: DeviceAccessibility, platform: DevicePlatform, api: RiffetApi, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    val packageName = platform.packageName
    var adb by remember { mutableStateOf<String?>(null) }
    var granting by remember { mutableStateOf(false) }
    var grantError by remember { mutableStateOf<String?>(null) }
    // Step 1 stays on the list once done, so it can show its check mark.
    val needsRestricted = remember { accessibility.state == AccessibilityState.RESTRICTED }
    val restrictedDone = accessibility.state != AccessibilityState.RESTRICTED
    val listed = accessibility.state == AccessibilityState.NOT_RUNNING || accessibility.state == AccessibilityState.RUNNING
    // Back from the computer's cable prompt or a system page.
    val focused = LocalWindowInfo.current.isWindowFocused
    LaunchedEffect(focused) {
        if (!focused || packageName == null) return@LaunchedEffect
        adb = try {
            api.deviceAdbStatus(packageName).state
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (_: Throwable) {
            DeviceAdbState.ABSENT
        }
    }

    PickerOverlay(title = stringResource(Res.string.settings_device_a11y_sheet), onDismiss = onDismiss) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(bottom = 8.dp)) {
            if (adb == DeviceAdbState.READY || adb == DeviceAdbState.UNAUTHORIZED) {
                val ready = adb == DeviceAdbState.READY
                Group {
                    GroupRow(
                        stringResource(Res.string.settings_device_a11y_computer),
                        subtitle = grantError ?: if (ready) null else stringResource(Res.string.settings_device_a11y_unauthorized),
                        subtitleLines = 3,
                        trailing = if (ready) ({
                            SettingsButton(stringResource(Res.string.settings_device_a11y_enable), enabled = !granting, onClick = {
                                if (packageName == null) return@SettingsButton
                                scope.launch {
                                    granting = true
                                    grantError = null
                                    try {
                                        api.grantDeviceAdb(packageName)
                                        platform.refresh()
                                        platform.enableAccessibility()
                                    } catch (cancellation: CancellationException) {
                                        throw cancellation
                                    } catch (failure: RiffetHttpException) {
                                        grantError = grantFailure(failure, platform.maker)
                                    } catch (failure: Throwable) {
                                        grantError = failure.message
                                    } finally {
                                        granting = false
                                    }
                                }
                            })
                        }) else null,
                    )
                }
                GroupSpacer()
            }
            Group {
                if (needsRestricted) {
                    GroupRow(
                        stringResource(Res.string.settings_device_a11y_restricted),
                        subtitle = if (platform.maker == DeviceMaker.OPPO) stringResource(Res.string.settings_device_a11y_reinstall) else null,
                        subtitleLines = 3,
                        leading = { StepNumber(1) },
                        trailing = { StepAction(restrictedDone) { platform.request(DevicePermission.RESTRICTED_SETTINGS) } },
                    )
                }
                GroupRow(
                    stringResource(Res.string.settings_device_a11y_open),
                    leading = { StepNumber(if (needsRestricted) 2 else 1) },
                    trailing = { StepAction(listed) { platform.request(DevicePermission.ACCESSIBILITY) } },
                )
            }
        }
    }
}

/** adb's refusal in the words of the setting that causes it on the makers that have one. */
private suspend fun grantFailure(failure: RiffetHttpException, maker: DeviceMaker): String {
    if (failure.code != "ADB_GRANT_FAILED") return failure.message
    if ("GRANT_RUNTIME_PERMISSIONS" !in failure.serverMessage) return failure.serverMessage
    return when (maker) {
        DeviceMaker.OPPO -> getString(Res.string.settings_device_a11y_oppo_monitor)
        DeviceMaker.XIAOMI -> getString(Res.string.settings_device_a11y_xiaomi_secure)
        DeviceMaker.OTHER -> failure.serverMessage
    }
}

@Composable
private fun StepNumber(number: Int) {
    Text(number.toString(), style = LocalRiffetTypography.current.body, color = LocalRiffetColors.current.fg3)
}

@Composable
private fun StepAction(done: Boolean, onClick: () -> Unit) {
    if (done) {
        Icon(RiffetIcons.Check, contentDescription = null, tint = LocalRiffetColors.current.success, modifier = Modifier.size(LocalInterfaceStyle.current.metrics.iconSize))
    } else {
        SettingsButton(stringResource(Res.string.settings_device_a11y_go), onClick = onClick)
    }
}

/** The apps screen control has touched, each with 允许 / 询问 / 禁止; stored on this device only. */
@Composable
private fun AppPoliciesGroup() {
    val apps = DeviceControl.apps
    val touched by apps.touched.collectAsState()
    // Read so a change redraws the rows.
    val policies by apps.changes.collectAsState()
    if (touched.isEmpty()) return
    val labels = listOf(
        AppPolicy.ALLOW to stringResource(Res.string.settings_device_app_allow),
        AppPolicy.ASK to stringResource(Res.string.settings_device_app_ask),
        AppPolicy.BLOCK to stringResource(Res.string.settings_device_app_block),
    )
    SettingsGroup(stringResource(Res.string.settings_device_apps)) {
        touched.forEach { app ->
            val current = AppPolicy.of(policies[app.packageName]) ?: apps.policy(app.packageName)
            SettingsRow(app.label) { PolicyMenu(labels, current) { apps.set(app.packageName, it) } }
        }
    }
    SettingsFootnote(stringResource(Res.string.settings_device_apps_note))
}

@Composable
private fun PolicyMenu(labels: List<Pair<AppPolicy, String>>, current: AppPolicy, onSelect: (AppPolicy) -> Unit) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    var open by remember { mutableStateOf(false) }
    Box {
        SettingsButton(labels.first { it.first == current }.second, onClick = { open = true })
        RiffetDropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            labels.forEach { (policy, label) ->
                RiffetMenuItem(onClick = { open = false; onSelect(policy) }, selected = policy == current, showCheck = true) {
                    Text(label, style = typography.body, color = colors.fg)
                }
            }
        }
    }
}

@Composable
private fun CapabilityControl(capability: DeviceCapabilityState, platform: DevicePlatform) {
    val colors = LocalRiffetColors.current
    val missing = capability.missing
    when {
        missing != null -> SettingsButton(stringResource(Res.string.settings_keepalive_allow), onClick = { platform.request(missing) })
        capability.usable -> SettingsStatusLine(stringResource(Res.string.settings_device_available), colors.success)
        else -> SettingsStatusLine(stringResource(Res.string.settings_device_unavailable), colors.fg4)
    }
}
