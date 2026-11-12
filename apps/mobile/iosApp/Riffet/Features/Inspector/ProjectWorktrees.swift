import SwiftUI
import RiffetKit

struct ProjectWorktrees: View {
    let workbench: Workbench
    let project: Project
    let refresh: Int
    @State private var worktrees: [WorktreeInfo]?
    @State private var branch = ""
    @State private var base = ""
    @State private var error: String?
    @State private var busy = false
    @State private var pendingRemove: WorktreeInfo?
    @State private var opened: Project?

    var body: some View {
        List {
            Section {
                TextField(gitText("New branch name"), text: $branch).textInputAutocapitalization(.never).autocorrectionDisabled()
                TextField(gitText("Based on (optional)"), text: $base).textInputAutocapitalization(.never).autocorrectionDisabled()
                Button(gitText("Create")) { Task { await create() } }.disabled(busy || branch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            if let error { Text(error).foregroundStyle(.red) }
            if let opened {
                Section {
                    NavigationLink(gitText(opened.name)) { ProjectFilesView(workbench: workbench, project: opened) }
                }
            }
            if let worktrees {
                ForEach(worktrees, id: \.path) { tree in
                    Section {
                        VStack(alignment: .leading, spacing: 5) {
                            Label(tree.branch ?? "Detached HEAD", systemImage: "arrow.triangle.branch").font(.body.monospaced())
                            Text(tree.path).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                            Text(String(tree.head.prefix(8))).font(.caption).foregroundStyle(.secondary)
                        }
                        if tree.bare?.boolValue != true {
                            if !current(tree) {
                                Button(gitText("Open as Project")) { Task { await open(tree) } }.disabled(busy)
                                Button(gitText("Remove Worktree"), role: .destructive) { pendingRemove = tree }.disabled(busy)
                            }
                        }
                    }
                }
                if worktrees.isEmpty { ContentUnavailableView(gitText("No worktrees"), systemImage: "arrow.triangle.branch") }
            } else if error == nil { ProgressView() }
        }
        .task(id: "\(project.id)|\(refresh)") { await load() }
        .refreshable { await load() }
        .confirmationDialog(gitText("Remove Worktree?"), isPresented: Binding(get: { pendingRemove != nil }, set: { if !$0 { pendingRemove = nil } }), titleVisibility: .visible) {
            Button(gitText("Remove"), role: .destructive) {
                guard let target = pendingRemove else { return }
                pendingRemove = nil
                Task { await remove(target) }
            }
        } message: {
            Text(verbatim: "\(pendingRemove?.path ?? "")\n\nGit refuses to remove a worktree with uncommitted changes.")
        }
    }
    private func current(_ tree: WorktreeInfo) -> Bool {
        tree.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")) == project.cwd.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }
    private func load() async {
        do {
            guard let api = workbench.api else { throw InspectorFailure.disconnected }
            worktrees = try await api.worktrees(projectId: project.id)
            error = nil
        } catch { self.error = gitMessage(error) }
    }
    private func create() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            guard let api = workbench.api else { throw InspectorFailure.disconnected }
            let name = branch.trimmingCharacters(in: .whitespacesAndNewlines)
            let from = base.trimmingCharacters(in: .whitespacesAndNewlines)
            _ = try await api.createWorktree(projectId: project.id, body: CreateWorktreeRequest(branch: name, path: nil, base: from.isEmpty ? nil : from))
            branch = ""; base = ""
            await load()
        } catch { self.error = gitMessage(error) }
    }
    private func remove(_ tree: WorktreeInfo) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            guard let api = workbench.api else { throw InspectorFailure.disconnected }
            try await api.removeWorktree(projectId: project.id, path: tree.path)
            await load()
        } catch { self.error = gitMessage(error) }
    }
    private func open(_ tree: WorktreeInfo) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do { opened = try await workbench.store.openDirectory(path: tree.path); error = nil }
        catch { self.error = gitMessage(error) }
    }
}
