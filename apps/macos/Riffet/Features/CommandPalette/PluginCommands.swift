import SwiftUI
import RiffetKit

// Plugin commands (docs/design/plugin-system.md §4.3): the commands enabled plugins declare, listed in
// the command palette and run through `POST /api/integrations/:id/commands/:name`. Visibility only
// follows the declared condition; the server checks scope and condition again when one runs.

/// One command of an enabled plugin.
struct PluginCommand: Identifiable {
    let pluginTitle: String
    let declaration: CommandDeclaration

    var id: String { declaration.id }
    var title: String { localizedText(declaration.title, fallback: declaration.id) }
    var scope: String { declaration.scope ?? "project" }
    var params: [TaskParamField] { declaration.params ?? [] }
    /// Runs at once when it takes nothing or every value has a default; otherwise the reader fills a form first.
    var needsInput: Bool { params.contains { $0.defaultText() == nil } }
}

/// A task the reader should see in its view, as a command that started it asked.
struct TaskFocus: Equatable {
    let taskId: String
    let projectId: String
    let provider: String
}

extension Workbench {
    /// The commands on offer for the open conversation or project: plugins that are on, a `when` that
    /// holds, and the context their scope needs.
    var pluginCommandList: [PluginCommand] {
        let facts = inspectorFacts
        let project = quickChatContext ? nil : currentProject
        let session = quickChatContext || showingHome ? nil : selected
        return plugins.filter(\.enabled).flatMap { plugin in
            (plugin.declared?.commands ?? []).compactMap { declaration -> PluginCommand? in
                guard facts.matches(declaration.whenCondition) else { return nil }
                switch declaration.scope ?? "project" {
                case "global": break
                case "session": if project == nil || session == nil { return nil }
                default: if project == nil { return nil }
                }
                return PluginCommand(pluginTitle: plugin.displayTitle, declaration: declaration)
            }
        }
    }
}

/// The input form, the confirmation and the message of the commands being run. The workbench shows them
/// (`PluginCommandPresenter`).
@MainActor
@Observable
final class PluginCommandRunner {
    /// Where a run happens, fixed when it starts: a late answer never lands in another project.
    struct Context {
        var projectId: String?
        var sessionId: String?
    }

    struct Form: Identifiable {
        let command: PluginCommand
        let context: Context
        var id: String { command.id }
    }

    /// A run that waits for the reader to approve the command a task would execute. The approved run is a new request: the refused one got an answer.
    struct Confirmation: Identifiable {
        let id = UUID()
        let command: PluginCommand
        let context: Context
        let values: [String: String]
        let plan: TaskConfirmation
    }

    struct Message: Equatable {
        let text: String
        let failed: Bool
        let ticket: Int
    }

    var form: Form?
    var confirmation: Confirmation?
    private(set) var message: Message?
    @ObservationIgnored private var running: Set<String> = []
    @ObservationIgnored private var ticket = 0

    func run(_ command: PluginCommand, in workbench: Workbench) {
        let context = Context(
            projectId: command.scope == "global" ? nil : workbench.currentProjectId,
            sessionId: command.scope == "session" ? workbench.selected?.id : nil
        )
        if command.needsInput { form = Form(command: command, context: context) } else { execute(command, context, values: [:], in: workbench) }
    }

    func execute(_ command: PluginCommand, _ context: Context, values: [String: String], requestId: String = UUID().uuidString.lowercased(), confirm: String? = nil, in workbench: Workbench) {
        guard !running.contains(command.id), let api = workbench.host.api else { return }
        running.insert(command.id)
        Task { @MainActor in
            defer { self.running.remove(command.id) }
            do {
                let run = try await api.runCommand(
                    commandId: command.id, requestId: requestId, projectId: context.projectId, sessionId: context.sessionId,
                    values: values, params: command.params, confirm: confirm
                )
                if let plan = run.confirmation {
                    self.confirmation = Confirmation(command: command, context: context, values: values, plan: plan)
                } else if let result = run.result {
                    await self.handle(result, context: context, in: workbench)
                }
            } catch {
                self.show(error.riffetMessage, failed: true)
            }
        }
    }

    private func handle(_ result: PluginCommandResult, context: Context, in workbench: Workbench) async {
        switch result.kind {
        case "done":
            let text = localizedText(result.message, fallback: "")
            if !text.isEmpty { show(text, failed: false) }
        case "open":
            if let sessionId = result.sessionId { workbench.open(sessionId: sessionId) }
            if let view = result.view {
                if let sessionId = result.sessionId { workbench.showPanel(view, session: sessionId) }
                else if let tab = workbench.inspectorTab(panel: view) { workbench.showInspector(tab) }
            }
            if let path = result.path { workbench.preview(path: path) }
        case "task":
            guard let taskId = result.taskId, let api = workbench.host.api, let task = try? await api.task(id: taskId) else { return }
            let projectId = task.projectId.isEmpty ? context.projectId : task.projectId
            guard let projectId else { return }
            workbench.taskFocus = TaskFocus(taskId: taskId, projectId: projectId, provider: task.providerId)
            if let view = workbench.inspectorViews.first(where: { $0.taskProvider == task.providerId }) { workbench.showInspector(view.tab) }
        default:
            break
        }
    }

    func show(_ text: String, failed: Bool) {
        ticket += 1
        let current = ticket
        message = Message(text: text, failed: failed, ticket: current)
        guard !failed else { return }
        Task {
            try? await Task.sleep(for: .seconds(2.4))
            if self.ticket == current { self.message = nil }
        }
    }

    func dismissMessage() { message = nil }
}

/// The sheets and the message of plugin commands, over the workbench.
struct PluginCommandPresenter: ViewModifier {
    let workbench: Workbench
    @Environment(\.palette) private var palette
    @State private var messageDismissal = UUID()

    func body(content: Content) -> some View {
        let runner = workbench.pluginCommands
        content
            .sheet(item: Binding(get: { runner.form }, set: { runner.form = $0 })) { form in
                PluginCommandForm(command: form.command) { values in
                    runner.execute(form.command, form.context, values: values, in: workbench)
                }
            }
            .sheet(item: Binding(get: { runner.confirmation }, set: { runner.confirmation = $0 })) { pending in
                TaskConfirmationSheet(title: pending.command.pluginTitle, plan: pending.plan) {
                    runner.execute(pending.command, pending.context, values: pending.values, confirm: pending.plan.fingerprint, in: workbench)
                }
            }
            .overlay(alignment: .bottom) {
                VStack(spacing: Space.xs) {
                    FeedbackRegion(value: runner.message, active: runner.form == nil && runner.confirmation == nil) { message, live in
                        HStack(alignment: .top, spacing: Space.sm) {
                            if message.failed && live { Image(icon: "exclamationmark.circle").foregroundStyle(palette.toastDanger) }
                            Text(message.text).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                            if message.failed {
                                Button {
                                    if runner.message?.ticket == message.ticket { runner.dismissMessage() }
                                    messageDismissal = UUID()
                                } label: { Image(icon: "xmark") }
                                    .buttonStyle(.plain).help("关闭")
                            }
                        }
                        .font(.riffet(size: S(12.5))).foregroundStyle(.white)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .background(RoundedRectangle(cornerRadius: Radius.container, style: .continuous).fill(palette.toast))
                        .transition(.opacity.combined(with: .offset(y: 8)))
                    }
                    .id("\(workbench.baseURL.absoluteString)|\(messageDismissal)")
                }
                .padding(.bottom, 28)
            }
            .animation(.easeOut(duration: 0.2), value: runner.message)
    }
}

extension View {
    func pluginCommandPresenter(_ workbench: Workbench) -> some View { modifier(PluginCommandPresenter(workbench: workbench)) }
}

/// The values a command takes, by its declared fields.
private struct PluginCommandForm: View {
    let command: PluginCommand
    let run: ([String: String]) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var values: [String: String]

    init(command: PluginCommand, run: @escaping ([String: String]) -> Void) {
        self.command = command
        self.run = run
        _values = State(initialValue: Dictionary(uniqueKeysWithValues: command.params.map { ($0.key, $0.defaultText() ?? ($0.kind == "boolean" ? "false" : "")) }))
    }

    private var complete: Bool {
        command.params.allSatisfy { !$0.required || $0.kind == "boolean" || !(values[$0.key] ?? "").isEmpty }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            Text(command.title).font(.title3.weight(.semibold))
            Form {
                ForEach(command.params, id: \.key) { field in
                    let label = localizedText(field.label, fallback: field.key)
                    switch field.kind {
                    case "boolean":
                        SettingsRow(label) { Toggle(label, isOn: flag(field.key)).labelsHidden().toggleStyle(.switch) }
                    case "choice":
                        SettingsFieldRow(label) {
                            Picker(label, selection: text(field.key)) {
                                ForEach(field.options ?? [], id: \.self) { Text($0).tag($0) }
                            }
                            .formPicker()
                        }
                    default:
                        SettingsFieldRow(label) { TextField(label, text: text(field.key)).formField() }
                    }
                }
            }
            .riffetForm()
            .scrollContentBackground(.hidden)
            HStack {
                Spacer()
                Button("取消") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("运行") { dismiss(); run(values) }
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(SolidButtonStyle(kind: .primary))
                    .disabled(!complete)
            }
        }
        .padding(Space.xl)
        .frame(width: 420)
    }

    private func text(_ key: String) -> Binding<String> {
        Binding(get: { values[key] ?? "" }, set: { values[key] = $0 })
    }

    private func flag(_ key: String) -> Binding<Bool> {
        Binding(get: { values[key] == "true" }, set: { values[key] = $0 ? "true" : "false" })
    }
}

/// The exact command a task of an installed package would run, shown before its first run. Nothing is
/// stored here: the server remembers the approval.
struct TaskConfirmationSheet: View {
    let title: String
    let plan: TaskConfirmation
    let run: () -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette

    /// `file` and arguments as a shell would read them.
    private var commandLine: String { ([plan.file] + plan.args).map(Self.quoted).joined(separator: " ") }

    private var lines: [String] {
        ["cd \(Self.quoted(plan.cwd.isEmpty ? "." : plan.cwd))", commandLine]
            + plan.env.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            Text(title).font(.title3.weight(.semibold))
            Text("首次运行这条命令").foregroundStyle(palette.fg3)
            // Scrolls rather than grows: a long plan must not push part of itself, or the buttons, off the sheet.
            ScrollView {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                        Text(line)
                            .font(.riffet(size: S(12), design: .monospaced))
                            .foregroundStyle(palette.fg)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .textSelection(.enabled)
                .padding(Space.sm)
            }
            .frame(maxHeight: 240)
            .background(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).fill(palette.bgMuted))
            .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(palette.lineSoft))
            HStack {
                Spacer()
                Button("取消") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("运行") { dismiss(); run() }
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(SolidButtonStyle(kind: .primary))
            }
        }
        .padding(Space.xl)
        .frame(width: 480)
    }

    /// Single-quoted unless it is made of characters a shell leaves alone.
    static func quoted(_ word: String) -> String {
        if !word.isEmpty, word.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || "_@%+=:,./-".contains($0)) }) { return word }
        return "'" + word.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}
