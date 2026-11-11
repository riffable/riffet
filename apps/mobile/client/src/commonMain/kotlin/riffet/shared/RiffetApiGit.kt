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

// RiffetApi endpoints — git: status, diffs, index writes, checkpoints, worktrees and publishing. Transport and auth rules: see RiffetApi.kt.

@Throws(Exception::class)
suspend fun RiffetApi.gitStatus(projectId: String): GitStatus =
    get("/api/projects/${projectId.enc()}/git/status").decode()

@Throws(Exception::class)
suspend fun RiffetApi.gitDiff(projectId: String, path: String, staged: Boolean = false): GitDiff =
    get("/api/projects/${projectId.enc()}/git/diff", listOf("path" to path, "staged" to staged.toString())).decode()

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
