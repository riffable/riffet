package riffet.ui.downloads

import riffet.ui.design.LocalInterfaceStyle
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.border
import androidx.compose.ui.unit.sp
import riffet.ui.design.surfaces
import riffet.ui.app.pageColor
import riffet.ui.app.cardColor
import riffet.ui.app.pageBackground
import androidx.compose.ui.semantics.Role
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import riffet.ui.theme.LocalRiffetMotion
import riffet.ui.theme.LocalRiffetPageMotion
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import riffet.ui.design.ConfirmDialog
import androidx.compose.material3.HorizontalDivider
import riffet.ui.icons.Icon
import riffet.ui.design.RiffetIconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import riffet.ui.design.RiffetTextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.dp
import riffet.shared.DownloadCenter
import riffet.shared.DownloadItem
import riffet.shared.DownloadState
import riffet.shared.RiffetApi
import riffet.shared.downloadPercent
import riffet.shared.openDownload
import riffet.shared.downloadMimeType
import riffet.shared.APK_MIME_TYPE
import riffet.shared.INTERRUPTED_DOWNLOAD_ERROR
import riffet.ui.files.formatBytes
import riffet.ui.app.PageTopBar
import riffet.ui.app.LocalRiffetSnackbar
import riffet.ui.app.SnackbarNotice
import riffet.ui.icons.RiffetIcons
import riffet.ui.pickers.RiffetDropdownMenu
import riffet.ui.pickers.RiffetMenuItem
import riffet.ui.settings.SettingsNoticeKind
import riffet.ui.settings.SettingsMessageBanner
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet.ui.timeline.formatDateTime
import riffet.ui.timeline.platformUtcOffsetMillis
import org.jetbrains.compose.resources.stringResource
import riffet_mobile.shared.generated.resources.*

/**
 * Every download of this app: the running ones with their progress and a cancel, the finished ones
 * to open, retry, delete or clear. Opened from the sidebar's footer and from the notice a download
 * shows when it starts or ends.
 */
@Composable
fun DownloadsScreen(
    api: RiffetApi?,
    projectName: (String) -> String?,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    center: DownloadCenter = DownloadCenter.shared,
) {
    val motion = LocalRiffetMotion.current
    val pageMotion = LocalRiffetPageMotion.current
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val items by center.items.collectAsState()
    var message by remember { mutableStateOf<String?>(null) }
    var clearingHistory by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf<DownloadItem?>(null) }
    val openFailedMessage = stringResource(Res.string.downloads_open_failed)

    SnackbarNotice(message) { shown -> if (message == shown) message = null }

    riffet.ui.app.RiffetPageScaffold(modifier = modifier, topBar = {
        PageTopBar(title = stringResource(Res.string.downloads_title), onBack = onBack) {
            if (items.any { it.state != DownloadState.RUNNING }) {
                RiffetTextButton(onClick = { clearingHistory = true }) {
                    Text(stringResource(Res.string.downloads_clear_history), style = typography.label, color = colors.accent)
                }
            }
        }

        if (LocalRiffetSnackbar.current == null) {
            message?.let { text ->
                Box(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
                    SettingsMessageBanner(text, SettingsNoticeKind.ERROR)
                }
            }
        }

        if (items.isNotEmpty()) DownloadsSummary(items)
    }) { chromeInsets ->
        // Empty and list are two kinds of page; the list keeps its last rows while it fades out.
        val shown = remember { Held(items) }
        if (items.isNotEmpty()) shown.value = items
        AnimatedContent(
            targetState = items.isEmpty(),
            modifier = Modifier.fillMaxSize(),
            transitionSpec = { pageMotion.transition() },
            label = "downloads-surface",
        ) { empty ->
            if (empty) {
                EmptyDownloads(Modifier.fillMaxSize().padding(chromeInsets))
            } else {
                Column(Modifier.fillMaxSize()) {
                    val entries = shown.value
                    val runningLabel = stringResource(Res.string.downloads_group_running)
                    val historyLabel = stringResource(Res.string.downloads_group_history)
                    val groups = remember(entries, runningLabel, historyLabel) {
                        listOf(
                            runningLabel to entries.filter { it.state == DownloadState.RUNNING },
                            historyLabel to entries.filter { it.state != DownloadState.RUNNING },
                        ).filter { it.second.isNotEmpty() }
                    }
                    LazyColumn(
                        modifier = Modifier.weight(1f).fillMaxWidth(),
                        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = chromeInsets.calculateTopPadding(), bottom = chromeInsets.calculateBottomPadding() + 24.dp),
                    ) {
                        groups.forEach { (label, rows) ->
                            item(key = "group:$label", contentType = "group") {
                                Text("$label · ${rows.size}", style = LocalRiffetTypography.current.caption,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier.animateItem(fadeInSpec = motion.effects(), placementSpec = motion.spatial(),
                                        fadeOutSpec = motion.effects()).padding(start = 4.dp, top = 16.dp, bottom = 8.dp))
                            }
                            itemsIndexed(rows, key = { _, item -> item.id }, contentType = { _, _ -> "download" }) { index, item ->
                                // A row that moves between groups changes its corners; they glide rather than snap.
                                val top by animateDpAsState(if (index == 0) LocalInterfaceStyle.current.groupRadius else 0.dp, motion.spatial(), label = "download-top-corner")
                                val bottom by animateDpAsState(if (index == rows.lastIndex) LocalInterfaceStyle.current.groupRadius else 0.dp, motion.spatial(), label = "download-bottom-corner")
                                val topRadius = top.coerceAtLeast(0.dp)
                                val bottomRadius = bottom.coerceAtLeast(0.dp)
                                Column(Modifier.animateItem(fadeInSpec = motion.effects(), placementSpec = motion.spatial(),
                                    fadeOutSpec = motion.effects()).fillMaxWidth().clip(RoundedCornerShape(topStart = topRadius, topEnd = topRadius,
                                    bottomStart = bottomRadius, bottomEnd = bottomRadius)).background(cardColor())) {
                                    DownloadRow(
                                        item = item,
                                        projectName = projectName(item.projectId),
                                        canRetry = api != null,
                                        onOpen = {
                                            if (!openDownload(item)) message = openFailedMessage
                                        },
                                        onCancel = { center.cancel(item.id) },
                                        onRetry = { api?.let { center.retry(it, item) } },
                                        onRemove = { center.remove(item.id) },
                                        onDelete = { deleting = item },
                                    )
                                    if (index < rows.lastIndex) {
                                        HorizontalDivider(modifier = Modifier.padding(start = 56.dp),
                                            color = MaterialTheme.colorScheme.outlineVariant)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    deleting?.takeIf { riffet.ui.app.LocalPageActive.current }?.let { item ->
        ConfirmDialog(
            title = stringResource(Res.string.confirm_delete_file_title, if (item.name.isBlank()) stringResource(Res.string.downloads_unnamed_file) else item.name),
            message = stringResource(Res.string.confirm_delete_file_message),
            confirmLabel = stringResource(Res.string.downloads_delete),
            danger = true,
            onConfirm = {
                center.deleteFile(item)
                deleting = null
            },
            onDismiss = { deleting = null },
        )
    }
    if (clearingHistory) {
        ConfirmDialog(
            title = stringResource(Res.string.confirm_clear_history_title),
            message = stringResource(Res.string.confirm_clear_history_message),
            confirmLabel = stringResource(Res.string.downloads_clear_history),
            danger = true,
            onConfirm = { center.clearFinished(); clearingHistory = false },
            onDismiss = { clearingHistory = false },
        )
    }
}

@Composable
private fun EmptyDownloads(modifier: Modifier) {
    riffet.ui.design.EmptyState(stringResource(Res.string.downloads_empty), modifier, icon = RiffetIcons.Download)
}

/**
 * The line above the list: how many rows there are, how many are running, and where the files land.
 * It is a page subheader rather than an item, so the list below scrolls under a fixed tally.
 */
@Composable
private fun DownloadsSummary(items: List<DownloadItem>) {
    val scheme = MaterialTheme.colorScheme
    val typography = LocalRiffetTypography.current
    val running = items.count { it.state == DownloadState.RUNNING }
    val summary = stringResource(Res.string.downloads_summary, items.size) +
        if (running > 0) " · " + stringResource(Res.string.downloads_summary_running, running) else ""
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(summary, style = typography.label, color = scheme.onSurfaceVariant, maxLines = 1,
            overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        Spacer(Modifier.width(12.dp))
        Icon(RiffetIcons.Folder, contentDescription = null, tint = scheme.onSurfaceVariant, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(4.dp))
        // A filesystem location under the user's home; the persisted prefix is the system
        // Downloads folder's name, shown in the current language.
        Text(stringResource(Res.string.downloads_location_riffet), style = typography.caption, color = scheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** Material list items and Cupertino file rows share download state and actions. */
@Composable
private fun DownloadRow(
    item: DownloadItem,
    projectName: String?,
    canRetry: Boolean,
    onOpen: () -> Unit,
    onCancel: () -> Unit,
    onRetry: () -> Unit,
    onRemove: () -> Unit,
    onDelete: () -> Unit,
) {
    val designMetrics = LocalInterfaceStyle.current.metrics
    val motion = LocalRiffetMotion.current
    val scheme = MaterialTheme.colorScheme
    val colors = LocalRiffetColors.current
    val grouped = LocalInterfaceStyle.current.components.lists.grouped
    val source = remember { MutableInteractionSource() }
    val focused by source.collectIsFocusedAsState()
    val typography = LocalRiffetTypography.current
    val saved = item.state == DownloadState.SAVED
    val openLabel = if (downloadMimeType(item.name, item.mimeType) == APK_MIME_TYPE) stringResource(Res.string.downloads_install) else stringResource(Res.string.downloads_open)
    val icon = when (item.state) {
        DownloadState.RUNNING -> RiffetIcons.Download
        DownloadState.SAVED -> RiffetIcons.FileText
        DownloadState.FAILED -> RiffetIcons.CircleAlert
        DownloadState.CANCELLED -> RiffetIcons.Close
    }
    val statusColor = if (item.state == DownloadState.FAILED) scheme.error else scheme.onSurfaceVariant
    val card = cardColor()
    val containerColor by animateColorAsState(
        targetValue = if (!grouped && item.state == DownloadState.RUNNING) surfaces.rowSelected else card,
        animationSpec = motion.effects(),
        label = "download-container",
    )
    // The tint is drawn by the column, under the ListItem, so a tap's ripple shows over it.
    Column(Modifier.drawBehind { drawRect(containerColor) }) {
        if (grouped) {
            val rowAction = when {
                saved -> onOpen
                item.state == DownloadState.FAILED && canRetry -> onRetry
                else -> null
            }
            Row(
                Modifier.fillMaxWidth()
                    .then(if (focused) Modifier.border(designMetrics.focusWidth, surfaces.focus) else Modifier)
                    .then(if (rowAction != null) Modifier.clickable(
                        interactionSource = source, indication = LocalIndication.current,
                        role = Role.Button,
                        onClickLabel = if (saved) openLabel else stringResource(Res.string.downloads_retry),
                        onClick = rowAction,
                    ) else Modifier)
                    .padding(start = 16.dp, end = 8.dp, top = 10.dp, bottom = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Icon(icon, contentDescription = null, tint = if (item.state == DownloadState.RUNNING) colors.accent else statusColor,
                    modifier = Modifier.size(28.dp))
                Column(Modifier.weight(1f)) {
                    Text(if (item.name.isBlank()) stringResource(Res.string.downloads_unnamed_file) else item.name,
                        style = typography.body, color = colors.fg,
                        maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text(statusLine(item), style = typography.caption, color = statusColor, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    val meta = listOfNotNull(projectName, item.path).joinToString(" · ")
                    if (meta.isNotEmpty()) Text(meta, style = typography.monoSmall, color = colors.fg3,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                if (item.state == DownloadState.RUNNING) RiffetIconButton(onClick = onCancel) {
                    Icon(RiffetIcons.Close, stringResource(Res.string.downloads_cancel_download), Modifier.size(designMetrics.buttonIconSize), tint = colors.fg3)
                } else DownloadMenu(saved, openLabel, canRetry, onOpen, onRetry, onRemove, onDelete)
            }
        } else ListItem(
            colors = ListItemDefaults.colors(containerColor = Color.Transparent),
            modifier = when {
                saved -> Modifier.clickable(role = Role.Button, onClickLabel = openLabel, onClick = onOpen)
                // A failed download's one remedy is the ⋯ menu's 重新下载, so the row is that action.
                item.state == DownloadState.FAILED && canRetry ->
                    Modifier.clickable(role = Role.Button, onClickLabel = stringResource(Res.string.downloads_retry), onClick = onRetry)
                else -> Modifier
            },
            leadingContent = {
                Box(Modifier.width(24.dp).height(48.dp), contentAlignment = Alignment.Center) {
                    Icon(icon, contentDescription = null,
                        tint = if (item.state == DownloadState.RUNNING) scheme.primary else statusColor,
                        modifier = Modifier.size(designMetrics.iconSize))
                }
            },
            headlineContent = {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(if (item.name.isBlank()) stringResource(Res.string.downloads_unnamed_file) else item.name, style = LocalRiffetTypography.current.body, color = scheme.onSurface,
                        maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    if (item.state == DownloadState.RUNNING) {
                        RiffetIconButton(onClick = onCancel) {
                            Icon(RiffetIcons.Close, contentDescription = stringResource(Res.string.downloads_cancel_download), modifier = Modifier.size(designMetrics.iconSize))
                        }
                    } else {
                        DownloadMenu(saved, openLabel, canRetry, onOpen, onRetry, onRemove, onDelete)
                    }
                }
            },
            supportingContent = {
                Column(Modifier.fillMaxWidth()) {
                    Text(statusLine(item), style = LocalRiffetTypography.current.bodySmall, color = statusColor,
                        maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.fillMaxWidth())
                    val meta = listOfNotNull(projectName, item.path).joinToString(" · ")
                    if (meta.isNotEmpty()) {
                        Spacer(Modifier.height(4.dp))
                        Text(meta, style = typography.monoSmall, color = scheme.onSurfaceVariant, maxLines = 1,
                            overflow = TextOverflow.Ellipsis, modifier = Modifier.fillMaxWidth())
                    }
                }
            },
        )
        AnimatedVisibility(visible = item.state == DownloadState.RUNNING, enter = motion.expandIn(), exit = motion.collapseOut()) {
            Box(Modifier.fillMaxWidth().padding(start = 56.dp, end = 16.dp, bottom = if (!grouped) 16.dp else 12.dp)) {
                DownloadProgress(item)
            }
        }
    }
}

/** Progress and percentage share a line aligned with the download's text. */
@Composable
private fun DownloadProgress(item: DownloadItem) {
    val motion = LocalRiffetMotion.current
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val percent = downloadPercent(item.received, item.total)
    Row(verticalAlignment = Alignment.CenterVertically) {
        val bar = Modifier.weight(1f).height(4.dp).clip(CircleShape)
        if (percent == null) {
            LinearProgressIndicator(modifier = bar, color = colors.accent, trackColor = pageColor())
        } else {
            // Throttled server updates arrive as whole percent steps; gliding between them keeps the
            // bar from jumping while the reader watches it.
            val progress by animateFloatAsState(
                targetValue = percent / 100f,
                animationSpec = motion.spatial(),
                label = "download-progress",
            )
            LinearProgressIndicator(
                progress = { progress },
                modifier = bar,
                color = colors.accent,
                trackColor = pageColor(),
                drawStopIndicator = {},
            )
            Spacer(Modifier.width(10.dp))
            Text(
                text = "$percent%",
                style = typography.label,
                color = colors.accent,
                textAlign = TextAlign.End,
                maxLines = 1,
                modifier = Modifier.widthIn(min = 40.dp),
            )
        }
    }
}

@Composable
private fun DownloadMenu(
    saved: Boolean,
    openLabel: String,
    canRetry: Boolean,
    onOpen: () -> Unit,
    onRetry: () -> Unit,
    onRemove: () -> Unit,
    onDelete: () -> Unit,
) {
    val designMetrics = LocalInterfaceStyle.current.metrics
    var open by remember { mutableStateOf(false) }
    Box {
        RiffetIconButton(onClick = { open = true }) {
            Icon(RiffetIcons.Ellipsis, contentDescription = stringResource(Res.string.downloads_more), modifier = Modifier.size(designMetrics.iconSize))
        }
        RiffetDropdownMenu(
            expanded = open,
            onDismissRequest = { open = false },
            offset = DpOffset(0.dp, (-4).dp),
            modifier = Modifier.width(176.dp),
        ) {
            if (saved) RiffetMenuItem(openLabel, { open = false; onOpen() }, icon = RiffetIcons.ExternalLink)
            if (!saved && canRetry) RiffetMenuItem(stringResource(Res.string.downloads_retry), { open = false; onRetry() }, icon = RiffetIcons.Refresh)
            RiffetMenuItem(stringResource(Res.string.downloads_remove), { open = false; onRemove() }, icon = RiffetIcons.Close)
            if (saved) RiffetMenuItem(stringResource(Res.string.downloads_delete_file), { open = false; onDelete() }, icon = RiffetIcons.Trash, danger = true)
        }
    }
}

@Composable
private fun statusLine(item: DownloadItem): String = when (item.state) {
    DownloadState.RUNNING -> {
        // The percentage is drawn beside the bar; this line carries the bytes.
        val size = item.total?.let { "${formatBytes(item.received)} / ${formatBytes(it)}" }
        size ?: listOfNotNull(stringResource(Res.string.downloads_downloading), formatBytes(item.received).takeIf { item.received > 0 }).joinToString(" · ")
    }
    DownloadState.SAVED -> listOfNotNull(
        stringResource(Res.string.downloads_saved),
        localizedDownloadError(item.error),
        item.total?.let(::formatBytes),
        item.finishedAt?.let { formatDateTime(it, platformUtcOffsetMillis(it)) },
        item.location?.let { displayDownloadLocation(it) },
    ).joinToString(" · ")
    DownloadState.FAILED -> stringResource(
        Res.string.downloads_failed,
        localizedDownloadError(item.error) ?: stringResource(Res.string.downloads_unknown_error),
    )
    DownloadState.CANCELLED -> stringResource(Res.string.downloads_cancelled)
}

/** The persisted location uses the device's Downloads folder name; show that prefix in the UI language. */
@Composable
private fun displayDownloadLocation(location: String): String {
    val root = stringResource(Res.string.downloads_location_root)
    return if (location == SOURCE_DOWNLOAD_ROOT || location.startsWith("$SOURCE_DOWNLOAD_ROOT/")) {
        root + location.removePrefix(SOURCE_DOWNLOAD_ROOT)
    } else {
        location
    }
}

/**
 * Errors are shown as they were recorded, except the stable interrupted marker (and the Chinese
 * text older builds stored before the marker existed), which reads in the current language.
 */
@Composable
private fun localizedDownloadError(error: String?): String? = when (error) {
    null -> null
    INTERRUPTED_DOWNLOAD_ERROR, LEGACY_INTERRUPTED_DOWNLOAD_ERROR -> stringResource(Res.string.downloads_interrupted)
    else -> error
}

/** The Chinese Downloads folder name in locales whose filesystem keeps it. */
private const val SOURCE_DOWNLOAD_ROOT = "下载"
private const val LEGACY_INTERRUPTED_DOWNLOAD_ERROR = "下载被中断"

/** A value kept by plain reference, so a fading page can hold what it last showed. */
private class Held<T>(var value: T)
