package riffet.ui.files

import kotlin.math.floor
import riffet.contracts.GitEntry

/*
 * The pure formatting rules the files and git panels share with `apps/web/src/lib/utils.ts`.
 *
 * They are ports, not inventions, and they are the kind of thing that drifts silently: a path
 * rendered as `/Users/me/…` instead of `~/…`, or a size that reads `1.0 KB` where the web says
 * `1.0 KB` and `12 KB` where the web says `12 KB`. They live outside the composables so the one
 * focused test can pin them (`FileFormatTest`).
 */

/** `formatBytes` from utils.ts. `null` means "size was not reported", which renders as nothing. */
fun formatBytes(size: Long?): String {
    if (size == null) return ""
    return when {
        size < 1024 -> "$size B"
        size < 1024L * 1024L -> if (size < 10L * 1024L) "${fixed1(size / 1024.0)} KB" else "${fixed0(size / 1024.0)} KB"
        else -> "${fixed1(size / 1024.0 / 1024.0)} MB"
    }
}

/** `tildePath` from utils.ts: only `/Users/<name>/…` is shortened; every other absolute path is verbatim. */
fun tildePath(path: String): String {
    if (!path.startsWith("/Users/")) return path
    val rest = path.removePrefix("/Users/")
    val slash = rest.indexOf('/')
    return if (slash < 0) "~" else "~" + rest.substring(slash)
}

/**
 * Whether a path is absolute. POSIX is the server's own platform, but a Windows server reports
 * `C:\…` or `C:/…`, so both spellings count. A project-relative path is never absolute.
 */
fun isAbsolutePath(path: String): Boolean =
    path.startsWith("/") || (path.length >= 2 && path[1] == ':' && path[0].isLetter())

/** `basename` from utils.ts, for the two places a path is shown as a single segment. */
fun fileBasename(path: String): String =
    path.split('/').lastOrNull { it.isNotEmpty() } ?: path

/**
 * The server's preview is a raster image exactly when it returns an `image` mime; nothing here
 * guesses from the extension.
 */

/**
 * `toFixed(1)`, without pulling in a platform formatter (there is none in commonMain).
 *
 * `floor(x + 0.5)` rather than `kotlin.math.round`: `round` is `rint`, which breaks ties to even,
 * while `Number.prototype.toFixed` breaks them away from zero. A 10.5 KB file must read `11 KB`,
 * not `10 KB`.
 */
private fun fixed1(value: Double): String {
    val scaled = floor(value * 10.0 + 0.5).toLong()
    return "${scaled / 10}.${scaled % 10}"
}

/** `toFixed(0)`, with the same half-away-from-zero tie break as [fixed1]. */
private fun fixed0(value: Double): String = floor(value + 0.5).toLong().toString()

/**
 * `staged` in apps/web/src/app/panels/GitPanel.tsx: an index status that is neither blank nor `?`
 * (untracked). Android and iOS both read it from here, so the two lists cannot drift apart.
 */
fun gitStaged(entry: GitEntry): Boolean = entry.index != " " && entry.index != "?"

/** `unstaged` in GitPanel.tsx: a worktree change, or a brand-new untracked file. */
fun gitUnstaged(entry: GitEntry): Boolean = entry.worktree != " " || entry.index == "?"
