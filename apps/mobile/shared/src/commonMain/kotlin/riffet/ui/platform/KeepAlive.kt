package riffet.ui.platform

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/** Phone makers whose own background switches sit outside stock Android's battery settings. */
enum class KeepAliveVendor { OPPO, XIAOMI, VIVO, HUAWEI, HONOR, SAMSUNG }

/** A system page that keeps the connection up while Riffet is in the background. */
enum class KeepAlivePage {
    /** Android's battery-optimisation exemption, asked for with the system dialog. */
    BATTERY,

    /** The maker's background/battery page for this app, or the app's details page. */
    BACKGROUND,

    /** The maker's auto-start list; offered only where one exists. */
    AUTOSTART,
}

/**
 * What the keep-alive rows show. [batteryExempt] is null where it cannot be read; [autostart] is
 * whether the maker has an auto-start page apart from [KeepAlivePage.BACKGROUND].
 */
data class KeepAliveStatus(
    val batteryExempt: Boolean?,
    val vendor: KeepAliveVendor?,
    val autostart: Boolean,
)

/** Null where nothing on this platform keeps a connection in the background. */
@Composable
expect fun rememberKeepAliveStatus(): KeepAliveStatus?

expect fun openKeepAlivePage(page: KeepAlivePage)

/**
 * Set by the Android host when the connection dropped while the app was in the background and the
 * keep-alive service was up; the settings page then says so next to the switches that prevent it.
 */
object KeepAliveNotice {
    var cutOffAt: Long? by mutableStateOf(null)

    fun dismiss() {
        cutOffAt = null
    }
}
