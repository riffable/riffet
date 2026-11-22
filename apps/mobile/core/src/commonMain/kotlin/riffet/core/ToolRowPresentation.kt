package riffet.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

/*
 * Unified 4-slot tool row presentation across all agents (Claude Code, Codex, Cursor, Droid,
 * DSH, Pi, MCP) — Kotlin port of `packages/timeline/src/toolPresentation.ts`.
 *
 * Pure display summarizer: decoupled from approval / read-only enforcement. Expanding any row still
 * exposes the original full command, diff, locations and output.
 */

data class ToolRowPresentation(
    val icon: String,
    val verb: String,
    /** Runtime prefix (`python3`, `node`, `sqlite3`). */
    val prefix: String? = null,
    val primary: String,
    /** `"path"`, `"code"`, or `"prose"`. */
    val primaryKind: String,
    /** Muted trailing scope or argument (`gen-contracts.ts`, `main`, `actions/runs/…/jobs`). */
    val secondary: String? = null,
    /** Line range for file reads (`L155–194`). */
    val lineRange: String? = null,
    /** Fallback line count for inline scripts (`28`). */
    val lineCount: Int? = null,
    /** Additional sub-commands in a chained shell line (`+2`). */
    val extraCommands: Int? = null,
    /** Additional files beyond those listed inline (`+4`). */
    val extraFiles: Int? = null,
    /** Adjacent completed calls sharing a non-empty `mergeKey` collapse into one `×N` row. */
    val mergeKey: String? = null,
    /** Generalized `secondary` when merged calls differ only by a numeric/UUID segment. */
    val mergedSecondary: String? = null,
) {
    /** Trailing context to display: generalized form when merged, else `secondary`. */
    fun displaySecondary(merged: Boolean = false): String? =
        if (merged) (mergedSecondary ?: secondary) else secondary
}

data class ToolPathParts(val name: String, val dir: String?)

/**
 * Split a display path into primary-first `(name, dir)` (`"Timeline.tsx"` + `"apps/web/src/app/session"`)
 * so every tool row reads left-dark / right-muted, matching command and search rows.
 */
fun splitToolPath(path: String): ToolPathParts {
    val clean = path.trimEnd('/')
    val slash = clean.lastIndexOf('/')
    if (slash <= 0) return ToolPathParts(clean.ifEmpty { path }, null)
    return ToolPathParts(clean.substring(slash + 1), clean.substring(0, slash))
}

private val ROOT_CD_RE = Regex("^cd\\s+\\.?\\s*(?:&&|;)\\s*")
private val SHELL_WRAPPER_RE = Regex("^(?:/(?:usr/)?bin/)?(?:z|ba|da|k|a)?sh\\s+-[a-z]*c\\s+([\\s\\S]+)$")
private val HOME_PREFIX_RE = Regex("^/(?:Users|home)/[^/]+(?=/|$)")
private val HEX_ID_RE = Regex("^[0-9a-f-]{16,}$", RegexOption.IGNORE_CASE)
private val VERSION_TEMP_RE = Regex("-[0-9]+\\.[0-9]+\\.[0-9]+\\.")
private val ENV_PREFIX_RE = Regex("^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|\"[^\"]*\"|\\S*)\\s+)+")
private val REDIR_OP_RE = Regex("^(?:\\d*>>?|&>>?)")
private val FORMAT_PIPE_RE = Regex("^(?:tail|head|sed|awk|cut|sort|uniq|wc|tr|tee|jq|cat|less|more|column|xargs|nl|fold|fmt|grep|rg)\\b")
private val HEREDOC_OP_RE = Regex("^<<-?\\s*['\"]?([A-Za-z_][A-Za-z0-9_]*)['\"]?")
private val LINE_RANGE_TITLE_RE = Regex("\\s+(?:lines?\\s+|L)(\\d+)(?:\\s*[-–]\\s*(\\d+))?$", RegexOption.IGNORE_CASE)
private val SCRIPT_API_RE = Regex("\\b(?:Path|open|readFileSync|writeFileSync|readFile|writeFile|connect|glob|unlink|remove|stat)\\s*\\(\\s*[rfbu]?(['\"])([^'\"\\n]{2,180})\\1")
private val SCRIPT_LITERAL_RE = Regex("(['\"])((?:/tmp/|~/|\\.?/)?[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*\\.[A-Za-z0-9]{1,12})\\1")
private val FILE_EXT_RE = Regex("\\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|mdx|mdc|swift|kt|kts|py|rb|go|rs|sh|zsh|bash|yml|yaml|toml|po|xcstrings|plist|xml|html|css|sql|sqlite|db|log|txt|tgz|gz|zip|tar|csv|env|lock)$", RegexOption.IGNORE_CASE)
private val NON_FILE_LITERAL_RE = Regex("^(?:utf-?8|ascii|latin-?1|r|w|rb|wb|a|ab)$", RegexOption.IGNORE_CASE)
private val COMMENT_LINE_RE = Regex("^(?:#|//)\\s*(.+)$")
private val CODING_HEADER_RE = Regex("^coding[:=]", RegexOption.IGNORE_CASE)
private val IMPORT_STMT_RE = Regex("^(?:import|from)\\s+\\S+")
private val SIMPLE_EXT_RE = Regex("\\.[a-z0-9]{1,10}$", RegexOption.IGNORE_CASE)
private val PATH_SPLIT_RE = Regex("[\\\\/]")
private val RUNNER_VALUE_FLAG_RE = Regex("^(?:-C|--cwd|--prefix|--pack-destination|--reporter|--config)$")
private val SEARCH_LONG_VALUE_FLAG_RE = Regex("^--(?:glob|iglob|type|type-not|include|exclude|max-count|max-depth|context|after-context|before-context|file|ignore-file)$")
private val FIND_NAME_FLAG_RE = Regex("^-(?:i?name|i?path|i?regex)$")
private val NUMERIC_RE = Regex("^\\d+$")
private val SED_PRINT_RE = Regex("^\\d+(?:,\\d+)?p;?$")
private val GLOB_ALL_RE = Regex("^\\*(?:/\\*+)?$|^\\*\\*$")
private val GH_REPO_PREFIX_RE = Regex("^/?repos/[^/]+/[^/]+/")
private val GH_NUM_SEG_RE = Regex("/\\d+(?=/|$)")
private val GH_HEX_SEG_RE = Regex("/[0-9a-f]{12,}(?=/|$)", RegexOption.IGNORE_CASE)
private val GH_API_VALUE_FLAGS = setOf("-X", "--method", "-q", "--jq", "-H", "--header", "-f", "-F", "--raw-field", "--field", "--input", "--hostname", "--cache", "-t", "--template", "-p", "--preview")
private val URL_SCHEME_RE = Regex("^https?://")
private val URL_EXTRACT_RE = Regex("^https?://([^/?#]+)(/[^#]*)?")

private val SILENT_PROGRAMS = setOf("cd", "echo", "printf", "true", ":", "pwd", "export", "set", "unset")
private val INLINE_RUNTIMES = setOf("python", "python3", "node", "ruby", "perl", "tsx", "bun", "deno")
private val GIT_ACTION_PRIORITY = setOf("merge", "rebase", "commit", "push", "pull", "cherry-pick", "checkout", "switch", "reset", "tag", "stash")
private val GIT_GLOBAL_VALUE_FLAGS = setOf("-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env")
private val GIT_NOISE_FLAGS = setOf(
    "--quiet", "-q", "--no-tags", "--no-edit", "--short", "-s", "--branch", "-b", "-uall", "--porcelain",
    "--reset-author", "--no-verify", "--no-pager", "--no-ext-diff", "--no-color", "--color=never",
)
private val RUNNER_TOOLS = setOf(
    "pnpm", "npm", "yarn", "bun", "npx", "pnpx", "cargo", "go", "swift", "xcodebuild",
    "gradle", "gradlew", "pytest", "vitest", "jest", "make", "docker", "kubectl", "uv", "poetry", "pip", "pip3",
)

private fun unwrapShell(raw: String): String {
    val trimmed = raw.trim()
    val match = SHELL_WRAPPER_RE.matchEntire(trimmed) ?: return trimmed
    val inner = match.groupValues[1].trim()
    if ((inner.startsWith("'") && inner.endsWith("'")) || (inner.startsWith("\"") && inner.endsWith("\""))) {
        return inner.substring(1, inner.length - 1).replace(Regex("\\\\([\"'\\\\])"), "$1")
    }
    return inner
}

/** Collapse long absolute paths outside the project root (`~/.cursor/…/terminals/426378.txt`, `/tmp/…/pack.log`). */
fun compactDisplayPath(path: String, root: String? = null): String {
    val rel = stripRoot(path.trim(), root).removePrefix("./")
    if (!rel.startsWith("/") && !rel.startsWith("~")) return rel
    val home = rel.replace(HOME_PREFIX_RE, "~")
    val leadingSlash = home.startsWith("/")
    val parts = home.split('/').filter { it.isNotEmpty() }
    if (parts.size == 3 && leadingSlash && (parts[0] == "tmp" || parts[0] == "var") && parts[1].length > 18) {
        return "/${parts[0]}/…/${parts[2]}"
    }
    if (parts.size <= 3) return home
    val first = if (leadingSlash) "/${parts[0]}" else parts[0]
    val second = parts[1]
    val last = parts.last()
    val parent = parts[parts.size - 2]
    val head = if (first == "~" && second.startsWith(".") && second.length <= 16) "$first/$second" else first
    val tail = if (parent.length <= 18 && !HEX_ID_RE.matches(parent) && !VERSION_TEMP_RE.containsMatchIn(parent)) {
        "$parent/$last"
    } else {
        last
    }
    return "$head/…/$tail"
}

/** Compact a search regex or query for one-line display: no shell quotes, bounded OR branches. */
fun compactSearchQuery(raw: String): String {
    val fallback = cleanLabel(raw)
    var q = fallback.replace(Regex("^['\"]|['\"]$"), "")
    q = q.replace(Regex("^\\\\b|\\\\b$"), "")
    if (q.startsWith("(?:") && q.endsWith(")") && isWrappedGroup(q)) {
        q = q.substring(3, q.length - 1)
    } else if (q.startsWith("(") && q.endsWith(")") && isWrappedGroup(q)) {
        q = q.substring(1, q.length - 1)
    }
    if ('|' in q) {
        val parts = q.split(Regex("\\\\?\\|")).map { it.trim() }.filter { it.isNotEmpty() }
        if (parts.size > 2) {
            val two = "${parts[0]}|${parts[1]}"
            q = if (two.length <= 20) "$two…" else "${parts[0].take(18)}…"
        }
    }
    if (q.isEmpty()) q = fallback
    if (q.length > 24) q = "${q.take(22)}…"
    return q
}

private fun isWrappedGroup(text: String): Boolean {
    var depth = 0
    var i = 0
    while (i < text.length) {
        val ch = text[i]
        if (ch == '\\') { i += 2; continue }
        if (ch == '(') depth += 1
        else if (ch == ')') {
            depth -= 1
            if (depth == 0) return i == text.length - 1
        }
        i += 1
    }
    return false
}

/** Compact a search target path: basename for a single file, last 2 segments for a directory. */
fun compactSearchScope(path: String?, root: String? = null): String? {
    if (path == null) return null
    val clean = stripRoot(path.trim(), root).removePrefix("./").trimEnd('/')
    if (clean.isEmpty() || clean == ".") return null
    if (clean.startsWith("/") || clean.startsWith("~")) return compactDisplayPath(clean, root)
    val parts = clean.split('/').filter { it.isNotEmpty() }
    if (parts.size <= 1) return clean
    val last = parts.last()
    if (SIMPLE_EXT_RE.containsMatchIn(last)) return last
    return parts.takeLast(2).joinToString("/")
}

private fun splitChainedCommands(headline: String): List<String> {
    val parts = ArrayList<String>()
    val current = StringBuilder()
    var quote: Char? = null
    var parenDepth = 0
    var i = 0
    while (i < headline.length) {
        val ch = headline[i]
        if (quote == '\'') {
            current.append(ch)
            if (ch == '\'') quote = null
            i += 1
            continue
        }
        if (ch == '\\' && i + 1 < headline.length) {
            current.append(ch).append(headline[i + 1])
            i += 2
            continue
        }
        if (quote == '"') {
            current.append(ch)
            if (ch == '"') quote = null
            i += 1
            continue
        }
        if (ch == '\'' || ch == '"') {
            quote = ch
            current.append(ch)
            i += 1
            continue
        }
        if (ch == '(') parenDepth += 1
        else if (ch == ')' && parenDepth > 0) parenDepth -= 1
        if (parenDepth == 0) {
            val next = headline.getOrNull(i + 1)
            if (ch == ';') {
                val seg = current.toString().trim()
                if (seg.isNotEmpty()) parts += seg
                current.clear()
                i += 1
                continue
            }
            if ((ch == '&' && next == '&') || (ch == '|' && next == '|')) {
                val seg = current.toString().trim()
                if (seg.isNotEmpty()) parts += seg
                current.clear()
                i += 2
                continue
            }
        }
        current.append(ch)
        i += 1
    }
    val tail = current.toString().trim()
    if (tail.isNotEmpty()) parts += tail
    return parts
}

private fun shellWords(segment: String): List<String> {
    val words = ArrayList<String>()
    val current = StringBuilder()
    var quote: Char? = null
    var hasWord = false
    var i = 0
    while (i < segment.length) {
        val ch = segment[i]
        if (quote == '\'') {
            if (ch == '\'') quote = null else current.append(ch)
            i += 1
            continue
        }
        if (quote == '"') {
            if (ch == '\\' && i + 1 < segment.length && segment[i + 1] in "\"\\$`") {
                current.append(segment[i + 1])
                i += 2
                continue
            }
            if (ch == '"') quote = null else current.append(ch)
            i += 1
            continue
        }
        if (ch == '\\' && i + 1 < segment.length) {
            current.append(segment[i + 1])
            hasWord = true
            i += 2
            continue
        }
        if (ch == '\'' || ch == '"') {
            quote = ch
            hasWord = true
            i += 1
            continue
        }
        if (ch.isWhitespace()) {
            if (hasWord) {
                words += current.toString()
                current.clear()
                hasWord = false
            }
            i += 1
            continue
        }
        current.append(ch)
        hasWord = true
        i += 1
    }
    if (hasWord) words += current.toString()
    return words
}

private fun findTopLevelPipe(text: String): Int {
    var quote: Char? = null
    var depth = 0
    var i = 0
    while (i < text.length) {
        val ch = text[i]
        if (quote == '\'') { if (ch == '\'') quote = null; i += 1; continue }
        if (ch == '\\') { i += 2; continue }
        if (quote == '"') { if (ch == '"') quote = null; i += 1; continue }
        if (ch == '\'' || ch == '"') { quote = ch; i += 1; continue }
        if (ch == '(') depth += 1
        else if (ch == ')' && depth > 0) depth -= 1
        if (depth == 0 && ch == '|' && text.getOrNull(i + 1) != '|' && text.getOrNull(i - 1) != '|') return i
        i += 1
    }
    return -1
}

/** Strip output redirections (`> file`, `2>/dev/null`, `2>&1`, `&>log`) only outside quotes. */
private fun stripRedirections(segment: String): String {
    val out = StringBuilder(segment.length)
    var quote: Char? = null
    var i = 0
    while (i < segment.length) {
        val ch = segment[i]
        if (quote == '\'') {
            out.append(ch)
            if (ch == '\'') quote = null
            i += 1
            continue
        }
        if (ch == '\\' && i + 1 < segment.length) {
            out.append(ch).append(segment[i + 1])
            i += 2
            continue
        }
        if (quote == '"') {
            out.append(ch)
            if (ch == '"') quote = null
            i += 1
            continue
        }
        if (ch == '\'' || ch == '"') {
            quote = ch
            out.append(ch)
            i += 1
            continue
        }
        val atTokenStart = i == 0 || segment[i - 1].isWhitespace()
        if (atTokenStart) {
            val op = REDIR_OP_RE.find(segment.substring(i))
            if (op != null) {
                var j = i + op.value.length
                if (segment.getOrNull(j) == '&' && segment.getOrNull(j + 1)?.isDigit() == true) {
                    j += 1
                    while (j < segment.length && segment[j].isDigit()) j += 1
                } else {
                    while (j < segment.length && (segment[j] == ' ' || segment[j] == '\t')) j += 1
                    var targetQuote: Char? = null
                    while (j < segment.length) {
                        val c = segment[j]
                        if (targetQuote == '\'') { j += 1; if (c == '\'') targetQuote = null; continue }
                        if (c == '\\' && j + 1 < segment.length) { j += 2; continue }
                        if (targetQuote == '"') { j += 1; if (c == '"') targetQuote = null; continue }
                        if (c == '\'' || c == '"') { targetQuote = c; j += 1; continue }
                        if (c.isWhitespace()) break
                        j += 1
                    }
                }
                i = j
                continue
            }
        }
        out.append(ch)
        i += 1
    }
    return out.toString().trim()
}

private fun cleanSegment(segment: String): String {
    var out = segment.trim().replace(ENV_PREFIX_RE, "")
    val pipeIndex = findTopLevelPipe(out)
    if (pipeIndex > 0) {
        val right = out.substring(pipeIndex + 1).trim()
        if (FORMAT_PIPE_RE.containsMatchIn(right)) {
            out = out.substring(0, pipeIndex).trim()
        }
    }
    return stripRedirections(out)
}

private fun programOf(word: String?): String {
    if (word.isNullOrEmpty()) return ""
    return if ('/' in word) word.substringAfterLast('/') else word
}

private data class GitSubcommand(val name: String, val modifiers: List<String>, val operands: List<String>)

private fun gitSubcommand(args: List<String>): GitSubcommand {
    var i = 0
    while (i < args.size) {
        val arg = args[i]
        if (arg in GIT_GLOBAL_VALUE_FLAGS) { i += 2; continue }
        if (arg.startsWith("--git-dir=") || arg.startsWith("--work-tree=") || (arg.startsWith("-C") && arg.length > 2)) {
            i += 1; continue
        }
        if (arg.startsWith("-")) { i += 1; continue }
        break
    }
    val name = args.getOrNull(i).orEmpty()
    val rest = if (i + 1 < args.size) args.subList(i + 1, args.size) else emptyList()
    val modifiers = ArrayList<String>()
    val operands = ArrayList<String>()
    var afterDoubleDash = false
    var j = 0
    while (j < rest.size) {
        val arg = rest[j]
        if (!afterDoubleDash && arg == "--") { afterDoubleDash = true; j += 1; continue }
        if (!afterDoubleDash && arg.startsWith("-")) {
            if (arg in GIT_NOISE_FLAGS || arg.startsWith("--format") || arg.startsWith("--pretty")) { j += 1; continue }
            if (arg == "-n" && rest.getOrNull(j + 1)?.let { NUMERIC_RE.matches(it) } == true) {
                modifiers += "-${rest[j + 1]}"
                j += 2
                continue
            }
            if (Regex("^-\\d+$").matches(arg) && name == "log") { modifiers += arg; j += 1; continue }
            if (arg in setOf("--stat", "--amend", "--cached", "--staged", "--hard", "--soft", "--force", "-f")) {
                modifiers += arg
                j += 1
                continue
            }
            if (arg == "-m" && j + 1 < rest.size) { operands += rest[j + 1]; j += 2; continue }
            j += 1
            continue
        }
        operands += arg
        j += 1
    }
    return GitSubcommand(name, modifiers, operands)
}

private data class PickedSegment(val primary: String, val fetchRef: String?)

private fun pickPrimarySegment(segments: List<String>): PickedSegment {
    var fetchRef: String? = null
    for (seg in segments) {
        val words = shellWords(cleanSegment(seg))
        if (programOf(words.firstOrNull()) == "git") {
            val sub = gitSubcommand(words.drop(1))
            if (sub.name == "fetch") {
                val ref = sub.operands.firstOrNull { it.contains("refs/heads/") || (it != "." && !it.startsWith("-")) }
                if (ref != null) fetchRef = ref.removePrefix("refs/heads/")
            }
        }
    }
    for (seg in segments) {
        val words = shellWords(cleanSegment(seg))
        if (programOf(words.firstOrNull()) == "git") {
            val rest = words.drop(1)
            val sub = gitSubcommand(rest)
            if (sub.name == "tag" && ("--list" in rest || "-l" in rest || sub.operands.isEmpty())) continue
            if (sub.name in GIT_ACTION_PRIORITY) return PickedSegment(seg, fetchRef)
        }
    }
    return PickedSegment(segments.first(), fetchRef)
}

private fun looksLikeFilePath(value: String): Boolean {
    if (value.length < 3 || value.startsWith("/dev/") || URL_SCHEME_RE.containsMatchIn(value)) return false
    if (NON_FILE_LITERAL_RE.matches(value)) return false
    if ('/' in value) return !value.any { it.isWhitespace() }
    return FILE_EXT_RE.containsMatchIn(value)
}

private fun extractScriptFiles(body: String, root: String?): List<String> {
    val candidates = ArrayList<String>()
    for (match in SCRIPT_API_RE.findAll(body)) {
        val candidate = match.groupValues[2].trim()
        if (looksLikeFilePath(candidate)) candidates += candidate
    }
    if (candidates.isEmpty()) {
        for (match in SCRIPT_LITERAL_RE.findAll(body)) {
            val candidate = match.groupValues[2].trim()
            if (looksLikeFilePath(candidate)) candidates += candidate
        }
    }
    val seen = HashSet<String>()
    val unique = ArrayList<String>()
    for (raw in candidates) {
        val clean = stripRoot(raw, root)
        if (seen.add(clean)) unique += clean
    }
    return unique
}

private fun extractScriptComment(body: String): String? {
    val lines = body.lineSequence().map { it.trim() }.filter { it.isNotEmpty() }.take(2).toList()
    for (line in lines) {
        if (line.startsWith("#!")) continue
        val match = COMMENT_LINE_RE.matchEntire(line)
        if (match != null) {
            val note = cleanLabel(match.groupValues[1])
            if (note.length in 4..72 && !CODING_HEADER_RE.containsMatchIn(note)) return note
        }
        break
    }
    return null
}

private data class HeredocRef(val marker: String, val raw: String)

private fun findUnquotedHeredoc(segment: String): HeredocRef? {
    var quote: Char? = null
    var i = 0
    while (i < segment.length) {
        val ch = segment[i]
        if (quote == '\'') { if (ch == '\'') quote = null; i += 1; continue }
        if (ch == '\\') { i += 2; continue }
        if (quote == '"') { if (ch == '"') quote = null; i += 1; continue }
        if (ch == '\'' || ch == '"') { quote = ch; i += 1; continue }
        if (ch == '<' && segment.getOrNull(i + 1) == '<' && segment.getOrNull(i + 2) != '<') {
            val match = HEREDOC_OP_RE.find(segment.substring(i))
            if (match != null) return HeredocRef(match.groupValues[1], match.value)
        }
        i += 1
    }
    return null
}

private data class InlineScript(val body: String, val lines: Int)

private fun parseInlineScript(
    program: String,
    chosenSegment: String,
    words: List<String>,
    fullCommand: String,
): InlineScript? {
    if (program !in INLINE_RUNTIMES) return null
    val heredoc = findUnquotedHeredoc(chosenSegment)
    if (heredoc != null) {
        val markerIdx = fullCommand.indexOf(heredoc.raw).coerceAtLeast(0)
        val firstNl = fullCommand.indexOf('\n', markerIdx)
        if (firstNl >= 0) {
            val rest = fullCommand.substring(firstNl + 1)
            val endMatch = Regex("(?:^|\\r?\\n)[ \\t]*${Regex.escape(heredoc.marker)}(?:\\r?\\n|$)").find(rest)
            val body = (if (endMatch != null) rest.substring(0, endMatch.range.first) else rest).trim()
            val lines = if (body.isEmpty()) 0 else body.split(Regex("\\r?\\n")).size
            return InlineScript(body, lines)
        }
        return InlineScript("", 0)
    }
    val flagIdx = words.indexOfFirst { it == "-c" || it == "-e" || it == "--eval" }
    if (flagIdx > 0) {
        var rawBody = words.getOrNull(flagIdx + 1)
        if ('\n' in fullCommand) {
            for (fullSeg in splitChainedCommands(fullCommand)) {
                val fullWords = shellWords(cleanSegment(fullSeg))
                if (programOf(fullWords.firstOrNull()) != program) continue
                val fullFlagIdx = fullWords.indexOfFirst { it == "-c" || it == "-e" || it == "--eval" }
                if (fullFlagIdx > 0 && fullFlagIdx + 1 < fullWords.size) {
                    rawBody = fullWords[fullFlagIdx + 1]
                    break
                }
            }
        }
        if (rawBody != null) {
            val body = rawBody.trim()
            val lines = if (body.isEmpty()) 0 else body.split(Regex("\\r?\\n")).size
            return InlineScript(body, lines)
        }
    }
    return null
}

private fun shortFileLabelsList(paths: List<String>): List<String> {
    val split = paths.map { it.split(PATH_SPLIT_RE).filter { part -> part.isNotEmpty() } }
    val baseCounts = HashMap<String, Int>()
    for (parts in split) {
        val base = parts.lastOrNull().orEmpty()
        baseCounts[base] = (baseCounts[base] ?: 0) + 1
    }
    return split.mapIndexed { index, parts ->
        val base = parts.lastOrNull() ?: return@mapIndexed paths[index]
        if ((baseCounts[base] ?: 0) <= 1 || parts.size <= 1) base else parts.takeLast(2).joinToString("/")
    }
}

private fun formatShortTargetList(items: List<String>, limit: Int = 2): String =
    if (items.size <= limit) items.joinToString(", ")
    else "${items.take(limit).joinToString(", ")} +${items.size - limit}"

private fun presentInlineScript(
    program: String,
    script: InlineScript,
    diffPaths: List<String>,
    extraCommands: Int?,
    root: String?,
): ToolRowPresentation {
    // Tier 1: observed file edits -> Edit
    if (diffPaths.isNotEmpty()) {
        if (diffPaths.size == 1) {
            val display = compactDisplayPath(diffPaths[0], root)
            return ToolRowPresentation(
                icon = "edit", verb = "Edit", prefix = program, primary = display, primaryKind = "path",
                extraCommands = extraCommands, mergeKey = if (extraCommands == null) "edit:$program:${diffPaths[0]}" else null,
            )
        }
        val labels = shortFileLabelsList(diffPaths)
        return ToolRowPresentation(
            icon = "edit", verb = "Edit", prefix = program,
            primary = labels.take(2).joinToString(", "), primaryKind = "code",
            extraFiles = if (diffPaths.size > 2) diffPaths.size - 2 else null,
            extraCommands = extraCommands,
        )
    }
    // Tier 2: meaningful leading comment
    extractScriptComment(script.body)?.let { note ->
        return ToolRowPresentation(
            icon = "execute", verb = "Run", prefix = program, primary = note, primaryKind = "prose",
            extraCommands = extraCommands,
        )
    }
    // Tier 3: static scan of file references
    val files = extractScriptFiles(script.body, root)
    if (files.size == 1) {
        return ToolRowPresentation(
            icon = "execute", verb = "Run", prefix = program, primary = compactDisplayPath(files[0], root),
            primaryKind = "path", extraCommands = extraCommands,
            mergeKey = if (extraCommands == null) "script:$program:${files[0]}" else null,
        )
    }
    if (files.size > 1) {
        val labels = shortFileLabelsList(files)
        return ToolRowPresentation(
            icon = "execute", verb = "Run", prefix = program, primary = labels.take(2).joinToString(", "),
            primaryKind = "code", extraFiles = if (files.size > 2) files.size - 2 else null,
            extraCommands = extraCommands,
        )
    }
    // Tier 4: short one-liner
    if (script.lines <= 1 && script.body.isNotEmpty()) {
        val statements = script.body.split(';').map { it.trim() }.filter { it.isNotEmpty() }
        val nonImports = statements.filterNot { IMPORT_STMT_RE.containsMatchIn(it) }
        val expr = cleanLabel((nonImports.ifEmpty { statements }).joinToString("; "))
        if (expr.isNotEmpty() && expr.length <= 32) {
            return ToolRowPresentation(
                icon = "execute", verb = "Run", prefix = program, primary = expr, primaryKind = "code",
                extraCommands = extraCommands,
            )
        }
    }
    // Tier 5: fallback line count
    return ToolRowPresentation(
        icon = "execute", verb = "Run", primary = program, primaryKind = "code",
        lineCount = if (script.lines > 1) script.lines else null,
        extraCommands = extraCommands,
    )
}

private fun presentSearchSegment(
    program: String,
    args: List<String>,
    extraCommands: Int?,
    root: String?,
): ToolRowPresentation? {
    val shortVal = when (program) {
        "rg" -> "efgtTABCmMjEr"
        "fd" -> "etEdSocj"
        else -> "efABCmdD"
    }
    if (program == "find") {
        val start = args.indexOfFirst { it.startsWith("-") || it == "!" || it == "(" }
        val paths = if (start < 0) args else args.subList(0, start)
        val names = ArrayList<String>()
        for (idx in args.indices) {
            if (FIND_NAME_FLAG_RE.matches(args[idx]) && idx + 1 < args.size) names += args[idx + 1]
        }
        val scope = compactSearchScope(paths.firstOrNull { it != "." && it != "./" }, root)
        if (names.isEmpty()) {
            return ToolRowPresentation(
                icon = "read", verb = "List", primary = scope ?: ".", primaryKind = "code",
                extraCommands = extraCommands,
            )
        }
        return ToolRowPresentation(
            icon = "search", verb = "Search", primary = compactSearchQuery(names.joinToString("|")),
            primaryKind = "code", secondary = scope, extraCommands = extraCommands,
        )
    }
    val patterns = ArrayList<String>()
    val operands = ArrayList<String>()
    var listFiles = false
    var i = 0
    while (i < args.size) {
        val arg = args[i]
        if (arg == "--files") {
            listFiles = true
            i += 1
            continue
        }
        if (arg == "--") {
            operands.addAll(args.drop(i + 1))
            break
        }
        if (arg == "-e" || arg == "--regexp") {
            if (i + 1 < args.size) patterns += args[i + 1]
            i += 2
            continue
        }
        if (arg.startsWith("--regexp=")) {
            patterns += arg.removePrefix("--regexp=")
            i += 1
            continue
        }
        if (arg.startsWith("--")) {
            if ('=' !in arg && SEARCH_LONG_VALUE_FLAG_RE.matches(arg)) i += 2 else i += 1
            continue
        }
        if (arg.startsWith("-") && arg.length > 1) {
            val last = arg.last()
            if (arg.length == 2 && last in shortVal) i += 2 else i += 1
            continue
        }
        operands += arg
        i += 1
    }
    if (listFiles) {
        val scope = compactSearchScope(operands.firstOrNull(), root)
        return ToolRowPresentation(
            icon = "read", verb = "List", primary = scope ?: ".",
            primaryKind = "code", extraCommands = extraCommands,
        )
    }
    val query = if (patterns.isNotEmpty()) patterns.joinToString("|") else operands.removeFirstOrNull() ?: return null
    val scope = compactSearchScope(operands.firstOrNull(), root)
    return ToolRowPresentation(
        icon = "search", verb = "Search", primary = compactSearchQuery(query), primaryKind = "code",
        secondary = scope, extraCommands = extraCommands,
    )
}

private fun presentGitSegment(
    args: List<String>,
    fetchRef: String?,
    extraCommands: Int?,
    root: String?,
): ToolRowPresentation {
    val sub = gitSubcommand(args)
    if (sub.name.isEmpty()) {
        return ToolRowPresentation(icon = "git", verb = "Git", primary = "git", primaryKind = "code", extraCommands = extraCommands)
    }
    val subLabel = (listOf(sub.name) + sub.modifiers.take(1)).joinToString(" ")
    val cleanedOps = sub.operands
        .map { op -> if (op == "FETCH_HEAD" && fetchRef != null) fetchRef else stripRoot(op, root) }
        .filter { it.isNotEmpty() && it != "." }
    var secondary: String? = when {
        cleanedOps.size == 1 -> {
            val op = cleanedOps[0]
            if ('/' in op && !op.startsWith("refs/")) compactDisplayPath(op, root) else op
        }
        cleanedOps.size > 1 -> formatShortTargetList(shortFileLabelsList(cleanedOps), 2)
        else -> null
    }
    if (secondary != null && secondary.length > 44) secondary = "${secondary.take(42)}…"
    return ToolRowPresentation(
        icon = "git", verb = "Git", primary = subLabel, primaryKind = "code",
        secondary = secondary, extraCommands = extraCommands,
        mergeKey = if (extraCommands == null) "git:$subLabel:${secondary.orEmpty()}" else null,
    )
}

private fun presentGhSegment(args: List<String>, extraCommands: Int?): ToolRowPresentation {
    val sub = args.firstOrNull().orEmpty()
    if (sub == "api") {
        var endpoint = ""
        var i = 1
        while (i < args.size) {
            val arg = args[i]
            if (arg in GH_API_VALUE_FLAGS) { i += 2; continue }
            if (arg.startsWith("-")) { i += 1; continue }
            endpoint = arg
            break
        }
        val shortEndpoint = endpoint.replace(GH_REPO_PREFIX_RE, "")
        val generalized = shortEndpoint.replace(GH_NUM_SEG_RE, "/…").replace(GH_HEX_SEG_RE, "/…")
        return ToolRowPresentation(
            icon = "execute", verb = "Run", primary = "gh api", primaryKind = "code",
            secondary = shortEndpoint.ifEmpty { null },
            extraCommands = extraCommands,
            mergeKey = if (extraCommands == null && shortEndpoint.isNotEmpty()) "gh-api:$generalized" else null,
            mergedSecondary = if (generalized != shortEndpoint) generalized else null,
        )
    }
    val rest = args.drop(1).filter { !it.startsWith("-") }
    val subCmd = when {
        rest.isNotEmpty() -> "gh $sub ${rest[0]}"
        sub.isNotEmpty() -> "gh $sub"
        else -> "gh"
    }
    val arg = rest.getOrNull(1)
    return ToolRowPresentation(
        icon = "execute", verb = "Run", primary = subCmd, primaryKind = "code",
        secondary = arg, extraCommands = extraCommands,
        mergeKey = if (extraCommands == null) "gh:$subCmd:${arg.orEmpty()}" else null,
    )
}

private fun presentRunnerSegment(
    program: String,
    args: List<String>,
    extraCommandsIn: Int?,
    root: String?,
): ToolRowPresentation {
    val kept = ArrayList<String>()
    var testFilter: String? = null
    var extraCommands = extraCommandsIn
    var i = 0
    while (i < args.size) {
        val arg = args[i]
        if ((arg == "--tests" || arg == "-k") && i + 1 < args.size) {
            testFilter = args[i + 1].replace(Regex("^['\"]|['\"]$"), "")
            i += 2
            continue
        }
        if (RUNNER_VALUE_FLAG_RE.matches(arg)) { i += 2; continue }
        if (arg.startsWith("--")) { i += 1; continue }
        if (arg.startsWith("-") && arg.length <= 3) { i += 1; continue }
        kept += stripRoot(arg, root)
        i += 1
    }
    var primary = program
    var secondary: String? = null
    var extraFiles: Int? = null
    if (program == "npx" || program == "pnpx") {
        val tool = kept.removeFirstOrNull()
        val sub = kept.removeFirstOrNull()
        primary = listOfNotNull(tool, sub).joinToString(" ").ifEmpty { program }
        secondary = kept.firstOrNull()?.let { compactDisplayPath(it, root) }
        if (kept.size > 1) extraFiles = kept.size - 1
    } else if (kept.isNotEmpty()) {
        val sub1 = kept[0]
        val sub2 = kept.getOrNull(1)?.takeIf { '/' !in it && '.' !in it && !it.startsWith(":") && it.length <= 16 }
        primary = if (sub2 != null) "$program $sub1 $sub2" else "$program $sub1"
        val rest = kept.drop(if (sub2 != null) 2 else 1)
        if (testFilter != null) {
            secondary = if ('.' in testFilter) testFilter.substringAfterLast('.') else testFilter
            if (rest.isNotEmpty()) extraCommands = (extraCommands ?: 0) + rest.size
        } else if (rest.isNotEmpty()) {
            secondary = if ('/' in rest[0]) compactDisplayPath(rest[0], root) else rest[0]
            if (rest.size > 1) extraFiles = rest.size - 1
        }
    }
    if (secondary != null && secondary.length > 44) secondary = "${secondary.take(42)}…"
    return ToolRowPresentation(
        icon = "execute", verb = "Run", primary = primary, primaryKind = "code",
        secondary = secondary, extraFiles = extraFiles, extraCommands = extraCommands,
        mergeKey = if (extraCommands == null && extraFiles == null) "run:$primary:${secondary.orEmpty()}" else null,
    )
}

private fun presentShellCommand(
    rawCommand: String,
    diffPaths: List<String>,
    root: String?,
): ToolRowPresentation {
    val unwrapped = unwrapShell(rawCommand)
    val full = stripRoot(unwrapped, root).replace(ROOT_CD_RE, "")
    val headline = commandHeadline(full)
    val rawSegments = splitChainedCommands(headline)
    val activeSegments = rawSegments.filter { seg ->
        val words = shellWords(cleanSegment(seg))
        words.isNotEmpty() && programOf(words.firstOrNull()) !in SILENT_PROGRAMS
    }
    if (activeSegments.isEmpty()) {
        return ToolRowPresentation(icon = "execute", verb = "Run", primary = headline.take(48), primaryKind = "code")
    }
    val extraCommands = if (activeSegments.size > 1) activeSegments.size - 1 else null
    val picked = pickPrimarySegment(activeSegments)
    val cleaned = cleanSegment(picked.primary)
    val words = shellWords(cleaned)
    val program = programOf(words.firstOrNull())
    val args = words.drop(1)

    // 1. Inline scripts (`python3 - <<'PY'`, `python3 -c`, `node -e`)
    parseInlineScript(program, picked.primary, words, full)?.let { script ->
        return presentInlineScript(program, script, diffPaths, extraCommands, root)
    }
    // 2. Git commands
    if (program == "git") return presentGitSegment(args, picked.fetchRef, extraCommands, root)
    // 3. GitHub CLI
    if (program == "gh") return presentGhSegment(args, extraCommands)
    // 4. Search commands
    if (program in setOf("rg", "grep", "egrep", "fgrep", "find", "fd", "fdfind")) {
        presentSearchSegment(program, args, extraCommands, root)?.let { return it }
    }
    // 5. File reading commands
    if (program in setOf("cat", "head", "tail", "nl", "less") ||
        (program == "sed" && args.any { it == "-n" || Regex("^-[a-z]*n").matches(it) })
    ) {
        val files = args.filter {
            !it.startsWith("-") && it != "-" && !NUMERIC_RE.matches(it) && !(program == "sed" && SED_PRINT_RE.matches(it))
        }
        if (files.size == 1) {
            return ToolRowPresentation(
                icon = "read", verb = "Read", primary = compactDisplayPath(files[0], root),
                primaryKind = "path", extraCommands = extraCommands,
            )
        }
        if (files.size > 1) {
            return ToolRowPresentation(
                icon = "read", verb = "Read", primary = formatShortTargetList(shortFileLabelsList(files), 2),
                primaryKind = "code", extraCommands = extraCommands,
            )
        }
    }
    // 6. Directory listings
    if (program == "ls" || program == "tree") {
        val dirs = args.filter { !it.startsWith("-") }
        return ToolRowPresentation(
            icon = "read", verb = "List",
            primary = compactSearchScope(dirs.firstOrNull(), root) ?: ".",
            primaryKind = "code", extraCommands = extraCommands,
        )
    }
    // 7. Package managers, test runners & build tools
    if (program in RUNNER_TOOLS) return presentRunnerSegment(program, args, extraCommands, root)
    // 7b. SQLite CLI
    if (program == "sqlite3") {
        val positional = args.filter { !it.startsWith("-") }
        val db = positional.firstOrNull()
        val sql = positional.getOrNull(1)?.trim()
        val shortSql = sql?.takeIf { it.startsWith(".") && it.length <= 20 }
        val target = db?.let { compactDisplayPath(it, root) }
        return if (target != null) {
            ToolRowPresentation(
                icon = "execute", verb = "Run", prefix = "sqlite3", primary = target, primaryKind = "path",
                secondary = shortSql, extraCommands = extraCommands,
                mergeKey = if (extraCommands == null) "sqlite3:${stripRoot(db, root)}:${shortSql.orEmpty()}" else null,
            )
        } else {
            ToolRowPresentation(
                icon = "execute", verb = "Run", primary = "sqlite3", primaryKind = "code",
                secondary = shortSql, extraCommands = extraCommands,
            )
        }
    }
    // 8. Script file invocation
    if (program in INLINE_RUNTIMES && args.firstOrNull()?.startsWith("-") == false) {
        val arg1 = args.getOrNull(1)?.takeIf { !it.startsWith("-") }
        return ToolRowPresentation(
            icon = "execute", verb = "Run", prefix = program, primary = compactDisplayPath(args[0], root),
            primaryKind = "path", secondary = arg1, extraCommands = extraCommands,
        )
    }
    // 9. Cleaned fallback
    val compact = cleanLabel(cleaned)
    return ToolRowPresentation(
        icon = "execute", verb = "Run",
        primary = if (compact.length > 56) "${compact.take(54)}…" else compact,
        primaryKind = "code", extraCommands = extraCommands,
    )
}

private data class LineRangeResult(val range: String?, val cleanedTitle: String)

private fun extractLineRange(title: String, input: JsonObject?, locationLine: Long?): LineRangeResult {
    val match = LINE_RANGE_TITLE_RE.find(title)
    if (match != null) {
        val start = match.groupValues[1]
        val end = match.groupValues[2].takeIf { it.isNotEmpty() }
        val range = if (end != null) "L$start–$end" else "L$start"
        return LineRangeResult(range, title.substring(0, match.range.first).trim())
    }
    val offset = finiteNumber(input?.get("offset"))?.toInt()?.takeIf { it > 0 }
    val limit = finiteNumber(input?.get("limit"))?.toInt()?.takeIf { it > 0 }
    if (offset != null && limit != null) return LineRangeResult("L$offset–${offset + limit - 1}", title)
    if (offset != null) return LineRangeResult("L$offset+", title)
    if (locationLine != null && locationLine > 0) return LineRangeResult("L$locationLine", title)
    return LineRangeResult(null, title)
}

private fun presentUrl(rawUrl: String): Pair<String, String?> {
    val match = URL_EXTRACT_RE.find(rawUrl.trim())
    if (match != null) {
        val host = match.groupValues[1]
        val path = match.groupValues[2].trimEnd('/')
        val secondary = if (path.isNotEmpty() && path != "/") {
            if (path.length > 42) "${path.take(40)}…" else path
        } else null
        return host to secondary
    }
    return rawUrl.replace(URL_SCHEME_RE, "").take(48) to null
}

private fun parseMcpTool(rawName: String, input: JsonObject?, allowDotHeuristic: Boolean): ToolRowPresentation? {
    var server: String? = null
    var tool: String? = null
    if (rawName.startsWith("mcp__")) {
        val parts = rawName.removePrefix("mcp__").split("__").filter { it.isNotEmpty() }
        if (parts.size >= 2) {
            server = parts[0].removePrefix("plugin_").removeSuffix("_tools").replace('_', '-')
            tool = parts.drop(1).joinToString("_")
        }
    } else if (allowDotHeuristic && " · " in rawName && !Regex("^(?:Read|Search|List|Edit|Write|Run)\\b").containsMatchIn(rawName)) {
        val idx = rawName.indexOf(" · ")
        val left = rawName.substring(0, idx).trim()
        val right = rawName.substring(idx + 3).trim()
        if (left.isNotEmpty() && right.isNotEmpty()) {
            server = left
            tool = right
        }
    }
    if (server == null || tool == null) return null
    var label = "$server · $tool"
    val underscore = tool.indexOf('_')
    if (underscore > 0 && server.contains("riffet", ignoreCase = true)) {
        label = "${tool.substring(0, underscore)} · ${tool.substring(underscore + 1)}"
    }
    val argVal = str(input?.get("url")) ?: str(input?.get("path")) ?: str(input?.get("query"))
        ?: str(input?.get("selector")) ?: str(input?.get("name")) ?: str(input?.get("id"))
    val secondary = argVal?.let {
        if (URL_SCHEME_RE.containsMatchIn(it)) it.replace(URL_SCHEME_RE, "").take(40) else it.take(40)
    }
    return ToolRowPresentation(
        icon = "mcp", verb = "MCP", primary = label, primaryKind = "code",
        secondary = secondary, mergeKey = "mcp:$label:${secondary.orEmpty()}",
    )
}

private fun toolDataKindFromData(data: JsonObject): String {
    val input = (data["rawInput"] ?: data["input"]) as? JsonObject
    if (data["subagent"] is JsonObject ||
        (str(data["kind"]) == "think" && !str(input?.get("subagent_type")).isNullOrEmpty())
    ) return "agent"
    val kind = str(data["kind"])
    if (kind == null || kind == "other") {
        val actions = records(input?.get("commandActions"))
        if (actions.isNotEmpty()) {
            val kinds = actions.map { action ->
                when (str(action["type"])) {
                    "read" -> "read"
                    "search", "listFiles" -> "search"
                    else -> "execute"
                }
            }
            val allSame = kinds.all { it == kinds[0] }
            return if (allSame || "execute" !in kinds) kinds[0] else "other"
        }
    }
    return kind ?: "other"
}

/** Produce the unified 4-slot presentation for any tool call event across all backends. */
fun describeToolRow(
    data: JsonObject,
    fallbackTitle: String,
    root: String? = null,
): ToolRowPresentation {
    val rawInput = data["rawInput"] ?: data["input"]
    val input = rawInput as? JsonObject
    val rawCommand = str(input?.get("command"))
        ?: (input?.get("command") as? JsonArray)?.joinToString(" ") { str(it) ?: "" }
        ?: str(data["command"])
    val command = rawCommand?.let { stripRoot(unwrapShell(it), root).replace(ROOT_CD_RE, "") }
    val contents = records(data["content"])
    val diffPaths = contents.mapNotNull { entry ->
        if (str(entry["type"]) == "diff") str(entry["path"])?.let { stripRoot(it, root) } else null
    }.distinct()
    val locations = records(data["locations"]).mapNotNull { loc ->
        val path = str(loc["path"]) ?: return@mapNotNull null
        ToolLocation(path = stripRoot(path, root), line = finiteNumber(loc["line"])?.toLong())
    }
    val kind = toolDataKindFromData(data)
    val rawToolName = str(data["toolName"]) ?: str(data["name"]).orEmpty()
    val rawTitle = cleanLabel(str(data["title"]) ?: rawToolName.ifEmpty { fallbackTitle }).replace(Regex("^`([^`]*)`$"), "$1")
    val description = str(input?.get("description"))?.trim()
    val actions = records(input?.get("commandActions"))

    // 1. Subagent rows keep dedicated prose rendering
    if (kind == "agent") {
        return ToolRowPresentation(icon = "agent", verb = "Agent", primary = rawTitle.ifEmpty { fallbackTitle }, primaryKind = "prose")
    }
    // 2. MCP tools (` · ` heuristic restricted to other/mcp without a shell command)
    parseMcpTool(rawToolName.ifEmpty { rawTitle }, input, command == null && (kind == "other" || kind == "mcp"))?.let { return it }

    // 3. Explicit prose description on a shell command
    if (command != null && !description.isNullOrEmpty() && !isCommandTitle(description, command) && kind == "execute") {
        return ToolRowPresentation(icon = "execute", verb = "Run", primary = description, primaryKind = "prose")
    }

    // 4. Structured Read
    if (kind == "read" || Regex("^Read\\s+", RegexOption.IGNORE_CASE).containsMatchIn(rawTitle)) {
        val (range, cleanedTitle) = extractLineRange(rawTitle, input, locations.firstOrNull()?.line)
        if (" · " !in cleanedTitle) {
            val explicitTarget = str(input?.get("file_path")) ?: str(input?.get("path"))
            if (explicitTarget == null && locations.size > 1) {
                val uniqueLocs = locations.map { it.path }.distinct()
                val labels = shortFileLabelsList(uniqueLocs)
                return ToolRowPresentation(
                    icon = "read", verb = "Read", primary = labels.take(2).joinToString(", "), primaryKind = "code",
                    extraFiles = if (uniqueLocs.size > 2) uniqueLocs.size - 2 else null,
                )
            }
            val targetRaw = explicitTarget ?: locations.firstOrNull()?.path
                ?: cleanedTitle.replace(Regex("^Read(?:\\s+image)?\\s+", RegexOption.IGNORE_CASE), "").trim()
            if (targetRaw.isNotEmpty() && targetRaw != "file" && ", " !in targetRaw) {
                return ToolRowPresentation(
                    icon = "read", verb = "Read", primary = compactDisplayPath(targetRaw, root), primaryKind = "path",
                    lineRange = range, mergeKey = "read:${stripRoot(targetRaw, root)}",
                )
            }
            if (targetRaw.isNotEmpty()) {
                return ToolRowPresentation(icon = "read", verb = "Read", primary = targetRaw, primaryKind = "code", lineRange = range)
            }
        }
    }

    // 5. Structured Edit / Write / Delete / Move
    if (kind in setOf("edit", "delete", "move") ||
        Regex("^(?:Edit|Write|MultiEdit|NotebookEdit)\\s+", RegexOption.IGNORE_CASE).containsMatchIn(rawTitle)
    ) {
        val verb = when {
            kind == "delete" -> "Delete"
            kind == "move" -> "Move"
            Regex("^Write\\b", RegexOption.IGNORE_CASE).containsMatchIn(rawToolName.ifEmpty { rawTitle }) -> "Write"
            else -> "Edit"
        }
        val icon = when (kind) {
            "delete" -> "delete"
            "move" -> "move"
            else -> "edit"
        }
        val paths = when {
            diffPaths.isNotEmpty() -> diffPaths
            locations.isNotEmpty() -> locations.map { it.path }
            else -> listOfNotNull(
                str(input?.get("file_path")) ?: str(input?.get("path")) ?: str(input?.get("target_file"))
                    ?: rawTitle.replace(Regex("^(?:Edit|Write|MultiEdit|NotebookEdit)\\s+", RegexOption.IGNORE_CASE), "").trim().takeIf { it.isNotEmpty() },
            )
        }.map { stripRoot(it, root) }.distinct()
        if (paths.size == 1) {
            val target = paths[0]
            return ToolRowPresentation(
                icon = icon, verb = verb, primary = compactDisplayPath(target, root), primaryKind = "path",
                mergeKey = "${verb.lowercase()}:$target",
            )
        }
        if (paths.size > 1) {
            val labels = shortFileLabelsList(paths)
            return ToolRowPresentation(
                icon = icon, verb = verb, primary = labels.take(2).joinToString(", "), primaryKind = "code",
                extraFiles = if (paths.size > 2) paths.size - 2 else null,
            )
        }
    }

    // 6. Web fetch & Web search
    if (kind == "fetch" || rawToolName.equals("WebFetch", ignoreCase = true) || rawTitle.startsWith("抓取 ")) {
        val url = str(input?.get("url"))
            ?: Regex("^抓取\\s+(\\S+)").find(rawTitle)?.groupValues?.get(1)
            ?: rawTitle.takeIf { URL_SCHEME_RE.containsMatchIn(it) }
        if (url != null) {
            val (primary, secondary) = presentUrl(url)
            return ToolRowPresentation(
                icon = "fetch", verb = "Fetch", primary = primary, primaryKind = "code",
                secondary = secondary, mergeKey = "fetch:$primary:${secondary.orEmpty()}",
            )
        }
        val query = str(input?.get("query")) ?: rawTitle
        return ToolRowPresentation(icon = "fetch", verb = "Search", primary = compactSearchQuery(query), primaryKind = "code", secondary = "web")
    }
    if (rawToolName.equals("WebSearch", ignoreCase = true) || rawToolName.equals("web_search", ignoreCase = true) || rawTitle.startsWith("网页搜索")) {
        val query = str(input?.get("query")) ?: rawTitle.removePrefix("网页搜索").trim()
        return ToolRowPresentation(icon = "fetch", verb = "Search", primary = compactSearchQuery(query.ifEmpty { rawTitle }), primaryKind = "code", secondary = "web")
    }

    // 7. Shell command
    if (command != null) {
        if (actions.isNotEmpty() && actions.all { str(it["type"]) == "listFiles" }) {
            val targets = actions.mapNotNull { str(it["path"]) }.distinct()
            val primary = when {
                targets.size == 1 -> compactSearchScope(targets[0], root) ?: "."
                targets.size > 1 -> formatShortTargetList(shortFileLabelsList(targets), 2)
                else -> "."
            }
            return ToolRowPresentation(icon = "read", verb = "List", primary = primary, primaryKind = "code")
        }
        if (actions.size == 1 && str(actions[0]["type"]) == "search") {
            val query = str(actions[0]["query"])
            val scope = compactSearchScope(str(actions[0]["path"]), root)
            if (query != null) {
                return ToolRowPresentation(icon = "search", verb = "Search", primary = compactSearchQuery(query), primaryKind = "code", secondary = scope)
            }
        }
        return presentShellCommand(rawCommand, diffPaths, root)
    }

    // 8. Native Search / Glob / Grep / List
    if (kind == "search" || Regex("^(?:Search|grep|glob|find|ls|List files)\\b", RegexOption.IGNORE_CASE).containsMatchIn(rawTitle)) {
        val rawTargetDir = str(input?.get("target_directory")) ?: str(input?.get("path")) ?: locations.firstOrNull()?.path
        if (Regex("^(?:ls|List files)\\b", RegexOption.IGNORE_CASE).containsMatchIn(rawTitle)) {
            val dir = rawTargetDir ?: rawTitle.replace(Regex("^(?:ls|List files)\\s*", RegexOption.IGNORE_CASE), "").trim().takeIf { it.isNotEmpty() }
            return ToolRowPresentation(icon = "read", verb = "List", primary = compactSearchScope(dir, root) ?: ".", primaryKind = "code")
        }
        val pattern = str(input?.get("pattern")) ?: str(input?.get("glob_pattern")) ?: str(input?.get("query"))
        if (pattern != null) {
            val trimmedPattern = pattern.trim()
            if (GLOB_ALL_RE.matches(trimmedPattern)) {
                return ToolRowPresentation(icon = "read", verb = "List", primary = compactSearchScope(rawTargetDir, root) ?: ".", primaryKind = "code")
            }
            val scope = compactSearchScope(rawTargetDir, root)
            return ToolRowPresentation(icon = "search", verb = "Search", primary = compactSearchQuery(pattern), primaryKind = "code", secondary = scope)
        }
        val stripped = rawTitle.replace(Regex("^(?:Search|grep|glob|find)\\s+", RegexOption.IGNORE_CASE), "").trim()
        val inMatch = Regex("^(.+?)\\s+in\\s+(.+)$").matchEntire(stripped)
        if (inMatch != null) {
            val queryPart = inMatch.groupValues[1].trim()
            if (GLOB_ALL_RE.matches(queryPart)) {
                return ToolRowPresentation(icon = "read", verb = "List", primary = compactSearchScope(inMatch.groupValues[2], root) ?: ".", primaryKind = "code")
            }
            val scope = compactSearchScope(inMatch.groupValues[2], root)
            return ToolRowPresentation(icon = "search", verb = "Search", primary = compactSearchQuery(queryPart), primaryKind = "code", secondary = scope)
        }
        if (GLOB_ALL_RE.matches(stripped)) {
            return ToolRowPresentation(icon = "read", verb = "List", primary = compactSearchScope(rawTargetDir, root) ?: ".", primaryKind = "code")
        }
        val scope = compactSearchScope(rawTargetDir, root)
        return ToolRowPresentation(icon = "search", verb = "Search", primary = compactSearchQuery(stripped.ifEmpty { rawTitle }), primaryKind = "code", secondary = scope)
    }

    // 9. Workflow tools
    when (kind) {
        "plan" -> return ToolRowPresentation(icon = "plan", verb = "Plan", primary = rawTitle.ifEmpty { fallbackTitle }, primaryKind = "prose")
        "question" -> return ToolRowPresentation(icon = "question", verb = "Ask", primary = rawTitle.ifEmpty { fallbackTitle }, primaryKind = "prose")
        "message" -> return ToolRowPresentation(icon = "message", verb = "Send", primary = rawTitle.ifEmpty { fallbackTitle }, primaryKind = "prose")
        "switch_mode" -> return ToolRowPresentation(icon = "switch_mode", verb = "Mode", primary = rawTitle.ifEmpty { fallbackTitle }, primaryKind = "prose")
    }

    // 10. Generic fallback
    return ToolRowPresentation(
        icon = kind.ifEmpty { "other" },
        verb = "Tool",
        primary = stripRoot(rawTitle, root).ifEmpty { fallbackTitle },
        primaryKind = "code",
    )
}

/**
 * Unified 4-slot presentation for a background shell job or background task row.
 * Uses a natural-language title when distinct from the raw command, otherwise summarizes the command.
 */
fun describeJobRow(
    title: String?,
    command: String?,
    root: String? = null,
): ToolRowPresentation {
    val cleanTitle = title?.trim()?.takeIf { it.isNotEmpty() }
    val cleanCommand = command?.trim()?.takeIf { it.isNotEmpty() }
    if (cleanTitle != null && !isCommandTitle(stripRoot(cleanTitle, root), cleanCommand?.let { stripRoot(it, root) })) {
        return ToolRowPresentation(icon = "execute", verb = "Run", primary = cleanTitle, primaryKind = "prose")
    }
    if (cleanCommand != null) return presentShellCommand(cleanCommand, emptyList(), root)
    return ToolRowPresentation(icon = "execute", verb = "Run", primary = cleanTitle ?: "shell", primaryKind = "code")
}

/** One-line plain string for search-in-page or non-rich surfaces. */
fun formatToolPresentationText(p: ToolRowPresentation): String =
    listOfNotNull(p.verb, p.prefix, p.primary, p.secondary, p.lineRange).joinToString(" ")
