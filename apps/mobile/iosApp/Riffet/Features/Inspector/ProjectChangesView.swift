import SwiftUI
import RiffetKit

/// The Git page's views; a caller may open the page on one of them.
enum GitTab: CaseIterable {
    case changes, history, checkpoints, worktrees
    var title: String {
        switch self {
        case .changes: "Changes"
        case .history: "History"
        case .checkpoints: "Checkpoints"
        case .worktrees: "Worktrees"
        }
    }
}

struct ProjectChangesView: View {
    let workbench: Workbench
    let project: Project
    @State private var model: GitPanelModel
    @State private var tab: GitTab
    @State private var refresh = 0
    @Environment(\.palette) private var palette

    init(workbench: Workbench, project: Project, tab: GitTab = .changes) {
        self.workbench = workbench
        self.project = project
        _model = State(initialValue: GitPanelModel(workbench: workbench, project: project))
        _tab = State(initialValue: tab)
    }

    private var tabs: [GitTab] { GitTab.allCases.filter { $0 != .history || model.status != nil } }

    var body: some View {
        VStack(spacing: 0) {
            switch tab {
            case .history: ProjectHistoryView(model: model, refresh: refresh)
            case .checkpoints: ProjectCheckpoints(model: model, refresh: refresh)
            case .worktrees: ProjectWorktrees(workbench: workbench, project: project, refresh: refresh)
            case .changes: ProjectChangesList(model: model, refresh: refresh)
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            RiffetViewTabs(items: tabs.map { .init(value: $0, title: $0.title) }, selection: $tab)
                .background(palette.bg)
        }
        .navigationTitle(gitText("Git"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .bottomBar)
        .task(id: "\(project.id)|\(workbench.api != nil)") { await model.watch() }
        .gitPanelChrome(model, scope: "panel")
    }
}

private enum GitScope: CaseIterable {
    case uncommitted, turn, branch
    var title: String {
        switch self {
        case .uncommitted: "Uncommitted"
        case .turn: "This Turn"
        case .branch: "Branch"
        }
    }
}

/// A file of a scope other than the working tree: the turn's or the branch's changes.
private struct ScopeFile {
    let path: String
    let letter: String
    let added: KotlinLong?
    let removed: KotlinLong?
}

private struct ScopeListing {
    let files: [ScopeFile]
    let total: Int?
    let source: GitDiffSource?
    let ref: String?
}

private struct ProjectChangesList: View {
    let model: GitPanelModel
    let refresh: Int
    @State private var scope = GitScope.uncommitted
    @State private var listing: ScopeListing?
    @State private var listingError: String?
    @State private var shown = 300
    @State private var message = ""
    @State private var committing = false
    @Environment(\.palette) private var palette

    private var status: GitStatus? { model.status }
    private var staged: [GitEntry] { status?.entries.filter { gitStaged(entry: $0) } ?? [] }
    private var unstaged: [GitEntry] { status?.entries.filter { gitUnstaged(entry: $0) } ?? [] }
    private var scopes: [GitScope] {
        var result = [GitScope.uncommitted]
        if model.sessionID != nil { result.append(.turn) }
        if status?.base != nil { result.append(.branch) }
        return result
    }

    var body: some View {
        List {
            RiffetNotice.section(.error, model.error)
            if let status {
                Section {
                    RiffetValueRow(label: gitText("Branch"), value: status.branch, mono: true)
                    if scopes.count > 1 {
                        Picker(gitText("Scope"), selection: $scope) {
                            ForEach(scopes, id: \.self) { Text(verbatim: $0.title).tag($0) }
                        }.pickerStyle(.segmented)
                    }
                }
                switch scope {
                case .uncommitted: uncommitted(status)
                default: scoped
                }
            } else if let error = model.statusError {
                ContentUnavailableView(gitText("Not a Git repository"), systemImage: "exclamationmark.triangle", description: Text(error))
            } else { ProgressView().frame(maxWidth: .infinity) }
        }
        .refreshable { await model.reload() }
        .task(id: "\(scope)|\(scopes.count)|\(status?.base ?? "")|\(refresh)|\(model.revision)") { await loadScope() }
        .onChange(of: scopes) { if !scopes.contains(scope) { scope = .uncommitted } }
        .gitPanelChrome(model, scope: "list", notice: false)
        .toolbar {
            if scope == .uncommitted, status != nil {
                if !staged.isEmpty {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button(gitText("Commit")) { committing = true }
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        if !unstaged.isEmpty { Button(gitText("Stage All"), systemImage: "plus.circle") { Task { await model.stage(unstaged.map(\.path), on: true) } } }
                        if !staged.isEmpty { Button(gitText("Unstage All"), systemImage: "minus.circle") { Task { await model.stage(staged.map(\.path), on: false) } } }
                        if let behind = model.branch?.behind, behind > 0 { Button(gitText("Pull"), systemImage: "arrow.down.circle") { Task { await model.pull() } } }
                    } label: { Label(gitText("More"), systemImage: "ellipsis.circle") }
                        .disabled(unstaged.isEmpty && staged.isEmpty && (model.branch?.behind ?? 0) == 0)
                }
            }
        }
        .sheet(isPresented: $committing) {
            RiffetEditPage(title: gitText("Commit"), saveTitle: gitText("Commit"),
                           dirty: !message.isEmpty, canSave: !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) {
                await commit()
            } content: {
                RiffetNotice.section(.error, model.error)
                Section { RiffetField(prompt: gitText("Message"), text: $message, axis: .vertical) }
            }
        }
    }

    @ViewBuilder
    private func uncommitted(_ status: GitStatus) -> some View {
        let visibleUnstaged = Array(unstaged.prefix(shown))
        let visibleStaged = Array(staged.prefix(max(0, shown - unstaged.count)))
        let hidden = unstaged.count + staged.count - visibleUnstaged.count - visibleStaged.count
        if !unstaged.isEmpty {
            Section {
                ForEach(visibleUnstaged, id: \.path) { entry in entryRow(entry, staged: false) }
            } header: { RiffetSectionTitle("\(gitText("Unstaged")) · \(unstaged.count)") }
        }
        if !staged.isEmpty {
            Section {
                ForEach(visibleStaged, id: \.path) { entry in entryRow(entry, staged: true) }
            } header: { RiffetSectionTitle("\(gitText("Staged")) · \(staged.count)") }
        }
        if hidden > 0 {
            Button(gitMoreFiles(hidden)) { shown += 1000 }.riffetFont(.label).foregroundStyle(palette.fg2)
        }
        if status.entries.isEmpty { ContentUnavailableView(gitText("Working tree clean"), systemImage: "checkmark.circle") }
    }

    @ViewBuilder
    private var scoped: some View {
        if let listing {
            Section {
                ForEach(Array(listing.files.prefix(shown)), id: \.path) { file in
                    if let source = listing.source {
                        NavigationLink {
                            ProjectDiffPage(model: model, path: file.path, source: source)
                        } label: { GitFileLabel(letter: file.letter, path: file.path, added: file.added, removed: file.removed) }
                            .contextMenu { Button(gitText("Copy Path")) { UIPasteboard.general.string = file.path } }
                    }
                }
                if listing.files.count > shown {
                    Button(gitMoreFiles(listing.files.count - shown)) { shown += 1000 }.riffetFont(.label).foregroundStyle(palette.fg2)
                }
                if let total = listing.total, total > listing.files.count {
                    Text(verbatim: "Showing the first \(listing.files.count) of \(total) files").riffetFont(.caption).foregroundStyle(palette.fg3)
                }
            } header: { if let ref = listing.ref { RiffetSectionTitle(ref) } }
            if listing.files.isEmpty {
                ContentUnavailableView(scope == .turn ? gitText("No changes this turn") : gitText("No differences from \(listing.ref ?? status?.base ?? "base")"), systemImage: "checkmark.circle")
            }
        } else if let listingError { RiffetNotice.section(.error, listingError, actionTitle: gitText("Retry")) { Task { await loadScope() } } }
        else { ProgressView().frame(maxWidth: .infinity) }
    }

    private func entryRow(_ entry: GitEntry, staged: Bool) -> some View {
        let folder = entry.path.hasSuffix("/")
        let letter = gitLetter(staged ? entry.index : entry.worktree)
        return Group {
            if folder {
                Label(entry.path, systemImage: "folder").riffetFont(.mono).foregroundStyle(palette.fg)
            } else {
                NavigationLink {
                    ProjectDiffPage(model: model, path: entry.path, source: .worktree(staged: staged))
                } label: { GitFileLabel(letter: letter, path: entry.path, added: entry.added, removed: entry.removed) }
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if !staged { Button(gitText("Discard"), role: .destructive) { Task { await model.discard([entry.path], scope: "list") } } }
            Button(staged ? gitText("Unstage") : gitText("Stage")) { Task { await model.stage([entry.path], on: !staged) } }.tint(palette.accent)
        }
        .contextMenu {
            Button(staged ? gitText("Unstage") : gitText("Stage")) { Task { await model.stage([entry.path], on: !staged) } }
            if !staged { Button(gitText("Discard"), role: .destructive) { Task { await model.discard([entry.path], scope: "list") } } }
            Button(gitText("Copy Path")) { UIPasteboard.general.string = entry.path }
        }
    }

    private func loadScope() async {
        shown = 300
        listing = nil
        listingError = nil
        guard scope != .uncommitted else { return }
        do {
            let api = try model.api()
            switch scope {
            case .turn:
                guard let sessionID = model.sessionID, let turn = try await api.sessionCheckpoints(sessionId: sessionID).first else {
                    listing = ScopeListing(files: [], total: nil, source: nil, ref: nil)
                    return
                }
                let changes = try await api.checkpointChanges(projectId: model.project.id, checkpointId: turn.id)
                listing = ScopeListing(files: changes.map { change in
                    ScopeFile(path: change.path, letter: change.kind == .added ? "A" : change.kind == .deleted ? "D" : "M", added: nil, removed: nil)
                }, total: nil, source: .base("checkpoint:\(turn.id)"), ref: nil)
            default:
                let comparison = try await api.gitCompare(projectId: model.project.id, base: nil)
                listing = ScopeListing(files: comparison.files.map { ScopeFile(path: $0.path, letter: gitLetter($0.status), added: $0.added, removed: $0.removed) },
                                       total: comparison.filesTotal?.intValue, source: .base(comparison.base), ref: comparison.ref ?? comparison.base)
            }
        } catch { listingError = gitMessage(error) }
    }

    private func commit() async -> Bool {
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !staged.isEmpty else { return false }
        if await model.commit(text) { message = ""; return true }
        return false
    }
}

/// Uses the shared line diff, preserving the same context and ordering as the other clients.
struct UnifiedDiffView: View {
    let before: String
    let after: String
    @State private var lines: [DiffLine]?
    @State private var fallback = false
    @Environment(\.palette) private var palette
    var body: some View {
        Group {
            if let lines {
                ScrollView([.horizontal, .vertical]) {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                            HStack(alignment: .top, spacing: 8) {
                                Text(line.oldNo.map { "\($0.int64Value)" } ?? "").frame(minWidth: 32, alignment: .trailing).foregroundStyle(palette.fg3)
                                Text(line.newNo.map { "\($0.int64Value)" } ?? "").frame(minWidth: 32, alignment: .trailing).foregroundStyle(palette.fg3)
                                Text(line.type == .add ? "+" : line.type == .del ? "−" : " ").foregroundStyle(line.type == .add ? palette.diffAddMarker : line.type == .del ? palette.diffDelMarker : palette.fg3)
                                Text(line.text.isEmpty ? " " : line.text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .riffetFont(.mono).padding(.vertical, 2).padding(.horizontal, 6)
                            .background(line.type == .add ? palette.diffAdd : line.type == .del ? palette.diffDel : .clear)
                        }
                    }.padding(.vertical)
                }
            } else if fallback {
                ContentUnavailableView(gitText("Too large to preview"), systemImage: "doc.text")
            } else { ProgressView() }
        }
        .task(id: "\(before.hashValue)|\(after.hashValue)") {
            lines = nil
            fallback = false
            let before = before, after = after
            let result = await Task.detached(priority: .userInitiated) {
                lineDiff(before: before, after: after, context: 3, lineOffset: 0, trailingLines: 0)
            }.value
            guard !Task.isCancelled else { return }
            if let result { lines = result.lines } else { fallback = true }
        }
    }
}
