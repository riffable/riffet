package riffet.ui.home

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import org.jetbrains.compose.resources.stringResource
import riffet.contracts.Project
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.RiffetSearchField
import riffet.ui.icons.RiffetIcons
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.pickers.LocalPickerHost
import riffet.ui.pickers.OptionRow
import riffet.ui.pickers.PickerPage
import riffet.ui.pickers.PickerSheetFrame
import riffet.ui.pickers.SheetInset
import riffet_mobile.shared.generated.resources.*

/** Past this many directories the sheet leads with a search field. */
private const val SearchThreshold = 8

/**
 * Every directory a session can start in, as a sheet, each with where it lives on the line below.
 * Worktrees stay out of it unless one is the current choice, nested under its origin. Shared by the home's directory row and the
 * session list's project filter, which adds an "all projects" choice ([allLabel]).
 *
 * @param onChooseDirectory runs once the sheet has slid away, so the directory browser it opens does
 *   not stack on top of this one.
 */
@Composable
internal fun ProjectPickerSheet(
    projects: List<Project>,
    selectedId: String?,
    onSelect: (Project?) -> Unit,
    onDismiss: () -> Unit,
    allLabel: String? = null,
    onChooseDirectory: (() -> Unit)? = null,
) {
    var browse by remember { mutableStateOf(false) }
    PickerSheetFrame(onDismiss = { onDismiss(); if (browse) onChooseDirectory?.invoke() }) {
        val host = LocalPickerHost.current
        val metrics = LocalInterfaceStyle.current.metrics
        val searchable = projects.count { it.worktree == null } > SearchThreshold
        var query by remember { mutableStateOf("") }
        // Worktrees are where sessions ran, not places to start one: only the current one is listed.
        val rows = remember(projects, selectedId) { directoryRows(projects).filter { (project, _) -> project.worktree == null || project.id == selectedId } }
        val shown = remember(rows, query) {
            val needle = query.trim()
            if (needle.isEmpty()) rows else rows.filter { (project, _) ->
                project.name.contains(needle, ignoreCase = true) ||
                    project.worktree?.branch?.contains(needle, ignoreCase = true) == true ||
                    project.cwd.contains(needle, ignoreCase = true)
            }
        }
        fun pick(project: Project?) {
            onSelect(project)
            host?.dismiss?.invoke()
        }
        // A searchable list keeps its full height, so filtering does not shrink the sheet under the finger.
        PickerPage(title = stringResource(Res.string.session_projects), fullHeight = searchable) {
            if (searchable) RiffetSearchField(
                query = query,
                onQueryChange = { query = it },
                placeholder = stringResource(Res.string.session_search_projects),
                clearDescription = stringResource(Res.string.session_clear_search),
                modifier = Modifier.padding(horizontal = SheetInset, vertical = metrics.controlInset / 2),
            )
            Column(Modifier.fillMaxWidth().weight(1f, fill = searchable).verticalScroll(rememberScrollState()).padding(bottom = metrics.controlInset)) {
                if (allLabel != null && query.isBlank()) OptionRow(
                    label = allLabel,
                    selected = selectedId == null,
                    onClick = { pick(null) },
                )
                if (allLabel != null && query.isBlank()) Separator()
                shown.forEach { (project, nested) ->
                    Box(if (nested && query.isBlank()) Modifier.padding(start = metrics.rowPadding) else Modifier) {
                        OptionRow(
                            label = project.worktree?.branch?.takeIf { nested } ?: project.name,
                            // A worktree's path is a long generated one; its branch already says which.
                            description = if (project.worktree != null) null else directoryHint(project),
                            icon = if (nested) RiffetIcons.Branch else RiffetIcons.Folder,
                            selected = project.id == selectedId,
                            onClick = { pick(project) },
                        )
                    }
                }
                if (onChooseDirectory != null && query.isBlank()) {
                    Separator()
                    if (onChooseDirectory != null && query.isBlank()) OptionRow(
                        label = stringResource(Res.string.session_choose_other_directory),
                        icon = RiffetIcons.FolderPlus,
                        selected = false,
                        tone = LocalRiffetColors.current.accent,
                        onClick = { browse = true; host?.dismiss?.invoke() },
                    )
                }
            }
        }
    }
}

/** Sets the scope row and the action row apart from the directory list. */
@Composable
private fun Separator() {
    val metrics = LocalInterfaceStyle.current.metrics
    Box(Modifier.fillMaxWidth().padding(vertical = metrics.controlInset / 2).height(metrics.hairlineWidth).background(LocalRiffetColors.current.line))
}

/** Origins in order, each followed by its worktrees; a worktree whose origin is gone lists on its own. */
internal fun directoryRows(projects: List<Project>): List<Pair<Project, Boolean>> {
    val ids = projects.mapTo(HashSet()) { it.id }
    val byOrigin = projects.filter { it.worktree != null && it.worktree!!.originProjectId in ids }.groupBy { it.worktree!!.originProjectId }
    val nestedIds = byOrigin.values.flatten().mapTo(HashSet()) { it.id }
    return buildList {
        projects.filter { it.id !in nestedIds }.forEach { project ->
            add(project to false)
            byOrigin[project.id]?.forEach { add(it to true) }
        }
    }
}

/**
 * Where a directory lives, without repeating its name: the parent folder when the last segment is
 * the project's name (the usual case), otherwise the whole path.
 */
internal fun directoryHint(project: Project): String {
    val path = tildePath(project.cwd.trimEnd('/'))
    val leaf = path.substringAfterLast('/')
    return if (leaf == project.name && '/' in path) path.substringBeforeLast('/').ifEmpty { "/" } else path
}
