package riffet.ui.pickers

import riffet.ui.design.LocalInterfaceStyle
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import riffet.contracts.AccountUsage
import riffet.contracts.ModelQuota
import riffet.contracts.ModelStatus
import riffet.contracts.UsageWindow
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet.ui.timeline.platformNowMillis
import riffet.ui.timeline.platformUtcOffsetMillis

/*
 * Port of `apps/web/src/lib/usage.ts`: the words the model list uses for a provider's quota and load.
 * The strings are the web's, so both clients say the same thing about the same account.
 */

/** A model's quota and load, as short figures after its name; nothing when neither was reported. */
@Composable
internal fun ModelStatusTags(status: ModelStatus?) {
    val metrics = LocalInterfaceStyle.current.metrics
    if (status == null) return
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    status.quota?.let { quota ->
        QuotaTag(quotaLabel(quota), if (quota.depleted) colors.danger else colors.fg4)
    }
    // The daily allowance is its own window: a depleted daily quota lowers priority while the
    // shared weekly quota above can still have room.
    status.dailyQuota?.let { daily ->
        QuotaTag(dailyQuotaLabel(daily), colors.fg4)
        if (daily.depleted) QuotaTag(dailyQuotaLowPriorityLabel(), colors.fg4)
    }
    if (quotaUnavailable(status)) QuotaTag(quotaUnavailableLabel(), colors.fg4)
    status.loadPercent?.let { load ->
        val tone = when (loadTone(load)) {
            LoadTone.DANGER -> colors.danger
            LoadTone.WARNING -> colors.warning
            LoadTone.MUTED -> colors.fg4
        }
        Text(text = "Load $load%", style = typography.caption, color = tone)
        Spacer(Modifier.width((metrics.controlInset / 2)))
    }
}

@Composable
private fun QuotaTag(text: String, color: androidx.compose.ui.graphics.Color) {
    val metrics = LocalInterfaceStyle.current.metrics
    Text(text = text, style = LocalRiffetTypography.current.caption, color = color)
    Spacer(Modifier.width((metrics.controlInset / 2)))
}
