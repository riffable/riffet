import SwiftUI
import RiffetKit

/// Checkpoint list for the changes panel. Opening one pushes `GitCheckpointDetail`.
struct GitCheckpointsList: View {
    let workbench: Workbench
    let project: Project
    let sessionId: String?
    let refreshToken: Int
    let onOpen: (Checkpoint) -> Void
    @Environment(\.palette) private var palette
    @State private var checkpoints: [Checkpoint]?
    @State private var title = ""
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: Space.sm) {
                GitField(placeholder: String(localized: "检查点名称（可选）"), text: $title) { Task { await create() } }
                Button("保存") { Task { await create() } }
                    .buttonStyle(SolidButtonStyle(kind: .primary))
                    .disabled(busy)
            }
            .padding(Space.md)
            if let error { GitInlineError(message: error) }
            content
        }
        .task(id: project.id) {
            title = ""
            checkpoints = nil
            error = nil
            await load()
        }
        .onChange(of: refreshToken) { _, _ in Task { await load() } }
    }

    @ViewBuilder
    private var content: some View {
        if checkpoints == nil, error == nil {
            Spinner(size: .regular).frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let checkpoints, !checkpoints.isEmpty {
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(checkpoints, id: \.id) { checkpoint in
                        Button { onOpen(checkpoint) } label: { GitCheckpointRow(checkpoint: checkpoint) }
                            .buttonStyle(HoverRowStyle())
                    }
                }
                .padding(Space.xs + 2)
            }
        } else if error == nil {
            ContentUnavailableView("还没有检查点", icon: "clock.arrow.circlepath", description: Text("保存检查点后，可以把工作区文件恢复到这个状态。"))
        } else {
            Spacer(minLength: 0)
        }
    }

    private func load() async {
        guard let api = workbench.host.api else { return }
        do {
            let next = try await api.checkpoints(projectId: project.id)
            if checkpoints != next { checkpoints = next }
            if error != nil { error = nil }
        } catch {
            self.error = String(localized: "无法读取检查点：\(error.riffetMessage)")
            if checkpoints == nil { checkpoints = [] }
        }
    }

    private func create() async {
        guard let api = workbench.host.api, !busy else { return }
        busy = true
        error = nil
        let name = title.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let created = try await api.createCheckpoint(projectId: project.id, body: CreateCheckpointRequest(sessionId: sessionId, title: name.isEmpty ? nil : name))
            title = ""
            await load()
            if error == nil, checkpoints?.contains(where: { $0.id == created.id }) != true {
                self.error = String(localized: "创建请求已返回，但列表没有出现新检查点；请刷新确认")
            }
        } catch {
            self.error = String(localized: "无法创建检查点：\(error.riffetMessage)")
        }
        busy = false
    }
}

struct GitCheckpointRow: View {
    let checkpoint: Checkpoint
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: Space.sm) {
            VStack(alignment: .leading, spacing: 1) {
                Text(checkpoint.title)
                    .font(.riffet(size: S(13), weight: .medium))
                    .foregroundStyle(palette.fg)
                    .lineLimit(1)
                Text(checkpointSubtitle(checkpoint))
                    .font(.riffet(size: S(11)))
                    .foregroundStyle(palette.fg4)
                    .lineLimit(1)
            }
            Spacer(minLength: Space.sm)
            Image(icon: "chevron.right").font(.riffet(size: S(9), weight: .semibold)).foregroundStyle(palette.fg4)
        }
        .padding(.horizontal, Space.sm)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Pushed page: the files a restore would write, then a confirmation that sends those exact rows back.
struct GitCheckpointDetail: View {
    let workbench: Workbench
    let project: Project
    let checkpoint: Checkpoint
    let onBack: () -> Void
    let onRestored: () async -> Void
    @Environment(\.palette) private var palette
    @State private var changes: [CheckpointChange]?
    @State private var error: String?
    @State private var busy = false
    @State private var confirm = false

    var body: some View {
        VStack(spacing: 0) {
            DetailHeader(title: checkpoint.title, subtitle: checkpointSubtitle(checkpoint), back: { if !busy { onBack() } }) {
                Button("恢复") { confirm = true }
                    .buttonStyle(SolidButtonStyle(kind: .danger))
                    .disabled(changes == nil || busy)
            }
            PanelRule()
            Text("指纹是 SHA-256 的前 12 位。恢复时服务器会再核对一次，对不上就拒绝。")
                .font(.riffet(size: S(11)))
                .foregroundStyle(palette.fg4)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, Space.md)
                .padding(.vertical, Space.sm)
            if let error { GitInlineError(message: error) }
            if let changes {
                if changes.isEmpty {
                    ContentUnavailableView("与当前工作区相同", icon: "checkmark.circle", description: Text("没有文件差异。"))
                } else {
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(changes, id: \.path) { GitCheckpointChangeRow(change: $0) }
                        }
                        .padding(Space.xs + 2)
                    }
                }
            } else if error == nil {
                Spinner(size: .regular).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                Spacer(minLength: 0)
            }
        }
        .confirmationDialog("恢复到「\(checkpoint.title)」？", isPresented: $confirm, titleVisibility: .visible) {
            Button("恢复", role: .destructive) {
                let reviewed = changes ?? []
                Task { await restore(reviewed) }
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text(confirmMessage)
        }
        .task(id: checkpoint.id) { await load() }
    }

    private var confirmMessage: String {
        guard let changes else { return String(localized: "正在读取改动。") }
        if changes.isEmpty {
            return String(localized: "没有文件差异。服务器仍会核对这份空列表，工作区若已变化会拒绝恢复。")
        }
        let lines = changes.prefix(16).map { "\(gitChangeLabel($0.kind))  \($0.path)\n    \(shortHash($0.beforeHash)) → \(shortHash($0.afterHash))" }
        var text = lines.joined(separator: "\n")
        if changes.count > 16 { text += String(localized: "\n…还有 \(changes.count - 16) 个文件，完整列表在这个页面上。") }
        text += String(localized: "\n\n服务器会再次核对下列文件指纹。若文件在此期间被修改，恢复会被拒绝。")
        return text
    }

    private func load() async {
        guard let api = workbench.host.api else { return }
        do {
            changes = try await api.checkpointChanges(projectId: project.id, checkpointId: checkpoint.id)
            error = nil
        } catch {
            self.error = String(localized: "无法读取检查点内容：\(error.riffetMessage)")
        }
    }

    /// Sends the list the reader just confirmed. A 409 means that list is stale: reload it and ask again.
    private func restore(_ expected: [CheckpointChange]) async {
        guard let api = workbench.host.api, !busy else { return }
        busy = true
        error = nil
        do {
            try await api.restoreCheckpoint(projectId: project.id, checkpointId: checkpoint.id, expectedChanges: expected)
            await onRestored()
        } catch {
            await handleRestoreFailure(error)
        }
        busy = false
    }

    private func handleRestoreFailure(_ error: Error) async {
        let http = riffetHTTP(error)
        if http?.code == "CHECKPOINT_EXCLUDED_CHANGES" {
            self.error = String(localized: "该检查点含有无法安全恢复的文件，服务器拒绝恢复。\(error.riffetMessage)")
            return
        }
        guard http?.status == 409 || http?.code == "CHECKPOINT_CONFLICT" else {
            self.error = String(localized: "检查点恢复被拒绝：\(error.riffetMessage)")
            return
        }
        guard let api = workbench.host.api else {
            self.error = String(localized: "工作区已变化，恢复被拒绝，且当前没有连接，无法重新读取改动。")
            return
        }
        do {
            changes = try await api.checkpointChanges(projectId: project.id, checkpointId: checkpoint.id)
            self.error = String(localized: "工作区自上次预览后已改动，服务器拒绝了这次恢复。下面是重新读取的改动，确认后再恢复。")
        } catch {
            changes = nil
            self.error = String(localized: "工作区已变化，恢复被拒绝，且无法重新读取改动：\(error.riffetMessage)")
        }
    }
}

struct GitCheckpointChangeRow: View {
    let change: CheckpointChange
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
            Text(gitChangeLabel(change.kind))
                .font(.riffet(size: S(11), weight: .semibold))
                .foregroundStyle(gitChangeTint(change.kind, palette))
                .frame(width: 28, alignment: .leading)
            VStack(alignment: .leading, spacing: 1) {
                Text(change.path)
                    .font(.riffet(size: S(12), design: .monospaced))
                    .foregroundStyle(palette.fg)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .help(change.path)
                Text("\(shortHash(change.beforeHash)) → \(shortHash(change.afterHash))")
                    .font(.riffet(size: S(11), design: .monospaced))
                    .foregroundStyle(palette.fg4)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Space.sm)
        .padding(.vertical, 5)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

func checkpointSubtitle(_ checkpoint: Checkpoint) -> String {
    var parts: [String] = []
    if let when = formatDateTime(value: checkpoint.createdAt) { parts.append(when) }
    parts.append(String(localized: "\(checkpoint.files.formatted()) 个文件"))
    if !checkpoint.excluded.isEmpty { parts.append(String(localized: "已排除 \(checkpoint.excluded.count)")) }
    return parts.joined(separator: " · ")
}
