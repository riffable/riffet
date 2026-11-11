package riffet.contracts

/**
 * Compare the prompt this app sent with the copy the CLI stored. Ported from
 * packages/contracts/src/prompt-match.ts — the algorithm is deliberately identical, because the
 * server binds a run to its receipt with the same rule and divergence reintroduces the bug.
 *
 * Text delivered through the terminal can reach the CLI as one or two U+FFFD replacement
 * characters, so the stored copy both loses the original character and gains code units. An exact
 * comparison therefore refuses to recognise a message the CLI clearly received: the run stays
 * `uncertain`, its delivery fence never lifts, and every later message waits in the queue.
 *
 * The comparison walks both texts in order with a small skip budget, spent on whichever side is
 * currently longer, so a mangled character realigns the rest of the text. The budget is a
 * percentage of the shorter text, which keeps a genuinely different prompt from matching.
 *
 * Whitespace is compared by position, not by kind or count: the TUI expands a pasted tab to the
 * next tab stop, so a crash report or a table can store hundreds more characters than were sent.
 */
fun samePromptText(sentText: String, storedText: String): Boolean {
    val sent = collapseWhitespace(sentText)
    val stored = collapseWhitespace(storedText)
    val longest = maxOf(sent.length, stored.length)
    if (longest == 0) return true
    if (kotlin.math.abs(sent.length - stored.length).toDouble() > maxOf(4.0, longest * 0.01)) return false
    // An empty side would satisfy the loop below without comparing anything.
    if (sent.isEmpty() || stored.isEmpty()) return sent == stored
    var budget = minOf(32, maxOf(3, kotlin.math.ceil(minOf(sent.length, stored.length) * 0.01).toInt()))
    var surplus = stored.length - sent.length
    var index = 0
    var other = 0
    while (index < sent.length && other < stored.length) {
        if (sent[index] == stored[other]) {
            index += 1
            other += 1
            continue
        }
        if (budget == 0) return false
        budget -= 1
        index += 1
        other += 1
        if (surplus > 0) {
            other += 1
            surplus -= 1
        } else if (surplus < 0) {
            index += 1
            surplus += 1
        }
    }
    return true
}

private val WHITESPACE = Regex("[ \\t\\n\\r\\u000C\\u000B]+")

private fun collapseWhitespace(text: String): String = text.replace(WHITESPACE, " ").removePrefix(" ").removeSuffix(" ")
