package riffet.ui.design

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import riffet.ui.icons.Icon
import riffet.ui.icons.RiffetIcons
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet.ui.theme.visualWorkActive

/*
 * The three shared states of mobile.md §5: a notice (one fact about the page, in place), an empty
 * state (nothing to show, and what to do about it) and a skeleton (the shape of what is loading).
 * Business code uses these; it does not draw its own banner, empty column or grey blocks.
 */

/** How serious a [Notice] is: its icon and the icon's tone. Text stays in the page's ink. */
internal enum class NoticeKind { INFO, SUCCESS, WARNING, ERROR }

/**
 * One fact the reader needs about the page or the object it shows, in place, on a card (mobile.md
 * §5): an icon in the kind's tone, an optional [title], the [message], then at most one [action].
 * One notice per state: what a card, a row or the top bar already says is not repeated here.
 */
@Composable
internal fun Notice(
    message: String,
    kind: NoticeKind,
    modifier: Modifier = Modifier,
    title: String? = null,
    action: String? = null,
    onAction: (() -> Unit)? = null,
    background: Color = LocalRiffetSurfaces.current.card,
    maxLines: Int = Int.MAX_VALUE,
    onOverflow: ((Boolean) -> Unit)? = null,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val type = LocalRiffetTypography.current
    val (icon, tone) = when (kind) {
        NoticeKind.INFO -> RiffetIcons.Info to colors.fg3
        NoticeKind.SUCCESS -> RiffetIcons.Check to colors.accent
        NoticeKind.WARNING -> RiffetIcons.Warning to colors.warning
        NoticeKind.ERROR -> RiffetIcons.Error to colors.danger
    }
    val actionable = action != null && onAction != null
    Row(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(metrics.groupRadius))
            .background(background)
            .heightIn(min = metrics.controlHeight)
            // With an action, its 48dp touch target sets the height and the row centres on it.
            .padding(start = metrics.rowPadding, end = if (actionable) metrics.controlInset / 2 else metrics.rowPadding,
                top = if (actionable) 0.dp else metrics.controlInset, bottom = if (actionable) 0.dp else metrics.controlInset),
        verticalAlignment = if (actionable) Alignment.CenterVertically else Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(metrics.controlInset),
    ) {
        // The icon sits on the first line of text; the line height is the body-small one.
        Box(Modifier.height(with(LocalDensity.current) { type.bodySmall.lineHeight.toDp() }), contentAlignment = Alignment.Center) {
            Icon(icon, contentDescription = null, tint = tone, modifier = Modifier.size(metrics.smallIconSize))
        }
        Column(Modifier.weight(1f).then(if (actionable) Modifier.padding(vertical = metrics.controlInset) else Modifier)) {
            if (title != null) Text(title, style = type.label, color = colors.fg, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(message, style = type.bodySmall, color = if (title != null) colors.fg2 else colors.fg,
                maxLines = maxLines, overflow = TextOverflow.Ellipsis, onTextLayout = { onOverflow?.invoke(it.hasVisualOverflow) })
        }
        if (actionable) RiffetTextButton(onClick = onAction!!) { Text(action!!) }
    }
}

/**
 * Nothing to show (mobile.md §5): an optional [icon], an optional [title], one sentence, then the
 * next step in [actions] (a [RiffetButton] or two). [fill] centres it in the page's remaining
 * height; off, it sits in a list's place with room above and below. A search with no results is
 * its own case: say what was searched, offer no action.
 */
@Composable
internal fun EmptyState(
    message: String?,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    title: String? = null,
    fill: Boolean = true,
    actions: (@Composable RowScope.() -> Unit)? = null,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val type = LocalRiffetTypography.current
    Column(
        modifier
            .then(if (fill) Modifier.fillMaxSize() else Modifier.fillMaxWidth())
            .padding(horizontal = metrics.pageInset * 2, vertical = metrics.sectionGap * 2),
        verticalArrangement = if (fill) Arrangement.Center else Arrangement.Top,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        if (icon != null) {
            Icon(icon, contentDescription = null, tint = colors.fg3, modifier = Modifier.size(metrics.iconSize * 4 / 3))
            Spacer(Modifier.height(metrics.controlInset))
        }
        if (title != null) {
            Text(title, style = type.headline, color = colors.fg, textAlign = TextAlign.Center)
            Spacer(Modifier.height(metrics.hairlineWidth * 4))
        }
        if (!message.isNullOrBlank()) Text(message, style = type.bodySmall, color = colors.fg3, textAlign = TextAlign.Center)
        if (actions != null) {
            Spacer(Modifier.height(metrics.rowPadding))
            Row(horizontalArrangement = Arrangement.spacedBy(metrics.controlInset), verticalAlignment = Alignment.CenterVertically, content = actions)
        }
    }
}

/**
 * The shape of something loading where it will appear (mobile.md §5): a block in the card's tone
 * that breathes slowly, still under reduced motion. Size it like what it stands for.
 */
@Composable
internal fun SkeletonBlock(modifier: Modifier = Modifier, shape: Shape = RoundedCornerShape(LocalInterfaceStyle.current.metrics.selectionRadius)) {
    val pulse = skeletonPulse()
    Box(modifier.graphicsLayer { alpha = pulse?.value ?: 1f }.clip(shape).background(LocalRiffetColors.current.fg.copy(alpha = 0.08f)))
}

/** [count] list rows loading on one group card: a title line and a shorter second line each. */
@Composable
internal fun SkeletonRows(count: Int = 3, modifier: Modifier = Modifier, subtitle: Boolean = true) {
    val metrics = LocalInterfaceStyle.current.metrics
    val type = LocalRiffetTypography.current
    val density = LocalDensity.current
    val line = with(density) { type.body.fontSize.toDp() }
    val small = with(density) { type.bodySmall.fontSize.toDp() }
    Group(modifier) {
        repeat(count) { index ->
            Column(
                Modifier.fillMaxWidth().heightIn(min = if (subtitle) metrics.rowSubtitleHeight else metrics.rowHeight)
                    .padding(horizontal = metrics.rowPadding, vertical = metrics.rowPadding / 2),
                verticalArrangement = Arrangement.spacedBy(metrics.controlInset / 2, Alignment.CenterVertically),
            ) {
                // Uneven widths, so the rows read as text rather than as bars.
                SkeletonBlock(Modifier.fillMaxWidth(if (index % 2 == 0) 0.62f else 0.48f).height(line))
                if (subtitle) SkeletonBlock(Modifier.fillMaxWidth(if (index % 2 == 0) 0.38f else 0.3f).height(small))
            }
        }
    }
}

/** One breathing alpha for every block on screen; null (still) under reduced motion or off-screen. */
@Composable
private fun skeletonPulse(): State<Float>? {
    if (!visualWorkActive(decorative = true)) return null
    // motion-loop: loading indicator; visualWorkActive(decorative) stops it under reduced motion
    val transition = rememberInfiniteTransition(label = "skeleton")
    // motion-loop: loading indicator
    return transition.animateFloat(0.55f, 1f, infiniteRepeatable(tween(SkeletonPulseMillis), RepeatMode.Reverse), label = "skeleton-alpha")
}

private const val SkeletonPulseMillis = 900
