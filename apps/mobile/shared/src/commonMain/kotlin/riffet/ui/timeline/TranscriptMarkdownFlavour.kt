package riffet.ui.timeline

import org.intellij.markdown.flavours.gfm.GFMFlavourDescriptor
import org.intellij.markdown.flavours.gfm.StrikeThroughDelimiterParser
import org.intellij.markdown.parser.sequentialparsers.DelimiterParser
import org.intellij.markdown.parser.sequentialparsers.EmphasisLikeParser
import org.intellij.markdown.parser.sequentialparsers.SequentialParser
import org.intellij.markdown.parser.sequentialparsers.SequentialParserManager
import org.intellij.markdown.parser.sequentialparsers.TokensCache
import org.intellij.markdown.parser.sequentialparsers.impl.EmphStrongDelimiterParser

/** GFM with punctuation allowed inside a **strong** span adjacent to CJK text. */
internal class TranscriptMarkdownFlavour : GFMFlavourDescriptor() {
    override val sequentialParserManager = object : SequentialParserManager() {
        override fun getParserSequence(): List<SequentialParser> =
            GFMFlavourDescriptor().sequentialParserManager.getParserSequence().map { parser ->
                if (parser is EmphasisLikeParser) {
                    EmphasisLikeParser(CjkStrongDelimiterParser(), StrikeThroughDelimiterParser())
                } else parser
            }
    }
}

/**
 * Only relax double asterisks at a CJK boundary, e.g. **未保存内容有保护。**取消手势。
 * Upstream still handles pairing, nesting and escapes. Earlier inline parsers consume code spans
 * and link destinations before this runs. Source text and AST offsets remain unchanged.
 */
private class CjkStrongDelimiterParser : DelimiterParser() {
    private val delegate = EmphStrongDelimiterParser()

    override fun scan(tokens: TokensCache, iterator: TokensCache.Iterator, delimiters: MutableList<Info>): Int {
        val first = delimiters.size
        val steps = delegate.scan(tokens, iterator, delimiters)
        if (steps != 2 || iterator.firstChar != '*') return steps
        val right = iterator.advance()
        val opens = iterator.charLookup(-1).isCjkLetter() && isPunctuation(right, 1)
        val closes = isPunctuation(iterator, -1) && right.charLookup(1).isCjkLetter()
        for (index in first until delimiters.size) {
            if (opens) delimiters[index].canOpen = true
            if (closes) delimiters[index].canClose = true
        }
        return steps
    }

    override fun process(
        tokens: TokensCache,
        iterator: TokensCache.Iterator,
        delimiters: MutableList<Info>,
        result: SequentialParser.ParsingResultBuilder,
    ) = delegate.process(tokens, iterator, delimiters, result)
}

private fun Char.isCjkLetter(): Boolean =
    this in '\u3400'..'\u9fff' || this in '\uf900'..'\ufaff' ||
        this in '\u3040'..'\u30ff' || this in '\uac00'..'\ud7af'
