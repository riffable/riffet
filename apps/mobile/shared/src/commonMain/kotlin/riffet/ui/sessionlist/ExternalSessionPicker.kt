package riffet.ui.sessionlist

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.stringResource
import riffet.contracts.ExternalSession
import riffet.contracts.ExternalSessionDirectory
import riffet.contracts.Project
import riffet.contracts.Session
import riffet.shared.RiffetApi
import riffet.shared.externalSessionDirectories
import riffet.shared.externalSessions
import riffet.ui.design.ChipItem
import riffet.ui.design.ChipRow
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.RiffetProgressIndicator
import riffet.ui.design.RiffetSearchField
import riffet.ui.design.SegmentedControl
import riffet.ui.home.tildePath
import riffet.ui.icons.AgentMarks
import riffet.ui.icons.RiffetIcons
import riffet.ui.pickers.AnimatedSheetNotice
import riffet.ui.pickers.LocalPickerHost
import riffet.ui.pickers.OptionRow
import riffet.ui.pickers.PickerPage
import riffet.ui.pickers.PickerSheetFrame
import riffet.ui.pickers.SheetInset
import riffet.ui.pickers.ToggleRow
import riffet.ui.settings.SettingsNoticeKind
import riffet.ui.state.SessionStore
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet.ui.timeline.instantMillis
import riffet.ui.timeline.platformNowMillis
import riffet_mobile.shared.generated.resources.Res
import riffet_mobile.shared.generated.resources.external_directory_missing
import riffet_mobile.shared.generated.resources.external_empty
import riffet_mobile.shared.generated.resources.external_import_title
import riffet_mobile.shared.generated.resources.external_include_non_interactive
import riffet_mobile.shared.generated.resources.external_in_terminal
import riffet_mobile.shared.generated.resources.external_scope_all
import riffet_mobile.shared.generated.resources.external_scope_directory
import riffet_mobile.shared.generated.resources.external_scope_project
import riffet_mobile.shared.generated.resources.external_search_placeholder
import riffet_mobile.shared.generated.resources.session_clear_search

private const val PAGE_SIZE = 30
private const val SEARCH_DEBOUNCE_MILLIS = 300L
private const val SCOPE_PROJECT = "project"
private const val SCOPE_DIRECTORY = "directory"
private const val SCOPE_ALL = "all"
private val AGENTS = listOf("claude" to "Claude", "codex" to "Codex")

/**
 * Provider conversations found on the server's machine (docs/TERMINAL-SESSIONS.md), listed from the
 * provider's own files; choosing one imports it and opens the conversation. [projectId] is the scope the sheet opens in; without one there is no project scope.
 */
@Composable
internal fun ExternalSessionPickerSheet(
    api: RiffetApi,
    store: SessionStore,
    projects: List<Project>,
    projectId: String?,
    onOpen: (Session) -> Unit,
    onDismiss: () -> Unit,
) {
    PickerSheetFrame(onDismiss = onDismiss) {
        val host = LocalPickerHost.current
        val metrics = LocalInterfaceStyle.current.metrics
        val colors = LocalRiffetColors.current
        val typography = LocalRiffetTypography.current
        val scope = rememberCoroutineScope()
        val scopes = remember(projectId) { if (projectId != null) listOf(SCOPE_PROJECT, SCOPE_DIRECTORY, SCOPE_ALL) else listOf(SCOPE_DIRECTORY, SCOPE_ALL) }
        var scopeName by rememberSaveable { mutableStateOf(if (projectId != null) SCOPE_PROJECT else SCOPE_ALL) }
        var directory by rememberSaveable { mutableStateOf<String?>(null) }
        var agent by rememberSaveable { mutableStateOf("") }
        var query by rememberSaveable { mutableStateOf("") }
        var nonInteractive by rememberSaveable { mutableStateOf(false) }

        var items by remember { mutableStateOf<List<ExternalSession>>(emptyList()) }
        var directories by remember { mutableStateOf<List<ExternalSessionDirectory>>(emptyList()) }
        var cursor by remember { mutableStateOf<String?>(null) }
        var loading by remember { mutableStateOf(true) }
        var failure by remember { mutableStateOf<String?>(null) }
        var importing by remember { mutableStateOf<String?>(null) }
        var importError by remember { mutableStateOf<String?>(null) }

        val listing = scopeName != SCOPE_DIRECTORY || directory != null
        // The directory list is filtered on the client, so its key leaves the query out.
        val key = listOf(scopeName, directory.orEmpty(), agent, nonInteractive, if (listing) query.trim() else "").joinToString("\u0000")
        val currentKey by rememberUpdatedState(key)
        val agentId = agent.takeIf { it.isNotEmpty() }

        suspend fun fetch(page: String?, forKey: String) {
            try {
                if (!listing) {
                    val read = api.externalSessionDirectories(backendId = agentId, nonInteractive = nonInteractive)
                    if (forKey == currentKey) directories = read
                } else {
                    val read = api.externalSessions(
                        scope = scopeName,
                        projectId = projectId.takeIf { scopeName == SCOPE_PROJECT },
                        cwd = directory.takeIf { scopeName == SCOPE_DIRECTORY },
                        backendId = agentId,
                        query = query,
                        nonInteractive = nonInteractive,
                        cursor = page,
                        limit = PAGE_SIZE,
                    )
                    if (forKey != currentKey) return
                    items = if (page == null) read.items else items + read.items
                    cursor = read.nextCursor
                    failure = read.failures.firstOrNull()?.message
                }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Throwable) {
                if (forKey == currentKey) failure = error.message
            } finally {
                if (forKey == currentKey) loading = false
            }
        }

        LaunchedEffect(key) {
            loading = true
            failure = null
            items = emptyList()
            cursor = null
            if (listing && query.isNotBlank()) delay(SEARCH_DEBOUNCE_MILLIS)
            fetch(null, key)
        }

        val listState = rememberLazyListState()
        val nearEnd by remember(listState) {
            derivedStateOf {
                val last = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
                last >= listState.layoutInfo.totalItemsCount - 3
            }
        }
        // Collected from a snapshot flow so that setting `loading` below cannot restart the effect.
        LaunchedEffect(listState) {
            snapshotFlow { nearEnd && !loading && listing && cursor != null }
                .distinctUntilChanged()
                .filter { it }
                .collect {
                    val next = cursor ?: return@collect
                    loading = true
                    fetch(next, currentKey)
                }
        }

        fun choose(candidate: ExternalSession) {
            if (importing != null) return
            importing = candidate.nativeSessionId
            importError = null
            scope.launch {
                try {
                    val result = store.importExternalSession(candidate.backendId, candidate.backendProfileId, candidate.nativeSessionId)
                    onOpen(result.session)
                    host?.dismiss?.invoke()
                } catch (cancellation: CancellationException) {
                    throw cancellation
                } catch (error: Throwable) {
                    importError = error.message
                } finally {
                    importing = null
                }
            }
        }

        val names = remember(projects) { projects.associate { it.id to it.name } }
        val title = if (listing && scopeName == SCOPE_DIRECTORY) directory?.trimEnd('/')?.substringAfterLast('/')?.ifEmpty { "/" }.orEmpty()
        else stringResource(Res.string.external_import_title)
        PickerPage(
            title = title,
            onBack = if (scopeName == SCOPE_DIRECTORY && directory != null) ({ directory = null }) else null,
            fullHeight = true,
        ) {
            SegmentedControl(
                options = scopes.map { name ->
                    when (name) {
                        SCOPE_PROJECT -> stringResource(Res.string.external_scope_project)
                        SCOPE_DIRECTORY -> stringResource(Res.string.external_scope_directory)
                        else -> stringResource(Res.string.external_scope_all)
                    }
                },
                selected = scopes.indexOf(scopeName),
                onSelect = { index ->
                    scopeName = scopes[index]
                    directory = null
                },
                modifier = Modifier.padding(horizontal = SheetInset, vertical = metrics.controlInset / 2),
            )
            ChipRow(
                items = listOf(ChipItem("", stringResource(Res.string.external_scope_all))) + AGENTS.map { ChipItem(it.first, it.second) },
                selected = agent,
                onSelect = { agent = it },
                contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = SheetInset, vertical = metrics.controlInset / 3),
            )
            ToggleRow(
                label = stringResource(Res.string.external_include_non_interactive),
                on = nonInteractive,
                onToggle = { nonInteractive = it },
            )
            RiffetSearchField(
                query = query,
                onQueryChange = { query = it },
                placeholder = stringResource(Res.string.external_search_placeholder),
                clearDescription = stringResource(Res.string.session_clear_search),
                modifier = Modifier.padding(horizontal = SheetInset, vertical = metrics.controlInset / 2),
            )
            AnimatedSheetNotice(importError ?: failure, SettingsNoticeKind.ERROR)
            val now = remember(items) { platformNowMillis() }
            val needle = query.trim()
            val shownDirectories = remember(directories, needle) {
                if (needle.isEmpty()) directories else directories.filter { it.cwd.contains(needle, ignoreCase = true) }
            }
            val empty = !loading && failure == null && if (listing) items.isEmpty() else shownDirectories.isEmpty()
            Box(Modifier.fillMaxWidth().weight(1f)) {
                LazyColumn(state = listState, modifier = Modifier.fillMaxSize()) {
                    if (!listing) {
                        items(shownDirectories, key = { it.cwd }) { entry ->
                            OptionRow(
                                label = entry.cwd.trimEnd('/').substringAfterLast('/').ifEmpty { "/" },
                                description = tildePath(entry.cwd),
                                icon = RiffetIcons.Folder,
                                selected = false,
                                disabledReason = if (entry.exists) null else stringResource(Res.string.external_directory_missing),
                                onClick = { directory = entry.cwd },
                                trailing = { Text(entry.count.toString(), style = typography.caption, color = colors.fg3) },
                            )
                        }
                    } else {
                        items(items, key = { "${it.backendId}\u0000${it.nativeSessionId}" }) { entry ->
                            val agentKey = entry.backendId
                            val time = instantMillis(entry.updatedAt)?.let { relativeTimeLabel(it, now) }
                            val where = when {
                                scopeName == SCOPE_PROJECT -> null
                                entry.projectId != null -> names[entry.projectId]
                                else -> tildePath(entry.cwd)
                            }
                            OptionRow(
                                label = entry.title,
                                description = listOfNotNull(where, entry.gitBranch, time).joinToString(" · "),
                                icon = AgentMarks.vector(agentKey) ?: RiffetIcons.Message,
                                iconTint = if (agentKey == "codex" || agentKey == "pi") Color.Unspecified else null,
                                selected = false,
                                disabledReason = if (entry.cwdExists) null else stringResource(Res.string.external_directory_missing),
                                onClick = { choose(entry) },
                                trailing = when {
                                    importing == entry.nativeSessionId -> ({ RiffetProgressIndicator(color = colors.accent, strokeWidth = 2.dp, modifier = Modifier.size(16.dp)) })
                                    entry.live == "terminal" -> ({ Text(stringResource(Res.string.external_in_terminal), style = typography.caption, color = colors.fg3) })
                                    else -> null
                                },
                            )
                        }
                    }
                    if (loading) item(key = "loading") {
                        Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
                            RiffetProgressIndicator(color = colors.accent, strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
                        }
                    }
                    if (empty) item(key = "empty") {
                        Text(
                            text = stringResource(Res.string.external_empty),
                            style = typography.bodySmall,
                            color = colors.fg3,
                            modifier = Modifier.fillMaxWidth().padding(24.dp),
                        )
                    }
                }
            }
        }
    }
}
