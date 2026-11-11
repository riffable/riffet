package riffet.ui.files

import riffet.ui.app.RiffetPageScaffold
import androidx.compose.foundation.layout.PaddingValues

import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.surfaces
import androidx.compose.ui.semantics.Role
import androidx.compose.foundation.shape.CircleShape
import riffet.ui.favorites.FolderFavoriteChips
import riffet.ui.favorites.FolderFavoritesState
import riffet.ui.favorites.rememberFolderFavorites
import riffet.ui.app.PageBarAction
import riffet.ui.app.PageTopBar
import riffet.ui.pickers.RiffetDropdownMenu
import riffet.ui.pickers.RiffetMenuItem
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import riffet.contracts.FileEntry
import riffet.contracts.FileEntryKind
import riffet.contracts.FilePreview
import riffet.contracts.SearchHit
import riffet.shared.RiffetApi
import riffet.shared.RiffetHttpException
import riffet.ui.focus.SelectableText
import riffet.ui.focus.blurOnTap
import riffet.ui.icons.RiffetIcons
import riffet.ui.settings.SettingsButton
import riffet.ui.settings.SettingsField
import riffet.ui.settings.SettingsNoticeKind
import riffet.ui.settings.SettingsMessageBanner
import riffet.ui.sessionlist.relativeTimeAgo
import riffet.ui.settings.SettingsSegmented
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet.ui.theme.LocalRiffetMotion
import riffet.ui.timeline.FlexibleImage
import riffet.ui.timeline.ImageSource
import riffet.ui.timeline.Spinner
import riffet.ui.timeline.highlightCode
import riffet.ui.timeline.languageForPath
import riffet.ui.timeline.platformNowMillis
import riffet.shared.DownloadCenter
import riffet.shared.downloadsSupported
import riffet.theme.RiffetColors
import androidx.compose.runtime.produceState
import androidx.compose.ui.text.AnnotatedString
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.jetbrains.compose.resources.getString
import org.jetbrains.compose.resources.stringResource
import riffet_mobile.shared.generated.resources.*
import riffet.shared.files
import riffet.shared.find
import riffet.shared.preview
import riffet.shared.search

/*
 * The project file browser, ported from `apps/web/src/app/panels/ContextPanel.tsx` (the `files`
 * half) and `LargeFilePreview.tsx`.
 *
 * Scope rules, taken from ContextPanel and honoured here rather than flattened:
 *
 *  - the tree, name search and content search are **project-scoped**; every path they yield is
 *    relative to the project root and there is no way to navigate out of the tree;
 *  - reading an absolute path outside the project is a *separate, opt-in* server setting
 *    (`allowOutsideRead`). The only way such a path reaches this panel is [initialPreviewPath],
 *    and when it does the preview is labelled as outside the project instead of being presented
 *    as an ordinary file. When the server refuses it, the refusal is repeated with the setting's
 *    location rather than swallowed.
 *
 * Text highlighting and image loading share the timeline's renderer. Each directory/search/preview
 * visit retains its own scroll, query and result while another page is on top of it.
 *
 * @param initialPreviewPath a path to open on first composition, e.g. handed over by the timeline's
 *   file chip or the git panel's diff header. Absolute paths are the outside-project route.
 */

private const val PAGE = 100
private val LINE_NUMBER_WIDTH = 46.dp

private enum class SearchMode(val id: String) {
    NAME("name"),
    CONTENT("content"),
}

private sealed interface FilesPage {
    data class Directory(val path: String) : FilesPage
    data object Search : FilesPage
    data class Preview(val path: String, val line: Int?, val visualization: Boolean = false) : FilesPage
}

@Composable
fun FilesPanel(
    api: RiffetApi,
    projectId: String,
    projectName: String,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    initialPreviewPath: String? = null,
    initialPreviewLine: Int? = null,
    initialVisualization: Boolean = false,
) {
    val pages = remember(projectId) {
        riffet.ui.app.PageStack<FilesPage>(FilesPage.Directory("")).apply {
            var path = ""
            FileCache.directory(projectId).split('/').filter { it.isNotEmpty() }.forEach { part ->
                path = if (path.isEmpty()) part else "$path/$part"
                push(FilesPage.Directory(path))
            }
            if (initialPreviewPath != null) push(FilesPage.Preview(initialPreviewPath, initialPreviewLine, initialVisualization))
        }
    }
    val focus = LocalFocusManager.current
    val close: () -> Unit = { focus.clearFocus(); onBack() }
    // One list for every page of the stack, so a star set two folders down shows on the way back.
    val favorites = rememberFolderFavorites(api, projectId)
    riffet.ui.app.PageHost(pages, modifier) { page, back ->
        val goBack = if (!pages.canPop) close else back
        when (page) {
            is FilesPage.Directory -> DirectoryPage(api, projectId, projectName, page.path, favorites, goBack, close,
                onDirectory = { path ->
                    if (path != page.path && !pages.popTo { (it as? FilesPage.Directory)?.path == path }) pages.push(FilesPage.Directory(path))
                },
                onFile = { pages.push(FilesPage.Preview(it, null)) },
                onSearch = { pages.push(FilesPage.Search) },
            )
            FilesPage.Search -> FileSearchPage(api, projectId, back, close,
                onDirectory = { pages.push(FilesPage.Directory(it)) },
                onFile = { path, line -> pages.push(FilesPage.Preview(path, line)) },
            )
            is FilesPage.Preview -> FilePreviewPage(api, projectId, page, back, close)
        }
    }
}

@Composable
private fun FilePageChrome(
    title: String,
    onBack: () -> Unit,
    onClose: () -> Unit,
    actions: @Composable () -> Unit = {},
    header: @Composable () -> Unit = {},
    bottomBar: (@Composable () -> Unit)? = null,
    content: @Composable (PaddingValues) -> Unit,
) {
    RiffetPageScaffold(topBar = {
        PageTopBar(title = title, onBack = onBack) {
            actions()
            PageBarAction(icon = RiffetIcons.Close, description = stringResource(Res.string.files_close), onClick = onClose)
        }
        header()
    }, bottomBar = bottomBar, content = content)
}

/** The directory page's actions behind one overflow button, so the bar stays back/title/menu/close. */
@Composable
private fun DirectoryActionsMenu(
    canFavorite: Boolean,
    starred: Boolean,
    refreshing: Boolean,
    onFavorite: () -> Unit,
    onRefresh: () -> Unit,
    onSearch: () -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    Box {
        PageBarAction(icon = RiffetIcons.Ellipsis, description = stringResource(Res.string.files_more), onClick = { open = true })
        RiffetDropdownMenu(expanded = open, onDismissRequest = { open = false }, modifier = Modifier.width(200.dp)) {
            if (canFavorite) {
                RiffetMenuItem(
                    if (starred) stringResource(Res.string.files_unfavorite) else stringResource(Res.string.files_favorite_folder),
                    { open = false; onFavorite() },
                    icon = if (starred) RiffetIcons.StarFilled else RiffetIcons.Star,
                )
            }
            RiffetMenuItem(stringResource(Res.string.files_refresh), { open = false; onRefresh() }, icon = RiffetIcons.Refresh, enabled = !refreshing)
            RiffetMenuItem(stringResource(Res.string.files_search), { open = false; onSearch() }, icon = RiffetIcons.Search)
        }
    }
}

@Composable
private fun DirectoryPage(
    api: RiffetApi, projectId: String, projectName: String, path: String, favorites: FolderFavoritesState,
    onBack: () -> Unit, onClose: () -> Unit,
    onDirectory: (String) -> Unit, onFile: (String) -> Unit, onSearch: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val addFavoriteFailed = stringResource(Res.string.favorites_error_add)
    val removeFavoriteFailed = stringResource(Res.string.favorites_error_remove)
    val cached = remember { FileCache.listing(projectId, path) }
    var entries by remember { mutableStateOf(cached?.entries.orEmpty()) }
    var hasMore by remember { mutableStateOf(cached?.hasMore ?: false) }
    var loading by remember { mutableStateOf(cached == null) }
    var loadingMore by remember { mutableStateOf(false) }
    var loaded by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val active = riffet.ui.app.LocalPageActive.current
    suspend fun load(force: Boolean = false) {
        if (force) loading = true
        error = null
        try {
            val first = api.files(projectId, path, PAGE, 0)
            val known = first.map { it.path }.toSet()
            val rest = entries.drop(PAGE).filter { it.path !in known }
            entries = first + rest
            hasMore = if (rest.isNotEmpty()) hasMore else first.size == PAGE
            FileCache.putListing(projectId, path, FileCache.Listing(entries, hasMore))
            loaded = true
        } catch (cancellation: CancellationException) { throw cancellation }
        catch (failure: Throwable) { error = panelError(failure, getString(Res.string.files_error_read_dir)) }
        finally { loading = false }
    }
    LaunchedEffect(active) {
        if (active) {
            FileCache.putDirectory(projectId, path)
            if (!loaded) load()
        }
    }
    FilePageChrome(projectName, onBack, onClose, actions = {
        DirectoryActionsMenu(
            canFavorite = path.isNotEmpty(),
            starred = path.isNotEmpty() && favorites.favoriteAt(path) != null,
            refreshing = loading,
            onFavorite = { favorites.toggle(path, addFavoriteFailed, removeFavoriteFailed) },
            onRefresh = { scope.launch { load(true) } },
            onSearch = onSearch,
        )
    }, header = {
        error?.let { SettingsMessageBanner(it, SettingsNoticeKind.ERROR); SettingsButton(stringResource(Res.string.files_retry), onClick = { scope.launch { load(true) } }) }
        favorites.error?.let { SettingsMessageBanner(it, SettingsNoticeKind.ERROR) }
        DirectoryHeader(projectName, path, favorites, onDirectory)
    }) { insets ->
        Box(Modifier.fillMaxSize()) {
            BrowseBody(entries, loading, loadingMore, hasMore, favorites, insets,
                onOpenDirectory = onDirectory, onOpenFile = onFile,
                onLoadMore = {
                    if (!loadingMore) scope.launch {
                        loadingMore = true
                        try {
                            val next = api.files(projectId, path, PAGE, entries.size)
                            val known = entries.map { it.path }.toSet()
                            entries = entries + next.filter { it.path !in known }
                            hasMore = next.size == PAGE
                            FileCache.putListing(projectId, path, FileCache.Listing(entries, hasMore))
                        } catch (cancellation: CancellationException) { throw cancellation }
                        catch (failure: Throwable) { error = panelError(failure, getString(Res.string.files_error_load_more)) }
                        finally { loadingMore = false }
                    }
                },
            )
        }
    }
}

@Composable
private fun FileSearchPage(
    api: RiffetApi, projectId: String, onBack: () -> Unit, onClose: () -> Unit,
    onDirectory: (String) -> Unit, onFile: (String, Int?) -> Unit,
) {
    val scope = rememberCoroutineScope()
    var mode by remember { mutableStateOf(SearchMode.NAME) }
    var query by remember { mutableStateOf("") }
    var found by remember { mutableStateOf<List<FileEntry>?>(null) }
    var hits by remember { mutableStateOf<List<SearchHit>?>(null) }
    var searching by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val runSearch: () -> Unit = {
        val value = query.trim()
        if (value.isNotEmpty() && !searching) {
            val requestedMode = mode
            searching = true
            scope.launch {
                error = null
                try {
                    if (requestedMode == SearchMode.NAME) { found = api.find(projectId, value); hits = null }
                    else { hits = api.search(projectId, value); found = null }
                } catch (cancellation: CancellationException) { throw cancellation }
                catch (failure: Throwable) { error = panelError(failure, getString(Res.string.files_error_search)) }
                finally { searching = false }
            }
        }
    }
    FilePageChrome(stringResource(Res.string.files_search), onBack, onClose, header = {
        error?.let { SettingsMessageBanner(it, SettingsNoticeKind.ERROR) }
        SearchControls(mode, { mode = it; found = null; hits = null }, query, { query = it }, searching, runSearch)
    }) { insets ->
        Box(Modifier.fillMaxSize()) {
            SearchBody(mode, searching, found, hits, insets,
                onOpenEntry = { if (it.kind == FileEntryKind.DIRECTORY) onDirectory(it.path) else onFile(it.path, null) },
                onOpenHit = { onFile(it.path, it.line.toInt()) },
            )
        }
    }
}

@Composable
private fun FilePreviewPage(api: RiffetApi, projectId: String, page: FilesPage.Preview, onBack: () -> Unit, onClose: () -> Unit) {
    var preview by remember { mutableStateOf(FileCache.preview(projectId, page.path)) }
    var loading by remember { mutableStateOf(preview == null) }
    var error by remember { mutableStateOf<String?>(null) }
    var refresh by remember { mutableStateOf(0) }
    LaunchedEffect(refresh) {
        loading = preview == null
        error = null
        try {
            val result = api.preview(projectId, page.path)
            FileCache.putPreview(projectId, page.path, result)
            preview = result
        } catch (cancellation: CancellationException) { throw cancellation }
        catch (failure: Throwable) {
            val code = (failure as? RiffetHttpException)?.code
            error = if (code == "PATH_OUTSIDE_PROJECT" || code == "INVALID_PATH") getString(Res.string.files_outside_hint) else panelError(failure, getString(Res.string.files_error_open))
        } finally { loading = false }
    }
    val path = preview?.path ?: page.path
    val outside = isAbsolutePath(path)
    // Downloading reads the file as it is, so it does not wait on, or depend on, a preview that may fail.
    val download = if (!outside && downloadsSupported) ({ DownloadCenter.shared.start(api, projectId, path) }) else null
    val value = preview
    val html = value != null && htmlPreviewSupported && (value.render != null || (!value.binary && value.image == null && isHtmlPreviewPath(value.path)))
    var renderHtml by remember(path, page.line) { mutableStateOf(page.line == null) }
    val textPreview = value != null && !(html && renderHtml) && value.image == null && !value.binary
    val footer: (@Composable () -> Unit)? = if (value != null && textPreview) ({ TextPreviewFooter(value) }) else null
    FilePageChrome(tildePath(path), onBack, onClose, actions = {
        if (download != null) PageBarAction(icon = RiffetIcons.Download, description = stringResource(Res.string.files_download_file), onClick = download)
    }, header = {
        error?.let { SettingsMessageBanner(it, SettingsNoticeKind.ERROR); SettingsButton(stringResource(Res.string.files_retry), onClick = { refresh++ }) }
        if (value != null) {
            if (outside) Box(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp)) {
                SettingsMessageBanner(stringResource(Res.string.files_outside_banner), SettingsNoticeKind.INFO)
            }
            if (html) Box(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp)) {
                SettingsSegmented(
                    options = listOf("preview" to stringResource(Res.string.files_preview), "source" to stringResource(Res.string.files_source)),
                    value = if (renderHtml) "preview" else "source", onSelect = { renderHtml = it == "preview" },
                )
            }
            if (textPreview && value.truncated) Box(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp)) {
                SettingsMessageBanner(stringResource(Res.string.files_truncated), SettingsNoticeKind.INFO)
            }
        }
    }, bottomBar = footer) { insets ->
        Box(Modifier.fillMaxSize().blurOnTap()) {
            if (value != null)
                PreviewBody(value, api, projectId, page.line, page.visualization, download, html && renderHtml, insets)
            else if (loading) Box(Modifier.fillMaxSize().padding(insets), contentAlignment = Alignment.Center) { Spinner(size = 20.dp) }
        }
    }
}

/* --------------------------------------------------------------------------------------------- */
/* Browse                                                                                         */
/* --------------------------------------------------------------------------------------------- */

@Composable
private fun DirectoryHeader(projectName: String, path: String, favorites: FolderFavoritesState, onNavigate: (String) -> Unit) {
    val colors = LocalRiffetColors.current
    val crumbs = remember(path) { path.split('/').filter { it.isNotEmpty() } }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(40.dp)
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Crumb(text = projectName, current = crumbs.isEmpty(), onClick = { onNavigate("") })
        crumbs.forEachIndexed { index, part ->
            Icon(RiffetIcons.ChevronRight, contentDescription = null, tint = colors.fg4, modifier = Modifier.size(13.dp))
            Crumb(
                text = part,
                current = index == crumbs.lastIndex,
                onClick = { onNavigate(crumbs.take(index + 1).joinToString("/")) },
            )
        }
    }
    // The project's favorite folders: a tap goes there, a long press manages one.
    FolderFavoriteChips(favorites, currentPath = path, onOpen = { onNavigate(it.path) }, modifier = Modifier.padding(horizontal = 14.dp, vertical = 4.dp))
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun BrowseBody(
    entries: List<FileEntry>,
    loading: Boolean,
    loadingMore: Boolean,
    hasMore: Boolean,
    favorites: FolderFavoritesState,
    insets: PaddingValues,
    onOpenDirectory: (String) -> Unit,
    onOpenFile: (String) -> Unit,
    onLoadMore: () -> Unit,
) {
    val designMetrics = LocalInterfaceStyle.current.metrics
    val motion = LocalRiffetMotion.current
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val addFavoriteFailed = stringResource(Res.string.favorites_error_add)
    val removeFavoriteFailed = stringResource(Res.string.favorites_error_remove)
    val sortedEntries = remember(entries) { entries.sortedBy { it.kind != FileEntryKind.DIRECTORY } }

    val now = platformNowMillis()
    LazyColumn(Modifier.fillMaxSize(), contentPadding = insets) {
        if (loading) {
            item(key = "loading") {
                Box(Modifier.fillMaxWidth().padding(vertical = 40.dp), contentAlignment = Alignment.Center) { Spinner(size = 20.dp) }
            }
        } else {
            sortedEntries.forEach { entry ->
                item(key = entry.path) {
                    val directory = entry.kind == FileEntryKind.DIRECTORY
                    val starred = directory && favorites.favoriteAt(entry.path) != null
                    var menu by remember { mutableStateOf(false) }
                    Row(
                        modifier = Modifier
                            .animateItem(fadeInSpec = motion.effects(), placementSpec = motion.spatial(), fadeOutSpec = motion.effects())
                            .fillMaxWidth()
                            .height(56.dp)
                            // A long press on a folder offers to star it.
                            .combinedClickable(
                                onClick = { if (directory) onOpenDirectory(entry.path) else onOpenFile(entry.path) },
                                onLongClick = if (directory) ({ menu = true }) else null,
                            )
                            .padding(horizontal = designMetrics.pageInset),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(
                            modifier = Modifier.size(36.dp).clip(CircleShape).background(if (directory) colors.accentSoft else colors.bgMuted),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(
                                if (directory) RiffetIcons.Folder else RiffetIcons.FileText,
                                contentDescription = null,
                                tint = if (directory) colors.accent else colors.fg2,
                                modifier = Modifier.size(designMetrics.smallIconSize),
                            )
                        }
                        Spacer(Modifier.width(14.dp))
                        Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
                            Text(entry.name, style = typography.body, color = colors.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                            if (starred) {
                                Spacer(Modifier.width(6.dp))
                                Icon(RiffetIcons.StarFilled, contentDescription = stringResource(Res.string.files_starred), tint = colors.warning, modifier = Modifier.size(12.dp))
                            }
                            RiffetDropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                                RiffetMenuItem(if (starred) stringResource(Res.string.files_unfavorite) else stringResource(Res.string.files_favorite_folder), onClick = { menu = false; favorites.toggle(entry.path, addFavoriteFailed, removeFavoriteFailed) })
                            }
                        }
                        val meta = listOfNotNull(
                            // Re-derive the bucket from the timestamp instead of comparing the
                            // client's source-locale label, so "just now" localizes too.
                            relativeTimeAgo(entry.modifiedAt, now),
                            if (entry.kind == FileEntryKind.FILE) formatBytes(entry.size) else null,
                        ).joinToString(" · ")
                        if (meta.isNotEmpty()) {
                            Spacer(Modifier.width(8.dp))
                            Text(meta, style = typography.caption, color = colors.fg3, maxLines = 1)
                        }
                    }
                }
            }
            if (entries.isEmpty()) {
                item(key = "empty") {
                    Box(Modifier.fillMaxWidth().padding(vertical = 40.dp), contentAlignment = Alignment.Center) {
                        Text(stringResource(Res.string.files_empty_dir), style = typography.body, color = colors.fg3)
                    }
                }
            }
            if (hasMore) {
                item(key = "load-more") {
                    Box(Modifier.fillMaxWidth().padding(8.dp), contentAlignment = Alignment.Center) {
                        SettingsButton(
                            text = if (loadingMore) stringResource(Res.string.files_loading) else stringResource(Res.string.files_load_more),
                            onClick = onLoadMore,
                            enabled = !loadingMore,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun Crumb(text: String, current: Boolean, onClick: () -> Unit) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    Text(
        text = text,
        style = if (current) typography.label else typography.bodySmall,
        color = if (current) colors.fg else colors.fg3,
        maxLines = 1,
        modifier = Modifier
            .clip(RoundedCornerShape(LocalInterfaceStyle.current.controlRadius))
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 6.dp, vertical = 4.dp),
    )
}

/* --------------------------------------------------------------------------------------------- */
/* Search                                                                                         */
/* --------------------------------------------------------------------------------------------- */

@Composable
private fun SearchControls(
    mode: SearchMode, onModeChange: (SearchMode) -> Unit, query: String,
    onQueryChange: (String) -> Unit, searching: Boolean, onRun: () -> Unit,
) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        // The field owns the full width: closing the panel is the header's ✕, so there is no
        // second ✕ here to be mistaken for "clear the query".
        SettingsField(
            value = query,
            onValueChange = onQueryChange,
            placeholder = if (mode == SearchMode.NAME) stringResource(Res.string.files_search_name_placeholder) else stringResource(Res.string.files_search_content_placeholder),
            modifier = Modifier.fillMaxWidth(),
        )
        val modeLabels = mapOf(
            SearchMode.NAME to stringResource(Res.string.files_mode_name),
            SearchMode.CONTENT to stringResource(Res.string.files_mode_content),
        )
        SettingsSegmented(
            options = SearchMode.entries.map { it.id to modeLabels.getValue(it) },
            value = mode.id,
            enabled = !searching,
            onSelect = { id -> SearchMode.entries.firstOrNull { it.id == id }?.let(onModeChange) },
        )
        SettingsButton(text = if (searching) stringResource(Res.string.files_searching) else stringResource(Res.string.files_search_action), onClick = onRun, enabled = !searching, primary = true)
    }
}

@Composable
private fun SearchBody(
    mode: SearchMode,
    searching: Boolean,
    found: List<FileEntry>?,
    hits: List<SearchHit>?,
    insets: PaddingValues,
    onOpenEntry: (FileEntry) -> Unit,
    onOpenHit: (SearchHit) -> Unit,
) {
    val designMetrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val sortedFound = remember(found) { found?.sortedBy { it.kind != FileEntryKind.DIRECTORY } }

    LazyColumn(Modifier.fillMaxSize(), contentPadding = insets) {
        if (searching) {
            item(key = "loading") {
                Box(Modifier.fillMaxWidth().padding(vertical = 32.dp), contentAlignment = Alignment.Center) { Spinner(size = 20.dp) }
            }
        } else {
            if (mode == SearchMode.NAME) {
                sortedFound?.forEach { entry ->
                    item(key = entry.path) {
                        val directory = entry.kind == FileEntryKind.DIRECTORY
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(60.dp)
                                .clickable { onOpenEntry(entry) }
                                .padding(horizontal = designMetrics.pageInset),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Box(
                                modifier = Modifier.size(36.dp).clip(CircleShape).background(if (directory) colors.accentSoft else colors.bgMuted),
                                contentAlignment = Alignment.Center,
                            ) {
                                Icon(
                                    if (directory) RiffetIcons.Folder else RiffetIcons.FileText,
                                    contentDescription = null,
                                    tint = if (directory) colors.accent else colors.fg2,
                                    modifier = Modifier.size(designMetrics.smallIconSize),
                                )
                            }
                            Spacer(Modifier.width(14.dp))
                            Column(Modifier.weight(1f)) {
                                Text(entry.name, style = typography.body, color = colors.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(entry.path, style = typography.monoSmall, color = colors.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                        }
                    }
                }
            } else {
                hits?.forEachIndexed { index, hit ->
                    item(key = "${hit.path}:${hit.line}:$index") {
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { onOpenHit(hit) }
                                .padding(horizontal = 16.dp, vertical = 10.dp),
                        ) {
                            Text("${hit.path}:${hit.line}", style = typography.monoSmall, color = colors.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Spacer(Modifier.height(2.dp))
                            Text(hit.text.trim(), style = typography.monoSmall, color = colors.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
            val empty = if (mode == SearchMode.NAME) found?.isEmpty() == true else hits?.isEmpty() == true
            if (empty) {
                item(key = "empty") {
                    Box(Modifier.fillMaxWidth().padding(vertical = 32.dp), contentAlignment = Alignment.Center) {
                        Text(stringResource(Res.string.files_no_matches), style = typography.body, color = colors.fg3)
                    }
                }
            }
        }
    }
}

/* --------------------------------------------------------------------------------------------- */
/* Preview                                                                                        */
/* --------------------------------------------------------------------------------------------- */

@Composable
private fun PreviewBody(
    preview: FilePreview, api: RiffetApi, projectId: String, requestedLine: Int?, visualization: Boolean,
    onDownload: (() -> Unit)?, renderHtml: Boolean, insets: PaddingValues,
) {
    // Scrollable code owns content padding so its lines pass beneath both fixed bars.
    // Static image/binary/native HTML viewers retain a safe content rectangle.
    if (!renderHtml && preview.image == null && !preview.binary) TextPreview(preview, requestedLine, insets)
    else Box(Modifier.fillMaxSize().padding(insets)) {
        when {
            renderHtml -> HtmlFilePreview(api, projectId, preview.path, visualization, Modifier.fillMaxSize(), generated = preview.render != null)
            preview.image != null -> ImagePreview(preview, projectId)
            else -> BinaryMessage(preview, onDownload)
        }
    }
}

@Composable
private fun TextPreview(preview: FilePreview, requestedLine: Int?, insets: PaddingValues) {
    val colors = LocalRiffetColors.current
    val lines = remember(preview.path, preview.content) { preview.content.split("\n") }
    // Coloured off the main thread; the plain lines show until it lands.
    val highlighted by produceState<List<AnnotatedString>?>(null, preview.path, preview.content, colors) {
        val language = languageForPath(preview.path) ?: return@produceState
        value = withContext(Dispatchers.Default) { highlightLines(preview.content, language, colors) }
    }
    val listState = rememberLazyListState()

    LaunchedEffect(preview.path, requestedLine) {
        val line = requestedLine ?: return@LaunchedEffect
        val index = (line - 1).coerceIn(0, (lines.size - 1).coerceAtLeast(0))
        listState.scrollToItem(index)
    }

    // One horizontal viewport keeps every code line aligned; vertical padding remains inside
    // the lazy list, allowing its recorded content to scroll behind the fixed chrome.
    Box(Modifier.fillMaxSize().horizontalScroll(rememberScrollState())) {
        LazyColumn(state = listState, modifier = Modifier.fillMaxHeight(), contentPadding = insets) {
            items(lines.size, key = { it }) { index ->
                LineRow(
                    number = index + 1,
                    text = highlighted?.getOrNull(index) ?: AnnotatedString(lines[index]),
                    highlighted = requestedLine == index + 1,
                )
            }
        }
    }
}

@Composable
private fun TextPreviewFooter(preview: FilePreview) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val lineCount = remember(preview.content) { preview.content.count { it == '\n' } + 1 }
    Row(Modifier.fillMaxWidth().height(28.dp).padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(stringResource(Res.string.files_line_count, lineCount, formatBytes(preview.size)), style = typography.caption, color = colors.fg3)
    }
}

@Composable
private fun LineRow(number: Int, text: AnnotatedString, highlighted: Boolean) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    Row(Modifier.background(if (highlighted) surfaces.selected else Color.Transparent)) {
        Text(
            text = number.toString(),
            style = typography.monoSmall,
            color = if (highlighted) surfaces.selectedContent else colors.fg4,
            textAlign = TextAlign.End,
            maxLines = 1,
            modifier = Modifier.width(LINE_NUMBER_WIDTH).padding(end = 8.dp),
        )
        // The code text is selectable, the line number is not: a gutter number is chrome. The
        // container is per line because the preview is a `LazyColumn` — a container above a lazy
        // list is the case Compose documents as unreliable — and because each line is its own
        // `softWrap = false` row inside the panel's horizontal scroll.
        SelectableText {
            Text(
                text = if (text.isEmpty()) AnnotatedString(" ") else text,
                style = typography.monoSmall,
                color = if (highlighted) surfaces.selectedContent else colors.fg,
                softWrap = false,
                maxLines = 1,
                modifier = Modifier.padding(end = 16.dp),
            )
        }
    }
}

@Composable
private fun BinaryMessage(preview: FilePreview, onDownload: (() -> Unit)?) {
    val designMetrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(RiffetIcons.Warning, contentDescription = null, tint = colors.fg4, modifier = Modifier.size(designMetrics.iconSize))
            Spacer(Modifier.height(8.dp))
            Text(stringResource(Res.string.files_binary), style = typography.body, color = colors.fg)
            Spacer(Modifier.height(2.dp))
            Text(stringResource(Res.string.files_binary_meta, formatBytes(preview.size)), style = typography.caption, color = colors.fg3)
            // What there is to do with a file that cannot be shown is to take it.
            if (onDownload != null) {
                Spacer(Modifier.height(16.dp))
                SettingsButton(text = stringResource(Res.string.files_download), onClick = onDownload, primary = true)
            }
        }
    }
}

/** The image itself, through the project's image route; tap for the zoomable viewer. */
@Composable
private fun ImagePreview(preview: FilePreview, projectId: String) {
    val designMetrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    // One line, two homes: the panel shows it under the image, the full-screen viewer under the
    // file's name (which is that same line plus the path).
    val meta = "${preview.image?.mimeType ?: "image"} · ${formatBytes(preview.size)}"
    Column(
        modifier = Modifier.fillMaxSize().padding(designMetrics.rowPadding),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterVertically),
    ) {
        FlexibleImage(
            source = ImageSource.ProjectFile(projectId, preview.path),
            label = preview.path,
            maxHeight = 560.dp,
            detail = meta,
        )
        Text(
            meta,
            style = typography.caption,
            color = colors.fg3,
        )
    }
}

/** [content] coloured as [language] and cut back into lines, keeping spans that cross a line. */
private fun highlightLines(content: String, language: String, colors: RiffetColors): List<AnnotatedString> {
    val annotated = highlightCode(content, language, colors)
    val result = ArrayList<AnnotatedString>()
    var start = 0
    while (true) {
        val end = content.indexOf('\n', start)
        if (end < 0) {
            result += annotated.subSequence(start, content.length)
            return result
        }
        result += annotated.subSequence(start, end)
        start = end + 1
    }
}

/* --------------------------------------------------------------------------------------------- */
/* Errors                                                                                         */
/* --------------------------------------------------------------------------------------------- */

/**
 * The server's own message is the useful part of a failure; the fallback names the action. The web
 * does the same (`errorMessage(error, fallback)`), and the messages here are the server's English
 * text on purpose — translating them would invent detail the server did not send.
 */
internal suspend fun panelError(error: Throwable, fallback: String): String {
    val detail = error.message?.takeIf { it.isNotBlank() }
    return if (detail != null && detail != fallback) getString(Res.string.files_error_detail, fallback, detail) else fallback
}
