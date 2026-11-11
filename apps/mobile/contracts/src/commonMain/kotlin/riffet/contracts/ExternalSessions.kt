package riffet.contracts

import kotlinx.serialization.Serializable

/**
 * A provider conversation stored on the server's machine, as the import picker lists it
 * (docs/TERMINAL-SESSIONS.md). Strings rather than enums for [backendId], [source], [live] and
 * [liveStatus]: the server may add values, and one unknown row must not fail the page.
 */
@Serializable
data class ExternalSession(
    val backendId: String,
    val backendProfileId: String,
    val nativeSessionId: String,
    val cwd: String,
    val title: String,
    /** The first prompt, when the title is something else. */
    val preview: String? = null,
    val gitBranch: String? = null,
    val updatedAt: String,
    /** `cli`, `ide`, `desktop`, `exec`, `sdk` or `other`. */
    val source: String,
    /** Who runs it right now: `terminal` (a CLI outside Riffet) or `riffet`. */
    val live: String? = null,
    /** `idle` or `busy`. */
    val liveStatus: String? = null,
    /** The project whose directory is [cwd]. */
    val projectId: String? = null,
    val cwdExists: Boolean,
)

@Serializable
data class ExternalSessionFailure(val backendId: String, val message: String)

@Serializable
data class ExternalSessionPage(
    val items: List<ExternalSession>,
    val nextCursor: String? = null,
    /** Backends that could not be read this time; the rest are still listed. */
    val failures: List<ExternalSessionFailure> = emptyList(),
)

@Serializable
data class ExternalSessionDirectory(
    val cwd: String,
    val count: Int,
    val updatedAt: String,
    val projectId: String? = null,
    val exists: Boolean,
)

@Serializable
data class ExternalSessionDirectories(val directories: List<ExternalSessionDirectory> = emptyList())

@Serializable
data class ExternalSessionImport(val session: Session, val created: Boolean)

@Serializable
data class TerminalHoldRelease(val session: Session)

/** How a reader continues a conversation in a terminal of their own (docs/TERMINAL-SESSIONS.md). */
@Serializable
data class SessionResumeCommand(val nativeSessionId: String, val command: String, val credentialsOmitted: Boolean = false)
