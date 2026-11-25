package riffet.ui.pickers

import riffet.ui.settings.SettingsNoticeKind
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.foundation.layout.Box
import riffet.ui.design.RiffetProgressIndicator as CircularProgressIndicator
import androidx.compose.foundation.clickable
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.heightIn
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import riffet.ui.icons.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import org.jetbrains.compose.resources.stringResource
import riffet_mobile.shared.generated.resources.*
import riffet.contracts.NativeContext
import riffet.ui.icons.RiffetIcons
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.LocalRiffetSurfaces

/** One row of [SendSettingsSheet]: a setting, its current value, and the picker it opens. */
internal class SendSettingRow(
    val label: String,
    val value: String,
    val icon: ImageVector? = null,
    /** Overrides the sheet's default icon tint; `Color.Unspecified` keeps a
     * vector's own fill (the Codex mark's gradient) instead of flattening it. */
    val iconTint: Color? = null,
    val enabled: Boolean = true,
    /** The value is still being read: a spinner stands where the chevron goes. */
    val loading: Boolean = false,
    /** A write to this setting is in flight: the same spinner, announced as switching. */
    val switching: Boolean = false,
    /** The value could not be read: a warning stands where the chevron goes; the sheet's notice says why. */
    val error: Boolean = false,
    val onClick: () -> Unit,
)

/**
 * The web composer's mobile "发送设置" dialog: everything that shapes the next message — mode,
 * permission, agent and model — behind the one chip in the composer footer, and under them how
 * full the model's context window is.
 */
@Composable
internal fun SendSettingsPage(
    rows: List<SendSettingRow>,
    notice: String? = null,
    noticeKind: SettingsNoticeKind = SettingsNoticeKind.INFO,
    /** The notice's one safe remedy, shown at its end. */
    noticeAction: Pair<String, () -> Unit>? = null,
    /** The session's context occupancy, shown under the model it belongs to; null shows nothing. */
    context: NativeContext? = null,
    onOpenContext: () -> Unit = {},
    /** Back to the model panel that opened this page. */
    onBack: (() -> Unit)? = null,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val recipe = LocalInterfaceStyle.current.components.lists
    // No subtitle: the owner read "选择这条任务使用的模式、模型和权限" as noise above rows that already
    // say 模式 / 模型 / 权限. The web's dialog still carries the same sentence (Composer.tsx), so it is
    // an intentional divergence, not a drift — the sheet's own title says everything the rows do not.
    PickerPage(title = stringResource(Res.string.pmodel_more), onBack = onBack) {
        notice?.let { SheetNotice(it, noticeKind, noticeAction?.first, noticeAction?.second) }
        Column(modifier = Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(bottom = metrics.controlInset)) {
            rows.forEach { row ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = SheetGutter)
                        .clip(SheetRowShape)
                        .then(if (sheetRowsFilled) Modifier.background(LocalRiffetSurfaces.current.card) else Modifier)
                        .pickerRowDivider()
                        .clickable(role = Role.Button, enabled = row.enabled, onClick = row.onClick)
                        .heightIn(min = maxOf(metrics.controlHeight, if (recipe.valueBelowLabel) metrics.rowSubtitleHeight else metrics.rowHeight))
                        .padding(start = (SheetInset - SheetGutter).coerceAtLeast(0.dp), end = if (recipe.compactChevron) metrics.rowPadding else metrics.controlInset / 4, top = (metrics.rowPadding / 2), bottom = (metrics.rowPadding / 2)),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (recipe.valueBelowLabel) Column(modifier = Modifier.weight(1f)) {
                        Text(text = row.label, style = SheetRowText, color = if (row.enabled) colors.fg else colors.fg4)
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            row.icon?.let {
                                Icon(it, contentDescription = null, tint = row.iconTint ?: colors.fg2, modifier = Modifier.size(metrics.smallIconSize))
                                Spacer(Modifier.width((metrics.controlInset / 2)))
                            }
                            Text(
                                text = row.value,
                                style = typography.bodySmall,
                                color = if (row.enabled) colors.fg2 else colors.fg4,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    } else {
                        Text(
                            text = row.label,
                            modifier = Modifier.weight(0.5f).padding(end = metrics.controlInset / 2),
                            style = typography.body,
                            color = if (row.enabled) colors.fg else colors.fg4,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            text = row.value,
                            modifier = Modifier.weight(1f),
                            style = typography.bodySmall,
                            // The value's ink, as on a settings row: a step below the label in size and two in ink.
                            color = if (row.enabled) colors.fg3 else colors.fg4,
                            textAlign = TextAlign.End,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    if (row.enabled) {
                        Spacer(Modifier.width(if (recipe.compactChevron) metrics.controlInset / 2 else metrics.controlInset))
                        Box(modifier = Modifier.size(if (recipe.compactChevron) metrics.smallIconSize else metrics.iconSize), contentAlignment = Alignment.Center) {
                            if (row.loading || row.switching) {
                                val loadingLabel = if (row.loading) stringResource(Res.string.pickers_catalog_loading) else stringResource(Res.string.pickers_switching)
                                CircularProgressIndicator(
                                    modifier = Modifier.size(metrics.smallIconSize).semantics { stateDescription = loadingLabel },
                                    strokeWidth = metrics.focusWidth,
                                    color = colors.fg3,
                                )
                            } else if (row.error) {
                                val failedLabel = stringResource(Res.string.session_catalog_read_failed)
                                Icon(RiffetIcons.Warning, contentDescription = null, tint = colors.danger, modifier = Modifier.size(metrics.smallIconSize).semantics { stateDescription = failedLabel })
                            } else {
                                Icon(RiffetIcons.ChevronRight, contentDescription = null, tint = colors.fg3, modifier = Modifier.size(if (recipe.compactChevron) metrics.smallIconSize * 0.75f else metrics.iconSize))
                            }
                        }
                    }
                }
            }
            ContextSummaryRow(usage = context, onClick = onOpenContext)
        }
    }
}

@Composable
internal fun SendSettingsSheet(
    rows: List<SendSettingRow>,
    onDismiss: () -> Unit,
    notice: String? = null,
    noticeKind: SettingsNoticeKind = SettingsNoticeKind.INFO,
    noticeAction: Pair<String, () -> Unit>? = null,
    context: NativeContext? = null,
    onOpenContext: () -> Unit = {},
) {
    PickerSheetFrame(onDismiss) { SendSettingsPage(rows, notice, noticeKind, noticeAction, context, onOpenContext) }
}
