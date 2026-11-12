package riffet.ui.git

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import org.jetbrains.compose.resources.stringResource
import riffet.contracts.GitDiff
import riffet.contracts.GitLineChange
import riffet.ui.design.RiffetInlineAction
import riffet.ui.files.gitStaged
import riffet.ui.files.gitUnstaged
import riffet.ui.files.tildePath
import riffet.ui.settings.SettingsButton
import riffet.ui.settings.SettingsMessageBanner
import riffet.ui.settings.SettingsNoticeKind
import riffet.ui.settings.SettingsSegmented
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet.ui.timeline.CodeBlock
import riffet.ui.timeline.DiffBlock
import riffet.ui.timeline.Spinner
import riffet_mobile.shared.generated.resources.*

/** A file's diff as a page: the file's own Stage / Unstage, the Unstaged / Staged switch, and the changed runs with their actions. */
@Composable
internal fun GitDiffPage(
    target: GitDiffTarget,
    state: GitPanelState,
    controller: GitPanelController,
    onOpenFile: ((String, Int?) -> Unit)?,
) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val busy = state.busy
    val diff = state.diff
    // The file's side the status says it has; the target's own copy is as old as the page.
    val entry = target.entry?.let { opened -> state.status?.entries?.firstOrNull { it.path == opened.path } ?: opened }
    val staged = state.diffStaged
    val both = entry != null && gitStaged(entry) && entry.worktree != " "

    Column(Modifier.fillMaxSize()) {
        Text(
            text = tildePath(target.path),
            style = typography.monoSmall,
            color = colors.fg2,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
        )
        if (entry != null) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (both) {
                    Box(Modifier.weight(1f)) {
                        SettingsSegmented(
                            options = listOf("unstaged" to stringResource(Res.string.git_diff_unstaged), "staged" to stringResource(Res.string.git_diff_staged)),
                            value = if (staged) "staged" else "unstaged",
                            onSelect = { controller.showDiffSide(it == "staged") },
                        )
                    }
                    Spacer(Modifier.width(8.dp))
                }
                if (!staged && gitUnstaged(entry)) SettingsButton(stringResource(Res.string.git_stage), onClick = { controller.stage(listOf(entry.path)) }, enabled = !busy)
                if (staged && gitStaged(entry)) SettingsButton(stringResource(Res.string.git_unstage), onClick = { controller.unstage(listOf(entry.path)) }, enabled = !busy)
            }
        }
        Spacer(Modifier.height(8.dp))
        when {
            diff == null && state.diffLoading -> Box(Modifier.fillMaxWidth().padding(vertical = 40.dp), contentAlignment = Alignment.Center) { Spinner(size = 20.dp) }
            diff == null -> Box(Modifier.fillMaxWidth().padding(vertical = 40.dp), contentAlignment = Alignment.Center) {
                Text(stringResource(Res.string.git_diff_failed), style = typography.body, color = colors.fg3)
            }
            else -> DiffBody(
                diff = diff,
                rows = state.diffRows.orEmpty(),
                staged = staged,
                busy = busy,
                onChunk = controller::applyChunk,
                onOpenFile = onOpenFile,
            )
        }
    }
}

@Composable
private fun DiffBody(
    diff: GitDiff,
    rows: List<GitPatchRow>,
    staged: Boolean,
    busy: Boolean,
    onChunk: (action: String, change: GitLineChange) -> Unit,
    onOpenFile: ((String, Int?) -> Unit)?,
) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current

    when {
        diff.binary -> Column(Modifier.fillMaxSize().padding(horizontal = 12.dp)) {
            Text(stringResource(Res.string.git_binary), style = typography.caption, color = colors.fg3)
            Spacer(Modifier.height(6.dp))
            CodeBlock(text = diff.patch.ifBlank { stringResource(Res.string.git_binary) })
        }

        // A server that sent no patch still has the two sides to compare.
        rows.isEmpty() -> Column(Modifier.fillMaxSize().padding(horizontal = 12.dp)) {
            if (diff.truncated == true) {
                SettingsMessageBanner(stringResource(Res.string.git_diff_truncated), SettingsNoticeKind.INFO)
                Spacer(Modifier.height(8.dp))
            }
            DiffBlock(
                path = null,
                before = diff.before,
                after = diff.after,
                lineOffset = 0,
                trailingLines = 0,
                onOpenFile = { path, line -> onOpenFile?.invoke(path, line) },
            )
        }

        else -> {
            // Kept across a reload after a stage or a discard: the list is the same instance, so its scroll stays.
            val list = rememberLazyListState()
            LazyColumn(Modifier.fillMaxSize(), state = list, contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = 16.dp)) {
                if (diff.truncated == true) item(key = "truncated") {
                    Box(Modifier.padding(horizontal = 12.dp, vertical = 4.dp)) {
                        SettingsMessageBanner(stringResource(Res.string.git_diff_truncated), SettingsNoticeKind.INFO)
                    }
                }
                itemsIndexed(rows, contentType = { _, row -> row::class }) { _, row ->
                    when (row) {
                        is GitPatchRow.Hunk -> Text(
                            text = row.text,
                            style = typography.monoSmall,
                            color = colors.fg3,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.fillMaxWidth().background(colors.bgSubtle).padding(horizontal = 12.dp, vertical = 4.dp),
                        )

                        is GitPatchRow.Actions -> Row(
                            modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp),
                            horizontalArrangement = Arrangement.spacedBy(4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            if (staged) {
                                RiffetInlineAction(onClick = { onChunk("unstage", row.change) }, enabled = !busy) { Text(stringResource(Res.string.git_unstage)) }
                            } else {
                                RiffetInlineAction(onClick = { onChunk("stage", row.change) }, enabled = !busy) { Text(stringResource(Res.string.git_stage)) }
                                RiffetInlineAction(onClick = { onChunk("discard", row.change) }, enabled = !busy) {
                                    Text(stringResource(Res.string.git_discard), color = colors.danger)
                                }
                            }
                        }

                        is GitPatchRow.Line -> {
                            val background = when (row.sign) {
                                '+' -> colors.diffAdd
                                '-' -> colors.diffDel
                                else -> androidx.compose.ui.graphics.Color.Transparent
                            }
                            val marker = when (row.sign) {
                                '+' -> colors.diffAddMarker
                                '-' -> colors.diffDelMarker
                                else -> colors.fg4
                            }
                            Row(Modifier.fillMaxWidth().background(background).padding(horizontal = 12.dp)) {
                                Text(
                                    text = if (row.sign == '\\' || row.sign == ' ') " " else row.sign.toString(),
                                    style = typography.monoSmall,
                                    color = marker,
                                    modifier = Modifier.width(14.dp),
                                )
                                Text(
                                    text = row.text.ifEmpty { " " },
                                    style = typography.monoSmall,
                                    color = if (row.sign == '\\') colors.fg3 else colors.fg,
                                    modifier = Modifier.weight(1f),
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}
