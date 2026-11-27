package riffet.ui.timeline

import androidx.compose.runtime.staticCompositionLocalOf
import io.ktor.http.decodeURLPart
import io.ktor.http.encodeURLParameter

/*
 * What the transcript needs to open, show and download the files an agent names. Ported from
 * apps/web/src/app/session/fileAccess.ts and imageSource.ts; absent outside a project, and every
 * row that uses it degrades to plain text when it is.
 */

internal class FileAccess(
    val projectId: String,
    /** Opens the file in the project's file panel, scrolled to [line] when given. */
    val open: (path: String, line: Int?) -> Unit,
    /** Saves the file to the device. */
    val download: (path: String) -> Unit,
    /**
     * Whether this platform can save a download (`downloadsSupported`). False only where
     * `saveDownload` throws, and the rows then draw no download button at all rather than one
     * that does nothing.
     */
    val canDownload: Boolean = true,
    val downloadAttachment: ((id: String, name: String) -> Unit)? = null,
    /** Opens an explicitly interactive artifact; ordinary file links keep using [open]. */
    val openVisualization: (path: String) -> Unit = { path -> open(path, null) },
    /** The file a path written in the conversation's text names (`resolveFileMention`). */
    val resolve: (path: String) -> String = { it },
)

internal val LocalFileAccess = staticCompositionLocalOf<FileAccess?> { null }

private fun decode(value: String): String = runCatching { value.decodeURLPart() }.getOrDefault(value)

/** The renderer passes CommonMark's optional destination delimiters through to link clicks. */
internal fun markdownLinkDestination(value: String): String = value.trim().removeSurrounding("<", ">")

private val schemePattern = Regex("^[a-z][a-z0-9+.-]*:", RegexOption.IGNORE_CASE)

/**
 * Markdown image targets that name a local file: absolute or relative paths and `file://` URLs.
 * Remote, data and app URLs stay as written. Markdown percent-encodes destinations, so the path is
 * decoded back to what is on disk.
 */
internal fun localImagePath(src: String): String? {
    val value = markdownLinkDestination(src)
    if (value.isEmpty() || value.startsWith("//") || value.startsWith("/api/") || value.startsWith("#") || value.startsWith("?")) return null
    if (value.startsWith("file://", ignoreCase = true)) {
        val rest = value.substring("file://".length)
        val path = if (rest.startsWith("/")) rest else rest.substringAfter('/', "").let { if (it.isEmpty()) "" else "/$it" }
        return decode(path).ifEmpty { null }
    }
    if (schemePattern.containsMatchIn(value)) return null
    return decode(value)
}

internal data class LocalFileLink(val path: String, val line: Int?)

private val anchorPattern = Regex("#L(\\d+)(?:-L?\\d+)?$", RegexOption.IGNORE_CASE)
private val lineSuffixPattern = Regex("^(.+?):(\\d+)(?::\\d+)?$")

/** A markdown link that names a local file, with the line from a `#L12` anchor or a trailing `:12`. */
internal fun localFileLink(href: String): LocalFileLink? {
    val value = markdownLinkDestination(href)
    val anchor = anchorPattern.find(value)?.groupValues?.get(1)
    val path = localImagePath(value.replace(Regex("#.*$"), "")) ?: return null
    if (path.endsWith("/")) return null
    val suffix = lineSuffixPattern.find(path)
    val line = (anchor ?: suffix?.groupValues?.get(2))?.toIntOrNull()?.takeIf { it > 0 }
    return LocalFileLink(suffix?.groupValues?.get(1) ?: path, line)
}

private val extensionlessFiles = Regex("^(?:Makefile|Dockerfile|Containerfile|Justfile|Procfile|Gemfile|Rakefile|Brewfile|LICENSE|NOTICE|CODEOWNERS)$")
private val extensionPattern = Regex("\\.([A-Za-z0-9]{1,10})$")
private val bareFileExtensions = setOf(
    "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "json", "jsonl", "md", "mdx", "mdc", "css", "scss", "html", "vue", "svelte",
    "yml", "yaml", "toml", "ini", "xml", "kt", "kts", "gradle", "swift", "m", "mm", "h", "c", "cc", "cpp", "hpp", "go", "rs", "py",
    "rb", "java", "sh", "bash", "zsh", "sql", "txt", "csv", "lock", "pdf", "png", "jpg", "jpeg", "gif", "svg", "webp", "proto",
)
// Names may be in any script (`困在团里.html`), so letters, marks and digits are Unicode ones.
private val codeFilePathPattern = Regex("^[\\p{L}\\p{M}\\p{N}_.@~/-]+(?::\\d+(?::\\d+)?)?$")

private fun fileShaped(path: String): Boolean {
    val name = path.substringAfterLast('/')
    if (extensionlessFiles.matches(name)) return true
    val extension = extensionPattern.find(name)?.groupValues?.get(1)?.lowercase() ?: return false
    return '/' in path || name.startsWith('.') || extension in bareFileExtensions
}

/** Inline code the agent writes as `path/to/file.ts:42` or `~/.cursor/rules/foo.mdc`. */
internal fun codeFileMention(text: String): LocalFileLink? {
    val value = text.trim()
    if (value.isEmpty() || value.length > 300 || !codeFilePathPattern.matches(value)) return null
    val target = localFileLink(value) ?: return null
    return target.takeIf { fileShaped(it.path) }
}

private const val FILE_LINK_PREFIX = "riffet-file://open?path="

internal fun encodeFileLinkUrl(path: String, line: Int?): String = buildString {
    append(FILE_LINK_PREFIX)
    append(path.encodeURLParameter(spaceToPlus = false))
    if (line != null) append("&line=").append(line)
}

internal fun parseFileLinkUrl(url: String): LocalFileLink? {
    if (!url.startsWith(FILE_LINK_PREFIX)) return null
    val query = url.substring(FILE_LINK_PREFIX.length)
    val lineIndex = query.indexOf("&line=")
    val rawPath = if (lineIndex < 0) query else query.substring(0, lineIndex)
    val line = if (lineIndex < 0) null else query.substring(lineIndex + "&line=".length).toIntOrNull()?.takeIf { it > 0 }
    val path = decode(rawPath).ifEmpty { return null }
    return LocalFileLink(path, line)
}

/** What a markdown link target is, mirroring the web's `markdownLinkTarget`. */
internal sealed interface MarkdownLinkTarget {
    data object Web : MarkdownLinkTarget
    data class File(val link: LocalFileLink) : MarkdownLinkTarget
    /** A subagent id or a bare word: neither a page nor a file, so a tap does nothing. */
    data object Text : MarkdownLinkTarget
}

internal fun markdownLinkTarget(href: String): MarkdownLinkTarget {
    val value = markdownLinkDestination(href)
    if (value.isEmpty()) return MarkdownLinkTarget.Text
    if (schemePattern.containsMatchIn(value) && !value.startsWith("file://", ignoreCase = true)) return MarkdownLinkTarget.Web
    if (value.startsWith("#") || value.startsWith("?") || value.startsWith("//") || value.startsWith("/api/")) return MarkdownLinkTarget.Web
    val link = localFileLink(value) ?: return MarkdownLinkTarget.Text
    val name = link.path.substringAfterLast('/')
    val named = extensionlessFiles.matches(name) || extensionPattern.containsMatchIn(name)
    return if (named || (link.line != null && '/' in link.path)) MarkdownLinkTarget.File(link) else MarkdownLinkTarget.Text
}
