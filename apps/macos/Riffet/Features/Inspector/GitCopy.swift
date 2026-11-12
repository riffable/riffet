import Foundation

/// The Git panel's words. They are English in every interface language, so they are plain strings
/// here and never go through the localization catalog.
enum GitCopy {
    static let changes = "Changes"
    static let history = "History"
    static let checkpoints = "Checkpoints"
    static let worktrees = "Worktrees"

    static let uncommitted = "Uncommitted"
    static let thisTurn = "This Turn"
    static let branch = "Branch"
    static let current = "Current"
    static let all = "All"

    static let stage = "Stage"
    static let unstage = "Unstage"
    static let stageAll = "Stage All"
    static let unstageAll = "Unstage All"
    static let discard = "Discard"
    static let undo = "Undo"
    static let commit = "Commit"
    static let push = "Push"
    static let pushTo = "Push to…"
    static let pull = "Pull"
    static let fetch = "Fetch"
    static let refresh = "Refresh"
    static let newBranch = "New Branch…"
    static let newBranchFromHere = "New Branch from Here"
    static let checkOutRemote = "Check Out Remote Branch…"
    static let checkOut = "Check Out"
    static let createAndSwitch = "Create and Switch"
    static let restore = "Restore"
    static let save = "Save"
    static let cancel = "Cancel"
    static let copyPath = "Copy Path"
    static let copyHash = "Copy Hash"
    static let remove = "Remove"
    static let back = "Back"

    static let workingTreeClean = "Working tree clean"
    static let noCommits = "No commits yet"
    static let noChangesThisTurn = "No changes this turn"
    static let noCheckpoints = "No checkpoints yet"
    static let notARepository = "Not a Git repository"
    static func noDifferences(from ref: String) -> String { "No differences from \(ref)" }

    static let unstaged = "Unstaged"
    static let staged = "Staged"
    static let binaryFile = "Binary file"
    static let tooLarge = "Too large to preview"

    static let discarded = "Discarded"
    static let committed = "Committed"
    static let reloaded = "File changed, reloaded"
    static let restored = "Restored"

    static let switchBlocked = "Uncommitted changes would be overwritten. Commit or discard them first."
    static let pullDiverged = "Local and remote both have new commits. Merge or rebase first."
    static let detached = "HEAD"

    static func files(_ count: Int) -> String { count == 1 ? "1 file" : "\(count.formatted()) files" }
    static func moreFiles(_ count: Int) -> String { "\(count.formatted()) more files" }
    static func firstOf(_ shown: Int, _ total: Int) -> String { "Showing the first \(shown.formatted()) of \(total.formatted()) files" }
    static func commitFiles(_ count: Int) -> String { count > 0 ? "Commit \(files(count))" : commit }
    static func discardTitle(_ name: String) -> String { "Discard \"\(name)\"?" }
    static let discardUnrecoverable = "This file can't be backed up first, so this can't be undone."
}

/// The message a git error code stands for, when it has one.
func gitErrorMessage(_ error: Error) -> String? {
    switch error.riffetCode {
    case "GIT_SWITCH_BLOCKED": GitCopy.switchBlocked
    case "GIT_PULL_DIVERGED": GitCopy.pullDiverged
    default: nil
    }
}

/// Words that are not interface text stay as they are: a one-off English sentence in the panel.
func plain(_ text: String) -> String { text }

/// A failed git call in English: the server's own message, or a plain line when it never answered.
func gitMessage(_ error: Error) -> String {
    if let known = gitErrorMessage(error) { return known }
    let ns = error as NSError
    if error.riffetStatus == 0 || ns.domain == NSURLErrorDomain { return "Can't reach the server" }
    return error.riffetMessage
}
