import SwiftUI
import RiffetKit

/// Where a diff comes from; only the working tree's can be changed line by line.
enum GitDiffSource {
    case worktree(staged: Bool)
    case base(String)
    case commit(String)
}

struct ProjectDiffPage: View {
    let model: GitPanelModel
    let path: String
    let source: GitDiffSource
    @State private var staged: Bool
    @State private var diff: GitDiff?
    @State private var error: String?
    @Environment(\.palette) private var palette

    init(model: GitPanelModel, path: String, source: GitDiffSource) {
        self.model = model
        self.path = path
        self.source = source
        if case .worktree(let staged) = source { _staged = State(initialValue: staged) } else { _staged = State(initialValue: false) }
    }

    /// The file has staged and unstaged changes, so the page offers both sides.
    private var both: Bool {
        guard let entry = model.status?.entries.first(where: { $0.path == path }) else { return false }
        return gitStaged(entry: entry) && gitUnstaged(entry: entry)
    }

    private var isWorktree: Bool { if case .worktree = source { true } else { false } }

    var body: some View {
        Group {
            if let error { ContentUnavailableView(gitText("Couldn't load the diff"), systemImage: "exclamationmark.triangle", description: Text(error)) }
            else if let diff {
                if diff.binary { ContentUnavailableView(gitText("Binary file"), systemImage: "doc") }
                else if isWorktree, diff.version != nil, diff.truncated?.boolValue != true {
                    if gitPatchChunks(patch: diff.patch).isEmpty { ContentUnavailableView(gitText("Working tree clean"), systemImage: "checkmark.circle") } else {
                    PatchDiffView(patch: diff.patch, staged: staged, busy: model.busy) { chunk, action in
                        Task { await apply(chunk, action: action, version: diff.version ?? "") }
                    }
                    }
                } else {
                    UnifiedDiffView(before: diff.before, after: diff.after)
                        .safeAreaInset(edge: .bottom) {
                            if diff.truncated?.boolValue == true { Text(gitText("Too large to preview")).riffetFont(.caption).foregroundStyle(palette.fg3).padding().frame(maxWidth: .infinity).background(.bar) }
                        }
                }
            } else { ProgressView() }
        }
        .navigationTitle((path as NSString).lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .top) {
            if both, isWorktree {
                Picker(gitText("Side"), selection: $staged) {
                    Text(verbatim: "Unstaged").tag(false)
                    Text(verbatim: "Staged").tag(true)
                }.pickerStyle(.segmented).padding(.horizontal).padding(.vertical, 8).background(.bar)
            }
        }
        .toolbar {
            if isWorktree {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(staged ? gitText("Unstage") : gitText("Stage")) {
                        Task { await model.stage([path], on: !staged); await load() }
                    }.disabled(diff == nil)
                }
            }
        }
        .task(id: "\(path)|\(staged)|\(model.revision)") { await load() }
        .gitPanelChrome(model, scope: "diff")
    }

    private func load() async {
        do {
            let api = try model.api()
            var base: String?, commit: String?
            switch source {
            case .base(let value): base = value
            case .commit(let value): commit = value
            case .worktree: break
            }
            diff = try await api.gitDiff(projectId: model.project.id, path: path, staged: staged, base: base, commit: commit, from: nil)
            error = nil
        } catch { self.error = gitMessage(error) }
    }

    private func apply(_ chunk: GitPatchChunk, action: String, version: String) async {
        _ = await model.lines(path: path, action: action, change: chunk.change, version: version)
        await load()
    }
}

/// The patch as text with the actions for each run of changed lines at its start.
private struct PatchDiffView: View {
    private struct Row: Identifiable {
        let id: Int
        let text: String
        let chunk: GitPatchChunk?
    }

    private let rows: [Row]
    @Environment(\.palette) private var palette
    let staged: Bool
    let busy: Bool
    let act: (GitPatchChunk, String) -> Void

    init(patch: String, staged: Bool, busy: Bool, act: @escaping (GitPatchChunk, String) -> Void) {
        let chunks = Dictionary(gitPatchChunks(patch: patch).map { (Int($0.patchLine), $0) }, uniquingKeysWith: { first, _ in first })
        var seenHunk = false
        var rows: [Row] = []
        for (index, line) in patch.components(separatedBy: "\n").enumerated() {
            if line.hasPrefix("@@") { seenHunk = true }
            if seenHunk, !line.hasPrefix("\\") { rows.append(Row(id: index, text: line, chunk: chunks[index])) }
        }
        self.rows = rows
        self.staged = staged
        self.busy = busy
        self.act = act
    }

    private func hunkButton(_ title: String, _ tone: Color, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).riffetFont(.label).foregroundStyle(tone)
                .frame(minWidth: RiffetMetrics.hitTarget, minHeight: RiffetMetrics.hitTarget)
                .contentShape(Rectangle())
        }
        .buttonStyle(RiffetDimPressStyle())
    }

    var body: some View {
        GeometryReader { geo in
            ScrollView([.horizontal, .vertical]) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(rows) { row in
                        if let chunk = row.chunk {
                            HStack(spacing: 8) {
                                if staged {
                                    hunkButton(gitText("Unstage"), palette.accent) { act(chunk, "unstage") }
                                } else {
                                    hunkButton(gitText("Stage"), palette.accent) { act(chunk, "stage") }
                                    hunkButton(gitText("Discard"), palette.danger) { act(chunk, "discard") }
                                }
                            }
                            .disabled(busy).padding(.horizontal, 6)
                        }
                        Text(row.text.isEmpty ? " " : row.text)
                            .riffetFont(.mono).textSelection(.enabled).fixedSize(horizontal: true, vertical: false)
                            .foregroundStyle(row.text.hasPrefix("@@") ? palette.fg3 : palette.fg)
                            .padding(.vertical, 2).padding(.horizontal, 6)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(row.text.hasPrefix("+") ? palette.diffAdd : row.text.hasPrefix("-") ? palette.diffDel : .clear)
                            .contextMenu {
                                if let chunk = row.chunk {
                                    if staged {
                                        Button(gitText("Unstage"), systemImage: "minus.circle") { act(chunk, "unstage") }
                                    } else {
                                        Button(gitText("Stage"), systemImage: "plus.circle") { act(chunk, "stage") }
                                        Button(gitText("Discard"), systemImage: "trash", role: .destructive) { act(chunk, "discard") }
                                    }
                                }
                            }
                    }
                }
                .padding(.vertical)
                // Lines keep their own width and scroll sideways; a short patch still fills the page width.
                .frame(minWidth: geo.size.width, alignment: .leading)
            }
            .defaultScrollAnchor(.topLeading)
        }
    }
}
