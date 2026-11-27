package riffet.ui.composer

import riffet.contracts.NativeSlashCatalog
import riffet.contracts.NativeSlashItem

/*
 * The `/` menu's rules, ported from `apps/web/src/app/session/slashMenu.ts`: a slash opens a token at
 * the start of the draft or after whitespace; commands are offered only for the leading token, skills
 * also mid-message where the backend loads them there; a pick replaces just the typed token.
 */

/** A live `/` token under the caret: the query after the slash, where the slash sits, and whether it opens the message. */
data class SlashTrigger(val query: String, val start: Int, val leading: Boolean)

fun detectSlashTrigger(text: String, caret: Int): SlashTrigger? {
    var index = caret - 1
    while (index >= 0) {
        val char = text[index]
        if (char.isWhitespace()) return null
        if (char == '/' && (index == 0 || text[index - 1].isWhitespace())) {
            return SlashTrigger(text.substring(index + 1, caret), index, text.indexOfFirst { !it.isWhitespace() } == index)
        }
        index -= 1
    }
    return null
}

fun slashCandidates(items: List<NativeSlashItem>, leading: Boolean, inlineSkills: Boolean): List<NativeSlashItem> = when {
    leading -> items
    inlineSkills -> items.filter { it.isSkill }
    else -> emptyList()
}

private fun isSubsequence(needle: String, haystack: String): Boolean {
    var at = 0
    for (char in haystack) if (at < needle.length && char == needle[at]) at += 1
    return at == needle.length
}

private fun slashScore(item: NativeSlashItem, query: String): Int? {
    if (query.isEmpty()) return 0
    val name = item.name.lowercase()
    val parts = name.split('-', ':', '_', '.').filter { it.isNotEmpty() }
    val initials = parts.joinToString("") { it[0].toString() }
    return when {
        name == query -> 0
        name.startsWith(query) -> 1
        parts.any { it.startsWith(query) } -> 2
        query in name -> 3
        query.length >= 2 && isSubsequence(query, initials) -> 4
        item.description?.lowercase()?.contains(query) == true -> 5
        else -> null
    }
}

/** Matching items, best first; ties keep the catalog's order. */
fun rankSlashItems(items: List<NativeSlashItem>, query: String, limit: Int = 50): List<NativeSlashItem> {
    val needle = query.trim().lowercase()
    return items.withIndex()
        .mapNotNull { (index, item) -> slashScore(item, needle)?.let { Triple(item, index, it) } }
        .sortedWith(compareBy({ it.third }, { it.second }))
        .take(limit)
        .map { it.first }
}

/** Commands first, then skills, each ranked on its own; empty groups are dropped. */
fun slashMenuGroups(items: List<NativeSlashItem>, query: String): List<Pair<Boolean, List<NativeSlashItem>>> =
    listOf(false, true).mapNotNull { skills ->
        rankSlashItems(items.filter { it.isSkill == skills }, query).takeIf { it.isNotEmpty() }?.let { skills to it }
    }

/** The draft with the token at [trigger] replaced by `/name`, and the caret just after it. */
fun applySlashPick(text: String, caret: Int, trigger: SlashTrigger, item: NativeSlashItem): Pair<String, Int> {
    val insert = if (text.getOrNull(caret)?.isWhitespace() == true) "/${item.name}" else "/${item.name} "
    val next = text.substring(0, trigger.start) + insert + text.substring(caret)
    return next to trigger.start + insert.length
}

/** The menu's groups for [trigger]. */
fun NativeSlashCatalog.groupsFor(trigger: SlashTrigger): List<Pair<Boolean, List<NativeSlashItem>>> =
    slashMenuGroups(slashCandidates(items, trigger.leading, inlineSkills), trigger.query)
