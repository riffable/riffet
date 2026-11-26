package riffet.ui.design

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.SecondaryScrollableTabRow
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRowDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography

/**
 * Switching between a page's views (Git's 变更 / 历史 / 检查点 / 工作树): Material's secondary tabs,
 * scrollable, so a label is never cut short — Material retires segmented buttons for this, and a
 * connected segment cannot hold four long labels on a phone. A [SegmentedControl] is for a value with
 * two or three short options; the styles that draw view switches as segments do so only for those.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ViewTabs(labels: List<String>, selected: Int, onSelect: (Int) -> Unit, modifier: Modifier = Modifier) {
    val style = LocalInterfaceStyle.current
    val colors = LocalRiffetColors.current
    val type = LocalRiffetTypography.current
    val shortLabels = labels.size <= 3 && labels.all { it.length <= 10 }
    if (style.variants.homeTabs == HomeTabPresentation.SEGMENTED && shortLabels) {
        SegmentedControl(options = labels, selected = selected, onSelect = onSelect,
            modifier = modifier.fillMaxWidth().padding(horizontal = style.metrics.pageInset))
        return
    }
    SecondaryScrollableTabRow(
        selectedTabIndex = selected,
        modifier = modifier.fillMaxWidth(),
        // A tab pads its label by 16dp, the page inset: the first label lines up with the content below.
        edgePadding = 0.dp,
        containerColor = Color.Transparent,
        contentColor = colors.accent,
        indicator = { TabRowDefaults.SecondaryIndicator(Modifier.tabIndicatorOffset(selected), color = LocalRiffetSurfaces.current.primaryAction) },
        // Where tone separates surfaces the row keeps only its indicator: a rule across the page belongs to no card.
        divider = { if (!style.components.surfaces.softLines) TabRowDefaults.SecondaryIndicator(height = style.metrics.hairlineWidth, color = colors.line) },
    ) {
        labels.forEachIndexed { index, label ->
            Tab(
                selected = index == selected,
                onClick = { onSelect(index) },
                selectedContentColor = colors.fg,
                unselectedContentColor = colors.fg3,
                text = { Text(label, style = type.label, maxLines = 1, overflow = TextOverflow.Ellipsis) },
            )
        }
    }
}
