/** `added`/`removed` count lines against HEAD; both are absent for binary or uncounted files. */
export interface GitEntry { path: string; originalPath?: string; index: string; worktree: string; added?: number; removed?: number; }
/**
 * `base` is the main line the branch can be compared with (`origin/main`, say), absent on that line
 * itself. An untracked directory with a great many files is one entry whose path ends in `/`.
 */
export interface GitStatus { branch: string; entries: GitEntry[]; root: string; added?: number; removed?: number; base?: string; }
/**
 * `version` names the two contents compared. It is present when their lines can be staged, unstaged
 * or discarded one range at a time, and has to be sent back with such a request: the request is
 * refused if either content has changed since.
 */
export interface GitDiff { path: string; before: string; after: string; patch: string; binary: boolean; truncated?: boolean; version?: string; }
/** Lines of a diff's `before` and the lines of its `after` that replace them: zero-based, end exclusive, either range may be empty. */
export interface GitLineChange { before: [number, number]; after: [number, number]; }
/** `backup` is the checkpoint saved before a discard; restoring it undoes the discard. Absent when nothing could be saved. */
export interface GitDiscardResult { status: GitStatus; backup?: Checkpoint; }
/** `runId` marks the checkpoint taken just before that turn started, which is what "undo this turn" restores. */
export interface Checkpoint {
  id: string; projectId: string; sessionId?: string; runId?: string; title: string; createdAt: string; files: number; excluded: string[];
  /** Holds only the files it lists, so restoring it leaves every other file alone. Taken before a discard. */
  partial?: boolean;
}
export interface CheckpointChange { path: string; kind: 'added' | 'modified' | 'deleted'; beforeHash?: string; afterHash?: string; }
export interface WorktreeInfo {
  path: string; branch?: string; head: string; bare?: boolean;
  /** Resolved against the checkout root, including projects opened through a symlink or subdirectory. */
  current?: boolean;
  /** Created in Riffet's managed directory or associated with a registered Riffet project. */
  managed?: boolean;
  createdAt?: string;
}
/** `upstream` is absent until the branch is first pushed; `ahead`/`behind` then count against it. */
export interface BranchInfo { branch: string; head?: string; upstream?: string; ahead: number; behind: number; remotes: string[]; }
export interface PushResult { branch: BranchInfo; output: string; }
/** A name pointing at a commit, as the history shows it. `head` is the checkout itself when it is on no branch. */
export interface GitRefLabel { kind: 'head' | 'branch' | 'remote' | 'tag'; name: string; /** The branch that is checked out. */ current?: boolean; }
export interface GitCommit { hash: string; parents: string[]; subject: string; author: string; email: string; date: string; refs: GitRefLabel[]; }
/** One page of history, newest first. `more` says an older page exists. */
export interface GitLog { commits: GitCommit[]; more: boolean; }
/** A commit's whole message and what it changed against its first parent. */
/** `filesTotal` is set when the commit changed more files than are listed. Line counts are absent from a very wide commit. */
export interface GitCommitDetail extends GitCommit { body: string; files: Array<{ path: string; originalPath?: string; status: string; added?: number; removed?: number }>; filesTotal?: number; }
export interface GitBranchRef {
  name: string; hash: string; upstream?: string; current?: boolean;
  /** Checked out in another worktree, so it cannot be switched to here. */
  elsewhere?: boolean;
}
/**
 * `head` is absent when the checkout is on no branch. `remotes` are the remote branches without a
 * local one, named with their remote as in `origin/main`; only the first few are listed, out of
 * `remoteCount`, and a search narrows them.
 */
export interface GitRefs { head?: string; branches: GitBranchRef[]; remotes: Array<{ name: string; hash: string }>; remoteCount: number; tags: Array<{ name: string; hash: string }>; }
export interface MergeResult { merged: boolean; strategy: 'merge' | 'squash'; branch: string; into: string; head?: string; commits: number; removedWorktree?: boolean; }
export type CheckState = 'pending' | 'success' | 'failure' | 'neutral' | 'skipped';
export interface PullRequestCheck { name: string; state: CheckState; url?: string; }
export interface PullRequestInfo {
  number: number; url: string; title: string; state: 'OPEN' | 'CLOSED' | 'MERGED'; isDraft: boolean;
  headRefName: string; baseRefName: string; mergeable?: string; reviewDecision?: string;
  /** `none` when the repository runs no checks on this pull request. */
  checks: { state: CheckState | 'none'; items: PullRequestCheck[] };
}
/** `pullRequest` is null when the branch has none yet. */
export interface PullRequestStatus { branch: BranchInfo; pullRequest: PullRequestInfo | null; }
/** The change of one worktree against the commit its attempt started from, committed or not. */
export interface WorktreeComparison { base: string; /** The branch `base` was found on, when the comparison chose it. */ ref?: string; head?: string; commits: number; files: Array<{ path: string; status: string; added?: number; removed?: number }>; /** Set when more files changed than are listed. */ filesTotal?: number; added: number; removed: number; }
/** HEAD of a project's checkout. `branch` is absent when detached. */
export interface GitHead { branch?: string; head: string; short: string; }
/** A file as it is in a commit. `missing`: not in that commit (a new file). `text` is absent for a binary file. */
export interface GitFileAtRev { path: string; rev: string; text?: string; missing?: boolean; binary?: boolean; truncated?: boolean; }
export interface GitBlameCommit { hash: string; author: string; date: string; summary: string; }
/**
 * Who last changed each line of `start..end` (1-based, inclusive) of the working-tree file; `end` is
 * what was answered after the range was cut to the limit and to the file's length. `ranges` are
 * consecutive lines of one commit, with an all-zero `hash` for lines not committed yet (these have no
 * entry in `commits`).
 */
export interface GitBlame {
  path: string; start: number; end: number;
  ranges: Array<{ start: number; count: number; hash: string }>;
  commits: Record<string, GitBlameCommit>;
}
