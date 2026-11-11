import SwiftUI
import RiffetKit

/// Reusable tasks and the schedules that run them (`TasksPage.tsx`): a task is written once, often
/// saved from a conversation that went well, then run by hand in any project or left on a schedule.
/// Schedules come first because they are what keeps happening without anyone looking.
struct TasksPage: View {
    let workbench: Workbench
    /// Kept by the workbench: a later visit shows the last lists while they are read again.
    private let model: TasksModel
    @State private var sheet: TasksSheet?
    @State private var deletion: TasksDeletion?
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
            PageMenuButton(symbol: "plus", help: String(localized: "新建定时任务或任务模板")) {
                NSMenu.choices([
                    ChoiceOption(title: String(localized: "新建定时任务"), selected: false) { sheet = .newSchedule(templateId: nil) },
                    ChoiceOption(title: String(localized: "新建任务模板"), selected: false) { sheet = .newTemplate },
                ])
            }
            .disabled(model.templates == nil)
        }
        .onDisappear { model.dismissNotice() }
        // The next and last runs move on their own while the page is open.
        .task {
            while !Task.isCancelled {
                await model.load()
                try? await Task.sleep(for: .seconds(60))
            }
        }
        .sheet(item: $sheet) { sheet in
            switch sheet {
            case .newTemplate:
                TemplateEditorSheet(workbench: workbench, projectId: workbench.currentProjectId) { _ in model.reload() }
            case .editTemplate(let template):
                TemplateEditorSheet(workbench: workbench, template: template, projectId: workbench.currentProjectId) { _ in model.reload() }
            case .newSchedule(let templateId):
                ScheduleEditorSheet(workbench: workbench, templates: model.templates ?? [], templateId: templateId) { model.reload() }
            case .editSchedule(let schedule):
                ScheduleEditorSheet(workbench: workbench, schedule: schedule, templates: model.templates ?? []) { model.reload() }
            }
        }
        .confirmationDialog(deletion?.title ?? "", isPresented: Binding(get: { deletion != nil }, set: { if !$0 { deletion = nil } }), titleVisibility: .visible) {
            Button("删除", role: .destructive) {
                guard let target = deletion else { return }
                deletion = nil
                Task {
                    switch target {
                    case .template(let template): await model.delete(template)
                    case .schedule(let schedule): await model.delete(schedule)
                    }
                }
            }
            Button("取消", role: .cancel) { deletion = nil }
        } message: {
            if let message = deletion?.message { Text(message) }
        }
    }

    // MARK: Content

    @ViewBuilder
    private var content: some View {
        if let templates = model.templates, let schedules = model.schedules {
            if templates.isEmpty {
                emptyState
            } else {
                schedulesSection(schedules)
                templatesSection(templates)
            }
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

    private var emptyState: some View {
        VStack(spacing: Space.md) {
            Image(icon: "calendar.badge.clock").font(.riffet(size: S(28))).foregroundStyle(palette.fg4)
            Text("把常做的事存成任务").font(.riffet(size: S(15), weight: .semibold)).foregroundStyle(palette.fg)
            Button { sheet = .newTemplate } label: {
                HStack(spacing: 5) { Image(icon: "plus"); Text("新建任务模板") }
            }
            .buttonStyle(SolidButtonStyle(kind: .primary))
            .padding(.top, Space.xs)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 96)
    }

    private func schedulesSection(_ schedules: [Schedule]) -> some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            sectionHeader(String(localized: "定时任务"))
            if schedules.isEmpty {
                Button { sheet = .newSchedule(templateId: nil) } label: {
                    HStack(spacing: Space.sm) {
                        Image(icon: "calendar.badge.clock")
                        Text("让一个模板按计划自动运行")
                    }
                    .font(.riffet(size: S(13)))
                    .foregroundStyle(palette.fg3)
                    .frame(maxWidth: .infinity)
                    .frame(height: 64)
                    .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(palette.line, style: StrokeStyle(lineWidth: 1, dash: [5, 4])))
                }
                .buttonStyle(HoverRowStyle(radius: 12))
            } else {
                list {
                    ForEach(schedules, id: \.id) { schedule in
                        ScheduleRow(
                            schedule: schedule,
                            enabled: model.enabled(schedule),
                            toggling: model.toggling.contains(schedule.id),
                            running: model.running != nil,
                            runningThis: model.running == schedule.id,
                            projectName: workbench.project(schedule.projectId)?.name ?? String(localized: "已移除的项目"),
                            templateName: model.template(schedule.templateId)?.name,
                            setEnabled: { enabled in Task { await model.setEnabled(schedule, enabled) } },
                            runNow: { Task { await model.run(schedule) } },
                            openLast: { if let id = schedule.lastSessionId { workbench.open(sessionId: id) } },
                            hasLastSession: { schedule.lastSessionId != nil && workbench.list.sessions.contains { $0.id == schedule.lastSessionId } },
                            edit: { sheet = .editSchedule(schedule) },
                            remove: { deletion = .schedule(schedule) }
                        )
                        if schedule.id != schedules.last?.id { divider }
                    }
                }
            }
            Text("按本机时间运行；Riffet 需保持开启，重叠运行会跳过，错过超过一小时不补跑。")
                .font(.riffet(size: S(11.5)))
                .foregroundStyle(palette.fg4)
                .padding(.top, Space.xs)
                .padding(.horizontal, Space.xs)
        }
    }

    private func templatesSection(_ templates: [TaskTemplate]) -> some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            sectionHeader(String(localized: "任务模板"))
            list {
                ForEach(templates, id: \.id) { template in
                    TemplateRow(
                        template: template,
                        agent: agentLabel(template),
                        busy: model.running == template.id,
                        disabled: model.running != nil,
                        runEntries: { runEntries(template) },
                        schedule: { sheet = .newSchedule(templateId: template.id) },
                        edit: { sheet = .editTemplate(template) },
                        remove: { deletion = .template(template) }
                    )
                    if template.id != templates.last?.id { divider }
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

    private func agentLabel(_ template: TaskTemplate) -> String {
        guard let id = template.target.agent else { return String(localized: "默认 Agent") }
        let name = workbench.backends.first { $0.agent == id }?.label ?? backendLabel(id)
        guard let model = template.model, !model.isEmpty else { return name }
        return "\(name) · \(model.split(separator: "[").first.map(String.init) ?? model)"
    }

    /// Where a template runs is chosen as it is run: the project menu, then straight to the new conversation.
    private func runEntries(_ template: TaskTemplate) -> [NativeMenuEntry] {
        let title = String(localized: "在哪个项目运行「\(template.name)」？")
        let projects = workbench.projects
        guard !projects.isEmpty else { return [.header(title), .item(String(localized: "还没有项目"), enabled: false) {}] }
        return projectMenuEntries(projects, selected: workbench.currentProjectId, title: title) { project in
            Task { await model.run(template, in: project) }
        }
    }
}

private enum TasksSheet: Identifiable {
    case newTemplate
    case editTemplate(TaskTemplate)
    case newSchedule(templateId: String?)
    case editSchedule(Schedule)

    var id: String {
        switch self {
        case .newTemplate: "template"
        case .editTemplate(let template): "template-\(template.id)"
        case .newSchedule(let templateId): "schedule-new-\(templateId ?? "")"
        case .editSchedule(let schedule): "schedule-\(schedule.id)"
        }
    }
}

private enum TasksDeletion {
    case template(TaskTemplate)
    case schedule(Schedule)

    var title: String {
        switch self {
        case .template(let template): String(localized: "删除模板「\(template.name)」？")
        case .schedule(let schedule): String(localized: "删除定时任务「\(schedule.name)」？")
        }
    }

    var message: String? {
        switch self {
        case .template: nil
        case .schedule: String(localized: "已经运行出的会话会保留。")
        }
    }
}

// MARK: - Rows

private struct ScheduleRow: View {
    let schedule: Schedule
    let enabled: Bool
    let toggling: Bool
    let running: Bool
    let runningThis: Bool
    let projectName: String
    let templateName: String?
    let setEnabled: (Bool) -> Void
    let runNow: () -> Void
    let openLast: () -> Void
    /// Asked when the menu opens, not while the page renders, so the page does not follow the session list.
    let hasLastSession: () -> Bool
    let edit: () -> Void
    let remove: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: Space.md) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: Space.sm) {
                    Text(schedule.name).font(.riffet(size: S(13), weight: .medium)).foregroundStyle(palette.fg).lineLimit(1)
                    if let result = schedule.lastResult { resultBadge(result) }
                }
                Text(detail).font(.riffet(size: S(12))).foregroundStyle(palette.fg3).lineLimit(1)
            }
            .opacity(enabled ? 1 : 0.55)
            Spacer(minLength: Space.sm)
            VStack(alignment: .trailing, spacing: 3) {
                Text(nextText).font(.riffet(size: S(12))).foregroundStyle(palette.fg3)
                if let last = formatDateTime(value: schedule.lastRunAt) {
                    Text("上次 \(last)").font(.riffet(size: S(11))).foregroundStyle(palette.fg4)
                }
            }
            .monospacedDigit()
            .lineLimit(1)
            .opacity(enabled ? 1 : 0.55)
            .layoutPriority(-1)
            Toggle(enabled ? "暂停" : "启用", isOn: Binding(get: { enabled }, set: setEnabled))
                .labelsHidden()
                .toggleStyle(.switch)
                .controlSize(.small)
                .disabled(toggling)
            RowMenu(label: String(localized: "\(schedule.name) 的操作")) {
                var entries: [NativeMenuEntry] = [.item(String(localized: "立即运行"), symbol: "play", enabled: !running, action: runNow)]
                if hasLastSession() { entries.append(.item(String(localized: "打开上次的会话"), symbol: "arrow.right", action: openLast)) }
                entries.append(.item(String(localized: "编辑"), symbol: "pencil", action: edit))
                entries.append(.separator)
                entries.append(.item(String(localized: "删除…"), symbol: "trash", action: remove))
                return entries
            }
            .overlay { if runningThis { Spinner(size: .mini) } }
        }
        .padding(.horizontal, Space.lg)
        .padding(.vertical, Space.md)
    }

    private var detail: String {
        var parts = [describeCron(schedule.cron), projectName, templateName ?? String(localized: "模板已删除")]
        if schedule.target == "same" { parts.append(String(localized: "同一会话")) }
        return parts.joined(separator: " · ")
    }

    private var nextText: String {
        guard enabled else { return String(localized: "已暂停") }
        return formatDateTime(value: schedule.nextRunAt).map { String(localized: "下次 \($0)") } ?? String(localized: "不会再运行")
    }

    @ViewBuilder
    private func resultBadge(_ result: String) -> some View {
        let style = Self.badge(result, palette: palette)
        Text(style.label)
            .font(.riffet(size: S(10.5), weight: .medium))
            .foregroundStyle(style.foreground)
            .padding(.horizontal, 6)
            .padding(.vertical, 1.5)
            .background(style.background, in: Capsule())
            .help(schedule.lastError ?? formatDateTime(value: schedule.lastRunAt).map { String(localized: "上次 \($0)") } ?? "")
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

private struct TemplateRow: View {
    let template: TaskTemplate
    let agent: String
    let busy: Bool
    let disabled: Bool
    let runEntries: () -> [NativeMenuEntry]
    let schedule: () -> Void
    let edit: () -> Void
    let remove: () -> Void
    @Environment(\.palette) private var palette
    @State private var runAnchor = MenuAnchor()

    var body: some View {
        HStack(spacing: Space.md) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: Space.sm) {
                    Text(template.name).font(.riffet(size: S(13), weight: .medium)).foregroundStyle(palette.fg).lineLimit(1)
                    if template.isolate?.boolValue == true {
                        Text("独立 Worktree")
                            .font(.riffet(size: S(10.5), weight: .medium))
                            .foregroundStyle(palette.fg3)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 1.5)
                            .background(palette.bgMuted, in: Capsule())
                    }
                }
                Text("\(agent) · \(firstLine)").font(.riffet(size: S(12))).foregroundStyle(palette.fg3).lineLimit(1)
            }
            Spacer(minLength: Space.sm)
            Button { runAnchor.popUp(entries: runEntries()) } label: {
                HStack(spacing: 5) {
                    if busy { Spinner(size: .mini) } else { Image(icon: "play.fill").font(.riffet(size: S(9.5))) }
                    Text("运行")
                }
            }
            .buttonStyle(SolidButtonStyle())
            .background(MenuAnchorView(anchor: runAnchor))
            .disabled(disabled)
            .help("选择项目后运行")
            RowMenu(label: String(localized: "\(template.name) 的操作")) {
                [
                    .item(String(localized: "定时运行…"), symbol: "calendar.badge.clock", action: schedule),
                    .item(String(localized: "编辑"), symbol: "pencil", action: edit),
                    .separator,
                    .item(String(localized: "删除…"), symbol: "trash", action: remove),
                ]
            }
        }
        .padding(.horizontal, Space.lg)
        .padding(.vertical, Space.md)
    }

    private var firstLine: String {
        template.prompt.split(separator: "\n", omittingEmptySubsequences: true).first.map(String.init) ?? ""
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
