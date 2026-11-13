import SwiftUI
import RiffetKit

// MARK: Shared pieces

/// A file of a diff that is not the working tree's: what a turn, a branch or a commit changed.
struct GitDiffTarget: Equatable {
    let path: String
    var added: Int64?
    var removed: Int64?
    var base: String?
    var commit: String?
    var label: String?
}

/// What happened last, with the way back from it when there is one.
struct GitNotice: Equatable, Identifiable {
    let id = UUID()
    let text: String
    var failed = false
    var undo: Checkpoint?
}

struct GitNoticeBar: View {
    let notice: GitNotice
    var busy = false
    let undo: (Checkpoint) -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: Space.sm) {
            Text(notice.text)
                .font(.riffet(size: S(12)))
                .foregroundStyle(notice.failed ? palette.danger : palette.fg)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let backup = notice.undo {
                Button(GitCopy.undo) { undo(backup) }.buttonStyle(ChipButtonStyle()).disabled(busy)
            }
        }
        .padding(.horizontal, Space.md)
        .padding(.vertical, Space.sm)
        .background(palette.bgElevated, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(palette.line))
        .padding(Space.md)
    }
}

/// `N more files`: the list shows a window of a long one.
struct GitMoreRow: View {
    let count: Int
    let action: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        Button(action: action) {
            Text(GitCopy.moreFiles(count))
                .font(.riffet(size: S(12)))
                .foregroundStyle(palette.fg3)
                .padding(.horizontal, Space.sm)
                .padding(.vertical, 6)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(HoverRowStyle())
    }
}

struct GitFootnote: View {
    let text: String
    @Environment(\.palette) private var palette

    var body: some View {
        Text(text)
            .font(.riffet(size: S(11)))
            .foregroundStyle(palette.fg4)
            .padding(.horizontal, Space.sm)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A changed file of a turn, a branch or a commit.
struct GitFileRow: View {
    let path: String
    let letter: String
    let added: Int64?
    let removed: Int64?
    @Environment(\.palette) private var palette

    var body: some View {
        let folder = path.hasSuffix("/")
        let name = (trimTrailingSlash(path) as NSString).lastPathComponent
        let directory = (trimTrailingSlash(path) as NSString).deletingLastPathComponent
        HStack(spacing: Space.sm + 2) {
            if folder { Image(icon: "folder").font(.riffet(size: S(12))).foregroundStyle(palette.fg3) }
            VStack(alignment: .leading, spacing: 1) {
                Text(name).font(.riffet(size: S(13))).foregroundStyle(palette.fg).lineLimit(1)
                if !directory.isEmpty {
                    Text(directory).font(.riffet(size: S(11))).foregroundStyle(palette.fg4).lineLimit(1).truncationMode(.head)
                }
            }
            Spacer(minLength: Space.sm)
            DiffCounts(added: added, removed: removed)
            Text(letter)
                .font(.riffet(size: S(11), weight: .medium, design: .monospaced))
                .foregroundStyle(letter == "D" ? palette.danger : palette.fg4)
                .frame(width: 12)
        }
        .padding(.horizontal, Space.sm)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

func gitStatusLetter(_ status: String) -> String {
    let letter = String(status.trimmingCharacters(in: .whitespaces).prefix(1)).uppercased()
    return letter.isEmpty ? "M" : (letter == "?" ? "U" : letter)
}

// MARK: Turn and branch scopes

enum GitScope: String, CaseIterable, Identifiable {
    case uncommitted, turn, branch

    var id: String { rawValue }

    var title: String {
        switch self {
        case .uncommitted: GitCopy.uncommitted
        case .turn: GitCopy.thisTurn
        case .branch: GitCopy.branch
        }
    }
}

/// The files of the last turn (against the checkpoint taken before it) or of the branch (against its main line).
struct GitScopedChanges: View {
    struct Item: Identifiable {
        let path: String
        let letter: String
        let added: Int64?
        let removed: Int64?
        var id: String { path }
    }

    let workbench: Workbench
    let project: Project
    let scope: GitScope
    let sessionId: String?
    /// The shared status's revision: the lists are read again when the files change.
    let revision: Int
    let onOpen: (GitDiffTarget) -> Void
    @Environment(\.palette) private var palette
    @State private var items: [Item]?
    @State private var total: Int?
    @State private var base: String?
    @State private var ref: String?
    @State private var error: String?
    @State private var limit = 300

    var body: some View {
        Group {
            if let error {
                GitInlineError(message: error)
                Spacer(minLength: 0)
            } else if let items {
                if items.isEmpty {
                    ContentUnavailableView(scope == .turn ? GitCopy.noChangesThisTurn : GitCopy.noDifferences(from: ref ?? base ?? "main"), icon: "checkmark.circle")
                } else {
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(items.prefix(limit)) { item in
                                Button { open(item) } label: { GitFileRow(path: item.path, letter: item.letter, added: item.added, removed: item.removed) }
                                    .buttonStyle(HoverRowStyle())
                                    .contextMenu { Button(GitCopy.copyPath) { copyToPasteboard(item.path) } }
                            }
                            if items.count > limit { GitMoreRow(count: items.count - limit) { limit += 1000 } }
                            if let total, total > items.count { GitFootnote(text: GitCopy.firstOf(items.count, total)) }
                        }
                        .padding(Space.xs + 2)
                    }
                }
            } else {
                Spinner(size: .regular).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .task(id: "\(project.id)|\(scope.rawValue)|\(sessionId ?? "")") { items = nil; error = nil; total = nil; limit = 300; await load() }
        .task(id: revision) { if items != nil { await load() } }
    }

    private func open(_ item: Item) {
        guard !item.path.hasSuffix("/"), let base else { return }
        onOpen(GitDiffTarget(path: item.path, added: item.added, removed: item.removed, base: base, commit: nil, label: scope == .branch ? ref : nil))
    }

    private func load() async {
        guard let api = workbench.host.api else { return }
        do {
            switch scope {
            case .turn:
                guard let sessionId, let turn = try await api.sessionCheckpoints(sessionId: sessionId).first else {
                    guard !Task.isCancelled else { return }
                    items = []
                    base = nil
                    error = nil
                    return
                }
                let changes = try await api.checkpointChanges(projectId: project.id, checkpointId: turn.id)
                guard !Task.isCancelled else { return }
                base = "checkpoint:\(turn.id)"
                ref = nil
                total = nil
                items = changes.map { change in
                    Item(path: change.path, letter: change.kind == .added ? "A" : change.kind == .deleted ? "D" : "M", added: nil, removed: nil)
                }
            case .branch:
                let comparison = try await api.gitCompare(projectId: project.id, base: nil)
                guard !Task.isCancelled else { return }
                base = comparison.base
                ref = comparison.ref
                total = comparison.filesTotal.map { Int($0.int64Value) }
                items = comparison.files.map { file in
                    Item(path: file.path, letter: gitStatusLetter(file.status), added: file.added?.int64Value, removed: file.removed?.int64Value)
                }
            case .uncommitted:
                return
            }
            error = nil
        } catch {
            guard !Task.isCancelled else { return }
            self.error = gitMessage(error)
            if items == nil { items = [] }
        }
    }
}

// MARK: Read-only diff

/// A file's diff from a turn, a branch or a commit: nothing to stage there.
struct GitDiffPage: View {
    let workbench: Workbench
    let project: Project
    let target: GitDiffTarget
    let onBack: () -> Void
    @State private var diff: GitDiff?
    @State private var error: String?

    var body: some View {
        VStack(spacing: 0) {
            DetailHeader(title: (target.path as NSString).lastPathComponent, subtitle: target.label ?? (target.path as NSString).deletingLastPathComponent, back: onBack) {
                DiffCounts(added: target.added, removed: target.removed)
            }
            PanelRule()
            if let error {
                GitInlineError(message: error)
                Spacer(minLength: 0)
            } else if let diff {
                if diff.binary {
                    ContentUnavailableView(GitCopy.binaryFile, icon: "doc")
                } else if diff.truncated?.boolValue == true, diff.before.isEmpty, diff.after.isEmpty {
                    ContentUnavailableView(GitCopy.tooLarge, icon: "doc")
                } else {
                    FullDiffView(before: diff.before, after: diff.after)
                }
            } else {
                Spinner(size: .regular).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: target) {
            diff = nil
            error = nil
            guard let api = workbench.host.api else { return }
            do {
                let loaded = try await api.gitDiff(projectId: project.id, path: target.path, staged: false, base: target.base, commit: target.commit, from: nil)
                guard !Task.isCancelled else { return }
                diff = loaded
            } catch {
                guard !Task.isCancelled else { return }
                self.error = gitMessage(error)
            }
        }
    }
}

// MARK: History

/// The commit log with its graph, and the branch row above it.
struct GitHistoryView: View {
    private enum Prompt: String, Identifiable {
        case newBranch, remote
        var id: String { rawValue }
    }

    let workbench: Workbench
    let project: Project
    let refreshToken: Int
    /// The shared status's revision: commits and branch changes made elsewhere show here.
    let revision: Int
    let onOpen: (GitCommit) -> Void
    /// A switch moved HEAD: the status and the other tabs read again.
    let onSwitched: () -> Void
    @Environment(\.palette) private var palette
    @State private var branchAnchor = MenuAnchor()
    @State private var refs: GitRefs?
    @State private var commits: [GitCommit] = []
    @State private var graph: [GitGraphRow] = []
    @State private var lanes = 1
    @State private var more = false
    @State private var all = false
    @State private var loaded = false
    @State private var loadingMore = false
    @State private var error: String?
    @State private var notARepository = false
    @State private var actionError: String?
    @State private var busy = false
    @State private var prompt: Prompt?
    @State private var promptText = ""
    @State private var generation = 0

    private static let pageSize = 150

    var body: some View {
        VStack(spacing: 0) {
            header
            PanelRule()
            if let actionError { GitInlineError(message: actionError) }
            content
        }
        .task(id: "\(project.id)|\(all)") {
            commits = []; graph = []; refs = nil; more = false; loaded = false; error = nil; notARepository = false; actionError = nil
            await reload()
        }
        .task(id: "\(refreshToken)|\(revision)") { if loaded { await reload() } }
        .alert(prompt == .remote ? GitCopy.checkOutRemote : GitCopy.newBranch, isPresented: Binding(get: { prompt != nil }, set: { if !$0 { prompt = nil } })) {
            TextField(plain("Branch name"), text: $promptText)
            Button(prompt == .remote ? GitCopy.checkOut : GitCopy.createAndSwitch) {
                let name = promptText.trimmingCharacters(in: .whitespacesAndNewlines)
                let kind = prompt
                promptText = ""
                prompt = nil
                guard !name.isEmpty else { return }
                Task { await `switch`(branch: kind == .newBranch ? name : nil, create: kind == .newBranch, remote: kind == .remote ? name : nil) }
            }
            Button(GitCopy.cancel, role: .cancel) { promptText = "" }
        }
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: Space.sm) {
            branchMenu
            Spacer(minLength: 0)
            SegmentedTrack(selection: $all, fontSize: 11.5, inset: Space.sm) {
                Text(verbatim: GitCopy.current).tag(false)
                Text(verbatim: GitCopy.all).tag(true)
            }
            .fixedSize()
            Button { Task { await fetch() } } label: { Image(icon: "arrow.triangle.2.circlepath").font(.riffet(size: S(12))) }
                .buttonStyle(IconButtonStyle())
                .help(GitCopy.fetch)
                .accessibilityLabel(GitCopy.fetch)
                .disabled(busy)
        }
        .padding(.leading, Space.sm)
        .padding(.trailing, Space.sm)
        .frame(height: InspectorMetrics.headerHeight - 4)
    }

    /// Branches, remotes and the new-branch actions, in the app's own menu (drawn or the system's per
    /// the style), built on click so a re-render never rebuilds it while it is open.
    private var branchMenu: some View {
        Button {
            guard let refs else { return }
            var entries: [NativeMenuEntry] = refs.branches.map { ref in
                let current = ref.current?.boolValue == true
                return .item(ref.name, checked: current, enabled: ref.elsewhere?.boolValue != true) {
                    if !current { Task { await `switch`(branch: ref.name, create: false, remote: nil) } }
                }
            }
            if !refs.remotes.isEmpty {
                entries.append(.separator)
                entries += refs.remotes.prefix(30).map { remote in .item(remote.name) { Task { await `switch`(branch: nil, create: false, remote: remote.name) } } }
            }
            entries.append(.separator)
            if refs.remoteCount > 30 { entries.append(.item(GitCopy.checkOutRemote) { prompt = .remote }) }
            entries.append(.item(GitCopy.newBranch) { prompt = .newBranch })
            branchAnchor.popUp(entries: entries)
        } label: {
            HStack(spacing: 5) {
                Image(icon: "arrow.triangle.branch").font(.riffet(size: S(12))).foregroundStyle(palette.fg3)
                Text(verbatim: refs.map { $0.head ?? GitCopy.detached } ?? "—")
                    .font(.riffet(size: S(13), weight: .medium, design: .monospaced))
                    .foregroundStyle(palette.fg)
                    .lineLimit(1)
                Image(icon: "chevron.down").font(.riffet(size: S(9), weight: .semibold)).foregroundStyle(palette.fg4)
            }
            .padding(.horizontal, 6)
            .frame(height: 28)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(MenuAnchorView(anchor: branchAnchor))
        .fixedSize()
        .disabled(busy || refs == nil)
    }

    // MARK: List

    @ViewBuilder
    private var content: some View {
        if notARepository {
            ContentUnavailableView(GitCopy.notARepository, icon: "exclamationmark.triangle")
        } else if let error {
            GitInlineError(message: error)
            Button(plain("Retry")) { Task { await reload() } }.buttonStyle(ChipButtonStyle()).padding(Space.md)
            Spacer(minLength: 0)
        } else if !loaded {
            Spinner(size: .regular).frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if commits.isEmpty {
            ContentUnavailableView(GitCopy.noCommits, icon: "clock.arrow.circlepath")
        } else {
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(Array(commits.enumerated()), id: \.element.hash_) { index, commit in
                        Button { onOpen(commit) } label: {
                            GitCommitRow(commit: commit, graph: index < graph.count ? graph[index] : nil, lanes: lanes)
                        }
                        .buttonStyle(HoverRowStyle(radius: 0))
                        .contextMenu {
                            Button(GitCopy.copyHash) { copyToPasteboard(commit.hash_) }
                        }
                        .onAppear { if more, index >= commits.count - 20 { Task { await loadMore() } } }
                    }
                    if loadingMore { Spinner(size: .mini).frame(maxWidth: .infinity).padding(Space.sm) }
                }
                .padding(.vertical, Space.xs)
            }
        }
    }

    // MARK: Loading

    private func reload() async {
        guard let api = workbench.host.api else { return }
        generation += 1
        let mine = generation
        do {
            async let nextRefs = api.gitRefs(projectId: project.id, query: nil)
            let page = try await api.gitLog(projectId: project.id, all: all, skip: 0)
            let loadedRefs = try await nextRefs
            guard !Task.isCancelled, mine == generation else { return }
            refs = loadedRefs
            commits = page.commits
            more = page.more
            error = nil
            notARepository = false
            relayout()
        } catch {
            guard !Task.isCancelled, mine == generation else { return }
            self.error = gitMessage(error)
            notARepository = error.riffetCode == "NOT_A_GIT_REPOSITORY"
        }
        loaded = true
    }

    private func loadMore() async {
        guard more, !loadingMore, let api = workbench.host.api else { return }
        loadingMore = true
        defer { loadingMore = false }
        let mine = generation
        do {
            let page = try await api.gitLog(projectId: project.id, all: all, skip: Int32(commits.count))
            guard mine == generation else { return }
            let known = Set(commits.map(\.hash_))
            commits += page.commits.filter { !known.contains($0.hash_) }
            more = page.more && !page.commits.isEmpty
            relayout()
        } catch {
            more = false
        }
    }

    private func relayout() {
        graph = layoutGitGraph(commits: commits)
        lanes = max(1, graph.map { Int($0.width) }.max() ?? 1)
    }

    private func fetch() async {
        guard let api = workbench.host.api, !busy else { return }
        busy = true
        actionError = nil
        do {
            refs = try await api.gitFetch(projectId: project.id)
            await reload()
            onSwitched()
        } catch {
            actionError = gitMessage(error)
        }
        busy = false
    }

    private func `switch`(branch: String?, create: Bool, remote: String?) async {
        guard let api = workbench.host.api, !busy else { return }
        busy = true
        actionError = nil
        do {
            refs = try await api.gitSwitch(projectId: project.id, branch: branch, create: create, base: nil, remote: remote)
            await reload()
            onSwitched()
        } catch {
            actionError = gitMessage(error)
        }
        busy = false
    }
}

// MARK: Commit

/// A commit's message and the files it changed; opening a file shows its diff against the first parent.
struct GitCommitPage: View {
    let workbench: Workbench
    let project: Project
    let commit: GitCommit
    let onBack: () -> Void
    let onOpenFile: (GitDiffTarget) -> Void
    let onSwitched: () -> Void
    @Environment(\.palette) private var palette
    @State private var detail: GitCommitDetail?
    @State private var error: String?
    @State private var busy = false
    @State private var naming = false
    @State private var branchName = ""

    var body: some View {
        VStack(spacing: 0) {
            DetailHeader(title: shortHash(commit.hash_), subtitle: commit.author, back: onBack) {
                Button { copyToPasteboard(commit.hash_) } label: { Image(icon: "doc.on.doc").font(.riffet(size: S(12))) }
                    .buttonStyle(IconButtonStyle())
                    .help(GitCopy.copyHash)
                    .accessibilityLabel(GitCopy.copyHash)
                Button(GitCopy.newBranchFromHere) { naming = true }
                    .buttonStyle(ChipButtonStyle())
                    .disabled(busy)
            }
            PanelRule()
            if let error { GitInlineError(message: error) }
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    VStack(alignment: .leading, spacing: Space.xs) {
                        Text(verbatim: commit.subject)
                            .font(.riffet(size: S(14), weight: .semibold))
                            .foregroundStyle(palette.fg)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                        if let body = detail?.body.trimmingCharacters(in: .whitespacesAndNewlines), !body.isEmpty {
                            Text(verbatim: body)
                                .font(.riffet(size: S(12.5)))
                                .foregroundStyle(palette.fg2)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Text(verbatim: "\(commit.author) · \(gitAbsoluteDate(commit.date))")
                            .font(.riffet(size: S(11)))
                            .foregroundStyle(palette.fg4)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(Space.md)
                    PanelRule()
                    if let detail {
                        LazyVStack(spacing: 0) {
                            ForEach(detail.files, id: \.path) { file in
                                Button {
                                    onOpenFile(GitDiffTarget(path: file.path, added: file.added?.int64Value, removed: file.removed?.int64Value, base: nil, commit: commit.hash_, label: shortHash(commit.hash_)))
                                } label: {
                                    GitFileRow(path: file.path, letter: gitStatusLetter(file.status), added: file.added?.int64Value, removed: file.removed?.int64Value)
                                }
                                .buttonStyle(HoverRowStyle())
                                .contextMenu { Button(GitCopy.copyPath) { copyToPasteboard(file.path) } }
                            }
                            if let total = detail.filesTotal?.int64Value, Int(total) > detail.files.count {
                                GitFootnote(text: GitCopy.firstOf(detail.files.count, Int(total)))
                            }
                        }
                        .padding(Space.xs + 2)
                    } else if error == nil {
                        Spinner(size: .regular).frame(maxWidth: .infinity).padding(Space.lg)
                    }
                }
            }
        }
        .alert(GitCopy.newBranchFromHere, isPresented: $naming) {
            TextField(plain("Branch name"), text: $branchName)
            Button(GitCopy.createAndSwitch) {
                let name = branchName.trimmingCharacters(in: .whitespacesAndNewlines)
                branchName = ""
                guard !name.isEmpty else { return }
                Task { await createBranch(name) }
            }
            Button(GitCopy.cancel, role: .cancel) { branchName = "" }
        }
        .task(id: commit.hash_) {
            detail = nil
            error = nil
            guard let api = workbench.host.api else { return }
            do {
                let loaded = try await api.gitCommit(projectId: project.id, hash: commit.hash_)
                guard !Task.isCancelled else { return }
                detail = loaded
            } catch {
                guard !Task.isCancelled else { return }
                self.error = gitMessage(error)
            }
        }
    }

    private func createBranch(_ name: String) async {
        guard let api = workbench.host.api, !busy else { return }
        busy = true
        error = nil
        do {
            _ = try await api.gitSwitch(projectId: project.id, branch: name, create: true, base: commit.hash_, remote: nil)
            onSwitched()
            onBack()
        } catch {
            self.error = gitMessage(error)
        }
        busy = false
    }
}
