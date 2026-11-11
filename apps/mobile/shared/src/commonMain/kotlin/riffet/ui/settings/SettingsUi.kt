package riffet.ui.settings

import riffet.ui.design.LocalInterfaceStyle
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import riffet.ui.icons.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.constrainHeight
import androidx.compose.ui.unit.dp
import riffet.ui.app.cardColor
import riffet.ui.design.Group
import riffet.ui.design.GroupRow
import riffet.ui.design.RiffetButton
import riffet.ui.design.GroupFootnote
import riffet.ui.design.GroupTitle
import riffet.ui.design.SegmentedControl
import riffet.ui.design.RiffetSwitch
import riffet.ui.icons.RiffetIcons
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet.ui.design.LocalRiffetSurfaces

/** Settings navigation delegates to the same row renderer as other grouped pages. */
@Composable
internal fun SettingsLinkRow(title: String, subtitle: String? = null, leading: (@Composable () -> Unit)? = null, onClick: () -> Unit) {
    GroupRow(title = title, subtitle = subtitle, subtitleLines = 2, leading = leading, chevron = true, onClick = onClick,
        modifier = Modifier.settingsSearchAnchor(title))
}

/** Lets grouped content extend across the page inset, including custom theme spacing. */
@Composable
internal fun Modifier.bleed(): Modifier {
    val inset = LocalInterfaceStyle.current.metrics.pageInset
    return layout { measurable, constraints ->
        val extra = inset.roundToPx() * 2
        if (!constraints.hasBoundedWidth) {
            val placeable = measurable.measure(constraints)
            return@layout layout(placeable.width, placeable.height) { placeable.place(0, 0) }
        }
        val width = constraints.maxWidth + extra
        val placeable = measurable.measure(constraints.copy(minWidth = width, maxWidth = width))
        layout(constraints.maxWidth, placeable.height) { placeable.place(-inset.roundToPx(), 0) }
    }
}

/** A titled group rendered by the global design system.
 * [card] false shows only the section heading and action for an empty group.
 */
@Composable
internal fun SettingsGroup(
    title: String,
    action: (@Composable () -> Unit)? = null,
    card: Boolean = true,
    content: @Composable () -> Unit,
) {
    Column(modifier = Modifier.fillMaxWidth().bleed()) {
        if (title.isNotEmpty() || action != null) Box(Modifier.fillMaxWidth().settingsSearchAnchor(title, SettingsSearchAnchor.GROUP)) {
            GroupTitle(title, action = action)
        } else Spacer(Modifier.size(16.dp))
        if (card) Group(content = content)
    }
}

/** A setting with optional wrapping supporting text and a trailing control. */
@Composable
private fun SettingsLine(title: String, description: String?, modifier: Modifier = Modifier, enabled: Boolean = true, trailing: @Composable () -> Unit) {
    GroupRow(title = title, subtitle = description, subtitleLines = Int.MAX_VALUE, modifier = modifier.settingsSearchAnchor(title), enabled = enabled, trailing = trailing)
}

/** Keep the label intact; move a wide control below it when both cannot share a line. */
@Composable
internal fun SettingsRow(
    title: String,
    description: String? = null,
    control: @Composable () -> Unit,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val typography = LocalRiffetTypography.current
    val colors = LocalRiffetColors.current
    val measurer = rememberTextMeasurer()
    val titleWidth = measurer.measure(title, style = typography.body, softWrap = false, maxLines = 1).size.width
    Layout(
        content = {
            Column {
                Text(title, style = typography.body, color = colors.fg)
                if (!description.isNullOrBlank()) Text(description, style = typography.subhead, color = colors.fg3,
                    modifier = Modifier.padding(top = metrics.hairlineWidth * 2))
            }
            Box { control() }
        },
        modifier = Modifier.fillMaxWidth().settingsSearchAnchor(title).padding(horizontal = metrics.rowPadding, vertical = metrics.rowPadding / 2),
    ) { children, constraints ->
        val gap = metrics.controlInset.roundToPx()
        val controlPlaceable = children[1].measure(constraints.copy(minWidth = 0, minHeight = 0))
        val inline = titleWidth + gap + controlPlaceable.width <= constraints.maxWidth
        val labelWidth = if (inline) constraints.maxWidth - controlPlaceable.width - gap else constraints.maxWidth
        val label = children[0].measure(constraints.copy(minWidth = 0, maxWidth = labelWidth, minHeight = 0))
        val height = maxOf(
            (metrics.rowHeight - metrics.rowPadding).roundToPx(),
            if (inline) maxOf(label.height, controlPlaceable.height) else label.height + gap + controlPlaceable.height,
        )
        layout(constraints.maxWidth, constraints.constrainHeight(height)) {
            label.placeRelative(0, if (inline) (height - label.height) / 2 else 0)
            controlPlaceable.placeRelative(if (inline) constraints.maxWidth - controlPlaceable.width else 0,
                if (inline) (height - controlPlaceable.height) / 2 else label.height + gap)
        }
    }
}

/** Longer explanations keep their full width, with actions on a separate line. */
@Composable
internal fun SettingsActionRow(title: String, description: String, actions: @Composable () -> Unit) {
    val metrics = LocalInterfaceStyle.current.metrics
    val typography = LocalRiffetTypography.current
    val colors = LocalRiffetColors.current
    Column(Modifier.fillMaxWidth().settingsSearchAnchor(title).padding(horizontal = metrics.rowPadding, vertical = metrics.rowPadding / 2)) {
        Text(title, style = typography.body, color = colors.fg)
        Text(description, style = typography.bodySmall, color = colors.fg3, modifier = Modifier.padding(top = metrics.hairlineWidth * 2))
        androidx.compose.foundation.layout.FlowRow(
            horizontalArrangement = Arrangement.spacedBy(metrics.controlInset / 2),
            verticalArrangement = Arrangement.spacedBy(metrics.controlInset / 2),
        ) { actions() }
    }
}

/** A setting that is a switch: a tap anywhere on the row toggles it, with one press highlight and one focus stop. */
@Composable
internal fun SettingsSwitchRow(
    title: String,
    description: String? = null,
    checked: Boolean,
    enabled: Boolean = true,
    onCheckedChange: (Boolean) -> Unit,
) {
    SettingsLine(
        title = title,
        description = description,
        enabled = enabled,
        modifier = Modifier.toggleable(value = checked, enabled = enabled, role = Role.Switch, onValueChange = onCheckedChange),
    ) { SettingsSwitch(checked = checked, enabled = enabled, onCheckedChange = null) }
}

/** A note under a group, aligned with its text inset. */
@Composable
internal fun SettingsFootnote(text: String) {
    GroupFootnote(text, Modifier.bleed())
}

/** With a null [onCheckedChange] the switch is only a picture; whatever contains it owns the toggle. */
@Composable
internal fun SettingsSwitch(checked: Boolean, enabled: Boolean = true, onCheckedChange: ((Boolean) -> Unit)?) {
    RiffetSwitch(checked = checked, onCheckedChange = onCheckedChange, enabled = enabled)
}

@Composable
internal fun SettingsField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String? = null,
    enabled: Boolean = true,
    mono: Boolean = false,
    password: Boolean = false,
    singleLine: Boolean = true,
    minLines: Int = 1,
    maxLines: Int = if (singleLine) 1 else Int.MAX_VALUE,
    modifier: Modifier = Modifier,
) {
    riffet.ui.design.RiffetTextField(
        value = value, onValueChange = onValueChange, placeholder = placeholder, enabled = enabled,
        mono = mono, password = password, singleLine = singleLine, minLines = minLines,
        maxLines = maxLines, modifier = modifier,
    )
}

/** `系统 / 浅色 / 深色` as the app's segmented control: one muted track, a raised thumb under the chosen option. */
@Composable
internal fun SettingsSegmented(
    options: List<Pair<String, String>>,
    value: String,
    enabled: Boolean = true,
    onSelect: (String) -> Unit,
) {
    SegmentedControl(
        options = options.map { it.second },
        selected = options.indexOfFirst { it.first == value },
        onSelect = { index -> options.getOrNull(index)?.let { onSelect(it.first) } },
        enabled = enabled,
    )
}

/** Compatibility adapter; the shared design layer owns the button renderer. */
@Composable
internal fun SettingsButton(text: String, onClick: () -> Unit, enabled: Boolean = true, primary: Boolean = false, danger: Boolean = false) {
    RiffetButton(text, onClick, enabled, primary, danger)
}

/** A coloured dot plus text, for `已配置 / 未配置` and capability rows. */
@Composable
internal fun SettingsStatusLine(text: String, tone: Color) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(6.dp).clip(CircleShape).background(tone))
        Spacer(Modifier.width(6.dp))
        Text(text = text, style = typography.caption, color = colors.fg3, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}

internal enum class SettingsNoticeKind { INFO, SUCCESS, WARNING, ERROR }

/** [background] defaults to the card tone of a plain page; [PageBanner] is the one for a grouped page. */
@Composable
internal fun SettingsMessageBanner(
    message: String,
    kind: SettingsNoticeKind,
    action: String? = null,
    onAction: (() -> Unit)? = null,
    background: Color = cardColor(),
    maxLines: Int = Int.MAX_VALUE,
    onOverflow: ((Boolean) -> Unit)? = null,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val (icon, tone) = when (kind) {
        SettingsNoticeKind.INFO -> RiffetIcons.Info to colors.fg3
        SettingsNoticeKind.SUCCESS -> RiffetIcons.Check to colors.accent
        SettingsNoticeKind.WARNING -> RiffetIcons.Warning to colors.warning
        SettingsNoticeKind.ERROR -> RiffetIcons.Error to colors.danger
    }
    val actionable = action != null && onAction != null
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(metrics.groupRadius))
            .background(background)
            // With an action, its 48dp touch target sets the height and the row centres on it.
            .padding(start = metrics.pageInset, end = if (actionable) metrics.controlInset / 2 else metrics.pageInset, top = if (actionable) 0.dp else metrics.rowPadding, bottom = if (actionable) 0.dp else metrics.rowPadding),
        verticalAlignment = if (actionable) Alignment.CenterVertically else Alignment.Top,
    ) {
        Icon(
            icon,
            contentDescription = null,
            tint = tone,
            modifier = Modifier.size(14.dp),
        )
        Spacer(Modifier.width(8.dp))
        Text(text = message, style = typography.caption, color = colors.fg2, modifier = Modifier.weight(1f),
            maxLines = maxLines, overflow = TextOverflow.Ellipsis, onTextLayout = { onOverflow?.invoke(it.hasVisualOverflow) })
        if (action != null && onAction != null) {
            riffet.ui.design.RiffetTextButton(onClick = onAction, modifier = Modifier.padding(start = 8.dp)) {
                Text(action)
            }
        }
    }
}

/** A banner on a settings page, in the grouped cards' own tone so it reads against the grouped page. */
@Composable
internal fun PageBanner(message: String, kind: SettingsNoticeKind, action: String? = null, onAction: (() -> Unit)? = null) {
    SettingsMessageBanner(message, kind, action, onAction, background = LocalRiffetSurfaces.current.card)
}

/** A label and its value in a group, the value in the monospace face and free to wrap, e.g. a path. */
@Composable
internal fun SettingsValueRow(label: String, value: String) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    Row(
        modifier = Modifier.fillMaxWidth().heightIn(min = metrics.controlHeight).padding(horizontal = metrics.pageInset, vertical = metrics.rowPadding),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text(text = label, style = typography.body, color = colors.fg,
            modifier = if (!LocalInterfaceStyle.current.components.lists.grouped) Modifier.weight(1f) else Modifier)
        Text(
            text = value,
            style = typography.monoSmall,
            color = colors.fg3,
            textAlign = TextAlign.End,
            maxLines = 3,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
    }
}
