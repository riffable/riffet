package riffet.ui.home

import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.settings.SettingsNoticeKind
import androidx.compose.ui.semantics.Role
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import riffet.ui.design.RiffetProgressIndicator as CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import riffet.ui.icons.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.getString
import org.jetbrains.compose.resources.stringResource
import riffet.contracts.BrowseResult
import riffet.shared.RiffetApi
import riffet.ui.favorites.FavoriteToggle
import riffet.ui.favorites.FolderFavoriteChips
import riffet.ui.favorites.rememberFolderFavorites
import riffet.ui.icons.RiffetIcons
import riffet.ui.pickers.AnimatedSheetNotice
import riffet.ui.pickers.OptionRow
import riffet.ui.pickers.PickerOverlay
import riffet.ui.settings.SettingsSwitch
import riffet.ui.theme.LocalRiffetMotion
import riffet.ui.theme.LocalRiffetPageMotion
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet.shared.browse
import riffet_mobile.shared.generated.resources.Res
import riffet_mobile.shared.generated.resources.session_cannot_read_directory
import riffet_mobile.shared.generated.resources.session_choose_directory_title
import riffet_mobile.shared.generated.resources.session_empty_directory
import riffet_mobile.shared.generated.resources.session_home_directory
import riffet_mobile.shared.generated.resources.session_loading
import riffet_mobile.shared.generated.resources.session_parent_directory
import riffet_mobile.shared.generated.resources.session_refresh
import riffet_mobile.shared.generated.resources.session_show_hidden_files
import riffet_mobile.shared.generated.resources.session_use_directory
import riffet_mobile.shared.generated.resources.session_using_directory

/**
 * The phone's directory picker: `apps/web/src/app/DirectoryPicker.tsx`, as a sheet.
 *
 * It browses the filesystem of the machine running the server — the only machine whose directories
 * matter, since a session reads and writes there. Every listing comes from `POST /api/browse`, which
 * also reports the host's home and the current path's parent, so this sheet never has to guess at
 * either; that is what the helpers in `DirectoryPaths.kt` consume.
 *
 * Choosing a directory does not create anything on its own: the caller binds it with
 * `SessionStore.openDirectory` (idempotent per canonical path) and only then switches to it, so
 * "use this directory" means the same thing here as it does on the web.
 *
 * @param initialPath where to open the sheet; the current project's directory on the home screen.
 * @param busy the caller is binding the chosen directory; the sheet stays open and disables its
 *   action so a second tap cannot start a second bind.
 * @param error the caller's own failure (a refused or vanished directory), shown without losing the
 *   listing the reader is standing in.
 */
@Composable
internal fun DirectoryPickerSheet(
    api: RiffetApi,
    initialPath: String?,
    busy: Boolean,
    error: String?,
    onDismiss: () -> Unit,
    onPick: (String) -> Unit,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val motion = LocalRiffetMotion.current
    val pageMotion = LocalRiffetPageMotion.current
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val scope = rememberCoroutineScope()
    var result by remember { mutableStateOf<BrowseResult?>(null) }
    var loading by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<String?>(null) }
    var showHidden by remember { mutableStateOf(false) }
    // Taps can outrun the server; only the newest request may write, or a slow earlier listing
    // would land on top of the directory the reader has already moved into.
    var request by remember { mutableStateOf(0) }
    val favorites = rememberFolderFavorites(api)

    fun load(path: String?) {
        val token = ++request
        scope.launch {
            loading = true
            failure = null
            try {
                val next = api.browse(path)
                if (token != request) return@launch
                result = next
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (cause: Throwable) {
                if (token == request) failure = cause.message?.takeIf { it.isNotBlank() } ?: getString(Res.string.session_cannot_read_directory)
            } finally {
                if (token == request) loading = false
            }
        }
    }

    LaunchedEffect(Unit) { load(initialPath) }

    val crumbs = remember(result?.path) { browseCrumbs(result?.path.orEmpty()) }

    PickerOverlay(
        title = stringResource(Res.string.session_choose_directory_title),
        subtitle = result?.let { browseDisplayPath(it.path, it.home) } ?: stringResource(Res.string.session_loading),
        onDismiss = onDismiss,
        fullHeight = true,
    ) {
        // The two absolute jumps the web offers as shortcuts, plus a refresh. Only the home
        // shortcut is unconditional: this sheet cannot know whether a `Documents` or `workspace`
        // folder exists on the host, and a button that is guaranteed to fail is worse than none.
        Row(
            modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            DirectoryChip(
                icon = RiffetIcons.House,
                label = stringResource(Res.string.session_home_directory),
                enabled = result != null && !loading,
                onClick = { load(result?.home) },
            )
            Spacer(Modifier.width(8.dp))
            DirectoryChip(
                icon = RiffetIcons.FolderOpen,
                label = stringResource(Res.string.session_parent_directory),
                enabled = result?.parent != null && !loading,
                onClick = { load(result?.parent) },
            )
            Spacer(Modifier.width(8.dp))
            result?.let { FavoriteToggle(favorites, it.path) }
            Box(
                modifier = Modifier
                    .size(metrics.controlHeight)
                    .clip(CircleShape)
                    .clickable(role = Role.Button, enabled = result != null && !loading) { load(result?.path) },
                contentAlignment = Alignment.Center,
            ) {
                if (loading) {
                    CircularProgressIndicator(color = colors.accent, strokeWidth = 2.dp, modifier = Modifier.size(16.dp))
                } else {
                    Icon(RiffetIcons.Refresh, contentDescription = stringResource(Res.string.session_refresh), tint = colors.fg3, modifier = Modifier.size(16.dp))
                }
            }
        }

        // Breadcrumbs, scrollable rather than truncated: a deep path is exactly where someone needs
        // to jump back two levels instead of walking up one at a time.
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState())
                .padding(horizontal = 20.dp, vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            crumbs.forEachIndexed { index, crumb ->
                if (index > 0) {
                    Icon(RiffetIcons.ChevronRight, contentDescription = null, tint = colors.fg4, modifier = Modifier.size(12.dp))
                }
                Text(
                    text = crumb.label,
                    style = typography.caption.copy(fontFamily = FontFamily.Monospace),
                    color = if (index == crumbs.lastIndex) colors.fg else colors.fg2,
                    maxLines = 1,
                    modifier = Modifier
                        .sizeIn(minWidth = 48.dp, minHeight = 48.dp)
                        .clip(RoundedCornerShape(LocalInterfaceStyle.current.controlRadius))
                        .clickable(role = Role.Button, enabled = !loading) { load(crumb.path) }
                        .padding(horizontal = 6.dp, vertical = 8.dp),
                )
            }
        }

        // Favorite folders, shared with every device: a tap goes there, a long press manages one.
        FolderFavoriteChips(
            favorites,
            currentPath = result?.path,
            onOpen = { load(it.path) },
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
        )

        AnimatedSheetNotice(failure, SettingsNoticeKind.ERROR)
        AnimatedSheetNotice(favorites.error, SettingsNoticeKind.ERROR)
        AnimatedSheetNotice(error, SettingsNoticeKind.ERROR)

        // Each directory follows the global page motion, reversing direction when going up.
        // The previous listing stays (dimmed) until the next one has been read, so a slow host shows
        // the place you left rather than an empty sheet; a refresh of the same path updates in place.
        val dim by animateFloatAsState(if (loading && result != null) 0.5f else 1f, motion.effects(), label = "listingDim")
        AnimatedContent(
            targetState = result,
            modifier = Modifier.fillMaxWidth().weight(1f).graphicsLayer { alpha = dim },
            contentKey = { it?.path },
            transitionSpec = {
                val from = initialState?.path
                val to = targetState?.path
                // An ancestor navigates back; a child or a jump to home or a favourite goes forward.
                pageMotion.transition(forward = from == null || to == null || !from.startsWith(to.trimEnd('/') + "/"))
            },
            label = "directoryListing",
        ) { listing ->
            val entries = browseEntries(listing, showHidden)
            LazyColumn(state = rememberLazyListState(), modifier = Modifier.fillMaxSize()) {
                if (listing?.parent != null) {
                    item(key = "..") {
                        OptionRow(
                            label = "..",
                            description = listing.parent?.let { browseDisplayPath(it, listing.home) },
                            icon = RiffetIcons.FolderOpen,
                            selected = false,
                            onClick = { load(listing.parent) },
                        )
                    }
                }
                items(entries, key = { it.name }) { entry ->
                    val path = browseChildPath(listing?.path.orEmpty(), entry.name)
                    OptionRow(
                        label = entry.name,
                        icon = RiffetIcons.Folder,
                        selected = false,
                        onClick = { load(path) },
                        trailing = { FavoriteToggle(favorites, path) },
                        // Hidden folders are dimmed by the same tone the web gives them, so "why is this
                        // one grey" has an answer without a legend.
                        tone = if (entry.hidden) colors.fg3 else null,
                    )
                }
                if (!loading && entries.isEmpty() && failure == null) {
                    item(key = "empty") {
                        Text(
                            text = stringResource(Res.string.session_empty_directory),
                            style = typography.bodySmall,
                            color = colors.fg3,
                            modifier = Modifier.fillMaxWidth().padding(24.dp),
                        )
                    }
                }
            }
        }

        HorizontalDivider(color = colors.line)
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            SettingsSwitch(checked = showHidden, onCheckedChange = { showHidden = it })
            Text(text = stringResource(Res.string.session_show_hidden_files), style = typography.label, color = colors.fg2, maxLines = 1)
            Spacer(Modifier.weight(1f))
            HomeActionButton(
                label = if (busy) stringResource(Res.string.session_using_directory) else stringResource(Res.string.session_use_directory),
                enabled = result != null && !busy && !loading,
                primary = true,
                onClick = { result?.let { onPick(it.path) } },
            )
        }
    }
}

/** A labelled shortcut in the sheet's top row. */
@Composable
private fun DirectoryChip(
    icon: ImageVector,
    label: String,
    enabled: Boolean,
    onClick: () -> Unit,
) = riffet.ui.design.ChipButton(label, active = false, onClick = onClick, icon = icon, enabled = enabled, trailingIcon = null)
