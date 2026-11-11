package riffet.ui.platform

import android.annotation.SuppressLint
import android.app.KeyguardManager
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.biometrics.BiometricManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalWindowInfo
import riffet.shared.AppLog
import riffet.shared.RiffetAndroid

actual fun approvalVerificationAvailability(): VerificationAvailability {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return VerificationAvailability.UNSUPPORTED
    val context = RiffetAndroid.requireContext()
    val ready = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        val manager = context.getSystemService(BiometricManager::class.java)
        manager?.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_WEAK or BiometricManager.Authenticators.DEVICE_CREDENTIAL) ==
            BiometricManager.BIOMETRIC_SUCCESS
    } else {
        context.getSystemService(KeyguardManager::class.java)?.isDeviceSecure == true
    }
    return if (ready) VerificationAvailability.AVAILABLE else VerificationAvailability.NOT_ENROLLED
}

private fun keepAliveStatus(context: Context): KeepAliveStatus {
    val power = context.getSystemService(PowerManager::class.java)
    val vendor = VendorPages.vendor()
    return KeepAliveStatus(
        batteryExempt = power?.isIgnoringBatteryOptimizations(context.packageName),
        vendor = vendor,
        autostart = VendorPages.pages(vendor, KeepAlivePage.AUTOSTART).any { it.resolves(context) },
    )
}

/** Read again whenever the window regains focus, i.e. on the way back from a system page. */
@Composable
actual fun rememberKeepAliveStatus(): KeepAliveStatus? {
    val context = RiffetAndroid.requireContext()
    val focused = LocalWindowInfo.current.isWindowFocused
    var value by remember { mutableStateOf(keepAliveStatus(context)) }
    LaunchedEffect(focused) { if (focused) value = keepAliveStatus(context) }
    return value
}

actual fun openKeepAlivePage(page: KeepAlivePage) {
    val context = RiffetAndroid.requireContext()
    val candidates = when (page) {
        KeepAlivePage.BATTERY -> listOf(batteryRequest(context), Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        else -> VendorPages.pages(VendorPages.vendor(), page).map { it.intent(context) }
    } + appDetails(context)
    val opened = candidates.firstOrNull { launch(context, it) }
    AppLog.log("app", "keep-alive page $page opened=${opened?.component?.className ?: opened?.action}")
}

/** The system dialog; declared with REQUEST_IGNORE_BATTERY_OPTIMIZATIONS in the manifest. */
@SuppressLint("BatteryLife")
private fun batteryRequest(context: Context): Intent =
    Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}"))

private fun appDetails(context: Context): Intent =
    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))

/**
 * Starts [intent]. A vendor page (an explicit component, visible through the manifest's `<queries>`)
 * is started only if it resolves, is exported and asks no permission this app lacks, so a page that
 * moved is skipped rather than crashing; a system settings action is simply tried.
 */
private fun launch(context: Context, intent: Intent): Boolean {
    val activity = RiffetAndroid.currentActivity()
    if (intent.component != null && !VendorPages.Page.resolves(context, intent)) return false
    return try {
        if (activity != null) activity.startActivity(intent) else context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        true
    } catch (_: ActivityNotFoundException) {
        false
    } catch (_: SecurityException) {
        false
    }
}

/**
 * Where each maker keeps the switches stock Android lacks and no API reports. These are the
 * makers' own activities, liable to move between ROM versions, so each is tried only if it
 * resolves and is exported, best first, and the app's details page — which links to the same
 * switches on all of them — is the fallback. Design after dsh-go's `VendorSettings` (no code reused).
 */
private object VendorPages {
    class Page(private val pkg: String, private val cls: String? = null, private val action: String? = null, private val packageExtra: String? = null) {
        fun intent(context: Context): Intent {
            val intent = if (cls != null) Intent().setComponent(ComponentName(pkg, cls)) else Intent(action).setPackage(pkg)
            packageExtra?.let { intent.putExtra(it, context.packageName) }
            return intent
        }

        fun resolves(context: Context): Boolean = resolves(context, intent(context))

        companion object {
            fun resolves(context: Context, intent: Intent): Boolean {
                val info = context.packageManager.resolveActivity(intent, 0)?.activityInfo ?: return false
                val permission = info.permission
                return info.exported && (permission == null || context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED)
            }
        }
    }

    fun vendor(): KeepAliveVendor? = match(Build.MANUFACTURER) ?: match(Build.BRAND)

    private fun match(name: String?): KeepAliveVendor? {
        val value = name?.trim()?.lowercase() ?: return null
        fun any(vararg keys: String) = keys.any { value.startsWith(it) }
        return when {
            any("oppo", "oneplus", "realme") -> KeepAliveVendor.OPPO
            any("xiaomi", "redmi", "poco") -> KeepAliveVendor.XIAOMI
            any("vivo", "iqoo") -> KeepAliveVendor.VIVO
            // Older Honor phones report HUAWEI and run Huawei's manager.
            any("huawei") -> KeepAliveVendor.HUAWEI
            any("honor", "hihonor") -> KeepAliveVendor.HONOR
            any("samsung") -> KeepAliveVendor.SAMSUNG
            else -> null
        }
    }

    /**
     * ColorOS and One UI keep this app's background switches on its details page (ColorOS:
     * 耗电管理), so [KeepAlivePage.BACKGROUND] has no vendor page there. Huawei and Honor hold
     * start-up and background running in one 应用启动管理 list, so they have no separate auto-start.
     */
    fun pages(vendor: KeepAliveVendor?, page: KeepAlivePage): List<Page> = when (page) {
        KeepAlivePage.BATTERY -> emptyList()
        KeepAlivePage.BACKGROUND -> when (vendor) {
            KeepAliveVendor.XIAOMI -> listOf(
                Page("com.miui.powerkeeper", "com.miui.powerkeeper.ui.HiddenAppsConfigActivity", packageExtra = "package_name"),
            )
            KeepAliveVendor.VIVO -> listOf(
                Page("com.vivo.abe", "com.vivo.applicationbehaviorengine.ui.ExcessivePowerManagerActivity"),
                Page("com.iqoo.powersaving", "com.iqoo.powersaving.PowerSavingManagerActivity"),
            )
            KeepAliveVendor.HUAWEI -> listOf(
                Page("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"),
                Page("com.huawei.systemmanager", "com.huawei.systemmanager.appcontrol.activity.StartupAppControlActivity"),
                Page("com.huawei.systemmanager", "com.huawei.systemmanager.optimize.process.ProtectActivity"),
            )
            KeepAliveVendor.HONOR -> listOf(
                Page("com.hihonor.systemmanager", "com.hihonor.systemmanager.startupmgr.ui.StartupNormalAppListActivity"),
                Page("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"),
            )
            KeepAliveVendor.OPPO, KeepAliveVendor.SAMSUNG, null -> emptyList()
        }
        KeepAlivePage.AUTOSTART -> when (vendor) {
            KeepAliveVendor.OPPO -> listOf(
                // ColorOS 13+ moved 自启动管理 into the battery app; older builds keep it in 手机管家.
                Page("com.oplus.battery", "com.oplus.startupapp.view.StartupAppListActivity"),
                Page("com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity"),
                Page("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"),
                Page("com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity"),
            )
            KeepAliveVendor.XIAOMI -> listOf(
                Page("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"),
            )
            KeepAliveVendor.VIVO -> listOf(
                Page("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"),
                Page("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager"),
                Page("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity"),
            )
            else -> emptyList()
        }
    }
}
