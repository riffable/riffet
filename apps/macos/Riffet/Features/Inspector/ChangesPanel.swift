import SwiftUI
import RiffetKit

// MARK: Changes

enum GitSection: String, CaseIterable, Identifiable {
    case changes, checkpoints, worktrees

    var id: String { rawValue }

    var title: String {
        switch self {
        case .changes: String(localized: "改动")
        case .checkpoints: String(localized: "检查点")
        case .worktrees: "Worktree"
        }
    }
}

struct ChangesPanel: View {
    let workbench: Workbench
    let project: Project
    @Environment(\.palette) private var palette
    @Environment(\.inspectorPanelVisible) private var panelVisible
    @State private var section: GitSection = .changes
    /// Sections opened so far; they stay mounted behind the shown one.
    @State private var visitedSections: Set<GitSection> = [.changes]
    @State private var selected: GitEntry?
    /// The commit message being typed; a new project starts it empty.
    @State private var commitMessage = ""
    @State private var openedCheckpoint: Checkpoint?
    @State private var diff: GitDiff?
    /// The file [diff] belongs to: a reload of the same file keeps the old diff on screen until the new one arrives.
    @State private var diffPath: String?
    @State private var actionError: String?
    @State private var busy = false
    @State private var refreshToken = 0

    /// Remarks outlive this view (the Files tab or a closed panel), so they are kept per project.
    private var review: ReviewDrafts { ReviewDrafts.drafts(for: project.id) }
    /// The status is shared with the toolbar menu and outlives a closed panel.
    private var git: GitStatusModel { GitStatusModel.model(for: project.id) }
    private var status: GitStatus? { git.status }
    private var error: String? { git.error }

    private var drillToken: String { selected?.path ?? openedCheckpoint?.id ?? "" }

    /// The open session, when it belongs to this project — attached to a checkpoint the way the web does.
    private var checkpointSessionId: String? {
        guard let session = workbench.selected, session.projectId == project.id else { return nil }
        return session.id
    }

    var body: some View {
        ZStack(alignment: .top) {
            // The list stays under an open diff or checkpoint, so going back keeps its scroll position.
            root.keptAlive(hidden: selected != nil || openedCheckpoint != nil)
            if let selected {
                diffPage(selected)
            } else if let openedCheckpoint {
                GitCheckpointDetail(workbench: workbench, project: project, checkpoint: openedCheckpoint, onBack: { self.openedCheckpoint = nil }) {
                    self.openedCheckpoint = nil
                    await git.load(workbench.host.api, force: true)
                }
            }
        }
        // Pages switch without a slide: every frame of one re-laid out the whole window.
        .onChange(of: project.id) { if !commitMessage.isEmpty { commitMessage = "" } }
        .task(id: project.id) {
            selected = nil
            openedCheckpoint = nil
            actionError = nil
            await git.load(workbench.host.api)
        }
        .onChange(of: workbench.working) { _, working in
            if !working { Task { await git.load(workbench.host.api) } }
        }
        .onChange(of: panelVisible) { _, visible in
            if visible { Task { await git.load(workbench.host.api, maxAge: 10) } }
        }
        .onChange(of: git.revision) { _, _ in
            if let selected, let updated = status?.entries.first(where: { $0.path == selected.path }) {
                self.selected = updated
            }
        }
    }

    private var root: some View {
        VStack(spacing: 0) {
            sectionBar
            PanelRule()
            ZStack(alignment: .top) {
                ForEach(pages) { page in
                    if mounted(page) {
                        pageBody(page)
                            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                            .keptAlive(hidden: section != page)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .onChange(of: section) { _, shown in visitedSections.insert(shown) }
    }

    private var pages: [GitSection] { GitSection.allCases.filter { !project.isTaskWorkspace || $0 != .worktrees } }

    private func mounted(_ page: GitSection) -> Bool { section == page || visitedSections.contains(page) }

    @ViewBuilder
    private func pageBody(_ page: GitSection) -> some View {
        switch page {
        case .changes:
            changesPage
        case .checkpoints:
            GitCheckpointsList(workbench: workbench, project: project, sessionId: checkpointSessionId, refreshToken: refreshToken) { openedCheckpoint = $0 }
        case .worktrees:
            GitWorktreesList(workbench: workbench, project: project)
        }
    }

    private var refreshButton: some View {
        Button { Task { await refresh() } } label: { Image(icon: "arrow.clockwise").font(.riffet(size: S(12))) }
            .buttonStyle(IconButtonStyle())
            .help("刷新")
            .disabled(busy)
    }

    /// One menu for the three views: a segmented control here would sit inside the inspector's segmented tabs.
    private var sectionBar: some View {
        HStack(spacing: Space.sm) {
            ChoiceMenu(options: pages.map { page in ChoiceOption(title: page.title, selected: page == section) { section = page } }) {
                HStack(spacing: Space.xs) {
                    Text(section.title).font(.riffet(size: S(13), weight: .semibold)).foregroundStyle(palette.fg)
                    Image(icon: "chevron.down").font(.riffet(size: S(9), weight: .semibold)).foregroundStyle(palette.fg4)
                }
                .padding(.horizontal, Space.sm)
                .frame(height: 28)
            }
            .accessibilityLabel("Git 视图")
            Spacer(minLength: 0)
            if section != .worktrees { refreshButton }
        }
        .padding(.leading, Space.sm)
        .padding(.trailing, Space.sm)
        .frame(height: InspectorMetrics.headerHeight)
    }

    private var changesPage: some View {
        VStack(spacing: 0) {
            if error == nil {
                PublishSection(workbench: workbench, project: project, git: git, sessionId: checkpointSessionId) { originProjectId, removed in
                    if removed {
                        // The copy is archived: the project it was cut from is where the work goes on.
                        workbench.showHome(projectId: originProjectId)
                    } else {
                        Task { await git.load(workbench.host.api, force: true) }
                    }
                }
                .id(project.id)
            }
            PanelRule()
            if let error {
                ContentUnavailableView("读不到 Git 状态", icon: "exclamationmark.triangle", description: Text(error))
            } else if let status, status.entries.isEmpty {
                if let actionError { GitInlineError(message: actionError) }
                ContentUnavailableView("工作区没有改动", icon: "checkmark.circle")
            } else if status == nil {
                Spinner(size: .regular).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                stageAllBar
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(status?.entries ?? [], id: \.path) { entry in
                            // The box sits over the row's leading inset, so it stages and the rest opens.
                            Button { open(entry) } label: { GitEntryRow(entry: entry, comments: review.count(for: entry.path)) }
                                .buttonStyle(HoverRowStyle())
                                .overlay(alignment: .leading) {
                                    StageBox(state: stageState(entry)) { Task { await stage([entry.path], gitUnstaged(entry: entry)) } }
                                        .disabled(busy)
                                        .padding(.leading, Space.sm)
                                }
                                .contextMenu { entryMenu(entry) }
                        }
                    }
                    .padding(Space.xs + 2)
                }
                if let actionError { GitInlineError(message: actionError) }
                ReviewBar(review: review, workbench: workbench, sessionId: checkpointSessionId)
                CommitBar(message: $commitMessage, stagedCount: git.stagedCount, busy: busy, commit: commit)
            }
        }
    }

    /// The list's own box: all staged unstages them all, anything less stages the rest.
    private var stageAllBar: some View {
        let entries = status?.entries ?? []
        let state: StageBox.State = git.unstagedCount == 0 ? .on : git.stagedCount == 0 ? .off : .mixed
        return HStack(spacing: Space.sm) {
            StageBox(state: state) { Task { await stage(entries.map(\.path), state != .on) } }
                .disabled(busy)
                .help(state == .on ? "取消暂存全部" : "暂存全部")
                .accessibilityLabel(state == .on ? "取消暂存全部" : "暂存全部")
            Text("已暂存 \(git.stagedCount) / \(entries.count)")
                .font(.riffet(size: S(11.5)))
                .foregroundStyle(palette.fg3)
                .monospacedDigit()
            Spacer(minLength: 0)
        }
        .padding(.leading, Space.xs + 2 + Space.sm)
        .padding(.trailing, Space.sm)
        .padding(.top, Space.sm)
    }

    private func stageState(_ entry: GitEntry) -> StageBox.State {
        switch (gitStaged(entry: entry), gitUnstaged(entry: entry)) {
        case (true, false): .on
        case (true, true): .mixed
        default: .off
        }
    }

    private func diffPage(_ entry: GitEntry) -> some View {
        VStack(spacing: 0) {
            DetailHeader(title: (entry.path as NSString).lastPathComponent, subtitle: (entry.path as NSString).deletingLastPathComponent, back: { selected = nil; diff = nil }) {
                let commented = review.count(for: entry.path)
                if commented > 0 { GitMetaBadge(text: String(localized: "\(commented) 条意见"), tint: palette.accent).fixedSize() }
                DiffCounts(added: entry.added?.int64Value, removed: entry.removed?.int64Value)
                if gitUnstaged(entry: entry) {
                    Button { Task { await stage([entry.path], true) } } label: { Image(icon: "plus").font(.riffet(size: S(12))) }
                        .buttonStyle(IconButtonStyle())
                        .help("暂存")
                        .disabled(busy)
                }
                if gitStaged(entry: entry) {
                    Button { Task { await stage([entry.path], false) } } label: { Image(icon: "minus").font(.riffet(size: S(12))) }
                        .buttonStyle(IconButtonStyle())
                        .help("取消暂存")
                        .disabled(busy)
                }
                if workbench.local {
                    Button { FileOpener.open(path: entry.path, line: nil, projectId: project.id, workbench: workbench) } label: { Image(icon: "arrow.up.forward.app").font(.riffet(size: S(12))) }
                        .buttonStyle(IconButtonStyle())
                        .help("在编辑器中打开")
                }
            }
            PanelRule()
            if let actionError { GitInlineError(message: actionError) }
            if let diff {
                if diff.binary {
                    ContentUnavailableView("二进制文件", icon: "doc")
                } else {
                    // A truncated preview would number lines that are not the file's.
                    let reviewable = diff.truncated?.boolValue != true
                    FullDiffView(before: diff.before, after: diff.after, marks: review.marks(for: entry.path), onPick: reviewable ? { line, extend, spec in
                        review.pick(path: entry.path, line: line, extend: extend) { reviewQuote(spec, from: $0, to: $1) }
                    } : nil)
                }
            } else {
                Spinner(size: .regular).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            if let diff {
                PanelRule()
                ReviewComposer(review: review, path: entry.path, pickable: !diff.binary && diff.truncated?.boolValue != true, truncated: diff.truncated?.boolValue == true)
            }
            ReviewBar(review: review, workbench: workbench, sessionId: checkpointSessionId)
        }
        .task(id: "\(entry.path)\u{1}\(entry.index)\u{1}\(entry.worktree)") {
            // Staging or a status refresh reloads the same file: its diff and the review composer stay
            // until the new diff replaces them. Another file starts from the spinner.
            if diffPath != entry.path { diff = nil }
            guard let api = workbench.host.api else { return }
            let stagedOnly = gitStaged(entry: entry) && entry.worktree == " "
            do {
                let loaded = try await api.gitDiff(projectId: project.id, path: entry.path, staged: stagedOnly)
                guard !Task.isCancelled else { return }
                diff = loaded
                diffPath = entry.path
            } catch {
                actionError = String(localized: "无法读取差异：\(error.riffetMessage)")
            }
        }
    }

    @ViewBuilder
    private func entryMenu(_ entry: GitEntry) -> some View {
        Button("查看差异") { open(entry) }
        if gitUnstaged(entry: entry) { Button("暂存") { Task { await stage([entry.path], true) } }.disabled(busy) }
        if gitStaged(entry: entry) { Button("取消暂存") { Task { await stage([entry.path], false) } }.disabled(busy) }
        Divider()
        if workbench.local { Button("在编辑器中打开") { FileOpener.open(path: entry.path, line: nil, projectId: project.id, workbench: workbench) } }
        Button("复制路径") { copyToPasteboard(entry.path) }
    }

    private func open(_ entry: GitEntry) {
        diff = nil
        actionError = nil
        selected = entry
    }

    private func refresh() async {
        switch section {
        case .changes:
            actionError = nil
            await git.load(workbench.host.api, force: true)
        case .checkpoints, .worktrees:
            refreshToken += 1
        }
    }

    private func stage(_ paths: [String], _ on: Bool) async {
        guard let api = workbench.host.api, !paths.isEmpty, !busy else { return }
        busy = true
        actionError = nil
        let targets = Set(paths)
        do {
            if on {
                try await api.stage(projectId: project.id, paths: paths)
            } else {
                try await api.unstage(projectId: project.id, paths: paths)
            }
        } catch {
            actionError = on ? String(localized: "无法暂存改动：\(error.riffetMessage)") : String(localized: "无法取消暂存：\(error.riffetMessage)")
        }
        await git.load(api, force: true)
        if actionError == nil, error == nil, let entries = status?.entries {
            if on {
                let still = entries.filter { targets.contains($0.path) && gitUnstaged(entry: $0) }
                if !still.isEmpty { actionError = String(localized: "服务器返回后仍有 \(still.count) 个文件未进入暂存区") }
            } else {
                let still = entries.filter { targets.contains($0.path) && gitStaged(entry: $0) }
                if !still.isEmpty { actionError = String(localized: "服务器返回后仍有 \(still.count) 个文件留在暂存区") }
            }
        }
        busy = false
    }

    private func commit(_ text: String, committed: () -> Void) async {
        guard let api = workbench.host.api, !text.isEmpty, git.stagedCount > 0, !busy else { return }
        busy = true
        actionError = nil
        do {
            try await api.commit(projectId: project.id, message: text)
            committed()
        } catch {
            actionError = String(localized: "无法创建提交：\(error.riffetMessage)")
        }
        await git.load(api, force: true)
        if actionError == nil, error == nil {
            let remaining = git.stagedCount
            if remaining > 0 { actionError = String(localized: "提交请求已返回，但暂存区仍有 \(remaining) 个文件；请刷新确认") }
        }
        busy = false
    }
}

/// The commit message and button. The message lives here, so typing redraws this bar and not the list.
private struct CommitBar: View {
    /// Owned by the panel: the bar comes and goes with the change list, the message being typed stays.
    @Binding var message: String
    let stagedCount: Int
    let busy: Bool
    let commit: (_ text: String, _ committed: () -> Void) async -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(spacing: 0) {
            PanelRule()
            // The button lives in the field, the way a message is sent: one quiet line until there is
            // something to commit, then the arrow fills in.
            HStack(spacing: Space.xs) {
                TextField(String(localized: "提交说明"), text: $message)
                    .textFieldStyle(.plain)
                    .font(.riffet(size: S(13)))
                    .onSubmit(submit)
                Button(action: submit) {
                    Image(icon: "arrow.up")
                        .font(.riffet(size: S(11), weight: .semibold))
                        .foregroundStyle(ready ? palette.primaryFg : palette.fg4)
                        .frame(width: 22, height: 22)
                        .background(Circle().fill(ready ? palette.primary : palette.bgMuted))
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .disabled(!ready)
                .help(stagedCount > 0 ? "提交 \(stagedCount) 个文件" : "提交")
                .accessibilityLabel(stagedCount > 0 ? "提交 \(stagedCount) 个文件" : "提交")
            }
            .padding(.leading, Space.sm + 2)
            .padding(.trailing, 4)
            .frame(height: 30)
            .background(palette.bgSubtle, in: RoundedRectangle(cornerRadius: Radius.control + 2, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.control + 2, style: .continuous).strokeBorder(palette.lineSoft))
            .padding(Space.md)
        }
    }

    private var ready: Bool { !message.trimmingCharacters(in: .whitespaces).isEmpty && stagedCount > 0 && !busy }

    private func submit() {
        guard ready else { return }
        let text = message.trimmingCharacters(in: .whitespaces)
        Task { await commit(text) { message = "" } }
    }
}

/// A project's git status, shared by the 变更 panel and the toolbar's ⋯ menu and kept after the panel
/// closes: what was read last shows at once while it is read again, loads that arrive together (the
/// panel opening, a turn ending) share one request, and a reading that changed nothing changes nothing.
@MainActor @Observable
final class GitStatusModel {
    private static let cacheLimit = 16
    private static var cache: [String: GitStatusModel] = [:]
    private static var recent: [String] = []

    static func model(for projectId: String) -> GitStatusModel {
        if let found = cache[projectId] {
            if recent.last != projectId {
                recent.removeAll { $0 == projectId }
                recent.append(projectId)
            }
            return found
        }
        let model = GitStatusModel(projectId: projectId)
        cache[projectId] = model
        recent.append(projectId)
        while recent.count > cacheLimit { cache[recent.removeFirst()] = nil }
        return model
    }

    let projectId: String
    private(set) var status: GitStatus?
    private(set) var error: String?
    /// Bumped by a load that brought a different status, or by a forced one; the branch's sync count follows it.
    private(set) var revision = 0
    private(set) var stagedCount = 0
    private(set) var unstagedCount = 0
    /// The branch row's last reading, shown while a reopened panel asks again.
    var branch: BranchInfo?
    var pullRequest: PullRequestInfo?
    var pullUnavailable: String?
    /// When the pull request was last asked about, and for which branch and upstream.
    @ObservationIgnored var pullChecked: (key: String, at: Date)?
    @ObservationIgnored private var inflight: Task<Void, Never>?
    @ObservationIgnored private var loadedAt: Date?

    private init(projectId: String) { self.projectId = projectId }

    /// Reads the status unless a reading is under way (joined instead) or one finished within `maxAge`
    /// seconds. `force` (an explicit refresh, after staging or committing) always reads afresh.
    func load(_ api: RiffetApi?, force: Bool = false, maxAge: TimeInterval = 2) async {
        guard let api else { return }
        if let inflight {
            await inflight.value
            if !force { return }
        }
        if !force, let loadedAt, Date.now.timeIntervalSince(loadedAt) < maxAge { return }
        let task = Task { await fetch(api, force: force) }
        inflight = task
        await task.value
        if inflight == task { inflight = nil }
    }

    private func fetch(_ api: RiffetApi, force: Bool) async {
        defer { loadedAt = .now }
        do {
            let next = try await api.gitStatus(projectId: projectId)
            if error != nil { error = nil }
            guard force || next != status else { return }
            status = next
            stagedCount = next.entries.filter { gitStaged(entry: $0) }.count
            unstagedCount = next.entries.filter { gitUnstaged(entry: $0) }.count
            revision += 1
        } catch {
            self.error = error.riffetMessage
        }
    }
}

struct GitEntryRow: View {
    let entry: GitEntry
    var comments = 0
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: Space.sm + 2) {
            // Room for the stage box laid over the row.
            Color.clear.frame(width: StageBox.size)
            VStack(alignment: .leading, spacing: 1) {
                Text((entry.path as NSString).lastPathComponent)
                    .font(.riffet(size: S(13)))
                    .foregroundStyle(palette.fg)
                    .lineLimit(1)
                let directory = (entry.path as NSString).deletingLastPathComponent
                if !directory.isEmpty {
                    Text(directory).font(.riffet(size: S(11))).foregroundStyle(palette.fg4).lineLimit(1).truncationMode(.head)
                }
            }
            Spacer(minLength: Space.sm)
            DiffCounts(added: entry.added?.int64Value, removed: entry.removed?.int64Value)
            if comments > 0 {
                Image(icon: "text.bubble").font(.riffet(size: S(11))).foregroundStyle(palette.fg3).help("\(comments) 条审阅意见")
            }
            StatusLetter(code: entry.index + entry.worktree)
        }
        .padding(.horizontal, Space.sm)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// `M`, `A`, `D`, `R` or `U` (untracked), quiet at the row's end the way Xcode marks a file: the
/// diff counts beside it already carry the colour.
struct StatusLetter: View {
    let code: String
    @Environment(\.palette) private var palette

    var body: some View {
        let letter = code.contains("?") ? "U" : String(code.trimmingCharacters(in: .whitespaces).prefix(1)).ifEmpty("M")
        Text(letter)
            .font(.riffet(size: S(11), weight: .medium, design: .monospaced))
            .foregroundStyle(letter == "D" ? palette.danger : palette.fg4)
            .frame(width: 12)
            .help(help(letter))
    }

    private func help(_ letter: String) -> String {
        switch letter {
        case "A": String(localized: "新增")
        case "U": String(localized: "未跟踪")
        case "D": String(localized: "已删除")
        case "R": String(localized: "已重命名")
        case "C": String(localized: "已复制")
        default: String(localized: "已修改")
        }
    }
}

/// Whether a file (or the whole list) is staged, as a box in ink rather than the accent: the
/// checked state is the content's, not a system selection.
struct StageBox: View {
    enum State { case off, on, mixed }
    static let size: CGFloat = 16
    let state: State
    let action: () -> Void
    @Environment(\.palette) private var palette
    @Environment(\.isEnabled) private var enabled

    var body: some View {
        Button(action: action) {
            Image(icon: state == .on ? "checkmark.square.fill" : state == .mixed ? "minus.square.fill" : "square")
                .font(.riffet(size: S(14)))
                .foregroundStyle(state == .off ? palette.fg4 : palette.fg2)
                .frame(width: Self.size, height: Self.size)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .opacity(enabled ? 1 : 0.5)
        .help(state == .on ? "取消暂存" : "暂存")
        .accessibilityLabel(state == .on ? "取消暂存" : "暂存")
        .accessibilityValue(state == .on ? "已暂存" : state == .mixed ? "部分暂存" : "未暂存")
    }
}

struct DiffCounts: View {
    let added: Int64?
    let removed: Int64?
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 5) {
            if let added, added > 0 { Text("+\(added.formatted())").foregroundStyle(palette.success) }
            if let removed, removed > 0 { Text("−\(removed.formatted())").foregroundStyle(palette.danger) }
        }
        .font(.riffet(size: S(11), design: .monospaced))
        .lineLimit(1)
        .fixedSize()
    }
}

/// A whole-file diff filling its container, with the transcript's diff drawing: lines are diffed
/// and measured off the main thread, and only the lines on screen are drawn.
struct FullDiffView: View {
    let before: String
    let after: String
    /// Remarks on the new file's lines: the lines carrying one and the pick being written about.
    var marks = ReviewMarks()
    /// A click on a line number (new-file line, shift held, the diff it belongs to). Nil: no remarks.
    var onPick: ((Int, Bool, DiffSpec) -> Void)?
    @State private var spec: DiffSpec?
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Group {
            if let spec {
                DiffDocument(spec: spec, dark: colorScheme == .dark, marks: marks, onPick: onPick)
            } else {
                Spinner(size: .regular).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: "\(before.hashValue)|\(after.hashValue)|\(colorScheme == .dark)") {
            spec = nil
            let style = TranscriptStyle.current(dark: colorScheme == .dark)
            let before = before, after = after
            let work = Task.detached(priority: .userInitiated) {
                let diff = lineDiff(before: before, after: after, context: 3, lineOffset: 0, trailingLines: 0)
                return RowBuilder.diffSpec(RowBuilder.diffLines(diff, before: before, after: after), style: style)
            }
            let result = await withTaskCancellationHandler { await work.value } onCancel: { work.cancel() }
            // Another file may have been opened while this one was diffed.
            guard !Task.isCancelled else { return }
            spec = result
        }
    }
}

private struct DiffDocument: NSViewRepresentable {
    let spec: DiffSpec
    let dark: Bool
    let marks: ReviewMarks
    let onPick: ((Int, Bool, DiffSpec) -> Void)?

    final class Host: FragmentHost {
        var style: TranscriptStyle
        init(style: TranscriptStyle) { self.style = style }
        func perform(_ action: TranscriptAction) {}
        var rowMessage: String? { nil }
        func messageMenu(selection: String?, in view: TextLayoutView?) -> NSMenu? { nil }
    }

    /// The diff's lines with the remark overlay on top; both fill the scrolled canvas.
    final class Scroller: NSScrollView {
        let canvas = FlippedView()
        let lines = DiffView.DiffLines()
        let overlay = ReviewGutterOverlay()

        override func tile() {
            super.tile()
            guard let spec = lines.spec else { return }
            let size = NSSize(width: max(contentView.bounds.width, spec.contentWidth), height: CGFloat(spec.lines.count) * spec.lineHeight + 8)
            if canvas.frame.size != size {
                canvas.setFrameSize(size)
                lines.frame = NSRect(origin: .zero, size: size)
                overlay.frame = NSRect(origin: .zero, size: size)
            }
        }
    }

    func makeCoordinator() -> Host { Host(style: TranscriptStyle.current(dark: dark)) }

    func makeNSView(context: Context) -> Scroller {
        let scroller = Scroller()
        scroller.hasVerticalScroller = true
        scroller.hasHorizontalScroller = true
        scroller.autohidesScrollers = true
        scroller.drawsBackground = false
        scroller.contentView = FlippedClip()
        scroller.canvas.addSubview(scroller.lines)
        scroller.canvas.addSubview(scroller.overlay)
        scroller.documentView = scroller.canvas
        return scroller
    }

    func updateNSView(_ scroller: Scroller, context: Context) {
        let style = TranscriptStyle.current(dark: dark)
        context.coordinator.style = style
        scroller.lines.host = context.coordinator
        scroller.lines.spec = spec
        scroller.lines.needsDisplay = true
        let overlay = scroller.overlay
        overlay.spec = spec
        overlay.commentedTint = style.color(\.accent, 0.1)
        overlay.selectedTint = style.color(\.accent, 0.22)
        overlay.barTint = style.color(\.accent)
        overlay.onPick = onPick.map { pick in { (line: Int, extend: Bool) in pick(line, extend, spec) } }
        if overlay.marks != marks { overlay.marks = marks }
        scroller.tile()
        // The lines behind the overlay may have changed without the canvas changing size.
        overlay.needsDisplay = true
    }
}

// MARK: Shared git chrome

struct GitField: View {
    let placeholder: String
    @Binding var text: String
    var onSubmit: () -> Void = {}
    @Environment(\.palette) private var palette

    var body: some View {
        TextField(placeholder, text: $text)
            .textFieldStyle(.plain)
            .font(.riffet(size: S(13)))
            .padding(.horizontal, Space.sm + 2)
            .frame(height: 28)
            .background(palette.bgSubtle, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(palette.lineSoft))
            .onSubmit(onSubmit)
    }
}

struct GitInlineError: View {
    let message: String
    var summary: String?
    @Environment(\.palette) private var palette

    var body: some View {
        Group {
            if let summary {
                DisclosureGroup {
                    ScrollView {
                        Text(message)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxHeight: 180)
                } label: {
                    Text(summary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else {
                Text(message)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .font(.riffet(size: S(12)))
        .foregroundStyle(palette.danger)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Space.md)
        .padding(.vertical, Space.sm)
        .background(palette.danger.opacity(0.08))
    }
}

struct GitMetaBadge: View {
    let text: String
    var tint: Color

    var body: some View {
        Text(text)
            .font(.riffet(size: S(10), weight: .semibold, design: .monospaced))
            .foregroundStyle(tint)
            .lineLimit(1)
            .truncationMode(.tail)
            .padding(.horizontal, 5)
            .frame(height: 18)
            .background(tint.opacity(0.14), in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
    }
}

func worktreeBranchLabel(_ branch: String?) -> String {
    guard let branch else { return String(localized: "分离 HEAD") }
    let name = branch.hasPrefix("refs/heads/") ? String(branch.dropFirst("refs/heads/".count)) : branch
    return name.trimmingCharacters(in: .whitespaces).isEmpty ? String(localized: "分离 HEAD") : name
}

func trimTrailingSlash(_ path: String) -> String {
    var value = path
    while value.count > 1, value.hasSuffix("/") { value.removeLast() }
    return value
}

func gitChangeLabel(_ kind: CheckpointChangeKind) -> String {
    switch kind {
    case .added: String(localized: "新增")
    case .modified: String(localized: "修改")
    case .deleted: String(localized: "删除")
    }
}

func gitChangeTint(_ kind: CheckpointChangeKind, _ palette: Palette) -> Color {
    switch kind {
    case .added: palette.success
    case .deleted: palette.danger
    case .modified: palette.warning
    }
}

func shortHash(_ value: String?) -> String {
    guard let value, !value.isEmpty else { return "—" }
    return String(value.prefix(12))
}

func riffetHTTP(_ error: Error) -> RiffetHttpException? {
    (error as NSError).userInfo["KotlinException"] as? RiffetHttpException
}
