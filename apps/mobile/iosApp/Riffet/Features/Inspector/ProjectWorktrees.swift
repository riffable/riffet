import SwiftUI
import RiffetKit

private func sameDirectory(_ a: String, _ b: String) -> Bool {
    a.trimmingCharacters(in: CharacterSet(charactersIn: "/")) == b.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
}

struct ProjectWorktrees: View {
    let workbench: Workbench
    let project: Project
    let refresh: Int
    @State private var worktrees: [WorktreeInfo]?
    @State private var branch = ""
    @State private var base = ""
    @State private var error: String?
    @State private var createError: String?
    @State private var creating = false
    @Environment(\.palette) private var palette

    var body: some View {
        List {
            RiffetNotice.section(.error, error, actionTitle: gitText("Retry")) { Task { await load() } }
            if let worktrees {
                ForEach(worktrees, id: \.path) { tree in
                    NavigationLink {
                        WorktreeDetail(workbench: workbench, project: project, tree: tree) { await load() }
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(tree.branch ?? "Detached HEAD").riffetFont(.mono).foregroundStyle(palette.fg).lineLimit(1)
                            Text(tree.path).riffetFont(.monoSmall).foregroundStyle(palette.fg3).lineLimit(1).truncationMode(.head)
                        }
                    }
                }
                if worktrees.isEmpty { ContentUnavailableView(gitText("No worktrees"), systemImage: "arrow.triangle.branch") }
            } else if error == nil { ProgressView().frame(maxWidth: .infinity) }
        }
        .task(id: "\(project.id)|\(refresh)") { await load() }
        .refreshable { await load() }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(gitText("New Worktree"), systemImage: "plus") { creating = true }
            }
        }
        .sheet(isPresented: $creating) {
            RiffetEditPage(title: gitText("New Worktree"), saveTitle: gitText("Create"),
                           dirty: !branch.isEmpty || !base.isEmpty,
                           canSave: !branch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) {
                await create()
            } content: {
                RiffetNotice.section(.error, createError)
                Section {
                    RiffetField(label: gitText("Branch"), prompt: gitText("New branch name"), text: $branch, mono: true)
                    RiffetField(label: gitText("Based on"), prompt: gitText("Optional"), text: $base, mono: true)
                }
            }
        }
    }

    private func load() async {
        do {
            guard let api = workbench.api else { throw InspectorFailure.disconnected }
            worktrees = try await api.worktrees(projectId: project.id)
            error = nil
        } catch { self.error = gitMessage(error) }
    }

    private func create() async -> Bool {
        do {
            guard let api = workbench.api else { throw InspectorFailure.disconnected }
            let name = branch.trimmingCharacters(in: .whitespacesAndNewlines)
            let from = base.trimmingCharacters(in: .whitespacesAndNewlines)
            _ = try await api.createWorktree(projectId: project.id, body: CreateWorktreeRequest(branch: name, path: nil, base: from.isEmpty ? nil : from))
            branch = ""; base = ""
            createError = nil
            await load()
            return true
        } catch { createError = gitMessage(error); return false }
    }
}

private struct WorktreeDetail: View {
    let workbench: Workbench
    let project: Project
    let tree: WorktreeInfo
    let changed: () async -> Void
    @State private var busy = false
    @State private var error: String?
    @State private var confirmRemove = false
    @State private var opened: Project?
    @State private var showOpened = false
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette

    private var current: Bool { sameDirectory(tree.path, project.cwd) }
    private var actionable: Bool { tree.bare?.boolValue != true && !current }

    var body: some View {
        RiffetList {
            RiffetNotice.section(.error, error)
            Section {
                RiffetValueRow(label: gitText("Branch"), value: tree.branch ?? "Detached HEAD", mono: true)
                RiffetValueRow(label: gitText("Path"), value: tree.path, mono: true)
                RiffetValueRow(label: gitText("HEAD"), value: String(tree.head.prefix(8)), mono: true)
            }
            if actionable {
                Section {
                    RiffetActionRow(verbatim: gitText("Open as Project"), symbol: "folder", enabled: !busy) { Task { await open() } }
                }
                Section {
                    RiffetActionRow(verbatim: gitText("Remove Worktree"), symbol: "trash", destructive: true, enabled: !busy) { confirmRemove = true }
                }
            }
        }
        .navigationTitle(gitText("Worktree"))
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(isPresented: $showOpened) {
            if let opened { ProjectFilesView(workbench: workbench, project: opened) }
        }
        .confirmationDialog(gitText("Remove \"\(tree.branch ?? (tree.path as NSString).lastPathComponent)\"?"), isPresented: $confirmRemove, titleVisibility: .visible) {
            Button(gitText("Remove Worktree"), role: .destructive) { Task { await remove() } }
        } message: {
            Text(gitText("Git refuses to remove a worktree with uncommitted changes."))
        }
    }

    private func remove() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            guard let api = workbench.api else { throw InspectorFailure.disconnected }
            try await api.removeWorktree(projectId: project.id, path: tree.path)
            await changed()
            dismiss()
        } catch { self.error = gitMessage(error) }
    }

    private func open() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do { opened = try await workbench.store.openDirectory(path: tree.path); error = nil; showOpened = true }
        catch { self.error = gitMessage(error) }
    }
}
