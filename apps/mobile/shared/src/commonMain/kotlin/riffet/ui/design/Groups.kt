package riffet.ui.design

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import riffet.ui.icons.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.ParentDataModifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import riffet.ui.icons.RiffetIcons
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography

/** Grouped cards' corner. */
internal val GroupShape: RoundedCornerShape
    @Composable get() = RoundedCornerShape(LocalInterfaceStyle.current.groupRadius)

/** The page inset of a grouped card, and of its title. */
internal val GroupInset
    @Composable get() = LocalInterfaceStyle.current.metrics.groupInset

/** A group's label above its card: footnote size, the third text tone, aligned with the rows' text. */
@Composable
internal fun GroupTitle(text: String, modifier: Modifier = Modifier, action: (@Composable () -> Unit)? = null) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    Row(
        modifier.fillMaxWidth().padding(start = GroupInset + metrics.rowPadding, end = GroupInset + if (action != null) (metrics.controlInset / 4) else metrics.rowPadding, top = metrics.sectionGap, bottom = (metrics.controlInset / 2)),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(text, style = LocalRiffetTypography.current.footnote, color = colors.fg3, maxLines = 1, modifier = Modifier.weight(1f))
        action?.invoke()
    }
}

/** A note under a group, for the one fact a reader cannot infer from the rows. */
@Composable
internal fun GroupFootnote(text: String, modifier: Modifier = Modifier) {
    val metrics = LocalInterfaceStyle.current.metrics
    Text(
        text,
        style = LocalRiffetTypography.current.caption,
        color = LocalRiffetColors.current.fg3,
        modifier = modifier.fillMaxWidth().padding(start = GroupInset + metrics.rowPadding, end = GroupInset + metrics.rowPadding, top = (metrics.controlInset / 2)),
    )
}

/**
 * A grouped card: rows on one rounded surface with hairlines between them, each hairline starting
 * where its row's text does (see [GroupRow]'s leading slot). Clips, so a row's press highlight
 * follows the corners.
 */
@Composable
internal fun Group(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val metrics = LocalInterfaceStyle.current.metrics
    val s = surfaces
    val hairline = s.hairline
    val drawDividers = LocalInterfaceStyle.current.components.lists.dividers
    // Row tops and their hairline insets, recorded during layout and drawn right after it.
    val dividers = remember { DividerPlan() }
    Layout(
        content = content,
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = GroupInset)
            .cardEdge(GroupShape)
            .clip(GroupShape)
            .background(materialContentBackground(s.card))
            .drawWithContent {
                drawContent()
                for (i in 0 until if (drawDividers) dividers.count else 0) {
                    val y = dividers.tops[i].toFloat()
                    drawLine(hairline, Offset(dividers.insets[i].toFloat(), y), Offset(size.width, y), strokeWidth = metrics.hairlineWidth.toPx())
                }
            },
    ) { measurables, constraints ->
        val placeables = measurables.map { it.measure(constraints.copy(minHeight = 0)) }
        val height = placeables.sumOf { it.height }
        layout(constraints.maxWidth, height) {
            // Reset here, not in measure: placement can run again without a remeasure.
            dividers.reset(placeables.size)
            var y = 0
            // Only between rows that take room: a collapsed AnimatedVisibility or a dialog's empty
            // slot must not leave a hairline behind.
            var seen = false
            placeables.forEachIndexed { index, placeable ->
                if (placeable.height > 0) {
                    if (seen) dividers.add(y, ((measurables[index].parentData as? GroupInsetData)?.inset ?: metrics.rowPadding).roundToPx())
                    seen = true
                }
                placeable.place(0, y)
                y += placeable.height
            }
        }
    }
}

private class DividerPlan {
    var tops = IntArray(8); var insets = IntArray(8); var count = 0
    fun reset(capacity: Int) { if (tops.size < capacity) { tops = IntArray(capacity); insets = IntArray(capacity) }; count = 0 }
    fun add(top: Int, inset: Int) { tops[count] = top; insets[count] = inset; count++ }
}

private class GroupInsetData(val inset: Dp) : ParentDataModifier {
    override fun Density.modifyParentData(parentData: Any?): Any = this@GroupInsetData
}

/** Where the hairline above this row starts inside a [Group]. */
internal fun Modifier.groupDividerInset(inset: Dp): Modifier = this.then(GroupInsetData(inset))

/**
 * A white glyph on a small flat coloured tile: the leading mark of a settings or sheet
 * row. [tint] comes from the palette (a semantic, chart or agent colour), never a new colour.
 */
@Composable
internal fun IconTile(icon: ImageVector, tint: Color, modifier: Modifier = Modifier, size: Dp = LocalInterfaceStyle.current.metrics.iconSlot) {
    val metrics = LocalInterfaceStyle.current.metrics
    if (LocalInterfaceStyle.current.variants.settingsIcons == riffet.ui.design.SettingsIconPresentation.PLAIN) {
        Icon(icon, contentDescription = null, tint = tint, modifier = modifier.size(size * 0.8f))
        return
    }
    val shape = RoundedCornerShape(metrics.iconTileRadius)
    Box(
        modifier
            .size(size)
            .clip(shape)
            .background(tint),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = null, tint = Color.White, modifier = Modifier.size(size * 0.6f))
    }
}

/**
 * One row of a [Group]: an optional leading mark, a title with an optional line under it, then a
 * value, a control or a chevron. A row with [onClick] is pressable across its whole width.
 */
@Composable
internal fun GroupRow(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    /** A description or a result can run longer than a summary. */
    subtitleLines: Int = 1,
    leading: (@Composable () -> Unit)? = null,
    value: String? = null,
    chevron: Boolean = false,
    trailing: (@Composable () -> Unit)? = null,
    enabled: Boolean = true,
    onClickLabel: String? = null,
    role: Role? = null,
    onClick: (() -> Unit)? = null,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    if (!LocalInterfaceStyle.current.components.lists.grouped) {
        ListItem(
            headlineContent = { Text(title, style = LocalRiffetTypography.current.body, maxLines = 2, overflow = TextOverflow.Ellipsis) },
            supportingContent = subtitle?.let { { Text(it, style = LocalRiffetTypography.current.subhead, maxLines = subtitleLines, overflow = TextOverflow.Ellipsis) } },
            leadingContent = leading,
            trailingContent = if (value != null || trailing != null || chevron) ({
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy((metrics.controlInset / 2))) {
                    if (value != null) Text(value)
                    trailing?.invoke()
                    if (chevron) Icon(RiffetIcons.ChevronRight, null, Modifier.size(metrics.smallIconSize))
                }
            }) else null,
            colors = ListItemDefaults.colors(
                containerColor = Color.Transparent,
                headlineColor = if (enabled) LocalRiffetColors.current.fg else surfaces.disabledContent,
            ),
            modifier = modifier.heightIn(min = maxOf(metrics.controlHeight, if (subtitle != null) metrics.rowSubtitleHeight else metrics.rowHeight)).then(if (onClick != null) Modifier.clickable(enabled = enabled, onClickLabel = onClickLabel, role = role ?: Role.Button, onClick = onClick) else Modifier),
        )
        return
    }
    val colors = LocalRiffetColors.current
    val type = LocalRiffetTypography.current
    Row(
        modifier
            .groupDividerInset(if (leading != null) metrics.rowPadding + metrics.iconSlot + metrics.rowPadding else metrics.rowPadding)
            .fillMaxWidth()
            .then(if (onClick != null) Modifier.clickable(enabled = enabled, onClickLabel = onClickLabel, role = role ?: Role.Button, onClick = onClick) else Modifier)
            .heightIn(min = maxOf(metrics.controlHeight, if (subtitle != null) metrics.rowSubtitleHeight else metrics.rowHeight))
            .padding(start = metrics.rowPadding, end = metrics.rowPadding),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(metrics.rowPadding),
    ) {
        if (leading != null) Box(Modifier.width(metrics.iconSlot), contentAlignment = Alignment.Center) { leading() }
        Column(Modifier.weight(1f).padding(vertical = (metrics.rowPadding / 2))) {
            Text(title, style = type.body, color = if (enabled) colors.fg else surfaces.disabledContent, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (subtitle != null) Text(subtitle, style = type.subhead, color = colors.fg3, maxLines = subtitleLines, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = metrics.hairlineWidth * 2))
        }
        if (value != null) Text(value, style = type.body, color = colors.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = metrics.menuMaxWidth * 0.4f))
        trailing?.invoke()
        if (chevron) Icon(RiffetIcons.ChevronRight, contentDescription = null, tint = colors.fg4, modifier = Modifier.size(metrics.smallIconSize))
    }
}

/** Vertical rhythm between groups on a grouped page. */
@Composable
internal fun GroupSpacer() = Spacer(Modifier.heightIn(min = LocalInterfaceStyle.current.metrics.sectionGap))
