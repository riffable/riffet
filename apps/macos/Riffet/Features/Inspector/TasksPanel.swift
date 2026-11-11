import AppKit
import SwiftUI
import RiffetKit

// The `tasks` renderer of the side panel (docs/TASKS.md): a plugin's task provider drawn as its
// actions, the task being followed and the recent ones. The server owns the process; this panel
// only starts, cancels and reads, so closing it, switching tab or project stops the polling and
// nothing else.

/// One provider's tasks in one project. Built again for another project (`TasksPanel` is keyed by
/// it), so a read that was in flight for the old project cannot land in the new one.
@MainActor
@Observable
final class ProjectTasksModel {
    let projectId: String
    let provider: String
    private(set) var actions: [TaskAction] = []
    private(set) var tasks: [ProjectTask] = []
    /// The task the reader picked or just started; otherwise the running one, else the newest.
    private(set) var selectedId: String?
    private(set) var log = ""
    private(set) var starting = false
    private(set) var cancelling = false
    private(set) var downloading: String?
    private(set) var error: String?
    /// The command a task of an installed package would run, waiting for the reader's approval.
    var confirmation: PendingStart?
    /// Bumped when the followed task changes, which restarts the polling at once.
    private(set) var version = 0

    private static let logCap = 256 * 1024
    private static let window: Int32 = 64 * 1024
    @ObservationIgnored private var logTaskId: String?
    @ObservationIgnored private var logOffset: Int64 = 0

    /// A start waiting for approval: the same request goes out again with the fingerprint.
    struct PendingStart: Identifiable {
        let id = UUID()
        let action: TaskAction
        let requestId: String
        let plan: TaskConfirmation
    }

    init(projectId: String, provider: String) {
        self.projectId = projectId
        self.provider = provider
    }

    var current: ProjectTask? {
        if let selectedId, let picked = tasks.first(where: { $0.id == selectedId }) { return picked }
        return tasks.first(where: \.isOpen) ?? tasks.first
    }

    // MARK: Polling

    /// Reads until cancelled: every second while a task is open, every few seconds otherwise.
    func follow(_ api: RiffetApi) async {
        if actions.isEmpty, let response = try? await api.taskActions(projectId: projectId), !Task.isCancelled {
            actions = response.actions.filter { $0.providerId == provider }
        }
        while !Task.isCancelled {
            await refresh(api)
            let open = tasks.contains(where: \.isOpen)
            try? await Task.sleep(for: .seconds(open ? 1 : 4))
        }
    }

    private func refresh(_ api: RiffetApi) async {
        guard let all = try? await api.tasks(projectId: projectId, limit: 20), !Task.isCancelled else { return }
        let mine = all.filter { $0.providerId == provider }
        if mine != tasks { tasks = mine }
        await readLog(api)
    }

    /// The followed task's log from where the last read ended. A finished task with a long log starts
    /// near its end: only the last part is kept anyway.
    private func readLog(_ api: RiffetApi) async {
        guard let task = current else {
            if !log.isEmpty { log = "" }
            logTaskId = nil
            return
        }
        if logTaskId != task.id {
            logTaskId = task.id
            logOffset = max(0, task.logSize - Int64(Self.logCap))
            if !log.isEmpty { log = "" }
        }
        for _ in 0..<8 {
            guard let chunk = try? await api.taskLog(id: task.id, from: logOffset, limit: Self.window), !Task.isCancelled, logTaskId == task.id else { return }
            guard chunk.to > logOffset else { return }
            logOffset = chunk.to
            append(chunk.text)
            if chunk.eof { return }
        }
    }

    private func append(_ text: String) {
        guard !text.isEmpty else { return }
        var next = log + text
        if next.utf8.count > Self.logCap {
            // Keep the end, and start at a line.
            var tail = String(decoding: Array(next.utf8.suffix(Self.logCap)), as: UTF8.self)
            if let newline = tail.firstIndex(of: "\n"), tail.distance(from: tail.startIndex, to: newline) < 4096 { tail = String(tail[tail.index(after: newline)...]) }
            next = tail
        }
        log = next
    }

    // MARK: Actions of the reader

    func select(_ id: String) {
        guard id != current?.id else { return }
        selectedId = id
        version += 1
    }

    /// Starts one task. A second press while the request is in flight does nothing, and a retry of
    /// the same press would carry the same request id, so one press is one process.
    func begin(_ action: TaskAction, api: RiffetApi?, requestId: String = UUID().uuidString.lowercased(), confirm: String? = nil) {
        guard !starting, let api else { return }
        starting = true
        error = nil
        let body = TaskCreate(requestId: requestId, projectId: projectId, providerId: action.providerId, actionId: action.id, params: [:], confirm: confirm)
        Task { @MainActor in
            defer { self.starting = false }
            do {
                let started = try await api.startTask(body: body)
                if let plan = started.confirmation { self.confirmation = PendingStart(action: action, requestId: requestId, plan: plan); return }
                if let task = started.task { self.merge(task); self.selectedId = task.id }
                // Another task holds the project's lock: that is the one to watch.
                else if let holder = started.holderId { self.selectedId = holder }
                self.version += 1
            } catch {
                self.error = error.riffetMessage
            }
        }
    }

    /// Shows [id], the task a command started: it is the one to follow.
    func focus(_ id: String) {
        selectedId = id
        version += 1
    }

    /// Asks the server to stop it. What the panel shows afterwards is the server's own state: it stays
    /// `cancelling` until the process is seen to exit.
    func cancel(_ task: ProjectTask, api: RiffetApi?) {
        guard !cancelling, let api else { return }
        cancelling = true
        error = nil
        Task { @MainActor in
            defer { self.cancelling = false }
            do { self.merge(try await api.cancelTask(id: task.id)) } catch { self.error = error.riffetMessage }
        }
    }

    func download(_ artifact: TaskArtifact, of task: ProjectTask) {
        guard downloading == nil else { return }
        downloading = artifact.id
        error = nil
        Task { @MainActor in
            self.error = await TaskDownloads.save(taskId: task.id, artifact: artifact)
            self.downloading = nil
        }
    }

    private func merge(_ task: ProjectTask) {
        guard task.providerId == provider else { return }
        if let index = tasks.firstIndex(where: { $0.id == task.id }) { tasks[index] = task }
        else { tasks.insert(task, at: 0) }
    }
}

extension ProjectTask {
    var isOpen: Bool { state == "running" || state == "cancelling" }
}

/// Artifacts of a finished task, saved to the Downloads folder (an unsandboxed app may write there).
@MainActor
enum TaskDownloads {
    static func save(taskId: String, artifact: TaskArtifact) async -> String? {
        guard let api = AppModel.shared.host.api, let url = URL(string: api.taskArtifactUrl(taskId: taskId, artifactId: artifact.id)) else { return String(localized: "未连接") }
        do {
            let (temporary, response) = try await URLSession.shared.download(for: ProjectDownloads.authorized(url))
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard status == 200 else {
                // A later build replaced the file this task registered.
                return status == 409 ? String(localized: "文件已被之后的构建覆盖") : String(localized: "下载失败（\(status)）")
            }
            let files = FileManager.default
            let folder = files.urls(for: .downloadsDirectory, in: .userDomainMask).first ?? files.homeDirectoryForCurrentUser.appendingPathComponent("Downloads", isDirectory: true)
            let destination = unused(in: folder, name: artifact.name)
            try files.moveItem(at: temporary, to: destination)
            NSWorkspace.shared.activateFileViewerSelecting([destination])
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    /// `name`, or `name 2.ext`, `name 3.ext`... when that is taken: a download never replaces a file.
    private static func unused(in folder: URL, name: String) -> URL {
        var safe = (name as NSString).lastPathComponent
        if safe.isEmpty || safe == "." || safe == ".." { safe = "download" }
        let stem = (safe as NSString).deletingPathExtension
        let ext = (safe as NSString).pathExtension
        var candidate = folder.appendingPathComponent(safe)
        var number = 2
        while FileManager.default.fileExists(atPath: candidate.path) {
            candidate = folder.appendingPathComponent(ext.isEmpty ? "\(stem) \(number)" : "\(stem) \(number).\(ext)")
            number += 1
        }
        return candidate
    }
}

// MARK: View

struct TasksPanel: View {
    let workbench: Workbench
    let project: Project
    let provider: String

    var body: some View {
        TasksContent(workbench: workbench, project: project, provider: provider)
            .id("\(project.id)|\(provider)")
    }
}

private struct TasksContent: View {
    let workbench: Workbench
    let project: Project
    @Environment(\.palette) private var palette
    @Environment(\.inspectorPanelVisible) private var panelVisible
    @State private var model: ProjectTasksModel
    private let provider: String

    init(workbench: Workbench, project: Project, provider: String) {
        self.provider = provider
        self.workbench = workbench
        self.project = project
        _model = State(initialValue: ProjectTasksModel(projectId: project.id, provider: provider))
    }

    var body: some View {
        VStack(spacing: 0) {
            actionBar
            PanelRule()
            if let error = model.error { GitInlineError(message: error) }
            if let task = model.current {
                TaskDetail(workbench: workbench, task: task, model: model)
                if model.tasks.count > 1 {
                    PanelRule()
                    recent
                }
            } else {
                Spacer(minLength: 0)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .sheet(item: Bindable(model).confirmation) { pending in
            TaskConfirmationSheet(title: pluginTitle(of: pending.action), plan: pending.plan) {
                model.begin(pending.action, api: workbench.host.api, requestId: pending.requestId, confirm: pending.plan.fingerprint)
            }
        }
        // A command that started a task asked for it to be shown; once.
        .onChange(of: workbench.taskFocus, initial: true) { _, focus in
            guard let focus, focus.projectId == project.id, focus.provider == provider else { return }
            workbench.taskFocus = nil
            model.focus(focus.taskId)
        }
        // Only while the panel is on screen; the key restarts it when another task is followed.
        .task(id: "\(panelVisible)|\(model.version)") {
            guard panelVisible, let api = workbench.host.api else { return }
            await model.follow(api)
        }
    }

    private func pluginTitle(of action: TaskAction) -> String {
        workbench.plugins.first { $0.id == action.pluginId }?.displayTitle ?? action.pluginId
    }

    private var actionBar: some View {
        HStack(alignment: .top, spacing: Space.sm) {
            // A plugin can offer more actions than a narrow panel holds in one line: they wrap
            // rather than squeeze each title to a column of letters.
            FlowRow(spacing: Space.sm, lineSpacing: Space.sm) {
                ForEach(model.actions, id: \.id) { action in
                    Button { model.begin(action, api: workbench.host.api) } label: { Text(localizedText(action.title, fallback: action.id)) }
                        .buttonStyle(SolidButtonStyle(kind: .primary))
                        .disabled(model.starting)
                }
            }
            Spacer(minLength: 0)
            if let task = model.current, task.isOpen {
                Button(String(localized: "取消")) { model.cancel(task, api: workbench.host.api) }
                    .buttonStyle(SolidButtonStyle(kind: .secondary))
                    .disabled(task.state == "cancelling" || model.cancelling)
            }
        }
        .padding(.horizontal, Space.md)
        .padding(.vertical, Space.sm)
        .frame(minHeight: InspectorMetrics.headerHeight)
    }

    private var recent: some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                ForEach(model.tasks, id: \.id) { task in
                    Button { model.select(task.id) } label: { TaskRow(task: task, selected: task.id == model.current?.id) }
                        .buttonStyle(HoverRowStyle())
                }
            }
            .padding(Space.xs + 2)
        }
        .frame(maxHeight: 132)
    }
}

/// The followed task: how it stands, what it found, what it made, and its log.
private struct TaskDetail: View {
    let workbench: Workbench
    let task: ProjectTask
    let model: ProjectTasksModel
    @Environment(\.palette) private var palette

    private var diagnostics: [TaskDiagnostic] {
        let all = task.diagnostics ?? []
        return all.filter { $0.severity == "error" } + all.filter { $0.severity != "error" }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: Space.sm) {
                TaskStateGlyph(state: task.state)
                Text(localizedText(task.title, fallback: task.actionId))
                    .font(.riffet(size: S(13), weight: .medium))
                    .foregroundStyle(palette.fg)
                    .lineLimit(1)
                Spacer(minLength: Space.sm)
                Text(meta)
                    .font(.riffet(size: S(11)))
                    .foregroundStyle(task.state == "failed" ? palette.danger : palette.fg4)
                    .lineLimit(1)
            }
            .padding(.horizontal, Space.md)
            .frame(height: 36)
            if let reason = task.unknownReason {
                Text(reason)
                    .font(.riffet(size: S(12)))
                    .foregroundStyle(palette.fg3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, Space.md)
                    .padding(.bottom, Space.sm)
            }
            let artifacts = task.artifacts ?? []
            if !diagnostics.isEmpty || !artifacts.isEmpty {
                PanelRule()
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(artifacts, id: \.id) { artifact in
                            Button { model.download(artifact, of: task) } label: { ArtifactRow(artifact: artifact, busy: model.downloading == artifact.id) }
                                .buttonStyle(HoverRowStyle())
                                .disabled(model.downloading != nil)
                        }
                        ForEach(Array(diagnostics.enumerated()), id: \.offset) { _, diagnostic in
                            DiagnosticRow(diagnostic: diagnostic) { file, line in workbench.preview(path: file, line: line) }
                        }
                    }
                    .padding(Space.xs + 2)
                }
                .frame(maxHeight: 220)
            }
            PanelRule()
            TaskLogView(text: model.log, palette: palette)
        }
    }

    /// Only what the glyph cannot say: how long it took, the exit code of a failure, that a stop is under way.
    private var meta: String {
        switch task.state {
        case "cancelling": return String(localized: "正在取消")
        case "failed":
            guard let code = task.exitCode?.intValue else { return duration }
            return String(localized: "退出码 \(Int(code))")
        case "running": return ""
        default: return duration
        }
    }

    private var duration: String {
        guard let start = ServerTime.date(task.startedAt), let end = ServerTime.date(task.endedAt) else { return "" }
        let formatter = DateComponentsFormatter()
        formatter.unitsStyle = .abbreviated
        formatter.maximumUnitCount = 2
        formatter.allowedUnits = [.hour, .minute, .second]
        var calendar = Calendar.current
        calendar.locale = AppLocale.current
        formatter.calendar = calendar
        return formatter.string(from: max(1, end.timeIntervalSince(start))) ?? ""
    }
}

private struct TaskRow: View {
    let task: ProjectTask
    let selected: Bool
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: Space.sm) {
            TaskStateGlyph(state: task.state)
            Text(localizedText(task.title, fallback: task.actionId))
                .font(.riffet(size: S(12)))
                .foregroundStyle(palette.fg)
                .lineLimit(1)
            Spacer(minLength: Space.sm)
            Text(relativeLabel(value: task.startedAt, now: Int64(Date().timeIntervalSince1970 * 1000)) ?? "")
                .font(.riffet(size: S(11)))
                .foregroundStyle(palette.fg4)
                .lineLimit(1)
        }
        .padding(.horizontal, Space.sm)
        .frame(height: 26)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(selected ? palette.bgActive : .clear, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
    }
}

private struct TaskStateGlyph: View {
    let state: String
    @Environment(\.palette) private var palette

    var body: some View {
        Group {
            switch state {
            case "running", "cancelling": Spinner(size: .mini)
            case "succeeded": Image(icon: "checkmark.circle.fill").foregroundStyle(palette.success)
            case "failed": Image(icon: "xmark.circle.fill").foregroundStyle(palette.danger)
            case "cancelled": Image(icon: "stop.circle").foregroundStyle(palette.fg4)
            default: Image(icon: "questionmark.circle").foregroundStyle(palette.warning)
            }
        }
        .font(.riffet(size: S(12)))
        .frame(width: 16)
        .help(label)
        .accessibilityLabel(label)
    }

    private var label: String {
        switch state {
        case "running": String(localized: "运行中")
        case "cancelling": String(localized: "正在取消")
        case "succeeded": String(localized: "成功")
        case "failed": String(localized: "失败")
        case "cancelled": String(localized: "已取消")
        default: String(localized: "状态未知")
        }
    }
}

private struct DiagnosticRow: View {
    let diagnostic: TaskDiagnostic
    let open: (String, Int?) -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        if let file = diagnostic.file {
            Button { open(file, diagnostic.line?.intValue) } label: { content(file) }
                .buttonStyle(HoverRowStyle())
        } else {
            content(nil)
        }
    }

    private func content(_ file: String?) -> some View {
        let error = diagnostic.severity == "error"
        return HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
            Image(icon: error ? "exclamationmark.circle.fill" : "exclamationmark.triangle.fill")
                .font(.riffet(size: S(11)))
                .foregroundStyle(error ? palette.danger : palette.warning)
                .frame(width: 16)
                .help(error ? String(localized: "错误") : String(localized: "警告"))
            VStack(alignment: .leading, spacing: 1) {
                Text(diagnostic.message)
                    .font(.riffet(size: S(12)))
                    .foregroundStyle(palette.fg)
                    .lineLimit(3)
                    .multilineTextAlignment(.leading)
                if let file {
                    Text(diagnostic.line.map { "\(file):\($0.intValue)" } ?? file)
                        .font(RiffetFont.codeSmall)
                        .foregroundStyle(palette.fg4)
                        .lineLimit(1)
                        .truncationMode(.head)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Space.sm)
        .padding(.vertical, 5)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct ArtifactRow: View {
    let artifact: TaskArtifact
    let busy: Bool
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: Space.sm) {
            Group {
                if busy { Spinner(size: .mini) } else { Image(icon: "arrow.down.circle").font(.riffet(size: S(12))) }
            }
            .frame(width: 16)
            .foregroundStyle(palette.accent)
            Text(artifact.name)
                .font(.riffet(size: S(12), weight: .medium))
                .foregroundStyle(palette.fg)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: Space.sm)
            Text(ByteCountFormatter.string(fromByteCount: artifact.size, countStyle: .file))
                .font(.riffet(size: S(11)))
                .foregroundStyle(palette.fg4)
        }
        .padding(.horizontal, Space.sm)
        .padding(.vertical, 5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .help(String(localized: "下载"))
    }
}

/// The log in a read-only `NSTextView`: AppKit lays out what is on screen, so the last 256 KB scroll
/// as smoothly as a short one. New output is appended, and the view follows it while it is at the end.
private struct TaskLogView: NSViewRepresentable {
    let text: String
    let palette: Palette

    func makeCoordinator() -> Coordinator { Coordinator() }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSScrollView, context: Context) -> CGSize? {
        CGSize(width: proposal.width ?? 320, height: proposal.height ?? 200)
    }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSTextView.scrollableTextView()
        scroll.drawsBackground = false
        scroll.clipsToBounds = true
        scroll.hasHorizontalScroller = true
        scroll.autohidesScrollers = true
        guard let textView = scroll.documentView as? NSTextView else { return scroll }
        textView.isEditable = false
        textView.isSelectable = true
        textView.drawsBackground = false
        textView.textContainerInset = NSSize(width: 6, height: 8)
        textView.isHorizontallyResizable = true
        textView.isVerticallyResizable = true
        textView.minSize = .zero
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.textContainer?.widthTracksTextView = false
        textView.textContainer?.containerSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.autoresizingMask = []
        textView.layoutManager?.allowsNonContiguousLayout = true
        context.coordinator.textView = textView
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        let coordinator = context.coordinator
        guard let textView = coordinator.textView, let storage = textView.textStorage else { return }
        let size = S(12)
        let style = "\(size)|\(palette.values.id)|\(palette.revision)"
        let attributes: [NSAttributedString.Key: Any] = [
            .font: AppearanceFonts.current.mono?.nsFont(size: size) ?? NSFont.monospacedSystemFont(ofSize: size, weight: .regular),
            .foregroundColor: palette.nsColor(\.fg2),
        ]
        let following = coordinator.atEnd(scroll)
        if coordinator.style == style, coordinator.applied == text { return }
        if coordinator.style == style, !coordinator.applied.isEmpty, text.utf8.starts(with: coordinator.applied.utf8) {
            let tail = String(decoding: text.utf8.dropFirst(coordinator.applied.utf8.count), as: UTF8.self)
            storage.append(NSAttributedString(string: tail, attributes: attributes))
        } else {
            storage.setAttributedString(NSAttributedString(string: text, attributes: attributes))
        }
        coordinator.style = style
        coordinator.applied = text
        if following || coordinator.first { textView.scrollToEndOfDocument(nil) }
        coordinator.first = false
    }

    final class Coordinator {
        weak var textView: NSTextView?
        var style = ""
        var applied = ""
        var first = true

        /// The reader is looking at the end, so new output should stay in view.
        @MainActor
        func atEnd(_ scroll: NSScrollView) -> Bool {
            guard let textView else { return true }
            return scroll.contentView.bounds.maxY >= textView.frame.maxY - 24
        }
    }
}
