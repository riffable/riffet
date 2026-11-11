import AppKit
import SwiftUI
import UniformTypeIdentifiers
import RiffetKit

/// A template the editor opens with its fields already filled in.
struct TemplatePrefill: Identifiable {
    let id = UUID()
    let draft: TemplateDraft
    /// Shown above the editor when the draft could not be filled in completely.
    var notice: String?
}

/// A turn's code, before and after: what rewinding to the checkpoint taken just before it would write.
struct RewindPlan: Identifiable {
    let id = UUID()
    let sessionId: String
    let projectId: String
    let checkpointId: String
    let changes: [CheckpointChange]
}

/// The orchestration actions of one conversation (`NativeSession.tsx`'s `turnAction` and header
/// menu): fork from a turn, rewind the code to before it, hand the conversation to a chosen Agent,
/// keep it as a task template, export it. The owner (the transcript, the session menu) attaches
/// `.sessionOrchestration` to present what an action needs.
@MainActor
@Observable
final class SessionOrchestrator {
    enum Sheet: Identifiable {
        case handoff
        case template(TemplatePrefill)
        case rewind(RewindPlan)

        var id: String {
            switch self {
            case .handoff: "handoff"
            case let .template(prefill): "template.\(prefill.id)"
            case let .rewind(plan): "rewind.\(plan.id)"
            }
        }
    }

    var sheet: Sheet?
    var message: OrchestrationMessage?
    /// A request is in flight; one at a time.
    private(set) var busy = false

    /// A retried fork reuses its ids, so the server returns the conversation the first try created.
    @ObservationIgnored private var forkIds: [String: (clientSessionId: String, commandId: String)] = [:]

    // MARK: Turns

    func perform(_ action: TurnAction, runId: String, session: Session, workbench: Workbench) {
        switch action {
        case .fork: fork(runId: runId, session: session, workbench: workbench)
        case .rewind: rewind(runId: runId, session: session, workbench: workbench)
        }
    }

    private func fork(runId: String, session: Session, workbench: Workbench) {
        guard !busy, let api = workbench.host.api else { return }
        busy = true
        let key = "\(session.id)|\(runId)"
        let ids = forkIds[key] ?? (UUID().uuidString, UUID().uuidString)
        forkIds[key] = ids
        Task {
            defer { busy = false }
            do {
                let result = try await api.forkSession(
                    sessionId: session.id, clientSessionId: ids.clientSessionId, commandId: ids.commandId,
                    runId: runId, target: nil, isolate: false, note: nil
                )
                forkIds[key] = nil
                workbench.openLaunched(result)
            } catch {
                message = OrchestrationMessage(title: String(localized: "无法另开会话"), detail: error.riffetMessage)
            }
        }
    }

    /// Rewinding restores the checkpoint taken just before the turn, through the same fingerprint-checked
    /// restore the changes panel uses. The conversation itself stays: the CLI owns its history and
    /// cannot drop turns, so the sheet says so rather than implying a full undo.
    private func rewind(runId: String, session: Session, workbench: Workbench) {
        guard !busy, let api = workbench.host.api else { return }
        // Restoring under a running turn would race the agent's own writes.
        guard !workbench.working else {
            message = OrchestrationMessage(title: String(localized: "无法回退代码"), detail: String(localized: "Agent 正在运行，等它停下后再回退代码。"))
            return
        }
        busy = true
        Task {
            defer { busy = false }
            do {
                let checkpoints = try await api.sessionCheckpoints(sessionId: session.id)
                let match = checkpoints.first { $0.runId == runId }
                guard let checkpoint = match else {
                    message = OrchestrationMessage(title: String(localized: "无法回退代码"), detail: String(localized: "本轮开始前没有检查点，无法回退代码。"))
                    return
                }
                let changes = try await api.checkpointChanges(projectId: checkpoint.projectId, checkpointId: checkpoint.id)
                guard !changes.isEmpty else {
                    message = OrchestrationMessage(title: String(localized: "无需回退"), detail: String(localized: "代码与本轮开始前一致。"))
                    return
                }
                sheet = .rewind(RewindPlan(sessionId: session.id, projectId: checkpoint.projectId, checkpointId: checkpoint.id, changes: changes))
            } catch {
                message = OrchestrationMessage(title: String(localized: "无法回退代码"), detail: error.riffetMessage)
            }
        }
    }

    // MARK: Session menu

    func handoff() {
        sheet = .handoff
    }

    /// Opens the template editor with the conversation's name, opening request and target. The
    /// opening request is what a repeat of this conversation would start from; follow-ups that
    /// steered a running turn only make sense inside it.
    func saveAsTemplate(session: Session, workbench: Workbench) {
        guard !busy else { return }
        busy = true
        Task {
            defer { busy = false }
            let loaded = try? await workbench.host.api?.runs(id: session.id)
            let failed = loaded == nil
            let runs = loaded ?? []
            // The reader moved to another conversation meanwhile; its editor is not theirs to see here.
            guard workbench.selected?.id == session.id else { return }
            let first = runs.first { $0.native?.intent != "steer" && !$0.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            let target = LaunchChoice(agent: session.agent, profileId: session.backendProfileId, model: session.model, mode: session.mode, approval: session.approval)
            let draft = TemplateDraft(name: session.title, prompt: first?.prompt ?? "", target: target, isolate: false)
            sheet = .template(TemplatePrefill(draft: draft, notice: failed ? String(localized: "没能读取首条提问，可手动填写") : nil))
        }
    }

    func export(session: Session, workbench: Workbench) {
        guard !busy, let api = workbench.host.api else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                let text = try await api.exportSession(sessionId: session.id)
                let panel = NSSavePanel()
                panel.canCreateDirectories = true
                panel.isExtensionHidden = false
                panel.nameFieldStringValue = Self.exportName(session.title)
                panel.allowedContentTypes = [.json]
                guard panel.runModal() == .OK, let destination = panel.url else { return }
                try await Task.detached { try Data(text.utf8).write(to: destination, options: .atomic) }.value
            } catch {
                message = OrchestrationMessage(title: String(localized: "无法导出会话"), detail: error.riffetMessage)
            }
        }
    }

    private static func exportName(_ title: String) -> String {
        let cleaned = title.components(separatedBy: CharacterSet(charactersIn: "/:\\\n\r")).joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return "\(cleaned.isEmpty ? String(localized: "会话") : String(cleaned.prefix(60))).json"
    }
}

extension View {
    /// Presents what [orchestrator]'s actions need (their sheets and alerts) for [session].
    func sessionOrchestration(_ orchestrator: SessionOrchestrator, workbench: Workbench, session: Session) -> some View {
        modifier(SessionOrchestrationModifier(orchestrator: orchestrator, workbench: workbench, session: session))
    }
}

private struct SessionOrchestrationModifier: ViewModifier {
    @Bindable var orchestrator: SessionOrchestrator
    let workbench: Workbench
    let session: Session

    func body(content: Content) -> some View {
        content
            .sheet(item: $orchestrator.sheet) { sheet in
                switch sheet {
                case .handoff:
                    HandoffSheet(workbench: workbench, session: session)
                case let .template(prefill):
                    TemplateEditorSheet(workbench: workbench, template: nil, prefill: prefill.draft, projectId: session.projectId)
                        .safeAreaInset(edge: .top, spacing: 0) {
                            if let notice = prefill.notice {
                                NoticeBar(tone: .warning, symbol: "exclamationmark.triangle", text: notice) {}.padding([.horizontal, .top], Space.md)
                            }
                        }
                case let .rewind(plan):
                    RewindSheet(workbench: workbench, plan: plan) { count in
                        orchestrator.message = OrchestrationMessage(title: String(localized: "已回退代码"), detail: String(localized: "已回退 \(count) 个文件。"))
                    }
                }
            }
            .alert(
                orchestrator.message?.title ?? "",
                isPresented: Binding(get: { orchestrator.message != nil }, set: { if !$0 { orchestrator.message = nil } })
            ) {
                Button("好") {}
            } message: {
                Text(orchestrator.message?.detail ?? "")
            }
    }
}

// MARK: - Handoff

/// Hands the conversation to a chosen Agent (possibly the same one) in the same directory (`HandoffDialog`), in two steps: the
/// server drafts the new conversation's first message (with the handoff model when one is set, from
/// the transcript otherwise), the user edits it, and the edited text is what the new one starts from.
/// This one stays readable.
struct HandoffSheet: View {
    let workbench: Workbench
    let session: Session
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var choice = LaunchChoice()
    @State private var goal = ""
    /// The last draft. Kept when the target or goal changes: the text does not depend on the target, and 重新生成 applies a new goal.
    @State private var draft: HandoffDraft?
    @State private var text = ""
    @State private var generation: Task<Void, Never>?
    @State private var busy = false
    @State private var error: String?
    /// One pair per opening, so a retried submit after a dropped response finds the conversation it already made.
    @State private var ids = (clientSessionId: UUID().uuidString, commandId: UUID().uuidString)

    private var source: String? { session.agent }
    /// A turn in flight would keep changing what the summary describes, so the server refuses it too.
    private var working: Bool { workbench.working }
    /// The server never required a different backend: handing back to the same Agent is a fresh
    /// conversation carrying only the summary, which is how a full context window is reset.
    private var canGenerate: Bool { choice.agent != nil && !working }
    private var canSubmit: Bool { canGenerate && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var generating: Bool { generation != nil }

    var body: some View {
        OrchestrationSheet(
            title: String(localized: "交接会话"),
            subtitle: String(localized: "工具输出和图片不会带过去；原会话保留可读。"),
            confirmTitle: draft == nil ? String(localized: "生成") : String(localized: "交接"),
            canConfirm: draft == nil ? canGenerate : canSubmit,
            busy: busy || generating,
            error: error,
            secondaryTitle: draft == nil ? nil : String(localized: "重新生成"),
            secondary: draft == nil || !canGenerate ? nil : { generate() },
            cancelWhileBusy: generating,
            confirm: { if draft == nil { generate() } else { Task { await submit() } } }
        ) {
            // No field caption of its own: the picker's rows already name Agent / model / mode / approval,
            // and a second "交给" layer only pushed them out of alignment.
            LaunchTargetPicker(workbench: workbench, choice: $choice, projectId: session.projectId, allowsDefault: false)
            OrchestrationField(label: String(localized: "后续任务")) {
                OrchestrationTextArea(text: $goal, placeholder: String(localized: "先确认现状和未完成的部分，然后继续完成它"))
            }
            if let draft {
                OrchestrationField(label: String(localized: "交接摘要"), hint: provenance(draft)) {
                    OrchestrationTextArea(text: $text, placeholder: "", minHeight: 240, maxHeight: 360)
                }
            }
            if working {
                Text("\(source.map(backendLabel) ?? "Agent") 还在运行，先停止本轮任务再交接。")
                    .font(.riffet(size: S(11.5)))
                    .foregroundStyle(palette.warning)
            }
        }
        .task {
            if workbench.backends.isEmpty { await workbench.loadBackends() }
            if choice.agent == nil {
                // Another Agent stays the default (switching is the usual reason to hand off);
                // the same one is only the fallback when nothing else is available.
                let pickable = workbench.backends.filter(\.isPickable)
                let fallback = pickable.first { $0.available && $0.agent != source } ?? pickable.first { $0.available }
                choice = LaunchChoice(agent: fallback?.agent)
            }
        }
        .onDisappear { generation?.cancel() }
    }

    private func provenance(_ draft: HandoffDraft) -> String {
        if let model = draft.generatedBy { return String(localized: "由 \(model.profileName) · \(model.model) 生成") }
        if let reason = draft.fallbackReason { return String(localized: "摘要模型不可用，已改用对话记录：\(reason)") }
        return String(localized: "由对话记录拼成")
    }

    /// The server stops the model when the request goes away, so cancelling here (on dismiss) ends it.
    private func generate() {
        guard canGenerate, generation == nil, let api = workbench.host.api else { return }
        error = nil
        let trimmed = goal.trimmingCharacters(in: .whitespacesAndNewlines)
        generation = Task {
            defer { generation = nil }
            do {
                let next = try await api.handoffDraft(sessionId: session.id, target: choice.target, goal: trimmed.isEmpty ? nil : trimmed)
                guard !Task.isCancelled else { return }
                draft = next
                text = next.text
            } catch {
                guard !Task.isCancelled, !(error is CancellationError) else { return }
                self.error = message(for: error)
            }
        }
    }

    private func submit() async {
        guard canSubmit, !busy, let api = workbench.host.api else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            let result = try await api.handoffSession(
                sessionId: session.id, clientSessionId: ids.clientSessionId, commandId: ids.commandId,
                target: choice.target, note: nil, text: text
            )
            dismiss()
            workbench.openLaunched(result)
        } catch {
            self.error = message(for: error)
        }
    }

    private func message(for error: Error) -> String {
        error.riffetCode == "SESSION_BUSY" ? String(localized: "先停止本轮任务再交接") : String(localized: "无法交接会话：\(error.riffetMessage)")
    }
}

// MARK: - Rewind

/// Lists what rewinding would write and sends exactly that list back with the restore, so the server
/// refuses it when the working tree has moved on since the reader looked.
struct RewindSheet: View {
    let workbench: Workbench
    let plan: RewindPlan
    let onRestored: (Int) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var changes: [CheckpointChange]
    @State private var busy = false
    @State private var error: String?

    init(workbench: Workbench, plan: RewindPlan, onRestored: @escaping (Int) -> Void) {
        self.workbench = workbench
        self.plan = plan
        self.onRestored = onRestored
        _changes = State(initialValue: plan.changes)
    }

    var body: some View {
        OrchestrationSheet(
            title: String(localized: "回退代码到本轮开始前？"),
            subtitle: String(localized: "代码将回到本轮开始前，撤销 \(changes.count) 个文件自那之后的改动。对话记录会保留，Agent 不会感知到回退，可以接着告诉它。"),
            confirmTitle: String(localized: "回退"),
            confirmKind: .danger,
            canConfirm: !changes.isEmpty,
            busy: busy,
            error: error,
            confirm: { Task { await restore() } }
        ) {
            VStack(spacing: 0) {
                ForEach(changes, id: \.path) { change in
                    HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
                        Text(rewindLabel(change.kind))
                            .font(.riffet(size: S(11), weight: .semibold))
                            .foregroundStyle(gitChangeTint(change.kind, palette))
                            .frame(width: 28, alignment: .leading)
                        Text(change.path)
                            .font(.riffet(size: S(12), design: .monospaced))
                            .foregroundStyle(palette.fg)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .help(change.path)
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, 3)
                }
            }
        }
    }

    /// What rewinding does to the file, not what the turn did to it: a file the turn added is deleted.
    private func rewindLabel(_ kind: CheckpointChangeKind) -> String {
        switch kind {
        case .added: String(localized: "删除")
        case .modified: String(localized: "还原")
        case .deleted: String(localized: "恢复")
        }
    }

    private func restore() async {
        guard !busy, let api = workbench.host.api else { return }
        guard !workbench.working else {
            error = String(localized: "Agent 正在运行，等它停下后再回退代码。")
            return
        }
        busy = true
        error = nil
        defer { busy = false }
        let reviewed = changes
        do {
            try await api.restoreCheckpoint(projectId: plan.projectId, checkpointId: plan.checkpointId, expectedChanges: reviewed)
            dismiss()
            onRestored(reviewed.count)
        } catch {
            await handleFailure(error, api: api)
        }
    }

    /// A 409 means the list the reader confirmed is stale: read it again and ask again.
    private func handleFailure(_ failure: Error, api: RiffetApi) async {
        let http = riffetHTTP(failure)
        if http?.code == "CHECKPOINT_EXCLUDED_CHANGES" {
            error = String(localized: "该检查点含有无法安全恢复的文件，服务器拒绝回退。\(failure.riffetMessage)")
            return
        }
        guard http?.status == 409 || http?.code == "CHECKPOINT_CONFLICT" else {
            error = String(localized: "无法回退代码：\(failure.riffetMessage)")
            return
        }
        do {
            let latest = try await api.checkpointChanges(projectId: plan.projectId, checkpointId: plan.checkpointId)
            changes = latest
            self.error = latest.isEmpty
                ? String(localized: "工作区已变化，现在与本轮开始前一致，无需回退。")
                : String(localized: "工作区自上次预览后已改动，服务器拒绝了这次回退。下面是重新读取的改动，确认后再回退。")
        } catch {
            self.error = String(localized: "工作区已变化，回退被拒绝，且无法重新读取改动：\(error.riffetMessage)")
        }
    }
}
