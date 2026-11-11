package riffet.ui.home

import riffet.contracts.BrowseEntry
import riffet.contracts.BrowseResult

/*
 * Path arithmetic for the directory picker, kept apart from the sheet so it can be tested without
 * Compose. Every rule here mirrors `apps/web/src/app/DirectoryPicker.tsx`: the phone has no idea
 * where the Mac's home is, so anything that displays or joins a host path has to use the `home` the
 * server reports with each listing.
 */

/** One tappable segment of the picker's breadcrumb: what it reads as, and where it goes. */
data class DirectoryCrumb(val label: String, val path: String)

/**
 * How a host path reads on the phone: `~` for the host's home, `~/…` under it, otherwise the path
 * itself. This is the web's `displayPath`, and it exists because the phone cannot shorten a path it
 * knows nothing about — the server's own `home` is the only thing that can decide this.
 */
fun browseDisplayPath(path: String, home: String): String {
    if (path.isEmpty() || home.isEmpty()) return path
    if (path == home) return "~"
    return if (path.startsWith("$home/")) "~/" + path.removePrefix("$home/") else path
}

/** One entry's full path, joined the way the server does it, so `/` never becomes `//`. */
fun browseChildPath(parent: String, name: String): String =
    if (parent == "/") "/$name" else "${parent.trimEnd('/')}/$name"

/** The segments of a path, each carrying the path to return to when it is tapped. */
fun browseCrumbs(path: String): List<DirectoryCrumb> {
    val crumbs = mutableListOf(DirectoryCrumb("/", "/"))
    if (path.isEmpty() || path == "/") return crumbs
    var cursor = ""
    for (part in path.split('/')) {
        if (part.isEmpty()) continue
        cursor = "$cursor/$part"
        crumbs += DirectoryCrumb(part, cursor)
    }
    return crumbs
}

/**
 * The entries the sheet draws. Hidden folders stay in the listing and are only filtered out while
 * the toggle is off, exactly like the web's "显示隐藏文件" checkbox — a hidden directory is still a
 * directory someone may want to start a session in.
 */
fun browseEntries(result: BrowseResult?, showHidden: Boolean): List<BrowseEntry> =
    result?.entries?.filter { showHidden || !it.hidden } ?: emptyList()
