import SwiftUI
import RiffetKit

/// The most attempts one group can have (`MAX_ATTEMPTS` of `Attempts.tsx`; the server takes 2–4).
let maxAttempts = 4

// MARK: - Starting

/// Hands one task to several Agents at once (`AttemptsDialog`): each works in a worktree cut from the
/// same commit, then the results are compared and one is merged back. Starts from the home page's
/// choice for the first row.
struct AttemptsSheet: View {
    private struct Row: Identifiable {
        let id = UUID()
        var choice: LaunchChoice
    }

    let workbench: Workbench
    let projectId: String
    let initial: LaunchChoice
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    /// The full composer, so pasting files, `@` references and `/` commands work here as everywhere.
    @State private var composer: ComposerModel
    @State private var slash: NativeSlashCatalog?
    @State private var rows: [Row] = []

    init(workbench: Workbench, projectId: String, initial: LaunchChoice) {
        self.workbench = workbench
        self.projectId = projectId
        self.initial = initial
        // Loading the draft waits for `onAppear` (as in `HomeView`): `load` saves through
        // `UserDefaults`, and doing that while SwiftUI rebuilds this struct for a parent
        // re-render feeds the `@AppStorage` invalidation back into another rebuild.
        _composer = State(initialValue: ComposerModel())
    }
    @State private var base = ""
    @State private var busy = false
    @State private var error: String?
    /// The id of the last submit and what it asked for. The server tells requests apart by id and
    /// content: the same content under the same id finds the group it already made (a retry after a dropped
    /// response), different content under it is refused, so an edited retry takes a new id.
    @State private var submitted: (requestId: String, fingerprint: Fingerprint)?
    /// Set once the group exists and the server had something to say about it.
    @State private var started: CreateAttemptsResult?

    private struct Fingerprint: Equatable {
        var prompt: String
        var attachments: [String]
        var context: [String]
        var targets: [LaunchChoice]
        var base: String
    }

    private var hasDuplicate: Bool {
        let targets = rows.map(\.choice)
        return Set(targets.map { "\($0.agent ?? "")|\($0.profileId ?? "")|\($0.model ?? "")|\($0.mode ?? "")|\($0.approval ?? "")" }).count != targets.count
    }

    private var ready: Bool {
        composer.canSend && rows.count >= 2 && rows.allSatisfy { $0.choice.agent != nil } && !hasDuplicate
    }

    /// The `/` catalog follows the first row, like the home composer follows its own choice.
    private var slashKey: String {
        let first = rows.first?.choice
        return "\(first?.agent ?? "")|\(first?.profileId ?? "")|\(projectId)|\(workbench.catalogs.connectionRevision)"
    }

    private var features: ComposerFeatures {
        ComposerFeatures(
            slash: slash,
            unknownCommandHint: rows.first?.choice.agent.map { String(localized: "发送给 \(backendLabel($0))") },
            searchFiles: { query in (try? await workbench.host.api?.find(projectId: projectId, query: query)) ?? [] },
            references: workbench.references,
            addReference: { workbench.addReference(path: $0) },
            removeReference: { workbench.removeReference($0) },
            enterSends: workbench.settings?.composerEnterBehavior != "newline",
            menuBelow: true
        )
    }

    var body: some View {
        OrchestrationSheet(
            title: String(localized: "并行尝试"),
            subtitle: String(localized: "各尝试从同一次提交切出独立 Worktree。"),
            confirmTitle: started == nil ? String(localized: "开始 \(rows.count) 个尝试") : String(localized: "打开对比"),
            canConfirm: started != nil || ready,
            busy: busy,
            error: error,
            confirm: { if started == nil { Task { await submit() } } else { openFirst() } }
        ) {
            if let started {
                VStack(alignment: .leading, spacing: Space.xs) {
                    Text("已开始 \(started.group.attempts.count) 个尝试").font(.riffet(size: S(13), weight: .medium)).foregroundStyle(palette.fg)
                    ForEach(started.warnings, id: \.self) { warning in
                        Text(warning).font(.riffet(size: S(12))).foregroundStyle(palette.warning).fixedSize(horizontal: false, vertical: true)
                    }
                }
            } else {
                OrchestrationField(label: String(localized: "任务")) {
                    ComposerView(
                        model: composer,
                        placeholder: String(localized: "描述要完成的任务"),
                        working: false,
                        sendState: nil,
                        features: features,
                        onSend: { _ in Task { await submit() } },
                        onStop: nil,
                        upload: { try await workbench.upload($0, projectId: projectId) }
                    ) { EmptyView() } trailing: { EmptyView() }
                }
                OrchestrationField(label: String(localized: "Agent（已选 \(rows.count) / \(maxAttempts)）")) {
                    VStack(alignment: .leading, spacing: Space.md) {
                        ForEach($rows) { $row in
                            HStack(alignment: .top, spacing: Space.sm) {
                                LaunchTargetPicker(workbench: workbench, choice: $row.choice, projectId: projectId)
                                if rows.count > 2 {
                                    Button { rows.removeAll { $0.id == $row.wrappedValue.id } } label: {
                                        Image(icon: "xmark.circle.fill").font(.riffet(size: S(13)))
                                    }
                                    .buttonStyle(IconButtonStyle(size: 22))
                                    .help("移除这个尝试")
                                }
                            }
                        }
                        if rows.count < maxAttempts {
                            Button { rows.append(Row(choice: nextChoice())) } label: {
                                Label("再加一个", icon: "plus")
                            }
                            .buttonStyle(ChipButtonStyle())
                        }
                    }
                }
                if hasDuplicate {
                    Text("有重复配置").font(.riffet(size: S(12))).foregroundStyle(palette.danger)
                }
                OrchestrationField(label: String(localized: "起点"), hint: String(localized: "未提交改动不在起点内。")) {
                    GitField(placeholder: String(localized: "分支或提交（可选）"), text: $base)
                }
            }
        }
        .onAppear { composer.load(draftKey: "attempts.\(projectId)") }
        .task {
            if workbench.backends.isEmpty { await workbench.loadBackends() }
            if rows.isEmpty {
                rows = [Row(choice: initial), Row(choice: nextChoice(excluding: [initial]))]
            }
        }
        .task(id: slashKey) {
            guard let first = rows.first?.choice, let backend = first.agent else { slash = nil; return }
            slash = await workbench.catalogs.slashCatalog(agent: backend, profileId: first.profileId, projectId: projectId)
        }
        .onDisappear { composer.flushDraft() }
    }

    /// The first available Agent the rows do not use yet, else the home page's one again (a different model is a fine comparison).
    private func nextChoice(excluding extra: [LaunchChoice] = []) -> LaunchChoice {
        let used = Set((rows.map(\.choice) + extra).compactMap(\.agent))
        let unused = workbench.backends.first { $0.isPickable && $0.available && !used.contains($0.agent) }?.agent
        return LaunchChoice(agent: unused ?? initial.agent)
    }

    private func submit() async {
        guard ready, !busy, let api = workbench.host.api else { return }
        busy = true
        error = nil
        defer { busy = false }
        let trimmedBase = base.trimmingCharacters(in: .whitespacesAndNewlines)
        let submission = composer.submission()
        let trimmedPrompt = submission.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let cited = workbench.references
        let fingerprint = Fingerprint(
            prompt: trimmedPrompt, attachments: submission.attachments.map(\.id),
            context: cited.map { "\($0.path)|\($0.line?.intValue ?? 0)" },
            targets: rows.map(\.choice), base: trimmedBase
        )
        let requestId = submitted?.fingerprint == fingerprint ? submitted?.requestId ?? UUID().uuidString : UUID().uuidString
        submitted = (requestId, fingerprint)
        do {
            let result = try await api.createAttempts(
                projectId: projectId, prompt: trimmedPrompt,
                targets: rows.map(\.choice.target), base: trimmedBase.isEmpty ? nil : trimmedBase, requestId: requestId,
                attachments: submission.attachments, context: cited
            )
            workbench.refresh()
            workbench.pageModels.attemptGroups.invalidate(projectId)
            if result.warnings.isEmpty {
                composer.clear(sent: submission)
                cited.forEach { workbench.removeReference($0) }
                dismiss()
                open(result)
            } else {
                started = result
            }
        } catch {
            self.error = error.riffetCode == "INVALID_BASE"
                ? String(localized: "这个项目还没有提交，或起点不存在，无法从同一起点切出 Worktree")
                : String(localized: "无法开始并行尝试：\(error.riffetMessage)")
        }
    }

    private func openFirst() {
        guard let started else { return }
        dismiss()
        open(started)
    }

    private func open(_ result: CreateAttemptsResult) {
        workbench.openAttemptGroup(id: result.group.id, projectId: projectId)
    }
}

// MARK: - Comparing

/// What the strip last read per group, so moving between the attempts of one group does not blank it
/// while the next read is on its way.
@MainActor
enum AttemptComparisonCache {
    static var results: [String: AttemptComparisonResult] = [:]

    static func store(_ result: AttemptComparisonResult) {
        if results.count > 40 { results.removeAll() }
        results[result.group.id] = result
    }
}

struct AdoptRequest: Identifiable {
    let id = UUID()
    let group: AttemptGroup
    let attempt: AttemptComparison
    /// The branch the attempt would be merged into, when the server told us.
    let into: String?
    /// The attempt's worktree still has uncommitted changes, which are committed first.
    let dirty: Bool
}

/// The sibling attempts of this conversation, as a quiet row of tabs above it (`AttemptStrip`). Each
/// attempt is an ordinary conversation, so a tab opens that conversation here; the row adds what
/// comparing needs: who is still working, how much each changed, and which one to keep. Read when the
/// conversation opens and again when its turn ends.
struct AttemptStrip: View {
    let workbench: Workbench
    let session: Session
    let groupId: String
    @Environment(\.palette) private var palette
    @State private var data: AttemptComparisonResult?
    /// The live state of the attempts' conversations, read from the list only when one of them changes.
    @State private var liveStates: [String: SessionState] = [:]
    @State private var adopting: AdoptRequest?
    @State private var preparing = false
    @State private var error: String?

    private var current: AttemptComparison? { shown?.attempts.first { $0.sessionId == session.id } }
    /// The read of another group (kept while the next one loads) is never shown for this one.
    private var shown: AttemptComparisonResult? { data.flatMap { $0.group.id == groupId ? $0 : nil } ?? AttemptComparisonCache.results[groupId] }
    private var attemptIds: [String] { shown?.attempts.map(\.sessionId) ?? [session.id] }
    private var running: Bool { liveState(of: session.id, fallback: session.state).isActive }

    var body: some View {
        HStack(spacing: Space.sm) {
            if let shown {
                Button { workbench.openAttemptGroup(id: shown.group.id, projectId: shown.group.projectId) } label: {
                    HStack(spacing: Space.xs) {
                        Image(icon: "square.split.2x1").font(.riffet(size: S(11)))
                        Text("并行尝试").font(.riffet(size: S(12)))
                        let alive = shown.attempts.filter { attempt in shown.group.attempts.first { $0.sessionId == attempt.sessionId }?.discardedAt == nil }
                        Text("\(alive.filter { (liveStates[$0.sessionId] ?? $0.state ?? .idle).isTerminal }.count)/\(alive.count)")
                            .font(.riffet(size: S(11.5)).monospacedDigit()).foregroundStyle(palette.fg4)
                    }
                }
                .buttonStyle(.plain)
                .foregroundStyle(palette.fg3)
                .help(shown.group.prompt.count > 160 ? "\(shown.group.prompt.prefix(160))…" : shown.group.prompt)
                HStack(spacing: 2) {
                    ForEach(shown.attempts, id: \.sessionId) { attempt in tab(attempt, group: shown.group) }
                }
                .padding(2)
                .background(palette.bgMuted, in: RoundedRectangle(cornerRadius: Radius.container, style: .continuous))
                Spacer(minLength: Space.sm)
                trailing(shown)
            }
        }
        // The height is reserved before the first read lands (later reads hit the cache), so
        // switching between sibling attempts only ever changes the strip's content.
        .frame(minHeight: 34)
        .task(id: "\(groupId)|\(session.id)") { await load() }
        .task(id: attemptIds) {
            let ids = Set(attemptIds)
            await watchSessionList(workbench, read: { list in
                Dictionary(list.sessions.filter { ids.contains($0.id) }.map { ($0.id, $0.state) }, uniquingKeysWith: { first, _ in first })
            }, update: { liveStates = $0 })
        }
        // Diff statistics move when a turn ends.
        .onChange(of: running) { _, now in if !now { Task { await load() } } }
        .sheet(item: $adopting) { request in
            AdoptSheet(workbench: workbench, request: request) { Task { await load() } }
        }
        .alert("无法采用此方案", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("好") {}
        } message: {
            Text(error ?? "")
        }
    }

    private func tab(_ attempt: AttemptComparison, group: AttemptGroup) -> some View {
        let selected = attempt.sessionId == session.id
        let state = liveState(of: attempt.sessionId, fallback: attempt.state ?? .idle)
        return Button {
            if !selected { workbench.open(sessionId: attempt.sessionId) }
        } label: {
            HStack(spacing: Space.xs + 2) {
                AttemptStateDot(state: state)
                Text(attempt.target.agent.map(backendLabel) ?? String(localized: "默认"))
                    .font(.riffet(size: S(12.5), weight: .medium))
                if group.adopted?.sessionId == attempt.sessionId {
                    Image(icon: "checkmark").font(.riffet(size: S(10), weight: .semibold)).foregroundStyle(palette.success).help("已采用")
                }
                if let diff = attempt.comparison {
                    if diff.added > 0 || diff.removed > 0 {
                        HStack(spacing: 3) {
                            Text("+\(diff.added)").foregroundStyle(palette.success)
                            Text("−\(diff.removed)").foregroundStyle(palette.danger)
                        }
                        .font(.riffet(size: S(11)).monospacedDigit())
                    } else {
                        Text("无改动").font(.riffet(size: S(11))).foregroundStyle(palette.fg4)
                    }
                }
            }
            .foregroundStyle(selected ? palette.fg : palette.fg3)
            .padding(.horizontal, Space.sm + 2)
            .frame(height: 26)
            .background(selected ? palette.bgElevated : .clear, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
            .overlay { if selected { RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(palette.lineStrong, lineWidth: 0.5) } }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(attempt.error ?? attempt.branch)
    }

    @ViewBuilder
    private func trailing(_ shown: AttemptComparisonResult) -> some View {
        if let adopted = shown.group.adopted {
            if adopted.sessionId == session.id {
                Label("已采用", icon: "checkmark").font(.riffet(size: S(12))).foregroundStyle(palette.success)
            }
        } else if let current {
            HStack(spacing: Space.xs) {
                if preparing { Spinner(size: .mini) }
                Button { Task { await prepareAdopt(current, group: shown.group) } } label: {
                    Label("采用此方案", icon: "arrow.triangle.merge")
                }
                .buttonStyle(ChipButtonStyle())
                .disabled(preparing || running || (current.comparison?.files.isEmpty ?? true))
                .help(running ? "等这个尝试完成后再采用" : "把这个尝试的改动合并回原项目")
            }
        }
    }

    private func load() async {
        guard let api = workbench.host.api else { return }
        // The strip is an aid; the conversation works without it.
        guard let result = try? await api.compareAttempts(groupId: groupId), !Task.isCancelled else { return }
        AttemptComparisonCache.store(result)
        data = result
    }

    private func prepareAdopt(_ attempt: AttemptComparison, group: AttemptGroup) async {
        guard !preparing, let api = workbench.host.api else { return }
        preparing = true
        defer { preparing = false }
        do {
            let into = try? await api.gitBranch(projectId: group.projectId).branch
            let status = try await api.gitStatus(projectId: attempt.projectId, fresh: false)
            adopting = AdoptRequest(group: group, attempt: attempt, into: into, dirty: !status.entries.isEmpty)
        } catch {
            self.error = String(localized: "无法读取这个尝试的改动：\(error.riffetMessage)")
        }
    }

    /// The conversation's live state from the list, which moves before the comparison is read again.
    private func liveState(of id: String, fallback: SessionState) -> SessionState {
        liveStates[id] ?? fallback
    }
}

/// A coloured dot for an attempt: a spinner while it works, amber when it waits, red when it stopped
/// short, a ring when it is done.
struct AttemptStateDot: View {
    let state: SessionState
    @Environment(\.palette) private var palette

    var body: some View {
        Group {
            switch state {
            case .running, .starting, .cancelling:
                Spinner(size: .mini)
            case .waiting:
                Circle().fill(palette.warning).frame(width: 7, height: 7)
            case .failed, .interrupted:
                Circle().fill(palette.danger).frame(width: 7, height: 7)
            default:
                Circle().strokeBorder(palette.success, lineWidth: 1.5).frame(width: 8, height: 8)
            }
        }
        .frame(width: 12, height: 12)
    }
}

// MARK: - Adopting

/// Merges the chosen attempt's branch back into the original project (`MergeDialog`). A conflict
/// abandons the whole merge, so nothing half-merged is left behind.
struct AdoptSheet: View {
    let workbench: Workbench
    let request: AdoptRequest
    let onAdopted: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var strategy = "squash"
    @State private var message = ""
    @State private var pending = ""
    @State private var remove = false
    @State private var cleanup = "remove"
    @State private var busy = false
    @State private var error: String?
    /// Set when the merge landed but the cleanup kept something; the sheet stays open to say so.
    @State private var keptWarnings: [String]?
    @Environment(\.palette) private var palette

    private var label: String { request.attempt.target.agent.map(backendLabel) ?? String(localized: "默认 Agent") }
    private var target: String { request.into ?? String(localized: "原项目的当前分支") }
    private var defaultMessage: String {
        let firstLine = request.group.prompt.split(separator: "\n", omittingEmptySubsequences: true).first.map(String.init) ?? request.group.prompt
        return "\(firstLine.prefix(72)) (\(request.attempt.target.agent ?? "attempt"))"
    }

    var body: some View {
        OrchestrationSheet(
            title: String(localized: "采用 \(label) 的方案"),
            subtitle: "\(request.attempt.branch) → \(target)",
            confirmTitle: keptWarnings == nil ? String(localized: "合并") : String(localized: "完成"),
            canConfirm: true,
            busy: busy,
            error: error,
            confirm: { if keptWarnings == nil { Task { await submit() } } else { dismiss(); onAdopted() } }
        ) {
            if let keptWarnings {
                VStack(alignment: .leading, spacing: Space.xs) {
                    Text("已合并，部分 Worktree 未能移除：").font(.riffet(size: S(12.5))).foregroundStyle(palette.fg2)
                    ForEach(keptWarnings, id: \.self) { warning in
                        Text(warning).font(.riffet(size: S(12))).foregroundStyle(palette.warning).fixedSize(horizontal: false, vertical: true)
                    }
                }
            } else {
            SegmentedTrack(selection: $strategy) {
                Text("压缩为一个提交").tag("squash")
                Text("保留全部提交").tag("merge")
            }
            OrchestrationField(label: String(localized: "提交说明")) {
                GitField(placeholder: defaultMessage, text: $message)
            }
            if request.dirty {
                OrchestrationField(label: String(localized: "未提交的改动"), hint: String(localized: "Worktree 里还有未提交的改动，会先用这条说明提交。")) {
                    GitField(placeholder: "WIP on \(request.attempt.branch)", text: $pending)
                }
            }
            OrchestrationToggle(title: String(localized: "合并后移除 Worktree"), detail: String(localized: "分支保留。"), isOn: $remove)
            OrchestrationField(label: String(localized: "其余尝试"), hint: cleanup == "remove" ? String(localized: "有未提交改动时保留其项目。") : nil) {
                SegmentedTrack(selection: $cleanup) {
                    Text("保留").tag("keep")
                    Text("归档").tag("archive")
                    Text("归档并删除 Worktree").tag("remove")
                }
            }
            }
        }
    }

    private func submit() async {
        guard !busy, let api = workbench.host.api else { return }
        busy = true
        error = nil
        defer { busy = false }
        let trimmedMessage = message.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedPending = pending.trimmingCharacters(in: .whitespacesAndNewlines)
        let body = AdoptAttemptBody(
            sessionId: request.attempt.sessionId, strategy: strategy,
            message: trimmedMessage.isEmpty ? nil : trimmedMessage,
            commitPending: request.dirty ? (trimmedPending.isEmpty ? "WIP on \(request.attempt.branch)" : trimmedPending) : nil,
            removeWorktree: remove,
            cleanup: cleanup
        )
        do {
            let result = try await api.adoptAttempt(groupId: request.group.id, body: body)
            workbench.refresh()
            if result.warnings.isEmpty {
                dismiss()
                onAdopted()
            } else {
                keptWarnings = result.warnings
            }
        } catch {
            switch error.riffetCode {
            case "MERGE_CONFLICT": self.error = String(localized: "有冲突，已放弃合并。可以让 Agent 在 Worktree 里先合入 \(target) 并解决冲突，再回来采用。")
            case "MERGE_TARGET_DIRTY": self.error = String(localized: "\(target) 有未提交的改动，先在原项目里提交或暂存它们")
            default: self.error = String(localized: "合并失败：\(error.riffetMessage)")
            }
        }
    }
}
