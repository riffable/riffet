import SwiftUI
import RiffetKit

/// What the connected service keeps on disk: the database by part, the state directory by kind, and
/// which projects and conversations take the room. The breakdown comes from a scan the service runs in
/// the background, so the page polls only while `scanning`. Compaction rebuilds the database at the
/// service's next start; for the service this Mac hosts, 立即重启 is that start.
struct StorageSettings: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette
    @State private var report: StorageReport?
    /// The last read's failure; with a report on screen it sits in the status line.
    @State private var error: String?
    @State private var actionError: String?
    @State private var busy = false
    @State private var confirmCompaction = false

    private static let pollInterval: Duration = .seconds(2)
    /// Below this, an estimate of what compaction gives back says nothing worth reading.
    private static let reclaimWorthNaming: Int64 = 1_048_576

    var body: some View {
        ZStack {
            if model.workbench == nil {
                DisconnectedSettings(detail: String(localized: "连接服务器后可查看。"))
            } else if let report {
                form(report)
            } else if let error {
                ContentUnavailableView {
                    Label("无法读取存储空间", icon: "exclamationmark.triangle")
                } description: {
                    Text(error)
                } actions: {
                    Button("重试") { Task { await load() } }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                Spinner(size: .regular).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: model.workbench != nil) { await load() }
        .task(id: report?.scanning ?? false) {
            guard report?.scanning == true else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: Self.pollInterval)
                if Task.isCancelled { return }
                await load()
            }
        }
        .confirmationDialog("在服务下次启动时整理数据库？", isPresented: $confirmCompaction, titleVisibility: .visible) {
            Button("安排整理") { Task { await schedule(true) } }
            Button("取消", role: .cancel) {}
        } message: {
            if let free = report?.database.freeBytes, free >= Self.reclaimWorthNaming {
                Text("预计收回 \(bytes(free))。重建期间所有设备都连不上服务，可能持续几分钟。")
            } else {
                Text("重建期间所有设备都连不上服务，可能持续几分钟。")
            }
        }
    }

    private func form(_ report: StorageReport) -> some View {
        Form {
            Section {
                scanBar(report)
            }
            Section {
                overview(report)
            }
            databaseBlock(report)
            if let scan = report.scan {
                if !scan.projects.isEmpty { projectsBlock(scan.projects) }
                if !scan.sessions.isEmpty { sessionsBlock(scan.sessions) }
                foldersBlock(scan.folders)
            } else {
                SettingsBlock("按项目") {
                    Spinner(size: .small).frame(maxWidth: .infinity)
                }
            }
        }
        .riffetForm()
    }

    // MARK: - Scan bar and overview

    private func scanBar(_ report: StorageReport) -> some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            HStack(spacing: Space.sm) {
                if report.scanning {
                    Spinner(size: .small)
                    Text("正在统计")
                        .font(.riffet(size: S(RiffetTextSize.xs.size)))
                        .foregroundStyle(palette.fg3)
                } else if let scan = report.scan {
                    Text("统计于 \(ServerTime.relative(scan.at) ?? statsUnavailable) · 用时 \(formatDuration(Double(scan.durationMs)))")
                        .font(.riffet(size: S(RiffetTextSize.xs.size)))
                        .foregroundStyle(palette.fg4)
                        .monospacedDigit()
                }
                Spacer(minLength: Space.sm)
                SettingsActionButton("重新统计", symbol: "arrow.clockwise") { Task { await rescan() } }
                    .controlSize(.small)
                    .disabled(report.scanning)
            }
            SettingsErrorText(message: error)
        }
        .padding(.vertical, Space.xs)
    }

    private func overview(_ report: StorageReport) -> some View {
        let folders = report.scan?.folders ?? []
        let total = report.database.bytes + folders.reduce(0) { $0 + $1.bytes }
        let segments = ([Segment(id: "database", label: String(localized: "数据库"), color: palette.chart1, bytes: report.database.bytes)]
            + ranked(folders, other: { $0.kind == "other" }).map { Segment(id: $0.kind, label: folderLabel($0.kind), color: folderColor($0.kind), bytes: $0.bytes) })
            .filter { $0.bytes > 0 }
        return VStack(alignment: .leading, spacing: Space.md) {
            HStack(alignment: .lastTextBaseline, spacing: Space.md) {
                VStack(alignment: .leading, spacing: Space.xxs) {
                    Text(report.scan == nil ? statsUnavailable : bytes(total))
                        .font(.riffet(size: S(RiffetTextSize.x2xl.size), weight: .medium))
                        .foregroundStyle(palette.fg)
                        .monospacedDigit()
                    Text(report.directory)
                        .font(.riffet(size: S(RiffetTextSize.x2xs.size), design: .monospaced))
                        .foregroundStyle(palette.fg4)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                        .help(report.directory)
                }
                Spacer(minLength: Space.sm)
                Text("磁盘可用 \(bytes(report.disk.freeBytes)) / \(bytes(report.disk.totalBytes))")
                    .font(.riffet(size: S(RiffetTextSize.xs.size)))
                    .foregroundStyle(palette.fg3)
                    .monospacedDigit()
            }
            StackedBar(segments: segments, total: total)
            LegendFlow(segments: segments)
        }
        .padding(.vertical, Space.xs)
    }

    // MARK: - Database

    private func databaseBlock(_ report: StorageReport) -> some View {
        let database = report.database
        let parts = report.scan?.parts ?? []
        return SettingsBlock("数据库 · \(bytes(database.bytes))") {
            VStack(alignment: .leading, spacing: Space.md) {
                if parts.isEmpty {
                    Spinner(size: .small).frame(maxWidth: .infinity)
                }
                ForEach(ranked(parts, other: { $0.part == "other" }), id: \.part) { item in
                    ShareRow(label: partLabel(item.part), note: partNote(item.part), bytes: item.bytes, of: database.bytes, color: palette.chart1)
                }
                ShareRow(label: String(localized: "可回收"), note: nil, bytes: database.freeBytes, of: database.bytes, color: palette.lineStrong)
            }
            .padding(.vertical, Space.xs)
            compactionRow(report)
        }
    }

    @ViewBuilder
    private func compactionRow(_ report: StorageReport) -> some View {
        let compaction = report.compaction
        let short = report.disk.freeBytes < compaction.requiredBytes
        let server = model.server
        let hosted = model.workbench?.local == true && server.state.running != nil
        SettingsRow("整理数据库", detail: compactionDetail(compaction, short: short)) {
            HStack(spacing: Space.sm) {
                if busy || server.restartBlockers != nil { Spinner(size: .small) }
                if compaction.scheduledAt != nil {
                    if hosted {
                        SettingsActionButton("立即重启") { Task { await restart() } }
                            .disabled(server.restartBlockers != nil || server.maintenance?.running == true)
                    }
                    SettingsActionButton("取消") { Task { await schedule(false) } }
                        .disabled(busy)
                } else {
                    SettingsActionButton("安排整理") { confirmCompaction = true }
                        .disabled(busy || short)
                }
            }
            .controlSize(.small)
        }
        if let blockers = server.restartBlockers, !blockers.isEmpty || server.restartProblem != nil {
            if let problem = server.restartProblem {
                Text(verbatim: problem)
                    .font(.riffet(size: S(RiffetTextSize.xs.size)))
                    .foregroundStyle(palette.warning)
            }
            ForEach(blockers) { blocker in
                SettingsRow(blocker.title.isEmpty ? backendLabel(blocker.backendId) : blocker.title) {
                    Text(verbatim: "\(backendLabel(blocker.backendId)) · \(blocker.reasonLabel)")
                        .font(.riffet(size: S(RiffetTextSize.xs.size)))
                        .foregroundStyle(palette.fg3)
                }
            }
            HStack(spacing: Space.sm) {
                SettingsActionButton("仍然重启", kind: .danger) { server.restartAnyway() }
                SettingsActionButton("取消") { server.cancelRestart() }
                Spacer(minLength: 0)
            }
            .controlSize(.small)
        }
        if let last = compaction.last {
            Group {
                if let failure = last.error {
                    Text("上次整理未完成（\(ServerTime.relative(last.at) ?? statsUnavailable)）：\(failure)")
                        .foregroundStyle(palette.danger)
                } else {
                    Text("上次整理 \(ServerTime.relative(last.at) ?? statsUnavailable) · \(bytes(last.beforeBytes)) → \(last.afterBytes.map { bytes($0.int64Value) } ?? statsUnavailable) · 用时 \(formatDuration(Double(last.durationMs)))")
                        .foregroundStyle(palette.fg4)
                }
            }
            .font(.riffet(size: S(RiffetTextSize.x2xs.size)))
            .monospacedDigit()
        }
        SettingsErrorText(message: actionError)
    }

    private func compactionDetail(_ compaction: StorageCompaction, short: Bool) -> String {
        if compaction.scheduledAt != nil { return String(localized: "将在服务下次启动时进行") }
        if short { return String(localized: "可用空间不足，需要 \(bytes(compaction.requiredBytes))") }
        return String(localized: "在服务下次启动时重建文件，期间服务不可用")
    }

    // MARK: - Projects, sessions, folders

    private func projectsBlock(_ projects: [StorageProjectUsage]) -> some View {
        let max = Swift.max(projects.map(projectTotal).max() ?? 1, 1)
        return SettingsBlock("按项目") {
            Grid(alignment: .trailing, horizontalSpacing: Space.md, verticalSpacing: Space.sm) {
                GridRow {
                    Text("项目").gridColumnAlignment(.leading)
                    Color.clear.frame(width: Space.xxl * 4, height: 0)
                    Text("会话")
                    Text("检查点")
                    Text("工作树")
                    Text("合计")
                }
                .font(.riffet(size: S(RiffetTextSize.x2xs.size)))
                .foregroundStyle(palette.fg3)
                ForEach(projects, id: \.projectId) { project in
                    let total = projectTotal(project)
                    GridRow {
                        Text(project.name ?? String(localized: "已删除的项目"))
                            .font(.riffet(size: S(RiffetTextSize.xs.size), weight: project.projectId == nil ? .regular : .medium))
                            .foregroundStyle(project.projectId == nil ? palette.fg3 : palette.fg)
                            .lineLimit(1)
                            .truncationMode(.tail)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        ProjectBar(project: project, total: total, of: max, colors: [palette.chart1, palette.chart2, palette.chart3])
                            .frame(width: Space.xxl * 4)
                        projectCell(project.sessionBytes)
                        projectCell(project.checkpointBytes)
                        projectCell(project.worktreeBytes)
                        Text(bytes(total))
                            .font(.riffet(size: S(RiffetTextSize.xs.size), weight: .medium))
                            .foregroundStyle(palette.fg)
                    }
                }
            }
            .monospacedDigit()
            .padding(.vertical, Space.xs)
        }
    }

    private func projectCell(_ value: Int64) -> some View {
        Text(value > 0 ? bytes(value) : "—")
            .font(.riffet(size: S(RiffetTextSize.xs.size)))
            .foregroundStyle(palette.fg3)
    }

    private func projectTotal(_ project: StorageProjectUsage) -> Int64 {
        project.sessionBytes + project.checkpointBytes + project.worktreeBytes
    }

    private func sessionsBlock(_ sessions: [StorageSessionUsage]) -> some View {
        SettingsBlock("占用最多的会话") {
            Grid(alignment: .trailing, horizontalSpacing: Space.md, verticalSpacing: Space.sm) {
                GridRow {
                    Text("会话").gridColumnAlignment(.leading)
                    Text("最近活动")
                    Text("大小")
                }
                .font(.riffet(size: S(RiffetTextSize.x2xs.size)))
                .foregroundStyle(palette.fg3)
                ForEach(sessions, id: \.sessionId) { session in
                    GridRow {
                        VStack(alignment: .leading, spacing: 0) {
                            Text(session.title)
                                .font(.riffet(size: S(RiffetTextSize.xs.size), weight: .medium))
                                .foregroundStyle(palette.fg)
                                .lineLimit(1)
                                .truncationMode(.tail)
                            if let name = session.projectName {
                                Text(name)
                                    .font(.riffet(size: S(RiffetTextSize.x2xs.size)))
                                    .foregroundStyle(palette.fg4)
                                    .lineLimit(1)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        Text(session.lastActivityAt.flatMap { ServerTime.relative($0) } ?? "—")
                            .font(.riffet(size: S(RiffetTextSize.xs.size)))
                            .foregroundStyle(palette.fg3)
                        Text(bytes(session.bytes))
                            .font(.riffet(size: S(RiffetTextSize.xs.size)))
                            .foregroundStyle(palette.fg)
                            .monospacedDigit()
                    }
                }
            }
            .padding(.vertical, Space.xs)
        }
    }

    private func foldersBlock(_ folders: [StorageFolderUsage]) -> some View {
        let max = Swift.max(folders.map(\.bytes).max() ?? 1, 1)
        return SettingsBlock("文件") {
            VStack(alignment: .leading, spacing: Space.md) {
                ForEach(ranked(folders, other: { $0.kind == "other" }), id: \.kind) { folder in
                    ShareRow(label: folderLabel(folder.kind), note: folderNote(folder.kind), bytes: folder.bytes, of: max, color: folderColor(folder.kind))
                }
            }
            .padding(.vertical, Space.xs)
        }
    }

    // MARK: - Labels

    private func partLabel(_ part: String) -> String {
        switch part {
        case "journal": String(localized: "会话记录")
        case "timeline": String(localized: "时间线")
        case "blobs": String(localized: "图片与长输出")
        case "search": String(localized: "搜索索引")
        case "records": String(localized: "运行与用量")
        default: String(localized: "其他")
        }
    }

    /// How each part is let go, which nothing on screen shows.
    private func partNote(_ part: String) -> String? {
        switch part {
        case "journal": String(localized: "随会话删除")
        case "timeline": String(localized: "7 天未活动的会话清空，打开时重建")
        case "blobs": String(localized: "不再引用时回收")
        default: nil
        }
    }

    private func folderLabel(_ kind: String) -> String {
        switch kind {
        case "checkpoints": String(localized: "回合检查点")
        case "worktrees": String(localized: "工作树")
        case "attachments": String(localized: "附件")
        case "tasks": String(localized: "后台任务")
        case "plugins": String(localized: "插件")
        case "logs": String(localized: "日志与诊断")
        default: String(localized: "其他")
        }
    }

    private func folderNote(_ kind: String) -> String? {
        switch kind {
        case "checkpoints": String(localized: "每个项目保留最近 50 个回合")
        case "attachments": String(localized: "30 天未用即清理")
        default: nil
        }
    }

    private func folderColor(_ kind: String) -> Color {
        switch kind {
        case "checkpoints": palette.chart2
        case "worktrees": palette.chart3
        case "attachments": palette.chart4
        case "tasks": palette.chart5
        case "plugins": palette.chart6
        case "logs": palette.chart7
        default: palette.chart8
        }
    }

    /// Largest first, with 其他 always last: it is what is left, not a thing of its own.
    private func ranked<T>(_ items: [T], other: (T) -> Bool) -> [T] where T: StorageSized {
        items.sorted { a, b in
            let oa = other(a), ob = other(b)
            return oa != ob ? !oa : a.sizeBytes > b.sizeBytes
        }
    }

    private func bytes(_ value: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: value, countStyle: .file)
    }

    // MARK: - Actions

    private func load() async {
        guard let api = model.workbench?.host.api else { return }
        do {
            report = try await api.storage()
            error = nil
        } catch is CancellationError {
            return
        } catch {
            if !Task.isCancelled { self.error = error.riffetMessage }
        }
    }

    private func rescan() async {
        guard let api = model.workbench?.host.api else { return }
        do {
            report = try await api.scanStorage()
            error = nil
        } catch {
            self.error = error.riffetMessage
        }
    }

    private func schedule(_ scheduled: Bool) async {
        guard let api = model.workbench?.host.api, !busy else { return }
        busy = true
        actionError = nil
        do { report = try await api.scheduleCompaction(scheduled: scheduled) } catch { actionError = error.riffetMessage }
        busy = false
    }

    private func restart() async {
        actionError = nil
        do { try await model.server.restartWhenIdle() } catch { actionError = error.riffetMessage }
    }
}

// MARK: - Pieces

private protocol StorageSized {
    var sizeBytes: Int64 { get }
}

extension StoragePartUsage: StorageSized {
    fileprivate var sizeBytes: Int64 { bytes }
}

extension StorageFolderUsage: StorageSized {
    fileprivate var sizeBytes: Int64 { bytes }
}

extension Segment: StorageSized {
    fileprivate var sizeBytes: Int64 { bytes }
}

private struct Segment: Identifiable {
    let id: String
    let label: String
    let color: Color
    let bytes: Int64
}

/// One bar for the whole state directory: the database, then each kind of folder.
private struct StackedBar: View {
    let segments: [Segment]
    let total: Int64
    @Environment(\.palette) private var palette

    var body: some View {
        GeometryReader { proxy in
            HStack(spacing: 1) {
                if total > 0 {
                    ForEach(segments) { segment in
                        segment.color
                            .frame(width: proxy.size.width * Double(segment.bytes) / Double(total))
                            .help("\(segment.label) \(ByteCountFormatter.string(fromByteCount: segment.bytes, countStyle: .file))")
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(height: Space.sm)
        .background(palette.bgMuted)
        .clipShape(Capsule())
    }
}

private struct LegendFlow: View {
    let segments: [Segment]
    @Environment(\.palette) private var palette

    var body: some View {
        FlowLayout(spacing: Space.md) {
            ForEach(segments) { segment in
                HStack(spacing: Space.xs) {
                    Circle().fill(segment.color).frame(width: Space.sm - Space.xxs, height: Space.sm - Space.xxs)
                    Text(segment.label).foregroundStyle(palette.fg2)
                    Text(ByteCountFormatter.string(fromByteCount: segment.bytes, countStyle: .file)).foregroundStyle(palette.fg4)
                }
                .font(.riffet(size: S(RiffetTextSize.x2xs.size)))
                .monospacedDigit()
            }
        }
    }
}

/// A ranked bar against a total: the label, what it is let go by, and its size.
private struct ShareRow: View {
    let label: String
    let note: String?
    let bytes: Int64
    let of: Int64
    let color: Color
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
                Text(label)
                    .font(.riffet(size: S(RiffetTextSize.xs.size)))
                    .foregroundStyle(palette.fg2)
                if let note {
                    Text(note)
                        .font(.riffet(size: S(RiffetTextSize.x2xs.size)))
                        .foregroundStyle(palette.fg4)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                Spacer(minLength: Space.sm)
                Text(ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file))
                    .font(.riffet(size: S(RiffetTextSize.xs.size)))
                    .foregroundStyle(palette.fg)
                    .monospacedDigit()
            }
            GeometryReader { proxy in
                HStack(spacing: 0) {
                    color
                        .frame(width: proxy.size.width * fraction)
                        .clipShape(Capsule())
                    Spacer(minLength: 0)
                }
            }
            .frame(height: Space.xs + Space.xxs)
            .background(palette.bgMuted)
            .clipShape(Capsule())
        }
    }

    /// A nonzero part keeps a sliver, so it does not read as empty.
    private var fraction: CGFloat {
        guard of > 0, bytes > 0 else { return 0 }
        return max(CGFloat(bytes) / CGFloat(of), 0.008)
    }
}

/// A project's sessions, checkpoints and worktrees as one bar scaled to the largest project.
private struct ProjectBar: View {
    let project: StorageProjectUsage
    let total: Int64
    let of: Int64
    let colors: [Color]
    @Environment(\.palette) private var palette

    var body: some View {
        GeometryReader { proxy in
            let width = proxy.size.width * max(CGFloat(total) / CGFloat(of), 0.02)
            let parts = [project.sessionBytes, project.checkpointBytes, project.worktreeBytes]
            HStack(spacing: 0) {
                ForEach(parts.indices, id: \.self) { index in
                    if parts[index] > 0, total > 0 {
                        colors[index].frame(width: width * CGFloat(parts[index]) / CGFloat(total))
                    }
                }
                Spacer(minLength: 0)
            }
            .frame(height: Space.xs + Space.xxs)
            .clipShape(Capsule())
            .frame(maxHeight: .infinity, alignment: .center)
        }
        .frame(height: Space.md)
    }
}
