package riffet.contracts

/**
 * Compare the prompt this app sent with the copy the CLI stored. Ported from
 * packages/contracts/src/prompt-match.ts — the algorithm is deliberately identical, because the
 * server binds a run to its receipt with the same rule and divergence reintroduces the bug.
 * `PromptMatchTest.kt` holds the same cases as `prompt-match.test.ts`.
 *
 * Text delivered through the terminal can reach the CLI as one or more U+FFFD replacement
 * characters, so the stored copy both loses the original character and gains code units. An exact
 * comparison therefore refuses to recognise a message the CLI clearly received: the run stays
 * `uncertain`, its delivery fence never lifts, and every later message waits in the queue.
 *
 * A difference is accepted only where one side shows that replacement character: the run of U+FFFD
 * stands for the characters the terminal mangled there, and everything else has to agree exactly.
 * Differing prompts without replacement characters cannot match (e.g. "继续" and "好的"). The
 * number of places where the replacement runs or original characters differ is capped at about 1%
 * of the shorter text, and a fuzzy match needs at least one shared character besides whitespace.
 *
 * Whitespace is compared by position, not by kind or count: the TUI expands a pasted tab to the
 * next tab stop, so a crash report or a table can store hundreds more characters than were sent.
 */
fun samePromptText(sentText: String, storedText: String): Boolean {
    val sent = collapseWhitespace(sentText)
    val stored = collapseWhitespace(storedText)
    if (sent == stored) return true
    if (sent.isEmpty() || stored.isEmpty()) return false
    val longest = maxOf(sent.length, stored.length)
    if (kotlin.math.abs(sent.length - stored.length).toDouble() > maxOf(4.0, longest * 0.01)) return false
    val sentLastReplacement = sent.lastIndexOf(REPLACEMENT)
    val storedLastReplacement = stored.lastIndexOf(REPLACEMENT)
    if (sentLastReplacement == -1 && storedLastReplacement == -1) return false
    // Mangling was observed at a few places per thousand characters; the floor lets a short prompt
    // lose a character or two, the cap keeps a very long one from tolerating a wholesale rewrite.
    val places = minOf(32, maxOf(3, kotlin.math.ceil(minOf(sent.length, stored.length) * 0.01).toInt()))
    // Positions reached so far, with the fewest mangled places used to get there and whether any
    // character agreed on the way. A run of replacement characters can stand for a varying number of
    // characters, so more than one alignment is followed; the work is bounded by `STEPS`.
    var frontier = listOf(Reached(0, 0, false))
    var steps = 0
    var used = 0
    while (used <= places && frontier.isNotEmpty()) {
        val next = mutableListOf<Reached>()
        val seen = mutableSetOf<Long>()
        fun add(i: Int, j: Int, agreed: Boolean) {
            val key = (i.toLong() * (stored.length + 1) + j) * 2 + (if (agreed) 1 else 0)
            if (seen.add(key)) next += Reached(i, j, agreed)
        }
        for (start in frontier) {
            var i = start.sent
            var j = start.stored
            var agreed = start.agreed
            // With no more replacements on either side, the remaining suffixes must be the same length.
            if (i > sentLastReplacement && j > storedLastReplacement && sent.length - i != stored.length - j) continue
            while (true) {
                val character = sent.getOrNull(i)
                if (character == null || character != stored.getOrNull(j)) break
                if (character == REPLACEMENT) {
                    val run = runAt(sent, i)
                    if (run != runAt(stored, j)) break
                    i += run
                    j += run
                } else {
                    if (character != ' ') agreed = true
                    i += 1
                    j += 1
                }
            }
            if (i == sent.length && j == stored.length) {
                if (agreed) return true
                continue
            }
            if (used == places) continue
            val inSent = sent.getOrNull(i) == REPLACEMENT
            val inStored = stored.getOrNull(j) == REPLACEMENT
            if (inSent && inStored) {
                if (++steps > STEPS) return false
                add(i + runAt(sent, i), j + runAt(stored, j), agreed)
                continue
            }
            if (!inSent && !inStored) continue
            // Each replacement can stand for a whole Unicode character, including a surrogate pair.
            val run = if (inStored) runAt(stored, j) else runAt(sent, i)
            val original = if (inStored) sent else stored
            var end = if (inStored) i else j
            var taken = 0
            while (taken < run && end < original.length) {
                val high = original[end++].isHighSurrogate()
                if (high && original.getOrNull(end)?.isLowSurrogate() == true) end += 1
                if (++steps > STEPS) return false
                add(if (inStored) end else i + run, if (inStored) j + run else end, agreed)
                taken += 1
            }
        }
        frontier = next
        used += 1
    }
    return false
}

private class Reached(val sent: Int, val stored: Int, val agreed: Boolean)

private const val REPLACEMENT = '�'

/** Alignments tried before giving up; a real receipt needs a handful. */
private const val STEPS = 4096

private fun runAt(text: String, index: Int): Int {
    var end = index
    while (end < text.length && text[end] == REPLACEMENT) end += 1
    return end - index
}

private val WHITESPACE = Regex("[ \\t\\n\\r\\u000C\\u000B]+")

private fun collapseWhitespace(text: String): String = text.replace(WHITESPACE, " ").removePrefix(" ").removeSuffix(" ")
