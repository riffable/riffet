package riffet.ui.assistant

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.stringResource
import riffet.contracts.AssistantDelegation
import riffet.contracts.AssistantMemoryEntry
import riffet.ui.app.PaneIcon
import riffet.ui.app.PaneRow
import riffet.ui.app.PaneSection
import riffet.ui.design.Group
import riffet.ui.design.GroupField
import riffet.ui.design.GroupRow
import riffet.ui.design.GroupTitle
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.RiffetButton
import riffet.ui.icons.RiffetIcons
import riffet.ui.pickers.PickerOverlay
import riffet.ui.pickers.SheetInset
import riffet.ui.sessionlist.relativeTimeAgo
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet.ui.timeline.platformNowMillis
import riffet_mobile.shared.generated.resources.*

/** What the assistant's setup rows open as a sheet; 能力 is a page of its own. */
internal enum class AssistantSheet { MEMORY, RULES, DELEGATIONS }

/** The setup rows' reach: the data they show, and where each one goes. */
internal class AssistantEntries(
    val setup: AssistantSetup,
    val onSheet: (AssistantSheet) -> Unit,
    /** The extensions page scoped to the assistant. */
    val onAbilities: () -> Unit,
)

/** The conversation's 记忆 / 规则 / 能力 (and 委托 once there is one) in the session info. */
@Composable
internal fun AssistantPaneRows(entries: AssistantEntries) {
    val setup = entries.setup
    LaunchedEffect(setup) { setup.load() }
    val now = platformNowMillis()
    val colors = LocalRiffetColors.current
    PaneSection {
        PaneRow(
            stringResource(Res.string.assistant_memory), leading = { PaneIcon(RiffetIcons.Brain, colors.fg2) },
            value = relativeTimeAgo(setup.memory?.updatedAt, now), chevron = true,
        ) { entries.onSheet(AssistantSheet.MEMORY) }
        PaneRow(
            stringResource(Res.string.assistant_rules), leading = { PaneIcon(RiffetIcons.FileText, colors.fg2) },
            value = setup.instructions?.let { stringResource(if (it.custom) Res.string.assistant_rules_modified else Res.string.assistant_rules_default) },
            chevron = true,
        ) { entries.onSheet(AssistantSheet.RULES) }
        PaneRow(
            stringResource(Res.string.assistant_abilities), leading = { PaneIcon(RiffetIcons.Puzzle, colors.fg2) }, chevron = true,
            onClick = entries.onAbilities,
        )
        val active = setup.delegations?.count { it.state == "active" } ?: 0
        if (active > 0) PaneRow(
            stringResource(Res.string.assistant_delegations), leading = { PaneIcon(RiffetIcons.Repeat, colors.fg2) },
            value = active.toString(), chevron = true,
        ) { entries.onSheet(AssistantSheet.DELEGATIONS) }
    }
}

/** The sheet [open] names, over whatever page is showing. */
@Composable
internal fun AssistantSheets(setup: AssistantSetup, open: AssistantSheet?, onDismiss: () -> Unit) {
    LaunchedEffect(open) { if (open != null) setup.refresh() }
    when (open) {
        AssistantSheet.MEMORY -> MemorySheet(setup, onDismiss)
        AssistantSheet.RULES -> RulesSheet(setup, onDismiss)
        AssistantSheet.DELEGATIONS -> DelegationsSheet(setup, onDismiss)
        null -> Unit
    }
}

private class MemoryNote(val entry: AssistantMemoryEntry, val title: String, val note: String, val body: String)

/** A topic file's front matter names it and says what it holds; without one its first heading does, else the file name. */
private fun describe(entry: AssistantMemoryEntry): MemoryNote {
    val front = Regex("^---\\n([\\s\\S]*?)\\n---\\n?").find(entry.text)
    fun field(name: String): String = front?.let {
        Regex("^$name:\\s*(.+)$", RegexOption.MULTILINE).find(it.groupValues[1])?.groupValues?.get(1)?.trim()?.trim('"', '\'')
    }.orEmpty()
    val text = (if (front != null) entry.text.substring(front.value.length) else entry.text).trim()
    val heading = Regex("^# (.+)\\n?").find(text)
    return MemoryNote(
        entry,
        field("name").ifEmpty { heading?.groupValues?.get(1)?.trim() ?: entry.name.removeSuffix(".md") },
        field("description"),
        (if (heading != null) text.substring(heading.value.length) else text).trim(),
    )
}

/** Memory is read-only: to change it, tell the assistant. */
@Composable
private fun MemorySheet(setup: AssistantSetup, onDismiss: () -> Unit) {
    val colors = LocalRiffetColors.current
    val type = LocalRiffetTypography.current
    val memory = setup.memory
    val notes = remember(memory?.entries) { memory?.entries.orEmpty().map(::describe) }
    var expanded by remember { mutableStateOf<String?>(null) }
    PickerOverlay(title = stringResource(Res.string.assistant_memory), onDismiss = onDismiss, fullHeight = true) {
        when {
            memory == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                if (setup.memoryFailed) Text(stringResource(Res.string.assistant_memory_failed), style = type.body, color = colors.fg3)
                else CircularProgressIndicator(color = colors.accent)
            }
            memory.profile.isBlank() && notes.isEmpty() && memory.index.isBlank() -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text(stringResource(Res.string.assistant_memory_empty), style = type.body, color = colors.fg3)
            }
            else -> Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
                if (memory.profile.isNotBlank()) {
                    GroupTitle(stringResource(Res.string.assistant_memory_profile))
                    Group { Text(memory.profile.trim(), style = type.body, color = colors.fg, modifier = Modifier.padding(LocalInterfaceStyle.current.metrics.rowPadding)) }
                }
                // With no topic files yet, what it remembers is the lines of its index.
                if (notes.isNotEmpty() || memory.index.isNotBlank()) {
                    GroupTitle(stringResource(Res.string.assistant_memory_notes))
                    Group {
                        if (notes.isEmpty()) Text(memory.index.trim(), style = type.body, color = colors.fg, modifier = Modifier.padding(LocalInterfaceStyle.current.metrics.rowPadding))
                        notes.forEach { note ->
                            val shown = expanded == note.entry.name
                            GroupRow(
                                title = note.title, subtitle = note.note.takeIf { it.isNotEmpty() && !shown },
                                value = relativeTimeAgo(note.entry.modifiedAt, platformNowMillis()),
                                onClick = { expanded = if (shown) null else note.entry.name },
                            )
                            if (shown && note.body.isNotEmpty()) Text(
                                note.body, style = type.body, color = colors.fg2,
                                modifier = Modifier.fillMaxWidth().padding(LocalInterfaceStyle.current.metrics.rowPadding),
                            )
                        }
                    }
                }
                androidx.compose.foundation.layout.Spacer(Modifier.size(SheetInset))
            }
        }
    }
}

/** `AGENTS.md`, as the server holds it; a new conversation reads it, one already running keeps what it read. */
@Composable
private fun RulesSheet(setup: AssistantSetup, onDismiss: () -> Unit) {
    val colors = LocalRiffetColors.current
    val type = LocalRiffetTypography.current
    val metrics = LocalInterfaceStyle.current.metrics
    val scope = rememberCoroutineScope()
    val loaded = setup.instructions
    // The draft starts from what the server held when the sheet opened; a later read does not overwrite typing.
    var draft by remember(loaded == null) { mutableStateOf(loaded?.text.orEmpty()) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    fun write(text: String?) {
        if (busy) return
        busy = true
        error = null
        scope.launch {
            try {
                setup.saveInstructions(text)
                onDismiss()
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (failure: Throwable) {
                error = failure.message
            } finally {
                busy = false
            }
        }
    }
    PickerOverlay(title = stringResource(Res.string.assistant_rules), onDismiss = onDismiss, fullHeight = true) {
        if (loaded == null) Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = colors.accent) }
        else Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            Group {
                GroupField(
                    value = draft, onValueChange = { draft = it }, singleLine = false, minLines = 12, mono = true,
                    enabled = !busy,
                )
            }
            error?.let { Text(it, style = type.caption, color = colors.danger, modifier = Modifier.padding(horizontal = SheetInset, vertical = metrics.controlInset / 2)) }
            Row(
                Modifier.fillMaxWidth().padding(horizontal = SheetInset, vertical = metrics.controlInset),
                horizontalArrangement = Arrangement.spacedBy(metrics.controlInset), verticalAlignment = Alignment.CenterVertically,
            ) {
                RiffetButton(stringResource(Res.string.assistant_rules_restore), onClick = { write(null) }, enabled = !busy && loaded.custom)
                RiffetButton(
                    stringResource(Res.string.session_save), onClick = { write(draft) },
                    enabled = !busy && draft.isNotBlank() && draft != loaded.text, primary = true,
                )
            }
            Text(
                stringResource(Res.string.assistant_rules_effect), style = type.caption, color = colors.fg3,
                modifier = Modifier.padding(horizontal = SheetInset),
            )
        }
    }
}

@Composable
private fun triggerLabel(item: AssistantDelegation): String {
    val trigger = item.trigger
    return when (trigger.kind) {
        "schedule" -> stringResource(Res.string.assistant_trigger_schedule, trigger.cron.orEmpty())
        "github-release" -> stringResource(Res.string.assistant_trigger_release, trigger.repo.orEmpty())
        "task-status" -> {
            val number = trigger.taskNumber ?: return ""
            val status = when (trigger.status) {
                "todo" -> Res.string.assistant_trigger_task_todo
                "doing" -> Res.string.assistant_trigger_task_doing
                "watching" -> Res.string.assistant_trigger_task_watching
                "review" -> Res.string.assistant_trigger_task_review
                "done" -> Res.string.assistant_trigger_task_done
                "cancelled" -> Res.string.assistant_trigger_task_cancelled
                else -> null
            }
            if (status == null) "#$number" else "#$number · ${stringResource(status)}"
        }
        else -> stringResource(Res.string.assistant_trigger_page, trigger.url.orEmpty())
    }
}

/** What the assistant follows over time; the owner can end one, and the assistant makes them. */
@Composable
private fun DelegationsSheet(setup: AssistantSetup, onDismiss: () -> Unit) {
    val colors = LocalRiffetColors.current
    val type = LocalRiffetTypography.current
    val scope = rememberCoroutineScope()
    val items = setup.delegations
    var busy by remember { mutableStateOf<String?>(null) }
    PickerOverlay(title = stringResource(Res.string.assistant_delegations), onDismiss = onDismiss) {
        when {
            items == null -> Box(Modifier.fillMaxWidth().padding(SheetInset), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = colors.accent) }
            items.isEmpty() -> Box(Modifier.fillMaxWidth().padding(SheetInset), contentAlignment = Alignment.Center) {
                Text(stringResource(Res.string.assistant_delegations_empty), style = type.body, color = colors.fg3)
            }
            else -> Column(Modifier.verticalScroll(rememberScrollState())) {
                Group {
                    items.forEach { item ->
                        val active = item.state == "active"
                        GroupRow(
                            title = item.goal, subtitle = triggerLabel(item),
                            titleColor = if (active) null else colors.fg3,
                            trailing = {
                                if (active) RiffetButton(
                                    stringResource(Res.string.assistant_delegation_end),
                                    onClick = {
                                        busy = item.id
                                        scope.launch {
                                            try { setup.end(item.id) } catch (cancellation: CancellationException) { throw cancellation } catch (_: Throwable) { } finally { busy = null }
                                        }
                                    },
                                    enabled = busy != item.id,
                                ) else Text(stringResource(Res.string.assistant_delegation_ended), style = type.bodySmall, color = colors.fg3)
                            },
                        )
                    }
                }
                androidx.compose.foundation.layout.Spacer(Modifier.size(SheetInset))
            }
        }
    }
}
