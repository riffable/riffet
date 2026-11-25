package riffet.ui.pickers

import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.LocalRiffetSurfaces
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.layout.size
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.semantics
import riffet.ui.icons.Icon
import riffet.ui.icons.RiffetIcons
import org.jetbrains.compose.resources.stringResource
import riffet_mobile.shared.generated.resources.*
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
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
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(metrics.controlInset / 2)) {
        status.quota?.let { quota ->
            QuotaTag(quotaLabel(quota), when {
                quota.depleted -> colors.danger
                quota.remaining == null && remainingPercent(quota.usedPercent) < LOW_LEFT -> colors.warning
                else -> colors.fg3
            })
        }
        // The daily allowance is its own window: a depleted daily quota lowers priority while the
        // shared weekly quota above can still have room.
        status.dailyQuota?.let { daily ->
            QuotaTag(dailyQuotaLabel(daily), colors.fg3)
            if (daily.depleted) QuotaTag(dailyQuotaLowPriorityLabel(), colors.fg3)
        }
        if (quotaUnavailable(status)) QuotaTag(quotaUnavailableLabel(), colors.fg3)
        status.loadPercent?.let { load ->
            QuotaTag("Load $load%", when (loadTone(load)) {
                LoadTone.DANGER -> colors.danger
                LoadTone.WARNING -> colors.warning
                LoadTone.MUTED -> colors.fg3
            })
        }
    }
}

@Composable
private fun QuotaTag(text: String, color: androidx.compose.ui.graphics.Color) {
    Text(text = text, style = LocalRiffetTypography.current.caption, color = color, maxLines = 1)
}

/** Below this share left, a meter turns to warning and says when it resets. */
private const val LOW_LEFT = 20

/**
 * The account's quota as one weak chip over the panel's parameters: each window's share left (5 hours, Weekly), the
 * time it resets only once it runs low, then the credits. Fixed at the bottom, not with the models: it is the
 * provider's, the same whichever model is picked. Words and figures only, short enough for one line.
 */
@Composable
internal fun AccountQuotaStrip(account: AccountUsage, modifier: Modifier = Modifier) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val surfaces = LocalRiffetSurfaces.current
    val now = platformNowMillis()
    Row(
        // Shaped like the parameter chips under it, half their fill: a figure to read, not a control to press.
        modifier
            .clip(RoundedCornerShape(metrics.controlRadius))
            .background(surfaces.press.copy(alpha = surfaces.press.alpha / 2))
            .heightIn(min = metrics.segmentedHeight)
            .padding(horizontal = metrics.rowPadding * 3 / 4),
        horizontalArrangement = Arrangement.spacedBy(metrics.rowPadding),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (account.limitReached) Text(stringResource(Res.string.pmodel_limit_reached), style = typography.caption, color = colors.danger, maxLines = 1)
        account.windows.forEach { window ->
            val left = remainingPercent(window.usedPercent)
            val tone = when {
                left <= 0 -> colors.danger
                left < LOW_LEFT -> colors.warning
                else -> colors.fg
            }
            val reset = if (left < LOW_LEFT) resetLabel(window.resetsAt, now, ::platformUtcOffsetMillis) else null
            Row(
                Modifier.semantics(mergeDescendants = true) {},
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(metrics.controlInset / 2),
            ) {
                Text(windowName(window.windowMinutes), style = typography.caption, color = colors.fg3, maxLines = 1)
                Text("$left%", style = typography.caption, color = tone, maxLines = 1)
                // The clock says what the time is; the words that said it would not fit beside two windows.
                if (reset != null) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(metrics.controlInset / 4)) {
                    Icon(RiffetIcons.Clock, contentDescription = reset, tint = colors.fg3, modifier = Modifier.size(metrics.smallIconSize * 0.75f))
                    Text(reset.removePrefix("Resets in ").removePrefix("Resets on "), style = typography.caption, color = colors.fg3, maxLines = 1,
                        modifier = Modifier.clearAndSetSemantics {})
                }
            }
        }
        val credits = account.credits
        val balance = credits?.balance
        when {
            credits?.unlimited == true -> "Unlimited credits"
            balance != null -> "${formatQuotaAmount(kotlin.math.floor(balance))} credits"
            else -> null
        }?.let { Text(it, style = typography.caption, color = colors.fg3, maxLines = 1) }
    }
}
