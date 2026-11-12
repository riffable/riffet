package riffet.shared

import riffet.contracts.BranchInfo
import riffet.contracts.Checkpoint
import riffet.contracts.CheckpointChange
import riffet.contracts.GitDiff
import riffet.contracts.GitStatus
import riffet.contracts.MergeResult
import riffet.contracts.PullRequestStatus
import riffet.contracts.PushResult
import riffet.contracts.WorktreeInfo
import riffet.contracts.GitCommitDetail
import riffet.contracts.GitDiscardResult
import riffet.contracts.GitLineChange
import riffet.contracts.GitLog
import riffet.contracts.GitPullResult
import riffet.contracts.GitRefs
import riffet.contracts.RiffetJson
import riffet.contracts.WorktreeComparison
import io.ktor.client.plugins.HttpTimeoutConfig
import io.ktor.client.plugins.sse.sse
import io.ktor.client.plugins.timeout
import io.ktor.client.request.header
import io.ktor.http.HttpHeaders
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.produceIn
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.Serializable
import kotlin.time.Duration.Companion.seconds

// RiffetApi endpoints — git: status, diffs, index writes, checkpoints, worktrees and publishing. Transport and auth rules: see RiffetApi.kt.

/** While a [gitStatusStream] is open the server answers from what it last read; [fresh] reads again. */
@Throws(Exception::class)
suspend fun RiffetApi.gitStatus(projectId: String, fresh: Boolean = false): GitStatus =
    get("/api/projects/${projectId.enc()}/git/status", if (fresh) listOf("fresh" to "true") else emptyList()).decode()

/**
 * [base] compares the working tree with `checkpoint:<id>` or a commit; [commit] shows what that
 * commit changed (against [from], or its first parent). Only the working tree and index diffs carry
 * a `version`, so only they can be applied line by line.
 */
@Throws(Exception::class)
suspend fun RiffetApi.gitDiff(projectId: String, path: String, staged: Boolean = false, base: String? = null, commit: String? = null, from: String? = null): GitDiff =
    get(
        "/api/projects/${projectId.enc()}/git/diff",
        listOfNotNull("path" to path, "staged" to staged.toString(), base?.let { "base" to it }, commit?.let { "commit" to it }, from?.let { "from" to it }),
    ).decode()

/**
 * The project's status each time it changes, the first one right after connecting. The server
 * watches the files only while a stream is open. The flow redials after a dropped connection and
 * ends when the project is not a repository or the server has no such route.
 */
fun RiffetApi.gitStatusStream(projectId: String): Flow<GitStatus> = flow {
    var attempt = 0
    while (true) {
        var unavailable = false
        try {
            val token = readToken()
            http.sse(
                urlString = baseUrl + "/api/projects/${projectId.enc()}/git/stream",
                request = {
                    timeout {
                        requestTimeoutMillis = HttpTimeoutConfig.INFINITE_TIMEOUT_MS
                        socketTimeoutMillis = HttpTimeoutConfig.INFINITE_TIMEOUT_MS
                    }
                    if (!token.isNullOrEmpty()) header(HttpHeaders.Authorization, "Bearer $token")
                    header(FeaturesHeader, (config.features + "session-references-v1").distinct().joinToString(","))
                },
                // The heartbeat is a comment; without these the watchdog would fire.
                showCommentEvents = true,
            ) {
                val events = incoming.produceIn(this)
                try {
                    while (true) {
                        val event = withTimeoutOrNull(45.seconds) { events.receiveCatching() }?.getOrNull() ?: break
                        attempt = 0
                        when (event.event) {
                            "status" -> event.data?.let { data -> runCatching { RiffetJson.instance.decodeFromString(GitStatus.serializer(), data) }.getOrNull() }?.let { emit(it) }
                            "unavailable" -> { unavailable = true; break }
                        }
                    }
                } finally {
                    events.cancel()
                }
            }
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Throwable) {
            if (error.isUnauthorized()) return@flow
            if (error is io.ktor.client.plugins.sse.SSEClientException && error.response?.status?.value == 404) return@flow
        }
        if (unavailable) return@flow
        delay(config.retry.delayFor(attempt))
        attempt += 1
    }
}

/** What the branch changed since it left the main line (`GitStatus.base`), or since [base]. */
@Throws(Exception::class)
suspend fun RiffetApi.gitCompare(projectId: String, base: String? = null): WorktreeComparison =
    get("/api/projects/${projectId.enc()}/git/compare", listOfNotNull(base?.let { "base" to it })).decode()

/**
 * Throws away the working tree changes of [paths] (and unstages them). The files are saved first as
 * the result's `backup`; when one cannot be saved the server refuses with `DISCARD_UNRECOVERABLE`
 * unless [permanent].
 */
@Throws(Exception::class)
suspend fun RiffetApi.gitDiscard(projectId: String, paths: List<String>, permanent: Boolean = false): GitDiscardResult =
    post("/api/projects/${projectId.enc()}/git/discard", wireBody(GitDiscardBody(paths, if (permanent) true else null))).decode()

/**
 * Stages, unstages or discards some line ranges of a diff. [version] is the diff's own; the server
 * refuses with `GIT_DIFF_STALE` when the file has changed since. [action] is `stage`, `unstage` or
 * `discard`; a discard's result carries a `backup`.
 */
@Throws(Exception::class)
suspend fun RiffetApi.gitLines(projectId: String, path: String, action: String, changes: List<GitLineChange>, version: String, base: String? = null): GitDiscardResult =
    post("/api/projects/${projectId.enc()}/git/lines", wireBody(GitLinesBody(path, action, changes, version, base))).decode()

/** History, newest first, a page at a time; [all] walks every branch and upstream. */
@Throws(Exception::class)
suspend fun RiffetApi.gitLog(projectId: String, all: Boolean = false, skip: Int = 0): GitLog =
    get("/api/projects/${projectId.enc()}/git/log", listOf("all" to all.toString(), "skip" to skip.toString())).decode()

@Throws(Exception::class)
suspend fun RiffetApi.gitCommit(projectId: String, hash: String): GitCommitDetail =
    get("/api/projects/${projectId.enc()}/git/commits/${hash.enc()}").decode()

/** [query] narrows the remote branches listed. */
@Throws(Exception::class)
suspend fun RiffetApi.gitRefs(projectId: String, query: String? = null): GitRefs =
    get("/api/projects/${projectId.enc()}/git/refs", listOfNotNull(query?.let { "q" to it })).decode()

@Throws(Exception::class)
suspend fun RiffetApi.gitFetch(projectId: String): GitRefs =
    post("/api/projects/${projectId.enc()}/git/fetch").decode()

/** Fast-forward only: `GIT_PULL_DIVERGED` when both sides have new commits, `GIT_NO_UPSTREAM` without an upstream. */
@Throws(Exception::class)
suspend fun RiffetApi.gitPull(projectId: String): GitPullResult =
    post("/api/projects/${projectId.enc()}/git/pull").decode()

/**
 * Switches to [branch], creates it from [base] (or HEAD) when [create], or checks [remote]
 * (`origin/name`) out as a local branch. `GIT_SWITCH_BLOCKED` when uncommitted changes would be overwritten.
 */
@Throws(Exception::class)
suspend fun RiffetApi.gitSwitch(projectId: String, branch: String? = null, create: Boolean = false, base: String? = null, remote: String? = null): GitRefs =
    post("/api/projects/${projectId.enc()}/git/switch", wireBody(GitSwitchBody(branch, if (create) true else null, base, remote))).decode()

@Serializable
internal data class GitDiscardBody(val paths: List<String>, val permanent: Boolean? = null)

@Serializable
internal data class GitLinesBody(val path: String, val action: String, val changes: List<GitLineChange>, val version: String, val base: String? = null)

@Serializable
internal data class GitSwitchBody(val branch: String? = null, val create: Boolean? = null, val base: String? = null, val remote: String? = null)

@Throws(Exception::class)
suspend fun RiffetApi.checkpoints(projectId: String): List<Checkpoint> =
    get("/api/projects/${projectId.enc()}/checkpoints").decode()

@Throws(Exception::class)
suspend fun RiffetApi.createCheckpoint(projectId: String, body: CreateCheckpointRequest = CreateCheckpointRequest()): Checkpoint =
    post("/api/projects/${projectId.enc()}/checkpoints", wireBody(body)).decode()

@Throws(Exception::class)
suspend fun RiffetApi.worktrees(projectId: String): List<WorktreeInfo> =
    get("/api/projects/${projectId.enc()}/worktrees").decode()

@Throws(Exception::class)
suspend fun RiffetApi.stage(projectId: String, paths: List<String>) {
    post("/api/projects/${projectId.enc()}/git/stage", wireBody(PathsBody(paths))).discard()
}

@Throws(Exception::class)
suspend fun RiffetApi.unstage(projectId: String, paths: List<String>) {
    post("/api/projects/${projectId.enc()}/git/unstage", wireBody(PathsBody(paths))).discard()
}

@Throws(Exception::class)
suspend fun RiffetApi.commit(projectId: String, message: String) {
    post("/api/projects/${projectId.enc()}/git/commit", wireBody(CommitBody(message))).discard()
}

@Throws(Exception::class)
suspend fun RiffetApi.checkpointChanges(projectId: String, checkpointId: String): List<CheckpointChange> =
    get("/api/projects/${projectId.enc()}/checkpoints/${checkpointId.enc()}/changes").decode()

/**
 * Restores a checkpoint. [expectedChanges] is the list the user actually reviewed: the server
 * rejects the restore when the working tree has moved on since, so a stale confirmation cannot
 * silently overwrite work the reader never saw.
 */
@Throws(Exception::class)
suspend fun RiffetApi.restoreCheckpoint(projectId: String, checkpointId: String, expectedChanges: List<CheckpointChange>) {
    post(
        "/api/projects/${projectId.enc()}/checkpoints/${checkpointId.enc()}/restore",
        wireBody(RestoreBody(expectedChanges)),
    ).discard()
}

@Throws(Exception::class)
suspend fun RiffetApi.createWorktree(projectId: String, body: CreateWorktreeRequest): WorktreeInfo =
    post("/api/projects/${projectId.enc()}/worktrees", wireBody(body)).decode()

/** Removal is guarded server-side: uncommitted files, unpushed commits and an unsafe path all refuse. */
@Throws(Exception::class)
suspend fun RiffetApi.removeWorktree(projectId: String, path: String) {
    delete("/api/projects/${projectId.enc()}/worktrees", wireBody(PathBody(path))).discard()
}

@Throws(Exception::class)
suspend fun RiffetApi.gitBranch(projectId: String): BranchInfo =
    get("/api/projects/${projectId.enc()}/git/branch").decode()

/** Pushes the current branch; without [remote] the server picks the branch's own or the only one. */
@Throws(Exception::class)
suspend fun RiffetApi.gitPush(projectId: String, remote: String? = null): PushResult =
    post("/api/projects/${projectId.enc()}/git/push", wireBody(PushBody(remote))).decode()

/** `pullRequest` is null when the branch has none yet. */
@Throws(Exception::class)
suspend fun RiffetApi.pullRequest(projectId: String): PullRequestStatus =
    get("/api/projects/${projectId.enc()}/git/pull-request").decode()

@Throws(Exception::class)
suspend fun RiffetApi.createPullRequest(projectId: String, body: CreatePullRequestBody = CreatePullRequestBody()): PullRequestStatus =
    post("/api/projects/${projectId.enc()}/git/pull-request", wireBody(body)).decode()

/** Brings a worktree project's branch back into the branch its origin project has checked out. */
@Throws(Exception::class)
suspend fun RiffetApi.mergeWorktree(projectId: String, body: MergeBody = MergeBody()): MergeResult =
    post("/api/projects/${projectId.enc()}/worktree/merge", wireBody(body)).decode()
