package riffet.contracts

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/* Ported from packages/contracts/src/index.ts: line-level index writes, history and branches. */

/** Lines of a diff's `before` and the lines of its `after` that replace them: zero-based `[start, end)`, either range may be empty. */
@Serializable
data class GitLineChange(
    val before: List<Long>,
    val after: List<Long>,
)

/** [backup] is the checkpoint saved before a discard; restoring it undoes the discard. Absent when nothing could be saved. */
@Serializable
data class GitDiscardResult(
    val status: GitStatus,
    val backup: Checkpoint? = null,
)

@Serializable
enum class GitRefKind {
    @SerialName("head") HEAD,
    @SerialName("branch") BRANCH,
    @SerialName("remote") REMOTE,
    @SerialName("tag") TAG,
}

/** A name pointing at a commit. [current] marks the branch that is checked out. */
@Serializable
data class GitRefLabel(
    val kind: GitRefKind,
    val name: String,
    val current: Boolean? = null,
)

@Serializable
data class GitCommit(
    val hash: String,
    val parents: List<String> = emptyList(),
    val subject: String,
    val author: String,
    val email: String,
    val date: String,
    val refs: List<GitRefLabel> = emptyList(),
)

/** One page of history, newest first. [more] says an older page exists. */
@Serializable
data class GitLog(
    val commits: List<GitCommit>,
    val more: Boolean,
)

@Serializable
data class GitCommitFile(
    val path: String,
    val originalPath: String? = null,
    val status: String,
    val added: Long? = null,
    val removed: Long? = null,
)

/** A commit's whole message and what it changed against its first parent. [filesTotal] is set when more files changed than are listed. */
@Serializable
data class GitCommitDetail(
    val hash: String,
    val parents: List<String> = emptyList(),
    val subject: String,
    val author: String,
    val email: String,
    val date: String,
    val refs: List<GitRefLabel> = emptyList(),
    val body: String = "",
    val files: List<GitCommitFile> = emptyList(),
    val filesTotal: Long? = null,
)

/** [elsewhere]: checked out in another worktree, so it cannot be switched to here. */
@Serializable
data class GitBranchRef(
    val name: String,
    val hash: String,
    val upstream: String? = null,
    val current: Boolean? = null,
    val elsewhere: Boolean? = null,
)

@Serializable
data class GitNamedRef(
    val name: String,
    val hash: String,
)

/**
 * [head] is absent when the checkout is on no branch. [remotes] are remote branches without a local
 * one (`origin/main`); only the first few of [remoteCount] are listed, and a query narrows them.
 */
@Serializable
data class GitRefs(
    val head: String? = null,
    val branches: List<GitBranchRef> = emptyList(),
    val remotes: List<GitNamedRef> = emptyList(),
    val remoteCount: Long = 0,
    val tags: List<GitNamedRef> = emptyList(),
)

@Serializable
data class GitPullResult(
    val branch: BranchInfo,
    val status: GitStatus,
)
