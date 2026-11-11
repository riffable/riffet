package riffet.shared

import kotlinx.serialization.Serializable
import riffet.contracts.ExternalSessionDirectories
import riffet.contracts.ExternalSessionDirectory
import riffet.contracts.ExternalSessionImport
import riffet.contracts.ExternalSessionPage
import riffet.contracts.Session
import riffet.contracts.SessionResumeCommand
import riffet.contracts.TerminalHoldRelease

// RiffetApi endpoints — terminal conversations (docs/TERMINAL-SESSIONS.md): the provider conversations stored on the server's machine, their import, and taking a hold back.

@Serializable
private data class ExternalSessionImportBody(val backendId: String, val backendProfileId: String, val nativeSessionId: String)

/** [scope] is `project` (with [projectId]), `directory` (with [cwd]) or `all`. Listing starts no conversation. */
@Throws(Exception::class)
suspend fun RiffetApi.externalSessions(
    scope: String,
    projectId: String? = null,
    cwd: String? = null,
    backendId: String? = null,
    query: String? = null,
    cursor: String? = null,
    limit: Int? = null,
    nonInteractive: Boolean = false,
    refresh: Boolean = false,
): ExternalSessionPage = get(
    "/api/external-sessions",
    listOfNotNull(
        "scope" to scope,
        projectId?.let { "projectId" to it },
        cwd?.let { "cwd" to it },
        backendId?.let { "backendId" to it },
        query?.trim()?.takeIf { it.isNotEmpty() }?.let { "q" to it },
        cursor?.let { "cursor" to it },
        limit?.let { "limit" to it.toString() },
        if (nonInteractive) "nonInteractive" to "1" else null,
        if (refresh) "refresh" to "1" else null,
    ),
).decode()

@Throws(Exception::class)
suspend fun RiffetApi.externalSessionDirectories(backendId: String? = null, nonInteractive: Boolean = false): List<ExternalSessionDirectory> =
    get(
        "/api/external-sessions/directories",
        listOfNotNull(
            backendId?.let { "backendId" to it },
            if (nonInteractive) "nonInteractive" to "1" else null,
        ),
    ).decode<ExternalSessionDirectories>().directories

/** Binds the provider conversation to a Riffet one; an already bound one comes back with `created` false. Starts no CLI. */
@Throws(Exception::class)
suspend fun RiffetApi.importExternalSession(backendId: String, backendProfileId: String, nativeSessionId: String): ExternalSessionImport =
    post("/api/external-sessions/import", wireBody(ExternalSessionImportBody(backendId, backendProfileId, nativeSessionId))).decode()

/** Takes a terminal hold back. 409 `TERMINAL_STILL_RUNNING` while its CLI runs, unless [force] stops that CLI first. */
@Throws(Exception::class)
suspend fun RiffetApi.releaseTerminalHold(sessionId: String, force: Boolean = false): Session =
    delete("/api/sessions/${sessionId.enc()}/terminal-hold" + if (force) "?force=1" else "").decode<TerminalHoldRelease>().session

/** The provider session id and the shell command that resumes it; reading it starts and stops nothing. */
@Throws(Exception::class)
suspend fun RiffetApi.resumeCommand(sessionId: String): SessionResumeCommand =
    get("/api/sessions/${sessionId.enc()}/resume-command").decode()

/**
 * Stops this conversation's CLI in Riffet, so the one the reader starts from [resumeCommand] is the only writer.
 * 409 `SESSION_BUSY` while a turn runs.
 */
@Throws(Exception::class)
suspend fun RiffetApi.releaseSessionCli(sessionId: String): Session =
    post("/api/sessions/${sessionId.enc()}/release-cli").decode<TerminalHoldRelease>().session
