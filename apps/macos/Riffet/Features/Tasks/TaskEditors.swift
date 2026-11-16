import SwiftUI
import RiffetKit

/// What the editor starts from when it is not editing a saved task, so "save this conversation as a
/// scheduled task" and the quick bar's custom time can open it already filled in.
struct AutomationDraft: Equatable {
    var name = ""
    var prompt = ""
    var target = LaunchChoice()
    var projectId: String?
    var isolate = false
    var trigger: AutomationTrigger?

    static func == (lhs: AutomationDraft, rhs: AutomationDraft) -> Bool {
        lhs.name == rhs.name && lhs.prompt == rhs.prompt && lhs.target == rhs.target && lhs.projectId == rhs.projectId
            && lhs.isolate == rhs.isolate && lhs.trigger?.kind == rhs.trigger?.kind && lhs.trigger?.at == rhs.trigger?.at && lhs.trigger?.cron == rhs.trigger?.cron
    }
}

/// Creates an automation, or edits [automation]: what to do, when it runs and how each run goes.
/// Only the first trigger is edited; the others are kept as they are. Saves on its own and calls
/// [onSaved]; present it with `.sheet`.
struct AutomationEditorSheet: View {
    private enum When: String { case manual, once, cron, other }
    private static let customCron = "custom"

    let workbench: Workbench
    let automation: Automation?
    var onSaved: () -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var draft: AutomationDraft
    @State private var when: When
    @State private var at: Date
    /// A cron preset's expression, or `customCron`.
    @State private var cronPreset: String
    @State private var customText: String
    @State private var delivery: String
    @State private var catchUp: Bool
    @State private var busy = false
    @State private var error: String?
    @State private var cronError: String?

    init(workbench: Workbench, automation: Automation? = nil, prefill: AutomationDraft? = nil, onSaved: @escaping () -> Void = {}) {
        self.workbench = workbench
        self.automation = automation
        self.onSaved = onSaved
        let initial = automation.map {
            AutomationDraft(name: $0.name, prompt: $0.prompt, target: LaunchChoice($0.target), projectId: $0.projectId, isolate: $0.isolate?.boolValue ?? false, trigger: $0.triggers.first)
        } ?? prefill ?? AutomationDraft()
        var draft = initial
        if automation == nil, draft.projectId == nil {
            draft.projectId = workbench.currentProjectId ?? workbench.projects.first?.id
        }
        var when = When.manual
        var at = Date.now.addingTimeInterval(3600)
        var cron = CronPreset.all[0].cron
        switch initial.trigger?.kind {
        case nil: break
        case "once":
            when = .once
            if let date = ServerTime.date(initial.trigger?.at) { at = date }
        case "cron":
            when = .cron
            cron = initial.trigger?.cron ?? cron
        default: when = .other
        }
        let known = CronPreset.all.contains { $0.cron == cron }
        _draft = State(initialValue: draft)
        _when = State(initialValue: when)
        _at = State(initialValue: at)
        _cronPreset = State(initialValue: known ? cron : Self.customCron)
        _customText = State(initialValue: known ? "" : cron)
        _delivery = State(initialValue: automation?.delivery ?? "new")
        _catchUp = State(initialValue: (automation?.catchUp ?? "latest") == "latest")
    }

    private var name: String { draft.name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var prompt: String { draft.prompt.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var cron: String { cronPreset == Self.customCron ? customText.trimmingCharacters(in: .whitespacesAndNewlines) : cronPreset }
    private var project: Project? { workbench.project(draft.projectId) }
    private var scheduled: Bool { when == .once || when == .cron || when == .other }
    private var canSave: Bool {
        guard !prompt.isEmpty else { return false }
        if scheduled && draft.projectId == nil { return false }
        return when != .cron || !cron.isEmpty
    }

    var body: some View {
        EditorSheet(
            title: automation == nil ? String(localized: "新建自动化") : String(localized: "编辑自动化"),
            subtitle: "",
            canSave: canSave,
            busy: busy,
            error: error,
            save: { Task { await save() } }
        ) {
            EditorField(label: String(localized: "名称")) {
                GitField(placeholder: String(localized: "默认取提示词首行"), text: $draft.name)
            }
            EditorField(label: String(localized: "提示词")) {
                PromptEditor(text: $draft.prompt, placeholder: String(localized: "要做什么…"))
            }
            EditorField(label: "Agent") {
                LaunchTargetPicker(workbench: workbench, choice: $draft.target, projectId: draft.projectId)
            }
            EditorField(label: String(localized: "项目")) {
                NativeChipMenu(text: project.map { $0.worktree?.branch ?? $0.name } ?? String(localized: "运行时选择"), symbol: project?.worktree == nil ? "folder" : "arrow.triangle.branch") { projectEntries }
            }
            toggleRow(String(localized: "每次在新的 Worktree 中运行"), isOn: $draft.isolate)
            if when != .other {
                EditorField(label: String(localized: "何时运行")) {
                    VStack(alignment: .leading, spacing: Space.sm) {
                        SegmentedTrack(selection: $when) {
                            Text("手动").tag(When.manual)
                            Text("一次").tag(When.once)
                            Text("重复").tag(When.cron)
                        }
                        whenDetail
                    }
                }
            }
            EditorField(label: String(localized: "每次运行")) {
                SegmentedTrack(selection: $delivery) {
                    Text("开新会话").tag("new")
                    Text("发到同一会话").tag("same")
                }
            }
            if scheduled { toggleRow(String(localized: "错过后补跑"), isOn: $catchUp) }
        }
    }

    @ViewBuilder
    private var whenDetail: some View {
        switch when {
        case .once:
            DatePicker("", selection: $at, displayedComponents: [.date, .hourAndMinute])
                .labelsHidden()
                .datePickerStyle(.compact)
        case .cron:
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 88), spacing: Space.xs, alignment: .leading)], alignment: .leading, spacing: Space.xs) {
                ForEach(CronPreset.all) { item in
                    Button(item.label) { cronPreset = item.cron; cronError = nil }
                        .buttonStyle(ChipButtonStyle(active: cronPreset == item.cron))
                }
                Button("自定义") { cronPreset = Self.customCron }
                    .buttonStyle(ChipButtonStyle(active: cronPreset == Self.customCron))
            }
            if cronPreset == Self.customCron {
                GitField(placeholder: "30 8 * * 1-5", text: Binding(get: { customText }, set: { customText = $0; cronError = nil }))
            }
            if let line = cronNote {
                Text(line).font(.riffet(size: S(11.5))).foregroundStyle(cronError == nil ? palette.fg3 : palette.danger).monospacedDigit()
            }
        default:
            EmptyView()
        }
    }

    /// The error, or the words for a custom expression and when it fires next.
    private var cronNote: String? {
        if let cronError { return cronError }
        guard !cron.isEmpty else { return nil }
        var parts: [String] = []
        if cronPreset == Self.customCron {
            let described = describeCron(cron)
            parts.append(described != cron ? described : String(localized: "分 时 日 月 周；也可以用 @daily、@hourly"))
        }
        let unchanged = automation?.triggers.first?.cron == cron
        if unchanged, let next = automation?.nextRunAt, let text = formatDateTime(value: next) {
            parts.append(String(localized: "下次 \(text)"))
        } else if let next = nextCronRun(cron), let text = formatDateTime(value: TimePreset.iso(next)) {
            parts.append(String(localized: "下次 \(text)"))
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private func toggleRow(_ title: String, isOn: Binding<Bool>) -> some View {
        HStack(spacing: Space.md) {
            Text(title).font(.riffet(size: S(13)))
            Spacer(minLength: 0)
            Toggle(title, isOn: isOn)
                .labelsHidden()
                .toggleStyle(.switch)
                .controlSize(.small)
        }
    }

    private var projectEntries: [NativeMenuEntry] {
        var entries: [NativeMenuEntry] = []
        // A saved project cannot be cleared again (an update leaves an absent field as it was).
        if automation?.projectId == nil && !scheduled {
            entries.append(.item(String(localized: "运行时选择"), checked: draft.projectId == nil) { draft.projectId = nil })
        }
        return entries + projectMenuEntries(workbench.projects, selected: draft.projectId, title: String(localized: "在哪个项目运行？")) { draft.projectId = $0.id }
    }

    private func save() async {
        guard !busy, canSave, let api = workbench.host.api else { return }
        busy = true
        error = nil
        cronError = nil
        defer { busy = false }
        let finalName = name.isEmpty ? TasksModel.name(of: prompt) : name
        let existing = automation?.triggers ?? []
        var triggers: [AutomationTrigger]?
        switch when {
        case .manual: triggers = []
        case .once:
            // A time left as it was keeps the saved trigger as the server sent it.
            if let first = existing.first, first.kind == "once", ServerTime.date(first.at) == at {
                triggers = existing
            } else {
                triggers = [AutomationTrigger(kind: "once", at: TimePreset.iso(at), cron: nil, timeZone: TimeZone.current.identifier)] + existing.dropFirst()
            }
        case .cron:
            // An expression left as it was keeps the zone it was saved with.
            let first = existing.first
            let zone = first?.kind == "cron" && first?.cron == cron ? first?.timeZone : nil
            triggers = first?.kind == "cron" && first?.cron == cron ? existing : [AutomationTrigger(kind: "cron", at: nil, cron: cron, timeZone: zone ?? TimeZone.current.identifier)] + existing.dropFirst()
        case .other: triggers = nil
        }
        do {
            // The whole target is sent, so clearing a field clears it on the server.
            let target = draft.target.target
            let mode = delivery
            let catchUpValue = catchUp ? "latest" : "skip"
            if let automation {
                _ = try await api.updateAutomation(
                    id: automation.id, name: finalName, prompt: prompt, target: target, projectId: draft.projectId,
                    isolate: KotlinBoolean(bool: draft.isolate), triggers: triggers, delivery: mode, catchUp: catchUpValue, enabled: nil
                )
            } else {
                _ = try await api.createAutomation(
                    name: finalName, prompt: prompt, target: target, projectId: draft.projectId, isolate: draft.isolate,
                    triggers: triggers ?? [], delivery: mode, catchUp: catchUpValue, enabled: true
                )
            }
            onSaved()
            dismiss()
        } catch {
            if error.riffetCode == "INVALID_CRON" {
                cronError = String(localized: "无法识别这个时间表达式")
            } else {
                self.error = String(localized: "无法保存自动化：\(error.riffetMessage)")
            }
        }
    }
}

// MARK: - Shared pieces

/// The projects as a native menu: each project with its worktrees after it. [choose] runs once the menu has closed.
func projectMenuEntries(_ projects: [Project], selected: String?, title: String, choose: @escaping (Project) -> Void) -> [NativeMenuEntry] {
    func entry(_ project: Project, nested: Bool) -> NativeMenuEntry {
        .item(
            nested ? project.worktree?.branch ?? project.name : project.name,
            subtitle: abbreviateHome(project.cwd),
            symbol: nested ? "arrow.triangle.branch" : "folder",
            checked: project.id == selected
        ) { choose(project) }
    }
    var entries: [NativeMenuEntry] = [.header(title)]
    for origin in projects where origin.worktree == nil {
        entries.append(entry(origin, nested: false))
        for tree in projects where tree.worktree?.originProjectId == origin.id { entries.append(entry(tree, nested: true)) }
    }
    for orphan in projects {
        guard let tree = orphan.worktree, !projects.contains(where: { $0.id == tree.originProjectId }) else { continue }
        entries.append(entry(orphan, nested: false))
    }
    return entries
}

/// The frame of the editors: title, the fields, an error line and cancel / save.
private struct EditorSheet<Content: View>: View {
    let title: String
    let subtitle: String
    let canSave: Bool
    let busy: Bool
    let error: String?
    let save: () -> Void
    @ViewBuilder let content: Content
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.riffet(size: S(15), weight: .semibold)).foregroundStyle(palette.fg)
                Text(subtitle).font(.riffet(size: S(12))).foregroundStyle(palette.fg3)
            }
            .padding(.horizontal, Space.xl)
            .padding(.top, Space.xl)
            .padding(.bottom, Space.md)
            ScrollView {
                VStack(alignment: .leading, spacing: Space.lg) { content }
                    .padding(.horizontal, Space.xl)
                    .padding(.vertical, Space.xs)
            }
            .scrollBounceBehavior(.basedOnSize)
            .disabled(busy)
            HStack(spacing: Space.sm) {
                if let error {
                    Text(error).font(.riffet(size: S(12))).foregroundStyle(palette.danger).lineLimit(2).textSelection(.enabled)
                }
                Spacer(minLength: Space.md)
                if busy { Spinner(size: .small) }
                Button("取消") { dismiss() }
                    .buttonStyle(SolidButtonStyle())
                    .keyboardShortcut(.cancelAction)
                    .disabled(busy)
                Button("保存", action: save)
                    .buttonStyle(SolidButtonStyle(kind: .primary))
                    .keyboardShortcut(.defaultAction)
                    .disabled(busy || !canSave)
            }
            .padding(Space.xl)
        }
        .frame(width: 500)
        .frame(maxHeight: 640)
        .background(palette.bg)
    }
}

/// A caption above one field of an editor, with an optional note below it.
private struct EditorField<Content: View>: View {
    let label: String
    var hint: String?
    @ViewBuilder let content: Content
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs + 2) {
            Text(label).font(.riffet(size: S(12), weight: .medium)).foregroundStyle(palette.fg2)
            content
            if let hint {
                Text(hint).font(.riffet(size: S(11.5))).foregroundStyle(palette.fg3).fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A multi-line field in the look of `GitField`.
struct PromptEditor: View {
    @Binding var text: String
    let placeholder: String
    var minHeight: CGFloat = 112
    @Environment(\.palette) private var palette

    var body: some View {
        TextEditor(text: $text)
            .font(.riffet(size: S(12.5)))
            .scrollContentBackground(.hidden)
            .padding(.horizontal, Space.sm)
            .padding(.vertical, Space.xs + 2)
            .frame(minHeight: minHeight, maxHeight: 240)
            .background(palette.bgSubtle, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
            .overlay(alignment: .topLeading) {
                if text.isEmpty {
                    Text(placeholder)
                        .font(.riffet(size: S(12.5)))
                        .foregroundStyle(palette.fg4)
                        .padding(.horizontal, Space.sm + 5)
                        .padding(.vertical, Space.xs + 2 + 1)
                        .allowsHitTesting(false)
                }
            }
            .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(palette.lineSoft))
    }
}
