package riffet.ui.timeline

import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.theme.LocalRiffetMotion
import androidx.compose.ui.semantics.Role
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * The transcript's one collapsible row: a single-line header that expands into detail.
 *
 * It is the shape the web uses for a tool call, a background job and a task notification, and it
 * is where the layout rule from the README is enforced: **the header sits on the text column**, and
 * the expanded body is the only thing in the transcript that is indented, because it is the only
 * genuinely nested detail. There is no vertical rule around a turn's process block; the rule here belongs to a *second* level of nesting.
 *
 * A thrown-away `Row` of 36dp is the whole touch target, so a tap anywhere on the row toggles it
 * rather than only the glyph.
 */
@Composable
internal fun TimelineDisclosure(
    open: Boolean,
    onToggle: () -> Unit,
    title: @Composable () -> Unit,
    modifier: Modifier = Modifier,
    expandable: Boolean = true,
    /** False when the caller draws the body itself, below the row: the chevron still turns, nothing nests. */
    hasBody: Boolean = true,
    danger: Boolean = false,
    leading: (@Composable () -> Unit)? = null,
    detail: String? = null,
    /** Content that belongs with the title (a tool's diff counts): after the detail, ahead of the chevron. The row's state stays in [status], at the right edge. */
    inline: (@Composable () -> Unit)? = null,
    status: (@Composable () -> Unit)? = null,
    // Last, so every call site can pass the body as a trailing lambda.
    content: @Composable ColumnScope.() -> Unit,
) {
    val motion = LocalRiffetMotion.current
    val colors = TimelineTheme.colors
    Column(modifier.fillMaxWidth()) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = TimelineRhythm.toolRowHeight)
                .clip(RoundedCornerShape(LocalInterfaceStyle.current.rowRadius))
                .then(if (expandable) Modifier.clickable(role = Role.Button, onClick = onToggle) else Modifier),
        ) {
            if (leading != null) {
                Box(Modifier.size(16.dp), contentAlignment = Alignment.Center) { leading() }
                Spacer(Modifier.width(8.dp))
            }
            // Web gives the title up to 70% and lets the detail flex. A phone row is roughly a
            // quarter as wide, so the title is capped instead: same intent, bounded result.
            // The chevron follows the content — title, detail, inline counts — as the Mac row's
            // hover chevron does; only the row's state keeps the right edge (the web's `ml-auto`).
            @Composable
            fun trail() {
                if (inline != null) {
                    Spacer(Modifier.width(8.dp))
                    inline()
                }
                if (expandable) {
                    Spacer(Modifier.width(6.dp))
                    Chevron(open)
                }
            }
            when {
                detail != null -> {
                    Box(Modifier.widthIn(max = 200.dp)) { title() }
                    Spacer(Modifier.width(8.dp))
                    Text(
                        text = pathText(detail, dir = colors.fg4, name = colors.fg3),
                        style = TimelineTheme.type.codeSmall,
                        color = colors.fg3,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    trail()
                }
                // Inline counts are measured first and never wrap (mobile.md §1.1): the title
                // shrinks to its text and truncates instead, and the counts sit right after it.
                inline != null -> Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.weight(1f, fill = false)) { title() }
                    trail()
                }
                else -> {
                    Box(Modifier.weight(1f)) { title() }
                    trail()
                }
            }
            if (status != null) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    modifier = Modifier.padding(start = 8.dp),
                ) {
                    status()
                }
            }
        }
        AnimatedVisibility(
            visible = open && hasBody,
            // Anchored at the top: the web's Collapse grows downward from the header row. The detail
            // is unmounted only once the shrink has finished, not at the tap.
            enter = motion.expandIn(),
            exit = motion.collapseOut(),
        ) {
            NestedDetail(danger = danger, content = content)
        }
    }
}

/**
 * A second-level body: the web's `ml-[7px] edge-l pl-4` — a hairline under the centre of the row's
 * 16dp icon, and the content a full 16dp to its right, so the rule never touches a code block's
 * own border.
 *
 * The rule is painted with `drawBehind` rather than laid out as a sibling box. A sibling would need
 * `Modifier.height(IntrinsicSize.Min)` to match the content's height, and intrinsic measurement
 * through the horizontally scrollable diff rows below is exactly the kind of thing that works on
 * one Compose version and throws on the next. Painting has no such coupling.
 */
@Composable
internal fun NestedDetail(
    danger: Boolean = false,
    /** Between the body's blocks; a tool run's rows sit flush, as they do outside it. */
    spacing: Dp = TimelineRhythm.block,
    content: @Composable ColumnScope.() -> Unit,
) {
    val rule = if (danger) TimelineTheme.colors.dangerSoft else TimelineTheme.colors.line
    Column(
        verticalArrangement = Arrangement.spacedBy(spacing),
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 7.dp, top = 2.dp, bottom = 6.dp)
            .drawBehind {
                drawRect(
                    color = rule,
                    topLeft = Offset.Zero,
                    size = Size(width = 1.dp.toPx(), height = size.height),
                )
            }
            .padding(start = 16.dp, top = 2.dp),
    ) {
        content()
    }
}

/** A path with its directories a step quieter than the file name. */
internal fun pathText(path: String, dir: Color, name: Color): AnnotatedString = buildAnnotatedString {
    val cut = path.trimEnd('/').lastIndexOf('/') + 1
    withStyle(SpanStyle(color = dir)) { append(path, 0, cut) }
    withStyle(SpanStyle(color = name)) { append(path, cut, path.length) }
}
