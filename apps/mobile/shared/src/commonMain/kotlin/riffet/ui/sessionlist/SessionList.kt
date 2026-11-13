package riffet.ui.sessionlist

import riffet.ui.design.RiffetSearchField
import riffet.ui.design.ChipButton
import riffet.ui.home.ProjectPickerSheet
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue


import riffet.ui.design.riffetMaterialSource
import riffet.ui.design.RiffetMaterialSourceContent
import riffet.ui.design.materialBackdropEnabled
import riffet.ui.app.LocalTabContentBottomPadding
import riffet.ui.app.LocalPageActive

import riffet.ui.design.LocalInterfaceStyle
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyItemScope
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import riffet.ui.design.RiffetProgressIndicator as CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import riffet.ui.icons.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.getString
import org.jetbrains.compose.resources.stringResource
import org.jetbrains.compose.resources.rememberResourceEnvironment
import riffet.cache.IndexHit
import riffet.cache.IndexRole
import riffet.contracts.NativeBackendId
import riffet.contracts.Project
import riffet.contracts.Session
import riffet.contracts.SessionState
import riffet.shared.AppPreferences
import riffet.shared.PreferenceKeys
import riffet.shared.isQuickChat
import riffet.theme.RiffetColors
import riffet.ui.app.LocalTabChrome
import riffet.ui.app.PageBackHandler
import riffet.ui.app.PageBarAction
import riffet.ui.app.TabTopBar
import riffet.ui.design.AgentAvatar
import riffet.ui.design.AvatarStatus
import riffet.ui.design.ChipItem
import riffet.ui.design.ChipRow
import riffet.ui.design.LocalRiffetSurfaces
import riffet.ui.icons.RiffetIcons
import riffet.ui.pickers.RiffetDropdownMenu
import riffet.ui.pickers.RiffetMenuItem
import riffet.ui.pickers.RiffetMenuLabel
import riffet.ui.pickers.RiffetMenuSeparator
import riffet.ui.pickers.RiffetMenuText
import riffet.ui.session.RenameSessionDialog
import riffet.ui.session.backendName
import riffet.ui.state.SessionStore
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet.ui.theme.LocalRiffetMotion
import riffet.ui.timeline.instantMillis
import riffet.ui.timeline.localDayStart
import riffet.ui.timeline.rememberTickingNow
import riffet_mobile.shared.generated.resources.*

/** Typing pauses this long before the message index is read. */
private const val SEARCH_DEBOUNCE_MILLIS = 150L

/** The cache returns at most this many messages (`TimelineCache.SEARCH_LIMIT`); reaching it means there are more. */
private const val SEARCH_SHOWN = 60

/** Past this row, a return to the top first jumps to [NEAR_ROW] so the glide stays short. */
private const val FAR_ROW = 15
private const val NEAR_ROW = 8

/** The lazy list's content types: rows of one type share their slots when they scroll. */
private const val ITEM_SEARCH = "search"
private const val ITEM_CHIPS = "chips"
private const val ITEM_SESSION = "session"
private const val ITEM_SECTION = "section"
private const val ITEM_PROJECT = "project"
private const val ITEM_EMPTY = "empty"
private const val ITEM_MORE = "more"
private const val ITEM_HIT = "hit"

/** A value kept by plain reference, so a fading surface can hold what it last showed. */
private class Held<T>(var value: T)

/** New rows fade in at their final positions; replaced filter results leave immediately. */
@Composable
private fun LazyItemScope.listItemMotion(): Modifier {
    val motion = LocalRiffetMotion.current
    return Modifier.animateItem(fadeInSpec = motion.effects(), placementSpec = null, fadeOutSpec = null)
}

/*
 * The 任务 tab: the conversation list as a full page, the Android form of the iPhone's
 * `SessionHomeView`. It used to be the workbench's left drawer (the web's `Sidebar.tsx` inside the
 * mobile `Dialog`); the rows, the two layouts and the archive rules are unchanged.
 *
 * Search and filters lead the list and scroll with it in every material. Once the field leaves
 * the viewport, the top bar offers a search action that brings it back.
 *
 * Long-press on a row opens a menu with the agent, the project, the last activity — above rename /
 * pin / archive.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionList(
    store: SessionStore,
    preferences: AppPreferences,
    selectedSessionId: String?,
    /** The drawer's project scope, a sidebar group id; null is every project. */
    scope: String?,
    onSelectSession: (Session) -> Unit,
    /** A message found by the search box: open its conversation at it. */
    onOpenHit: (IndexHit) -> Unit,
    /** A project header's +: the 新会话 tab in that project. */
    onNewSession: (Project) -> Unit,
    /** The filter menu's project scope; a project also becomes 新会话's. */
    onScope: (Project?) -> Unit,
    onOpenMenu: () -> Unit,
    onSessionAction: (SessionAction) -> Unit,
    /** The conversation whose deletion preview is loading; only its 删除… entry is disabled. */
    deletingId: String? = null,
    modifier: Modifier = Modifier,
) {
    val designMetrics = LocalInterfaceStyle.current.metrics
    val motion = LocalRiffetMotion.current
    val list by store.list.collectAsState()
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val scheme = MaterialTheme.colorScheme

    var query by rememberSaveable { mutableStateOf("") }
    var searchFocused by remember { mutableStateOf(false) }
    var filterName by rememberSaveable { mutableStateOf(SessionFilter.ALL.name) }
    val filter = sessionFilter(filterName)
    // This is a device preference, like appearance: restore it before the first frame and keep it
    // across cold launches and server changes. Saved screen state alone cannot do that.
    var layoutName by remember(preferences) {
        mutableStateOf(sidebarLayout(preferences.string(PreferenceKeys.SIDEBAR_LAYOUT)).name)
    }
    val layout = sidebarLayout(layoutName)
    var collapsedRaw by rememberSaveable { mutableStateOf("") }
    val collapsed = remember(collapsedRaw) { collapsedRaw.split(',').filter { it.isNotEmpty() }.toSet() }
    var expandedProjectsRaw by rememberSaveable { mutableStateOf("") }
    val expandedProjects = remember(expandedProjectsRaw) { expandedProjectsRaw.split(',').filter { it.isNotEmpty() }.toSet() }
    var renameTargetId by rememberSaveable { mutableStateOf<String?>(null) }

    // The titles filter as typed; the messages come from the device's index, read once typing
    // pauses. Every stored transcript is searched, with or without a connection.
    var hits by remember { mutableStateOf<List<IndexHit>>(emptyList()) }
    LaunchedEffect(query) {
        val text = query.trim()
        if (text.isEmpty()) {
            hits = emptyList()
            return@LaunchedEffect
        }
        delay(SEARCH_DEBOUNCE_MILLIS)
        hits = try {
            store.searchMessages(text)
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (_: Throwable) {
            emptyList()
        }
    }

    // New criteria start from the top, where matching sessions appear. Restore the browse position
    // after clearing a query.
    val searching = query.isNotBlank()
    val listState = rememberLazyListState()
    val coroutineScope = rememberCoroutineScope()
    var requestSearchFocus by remember { mutableStateOf(false) }
    val searchOffscreen by remember { derivedStateOf { listState.firstVisibleItemIndex > 0 } }
    val browseAnchor = remember { IntArray(2) }
    // Capture the browse position only while the search field is idle.
    val searchActive = searchFocused || query.isNotEmpty() || requestSearchFocus
    val searchingNow by rememberUpdatedState(searchActive)
    LaunchedEffect(listState) {
        snapshotFlow { listState.firstVisibleItemIndex to listState.firstVisibleItemScrollOffset }
            .collect { (index, offset) ->
                if (!searchingNow && !requestSearchFocus) {
                    browseAnchor[0] = index
                    browseAnchor[1] = offset
                }
            }
    }
    val browseCriteria = listOf(filterName, scope.orEmpty(), layoutName).joinToString("\u0000")
    var shownBrowseCriteria by rememberSaveable { mutableStateOf(browseCriteria) }
    val criteria = "$query\u0000$browseCriteria"
    var shownCriteria by rememberSaveable { mutableStateOf(criteria) }
    var shownSearching by rememberSaveable { mutableStateOf(searching) }
    LaunchedEffect(criteria) {
        if (criteria == shownCriteria) return@LaunchedEffect
        val browseChanged = browseCriteria != shownBrowseCriteria
        val leftSearch = shownSearching && !searching
        shownCriteria = criteria
        shownBrowseCriteria = browseCriteria
        shownSearching = searching
        if (leftSearch && !browseChanged) listState.scrollToItem(browseAnchor[0], browseAnchor[1])
        else listState.scrollToItem(0)
    }
    // Back leaves search before it leaves the tab. The
    // keyboard takes the first back press itself, as everywhere else.
    val focusManager = LocalFocusManager.current
    PageBackHandler(enabled = searchActive, inline = true) {
        query = ""
        focusManager.clearFocus()
    }

    // Tapping the current tab again returns to the top; a long way down, jump near it first so the
    // glide stays short.
    val reselected = LocalTabChrome.current?.reselected ?: 0
    var seenReselected by remember { mutableIntStateOf(reselected) }
    LaunchedEffect(reselected) {
        if (reselected == seenReselected) return@LaunchedEffect
        seenReselected = reselected
        if (listState.firstVisibleItemIndex > FAR_ROW) listState.scrollToItem(NEAR_ROW)
        listState.animateScrollToItem(0)
    }

    // Relative times move by the minute; one shared clock keeps every row from reading its own.
    val now = rememberTickingNow(active = true, intervalMillis = 60_000L)
    // The time bands share one "today", like the web's `timeline` memo, so a session cannot land in
    // 今天 while a recomposition mid-list puts a later one in 昨天. `dayStart` only moves when the
    // local day rolls over, which is exactly when the bands have to be rebuilt.
    val dayStart = localDayStart(now)
    val environment = rememberResourceEnvironment()
    val keptOpen = selectedSessionId.takeIf { filter == SessionFilter.UNREAD }
    val content = remember(list.projects, list.sessions, query, filter, scope, layout, dayStart, environment, keptOpen) {
        sessionListContent(list.projects, list.sessions, query, filter, scope, layout, dayStart, keptOpen)
    }
    val projectNames = remember(list.projects) { list.projects.associate { it.id to it.name } }
    val sessionsById = remember(list.sessions) { list.sessions.associateBy { it.id } }
    // The scope picks one sidebar group; only live ones are offered.
    val scopes = remember(list.projects, list.sessions, environment) {
        visibleGroups(list.projects, list.sessions, "", false).map { it.project }
    }
    val scopeName = scope?.let { id -> scopes.firstOrNull { it.id == id }?.name }
    var scopeSheet by remember { mutableStateOf(false) }

    // Every section renders the same row. A project group already says whose sessions these are,
    // so its rows name their agent instead; everywhere else a row names its project.
    val sessionRows: LazyListScope.(List<Session>, String?) -> Unit = { sessions, group ->
        items(sessions, key = { session -> session.id }, contentType = { ITEM_SESSION }) { session ->
            SessionRow(
                session = session,
                selected = session.id == selectedSessionId,
                projectName = group ?: projectNames[session.projectId],
                showProject = group == null,
                now = now,
                modifier = listItemMotion(),
                onOpen = { onSelectSession(session) },
                onPin = { pinned -> onSessionAction(SessionAction.Pin(session, pinned)) },
                onRename = { renameTargetId = session.id },
                onArchive = { archived -> onSessionAction(SessionAction.Archive(session, archived)) },
                onDelete = if (list.canDeleteSessions) ({ onSessionAction(SessionAction.Delete(session)) }) else null,
                deleteEnabled = deletingId == null,
            )
        }
    }

    // The rows of the list: browse shows the layout's groups or bands, results the same rows
    // narrowed by the query with the matching messages last.
    val listBody: LazyListScope.(SessionListContent, List<IndexHit>) -> Unit = { body, messageHits ->
        if (body.waiting.isNotEmpty()) {
            item(key = "section:waiting", contentType = ITEM_SECTION) { SectionLabel(stringResource(Res.string.session_band_waiting), listItemMotion()) }
            sessionRows(body.waiting, null)
        }
        if (body.pinned.isNotEmpty()) {
            item(key = "section:pinned", contentType = ITEM_SECTION) { SectionLabel(stringResource(Res.string.session_band_pinned), listItemMotion()) }
            sessionRows(body.pinned, null)
        }
        if (layout == SidebarLayout.TIME) {
            // No project rows and no collapse state, exactly like the web's time layout.
            body.buckets.forEach { bucket ->
                // A translated band label must not replace the lazy item's identity.
                item(key = "bucket:${timeBucketKey(bucket.sessions.first(), dayStart)}", contentType = ITEM_SECTION) { TimeBucketLabel(bucket, dayStart, listItemMotion()) }
                sessionRows(bucket.sessions, null)
            }
        } else {
            body.groups.forEach { group ->
                val open = group.forceOpen || group.project.id !in collapsed
                item(key = "project:${group.project.id}", contentType = ITEM_PROJECT) {
                    ProjectHeader(
                        project = group.project,
                        open = open,
                        onToggle = { collapsedRaw = toggleCollapsed(collapsedRaw, group.project.id) },
                        onNewSession = if (group.project.system == "task-workspace") null else ({ onNewSession(group.project) }),
                        modifier = listItemMotion(),
                    )
                }
                if (open) {
                    if (group.sessions.isEmpty()) {
                        item(key = "empty:${group.project.id}", contentType = ITEM_EMPTY) {
                            Text(
                                text = stringResource(Res.string.session_project_empty),
                                style = typography.subhead,
                                color = colors.fg3,
                                modifier = listItemMotion().padding(start = designMetrics.pageInset + designMetrics.controlInset / 3,
                                    top = designMetrics.controlInset / 3, bottom = designMetrics.controlInset),
                            )
                        }
                    }
                    val active = group.sessions.count { isActiveSession(it) }
                    val limit = maxOf(5, active)
                    val showAll = group.forceOpen || group.sessions.size <= limit || group.project.id in expandedProjects
                    val visibleSessions = if (showAll) {
                        group.sessions
                    } else {
                        val head = group.sessions.take(limit)
                        val current = selectedSessionId?.let { id -> group.sessions.firstOrNull { it.id == id } }
                        if (current != null && head.none { it.id == current.id }) head + current else head
                    }
                    val hiddenCount = group.sessions.size - visibleSessions.size
                    val canCollapse = !group.forceOpen && group.sessions.size > limit && group.project.id in expandedProjects
                    sessionRows(visibleSessions, group.project.name)
                    if (hiddenCount > 0 || canCollapse) {
                        item(key = "more:${group.project.id}", contentType = ITEM_MORE) {
                            Text(
                                text = if (hiddenCount > 0) stringResource(Res.string.session_expand_remaining, hiddenCount) else stringResource(Res.string.session_collapse_history),
                                style = typography.label,
                                color = colors.accent,
                                modifier = listItemMotion()
                                    .fillMaxWidth()
                                    .heightIn(min = designMetrics.controlHeight)
                                    .clickable(role = Role.Button) { expandedProjectsRaw = toggleCollapsed(expandedProjectsRaw, group.project.id) }
                                    .padding(start = TextColumnInset, end = designMetrics.pageInset,
                                        top = designMetrics.rowPadding * 7 / 8, bottom = designMetrics.rowPadding * 7 / 8),
                            )
                        }
                    }
                }
            }
        }
        if (messageHits.isNotEmpty()) {
            item(key = "section:hits", contentType = ITEM_SECTION) {
                SectionLabel(stringResource(Res.string.session_messages_count, if (messageHits.size >= SEARCH_SHOWN) "${messageHits.size}+" else "${messageHits.size}"), listItemMotion())
            }
            items(messageHits, key = { hit -> "hit:${hit.sessionId}:${hit.sequence}" }, contentType = { ITEM_HIT }) { hit ->
                MessageHitRow(
                    hit = hit,
                    title = sessionsById[hit.sessionId]?.title,
                    now = now,
                    modifier = listItemMotion(),
                    onOpen = { onOpenHit(hit) },
                )
            }
        }
    }

    val emptyMessage: @Composable ColumnScope.(Boolean) -> Unit = { searchEmpty ->
        val (title, body) = when {
            list.error != null -> stringResource(Res.string.session_load_projects_failed) to list.error.orEmpty()
            searchEmpty -> stringResource(Res.string.session_no_match) to null
            filter != SessionFilter.ALL || scope != null -> stringResource(Res.string.session_list_empty) to null
            layout == SidebarLayout.TIME && list.sessions.any { it.archivedAt != null && it.backendId != NativeBackendId.CHAT } ->
                stringResource(Res.string.session_all_sessions_archived) to null
            layout == SidebarLayout.TIME -> stringResource(Res.string.session_no_sessions) to null
            list.projects.any { it.archivedAt != null && !it.isQuickChat } -> stringResource(Res.string.session_all_projects_archived) to null
            else -> stringResource(Res.string.session_no_projects) to null
        }
        Text(text = title, style = typography.body, color = scheme.onSurfaceVariant, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(top = 48.dp))
        if (body != null) {
            Spacer(Modifier.height(8.dp))
            Text(text = body, style = typography.caption, color = scheme.onSurfaceVariant, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp))
        }
    }

    val barTitle = scopeName ?: stringResource(Res.string.session_tab_tasks)
    val chips = SessionFilter.entries.map { option -> ChipItem(option.name, filterLabel(option)) }
    val header: @Composable () -> Unit = {
        TabTopBar(
            title = barTitle,
            onOpenMenu = onOpenMenu,
            background = if (materialBackdropEnabled) Color.Transparent else null,
            actions = {
                if (searchOffscreen) {
                    PageBarAction(
                        RiffetIcons.Search,
                        stringResource(Res.string.session_search_placeholder),
                        onClick = {
                            coroutineScope.launch {
                                requestSearchFocus = true
                                listState.scrollToItem(0)
                            }
                        },
                        tint = colors.fg,
                    )
                }
                ListMenu(
                    layout = layout,
                    onSelectLayout = { choice ->
                        preferences.setString(PreferenceKeys.SIDEBAR_LAYOUT, choice.name)
                        layoutName = choice.name
                    },
                    onMarkAllSeen = {
                        coroutineScope.launch {
                            try {
                                store.markAllSeen()
                            } catch (cancellation: CancellationException) {
                                throw cancellation
                            } catch (failure: Throwable) {
                                store.reportListError(failure.message?.takeIf { it.isNotBlank() } ?: getString(Res.string.app_operation_failed))
                            }
                        }
                    },
                )
            },
        )

        // The banner keeps its text while it collapses.
        val showOffline = list.error != null && list.projects.isNotEmpty()
        // The lists still on screen are the device's copy; say how old, then why.
        val savedAt = list.cachedAt
        val offlineNow = rememberTickingNow(active = showOffline && savedAt != null, intervalMillis = 60_000L)
        val offlineText = if (showOffline) {
            savedAt?.let {
                if (isJustNow(it, offlineNow)) stringResource(Res.string.session_offline_just_saved)
                else stringResource(Res.string.session_offline_saved_age, relativeTimeLabel(it, offlineNow))
            } ?: list.error.orEmpty()
        } else null
        val offlineHeld = remember { Held("") }
        if (offlineText != null) offlineHeld.value = offlineText
        AnimatedVisibility(visible = showOffline, enter = motion.expandIn(), exit = motion.collapseOut()) {
            Text(
                text = offlineHeld.value,
                style = typography.caption,
                color = scheme.error,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = designMetrics.controlHeight)
                    .clickable(onClickLabel = stringResource(Res.string.session_retry), role = Role.Button) { store.refresh() }
                    .padding(horizontal = designMetrics.pageInset, vertical = designMetrics.controlInset * 2 / 3),
            )
        }
    }

    val body: @Composable (PaddingValues) -> Unit = { chromeInsets ->
        PullToRefreshBox(
            isRefreshing = list.loading && list.loaded,
            onRefresh = { store.refresh() },
            modifier = Modifier.fillMaxSize(),
        ) {
            RiffetMaterialSourceContent {
                LazyColumn(
                    state = listState,
                    modifier = Modifier.fillMaxSize().then(if (LocalPageActive.current) Modifier.riffetMaterialSource(key = listState) else Modifier),
                    contentPadding = PaddingValues(top = chromeInsets.calculateTopPadding(), bottom = chromeInsets.calculateBottomPadding() + designMetrics.controlInset + LocalTabContentBottomPadding.current),
                ) {
                    item(key = ITEM_SEARCH, contentType = ITEM_SEARCH) {
                        SearchField(
                            query = query,
                            onQueryChange = { query = it },
                            onFocusChange = { focused ->
                                searchFocused = focused
                                if (focused) requestSearchFocus = false
                            },
                            requestFocus = requestSearchFocus,
                        )
                    }
                    item(key = ITEM_CHIPS, contentType = ITEM_CHIPS) {
                        ChipRow(
                            items = chips,
                            selected = filterName,
                            onSelect = { filterName = it },
                            leading = {
                                ChipButton(label = scopeName ?: stringResource(Res.string.session_projects), active = scopeName != null,
                                    icon = RiffetIcons.Folder, onClick = { scopeSheet = true })
                            },
                            contentPadding = PaddingValues(start = designMetrics.pageInset, end = designMetrics.pageInset,
                                top = designMetrics.controlInset, bottom = designMetrics.controlInset / 2),
                        )
                    }
                    when {
                        list.loading && !list.loaded -> item(key = "loading", contentType = ITEM_EMPTY) {
                            Box(listItemMotion().fillMaxWidth().padding(top = 48.dp), contentAlignment = Alignment.TopCenter) {
                                CircularProgressIndicator(modifier = Modifier.size(designMetrics.iconSize), strokeWidth = 2.5.dp, color = colors.accent)
                            }
                        }

                        searching && content.isEmpty && hits.isEmpty() ->
                            item(key = "none", contentType = ITEM_EMPTY) { Column(listItemMotion()) { emptyMessage(true) } }

                        searching -> listBody(content, hits)

                        content.isEmpty -> item(key = "none", contentType = ITEM_EMPTY) { Column(listItemMotion()) { emptyMessage(false) } }

                        else -> listBody(content, emptyList())
                    }
                }
            }
        }
    }

    riffet.ui.app.RiffetPageScaffold(
        modifier = modifier,
        topBar = { header() },
    ) { chromeInsets -> body(chromeInsets) }

    if (scopeSheet) {
        ProjectPickerSheet(
            projects = scopes,
            selectedId = scope,
            onSelect = onScope,
            onDismiss = { scopeSheet = false },
            allLabel = stringResource(Res.string.session_all_projects),
        )
    }

    val renameSession = renameTargetId?.let { id -> list.sessions.firstOrNull { it.id == id } }
    if (renameSession != null) {
        RenameSessionDialog(
            initial = renameSession.title,
            onDismiss = { renameTargetId = null },
            onConfirm = { title ->
                renameTargetId = null
                if (title.isNotEmpty() && title != renameSession.title) onSessionAction(SessionAction.Rename(renameSession, title))
            },
        )
    }
}

/**
 * The search field: a filled 48dp pill with a leading glyph and a clear button once there is text.
 * The whole pill takes a tap; [onFocusChange] reports focus anywhere inside it.
 */
@Composable
private fun SearchField(
    query: String,
    onQueryChange: (String) -> Unit,
    onFocusChange: (Boolean) -> Unit,
    requestFocus: Boolean,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    RiffetSearchField(
        query = query,
        onQueryChange = onQueryChange,
        placeholder = stringResource(Res.string.session_search_placeholder),
        clearDescription = stringResource(Res.string.session_clear_search),
        onFocusChange = onFocusChange,
        requestFocus = requestFocus,
        modifier = Modifier.padding(start = metrics.pageInset, end = metrics.pageInset, bottom = metrics.controlInset / 3),
    )
}

/** A filter chip's label. */
@Composable
private fun filterLabel(option: SessionFilter): String = when (option) {
    SessionFilter.ALL -> stringResource(Res.string.session_filter_all)
    SessionFilter.RUNNING -> stringResource(Res.string.session_state_running)
    SessionFilter.WAITING -> stringResource(Res.string.session_band_waiting)
    SessionFilter.UNREAD -> stringResource(Res.string.session_filter_unread)
    SessionFilter.QUICK_CHAT -> stringResource(Res.string.session_mode_chat)
    SessionFilter.ARCHIVED -> stringResource(Res.string.session_archived)
}

/** The app bar's menu: how the list is arranged, and mark all as seen. The project scope is the chip ahead of the filters. */
@Composable
private fun ListMenu(
    layout: SidebarLayout,
    onSelectLayout: (SidebarLayout) -> Unit,
    onMarkAllSeen: () -> Unit,
) {
    val colors = LocalRiffetColors.current
    // Not `rememberSaveable`: a saved `true` would reappear open after a rotation nobody asked for.
    var menuOpen by remember { mutableStateOf(false) }
    Box {
        PageBarAction(RiffetIcons.Ellipsis, stringResource(Res.string.session_display_options), onClick = { menuOpen = true }, tint = colors.fg)
        RiffetDropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }, modifier = Modifier.widthIn(min = 180.dp, max = 260.dp)) {
            RiffetMenuLabel(stringResource(Res.string.session_arrangement))
            LayoutChoice(
                label = stringResource(Res.string.session_group_by_project),
                selected = layout == SidebarLayout.PROJECT,
                onSelect = { onSelectLayout(SidebarLayout.PROJECT); menuOpen = false },
            )
            LayoutChoice(
                label = stringResource(Res.string.session_flat_by_time),
                selected = layout == SidebarLayout.TIME,
                onSelect = { onSelectLayout(SidebarLayout.TIME); menuOpen = false },
            )
            RiffetMenuSeparator()
            RiffetMenuItem(stringResource(Res.string.session_mark_all_seen), onClick = { onMarkAllSeen(); menuOpen = false })
        }
    }
}

/** One found message: whose and when above the matched words. */
@Composable
private fun MessageHitRow(hit: IndexHit, title: String?, now: Long, modifier: Modifier, onOpen: () -> Unit) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val who = when (hit.role) {
        IndexRole.USER -> stringResource(Res.string.session_hit_user)
        IndexRole.ASSISTANT -> "Agent"
        IndexRole.TOOL -> stringResource(Res.string.session_hit_tool)
    }
    val snippet = remember(hit, colors.accent) {
        buildAnnotatedString {
            append(hit.snippet)
            for (range in hit.highlights) {
                if (range.first < 0 || range.last >= hit.snippet.length) continue
                addStyle(SpanStyle(color = colors.accent, fontWeight = FontWeight.SemiBold), range.first, range.last + 1)
            }
        }
    }
    val owner = title ?: stringResource(Res.string.session_hit_unlisted)
    Column(
        modifier = modifier
            .fillMaxWidth()
            .clickable(role = Role.Button, onClick = onOpen)
            .padding(horizontal = metrics.pageInset + metrics.controlInset / 3,
                vertical = metrics.rowPadding * 5 / 8),
    ) {
        Text(
            text = listOfNotNull(owner, who, relativeTimeLabel(hit.createdAt, now)).joinToString(" · "),
            style = typography.caption,
            color = colors.fg3,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Text(text = snippet, style = typography.subhead, color = colors.fg, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}

/** A session row's least height, its avatar, and the gap between the avatar and the text. */
private val RowHeight = 68.dp
private val AvatarSize = 44.dp
private val RowShape
    @Composable get() = RoundedCornerShape(LocalInterfaceStyle.current.rowRadius)

/** Where the text column starts: the row's 16dp inset, the avatar and the 12dp gap. */
private val TextColumnInset = 16.dp + AvatarSize + 12.dp

/** One 排列方式 row: the web's `DropdownMenuRadioItem`, down to the trailing check column. */
@Composable
private fun LayoutChoice(label: String, selected: Boolean, onSelect: () -> Unit) {
    val colors = LocalRiffetColors.current
    RiffetMenuItem(onClick = onSelect, showCheck = true, selected = selected) {
        Text(text = label, style = RiffetMenuText, color = colors.fg, modifier = Modifier.weight(1f))
    }
}

/**
 * One band's label in the time layout. The client groups bands with `timeBucketLabel` in the
 * source locale; that string is an opaque grouping key here, so re-apply the same rule to the
 * band's first session and pick a resource instead of matching Chinese text. Keep this in step
 * with `SidebarModel.timeBucketLabel`.
 */
@Composable
internal fun TimeBucketLabel(bucket: TimeBucket, dayStartMillis: Long, modifier: Modifier = Modifier) {
    val session = bucket.sessions.firstOrNull() ?: return
    val text = when {
        session.pinnedAt != null -> stringResource(Res.string.session_band_pinned)
        isActiveSession(session) -> stringResource(Res.string.session_band_active)
        else -> {
            val day = 86_400_000L
            when (val at = instantMillis(activityAt(session))) {
                null -> stringResource(Res.string.session_band_earlier)
                else -> when {
                    at >= dayStartMillis -> stringResource(Res.string.session_band_today)
                    at >= dayStartMillis - day -> stringResource(Res.string.session_band_yesterday)
                    at >= dayStartMillis - 6 * day -> stringResource(Res.string.session_band_last_7_days)
                    at >= dayStartMillis - 29 * day -> stringResource(Res.string.session_band_last_30_days)
                    else -> stringResource(Res.string.session_band_earlier)
                }
            }
        }
    }
    SectionLabel(text, modifier)
}

/** A list subheader: the time bands, 待处理, 置顶 and the message hits. */
@Composable
private fun SectionLabel(text: String, modifier: Modifier = Modifier) {
    val metrics = LocalInterfaceStyle.current.metrics
    Text(
        text = text,
        style = LocalRiffetTypography.current.footnote,
        color = LocalRiffetColors.current.fg3,
        maxLines = 1,
        modifier = modifier.fillMaxWidth().padding(start = metrics.pageInset + metrics.controlInset / 3,
            end = metrics.pageInset + metrics.controlInset / 3,
            top = (metrics.sectionGap - metrics.controlInset / 6).coerceAtLeast(0.dp), bottom = metrics.controlInset / 2),
    )
}

/** A project's subheader: the whole row folds it, + starts a session there. */
@Composable
private fun ProjectHeader(
    project: Project,
    open: Boolean,
    onToggle: () -> Unit,
    onNewSession: (() -> Unit)?,
    modifier: Modifier = Modifier,
) {
    val designMetrics = LocalInterfaceStyle.current.metrics
    val motion = LocalRiffetMotion.current
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val title = project.name
    val chevron by animateFloatAsState(if (open) 90f else 0f, motion.spatial(), label = "project-chevron")
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clickable(role = Role.Button, onClick = onToggle)
            .padding(start = designMetrics.pageInset + designMetrics.controlInset / 3,
                end = designMetrics.controlInset, top = designMetrics.controlInset),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = title,
            style = typography.footnote,
            color = colors.fg3,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (project.archivedAt != null) {
            Text(text = stringResource(Res.string.session_archived), style = typography.caption, color = colors.fg3, modifier = Modifier.padding(horizontal = 8.dp))
        }
        if (onNewSession != null) Box(
            modifier = Modifier.size(designMetrics.controlHeight).clip(RoundedCornerShape(LocalInterfaceStyle.current.controlRadius)).clickable(role = Role.Button, onClick = onNewSession),
            contentAlignment = Alignment.Center,
        ) {
            Icon(RiffetIcons.Plus, contentDescription = stringResource(Res.string.session_new_session_in, title), tint = colors.fg3, modifier = Modifier.size(designMetrics.smallIconSize))
        }
        Box(modifier = Modifier.size(32.dp), contentAlignment = Alignment.Center) {
            Icon(
                imageVector = RiffetIcons.ChevronRight,
                contentDescription = if (open) stringResource(Res.string.session_collapse_named, title) else stringResource(Res.string.session_expand_named, title),
                tint = colors.fg3,
                modifier = Modifier.size(designMetrics.smallIconSize).graphicsLayer { rotationZ = chevron },
            )
        }
    }
}

/**
 * One conversation: its avatar (the state rides on it), the title and the time above a line that
 * leads with the state in words and ends with where it runs. The selected row, in the two-pane
 * layout, takes a rounded fill inset from the page's edges.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun SessionRow(
    session: Session,
    selected: Boolean,
    now: Long,
    onOpen: () -> Unit,
    onPin: (Boolean) -> Unit,
    onRename: () -> Unit,
    onArchive: (Boolean) -> Unit,
    /** Opens the delete confirmation; null when the server cannot delete. */
    onDelete: (() -> Unit)? = null,
    deleteEnabled: Boolean = true,
    /** Where the conversation lives: the long-press menu's header, and the detail line when [showProject]. */
    projectName: String? = null,
    /** False under a project's own heading, where the detail line names the agent instead. */
    showProject: Boolean = true,
    /** Has at least one saved reply (收藏). */
    marked: Boolean = false,
    modifier: Modifier = Modifier,
) {
    val motion = LocalRiffetMotion.current
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val page = LocalRiffetSurfaces.current.page
    val haptics = LocalHapticFeedback.current
    var menuOpen by remember { mutableStateOf(false) }
    val archived = session.archivedAt != null
    // Where the finger last went down, and the row's height: the menu opens at the touch. Read only
    // when the menu opens, so neither is state.
    val press = remember { floatArrayOf(Float.NaN, 0f, 0f) }
    val density = LocalDensity.current

    // The row is the menu's anchor, so the menu opens over the row that was pressed.
    Box(
        modifier = modifier
            .fillMaxWidth()
            .onSizeChanged { press[2] = it.height.toFloat() }
            // Watching the initial pass sees the touch without taking it from the row's own gestures.
            .pointerInput(Unit) {
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                    press[0] = down.position.x
                    press[1] = down.position.y
                }
            },
    ) {
        val container by animateColorAsState(
            targetValue = if (selected) LocalRiffetSurfaces.current.selected else Color.Transparent,
            animationSpec = motion.effects(),
            label = "session-row-container",
        )
        val word = when (session.state) {
            SessionState.RUNNING, SessionState.STARTING, SessionState.CANCELLING -> stringResource(Res.string.session_state_running)
            SessionState.WAITING -> stringResource(Res.string.session_waiting_for_you)
            SessionState.FAILED -> stringResource(Res.string.session_failed)
            SessionState.IDLE, SessionState.INTERRUPTED, SessionState.ARCHIVED -> null
        }
        val wordColor = when (session.state) {
            SessionState.WAITING -> colors.warning
            SessionState.FAILED -> colors.danger
            else -> colors.accent
        }
        val failure = session.error?.lineSequence()?.firstOrNull { it.isNotBlank() }?.trim()
        val backend = backendName(session.backendId)
        // A failure says what failed; otherwise the project, or under its own heading the agent.
        val detail = when {
            session.state == SessionState.FAILED && failure != null -> failure
            showProject && projectName != null -> projectName
            else -> backend
        }
        val subtitle = remember(word, wordColor, detail) {
            buildAnnotatedString {
                if (word != null) {
                    withStyle(SpanStyle(color = wordColor, fontWeight = FontWeight.Medium)) { append(word) }
                    append(" · ")
                }
                append(detail)
            }
        }
        val backendId = session.backendId ?: NativeBackendId.CURSOR
        val time = relativeTimeLabel(activityAt(session), now)
        val timeStyle = remember(typography) { typography.caption.copy(fontFeatureSettings = "tnum") }
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = metrics.controlInset * 2 / 3)
                .semantics { this.selected = selected }
                .clip(RowShape)
                .drawBehind { drawRect(container) }
                .combinedClickable(
                    role = Role.Tab,
                    onClick = onOpen,
                    onLongClickLabel = stringResource(Res.string.session_info_actions),
                    onLongClick = {
                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                        menuOpen = true
                    },
                )
                .heightIn(min = RowHeight)
                .padding(horizontal = metrics.controlInset * 2 / 3, vertical = metrics.rowPadding * 5 / 8),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(metrics.controlInset),
        ) {
            AgentAvatar(
                backendId = backendId.name.lowercase(),
                tint = agentMarkTint(backendId, colors),
                status = avatarStatus(session.state),
                // The colour the status dot is cut out of: the page, or the selected row's fill on it.
                ring = if (selected) container.compositeOver(page) else page,
                size = AvatarSize,
            )
            Column(modifier = Modifier.weight(1f)) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        text = session.title,
                        style = typography.headline,
                        color = if (selected) LocalRiffetSurfaces.current.selectedContent else if (archived) colors.fg2 else colors.fg,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f).alignByBaseline(),
                    )
                    if (marked) {
                        Icon(RiffetIcons.Bookmark, contentDescription = null, tint = colors.accent, modifier = Modifier.size(14.dp).alignBy { it.measuredHeight })
                    }
                    if (!selected && isDoneUnseen(session)) {
                        val unread = stringResource(Res.string.session_filter_unread)
                        Box(Modifier.align(Alignment.CenterVertically).size(6.dp).background(colors.fg, CircleShape).semantics { contentDescription = unread })
                    }
                    if (time != null) {
                        Text(text = time, style = timeStyle, color = colors.fg3, maxLines = 1, modifier = Modifier.alignByBaseline())
                    }
                }
                Text(
                    text = subtitle,
                    style = typography.subhead,
                    color = colors.fg3,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(top = 2.dp),
                )
            }
        }
        RiffetDropdownMenu(
            expanded = menuOpen,
            onDismissRequest = { menuOpen = false },
            // The menu hangs below the row's bottom edge: back up by the row, then down to the touch.
            offset = if (press[0].isNaN()) DpOffset(16.dp, (-8).dp) else with(density) {
                DpOffset(press[0].toDp(), (press[1] - press[2]).toDp())
            },
            modifier = Modifier.width(248.dp),
        ) {
            // What the row leaves out to keep the list to titles: the whole title, who runs it,
            // where, and when it last moved.
            Column(modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 4.dp)) {
                Text(
                    text = session.title,
                    style = typography.body.copy(lineHeight = 22.sp),
                    fontWeight = FontWeight.Medium,
                    color = colors.fg,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                )
                Spacer(Modifier.height(4.dp))
                Text(
                    text = listOfNotNull(backendName(session.backendId), projectName).joinToString(" · "),
                    style = typography.bodySmall,
                    color = colors.fg2,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                relativeTimeActivity(activityAt(session), now)?.let { time ->
                    Text(
                        text = time,
                        style = typography.bodySmall,
                        color = colors.fg3,
                        maxLines = 1,
                    )
                }
            }
            RiffetMenuSeparator()
            RiffetMenuItem(text = stringResource(Res.string.session_rename), icon = RiffetIcons.Pencil, onClick = { menuOpen = false; onRename() })
            RiffetMenuItem(
                text = if (session.pinnedAt == null) stringResource(Res.string.session_pin) else stringResource(Res.string.session_unpin),
                icon = if (session.pinnedAt == null) RiffetIcons.Pin else RiffetIcons.PinOff,
                onClick = { menuOpen = false; onPin(session.pinnedAt == null) },
            )
            RiffetMenuItem(
                text = if (archived) stringResource(Res.string.session_restore) else stringResource(Res.string.session_archive),
                icon = if (archived) RiffetIcons.ArchiveRestore else RiffetIcons.Archive,
                onClick = { menuOpen = false; onArchive(!archived) },
            )
            if (onDelete != null) {
                RiffetMenuItem(
                    text = stringResource(Res.string.session_delete_menu),
                    icon = RiffetIcons.Trash,
                    danger = true,
                    enabled = deleteEnabled,
                    onClick = { menuOpen = false; onDelete() },
                )
            }
        }
    }
}

/** What a row's avatar says about the conversation's state. */
private fun avatarStatus(state: SessionState): AvatarStatus = when (state) {
    SessionState.RUNNING, SessionState.STARTING, SessionState.CANCELLING -> AvatarStatus.RUNNING
    SessionState.WAITING -> AvatarStatus.WAITING
    SessionState.FAILED -> AvatarStatus.FAILED
    SessionState.IDLE, SessionState.INTERRUPTED, SessionState.ARCHIVED -> AvatarStatus.NONE
}

/**
 * The palette's agent colour for a row's mark. Codex ignores it (its mark keeps the brand
 * gradient inside [AgentMark]); droid, traex and pi have no palette role yet, so droid takes
 * the foreground, traex its brand green, and pi its shipped colours.
 */
private fun agentMarkTint(backendId: NativeBackendId, colors: RiffetColors): Color = when (backendId) {
    NativeBackendId.CURSOR -> colors.agentCursor
    NativeBackendId.CLAUDE -> colors.agentClaude
    NativeBackendId.DSH -> colors.agentDsh
    NativeBackendId.TRAEX -> Color(0xFF00A862)
    NativeBackendId.DROID -> colors.fg
    NativeBackendId.CODEX -> colors.fg2
    NativeBackendId.CHAT -> colors.fg2
    NativeBackendId.PI -> colors.fg2
    NativeBackendId.ANTIGRAVITY -> colors.fg2
}
