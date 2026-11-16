package riffet.ui.timeline

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import riffet.theme.RiffetCodeColors
import riffet.theme.RiffetColors
import riffet.theme.RiffetDefaultCodeTheme

/*
 * Syntax colouring for code blocks and the file preview.
 *
 * The web uses Prism (refractor) and colours its token classes from the design tokens
 * (apps/web/src/styles/index.css, "Syntax highlighting"): keywords `accent`, functions
 * `accentHover`, strings `success`, numbers and constants `warning`, tags and properties `danger`
 * (each muted toward `fg3`, as there), comments italic `fg3`, punctuation `fg3`. This is a
 * single-pass scanner with the same palette:
 * it knows comments, strings, numbers, keywords and calls for each language family, which is what
 * makes code readable at a glance, and it never fails — unknown input is just plain text.
 */

private enum class Family { C, PYTHON, SHELL, SQL, MARKUP, CSS, JSON, YAML, PLAIN }

private class Syntax(
    val family: Family,
    val keywords: Set<String>,
    val lineComments: List<String>,
    val blockComment: Pair<String, String>?,
    val backtickStrings: Boolean = false,
    val tripleQuotes: Boolean = false,
)

private fun words(text: String): Set<String> = text.split(' ', '\n').filter { it.isNotBlank() }.toSet()

private val constants = words("true false null nil None True False undefined NaN Infinity this self super it")

private val jsKeywords = words(
    """
    abstract as async await break case catch class const continue debugger declare default delete do else enum
    export extends finally for from function get if implements import in infer instanceof interface is keyof let
    namespace new of private protected public readonly return satisfies set static switch throw try type typeof
    var void while with yield
    """,
)
private val kotlinKeywords = words(
    """
    abstract actual annotation as break by catch class companion const constructor continue crossinline data do
    else enum expect external final finally for fun get if import in infix init inline inner interface internal is
    lateinit noinline object open operator out override package private protected public reified return sealed set
    suspend tailrec throw try typealias val value var vararg when where while
    """,
)
private val javaKeywords = words(
    """
    abstract assert boolean break byte case catch char class const continue default do double else enum extends
    final finally float for goto if implements import instanceof int interface long native new package private
    protected public record return short static strictfp switch synchronized throw throws transient try var void
    volatile while yield sealed permits
    """,
)
private val goKeywords = words(
    """
    break case chan const continue default defer else fallthrough for func go goto if import interface map package
    range return select struct switch type var
    """,
)
private val rustKeywords = words(
    """
    as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub
    ref return static struct trait type unsafe use where while
    """,
)
private val swiftKeywords = words(
    """
    as associatedtype break case catch class continue default defer deinit do else enum extension fallthrough fileprivate
    for func guard if import in init inout internal is let open operator private protocol public repeat return static
    struct subscript switch throw throws try typealias var where while async await some any
    """,
)
private val cKeywords = words(
    """
    auto break case char const continue default do double else enum extern float for goto if inline int long register
    return short signed sizeof static struct switch typedef union unsigned void volatile while class namespace
    template typename public private protected virtual override using new delete operator friend constexpr nullptr
    bool include define ifdef ifndef endif pragma
    """,
)
private val pythonKeywords = words(
    """
    and as assert async await break class continue def del elif else except finally for from global if import in is
    lambda match case nonlocal not or pass raise return try while with yield
    """,
)
private val shellKeywords = words(
    """
    if then else elif fi case esac for while until do done in function return local export readonly declare set unset
    shift exit source alias echo cd
    """,
)
private val sqlKeywords = words(
    """
    select from where and or not insert into values update set delete create table alter drop index view join left
    right inner outer full on as group by order having limit offset union all distinct case when then else end is
    null primary key foreign references default unique begin commit rollback with returning exists between like in
    SELECT FROM WHERE AND OR NOT INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE ALTER DROP INDEX VIEW JOIN LEFT
    RIGHT INNER OUTER FULL ON AS GROUP BY ORDER HAVING LIMIT OFFSET UNION ALL DISTINCT CASE WHEN THEN ELSE END IS
    NULL PRIMARY KEY FOREIGN REFERENCES DEFAULT UNIQUE BEGIN COMMIT ROLLBACK WITH RETURNING EXISTS BETWEEN LIKE IN
    """,
)

private val syntaxes: Map<String, Syntax> = buildMap {
    val cComments = listOf("//")
    val cBlock = "/*" to "*/"
    val js = Syntax(Family.C, jsKeywords, cComments, cBlock, backtickStrings = true)
    listOf("javascript", "js", "jsx", "typescript", "ts", "tsx", "mjs", "cjs").forEach { put(it, js) }
    val kotlin = Syntax(Family.C, kotlinKeywords, cComments, cBlock, tripleQuotes = true)
    listOf("kotlin", "kt", "kts").forEach { put(it, kotlin) }
    val java = Syntax(Family.C, javaKeywords, cComments, cBlock, tripleQuotes = true)
    listOf("java", "scala", "groovy", "gradle", "dart", "csharp", "cs").forEach { put(it, java) }
    put("go", Syntax(Family.C, goKeywords, cComments, cBlock, backtickStrings = true))
    listOf("rust", "rs").forEach { put(it, Syntax(Family.C, rustKeywords, cComments, cBlock)) }
    put("swift", Syntax(Family.C, swiftKeywords, cComments, cBlock, tripleQuotes = true))
    val c = Syntax(Family.C, cKeywords, cComments, cBlock)
    listOf("c", "h", "cpp", "cc", "hpp", "cxx", "objc", "m", "mm", "php", "proto").forEach { put(it, c) }
    val python = Syntax(Family.PYTHON, pythonKeywords, listOf("#"), null, tripleQuotes = true)
    listOf("python", "py", "ruby", "rb", "r").forEach { put(it, python) }
    val shell = Syntax(Family.SHELL, shellKeywords, listOf("#"), null)
    listOf("bash", "sh", "shell", "zsh", "console", "dockerfile", "makefile", "ini", "env", "properties").forEach { put(it, shell) }
    val sql = Syntax(Family.SQL, sqlKeywords, listOf("--"), cBlock)
    listOf("sql", "lua").forEach { put(it, sql) }
    val markup = Syntax(Family.MARKUP, emptySet(), emptyList(), "<!--" to "-->")
    listOf("html", "htm", "xml", "svg", "vue", "svelte", "markup", "plist").forEach { put(it, markup) }
    val css = Syntax(Family.CSS, words("important media import supports keyframes"), emptyList(), cBlock)
    listOf("css", "scss", "less").forEach { put(it, css) }
    val json = Syntax(Family.JSON, emptySet(), listOf("//"), cBlock)
    listOf("json", "jsonc", "json5").forEach { put(it, json) }
    val yaml = Syntax(Family.YAML, emptySet(), listOf("#"), null)
    listOf("yaml", "yml", "toml").forEach { put(it, yaml) }
}

/** The language of a file, from its extension or its well-known name; null when unknown. */
internal fun languageForPath(path: String): String? {
    val name = path.substringAfterLast('/').lowercase()
    when (name) {
        "dockerfile" -> return "dockerfile"
        "makefile" -> return "makefile"
        ".env" -> return "env"
    }
    val extension = name.substringAfterLast('.', "")
    return extension.takeIf { it.isNotEmpty() && it in syntaxes }
}

internal fun isHighlightable(language: String?): Boolean = language != null && language.lowercase() in syntaxes

private class Palette(colors: RiffetColors, code: RiffetCodeColors) {
    val comment = SpanStyle(
        color = code.comment,
        fontStyle = if (code.commentItalic) FontStyle.Italic else FontStyle.Normal,
    )
    val punctuation = SpanStyle(color = colors.fg3)
    val keyword = SpanStyle(color = code.keyword)
    val function = SpanStyle(color = code.declaration)
    val string = SpanStyle(color = code.string)
    val number = SpanStyle(color = code.number)
    val constant = SpanStyle(color = code.constant)
    val tag = SpanStyle(color = code.tag)
    val attribute = SpanStyle(color = code.attribute)
    val property = SpanStyle(color = code.property)
    val annotation = SpanStyle(color = code.annotation)
}

/** [code] with colour spans for [language]; plain text when the language is unknown. */
internal fun highlightCode(
    code: String,
    language: String?,
    colors: RiffetColors,
    codeColors: RiffetCodeColors = RiffetDefaultCodeTheme.light,
): AnnotatedString {
    val syntax = language?.lowercase()?.let { syntaxes[it] } ?: return AnnotatedString(code)
    if (code.length > MAX_HIGHLIGHT_CHARS) return AnnotatedString(code)
    val palette = Palette(colors, codeColors)
    return buildAnnotatedString {
        append(code)
        SyntaxScanner(code, syntax, palette) { style, start, end -> addStyle(style, start, end) }.run()
    }
}

/** Past this a block is a log or a data dump, and colour would cost more than it gives. */
private const val MAX_HIGHLIGHT_CHARS = 200_000

private class SyntaxScanner(
    private val text: String,
    private val syntax: Syntax,
    private val palette: Palette,
    private val emit: (SpanStyle, Int, Int) -> Unit,
) {
    private var i = 0

    fun run() {
        if (syntax.family == Family.MARKUP) return markup()
        while (i < text.length) {
            val start = i
            val ch = text[i]
            when {
                comment() -> Unit
                syntax.tripleQuotes && (text.startsWith("\"\"\"", i) || text.startsWith("'''", i)) -> {
                    val quote = text.substring(i, i + 3)
                    val end = text.indexOf(quote, i + 3).let { if (it < 0) text.length else it + 3 }
                    i = end
                    emit(palette.string, start, end)
                }
                ch == '"' || ch == '\'' || (ch == '`' && syntax.backtickStrings) -> {
                    string(ch)
                    val style = if (syntax.family == Family.JSON && followedByColon()) palette.attribute else palette.string
                    emit(style, start, i)
                }
                ch.isDigit() && (start == 0 || !isIdentifierPart(text[start - 1])) -> {
                    number()
                    emit(palette.number, start, i)
                }
                isIdentifierStart(ch) -> identifier(start)
                syntax.family == Family.SHELL && ch == '$' -> {
                    i++
                    if (i < text.length && text[i] == '{') {
                        i = text.indexOf('}', i).let { if (it < 0) text.length else it + 1 }
                    } else {
                        while (i < text.length && isIdentifierPart(text[i])) i++
                    }
                    emit(palette.function, start, i)
                }
                ch in PUNCTUATION -> {
                    i++
                    emit(palette.punctuation, start, i)
                }
                else -> i++
            }
            // This runs on the UI thread: a rule that consumed nothing must not spin forever.
            if (i <= start) i = start + 1
        }
    }

    private fun comment(): Boolean {
        val start = i
        val block = syntax.blockComment
        if (block != null && text.startsWith(block.first, i)) {
            val end = text.indexOf(block.second, i + block.first.length).let { if (it < 0) text.length else it + block.second.length }
            i = end
            emit(palette.comment, start, end)
            return true
        }
        val marker = syntax.lineComments.firstOrNull { text.startsWith(it, i) } ?: return false
        // `#` only starts a comment at a word boundary: `a#b` in a URL or `$#` in shell is not one.
        if (marker == "#" && i > 0 && !text[i - 1].isWhitespace()) return false
        // `//` inside a URL (`https://`) is not a comment either.
        if (marker == "//" && i > 0 && text[i - 1] == ':') return false
        val end = text.indexOf('\n', i).let { if (it < 0) text.length else it }
        i = end
        emit(palette.comment, start, end)
        return true
    }

    private fun string(quote: Char) {
        i++
        while (i < text.length) {
            val c = text[i]
            if (c == '\\') {
                i += 2
                continue
            }
            if (c == quote) {
                i++
                return
            }
            // A newline ends an unterminated ordinary string, so one stray quote cannot colour the rest.
            if (c == '\n' && quote != '`') return
            i++
        }
        i = text.length
    }

    private fun followedByColon(): Boolean {
        var j = i
        while (j < text.length && (text[j] == ' ' || text[j] == '\t')) j++
        return j < text.length && text[j] == ':'
    }

    private fun number() {
        if (text.startsWith("0x", i) || text.startsWith("0X", i)) {
            i += 2
            while (i < text.length && (text[i].isLetterOrDigit() || text[i] == '_')) i++
            return
        }
        while (i < text.length && (text[i].isDigit() || text[i] == '_' || text[i] == '.')) {
            if (text[i] == '.' && (i + 1 >= text.length || !text[i + 1].isDigit())) break
            i++
        }
        if (i < text.length && (text[i] == 'e' || text[i] == 'E')) {
            val save = i
            i++
            if (i < text.length && (text[i] == '+' || text[i] == '-')) i++
            if (i < text.length && text[i].isDigit()) {
                while (i < text.length && text[i].isDigit()) i++
            } else {
                i = save
            }
        }
        while (i < text.length && text[i].isLetter()) i++
    }

    private fun identifier(start: Int) {
        // The start character is consumed unconditionally: `@` starts an annotation but is not an
        // identifier part, and a scan that does not advance here never terminates.
        i = start + 1
        while (i < text.length && isIdentifierPart(text[i])) i++
        val word = text.substring(start, i)
        val style = when {
            word.startsWith("@") -> palette.annotation
            syntax.family == Family.YAML && followedByColon() -> palette.attribute
            syntax.family == Family.CSS && followedByColon() -> palette.property
            word in syntax.keywords -> palette.keyword
            word in constants -> palette.constant
            i < text.length && text[i] == '(' && syntax.family != Family.YAML -> palette.function
            else -> null
        }
        if (style != null) emit(style, start, i)
    }

    private fun markup() {
        while (i < text.length) {
            val start = i
            when {
                text.startsWith("<!--", i) -> {
                    val end = text.indexOf("-->", i).let { if (it < 0) text.length else it + 3 }
                    i = end
                    emit(palette.comment, start, end)
                }
                text[i] == '<' && i + 1 < text.length && (text[i + 1].isLetter() || text[i + 1] == '/' || text[i + 1] == '!' || text[i + 1] == '?') -> tag()
                else -> i++
            }
            if (i <= start) i = start + 1
        }
    }

    private fun tag() {
        val start = i
        i++
        if (i < text.length && (text[i] == '/' || text[i] == '!' || text[i] == '?')) i++
        while (i < text.length && (isIdentifierPart(text[i]) || text[i] == ':' || text[i] == '-' || text[i] == '.')) i++
        emit(palette.punctuation, start, start + 1)
        emit(palette.tag, start + 1, i)
        while (i < text.length && text[i] != '>') {
            val c = text[i]
            val at = i
            when {
                c == '"' || c == '\'' -> {
                    string(c)
                    emit(palette.string, at, i)
                }
                isIdentifierStart(c) -> {
                    i++
                    while (i < text.length && (isIdentifierPart(text[i]) || text[i] == ':' || text[i] == '-' || text[i] == '.')) i++
                    emit(palette.attribute, at, i)
                }
                else -> i++
            }
        }
        if (i < text.length) {
            emit(palette.punctuation, i, i + 1)
            i++
        }
    }

    private fun isIdentifierStart(c: Char) = c.isLetter() || c == '_' || c == '@' && syntax.family != Family.SHELL
    private fun isIdentifierPart(c: Char) = c.isLetterOrDigit() || c == '_' || c == '$' && syntax.family == Family.C

    private companion object {
        const val PUNCTUATION = "{}[]();,.:<>=+-*/%!&|^~?"
    }
}