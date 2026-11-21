package riffet.ui.files

import riffet.ui.gesture.riffetHorizontalScroll
import riffet.ui.app.RiffetPageScaffold
import androidx.compose.foundation.layout.PaddingValues

import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.surfaces
import androidx.compose.ui.semantics.Role
import riffet.ui.favorites.FolderFavoriteChips
import riffet.ui.favorites.FolderFavoritesState
import riffet.ui.favorites.rememberFolderFavorites
import riffet.ui.app.PageBarAction
import riffet.ui.app.PageTopBar
import riffet.ui.app.PageMoreAction
import riffet.ui.app.PageBackHandler
import riffet.ui.design.StyleTopBar
import riffet.ui.design.RiffetSearchField
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.snapshotFlow
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.filter
import riffet.ui.pickers.RiffetDropdownMenu
import riffet.ui.pickers.RiffetMenuItem
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
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
import riffet.ui.settings.SettingsNoticeKind
import riffet.ui.sessionlist.relativeTimeAgo
import riffet.ui.settings.SettingsSegmented
import riffet.ui.theme.LocalRiffetCodeColors
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
import riffet.theme.RiffetCodeColors
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
    data class Preview(val path: String, val line: Int?, val visualization: Boolean = false) : FilesPage
    data class Edit(val preview: FilePreview) : FilesPage
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
    val writes = remember(api) { FileWriteSupport(api) }
    // The file as last saved or reloaded by an editing page, for the preview beneath it.
    var edited by remember { mutableStateOf<FilePreview?>(null) }
    riffet.ui.app.PageHost(pages, modifier) { page, back ->
        val goBack = if (!pages.canPop) close else back
        when (page) {
            is FilesPage.Directory -> DirectoryPage(api, projectId, projectName, page.path, favorites, goBack, close,
                onDirectory = { path ->
                    if (path != page.path && !pages.popTo { (it as? FilesPage.Directory)?.path == path }) pages.push(FilesPage.Directory(path))
                },
                onFile = { path, line -> pages.push(FilesPage.Preview(path, line)) },
            )
            is FilesPage.Preview -> FilePreviewPage(api, projectId, page, back, close, writes, edited) { pages.push(FilesPage.Edit(it)) }
            is FilesPage.Edit -> FileEditPage(api, projectId, page.preview, back) { edited = it }
        }
    }
}

@Composable
private fun FilePageChrome(
    title: String,
    onBack: () -> Unit,
    onClose: () -> Unit,
    /** A file page's directory under its name (mobile.md §9.3). */
    subtitle: String? = null,
    actions: @Composable () -> Unit = {},
    header: @Composable () -> Unit = {},
    bottomBar: (@Composable () -> Unit)? = null,
    /** Replaces the title bar (the directory's search field); [onBack] is then the field's arrow. */
    searchBar: (@Composable () -> Unit)? = null,
    closeInBar: Boolean = true,
    content: @Composable (PaddingValues) -> Unit,
) {
    RiffetPageScaffold(topBar = {
        if (searchBar != null) searchBar()
        else PageTopBar(title = title, onBack = onBack, subtitle = subtitle) {
            actions()
            if (closeInBar) PageBarAction(icon = RiffetIcons.Close, description = stringResource(Res.string.files_close), onClick = onClose)
        }
        header()
    }, bottomBar = bottomBar, content = content)
}

/** The bar while searching: the field fills it, the arrow closes the search. */
@Composable
private fun FilesSearchBar(query: String, onQueryChange: (String) -> Unit, placeholder: String, onClose: () -> Unit) {
    StyleTopBar(
        title = {
            RiffetSearchField(
                query = query, onQueryChange = onQueryChange, placeholder = placeholder,
                clearDescription = stringResource(Res.string.session_clear_search), requestFocus = true,
                modifier = Modifier.padding(end = LocalInterfaceStyle.current.metrics.pageInset),
            )
        },
        navigation = { PageBarAction(RiffetIcons.ArrowLeft, stringResource(Res.string.app_close_search), onClose) },
    )
}

@Composable
private fun DirectoryPage(
    api: RiffetApi, projectId: String, projectName: String, path: String, favorites: FolderFavoritesState,
    onBack: () -> Unit, onClose: () -> Unit,
    onDirectory: (String) -> Unit, onFile: (String, Int?) -> Unit,
) {
    val scope = rememberCoroutineScope()
    val metrics = LocalInterfaceStyle.current.metrics
    val addFavoriteFailed = stringResource(Res.string.favorites_error_add)
    val removeFavoriteFailed = stringResource(Res.string.favorites_error_remove)
    val cached = remember { FileCache.listing(projectId, path) }
    var entries by remember { mutableStateOf(cached?.entries.orEmpty()) }
    var hasMore by remember { mutableStateOf(cached?.hasMore ?: false) }
    var loading by remember { mutableStateOf(cached == null) }
    var loadingMore by remember { mutableStateOf(false) }
    var loadMoreFailed by remember { mutableStateOf(false) }
    var loaded by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var searching by rememberSaveable { mutableStateOf(false) }
    var query by rememberSaveable { mutableStateOf("") }
    var mode by rememberSaveable { mutableStateOf(SearchMode.NAME.id) }
    val searchMode = SearchMode.entries.first { it.id == mode }
    var found by remember { mutableStateOf<List<FileEntry>?>(null) }
    var hits by remember { mutableStateOf<List<SearchHit>?>(null) }
    var searchBusy by remember { mutableStateOf(false) }
    var searchError by remember { mutableStateOf<String?>(null) }
    val active = riffet.ui.app.LocalPageActive.current
    suspend fun load(force: Boolean = false) {
        if (force) loading = true
        error = null
        loadMoreFailed = false
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
    // Results follow the query: a pause in typing, then one request; a newer query cancels the older one.
    LaunchedEffect(query, mode, searching) {
        val value = query.trim()
        if (!searching || value.isEmpty()) { found = null; hits = null; searchBusy = false; searchError = null; return@LaunchedEffect }
        delay(300)
        searchBusy = true
        searchError = null
        try {
            if (searchMode == SearchMode.NAME) { found = api.find(projectId, value); hits = null }
            else { hits = api.search(projectId, value); found = null }
        } catch (cancellation: CancellationException) { throw cancellation }
        catch (failure: Throwable) { searchError = panelError(failure, getString(Res.string.files_error_search)) }
        finally { searchBusy = false }
    }
    val closeSearch: () -> Unit = { searching = false; query = "" }
    PageBackHandler(enabled = searching) { closeSearch() }
    val showResults = searching && query.isNotBlank()
    val listState = rememberLazyListState()
    FilePageChrome(projectName, onBack, onClose, actions = {
        PageBarAction(RiffetIcons.Search, stringResource(Res.string.files_search), { searching = true })
        if (path.isNotEmpty()) {
            val starred = favorites.favoriteAt(path) != null
            PageBarAction(
                icon = if (starred) RiffetIcons.StarFilled else RiffetIcons.Star,
                description = stringResource(if (starred) Res.string.files_unfavorite else Res.string.files_favorite_folder),
                onClick = { favorites.toggle(path, addFavoriteFailed, removeFavoriteFailed) },
                tint = if (starred) LocalRiffetColors.current.warning else null,
            )
        }
        PageMoreAction { close ->
            RiffetMenuItem(stringResource(Res.string.files_refresh), { close(); scope.launch { load(true) } }, icon = RiffetIcons.Refresh, enabled = !loading)
            RiffetMenuItem(stringResource(Res.string.files_close), { close(); onClose() }, icon = RiffetIcons.Close)
        }
    }, closeInBar = false, searchBar = if (searching) ({
        FilesSearchBar(query, { query = it }, stringResource(if (searchMode == SearchMode.NAME) Res.string.files_search_name_placeholder else Res.string.files_search_content_placeholder), closeSearch)
    }) else null, header = {
        if (searching) {
            Box(Modifier.fillMaxWidth().padding(horizontal = metrics.pageInset, vertical = 8.dp)) {
                SettingsSegmented(
                    options = SearchMode.entries.map { it.id to stringResource(if (it == SearchMode.NAME) Res.string.files_mode_name else Res.string.files_mode_content) },
                    value = mode, onSelect = { mode = it; found = null; hits = null },
                )
            }
            searchError?.let { BannerBox(it, SettingsNoticeKind.ERROR) }
        } else {
            error?.let { message -> BannerBox(message, SettingsNoticeKind.ERROR, stringResource(Res.string.files_retry)) { scope.launch { load(true) } } }
            favorites.error?.let { BannerBox(it, SettingsNoticeKind.ERROR) }
            DirectoryHeader(projectName, path, favorites, onDirectory)
        }
    }) { insets ->
        Box(Modifier.fillMaxSize()) {
            if (showResults) SearchBody(searchMode, searchBusy, found, hits, insets,
                onOpenEntry = { if (it.kind == FileEntryKind.DIRECTORY) onDirectory(it.path) else onFile(it.path, null) },
                onOpenHit = { onFile(it.path, it.line.toInt()) },
            ) else BrowseBody(entries, loading, hasMore && !loadMoreFailed, favorites, insets, listState,
                onOpenDirectory = onDirectory, onOpenFile = { onFile(it, null) },
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
                        catch (failure: Throwable) { loadMoreFailed = true; error = panelError(failure, getString(Res.string.files_error_load_more)) }
                        finally { loadingMore = false }
                    }
                },
            )
        }
    }
}

@Composable
internal fun BannerBox(message: String, kind: SettingsNoticeKind, action: String? = null, onAction: (() -> Unit)? = null) {
    Box(Modifier.fillMaxWidth().padding(horizontal = LocalInterfaceStyle.current.metrics.pageInset, vertical = 4.dp)) {
        riffet.ui.design.Notice(message, kind, action = action, onAction = onAction)
    }
}

@Composable
private fun FilePreviewPage(
    api: RiffetApi, projectId: String, page: FilesPage.Preview, onBack: () -> Unit, onClose: () -> Unit,
    writes: FileWriteSupport, edited: FilePreview?, onEdit: (FilePreview) -> Unit,
) {
    var preview by remember { mutableStateOf(FileCache.preview(projectId, page.path)) }
    var loading by remember { mutableStateOf(preview == null) }
    var error by remember { mutableStateOf<String?>(null) }
    var refresh by remember { mutableStateOf(0) }
    LaunchedEffect(edited) { if (edited != null && edited.path == page.path) preview = edited }
    LaunchedEffect(preview?.editable) { if (preview?.editable == true) writes.ensure() }
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
    val entryPath = preview?.path ?: page.path
    val value = preview
    val html = value != null && htmlPreviewSupported && (value.render != null || (!value.binary && value.image == null && isHtmlPreviewPath(value.path)))
    var renderHtml by remember(entryPath, page.line) { mutableStateOf(page.line == null) }
    // A link followed inside a project HTML site moves the title and the download to that page.
    var sitePage by remember(page.path, renderHtml) { mutableStateOf<String?>(null) }
    val path = sitePage ?: entryPath
    val outside = isAbsolutePath(path) || path == "~" || path.startsWith("~/")
    // Downloading reads the file as it is, so it does not wait on, or depend on, a preview that may fail.
    val download = if (downloadsSupported) ({ DownloadCenter.shared.start(api, projectId, path) }) else null
    val textPreview = value != null && !(html && renderHtml) && value.image == null && !value.binary
    val writeSupported = writes.supported
    val canEdit = value != null && value.editable && writeSupported && textPreview
    val footer: (@Composable () -> Unit)? = if (value != null && textPreview) ({ TextPreviewFooter(value) }) else null
    // The name is what the reader looks for; the directory is the line under it.
    val shownPath = tildePath(path)
    FilePageChrome(shownPath.substringAfterLast('/'), onBack, onClose,
        subtitle = shownPath.substringBeforeLast('/', "").takeIf { it.isNotEmpty() }, actions = {
        if (canEdit && value != null) PageBarAction(icon = RiffetIcons.Pencil, description = stringResource(Res.string.files_edit), onClick = { onEdit(value) })
        if (download != null) PageBarAction(icon = RiffetIcons.Download, description = stringResource(Res.string.files_download_file), onClick = download)
    }, header = {
        error?.let { message -> BannerBox(message, SettingsNoticeKind.ERROR, stringResource(Res.string.files_retry)) { refresh++ } }
        if (value != null) {
            if (outside) BannerBox(stringResource(Res.string.files_outside_banner), SettingsNoticeKind.INFO)
            if (html) Box(Modifier.fillMaxWidth().padding(horizontal = LocalInterfaceStyle.current.metrics.pageInset, vertical = 8.dp)) {
                SettingsSegmented(
                    options = listOf("preview" to stringResource(Res.string.files_preview), "source" to stringResource(Res.string.files_source)),
                    value = if (renderHtml) "preview" else "source", onSelect = { renderHtml = it == "preview" },
                )
            }
            if (textPreview && value.truncated) BannerBox(stringResource(Res.string.files_truncated), SettingsNoticeKind.INFO)
        }
    }, bottomBar = footer) { insets ->
        Box(Modifier.fillMaxSize().blurOnTap()) {
            if (value != null)
                PreviewBody(value, api, projectId, page.line, page.visualization, download, html && renderHtml, insets) { sitePage = it }
            else if (loading) Box(Modifier.fillMaxSize().padding(insets), contentAlignment = Alignment.Center) { Spinner(size = 20.dp) }
        }
    }
}

/**
 * Whether the server saves files (`file-write-v1`), asked of the bootstrap when a file
 * that could be edited is opened; it is asked again until a read succeeds.
 */
internal class FileWriteSupport(private val api: RiffetApi) {
    var supported by mutableStateOf(false)
        private set
    private var asked = false

    suspend fun ensure() {
        if (asked) return
        asked = true
        try { supported = api.bootstrap().protocol?.features?.contains("file-write-v1") == true }
        // A failed read is not an answer: the next editable file asks again.
        catch (cancellation: CancellationException) { asked = false; throw cancellation }
        catch (_: Throwable) { asked = false; supported = false }
    }
}

/* --------------------------------------------------------------------------------------------- */
/* Browse                                                                                         */
/* --------------------------------------------------------------------------------------------- */

@Composable
private fun DirectoryHeader(projectName: String, path: String, favorites: FolderFavoritesState, onNavigate: (String) -> Unit) {
    val colors = LocalRiffetColors.current
    val crumbs = remember(path) { path.split('/').filter { it.isNotEmpty() } }
    // At the root the bar's title already names the folder; the path appears once there is one.
    if (crumbs.isNotEmpty()) Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(40.dp)
            .riffetHorizontalScroll(rememberScrollState())
            .padding(horizontal = LocalInterfaceStyle.current.metrics.pageInset - 6.dp),
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
    FolderFavoriteChips(favorites, currentPath = path, onOpen = { onNavigate(it.path) }, modifier = Modifier.padding(horizontal = LocalInterfaceStyle.current.metrics.pageInset, vertical = 4.dp))
}

@Composable
private fun FileTypeIcon(directory: Boolean) {
    val colors = LocalRiffetColors.current
    Icon(
        if (directory) RiffetIcons.Folder else RiffetIcons.FileText,
        contentDescription = null,
        tint = if (directory) colors.accent else colors.fg3,
        modifier = Modifier.size(22.dp),
    )
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun BrowseBody(
    entries: List<FileEntry>,
    loading: Boolean,
    hasMore: Boolean,
    favorites: FolderFavoritesState,
    insets: PaddingValues,
    listState: LazyListState,
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

    // The next page loads when the end of the list comes into view.
    val currentLoadMore by rememberUpdatedState(onLoadMore)
    LaunchedEffect(listState, hasMore, entries.size) {
        if (!hasMore) return@LaunchedEffect
        snapshotFlow { listState.layoutInfo.let { (it.visibleItemsInfo.lastOrNull()?.index ?: 0) >= it.totalItemsCount - 6 } }
            .filter { it }
            .collect { currentLoadMore() }
    }

    val now = platformNowMillis()
    LazyColumn(Modifier.fillMaxSize(), state = listState, contentPadding = insets) {
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
                    Box {
                        Row(
                            modifier = Modifier
                                .animateItem(fadeInSpec = motion.effects(), placementSpec = motion.spatial(), fadeOutSpec = motion.effects())
                                .fillMaxWidth()
                                .height(56.dp)
                                // A long press on a folder opens its actions.
                                .combinedClickable(
                                    onClick = { if (directory) onOpenDirectory(entry.path) else onOpenFile(entry.path) },
                                    onLongClick = if (directory) ({ menu = true }) else null,
                                )
                                .padding(horizontal = designMetrics.pageInset),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            FileTypeIcon(directory)
                            Spacer(Modifier.width(16.dp))
                            Column(Modifier.weight(1f)) {
                                Text(entry.name, style = typography.body, color = colors.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                // Re-derive the bucket from the timestamp instead of comparing the
                                // client's source-locale label, so "just now" localizes too.
                                val meta = listOfNotNull(
                                    if (entry.kind == FileEntryKind.FILE) formatBytes(entry.size) else null,
                                    relativeTimeAgo(entry.modifiedAt, now),
                                ).joinToString(" · ")
                                if (meta.isNotEmpty()) Text(meta, style = typography.bodySmall, color = colors.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                            if (starred) {
                                Spacer(Modifier.width(12.dp))
                                Icon(RiffetIcons.StarFilled, contentDescription = stringResource(Res.string.files_starred), tint = colors.warning, modifier = Modifier.size(16.dp))
                            }
                        }
                        RiffetDropdownMenu(expanded = menu, onDismissRequest = { menu = false }, modifier = Modifier.align(Alignment.TopEnd)) {
                            RiffetMenuItem(
                                if (starred) stringResource(Res.string.files_unfavorite) else stringResource(Res.string.files_favorite_folder),
                                onClick = { menu = false; favorites.toggle(entry.path, addFavoriteFailed, removeFavoriteFailed) },
                                icon = if (starred) RiffetIcons.StarFilled else RiffetIcons.Star,
                            )
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
                    Box(Modifier.fillMaxWidth().height(56.dp), contentAlignment = Alignment.Center) { Spinner(size = 20.dp) }
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
                                .height(56.dp)
                                .clickable { onOpenEntry(entry) }
                                .padding(horizontal = designMetrics.pageInset),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            FileTypeIcon(directory)
                            Spacer(Modifier.width(16.dp))
                            Column(Modifier.weight(1f)) {
                                Text(entry.name, style = typography.body, color = colors.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(entry.path, style = typography.bodySmall, color = colors.fg3, maxLines = 1, overflow = TextOverflow.StartEllipsis)
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
                                .padding(horizontal = designMetrics.pageInset, vertical = 10.dp),
                        ) {
                            Text("${hit.path}:${hit.line}", style = typography.bodySmall, color = colors.fg3, maxLines = 1, overflow = TextOverflow.StartEllipsis)
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
    onDownload: (() -> Unit)?, renderHtml: Boolean, insets: PaddingValues, onSitePage: (String) -> Unit,
) {
    // A PDF the platform cannot draw falls back to the server-rendered page.
    var pdfFailed by remember(preview.path) { mutableStateOf(false) }
    // Scrollable code owns content padding so its lines pass beneath both fixed bars.
    // Static image/binary/native HTML viewers retain a safe content rectangle.
    if (!renderHtml && preview.image == null && !preview.binary) TextPreview(preview, requestedLine, insets)
    else Box(Modifier.fillMaxSize().padding(insets)) {
        when {
            renderHtml && preview.render == null && !visualization ->
                HtmlSitePreview(api, projectId, preview.path, preview.hash, onSitePage, Modifier.fillMaxSize())
            renderHtml && preview.render?.kind == "pdf" && nativePdfSupported && !pdfFailed ->
                PlatformPdfPreview(api, projectId, preview.path, preview.hash, Modifier.fillMaxSize()) { pdfFailed = true }
            renderHtml -> HtmlFilePreview(api, projectId, preview.path, visualization, Modifier.fillMaxSize(), generated = preview.render != null)
            preview.image != null -> ImagePreview(preview, projectId)
            else -> BinaryMessage(preview, onDownload)
        }
    }
}

@Composable
private fun TextPreview(preview: FilePreview, requestedLine: Int?, insets: PaddingValues) {
    val colors = LocalRiffetColors.current
    val codeColors = LocalRiffetCodeColors.current
    val lines = remember(preview.path, preview.content) { preview.content.split("\n") }
    // Coloured off the main thread; the plain lines show until it lands.
    val highlighted by produceState<List<AnnotatedString>?>(null, preview.path, preview.content, colors, codeColors) {
        val language = languageForPath(preview.path) ?: return@produceState
        value = withContext(Dispatchers.Default) { highlightLines(preview.content, language, colors, codeColors) }
    }
    val listState = rememberLazyListState()

    LaunchedEffect(preview.path, requestedLine) {
        val line = requestedLine ?: return@LaunchedEffect
        val index = (line - 1).coerceIn(0, (lines.size - 1).coerceAtLeast(0))
        listState.scrollToItem(index)
    }

    // One horizontal viewport keeps every code line aligned; vertical padding remains inside
    // the lazy list, allowing its recorded content to scroll behind the fixed chrome.
    Box(Modifier.fillMaxSize().riffetHorizontalScroll(rememberScrollState())) {
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
    Row(Modifier.fillMaxWidth().height(28.dp).padding(horizontal = LocalInterfaceStyle.current.metrics.pageInset), verticalAlignment = Alignment.CenterVertically) {
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
private fun highlightLines(content: String, language: String, colors: RiffetColors, codeColors: RiffetCodeColors): List<AnnotatedString> {
    val annotated = highlightCode(content, language, colors, codeColors)
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
