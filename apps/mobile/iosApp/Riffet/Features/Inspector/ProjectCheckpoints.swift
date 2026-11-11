import SwiftUI
import RiffetKit

struct ProjectCheckpoints: View {
    let workbench: Workbench
    let project: Project
    let refresh: Int
    @State private var checkpoints: [Checkpoint]?
    @State private var title = ""
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        List {
            Section("保存工作区") {
                TextField("检查点名称（可选）", text: $title)
                Button("保存检查点") { Task { await create() } }.disabled(busy)
            }
            if let error { Text(error).foregroundStyle(.red) }
            if let checkpoints {
                if checkpoints.isEmpty { ContentUnavailableView("还没有检查点", systemImage: "clock.arrow.circlepath", description: Text("保存后可查看文件差异，并恢复工作区。")) }
                ForEach(checkpoints, id: \.id) { checkpoint in
                    NavigationLink {
                        CheckpointDetail(workbench: workbench, project: project, checkpoint: checkpoint)
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(checkpoint.title)
                            Text("\(checkpoint.files) 个文件 · \(checkpoint.createdAt)").font(.caption).foregroundStyle(.secondary)
                            if !checkpoint.excluded.isEmpty { Text("排除 \(checkpoint.excluded.count) 个文件").font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                }
            } else if error == nil { ProgressView() }
        }
        .task(id: "\(project.id)|\(refresh)") { await load() }
        .refreshable { await load() }
    }
    private func load() async {
        do {
            guard let api = workbench.api else { throw InspectorFailure.disconnected }
            checkpoints = try await api.checkpoints(projectId: project.id)
            error = nil
        } catch { self.error = error.riffetMessage }
    }
    private func create() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            guard let api = workbench.api else { throw InspectorFailure.disconnected }
            let name = title.trimmingCharacters(in: .whitespacesAndNewlines)
            let sessionID = workbench.selected?.projectId == project.id ? workbench.selected?.id : nil
            _ = try await api.createCheckpoint(projectId: project.id, body: CreateCheckpointRequest(sessionId: sessionID, title: name.isEmpty ? nil : name))
            title = ""
            await load()
        } catch { self.error = error.riffetMessage }
    }
}

private struct CheckpointDetail: View {
    let workbench: Workbench
    let project: Project
    let checkpoint: Checkpoint
    @State private var changes: [CheckpointChange]?
    @State private var error: String?
    @State private var confirm = false
    @State private var busy = false
    @State private var restored = false

    var body: some View {
        List {
            if let error { Text(error).foregroundStyle(.red) }
            if restored { Label("已恢复工作区", systemImage: "checkmark.circle").foregroundStyle(.secondary) }
            if let changes {
                Section {
                    Text("将修改 \(changes.count) 个文件。请查看下面的路径与指纹，再决定是否恢复。").font(.callout)
                    Button("恢复这个检查点", role: .destructive) { confirm = true }.disabled(busy || restored)
                }
                if changes.isEmpty { ContentUnavailableView("与当前工作区相同", systemImage: "checkmark.circle") }
                ForEach(changes, id: \.path) { change in
                    VStack(alignment: .leading, spacing: 5) {
                        Text(change.path).font(.body.monospaced())
                        Text("\(kind(change.kind)) · \(fingerprint(change.beforeHash)) → \(fingerprint(change.afterHash))")
                            .font(.caption.monospaced()).foregroundStyle(.secondary)
                    }.textSelection(.enabled)
                }
            } else if error == nil { ProgressView() }
        }
        .navigationTitle(checkpoint.title)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: checkpoint.id) { await load() }
        .confirmationDialog("恢复「\(checkpoint.title)」？", isPresented: $confirm, titleVisibility: .visible) {
            Button("恢复 \(changes?.count ?? 0) 个文件", role: .destructive) {
                let reviewed = changes ?? []
                Task { await restore(reviewed) }
            }
        } message: {
            Text("将覆盖上面列出的工作区文件。服务器会再次核对这份文件列表和指纹；文件若已变化，会拒绝恢复。")
        }
    }
    private func load() async {
        do {
            guard let api = workbench.api else { throw InspectorFailure.disconnected }
            changes = try await api.checkpointChanges(projectId: project.id, checkpointId: checkpoint.id)
            error = nil
        } catch { self.error = error.riffetMessage }
    }
    private func restore(_ reviewed: [CheckpointChange]) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            guard let api = workbench.api else { throw InspectorFailure.disconnected }
            try await api.restoreCheckpoint(projectId: project.id, checkpointId: checkpoint.id, expectedChanges: reviewed)
            restored = true
            await load()
        } catch {
            if error.riffetStatus == 409 {
                // A stale confirmation must never silently submit a new file list.
                changes = nil
                await load()
                self.error = String(localized: "工作区已经变化，本次恢复被拒绝。已重新读取，请再次查看文件后决定。", bundle: .riffet)
            } else { self.error = error.riffetMessage }
        }
    }
    private func fingerprint(_ value: String?) -> String { value.map { String($0.prefix(12)) } ?? String(localized: "不存在", bundle: .riffet) }
    private func kind(_ kind: CheckpointChangeKind) -> String {
        switch kind {
        case .added: String(localized: "新增", bundle: .riffet)
        case .deleted: String(localized: "删除", bundle: .riffet)
        default: String(localized: "修改", bundle: .riffet)
        }
    }
}
