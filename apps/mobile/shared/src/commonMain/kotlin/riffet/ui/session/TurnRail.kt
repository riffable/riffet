package riffet.ui.session

import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.animation.core.animateFloatAsState
import kotlinx.coroutines.delay
import riffet.ui.design.LocalRiffetSurfaces
import riffet.ui.design.MaterialRole
import riffet.ui.design.floatingShadow
import riffet.ui.design.riffetMaterial
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.pickers.RiffetMenuText
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import riffet.ui.icons.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import org.jetbrains.compose.resources.stringResource
import riffet.core.TimelineItem
import riffet.ui.icons.RiffetIcons
import riffet.ui.pickers.RiffetDropdownMenu
import riffet.ui.pickers.RiffetMenuItem
import riffet.ui.pickers.RiffetMenuLabel
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet.ui.theme.LocalRiffetMotion
import riffet.ui.timeline.StatusDot
import riffet.ui.timeline.TimelineRow
import riffet_mobile.shared.generated.resources.Res
import riffet_mobile.shared.generated.resources.session_history_sync_failed
import riffet_mobile.shared.generated.resources.session_jump_latest
import riffet_mobile.shared.generated.resources.session_jump_latest_unread
import riffet_mobile.shared.generated.resources.session_jump_messages
import riffet_mobile.shared.generated.resources.session_older_failed
import riffet_mobile.shared.generated.resources.session_retry
import riffet_mobile.shared.generated.resources.session_turn_locator
import riffet_mobile.shared.generated.resources.session_turn_user

/*
 * ============================================================================================
 * Turn navigation - `apps/web/src/app/session/TurnRail.tsx`, as a phone affordance
 * ============================================================================================
 *
 * The web's rail is one tick per turn on the right edge of the transcript, with a hover preview of
 * each turn's prompt. A phone has neither the spare width for a permanent strip nor hover, so the
 * same information becomes a small floating pill that opens the list of turns, prompts included.
 *
 * Turns are never re-derived here. [buildTurnTicks] reads the `turnKey` that `buildTimelineRows`
 * already stamped on each row (which comes from `core.timelineTurnKeys`), so this file and the
 * transcript can never disagree about where a turn starts.
 */

/** How long the turn pill stays after the transcript stops moving. */
private const val PILL_LINGER_MS = 1500L

/** One tick: the transcript row index to jump to, and what the turn is. */
internal data class TurnTick(val key: String, val index: Int, val label: String, val running: Boolean)

/** The row a turn's first row is, in order. Rows are already grouped, so this cannot split a turn. */
internal fun buildTurnTicks(
    rows: List<TimelineRow>,
    activeTurns: Set<String>,
    labels: TurnLabels,
): List<TurnTick> {
    val seen = HashSet<String>()
    val ticks = mutableListOf<TurnTick>()
    rows.forEachIndexed { index, row ->
        // A system activity sits inside a turn without being one.
        if (row is TimelineRow.Single && row.item is TimelineItem.Activity) return@forEachIndexed
        val key = row.turnKey
        if (key.isEmpty() || !seen.add(key)) return@forEachIndexed
        ticks.add(
            TurnTick(
                key = key,
                index = index,
                label = turnLabel(row, labels),
                running = key in activeTurns,
            ),
        )
    }
    return ticks
}

/** The localized names a turn falls back to when it has no prompt of its own. */
internal data class TurnLabels(
    val user: String,
    val thought: String,
    val tool: String,
    val plan: String,
    val image: String,
)

private val TimelineRow.turnKey: String
    get() = when (this) {
        is TimelineRow.Process -> turnKey
        is TimelineRow.Single -> turnKey
        is TimelineRow.Trigger -> ""
    }

/** The turn's prompt, or its first structured row when it has no prompt of its own. */
private fun turnLabel(row: TimelineRow, labels: TurnLabels): String = when (row) {
    is TimelineRow.Process -> row.items.firstNotNullOfOrNull { userText(it) }
        ?: row.items.firstOrNull()?.let { kindLabel(it, labels) }
        ?: ""

    is TimelineRow.Single -> userText(row.item) ?: kindLabel(row.item, labels)
    is TimelineRow.Trigger -> row.notices.firstOrNull()?.title.orEmpty()
}

private fun userText(item: TimelineItem): String? =
    (item as? TimelineItem.User)?.text?.let { firstLine(it) }?.takeIf { it.isNotEmpty() }

private fun kindLabel(item: TimelineItem, labels: TurnLabels): String = when (item) {
    is TimelineItem.User -> labels.user
    is TimelineItem.Assistant -> firstLine(item.text)
    is TimelineItem.Thought -> labels.thought
    is TimelineItem.Tool -> labels.tool
    is TimelineItem.Plan -> labels.plan
    is TimelineItem.Image -> labels.image
    is TimelineItem.Status -> firstLine(item.text)
    is TimelineItem.TaskNotification -> item.title
    is TimelineItem.Activity -> item.activity.title
}

private fun firstLine(text: String): String =
    text.split('\n').firstOrNull { it.isNotBlank() }?.trim().orEmpty()

/**
 * The navigator: a small "current / total" pill floating just under the header's right end. It
 * takes no width from the transcript and stays clear of the composer; tapping it opens the turn
 * list (each turn's prompt), scrolled to the turn on screen, and picking one scrolls there.
 *
 * Fewer than two turns is not a long transcript, so nothing renders at all (the web's
 * `turns.length < 2` rule). [onJump] receives the turn's **position** in [ticks].
 */
@Composable
internal fun TurnNavigator(
    ticks: List<TurnTick>,
    activeIndex: Int,
    onJump: (Int) -> Unit,
    modifier: Modifier = Modifier,
    /** The transcript is moving. The pill shows where you are while it does and leaves the text alone at rest. */
    scrolling: Boolean = true,
) {
    if (ticks.size < 2) return
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    var open by remember { mutableStateOf(false) }
    val menuScroll = rememberScrollState()
    val density = LocalDensity.current
    LaunchedEffect(open) {
        if (open) menuScroll.scrollTo(with(density) { (MENU_ROW * (activeIndex - 2).coerceAtLeast(0)).roundToPx() })
    }
    // Like a scroll indicator: there while the transcript moves or its list is open, gone a moment after.
    var shown by remember { mutableStateOf(scrolling) }
    LaunchedEffect(scrolling, open) {
        if (scrolling || open) shown = true else {
            delay(PILL_LINGER_MS)
            shown = false
        }
    }
    val presence = animateFloatAsState(if (shown) 1f else 0f, LocalRiffetMotion.current.effects(), label = "turn-pill")
    val pill = RoundedCornerShape(LocalInterfaceStyle.current.selectionRadius)
    // Tabular figures, so the counter does not shift sideways as the turn changes.
    val figures = remember(typography) { typography.label.copy(fontFeatureSettings = "tnum") }
    Box(modifier) {
        // The pill is only 28dp tall; the interactive size around it is the touch target.
        Box(Modifier.padding(horizontal = 6.dp).minimumInteractiveComponentSize()
            .graphicsLayer { alpha = presence.value; translationY = (presence.value - 1f) * 6.dp.toPx() }) {
            Row(
                modifier = Modifier
                    .height(28.dp)
                    .floatingShadow(pill)
                    .clip(pill)
                    .riffetMaterial(MaterialRole.CONTROL, pill, LocalRiffetSurfaces.current.floating)
                    .clickable(enabled = shown, role = Role.Button, onClickLabel = stringResource(Res.string.session_turn_locator)) { open = true }
                    .padding(start = 12.dp, end = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = "${activeIndex + 1}",
                    style = figures,
                    color = colors.accent,
                )
                Text(
                    text = " / ${ticks.size}",
                    style = figures,
                    color = colors.fg3,
                )
                Spacer(Modifier.width(4.dp))
                Icon(RiffetIcons.ChevronDown, contentDescription = null, tint = colors.fg3, modifier = Modifier.size(16.dp))
            }
        }
        RiffetDropdownMenu(
            expanded = open,
            onDismissRequest = { open = false },
            modifier = Modifier.width(280.dp).heightIn(max = 380.dp),
            scrollState = menuScroll,
        ) {
            RiffetMenuLabel(stringResource(Res.string.session_jump_messages))
            ticks.forEachIndexed { position, tick ->
                val current = position == activeIndex
                RiffetMenuItem(
                    onClick = {
                        open = false
                        onJump(position)
                    },
                    highlighted = current,
                ) {
                    Text(
                        text = "${position + 1}",
                        style = typography.monoSmall,
                        color = colors.fg4,
                        modifier = Modifier.width(26.dp),
                    )
                    if (tick.running) {
                        StatusDot(color = colors.accent, size = 6.dp)
                        Spacer(Modifier.width(8.dp))
                    }
                    Text(
                        text = tick.label.ifEmpty { stringResource(Res.string.session_turn_user) },
                        style = RiffetMenuText,
                        color = if (current) colors.fg else colors.fg2,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }
    }
}

private val MENU_ROW = 44.dp

/**
 * 回到最新: the transcript stopped following its tail ([riffet.ui.timeline.TimelineFollow]); a dot
 * when rows arrived since. The web's 回到底部 and iOS's arrow button. It scales in and out at its spot.
 */
@Composable
internal fun JumpToLatest(visible: Boolean, unread: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val motion = LocalRiffetMotion.current
    AnimatedVisibility(visible = visible, modifier = modifier, enter = motion.popIn(), exit = motion.popOut()) {
        JumpToLatestButton(unread, onClick)
    }
}

@Composable
private fun JumpToLatestButton(unread: Boolean, onClick: () -> Unit) {
    val designMetrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val label = if (unread) stringResource(Res.string.session_jump_latest_unread) else stringResource(Res.string.session_jump_latest)
    // 48dp to touch, 40dp to see.
    Box(
        modifier = Modifier
            .size(designMetrics.controlHeight)
            .clip(CircleShape)
            .clickable(onClickLabel = label, role = Role.Button, onClick = onClick)
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        Box(
            modifier = Modifier
                .size(40.dp)
                .floatingShadow(CircleShape)
                .clip(CircleShape)
                .riffetMaterial(MaterialRole.CONTROL, CircleShape, LocalRiffetSurfaces.current.floating),
            contentAlignment = Alignment.Center,
        ) {
            Icon(RiffetIcons.ArrowDown, contentDescription = null, tint = colors.fg2, modifier = Modifier.size(designMetrics.buttonIconSize))
        }
        if (unread) Box(Modifier.align(Alignment.TopEnd).padding(top = 6.dp, end = 6.dp)) { StatusDot(color = colors.accent, size = 8.dp) }
    }
}

/**
 * A failed older page (the store has already retried it), or a failed history re-sync from the
 * device copy: a pill over the top of the transcript, in the navigator's style. Progress is not
 * shown here; the top bar's connection caption says it is syncing. It is not a row, so the turn
 * ticks and the tail-follow keep their indexes.
 */
@Composable
internal fun HistoryPill(
    error: String?,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
    syncing: Boolean = false,
) {
    if (error == null) return
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val pill = RoundedCornerShape(LocalInterfaceStyle.current.selectionRadius)
    Row(
        modifier = modifier
            .height(28.dp)
            .floatingShadow(pill)
            .clip(pill)
            .riffetMaterial(MaterialRole.CONTROL, pill, LocalRiffetSurfaces.current.floating)
            .clickable(onClickLabel = stringResource(Res.string.session_retry), role = Role.Button, onClick = onRetry)
            .padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(RiffetIcons.Refresh, contentDescription = null, tint = colors.danger, modifier = Modifier.size(12.dp))
        Spacer(Modifier.width(6.dp))
        Text(
            text = stringResource(if (syncing) Res.string.session_history_sync_failed else Res.string.session_older_failed),
            style = typography.caption,
            color = colors.danger,
        )
    }
}
