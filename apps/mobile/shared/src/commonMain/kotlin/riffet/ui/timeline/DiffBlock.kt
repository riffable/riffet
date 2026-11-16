package riffet.ui.timeline

import riffet.ui.design.LocalRiffetSurfaces
import riffet.ui.design.LocalInterfaceStyle
import androidx.compose.ui.semantics.Role
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import riffet.ui.focus.SelectableText
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import org.jetbrains.compose.resources.rememberResourceEnvironment
import org.jetbrains.compose.resources.stringResource
import riffet.core.DiffLine
import riffet.core.DiffLineType
import riffet.core.lineDiff
import riffet_mobile.shared.generated.resources.*

/*
 * Ported from `DiffView` in apps/web/src/app/session/Timeline.tsx.
 *
 * The colours are the four diff roles, used for what they are: `diffAdd` / `diffDel` are line
 * backgrounds, and the `…Strong` pair tints the marker gutter so the change stands out at a
 * glance even on a small screen. The `+n / −n` summary is *text*, so it uses `success` / `danger`,
 * exactly as the web does — a translucent background colour is unreadable as type.
 *
 * `lineDiff` returns null when the two sides are too large to diff cheaply. That is not a failure:
 * it means "here is the file instead of a diff", and the fallback below shows `after` whole.
 */

private val LINE_NUMBER_WIDTH = 32.dp
private val MARKER_WIDTH = 14.dp

@Composable
internal fun DiffBlock(
    path: String?,
    before: String,
    after: String,
    lineOffset: Long,
    trailingLines: Long,
    onOpenFile: (String, Int?) -> Unit,
) {
    val designMetrics = LocalInterfaceStyle.current.metrics
    val colors = TimelineTheme.colors
    val environment = rememberResourceEnvironment()
    val diff = remember(before, after, lineOffset, trailingLines, environment) {
        lineDiff(before, after, 3, lineOffset, trailingLines)
    }
    val shape = RoundedCornerShape(LocalInterfaceStyle.current.controlRadius)
    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .border(designMetrics.hairlineWidth, colors.line, shape),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = designMetrics.controlHeight)
                .background(colors.bgSubtle)
                .padding(start = 10.dp, end = 10.dp),
        ) {
            if (path != null) {
                Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = path,
                        style = TimelineTheme.type.codeSmall,
                        color = colors.fg2,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier
                            .weight(1f, fill = false)
                            .clickable(role = Role.Button) { onOpenFile(path, null) },
                    )
                    CopyTextButton(path, stringResource(Res.string.timeline_copy_path), size = 30.dp)
                    FileDownloadButton(path, size = 30.dp)
                }
            } else {
                Text(
                    text = stringResource(Res.string.timeline_changed_files),
                    style = TimelineTheme.type.label,
                    color = colors.fg3,
                    modifier = Modifier.weight(1f),
                )
            }
            if (diff != null && diff.added > 0) {
                Text("+${diff.added}", style = TimelineTheme.type.codeSmall, color = colors.success)
            }
            if (diff != null && diff.removed > 0) {
                Spacer(Modifier.width(6.dp))
                Text("−${diff.removed}", style = TimelineTheme.type.codeSmall, color = colors.danger)
            }
            if (before.isEmpty()) {
                Spacer(Modifier.width(6.dp))
                Text(stringResource(Res.string.timeline_new_file), style = TimelineTheme.type.caption, color = colors.fg3)
            }
        }
        Box(Modifier.fillMaxWidth().height(designMetrics.hairlineWidth).background(colors.line))
        if (diff == null) {
            CodeBlock(
                text = after,
                language = path?.let(::languageForPath),
                background = colors.bg,
                foreground = colors.fg2,
                maxHeight = 320.dp,
                rounded = false,
            )
        } else {
            // Long lines scroll sideways rather than wrapping: a wrapped diff line loses the
            // column alignment that makes it readable. Every row is as wide as the widest (the
            // web's `min-w-max`), so the add/delete backgrounds run edge to edge. The height is
            // capped like the web's `max-h-80`, with its own bounded scroll.
            val language = path?.let(::languageForPath)
            val codeColors = TimelineTheme.codeColors
            val highlighted = remember(diff, language, colors, codeColors) {
                if (isHighlightable(language)) diff.lines.map { highlightCode(it.text, language, colors, codeColors) } else null
            }
            BoxWithConstraints(Modifier.fillMaxWidth()) {
                val viewport = maxWidth
                Box(
                    Modifier
                        .heightIn(max = 320.dp)
                        .verticalScroll(rememberScrollState())
                        .horizontalScroll(rememberScrollState()),
                ) {
                    // The diff lines are one container rather than one per line, so a hunk can be
                    // selected and copied whole. It sits inside the block's scroll boxes and inside
                    // the tool row, so nothing here touches `LazyColumn` composition. The Column
                    // goes *inside* it: SelectionContainer stacks its children like a Box.
                    SelectableText {
                        Column(
                            Modifier
                                .widthIn(min = viewport)
                                .width(IntrinsicSize.Max)
                                .padding(vertical = 4.dp),
                        ) {
                            diff.lines.forEachIndexed { index, line -> DiffLineRow(line, highlighted?.get(index)) }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun DiffLineRow(line: DiffLine, highlighted: AnnotatedString?) {
    val colors = TimelineTheme.colors
    if (line.type == DiffLineType.GAP) {
        Row(
            Modifier
                .fillMaxWidth()
                .background(colors.bgSubtle)
                .padding(horizontal = 10.dp, vertical = 3.dp),
        ) {
            Text(line.text, style = TimelineTheme.type.caption, color = colors.fg3)
        }
        return
    }
    val background = when (line.type) {
        DiffLineType.ADD -> colors.diffAdd
        DiffLineType.DEL -> colors.diffDel
        else -> Color.Transparent
    }
    val markerBackground = when (line.type) {
        DiffLineType.ADD -> colors.diffAddStrong
        DiffLineType.DEL -> colors.diffDelStrong
        else -> Color.Transparent
    }
    val marker = when (line.type) {
        DiffLineType.ADD -> "+"
        DiffLineType.DEL -> "−"
        else -> " "
    }
    val markerColor = when (line.type) {
        DiffLineType.ADD -> colors.success
        DiffLineType.DEL -> colors.danger
        else -> colors.fg4
    }
    Row(Modifier.fillMaxWidth().background(background)) {
        LineNumber(if (line.type == DiffLineType.ADD) null else line.oldNo)
        LineNumber(if (line.type == DiffLineType.DEL) null else line.newNo)
        Box(Modifier.width(MARKER_WIDTH).background(markerBackground), contentAlignment = Alignment.Center) {
            Text(marker, style = TimelineTheme.type.codeBlock, color = markerColor)
        }
        Text(
            text = highlighted?.takeIf { it.isNotEmpty() } ?: AnnotatedString(line.text.ifEmpty { " " }),
            style = TimelineTheme.type.codeBlock,
            color = colors.fg,
            softWrap = false,
            modifier = Modifier.padding(start = 4.dp, end = 16.dp),
        )
    }
}

@Composable
private fun LineNumber(value: Long?) {
    Text(
        text = value?.toString() ?: "",
        style = TimelineTheme.type.codeBlock,
        color = TimelineTheme.colors.fg4,
        textAlign = TextAlign.End,
        maxLines = 1,
        modifier = Modifier.width(LINE_NUMBER_WIDTH).padding(end = 6.dp),
    )
}
