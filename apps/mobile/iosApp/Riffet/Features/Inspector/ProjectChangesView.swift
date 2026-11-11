import SwiftUI
import RiffetKit

struct ProjectChangesView: View {
    let workbench: Workbench
    let project: Project
    @State private var status: GitStatus?
    @State private var error: String?
    @State private var message = ""
    @State private var busy = false
    @State private var section = 0
    @State private var refresh = 0

    private var staged: [GitEntry] { status?.entries.filter { gitStaged(entry: $0) } ?? [] }
    private var unstaged: [GitEntry] { status?.entries.filter { gitUnstaged(entry: $0) } ?? [] }

    var body: some View {
        VStack(spacing: 0) {
            Picker("Git 视图", selection: $section) {
                Text("改动").tag(0)
                Text("检查点").tag(1)
                Text("Worktree").tag(2)
            }.pickerStyle(.segmented).padding()
            switch section {
            case 1: ProjectCheckpoints(workbench: workbench, project: project, refresh: refresh)
            case 2: ProjectWorktrees(workbench: workbench, project: project, refresh: refresh)
            default: changes
            }
        }
        .navigationTitle(String(localized: "项目变更", bundle: .riffet))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .bottomBar)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("刷新", systemImage: "arrow.clockwise") { refresh += 1; Task { await load() } }.disabled(busy)
            }
        }
        .task(id: project.id) { await load() }
    }

    private var changes: some View {
        List {
            if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            if let status {
                Section {
                    Label(status.branch, systemImage: "arrow.triangle.branch").font(.body.monospaced())
                    Text("\(status.entries.count) 个改动文件").foregroundStyle(.secondary)
                }
                if !unstaged.isEmpty {
                    Section {
                        Button("全部暂存") { Task { await stage(unstaged.map(\.path), on: true) } }.disabled(busy)
                        ForEach(unstaged, id: \.path) { entry in entryRow(entry, staged: false) }
                    } header: { Text("工作区 · \(unstaged.count)") }
                }
                if !staged.isEmpty {
                    Section {
                        Button("全部取消暂存") { Task { await stage(staged.map(\.path), on: false) } }.disabled(busy)
                        ForEach(staged, id: \.path) { entry in entryRow(entry, staged: true) }
                    } header: { Text("已暂存 · \(staged.count)") }
                    Section("创建提交") {
                        TextField("提交说明", text: $message, axis: .vertical).lineLimit(2...6)
                        Button("提交 \(staged.count) 个文件") { Task { await commit() } }
                            .disabled(busy || message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
                if status.entries.isEmpty { ContentUnavailableView("工作区没有改动", systemImage: "checkmark.circle") }
            } else if error == nil { ProgressView().frame(maxWidth: .infinity) }
        }.refreshable { await load() }
    }

    private func entryRow(_ entry: GitEntry, staged: Bool) -> some View {
        NavigationLink {
            ProjectDiffPage(workbench: workbench, project: project, path: entry.path, staged: staged) { await load() }
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                Text(entry.path).font(.body.monospaced()).lineLimit(3)
                HStack {
                    Text(gitStatusText(entry, staged: staged)).foregroundStyle(.secondary)
                    if let added = entry.added { Text("+\(added.int64Value)").foregroundStyle(.green) }
                    if let removed = entry.removed { Text("−\(removed.int64Value)").foregroundStyle(.red) }
                }.font(.caption.monospaced())
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(staged ? "取消暂存" : "暂存") { Task { await stage([entry.path], on: !staged) } }.tint(.blue).disabled(busy)
        }
        .contextMenu {
            Button(staged ? "取消暂存" : "暂存") { Task { await stage([entry.path], on: !staged) } }.disabled(busy)
            Button("复制路径") { UIPasteboard.general.string = entry.path }
        }
    }

    private func load() async {
        do {
            guard let api = workbench.api else { throw InspectorFailure.disconnected }
            status = try await api.gitStatus(projectId: project.id)
            error = nil
        } catch { self.error = error.riffetMessage }
    }

    private func stage(_ paths: [String], on: Bool) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            guard let api = workbench.api else { throw InspectorFailure.disconnected }
            if on { try await api.stage(projectId: project.id, paths: paths) }
            else { try await api.unstage(projectId: project.id, paths: paths) }
            await load()
        } catch { self.error = error.riffetMessage }
    }

    private func commit() async {
        guard !busy, !staged.isEmpty else { return }
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        busy = true
        defer { busy = false }
        do {
            guard let api = workbench.api else { throw InspectorFailure.disconnected }
            try await api.commit(projectId: project.id, message: text)
            message = ""
            await load()
        } catch { self.error = error.riffetMessage }
    }
}

private func gitStatusText(_ entry: GitEntry, staged: Bool) -> String {
    let code = staged ? entry.index : entry.worktree
    switch code {
    case "?": return String(localized: "未跟踪", bundle: .riffet)
    case "A": return String(localized: "新增", bundle: .riffet)
    case "D": return String(localized: "删除", bundle: .riffet)
    case "R": return String(localized: "重命名", bundle: .riffet)
    case "U": return String(localized: "存在冲突", bundle: .riffet)
    default: return String(localized: "修改", bundle: .riffet)
    }
}

private struct ProjectDiffPage: View {
    let workbench: Workbench
    let project: Project
    let path: String
    let staged: Bool
    let changed: () async -> Void
    @State private var diff: GitDiff?
    @State private var error: String?
    @State private var busy = false
    @State private var stageComplete = false

    var body: some View {
        Group {
            if let error { ContentUnavailableView("无法读取差异", systemImage: "exclamationmark.triangle", description: Text(error)) }
            else if let diff {
                if diff.binary { ContentUnavailableView("二进制文件差异", systemImage: "doc") }
                else {
                    UnifiedDiffView(before: diff.before, after: diff.after)
                        .safeAreaInset(edge: .bottom) {
                            if diff.truncated?.boolValue == true { Text("差异较大，此处显示部分内容。").font(.caption).padding().frame(maxWidth: .infinity).background(.bar) }
                        }
                }
            } else { ProgressView() }
        }
        .navigationTitle((path as NSString).lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) {
            if stageComplete {
                Label(staged ? "已取消暂存" : "已暂存", systemImage: "checkmark.circle")
                    .font(.callout).padding().frame(maxWidth: .infinity).background(.bar)
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(staged ? "取消暂存" : "暂存") { Task { await updateStage() } }.disabled(busy || diff == nil || stageComplete)
            }
        }
        .task(id: "\(path)|\(staged)") { await load() }
    }
    private func load() async {
        do {
            guard let api = workbench.api else { throw InspectorFailure.disconnected }
            diff = try await api.gitDiff(projectId: project.id, path: path, staged: staged)
            error = nil
        } catch { self.error = error.riffetMessage }
    }
    private func updateStage() async {
        busy = true
        defer { busy = false }
        do {
            guard let api = workbench.api else { throw InspectorFailure.disconnected }
            if staged { try await api.unstage(projectId: project.id, paths: [path]) }
            else { try await api.stage(projectId: project.id, paths: [path]) }
            await changed()
            stageComplete = true
        } catch { self.error = error.riffetMessage }
    }
}

/// Uses the shared line diff, preserving the same context and ordering as the other clients.
struct UnifiedDiffView: View {
    let before: String
    let after: String
    @State private var lines: [DiffLine]?
    @State private var fallback = false
    var body: some View {
        Group {
            if let lines {
                ScrollView([.horizontal, .vertical]) {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                            HStack(alignment: .top, spacing: 8) {
                                Text(line.oldNo.map { "\($0.int64Value)" } ?? "").frame(minWidth: 32, alignment: .trailing).foregroundStyle(.secondary)
                                Text(line.newNo.map { "\($0.int64Value)" } ?? "").frame(minWidth: 32, alignment: .trailing).foregroundStyle(.secondary)
                                Text(line.type == .add ? "+" : line.type == .del ? "−" : " ").foregroundStyle(line.type == .add ? .green : line.type == .del ? .red : .secondary)
                                Text(line.text.isEmpty ? " " : line.text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .font(.body.monospaced()).padding(.vertical, 2).padding(.horizontal, 6)
                            .background(line.type == .add ? Color.green.opacity(0.1) : line.type == .del ? Color.red.opacity(0.1) : .clear)
                        }
                    }.padding(.vertical)
                }
            } else if fallback {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("文件较大，未计算行差异。以下分别显示修改前后内容。").font(.callout).foregroundStyle(.secondary)
                        Text("修改前").font(.headline)
                        Text(before).font(.body.monospaced()).textSelection(.enabled)
                        Text("修改后").font(.headline)
                        Text(after).font(.body.monospaced()).textSelection(.enabled)
                    }.padding()
                }
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
