package riffet.ui.assistant

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import riffet.contracts.AssistantPack
import riffet.ui.design.ChipButton
import riffet.ui.design.LocalInterfaceStyle

/**
 * The installed capability packs, one entry each, above the assistant's composer (docs/ASSISTANT.md §8.2).
 * Nothing shows until a pack with an entry is added in 设置.
 */
@Composable
internal fun AssistantPackEntries(packs: List<AssistantPack>, onPick: (String) -> Unit) {
    val entries = packs.filter { it.installed && !it.entry.isNullOrBlank() }
    if (entries.isEmpty()) return
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(LocalInterfaceStyle.current.metrics.controlInset / 2),
    ) {
        entries.forEach { pack -> ChipButton(pack.title, active = false, onClick = { onPick("${pack.entry} ") }, trailingIcon = null) }
    }
}

/** A pack's [entry] at the start of the draft; what was typed stays after it, on its own line. */
internal fun draftWithEntry(entry: String, typed: String): String = if (typed.isBlank()) entry else "$entry\n$typed"
