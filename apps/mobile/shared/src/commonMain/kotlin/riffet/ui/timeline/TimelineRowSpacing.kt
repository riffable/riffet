package riffet.ui.timeline

import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import riffet.core.TimelineItem

private fun TimelineRow.lastItem(): TimelineItem? = when (this) {
    is TimelineRow.Process -> items.lastOrNull()
    is TimelineRow.Single -> item
    is TimelineRow.Trigger -> notices.lastOrNull()
}

/**
 * The gap above [row], from the same two numbers for the whole transcript.
 *
 * The web also widened the gap around a prompt (40px before it, 24px after). On a phone that is
 * half a screen of dead space per turn, and the README's rule is that spacing is decided by a
 * single rule — so a prompt gets 16dp like everything else, and only the compact pair is tighter.
 */
internal fun rowGap(previous: TimelineRow?, row: TimelineRow): Dp {
    if (previous == null) return 0.dp
    val previousItem = previous.lastItem()
    val item = row.lastItem()
    return if (previousItem != null && item != null && isCompactItem(previousItem) && isCompactItem(item)) {
        TimelineRhythm.compact
    } else {
        TimelineRhythm.row
    }
}
