package riffet.ui.session

import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.app.PageTopBar
import riffet.ui.app.RiffetPageScaffold
import riffet.ui.app.PageBarAction

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.rememberLazyListState
import riffet.ui.icons.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import org.jetbrains.compose.resources.stringResource
import riffet.contracts.Project
import riffet.shared.DownloadCenter
import riffet.shared.RiffetApi
import riffet.shared.downloadsSupported
import riffet.ui.icons.RiffetIcons
import riffet.ui.state.SessionStore
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet.ui.timeline.prepareTranscriptMarkdown
import riffet.ui.timeline.ProcessFolds
import riffet.ui.timeline.FileAccess
import riffet.ui.timeline.LocalFileAccess
import riffet.ui.timeline.resolveFileMention
import riffet.ui.timeline.conversationFiles
import riffet.ui.focus.blurOnTap
import riffet.ui.timeline.Timeline
import riffet.ui.timeline.TimelineRhythm
import riffet.ui.timeline.layoutTimeline
import riffet.ui.timeline.TimelineLayout
import riffet.ui.timeline.subagentPresentation
import riffet_mobile.shared.generated.resources.Res
import riffet_mobile.shared.generated.resources.session_subagent_empty
import riffet_mobile.shared.generated.resources.session_subagent_finished
import riffet_mobile.shared.generated.resources.session_subagent_pending
import riffet_mobile.shared.generated.resources.session_subagent_running

/**
 * 子 Agent 的会话页: the phone's `SubagentSession.tsx`.
 *
 * A subagent is a conversation of its own, so this is the ordinary transcript again — the same
 * `Timeline`, the same folds, the same paging — over the child's events instead of the parent's, with
 * a header that says which child it is and how to get back. The web opens this as one level of an
 * overlay stack; on a phone it is a full screen, and the system's back gesture leaves it
 * ([BackHandler]).
 *
 * The child's transcript arrives live on the session stream (`SessionStore.subagents`) and starts —
 * for DSH children, which never carried their prompt as a message — with the prompt the spawning call
 * was given, injected only once the whole history is present so an older page cannot land above it.
 * That is the web's own rule; without it a DSH child page opens on an answer to nothing.
 */
@Composable
internal fun SubagentScreen(
    store: SessionStore,
    target: SubagentTarget,
    project: Project?,
    onBack: () -> Unit,
    onReturnToSession: () -> Unit,
    modifier: Modifier = Modifier,
    onOpenFile: ((path: String, line: Int?) -> Unit)? = null,
    onOpenVisualization: ((path: String) -> Unit)? = null,
    api: RiffetApi? = null,
) {
    val colors = LocalRiffetColors.current
    val interaction by store.interaction.collectAsState()
    // The child's projection and grouping run off the main thread, as on iOS (`subagentPresentation`).
    val page = remember(store, target.toolCallId) { subagentPresentation(store, target.toolCallId, prepare = ::prepareTranscriptMarkdown) }
        .collectAsState(initial = null).value?.takeIf { it.toolCallId == target.toolCallId }
    val transcript = page?.transcript
    val loading by store.loadingSubagent.collectAsState()
    val error by store.subagentError.collectAsState()
    val listState = rememberLazyListState()
    val folds = remember(target.toolCallId) { ProcessFolds() }
    // Keyed by the child: opening another subagent must not inherit this one's folds or scroll.
    val previous = remember(target.toolCallId) { PreviousTimeline() }
    val items = page?.items.orEmpty()
    val running = page?.running == true
    val entering = !riffet.ui.app.LocalPageContentReady.current
    val grouping = page?.grouping.takeUnless { entering }
    // The gaps are baked into the entries, so a new 会话间距 lays the transcript out again.
    val spacing = TimelineRhythm.scale
    val layout = remember(grouping, entering, folds, folds.version, spacing) {
        if (entering) previous.layout ?: TimelineLayout(emptyList(), IntArray(0))
        else {
            val rows = grouping?.rows.orEmpty()
            folds.sync(rows)
            layoutTimeline(rows, previous.layout, folds::isOpen).also { previous.layout = it }
        }
    }

    // The instance stays put while the lane streams (`LocalFileAccess` is static); a tap reads the latest rows.
    val latestRows = rememberUpdatedState(items)
    val latestRoot = rememberUpdatedState(project?.cwd)
    val fileAccess = remember(api, project?.id, onOpenFile, onOpenVisualization) {
        if (api != null && project != null) FileAccess(
            projectId = project.id,
            open = { path, line -> onOpenFile?.invoke(path, line) },
            openVisualization = { path ->
                if (onOpenVisualization != null) onOpenVisualization(path) else onOpenFile?.invoke(path, null)
            },
            canDownload = downloadsSupported,
            download = { path -> DownloadCenter.shared.start(api, project.id, path) },
            downloadAttachment = { id, name -> DownloadCenter.shared.startAttachment(api, id, name) },
            resolve = { path -> resolveFileMention(path, conversationFiles(latestRows.value, latestRoot.value)) },
        ) else null
    }

    // No composer here, but a tap still ends a text selection the way it does on the session page.
    CompositionLocalProvider(LocalFileAccess provides fileAccess) {
        RiffetPageScaffold(
            modifier = modifier.fillMaxSize().blurOnTap(),
            topBar = {
                PageTopBar(
                    title = target.name,
                    onBack = onBack,
                    subtitle = listOfNotNull(
                        transcript?.subagentType?.takeIf { it.isNotBlank() },
                        if (running) stringResource(Res.string.session_subagent_running) else stringResource(Res.string.session_subagent_finished),
                    ).joinToString(" · "),
                    subtitleColor = if (running) colors.accent else colors.fg3,
                    actions = {
                        if (interaction != null) PageBarAction(
                            icon = RiffetIcons.CircleAlert,
                            description = stringResource(Res.string.session_subagent_pending),
                            onClick = onReturnToSession,
                            tint = colors.accent,
                        )
                    },
                )
            },
        ) { chromePadding ->
            Box(modifier = Modifier.fillMaxSize()) {
                when {
                    entering || transcript == null || items.isEmpty() -> Box(Modifier.fillMaxSize().padding(chromePadding)) { EmptySubagent() }
                    else -> Timeline(
                        contentPadding = chromePadding,
                        layout = layout,
                        tail = items.lastOrNull(),
                        onToggleProcess = folds::toggle,
                        modifier = Modifier.fillMaxSize(),
                        root = project?.cwd,
                        onOpenFile = { path, line -> onOpenFile?.invoke(path, line) },
                        listState = listState,
                        // The child pages its own lane the way the parent pages the main one.
                        onReachTop = { store.loadOlderSubagent(target.toolCallId) },
                        reachTopKey = listOf(loading == target.toolCallId, page?.hasBefore, items.firstOrNull()?.key, error),
                    )
                }
                HistoryPill(
                    error = error,
                    onRetry = {
                        store.clearSubagentError()
                        store.loadOlderSubagent(target.toolCallId)
                    },
                    modifier = Modifier.align(Alignment.TopCenter).padding(top = chromePadding.calculateTopPadding() + 8.dp),
                )
            }
        }
    }
}

/** Nothing to show yet: the child is connected, but has not said anything. */
@Composable
private fun EmptySubagent() {
    riffet.ui.design.EmptyState(stringResource(Res.string.session_subagent_empty), icon = RiffetIcons.Bot)
}

/** The subagent a page is open on: which call spawned it, and what to call it in the header. */
data class SubagentTarget(
    val toolCallId: String,
    val name: String,
)
