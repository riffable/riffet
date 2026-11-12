import SwiftUI
import RiffetKit

/// Scheduled work (`TasksPage.tsx`): a quick bar to say what and when, then what runs next, what is
/// run by hand, what is paused and how the latest runs went. The full editor is one click away.
struct TasksPage: View {
    let workbench: Workbench
    /// Kept by the workbench: a later visit shows the last lists while they are read again.
    private let model: TasksModel
    @State private var sheet: TasksSheet?
    @State private var deletion: Automation?
    @State private var quick = QuickDraft()
    @State private var noticeDismissal = UUID()
    @Environment(\.palette) private var palette

    init(workbench: Workbench) {
        self.workbench = workbench
        model = workbench.pageModels.tasks
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.xl) {
                    FeedbackRegion(value: model.notice, active: sheet == nil && deletion == nil) { notice, live in
                        TasksNoticeBar(notice: notice, workbench: workbench, live: live) {
                            if model.notice?.id == notice.id { model.dismissNotice() }
                            noticeDismissal = UUID()
                        }
                    }
                    .id("\(workbench.baseURL.absoluteString)|\(noticeDismissal)")
                    content
                }
                .padding(.horizontal, Space.lg)
                .padding(.top, Space.lg)
                .padding(.bottom, Space.xxl)
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .navigationTitle(WorkbenchPage.tasks.title)
        .pageChrome(.tasks, workbench: workbench) {
            PageActionButton(title: String(localized: "新建定时任务"), symbol: "plus") { sheet = .new(nil) }
                .disabled(model.automations == nil)
        }
        .onDisappear { model.dismissNotice() }
        // The next and last runs move on their own while the page is open.
        .task {
            while !Task.isCancelled {
                await model.load()
                try? await Task.sleep(for: .seconds(30))
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            Task { await model.load() }
        }
        .sheet(item: $sheet) { sheet in
            switch sheet {
            case .new(let draft):
                AutomationEditorSheet(workbench: workbench, prefill: draft) { model.reload() }
            case .edit(let automation):
                AutomationEditorSheet(workbench: workbench, automation: automation) { model.reload() }
            }
        }
        .confirmationDialog(
            deletion.map { String(localized: "删除定时任务「\($0.name)」？") } ?? "",
            isPresented: Binding(get: { deletion != nil }, set: { if !$0 { deletion = nil } }),
            titleVisibility: .visible
        ) {
            Button("删除", role: .destructive) {
                guard let target = deletion else { return }
                deletion = nil
                Task { await model.delete(target) }
            }
            Button("取消", role: .cancel) { deletion = nil }
        } message: {
            Text("已经运行出的会话会保留。")
        }
    }

    // MARK: Content

    @ViewBuilder
    private var content: some View {
        if let automations = model.automations {
            QuickCreateBar(workbench: workbench, model: model, draft: $quick) { sheet = .new($0) }
            if automations.isEmpty {
                examples
            } else {
                group(String(localized: "即将运行"), model.upcoming) { automation in row(automation, kind: .upcoming) }
                group(String(localized: "手动"), model.manual) { automation in row(automation, kind: .manual) }
                group(String(localized: "已暂停"), model.paused) { automation in row(automation, kind: .paused) }
            }
            if !model.runs.isEmpty { recentRuns }
        } else if let error = model.loadError {
            VStack(spacing: Space.md) {
                Text(error).font(.riffet(size: S(13))).foregroundStyle(palette.fg2).multilineTextAlignment(.center)
                Button("重试") { model.retry() }.buttonStyle(SolidButtonStyle())
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 80)
        } else {
            Spinner().frame(maxWidth: .infinity).padding(.top, 120)
        }
    }

    private var examples: some View {
        list {
            ForEach(Array(Self.examples.enumerated()), id: \.offset) { index, example in
                Button {
                    quick.text = example.prompt
                    quick.when = example.when
                } label: {
                    HStack(spacing: Space.md) {
                        Text(example.prompt).font(.riffet(size: S(13))).foregroundStyle(palette.fg2).lineLimit(1)
                        Spacer(minLength: Space.sm)
                        Text(example.when.label).font(.riffet(size: S(12))).foregroundStyle(palette.fg3).monospacedDigit()
                    }
                    .padding(.horizontal, Space.lg)
                    .padding(.vertical, Space.md)
                    .contentShape(Rectangle())
                }
                .buttonStyle(HoverRowStyle(radius: 0))
                if index < Self.examples.count - 1 { divider }
            }
        }
    }

    private static let examples: [(prompt: String, when: TimePreset)] = [
        (String(localized: "总结昨天的提交"), .weekdays),
        (String(localized: "检查依赖更新"), .monday),
        (String(localized: "跑一遍测试并汇报失败"), TimePreset(label: String(localized: "每天 22:00"), cron: "0 22 * * *")),
    ]

    private func group(_ title: String, _ items: [Automation], @ViewBuilder row: @escaping (Automation) -> some View) -> some View {
        Group {
            if !items.isEmpty {
                VStack(alignment: .leading, spacing: Space.xs) {
                    sectionHeader(title)
                    list {
                        ForEach(items, id: \.id) { automation in
                            row(automation)
                            if automation.id != items.last?.id { divider }
                        }
                    }
                }
            }
        }
    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title)
            .font(.riffet(size: S(11.5), weight: .semibold))
            .foregroundStyle(palette.fg3)
            .padding(.leading, Space.xs)
    }

    /// The rows of one section in a hairline-bordered card.
    private func list<Rows: View>(@ViewBuilder _ rows: () -> Rows) -> some View {
        VStack(spacing: 0) { rows() }
            .background(palette.bgElevated, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(palette.line))
    }

    private var divider: some View {
        Rectangle().fill(palette.lineSoft).frame(height: 1)
    }

    // MARK: Rows

    private func row(_ automation: Automation, kind: AutomationRow.Kind) -> AutomationRow {
        let followUp = automation.followUp
        let enabled = model.enabled(automation)
        return AutomationRow(
            title: followUp == nil ? automation.name : TasksModel.name(of: automation.prompt),
            detail: detail(automation, kind: kind),
            trailing: trailing(automation, enabled: enabled),
            last: followUp == nil ? formatDateTime(value: automation.lastRunAt) : nil,
            kind: kind,
            isFollowUp: followUp != nil,
            enabled: enabled,
            toggling: model.toggling.contains(automation.id),
            busy: model.running == automation.id,
            disabled: model.running != nil,
            setEnabled: { value in Task { await model.setEnabled(automation, value) } },
            runEntries: { runEntries(automation) },
            runDirect: { Task { await model.run(automation) } },
            openSession: openAction(automation),
            edit: { sheet = .edit(automation) },
            remove: {
                if followUp != nil { Task { await model.delete(automation) } } else { deletion = automation }
            }
        )
    }

    private func openAction(_ automation: Automation) -> (() -> Void)? {
        guard let id = automation.followUp?.sessionId ?? automation.lastSessionId else { return nil }
        return { workbench.open(sessionId: id) }
    }

    private func detail(_ automation: Automation, kind: AutomationRow.Kind) -> String {
        if let followUp = automation.followUp {
            if let title = workbench.list.sessions.first(where: { $0.id == followUp.sessionId })?.title, !title.isEmpty { return title }
            return followUp.by == "agent" ? String(localized: "Agent 唤醒") : String(localized: "稍后发送")
        }
        let agent = agentLabel(automation)
        if kind == .manual {
            let first = automation.prompt.split(separator: "\n", omittingEmptySubsequences: true).first.map(String.init) ?? ""
            return "\(agent) · \(first)"
        }
        var parts: [String] = []
        if let trigger = automation.triggers.first { parts.append(describe(trigger)) }
        parts.append(automation.projectId.map { workbench.project($0)?.name ?? String(localized: "已移除的项目") } ?? String(localized: "运行时选择"))
        parts.append(agent)
        if automation.delivery == "same" { parts.append(String(localized: "同一会话")) }
        return parts.joined(separator: " · ")
    }

    private func describe(_ trigger: AutomationTrigger) -> String {
        switch trigger.kind {
        case "once": return formatDateTime(value: trigger.at) ?? ""
        case "cron": return describeCron(trigger.cron ?? "")
        default: return trigger.kind
        }
    }

    private func trailing(_ automation: Automation, enabled: Bool) -> String? {
        if let next = automation.nextRunAt, enabled { return formatDateTime(value: next).map { String(localized: "下次 \($0)") } }
        if enabled, !automation.triggers.isEmpty { return String(localized: "已结束") }
        return nil
    }

    private func agentLabel(_ automation: Automation) -> String {
        guard let id = automation.target.agent else { return String(localized: "默认 Agent") }
        let name = workbench.backends.first { $0.agent == id }?.label ?? backendLabel(id)
        guard let model = automation.model, !model.isEmpty else { return name }
        return "\(name) · \(model.split(separator: "[").first.map(String.init) ?? model)"
    }

    /// The project menu of a task with none of its own, or nothing to ask when it has one (nil).
    private func runEntries(_ automation: Automation) -> [NativeMenuEntry]? {
        guard automation.projectId == nil else { return nil }
        let title = String(localized: "在哪个项目运行「\(automation.name)」？")
        guard !workbench.projects.isEmpty else { return [.header(title), .item(String(localized: "还没有项目"), enabled: false) {}] }
        return projectMenuEntries(workbench.projects, selected: workbench.currentProjectId, title: title) { project in
            Task { await model.run(automation, projectId: project.id) }
        }
    }

    // MARK: Recent runs

    private var recentRuns: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            sectionHeader(String(localized: "最近运行"))
            list {
                ForEach(model.runs, id: \.id) { run in
                    RunRow(
                        name: model.automation(run.automationId).map { $0.followUp == nil ? $0.name : TasksModel.name(of: $0.prompt) } ?? String(localized: "已删除的任务"),
                        run: run,
                        open: run.sessionId.map { id in { workbench.open(sessionId: id) } }
                    )
                    if run.id != model.runs.last?.id { divider }
                }
            }
        }
    }
}

/// What the quick bar holds while the page is open.
private struct QuickDraft {
    var text = ""
    var when: TimePreset?
    var projectId: String?
    var choice = LaunchChoice()
}

private enum TasksSheet: Identifiable {
    case new(AutomationDraft?)
    case edit(Automation)

    var id: String {
        switch self {
        case .new: "new"
        case .edit(let automation): automation.id
        }
    }
}

/// Say what and when in one line: the text, a time, a project and an Agent, then send.
private struct QuickCreateBar: View {
    let workbench: Workbench
    let model: TasksModel
    @Binding var draft: QuickDraft
    /// Opens the full editor with what is typed so far.
    let custom: (AutomationDraft) -> Void
    @Environment(\.palette) private var palette

    private var prompt: String { draft.text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var projectId: String? { draft.projectId ?? workbench.currentProjectId ?? workbench.projects.first?.id }
    private var project: Project? { workbench.project(projectId) }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            PromptEditor(text: $draft.text, placeholder: String(localized: "要做什么…"), minHeight: 44)
            HStack(spacing: Space.sm) {
                NativeChipMenu(text: draft.when?.label ?? String(localized: "时间"), symbol: "clock") { timeEntries }
                NativeChipMenu(text: project.map { $0.worktree?.branch ?? $0.name } ?? String(localized: "项目"), symbol: project?.worktree == nil ? "folder" : "arrow.triangle.branch") {
                    projectMenuEntries(workbench.projects, selected: projectId, title: String(localized: "在哪个项目运行？")) { draft.projectId = $0.id }
                }
                LaunchTargetPicker(workbench: workbench, choice: $draft.choice, projectId: projectId, compact: true)
                Spacer(minLength: Space.sm)
                Button(action: send) {
                    if model.running == "create" { Spinner(size: .mini) } else { Image(icon: "arrow.up") }
                }
                .buttonStyle(SolidButtonStyle(kind: .primary))
                .disabled(prompt.isEmpty || draft.when == nil || projectId == nil || model.running != nil)
                .keyboardShortcut(.return, modifiers: .command)
                .help("创建 (⌘↩)")
                .accessibilityLabel("创建")
            }
        }
        .padding(Space.md)
        .background(palette.bgElevated, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(palette.line))
    }

    private var timeEntries: [NativeMenuEntry] {
        var entries: [NativeMenuEntry] = TimePreset.all.map { preset in
            .item(preset.label, checked: draft.when?.id == preset.id) { draft.when = preset }
        }
        entries.append(.separator)
        entries.append(.item(String(localized: "自定义…")) {
            custom(AutomationDraft(prompt: draft.text, target: draft.choice, projectId: projectId, trigger: draft.when?.trigger()))
        })
        return entries
    }

    private func send() {
        guard let when = draft.when, let projectId, !prompt.isEmpty else { return }
        let target = draft.choice.target
        Task {
            if await model.create(prompt: prompt, when: when, projectId: projectId, target: target) {
                draft.text = ""
                draft.when = nil
            }
        }
    }
}

// MARK: - Rows

private struct AutomationRow: View {
    enum Kind { case upcoming, manual, paused }

    let title: String
    let detail: String
    let trailing: String?
    let last: String?
    let kind: Kind
    let isFollowUp: Bool
    let enabled: Bool
    let toggling: Bool
    let busy: Bool
    let disabled: Bool
    let setEnabled: (Bool) -> Void
    /// The project menu of a task with none; nil when it runs straight away.
    let runEntries: () -> [NativeMenuEntry]?
    let runDirect: () -> Void
    let openSession: (() -> Void)?
    let edit: () -> Void
    let remove: () -> Void
    @Environment(\.palette) private var palette
    @State private var runAnchor = MenuAnchor()

    var body: some View {
        HStack(spacing: Space.md) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.riffet(size: S(13), weight: .medium)).foregroundStyle(palette.fg).lineLimit(1)
                Text(detail).font(.riffet(size: S(12))).foregroundStyle(palette.fg3).lineLimit(1)
            }
            .opacity(kind == .paused ? 0.55 : 1)
            Spacer(minLength: Space.sm)
            if trailing != nil || last != nil {
                VStack(alignment: .trailing, spacing: 3) {
                    if let trailing { Text(trailing).font(.riffet(size: S(12))).foregroundStyle(palette.fg3) }
                    if let last { Text("上次 \(last)").font(.riffet(size: S(11))).foregroundStyle(palette.fg4) }
                }
                .monospacedDigit()
                .lineLimit(1)
                .opacity(kind == .paused ? 0.55 : 1)
                .layoutPriority(-1)
            }
            if kind == .manual {
                Button(action: runNow) {
                    if busy { Spinner(size: .mini) } else { Image(icon: "play.fill").font(.riffet(size: S(9.5))) }
                }
                .buttonStyle(SolidButtonStyle())
                .background(MenuAnchorView(anchor: runAnchor))
                .disabled(disabled)
                .help("运行")
                .accessibilityLabel("运行")
            } else if !isFollowUp {
                Toggle(enabled ? "暂停" : "启用", isOn: Binding(get: { enabled }, set: setEnabled))
                    .labelsHidden()
                    .toggleStyle(.switch)
                    .controlSize(.small)
                    .disabled(toggling)
            }
            RowMenu(label: String(localized: "\(title) 的操作")) { entries }
                .overlay { if busy && kind != .manual { Spinner(size: .mini) } }
        }
        .padding(.horizontal, Space.lg)
        .padding(.vertical, Space.md)
    }

    private func runNow() {
        if let entries = runEntries() { runAnchor.popUp(entries: entries) } else { runDirect() }
    }

    private var entries: [NativeMenuEntry] {
        var entries: [NativeMenuEntry] = []
        if isFollowUp {
            if let openSession { entries.append(.item(String(localized: "打开会话"), symbol: "arrow.right", action: openSession)) }
            entries.append(.item(String(localized: "取消"), symbol: "xmark", action: remove))
            return entries
        }
        if kind != .manual { entries.append(.item(String(localized: "立即运行"), symbol: "play", enabled: !disabled, action: runNow)) }
        if let openSession { entries.append(.item(String(localized: "打开上次的会话"), symbol: "arrow.right", action: openSession)) }
        entries.append(.item(String(localized: "编辑"), symbol: "pencil", action: edit))
        entries.append(.separator)
        entries.append(.item(String(localized: "删除…"), symbol: "trash", action: remove))
        return entries
    }
}

private struct RunRow: View {
    let name: String
    let run: AutomationRun
    let open: (() -> Void)?
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: Space.md) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: Space.sm) {
                    Text(name).font(.riffet(size: S(13), weight: .medium)).foregroundStyle(palette.fg).lineLimit(1)
                    badge
                }
                if let reason = TasksModel.reason(run) {
                    Text(reason).font(.riffet(size: S(12))).foregroundStyle(palette.fg3).lineLimit(1).help(reason)
                }
            }
            Spacer(minLength: Space.sm)
            if let at = formatDateTime(value: run.at) {
                Text(at).font(.riffet(size: S(12))).foregroundStyle(palette.fg3).monospacedDigit().lineLimit(1).layoutPriority(-1)
            }
            if let open { Button("打开", action: open).buttonStyle(ChipButtonStyle()) }
        }
        .padding(.horizontal, Space.lg)
        .padding(.vertical, Space.md)
    }

    @ViewBuilder
    private var badge: some View {
        let style = Self.badge(run.result, palette: palette)
        Text(style.label)
            .font(.riffet(size: S(10.5), weight: .medium))
            .foregroundStyle(style.foreground)
            .padding(.horizontal, 6)
            .padding(.vertical, 1.5)
            .background(style.background, in: Capsule())
    }

    private static func badge(_ result: String, palette: Palette) -> (label: String, foreground: Color, background: Color) {
        switch result {
        case "started": (String(localized: "已运行"), palette.success, palette.successSoft)
        case "skipped": (String(localized: "已跳过"), palette.fg3, palette.bgMuted)
        case "missed": (String(localized: "已错过"), palette.warning, palette.warningSoft)
        case "failed": (String(localized: "失败"), palette.danger, palette.dangerSoft)
        default: (result, palette.fg3, palette.bgMuted)
        }
    }
}

/// The ellipsis button of a row; its menu is built when it opens.
private struct RowMenu: View {
    let label: String
    let entries: () -> [NativeMenuEntry]
    @State private var anchor = MenuAnchor()

    init(label: String, entries: @escaping () -> [NativeMenuEntry]) {
        self.label = label
        self.entries = entries
    }

    var body: some View {
        Button { anchor.popUp(entries: entries()) } label: { Image(icon: "ellipsis") }
            .buttonStyle(IconButtonStyle())
            .background(MenuAnchorView(anchor: anchor))
            .help(label)
            .accessibilityLabel(label)
    }
}

private struct TasksNoticeBar: View {
    let notice: TasksNotice
    let workbench: Workbench
    var live = true
    let dismiss: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: Space.sm) {
            Image(icon: notice.isError ? "xmark.octagon" : "checkmark.circle")
                .foregroundStyle(!live ? palette.fg3 : notice.isError ? palette.danger : palette.success)
            Text(notice.text).font(.riffet(size: S(12.5))).foregroundStyle(palette.fg2).lineLimit(3).textSelection(.enabled)
            Spacer(minLength: Space.sm)
            if live, let id = notice.sessionId {
                Button("打开") {
                    guard workbench.pageModels.tasks.notice?.id == notice.id else { return }
                    workbench.open(sessionId: id)
                }.buttonStyle(ChipButtonStyle())
            }
            Button(action: dismiss) { Image(icon: "xmark").font(.riffet(size: S(10.5), weight: .semibold)) }
                .buttonStyle(IconButtonStyle(size: 22))
                .help("关闭")
        }
        .padding(.horizontal, Space.md)
        .padding(.vertical, Space.sm)
        .background(palette.bgSubtle, in: RoundedRectangle(cornerRadius: Radius.container, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.container, style: .continuous).strokeBorder(palette.lineSoft))
    }
}
