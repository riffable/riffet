package riffet.ui.timeline

internal data class BareUrlMatch(
    val start: Int,
    val end: Int,
    val url: String,
)

/**
 * Finds bare web URLs (`http(s)://` and `www.`) in plain text following the same boundary, host,
 * port and balanced-delimiter rules as Web (`bareUrls.ts`) and Apple (`BareURLs.swift`).
 */
internal fun findBareUrls(text: String): List<BareUrlMatch> {
    if (!hasBareUrlHint(text)) return emptyList()
    val matches = ArrayList<BareUrlMatch>()
    var index = 0
    while (index < text.length) {
        val found = scanBareUrl(text, index)
        if (found == null) {
            index += 1
            continue
        }
        matches.add(found)
        index = found.end
    }
    return matches
}

private fun hasBareUrlHint(text: String): Boolean =
    text.contains("://") || text.contains("www.", ignoreCase = true)

private fun scanBareUrl(text: String, index: Int): BareUrlMatch? {
    scanSchemeUrl(text, index)?.let { return it }
    return scanWwwUrl(text, index)
}

private fun scanSchemeUrl(text: String, index: Int): BareUrlMatch? {
    val schemeLen: Int
    val normalizedScheme: String
    when {
        text.regionMatches(index, "http://", 0, 7, ignoreCase = true) -> {
            schemeLen = 7
            normalizedScheme = "http://"
        }
        text.regionMatches(index, "https://", 0, 8, ignoreCase = true) -> {
            schemeLen = 8
            normalizedScheme = "https://"
        }
        else -> return null
    }
    if (index > 0) {
        val prev = text[index - 1]
        if (isAsciiAlnum(prev) || prev == '_') return null
    }
    val authStart = index + schemeLen
    // Optional `userinfo@` before host.
    var hostStart = authStart
    var probe = authStart
    while (probe < text.length && isUserInfoChar(text[probe])) probe += 1
    if (probe > authStart && probe < text.length && text[probe] == '@') {
        hostStart = probe + 1
    }
    val hostEnd: Int
    if (hostStart < text.length && text[hostStart] == '[') {
        var close = hostStart + 1
        var hasColon = false
        while (close < text.length && isIPv6Char(text[close])) {
            if (text[close] == ':') hasColon = true
            close += 1
        }
        if (!hasColon || close <= hostStart + 2 || close >= text.length || text[close] != ']') return null
        hostEnd = close + 1
    } else {
        var scanEnd = hostStart
        while (scanEnd < text.length && isHostChar(text[scanEnd])) scanEnd += 1
        var trimmedEnd = scanEnd
        if (scanEnd < text.length && text[scanEnd] == '/' && trimmedEnd > hostStart && text[trimmedEnd - 1] == '.') {
            trimmedEnd -= 1
        } else {
            while (trimmedEnd > hostStart && text[trimmedEnd - 1] == '.') trimmedEnd -= 1
            scanEnd = trimmedEnd
        }
        if (!isValidHostname(text, hostStart, trimmedEnd)) return null
        hostEnd = scanEnd
    }
    val authEnd = scanPort(text, hostEnd) ?: return null
    val end = if (authEnd < text.length && isTailStart(text[authEnd])) scanTail(text, authEnd) else authEnd
    return BareUrlMatch(start = index, end = end, url = normalizedScheme + text.substring(authStart, end))
}

private fun scanWwwUrl(text: String, index: Int): BareUrlMatch? {
    if (!text.regionMatches(index, "www.", 0, 4, ignoreCase = true)) return null
    if (index > 0) {
        val prev = text[index - 1]
        if (isAsciiAlnum(prev) || prev == '.' || prev == '_' || prev == '/' || prev == '-' || prev == '@') return null
    }
    var scanEnd = index
    while (scanEnd < text.length && isHostChar(text[scanEnd])) scanEnd += 1
    var trimmedEnd = scanEnd
    if (scanEnd < text.length && text[scanEnd] == '/' && trimmedEnd > index && text[trimmedEnd - 1] == '.') {
        trimmedEnd -= 1
    } else {
        while (trimmedEnd > index && text[trimmedEnd - 1] == '.') trimmedEnd -= 1
        scanEnd = trimmedEnd
    }
    if (!isValidWwwHost(text, index, trimmedEnd)) return null
    val authEnd = scanPort(text, scanEnd) ?: return null
    val end = if (authEnd < text.length && isTailStart(text[authEnd])) scanTail(text, authEnd) else authEnd
    return BareUrlMatch(start = index, end = end, url = "http://" + text.substring(index, end))
}

/** Parses optional `:port` at [start]. Returns null if `:` introduces an invalid port. */
private fun scanPort(text: String, start: Int): Int? {
    if (start >= text.length || text[start] != ':') return start
    var end = start + 1
    while (end < text.length && text[end] in '0'..'9') end += 1
    if (end == start + 1) return start
    if (end < text.length && isAsciiAlnum(text[end])) return null
    val digits = end - (start + 1)
    if (digits > 5) return null
    val port = text.substring(start + 1, end).toIntOrNull() ?: return null
    if (port !in 1..65535) return null
    return end
}

/** Scans path/query/fragment from [start], stopping on punctuation/symbols or unmatched `)` / `]`. */
private fun scanTail(text: String, start: Int): Int {
    var end = start
    var parenDepth = 0
    var bracketDepth = 0
    while (end < text.length) {
        val ch = text[end]
        when (ch) {
            '(' -> { parenDepth += 1; end += 1; continue }
            ')' -> { if (parenDepth == 0) break; parenDepth -= 1; end += 1; continue }
            '[' -> { bracketDepth += 1; end += 1; continue }
            ']' -> { if (bracketDepth == 0) break; bracketDepth -= 1; end += 1; continue }
        }
        if (!keeps(ch)) break
        end += 1
    }
    while (end > start) {
        val last = text[end - 1]
        if (last in TRAILING) {
            end -= 1
            continue
        }
        if ((last == '(' || last == '[') && hasUnclosedOpen(text, start, end, last, if (last == '(') ')' else ']')) {
            end -= 1
            continue
        }
        break
    }
    return end
}

private fun hasUnclosedOpen(text: String, start: Int, end: Int, open: Char, close: Char): Boolean {
    var depth = 0
    for (i in start until end) {
        if (text[i] == open) depth += 1
        else if (text[i] == close && depth > 0) depth -= 1
    }
    return depth > 0
}

private fun keeps(ch: Char): Boolean {
    if (ch.code < 0x80) return ch in ASCII_TAIL
    if (ch.isWhitespace() || ch.isHighSurrogate() || ch.isLowSurrogate()) return false
    return when (ch.category) {
        CharCategory.CONNECTOR_PUNCTUATION,
        CharCategory.DASH_PUNCTUATION,
        CharCategory.START_PUNCTUATION,
        CharCategory.END_PUNCTUATION,
        CharCategory.INITIAL_QUOTE_PUNCTUATION,
        CharCategory.FINAL_QUOTE_PUNCTUATION,
        CharCategory.OTHER_PUNCTUATION,
        CharCategory.MATH_SYMBOL,
        CharCategory.CURRENCY_SYMBOL,
        CharCategory.MODIFIER_SYMBOL,
        CharCategory.OTHER_SYMBOL -> false
        else -> true
    }
}

private fun isValidHostname(text: String, start: Int, end: Int): Boolean {
    if (end <= start) return false
    var labelStart = start
    var cursor = start
    while (cursor <= end) {
        if (cursor == end || text[cursor] == '.') {
            if (cursor <= labelStart) return false
            if (!isAsciiAlnum(text[labelStart]) || !isAsciiAlnum(text[cursor - 1])) return false
            labelStart = cursor + 1
        } else if (!isDomainLabelChar(text[cursor])) {
            return false
        }
        cursor += 1
    }
    return true
}

private fun isValidWwwHost(text: String, start: Int, end: Int): Boolean {
    if (!isValidHostname(text, start, end)) return false
    var dots = 0
    var lastLabelStart = start
    for (i in start until end) {
        if (text[i] == '.') {
            dots += 1
            lastLabelStart = i + 1
        }
    }
    if (dots < 2) return false
    val tldLen = end - lastLabelStart
    if (tldLen < 2) return false
    var allLetters = true
    for (i in lastLabelStart until end) {
        if (!isAsciiLetter(text[i])) {
            allLetters = false
            break
        }
    }
    if (allLetters) return true
    if (tldLen < 6 || !text.regionMatches(lastLabelStart, "xn--", 0, 4, ignoreCase = true)) return false
    for (i in (lastLabelStart + 4) until end) {
        if (!isAsciiAlnum(text[i])) return false
    }
    return true
}

private fun isTailStart(ch: Char): Boolean = ch == '/' || ch == '?' || ch == '#'
private fun isAsciiLetter(ch: Char): Boolean = ch in 'A'..'Z' || ch in 'a'..'z'
private fun isAsciiAlnum(ch: Char): Boolean = isAsciiLetter(ch) || ch in '0'..'9'
private fun isDomainLabelChar(ch: Char): Boolean = isAsciiAlnum(ch) || ch == '-'
private fun isHostChar(ch: Char): Boolean = isAsciiAlnum(ch) || ch == '.' || ch == '-'
private fun isIPv6Char(ch: Char): Boolean = ch in '0'..'9' || ch in 'A'..'F' || ch in 'a'..'f' || ch == ':' || ch == '.'
private fun isUserInfoChar(ch: Char): Boolean = isAsciiAlnum(ch) || ch in USERINFO_EXTRA

private val ASCII_TAIL: Set<Char> = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~:/?#[]@!$&()+,;=%".toSet()
private val USERINFO_EXTRA: Set<Char> = "-._~%:+".toSet()
private val TRAILING: Set<Char> = "?!.,:;_~".toSet()
