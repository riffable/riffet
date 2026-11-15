package riffet.ui.app

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import org.jetbrains.compose.resources.stringResource
import riffet.ui.design.Group
import riffet.ui.design.GroupInset
import riffet.ui.design.GroupRow
import riffet.ui.design.GroupShape
import riffet.ui.design.GroupSpacer
import riffet.ui.design.GroupTitle
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.cardEdge
import riffet.ui.design.materialContentBackground
import riffet.ui.design.LocalRiffetSurfaces
import riffet.ui.icons.Icon
import riffet.ui.icons.RiffetIcons
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet_mobile.shared.generated.resources.*

/*
 * The parts both side panels are built from (mobile.md §2.7). A panel is the same app as the page
 * beside it, so it uses the page's list: [Group] cards, [GroupTitle] labels and [GroupRow] rows, at
 * the page's type scale and row height, in whatever form the interface style gives them. What is
 * the panel's own is only its header (a page bar's title in a narrower bar), the action bar and the
 * status dot. Object rows (a subagent, a favourite) are one line and truncate.
 */

/** The panel's fixed header: [leading] (an avatar) or a back arrow, a one-line title and status, then [actions] and close. */
@Composable
internal fun PaneHeader(
    title: String,
    onClose: (() -> Unit)?,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    subtitleColor: Color? = null,
    onBack: (() -> Unit)? = null,
    leading: (@Composable () -> Unit)? = null,
    onTitleClick: (() -> Unit)? = null,
    actions: @Composable RowScope.() -> Unit = {},
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val type = LocalRiffetTypography.current
    Row(
        modifier.fillMaxWidth().heightIn(min = metrics.barHeight)
            .padding(start = if (onBack != null) metrics.controlInset / 3 else metrics.pageInset, end = metrics.controlInset / 3),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (onBack != null) PageBarAction(RiffetIcons.ArrowLeft, stringResource(Res.string.app_back), onBack)
        Row(
            Modifier.weight(1f)
                .then(if (onTitleClick != null) Modifier.clip(RoundedCornerShape(metrics.controlRadius)).clickable(role = Role.Button, onClick = onTitleClick) else Modifier)
                .padding(vertical = metrics.controlInset / 3),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(metrics.controlInset),
        ) {
            leading?.invoke()
            Column(Modifier.weight(1f)) {
                Text(title, style = type.barTitle, color = colors.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (!subtitle.isNullOrEmpty()) Text(subtitle, style = type.bodySmall, color = subtitleColor ?: colors.fg3,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        actions()
        if (onClose != null) PageBarAction(RiffetIcons.Close, stringResource(Res.string.pickers_close), onClose)
    }
}

/**
 * A block of the panel: an optional group label with an optional figure at its end (`26`, `2 个运行中`),
 * then its rows on one [Group] card.
 */
@Composable
internal fun PaneSection(title: String? = null, figure: String? = null, content: @Composable () -> Unit) {
    if (title != null) {
        val metrics = LocalInterfaceStyle.current.metrics
        GroupTitle(title, action = figure?.let { {
            Text(it, style = LocalRiffetTypography.current.footnote, color = LocalRiffetColors.current.fg3, maxLines = 1,
                modifier = Modifier.padding(end = metrics.rowPadding - metrics.controlInset / 4))
        } })
    }
    Group(content = content)
}

/**
 * The panel's one row, a [GroupRow] whose title stays on one line: a [leading] mark, a title with an
 * optional [subtitle], then at most one of [value], [trailing] or a chevron. [tone] colours the
 * title for an action (accent) or a removal (danger).
 */
@Composable
internal fun PaneRow(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    leading: (@Composable () -> Unit)? = null,
    value: String? = null,
    trailing: (@Composable () -> Unit)? = null,
    chevron: Boolean = false,
    tone: Color? = null,
    enabled: Boolean = true,
    onClick: (() -> Unit)? = null,
) = GroupRow(
    title = title, modifier = modifier, subtitle = subtitle, titleLines = 1, leading = leading, value = value,
    chevron = chevron, trailing = trailing, enabled = enabled, titleColor = tone, onClick = onClick,
)

/** A leading icon for [PaneRow], at the size a settings row draws a plain icon, in the secondary tone unless [tint] says otherwise. */
@Composable
internal fun PaneIcon(icon: ImageVector, tint: Color? = null) {
    Icon(icon, contentDescription = null, tint = tint ?: LocalRiffetColors.current.fg2,
        modifier = Modifier.size(LocalInterfaceStyle.current.metrics.iconSize))
}

/** A leading status mark for [PaneRow]. */
@Composable
internal fun PaneDot(color: Color) {
    Box(Modifier.size(LocalInterfaceStyle.current.metrics.hairlineWidth * 8).clip(RoundedCornerShape(50)).background(color))
}

/**
 * A fact in a panel, laid out as a [GroupRow] with a value: the label in the main tone, the value at
 * the end in the third. [mono] for what is code (a path, a branch); a long path keeps its end.
 */
@Composable
internal fun PaneValueRow(label: String, value: String, mono: Boolean = false, onClick: (() -> Unit)? = null) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val type = LocalRiffetTypography.current
    Row(
        Modifier.fillMaxWidth().then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .heightIn(min = maxOf(metrics.controlHeight, metrics.rowHeight))
            .padding(horizontal = metrics.rowPadding),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(metrics.rowPadding),
    ) {
        Text(label, style = type.body, color = colors.fg, maxLines = 1)
        Text(value, style = if (mono) type.monoSmall else type.body, color = colors.fg3, maxLines = 1,
            overflow = TextOverflow.StartEllipsis.takeIf { mono } ?: TextOverflow.Ellipsis,
            textAlign = TextAlign.End, modifier = Modifier.weight(1f))
    }
}

/** One cell of a [PaneActionBar]. */
internal class PaneAction(
    val icon: ImageVector,
    val label: String,
    val enabled: Boolean = true,
    val onClick: () -> Unit,
)

/**
 * A row of two to four equal cells on a group card, icon over a short label: the panel's
 * destinations (变更, 文件, 终端, 查找) and, in a second bar, its small actions (置顶, 重命名…).
 * One component for both, so the panel has one rhythm. Icons and labels at the page's sizes;
 * labels are one line, so keep them to a word.
 */
@Composable
internal fun PaneActionBar(actions: List<PaneAction>) {
    if (actions.isEmpty()) return
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val surfaces = LocalRiffetSurfaces.current
    val type = LocalRiffetTypography.current
    Row(
        Modifier.fillMaxWidth().padding(horizontal = GroupInset).cardEdge(GroupShape).clip(GroupShape)
            .background(materialContentBackground(surfaces.card)),
    ) {
        actions.take(4).forEach { action ->
            Column(
                Modifier.weight(1f).clickable(enabled = action.enabled, role = Role.Button, onClick = action.onClick)
                    .heightIn(min = metrics.rowHeight * 3 / 2).padding(horizontal = metrics.controlInset / 4, vertical = metrics.controlInset),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(metrics.controlInset / 2, Alignment.CenterVertically),
            ) {
                val tint = if (action.enabled) colors.fg else surfaces.disabledContent
                Icon(action.icon, contentDescription = null, tint = tint, modifier = Modifier.size(metrics.iconSize))
                Text(action.label, style = type.bodySmall, color = tint,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
            }
        }
    }
}

/** Space between a panel's blocks: the page's gap between groups. */
@Composable
internal fun PaneGap() = GroupSpacer()

/** Room for the last block above the gesture bar. */
@Composable
internal fun PaneEnd() = Box(Modifier.width(LocalInterfaceStyle.current.metrics.pageInset).height(LocalInterfaceStyle.current.metrics.sectionGap))
