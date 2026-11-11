package riffet.terminal

/*
 * The java.lang.Character / StringBuilder code-point helpers the Termux sources rely on, which
 * Kotlin common code does not have.
 */

internal const val MIN_SUPPLEMENTARY_CODE_POINT = 0x10000

internal fun toCodePoint(high: Char, low: Char): Int =
    ((high.code - 0xD800) shl 10) + (low.code - 0xDC00) + MIN_SUPPLEMENTARY_CODE_POINT

internal fun charCount(codePoint: Int): Int = if (codePoint >= MIN_SUPPLEMENTARY_CODE_POINT) 2 else 1

/** Writes [codePoint] as UTF-16 into [destination] at [index]; returns the number of chars written. */
internal fun toChars(codePoint: Int, destination: CharArray, index: Int): Int {
    if (codePoint < MIN_SUPPLEMENTARY_CODE_POINT) {
        destination[index] = codePoint.toChar()
        return 1
    }
    val offset = codePoint - MIN_SUPPLEMENTARY_CODE_POINT
    destination[index] = (0xD800 + (offset ushr 10)).toChar()
    destination[index + 1] = (0xDC00 + (offset and 0x3FF)).toChar()
    return 2
}

internal fun StringBuilder.appendCodePoint(codePoint: Int): StringBuilder {
    if (codePoint < MIN_SUPPLEMENTARY_CODE_POINT) return append(codePoint.toChar())
    val offset = codePoint - MIN_SUPPLEMENTARY_CODE_POINT
    append((0xD800 + (offset ushr 10)).toChar())
    return append((0xDC00 + (offset and 0x3FF)).toChar())
}

/** The code point starting at [index] (a lone surrogate is returned as itself). */
internal fun CharArray.codePointAt(index: Int): Int {
    val high = this[index]
    if (high.isHighSurrogate() && index + 1 < size) {
        val low = this[index + 1]
        if (low.isLowSurrogate()) return toCodePoint(high, low)
    }
    return high.code
}

/** The code point starting at [index] (a lone surrogate is returned as itself). */
internal fun CharSequence.codePointAt(index: Int): Int {
    val high = this[index]
    if (high.isHighSurrogate() && index + 1 < length) {
        val low = this[index + 1]
        if (low.isLowSurrogate()) return toCodePoint(high, low)
    }
    return high.code
}
