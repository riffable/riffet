package riffet.ui.pickers

import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.settings.SettingsNoticeKind
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import org.jetbrains.compose.resources.stringResource
import riffet_mobile.shared.generated.resources.*
import riffet.contracts.NativeBackendOption

/*
 * ============================================================================================
 * Mode and permission pickers - `Composer.tsx`'s `ModePicker` and `ApprovalPicker.tsx`
 * ============================================================================================
 *
 * Both read their available values from the *session's backend capabilities*
 * (`NativeBackendCatalogEntry.capabilities.modes` / `.permissions`), never from an enum guessed on
 * this side. That is not a style choice: the server rejects a `nativeSetMode` / `nativeSetApproval`
 * whose id the backend does not advertise (`INVALID_MODE`, `INVALID_APPROVAL_MODE`), and the ids
 * differ per backend (Claude's are `manual`, `acceptEdits`, `bypassPermissions`, ...).
 *
 * The copy is the one thing this file does supply, and only where the server sends none. The
 * server's own options carry a label and no description (`backends/cursor/index.ts`:
 * `{ id: 'unrestricted', label: 'Run everything' }`), while the web spells out what each mode does
 * in `lib/approval.ts`. "Unrestricted is a meaningful escalation the operator should see spelled
 * out", so the web's sentence is reproduced for the ids it names, and the server's description is
 * used for everything else. The *values* still come only from the backend.
 */

/** The web's `modeMeta` copy, keyed by the Cursor mode ids the server advertises. */
@Composable
private fun modeDescription(id: String): String? = when (id) {
    "agent" -> stringResource(Res.string.pickers_mode_agent)
    "plan" -> stringResource(Res.string.pickers_mode_plan)
    "ask" -> stringResource(Res.string.pickers_mode_ask)
    else -> null
}

/** Cursor's fallback copy; other backends may reuse an id with different approval semantics. */
@Composable
private fun approvalDescription(id: String): String? = when (id) {
    "allowlist" -> stringResource(Res.string.pickers_approval_allowlist)
    "auto-review" -> stringResource(Res.string.pickers_approval_auto_review)
    "unrestricted" -> stringResource(Res.string.pickers_approval_unrestricted)
    else -> null
}

/** Modes the trigger and summaries mark with the warning colour; list rows stay plain. */
private val RISKY_PERMISSIONS = setOf("unrestricted", "bypassPermissions", "danger-full-access", "never", "high")

internal fun isRiskyApproval(id: String): Boolean = id in RISKY_PERMISSIONS

/**
 * The mode list as one page of a sheet. Picking applies [onSelect] and then lets the sheet leave
 * with its slide; a caller that also closes the sheet itself in [onSelect] merely skips the slide.
 */
@Composable
internal fun ModePickerPage(
    options: List<NativeBackendOption>,
    value: String,
    currentLabel: String,
    disabledReason: String?,
    onSelect: (String) -> Unit,
    onBack: (() -> Unit)? = null,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val host = LocalPickerHost.current
    PickerPage(
        title = stringResource(Res.string.pickers_mode_title),
        subtitle = stringResource(Res.string.pickers_current, currentLabel),
        onBack = onBack,
    ) {
        if (!disabledReason.isNullOrEmpty()) SheetNotice(disabledReason, SettingsNoticeKind.INFO)
        Column(modifier = Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(bottom = metrics.rowPadding)) {
            options.forEach { option ->
                OptionRow(
                    label = option.label.ifEmpty { option.id },
                    description = option.description?.takeIf { it.isNotBlank() } ?: modeDescription(option.id),
                    selected = option.id == value,
                    onClick = {
                        onSelect(option.id)
                        host?.dismiss?.invoke()
                    },
                    disabledReason = disabledReason,
                )
            }
        }
    }
}

@Composable
internal fun ModePickerSheet(
    options: List<NativeBackendOption>,
    value: String,
    currentLabel: String,
    disabledReason: String?,
    onDismiss: () -> Unit,
    onSelect: (String) -> Unit,
    onBack: (() -> Unit)? = null,
) {
    PickerSheetFrame(onDismiss) { ModePickerPage(options, value, currentLabel, disabledReason, onSelect, onBack) }
}

/** The approval list as one page of a sheet; see [ModePickerPage]. */
@Composable
internal fun ApprovalPickerPage(
    options: List<NativeBackendOption>,
    value: String,
    currentLabel: String,
    disabledReason: String?,
    onSelect: (String) -> Unit,
    onBack: (() -> Unit)? = null,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val host = LocalPickerHost.current
    PickerPage(
        title = stringResource(Res.string.pickers_approval_title),
        subtitle = stringResource(Res.string.pickers_current, currentLabel),
        onBack = onBack,
    ) {
        if (!disabledReason.isNullOrEmpty()) SheetNotice(disabledReason, SettingsNoticeKind.INFO)
        if (value in RISKY_PERMISSIONS) {
            SheetNotice(stringResource(Res.string.pickers_approval_escalated), SettingsNoticeKind.WARNING)
        }
        Column(modifier = Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(bottom = metrics.rowPadding)) {
            options.forEach { option ->
                OptionRow(
                    label = option.label.ifEmpty { option.id },
                    description = option.description?.takeIf { it.isNotBlank() }
                        ?: if (options.any { it.id == "allowlist" }) approvalDescription(option.id) else null,
                    selected = option.id == value,
                    onClick = {
                        onSelect(option.id)
                        host?.dismiss?.invoke()
                    },
                    disabledReason = disabledReason,
                )
            }
        }
    }
}

@Composable
internal fun ApprovalPickerSheet(
    options: List<NativeBackendOption>,
    value: String,
    currentLabel: String,
    disabledReason: String?,
    onDismiss: () -> Unit,
    onSelect: (String) -> Unit,
    onBack: (() -> Unit)? = null,
) {
    PickerSheetFrame(onDismiss) { ApprovalPickerPage(options, value, currentLabel, disabledReason, onSelect, onBack) }
}

/**
 * The label shown next to the trigger, from the session's own option list.
 *
 * [fallback] is the caller's localized name for the setting, used only when the backend reported
 * neither a label nor an id. It stays a parameter because this helper is not composable.
 */
internal fun optionLabelOf(options: List<NativeBackendOption>, value: String, fallback: String): String =
    options.firstOrNull { it.id == value }?.label?.takeIf { it.isNotBlank() } ?: value.ifBlank { fallback }

/** The compact name for a tight row: the option's short label, else its label. */
internal fun approvalShortLabelOf(options: List<NativeBackendOption>, value: String, fallback: String): String =
    options.firstOrNull { it.id == value }?.let { it.shortLabel?.takeIf(String::isNotBlank) ?: it.label.takeIf(String::isNotBlank) }
        ?: value.ifBlank { fallback }
