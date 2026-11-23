package riffet.terminal

/**
 * A row in a terminal, composed of a fixed number of cells.
 *
 * The text in the row is stored in a char[] array, [mText], for quick access during rendering.
 */
class TerminalRow(
    /** The number of columns in this terminal row. */
    private val mColumns: Int,
    style: Long,
) {

    /** The text filling this terminal row. */
    var mText: CharArray = CharArray((SPARE_CAPACITY_FACTOR * mColumns).toInt())

    /** The number of java chars used in [mText]. */
    private var mSpaceUsed = 0

    /** If this row has been line wrapped due to text output at the end of line. */
    internal var mLineWrap = false

    /** The style bits of each cell in the row. See [TextStyle]. */
    internal val mStyle: LongArray = LongArray(mColumns)

    /** If this row might contain chars with width != 1, used for deactivating fast path */
    internal var mHasNonOneWidthOrSurrogateChars = false

    /**
     * Monotonic content version bumped whenever this row's cells, styles, or wrap flag mutate.
     * Frozen copies created by [copy] carry the same [revision] and [sourceRow] so frame snapshots
     * can reuse unchanged copies in O(1) without reallocating [mText]/[mStyle].
     */
    var revision: Long = 1L
        private set

    internal var sourceRow: TerminalRow = this
        private set

    internal fun markDirty() {
        revision++
    }

    /** True when this frozen copy still matches [live] with no intervening mutations. */
    fun matchesSource(live: TerminalRow): Boolean = sourceRow === live && revision == live.revision

    /** Construct a blank row (containing only whitespace, ' ') with a specified style. */
    init {
        clear(style)
    }

    /** NOTE: The sourceX2 is exclusive. */
    fun copyInterval(line: TerminalRow, sourceX1: Int, sourceX2: Int, destinationX: Int) {
        var sourceX1 = sourceX1
        var destinationX = destinationX
        mHasNonOneWidthOrSurrogateChars = mHasNonOneWidthOrSurrogateChars or line.mHasNonOneWidthOrSurrogateChars
        val x1 = line.findStartOfColumn(sourceX1)
        val x2 = line.findStartOfColumn(sourceX2)
        var startingFromSecondHalfOfWideChar = (sourceX1 > 0 && line.wideDisplayCharacterStartingAt(sourceX1 - 1))
        val sourceChars = if (this === line) line.mText.copyOf(line.mText.size) else line.mText
        var latestNonCombiningWidth = 0
        var i = x1
        while (i < x2) {
            val sourceChar = sourceChars[i]
            var codePoint = if (sourceChar.isHighSurrogate()) toCodePoint(sourceChar, sourceChars[++i]) else sourceChar.code
            if (startingFromSecondHalfOfWideChar) {
                // Just treat copying second half of wide char as copying whitespace.
                codePoint = ' '.code
                startingFromSecondHalfOfWideChar = false
            }
            val w = WcWidth.width(codePoint)
            if (w > 0) {
                destinationX += latestNonCombiningWidth
                sourceX1 += latestNonCombiningWidth
                latestNonCombiningWidth = w
            }
            setChar(destinationX, codePoint, line.getStyle(sourceX1))
            i++
        }
    }

    fun getSpaceUsed(): Int {
        return mSpaceUsed
    }

    /**
     * Not in Termux: an independent copy of this row, for a renderer that draws on another thread
     * while the engine keeps writing to the original.
     */
    fun copy(): TerminalRow {
        val copy = TerminalRow(mColumns, 0)
        copy.mText = mText.copyOf()
        copy.mSpaceUsed = mSpaceUsed
        mStyle.copyInto(copy.mStyle)
        copy.mLineWrap = mLineWrap
        copy.mHasNonOneWidthOrSurrogateChars = mHasNonOneWidthOrSurrogateChars
        copy.sourceRow = this
        copy.revision = revision
        return copy
    }

    /** Note that the column may end of second half of wide character. */
    fun findStartOfColumn(column: Int): Int {
        if (column == mColumns) return getSpaceUsed()

        var currentColumn = 0
        var currentCharIndex = 0
        while (true) { // 0<2 1 < 2
            var newCharIndex = currentCharIndex
            val c = mText[newCharIndex++] // cci=1, cci=2
            val isHigh = c.isHighSurrogate()
            val codePoint = if (isHigh) toCodePoint(c, mText[newCharIndex++]) else c.code
            val wcwidth = WcWidth.width(codePoint) // 1, 2
            if (wcwidth > 0) {
                currentColumn += wcwidth
                if (currentColumn == column) {
                    while (newCharIndex < mSpaceUsed) {
                        // Skip combining chars.
                        if (mText[newCharIndex].isHighSurrogate()) {
                            if (WcWidth.width(toCodePoint(mText[newCharIndex], mText[newCharIndex + 1])) <= 0) {
                                newCharIndex += 2
                            } else {
                                break
                            }
                        } else if (WcWidth.width(mText[newCharIndex].code) <= 0) {
                            newCharIndex++
                        } else {
                            break
                        }
                    }
                    return newCharIndex
                } else if (currentColumn > column) {
                    // Wide column going past end.
                    return currentCharIndex
                }
            }
            currentCharIndex = newCharIndex
        }
    }

    private fun wideDisplayCharacterStartingAt(column: Int): Boolean {
        var currentCharIndex = 0
        var currentColumn = 0
        while (currentCharIndex < mSpaceUsed) {
            val c = mText[currentCharIndex++]
            val codePoint = if (c.isHighSurrogate()) toCodePoint(c, mText[currentCharIndex++]) else c.code
            val wcwidth = WcWidth.width(codePoint)
            if (wcwidth > 0) {
                if (currentColumn == column && wcwidth == 2) return true
                currentColumn += wcwidth
                if (currentColumn > column) return false
            }
        }
        return false
    }

    fun clear(style: Long) {
        mText.fill(' ')
        mStyle.fill(style)
        mSpaceUsed = mColumns
        mHasNonOneWidthOrSurrogateChars = false
        revision++
    }

    /*
     * Not in Termux: whole-row shortcuts for TerminalBuffer.blockSet / blockCopy. Upstream goes
     * through setChar one cell at a time, and once a row holds a wide or non-BMP character every
     * setChar scans the row from its start, so erasing or scrolling a line of Chinese text costs
     * O(columns²). Both produce exactly what the per-cell loop produces.
     */

    /** Same as `setChar(x, ' ', style)` for every x from [column] to the end of the row. */
    internal fun clearFrom(column: Int, style: Long) {
        if (column == 0) {
            clear(style)
            return
        }
        if (!mHasNonOneWidthOrSurrogateChars) {
            mText.fill(' ', column, mColumns)
            mStyle.fill(style, column, mColumns)
            revision++
            return
        }
        // Blanking the second half of a wide character blanks its first half too, in this style.
        val start = if (wideDisplayCharacterStartingAt(column - 1)) column - 1 else column
        val index = findStartOfColumn(start)
        val needed = index + (mColumns - start)
        if (needed > mText.size) mText = mText.copyOf(needed + mColumns)
        mText.fill(' ', index, needed)
        mSpaceUsed = needed
        mStyle.fill(style, start, mColumns)
        revision++
    }

    /** Same as `copyInterval(source, 0, columns, 0)`: this row becomes a copy of [source]'s cells. */
    internal fun copyAllFrom(source: TerminalRow) {
        if (mText.size < source.mSpaceUsed) mText = CharArray(source.mText.size)
        source.mText.copyInto(mText, 0, 0, source.mSpaceUsed)
        mSpaceUsed = source.mSpaceUsed
        source.mStyle.copyInto(mStyle)
        mHasNonOneWidthOrSurrogateChars = source.mHasNonOneWidthOrSurrogateChars
        revision++
        if (!mHasNonOneWidthOrSurrogateChars) return
        // copyInterval writes each character with its first column's style, which also lands on
        // the second column of a wide character; do the same.
        var index = 0
        var column = 0
        while (index < mSpaceUsed && column < mColumns) {
            val codePoint = mText.codePointAt(index)
            index += charCount(codePoint)
            val width = WcWidth.width(codePoint)
            if (width <= 0) continue
            if (width == 2 && column + 1 < mColumns) mStyle[column + 1] = mStyle[column]
            column += width
        }
    }

    // https://github.com/steven676/Android-Terminal-Emulator/commit/9a47042620bec87617f0b4f5d50568535668fe26
    fun setChar(columnToSet: Int, codePoint: Int, style: Long) {
        var columnToSet = columnToSet
        if (columnToSet < 0 || columnToSet >= mStyle.size)
            throw IllegalArgumentException("TerminalRow.setChar(): columnToSet=$columnToSet, codePoint=$codePoint, style=$style")

        revision++
        mStyle[columnToSet] = style

        val newCodePointDisplayWidth = WcWidth.width(codePoint)
        // Not in Termux: the second column of a wide character takes its style too, as in tmux and
        // xterm. Otherwise it keeps whatever was drawn there before and its background shows through
        // as a stale half cell behind the character.
        if (newCodePointDisplayWidth == 2 && columnToSet + 1 < mStyle.size) mStyle[columnToSet + 1] = style

        // Fast path when we don't have any chars with width != 1
        if (!mHasNonOneWidthOrSurrogateChars) {
            if (codePoint >= MIN_SUPPLEMENTARY_CODE_POINT || newCodePointDisplayWidth != 1) {
                mHasNonOneWidthOrSurrogateChars = true
            } else {
                mText[columnToSet] = codePoint.toChar()
                return
            }
        }

        val newIsCombining = newCodePointDisplayWidth <= 0

        val wasExtraColForWideChar = (columnToSet > 0) && wideDisplayCharacterStartingAt(columnToSet - 1)

        if (newIsCombining) {
            // When standing at second half of wide character and inserting combining:
            if (wasExtraColForWideChar) {
                columnToSet--
                // Not in Termux: both halves keep one style (see the wide-character note above).
                mStyle[columnToSet] = style
            }
        } else {
            // Check if we are overwriting the second half of a wide character starting at the previous column:
            if (wasExtraColForWideChar) setChar(columnToSet - 1, ' '.code, style)
            // Check if we are overwriting the first half of a wide character starting at the next column:
            val overwritingWideCharInNextColumn = newCodePointDisplayWidth == 2 && wideDisplayCharacterStartingAt(columnToSet + 1)
            if (overwritingWideCharInNextColumn) setChar(columnToSet + 1, ' '.code, style)
        }

        var text = mText
        val oldStartOfColumnIndex = findStartOfColumn(columnToSet)
        val oldCodePointDisplayWidth = WcWidth.width(text, oldStartOfColumnIndex)

        // Get the number of elements in the mText array this column uses now
        val oldCharactersUsedForColumn: Int
        if (columnToSet + oldCodePointDisplayWidth < mColumns) {
            val oldEndOfColumnIndex = findStartOfColumn(columnToSet + oldCodePointDisplayWidth)
            oldCharactersUsedForColumn = oldEndOfColumnIndex - oldStartOfColumnIndex
        } else {
            // Last character.
            oldCharactersUsedForColumn = mSpaceUsed - oldStartOfColumnIndex
        }

        // If MAX_COMBINING_CHARACTERS_PER_COLUMN already exist in column, then ignore adding additional combining characters.
        if (newIsCombining) {
            val combiningCharsCount = WcWidth.zeroWidthCharsCount(mText, oldStartOfColumnIndex, oldStartOfColumnIndex + oldCharactersUsedForColumn)
            if (combiningCharsCount >= MAX_COMBINING_CHARACTERS_PER_COLUMN)
                return
        }

        // Find how many chars this column will need
        var newCharactersUsedForColumn = charCount(codePoint)
        if (newIsCombining) {
            // Combining characters are added to the contents of the column instead of overwriting them, so that they
            // modify the existing contents.
            // FIXME: Unassigned characters also get width=0.
            newCharactersUsedForColumn += oldCharactersUsedForColumn
        }

        val oldNextColumnIndex = oldStartOfColumnIndex + oldCharactersUsedForColumn
        val newNextColumnIndex = oldStartOfColumnIndex + newCharactersUsedForColumn

        val javaCharDifference = newCharactersUsedForColumn - oldCharactersUsedForColumn
        if (javaCharDifference > 0) {
            // Shift the rest of the line right.
            val oldCharactersAfterColumn = mSpaceUsed - oldNextColumnIndex
            if (mSpaceUsed + javaCharDifference > text.size) {
                // We need to grow the array
                val newText = CharArray(text.size + mColumns)
                text.copyInto(newText, 0, 0, oldNextColumnIndex)
                text.copyInto(newText, newNextColumnIndex, oldNextColumnIndex, oldNextColumnIndex + oldCharactersAfterColumn)
                text = newText
                mText = text
            } else {
                text.copyInto(text, newNextColumnIndex, oldNextColumnIndex, oldNextColumnIndex + oldCharactersAfterColumn)
            }
        } else if (javaCharDifference < 0) {
            // Shift the rest of the line left.
            text.copyInto(text, newNextColumnIndex, oldNextColumnIndex, mSpaceUsed)
        }
        mSpaceUsed += javaCharDifference

        // Store char. A combining character is stored at the end of the existing contents so that it modifies them:
        toChars(codePoint, text, oldStartOfColumnIndex + (if (newIsCombining) oldCharactersUsedForColumn else 0))

        if (oldCodePointDisplayWidth == 2 && newCodePointDisplayWidth == 1) {
            // Replace second half of wide char with a space. Which mean that we actually add a ' ' java character.
            if (mSpaceUsed + 1 > text.size) {
                val newText = CharArray(text.size + mColumns)
                text.copyInto(newText, 0, 0, newNextColumnIndex)
                text.copyInto(newText, newNextColumnIndex + 1, newNextColumnIndex, mSpaceUsed)
                text = newText
                mText = text
            } else {
                text.copyInto(text, newNextColumnIndex + 1, newNextColumnIndex, mSpaceUsed)
            }
            text[newNextColumnIndex] = ' '

            ++mSpaceUsed
        } else if (oldCodePointDisplayWidth == 1 && newCodePointDisplayWidth == 2) {
            if (columnToSet == mColumns - 1) {
                throw IllegalArgumentException("Cannot put wide character in last column")
            } else if (columnToSet == mColumns - 2) {
                // Truncate the line to the second part of this wide char:
                mSpaceUsed = newNextColumnIndex
            } else {
                // Overwrite the contents of the next column, which mean we actually remove java characters. Due to the
                // check at the beginning of this method we know that we are not overwriting a wide char.
                var newNextNextColumnIndex = newNextColumnIndex + (if (mText[newNextColumnIndex].isHighSurrogate()) 2 else 1)
                // Not in Termux: the next column's combining characters go with it. Upstream left
                // them behind, attached to the wide character that replaced the column.
                while (newNextNextColumnIndex < mSpaceUsed) {
                    val next = mText.codePointAt(newNextNextColumnIndex)
                    if (WcWidth.width(next) > 0) break
                    newNextNextColumnIndex += charCount(next)
                }
                val nextLen = newNextNextColumnIndex - newNextColumnIndex

                // Shift the array leftwards.
                text.copyInto(text, newNextColumnIndex, newNextNextColumnIndex, mSpaceUsed)
                mSpaceUsed -= nextLen
            }
        }
    }

    internal fun isBlank(): Boolean {
        for (charIndex in 0 until getSpaceUsed())
            if (mText[charIndex] != ' ') return false
        return true
    }

    fun getStyle(column: Int): Long {
        return mStyle[column]
    }

    private companion object {
        const val SPARE_CAPACITY_FACTOR = 1.5f

        /**
         * Max combining characters that can exist in a column, that are separate from the base character
         * itself. Any additional combining characters will be ignored and not added to the column.
         *
         * There does not seem to be limit in unicode standard for max number of combination characters
         * that can be combined but such characters are primarily under 10.
         *
         * "Section 3.6 Combination" of unicode standard contains combining characters info.
         * - https://www.unicode.org/versions/Unicode15.0.0/ch03.pdf
         * - https://en.wikipedia.org/wiki/Combining_character#Unicode_ranges
         * - https://stackoverflow.com/questions/71237212/what-is-the-maximum-number-of-unicode-combined-characters-that-may-be-needed-to
         *
         * UAX15-D3 Stream-Safe Text Format limits to max 30 combining characters.
         * > The value of 30 is chosen to be significantly beyond what is required for any linguistic or technical usage.
         * > While it would have been feasible to chose a smaller number, this value provides a very wide margin,
         * > yet is well within the buffer size limits of practical implementations.
         * - https://unicode.org/reports/tr15/#Stream_Safe_Text_Format
         * - https://stackoverflow.com/a/11983435/14686958
         *
         * We choose the value 15 because it should be enough for terminal based applications and keep
         * the memory usage low for a terminal row, won't affect performance or cause terminal to
         * lag or hang, and will keep malicious applications from causing harm. The value can be
         * increased if ever needed for legitimate applications.
         */
        const val MAX_COMBINING_CHARACTERS_PER_COLUMN = 15
    }
}
