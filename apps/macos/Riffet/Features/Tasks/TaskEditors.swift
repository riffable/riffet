import SwiftUI
import RiffetKit

/// What the template editor starts from when it is not editing a saved template, so "save this
/// conversation as a template" can open it with the prompt and target already filled in.
struct TemplateDraft: Equatable {
    var name = ""
    var prompt = ""
    var target = LaunchChoice()
    var isolate = false
}

/// Creates a template, or edits [template]. Saves on its own and reports the saved template through
/// [onSaved]; present it with `.sheet`. [prefill] fills a new one (ignored when editing), and
/// [projectId] is the project whose model catalog the target picker reads.
struct TemplateEditorSheet: View {
    let workbench: Workbench
    let template: TaskTemplate?
    var projectId: String?
    var onSaved: (TaskTemplate) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var draft: TemplateDraft
    @State private var busy = false
    @State private var error: String?

    init(workbench: Workbench, template: TaskTemplate? = nil, prefill: TemplateDraft? = nil, projectId: String? = nil, onSaved: @escaping (TaskTemplate) -> Void = { _ in }) {
        self.workbench = workbench
        self.template = template
        self.projectId = projectId
        self.onSaved = onSaved
        let initial = template.map {
            TemplateDraft(name: $0.name, prompt: $0.prompt, target: LaunchChoice($0.target), isolate: $0.isolate?.boolValue ?? false)
        }
        _draft = State(initialValue: initial ?? prefill ?? TemplateDraft())
    }

    private var name: String { draft.name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var prompt: String { draft.prompt.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        EditorSheet(
            title: template == nil ? String(localized: "新建任务模板") : String(localized: "编辑任务模板"),
            subtitle: "",
            canSave: !name.isEmpty && !prompt.isEmpty,
            busy: busy,
            error: error,
            save: { Task { await save() } }
        ) {
            EditorField(label: String(localized: "名称")) {
                GitField(placeholder: String(localized: "比如：晨间依赖检查"), text: $draft.name)
            }
            EditorField(label: String(localized: "任务"), hint: String(localized: "运行时 {{date}} 会替换为当天日期，{{project}} 替换为项目名。")) {
                PromptEditor(text: $draft.prompt, placeholder: String(localized: "让 Agent 做什么"))
            }
            EditorField(label: "Agent") {
                LaunchTargetPicker(workbench: workbench, choice: $draft.target, projectId: projectId)
            }
            HStack(spacing: Space.md) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("每次在新的 Worktree 中运行").font(.riffet(size: S(13)))
                    Text("不碰项目当前的工作区。").font(.riffet(size: S(11.5))).foregroundStyle(palette.fg3)
                }
                Spacer(minLength: 0)
                Toggle("每次在新的 Worktree 中运行", isOn: $draft.isolate)
                    .labelsHidden()
                    .toggleStyle(.switch)
                    .controlSize(.small)
            }
        }
    }

    private func save() async {
        guard !busy, !name.isEmpty, !prompt.isEmpty, let api = workbench.host.api else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            // The whole target is sent, so clearing a field clears it on the server.
            let target = draft.target.target
            let saved: TaskTemplate
            if let template {
                saved = try await api.updateTemplate(id: template.id, name: name, prompt: prompt, target: target, isolate: KotlinBoolean(bool: draft.isolate))
            } else {
                saved = try await api.createTemplate(name: name, prompt: prompt, target: target, isolate: draft.isolate)
            }
            onSaved(saved)
            dismiss()
        } catch {
            self.error = String(localized: "无法保存模板：\(error.riffetMessage)")
        }
    }
}

/// Creates a schedule, or edits [schedule]: a template run in a project at a cron time. [templateId]
/// is the template a new one starts from.
struct ScheduleEditorSheet: View {
    let workbench: Workbench
    let schedule: Schedule?
    let templates: [TaskTemplate]
    var onSaved: () -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var name: String
    @State private var templateId: String
    @State private var projectId: String
    /// A preset's cron expression, or `custom`.
    @State private var preset: String
    @State private var custom: String
    @State private var target: String
    @State private var busy = false
    @State private var error: String?
    @State private var cronError: String?

    private static let customPreset = "custom"

    init(workbench: Workbench, schedule: Schedule? = nil, templates: [TaskTemplate], templateId: String? = nil, onSaved: @escaping () -> Void = {}) {
        self.workbench = workbench
        self.schedule = schedule
        self.templates = templates
        self.onSaved = onSaved
        let cron = schedule?.cron ?? CronPreset.all[0].cron
        let known = CronPreset.all.contains { $0.cron == cron }
        let projects = workbench.projects
        let defaultProject = projects.first { $0.id == workbench.currentProjectId } ?? projects.first
        _name = State(initialValue: schedule?.name ?? "")
        _templateId = State(initialValue: schedule?.templateId ?? templateId ?? templates.first?.id ?? "")
        _projectId = State(initialValue: schedule?.projectId ?? defaultProject?.id ?? "")
        _preset = State(initialValue: known ? cron : Self.customPreset)
        _custom = State(initialValue: known ? "" : cron)
        _target = State(initialValue: schedule?.target ?? "new")
    }

    private var cron: String { preset == Self.customPreset ? custom.trimmingCharacters(in: .whitespacesAndNewlines) : preset }
    private var templateName: String { templates.first { $0.id == templateId }?.name ?? "" }
    private var project: Project? { workbench.project(projectId) }

    var body: some View {
        EditorSheet(
            title: schedule == nil ? String(localized: "定时运行") : String(localized: "编辑定时任务"),
            subtitle: "",
            canSave: !templateId.isEmpty && !projectId.isEmpty && !cron.isEmpty,
            busy: busy,
            error: error,
            save: { Task { await save() } }
        ) {
            HStack(alignment: .top, spacing: Space.lg) {
                EditorField(label: String(localized: "模板")) {
                    NativeChipMenu(text: templateName.isEmpty ? String(localized: "选择模板") : templateName, symbol: "doc.text") { templateEntries }
                }
                EditorField(label: String(localized: "项目")) {
                    NativeChipMenu(text: project.map { $0.worktree?.branch ?? $0.name } ?? String(localized: "选择项目"), symbol: project?.worktree == nil ? "folder" : "arrow.triangle.branch") {
                        projectMenuEntries(workbench.projects, selected: projectId, title: String(localized: "在哪个项目运行？")) { projectId = $0.id }
                    }
                }
            }
            EditorField(label: String(localized: "时间")) { timePicker }
            EditorField(label: String(localized: "每次运行"), hint: target == "new" ? nil : String(localized: "那段会话归档后会重新开一段。")) {
                SegmentedTrack(selection: $target) {
                    Text("开新会话").tag("new")
                    Text("发到同一会话").tag("same")
                }
            }
            EditorField(label: String(localized: "名称")) {
                GitField(placeholder: templateName.isEmpty ? String(localized: "默认使用模板名") : templateName, text: $name)
            }
        }
    }

    private var timePicker: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 88), spacing: Space.xs, alignment: .leading)], alignment: .leading, spacing: Space.xs) {
                ForEach(CronPreset.all) { item in
                    Button(item.label) { preset = item.cron; cronError = nil }
                        .buttonStyle(ChipButtonStyle(active: preset == item.cron))
                }
                Button("自定义") { preset = Self.customPreset }
                    .buttonStyle(ChipButtonStyle(active: preset == Self.customPreset))
            }
            if preset == Self.customPreset {
                GitField(placeholder: "30 8 * * 1-5", text: Binding(get: { custom }, set: { custom = $0; cronError = nil }))
                let described = describeCron(custom)
                Text(cronError ?? (!cron.isEmpty && described != cron ? described : String(localized: "分 时 日 月 周，本地时间；也可以用 @daily、@hourly")))
                    .font(.riffet(size: S(11.5)))
                    .foregroundStyle(cronError == nil ? palette.fg3 : palette.danger)
            }
        }
    }

    private var templateEntries: [NativeMenuEntry] {
        [NativeMenuEntry.header(String(localized: "模板"))] + templates.map { item -> NativeMenuEntry in
            let id = item.id
            return .item(item.name, checked: id == templateId) { templateId = id }
        }
    }

    private func save() async {
        guard !busy, !templateId.isEmpty, !projectId.isEmpty, !cron.isEmpty, let api = workbench.host.api else { return }
        busy = true
        error = nil
        cronError = nil
        defer { busy = false }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let finalName = trimmed.isEmpty ? templateName : trimmed
        do {
            if let schedule {
                _ = try await api.updateSchedule(id: schedule.id, name: finalName, templateId: templateId, projectId: projectId, cron: cron, enabled: nil, target: target)
            } else {
                _ = try await api.createSchedule(name: finalName, templateId: templateId, projectId: projectId, cron: cron, enabled: true, target: target)
            }
            onSaved()
            dismiss()
        } catch {
            if error.riffetCode == "INVALID_CRON" {
                cronError = String(localized: "无法识别这个时间表达式")
            } else {
                self.error = String(localized: "无法保存定时任务：\(error.riffetMessage)")
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
private struct PromptEditor: View {
    @Binding var text: String
    let placeholder: String
    @Environment(\.palette) private var palette

    var body: some View {
        TextEditor(text: $text)
            .font(.riffet(size: S(12.5)))
            .scrollContentBackground(.hidden)
            .padding(.horizontal, Space.sm)
            .padding(.vertical, Space.xs + 2)
            .frame(minHeight: 112, maxHeight: 240)
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
