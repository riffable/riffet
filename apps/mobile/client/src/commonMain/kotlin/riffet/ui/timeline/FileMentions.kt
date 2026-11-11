package riffet.ui.timeline

import riffet.core.TimelineItem
import riffet.core.stripRoot
import riffet.core.toolView

/*
 * Which file a path the agent writes in its text means, shared by the phone and the Mac. Ported
 * from apps/web/src/app/session/fileAccess.ts.
 */

/**
 * The project-relative paths this conversation's tools read, wrote or edited, newest first and
 * without repeats: every non-failed tool row's locations and diff paths.
 */
fun conversationFiles(items: List<TimelineItem>, root: String?): List<String> {
    val seen = LinkedHashSet<String>()
    for (index in items.indices.reversed()) {
        val item = items[index] as? TimelineItem.Tool ?: continue
        val view = toolView(item.event.base, root)
        if (view.status == "failed") continue
        view.contents.forEach { content ->
            if (jsonText(content["type"]) == "diff") jsonText(content["path"])?.let { seen.add(stripRoot(it, root)) }
        }
        view.locations.forEach { seen.add(it.path) }
    }
    return seen.toList()
}

/**
 * Agents name a file they just handled by its name or the end of its path — `riffet2.png` after
 * reading `tmp/brand/riffet2.png` — so a mention means the newest such file the conversation
 * touched. One that matches none is sent as written, and the server reads a missing path as the
 * project's only file ending with it.
 */
fun resolveFileMention(path: String, files: List<String>): String {
    val mention = path.removePrefix("./")
    if (mention.isEmpty() || mention.startsWith("/") || mention.startsWith("~")) return path
    return files.firstOrNull { it == mention || it.endsWith("/$mention") } ?: path
}
