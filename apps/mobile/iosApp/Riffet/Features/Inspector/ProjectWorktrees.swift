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
            Section("创建 Worktree") {
                TextField("新分支名", text: $branch).textInputAutocapitalization(.never).autocorrectionDisabled()
                TextField("基于分支或提交（可选）", text: $base).textInputAutocapitalization(.never).autocorrectionDisabled()
                Button("创建") { Task { await create() } }.disabled(busy || branch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            if let error { Text(error).foregroundStyle(.red) }
            if let opened {
                Section("已添加为项目：\(opened.name)") {
                    NavigationLink("查看项目文件") { ProjectFilesView(workbench: workbench, project: opened) }
                    Text("返回会话列表后，可在这个项目中开始任务。").font(.caption).foregroundStyle(.secondary)
                }
            }
            if let worktrees {
                ForEach(worktrees, id: \.path) { tree in
                    Section {
                        VStack(alignment: .leading, spacing: 5) {
                            Label(tree.branch ?? String(localized: "分离 HEAD", bundle: .riffet), systemImage: "arrow.triangle.branch").font(.body.monospaced())
                            Text(tree.path).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                            Text(String(tree.head.prefix(8)) + (current(tree) ? String(localized: " · 当前项目", bundle: .riffet) : "")).font(.caption).foregroundStyle(.secondary)
                        }
                        if tree.bare?.boolValue != true {
                            if !current(tree) {
                                Button("添加为项目") { Task { await open(tree) } }.disabled(busy)
                                Button("移除 Worktree", role: .destructive) { pendingRemove = tree }.disabled(busy)
                            }
                        }
                    }
                }
                if worktrees.isEmpty { ContentUnavailableView("没有 Worktree", systemImage: "arrow.triangle.branch") }
            } else if error == nil { ProgressView() }
        }
        .task(id: "\(project.id)|\(refresh)") { await load() }
        .refreshable { await load() }
        .confirmationDialog("移除 Worktree？", isPresented: Binding(get: { pendingRemove != nil }, set: { if !$0 { pendingRemove = nil } }), titleVisibility: .visible) {
            Button("移除", role: .destructive) {
                guard let target = pendingRemove else { return }
                pendingRemove = nil
                Task { await remove(target) }
            }
        } message: {
            Text("\(pendingRemove?.path ?? "")\n\n有未提交改动或未推送提交时，服务器会拒绝移除。此操作不强制删除。")
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
        } catch { self.error = error.riffetMessage }
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
        } catch { self.error = error.riffetMessage }
    }
    private func remove(_ tree: WorktreeInfo) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            guard let api = workbench.api else { throw InspectorFailure.disconnected }
            try await api.removeWorktree(projectId: project.id, path: tree.path)
            await load()
        } catch { self.error = error.riffetMessage }
    }
    private func open(_ tree: WorktreeInfo) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do { opened = try await workbench.store.openDirectory(path: tree.path); error = nil }
        catch { self.error = error.riffetMessage }
    }
}
