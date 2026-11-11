import SwiftUI
import RiffetKit

/// The comparison page of one attempt group: a card per attempt, a file matrix under them, and the
/// group's whole lifecycle (stop, retry, add, discard, adopt) without leaving the page.
struct AttemptGroupView: View {
    let workbench: Workbench
    let groupId: String
    let projectId: String
    @Environment(\.palette) private var palette
    @State private var data: AttemptComparisonResult?
    @State private var liveStates: [String: SessionState] = [:]
    @State private var adopting: AdoptRequest?
    @State private var adding = false
    @State private var addChoice = LaunchChoice()
    @State private var discarding: AttemptComparison?
    @State private var busyAction: String?
    @State private var error: String?
    /// A finished action the reader should know about (a kept worktree), not a failure.
    @State private var notice: String?

    private var shown: AttemptComparisonResult? { data.flatMap { $0.group.id == groupId ? $0 : nil } ?? AttemptComparisonCache.results[groupId] }
    private var alive: [AttemptComparison] { (shown?.attempts ?? []).filter { attempt in shown?.group.attempts.first { $0.sessionId == attempt.sessionId }?.discardedAt == nil } }
    private var discardedCount: Int { (shown?.attempts.count ?? 0) - alive.count }
    private var adoptedId: String? { shown?.group.adopted?.sessionId }
    private var doneCount: Int { alive.filter { state(of: $0).isTerminal }.count }
    private var anyActive: Bool { alive.contains { state(of: $0).isActive } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.lg) {
                if let shown {
                    header(shown)
                    if adoptedId != nil {
                        Label("已合并到原项目", icon: "checkmark.circle.fill")
                            .font(.riffet(size: S(13), weight: .medium)).foregroundStyle(palette.success)
                    } else if !alive.isEmpty, doneCount == alive.count {
                        HStack(spacing: Space.sm) {
                            Image(icon: "checkmark.circle").foregroundStyle(palette.success)
                            Text("全部结束").font(.riffet(size: S(13), weight: .medium))
                            Spacer()
                            if let recommended = recommendedAttempt {
                                Button("采用推荐") { Task { await prepareAdopt(recommended, group: shown.group) } }
                                    .buttonStyle(ChipButtonStyle())
                            }
                        }
                        .padding(Space.md)
                        .background(palette.bgSubtle, in: RoundedRectangle(cornerRadius: Radius.container, style: .continuous))
                    }
                    cards(shown)
                    if alive.count > 1 { matrix(shown) }
                    if discardedCount > 0 {
                        Text("已丢弃 \(discardedCount) 个").font(.riffet(size: S(12))).foregroundStyle(palette.fg4)
                    }
                } else {
                    Spinner(size: .small).frame(maxWidth: .infinity).padding(.top, 80)
                }
                if let error {
                    Text(error).font(.riffet(size: S(12.5))).foregroundStyle(palette.danger).textSelection(.enabled)
                }
            }
            .frame(maxWidth: 1080)
            .padding(.horizontal, Space.xxl)
            .padding(.vertical, Space.xl)
            .frame(maxWidth: .infinity)
        }
        .task(id: groupId) { await load() }
        .task(id: alive.map(\.sessionId)) {
            let ids = Set(alive.map(\.sessionId))
            await watchSessionList(workbench, read: { list in
                Dictionary(list.sessions.filter { ids.contains($0.id) }.map { ($0.id, $0.state) }, uniquingKeysWith: { first, _ in first })
            }, update: { new in
                let changed = new != liveStates
                liveStates = new
                if changed, new.values.contains(where: { $0.isTerminal }) { Task { await load() } }
            })
        }
        .sheet(item: $adopting) { request in
            AdoptSheet(workbench: workbench, request: request) { Task { await load() } }
        }
        .sheet(isPresented: $adding) { addSheet }
        .confirmationDialog("丢弃这个尝试？", isPresented: Binding(get: { discarding != nil }, set: { if !$0 { discarding = nil } }), titleVisibility: .visible) {
            Button("丢弃", role: .destructive) {
                if let attempt = discarding { Task { await discard(attempt) } }
                discarding = nil
            }
            Button("取消", role: .cancel) { discarding = nil }
        } message: {
            Text("会话会归档，Worktree 有未提交改动时保留。")
        }
        .alert("操作失败", isPresented: Binding(get: { error != nil && adopting == nil }, set: { if !$0 { error = nil } })) {
            Button("好") { error = nil }
        } message: { Text(error ?? "") }
        .alert("已丢弃", isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })) {
            Button("好") { notice = nil }
        } message: { Text(notice ?? "") }
    }

    // MARK: Header

    private func header(_ shown: AttemptComparisonResult) -> some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            HStack(alignment: .top, spacing: Space.md) {
                VStack(alignment: .leading, spacing: Space.xs) {
                    Text(shown.group.prompt)
                        .font(.riffet(size: S(16), weight: .semibold)).foregroundStyle(palette.fg)
                        .lineLimit(3).fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: Space.sm) {
                        Text("\(doneCount)/\(alive.count)")
                            .font(.riffet(size: S(12)).monospacedDigit()).foregroundStyle(palette.fg3)
                        Text(String(shown.group.base.prefix(8))).font(.riffet(size: S(11.5), design: .monospaced)).foregroundStyle(palette.fg4)
                        if let name = workbench.project(projectId)?.name {
                            Text(name).font(.riffet(size: S(12))).foregroundStyle(palette.fg3)
                        }
                    }
                }
                Spacer(minLength: Space.md)
                if anyActive {
                    Button("停止全部") { Task { await stopAll() } }.buttonStyle(ChipButtonStyle())
                }
                if adoptedId == nil, alive.count < maxAttempts {
                    Button { addChoice = LaunchChoice(agent: workbench.backends.first { $0.isPickable && $0.available }?.agent); adding = true } label: {
                        Label("追加", icon: "plus")
                    }
                    .buttonStyle(ChipButtonStyle())
                }
                Button { Task { await load() } } label: { Image(icon: "arrow.clockwise") }
                    .buttonStyle(IconButtonStyle(size: 26))
                    .help("刷新")
            }
            ProgressView(value: alive.isEmpty ? 0 : Double(doneCount) / Double(alive.count))
                .progressViewStyle(.linear).tint(palette.accent)
        }
    }

    // MARK: Cards

    private func cards(_ shown: AttemptComparisonResult) -> some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 320), spacing: Space.md)], alignment: .leading, spacing: Space.md) {
            ForEach(alive, id: \.sessionId) { attempt in
                card(attempt, group: shown.group)
            }
        }
    }

    private func card(_ attempt: AttemptComparison, group: AttemptGroup) -> some View {
        let state = state(of: attempt)
        let isAdopted = adoptedId == attempt.sessionId
        let isRecommended = adoptedId == nil && recommendedAttempt?.sessionId == attempt.sessionId
        return VStack(alignment: .leading, spacing: Space.sm) {
            HStack(spacing: Space.sm) {
                AttemptStateDot(state: state)
                Text(title(of: attempt)).font(.riffet(size: S(13.5), weight: .semibold)).foregroundStyle(palette.fg).lineLimit(1)
                if isAdopted {
                    Text("已采用").font(.riffet(size: S(11), weight: .semibold)).foregroundStyle(palette.success)
                } else if isRecommended {
                    Text("推荐").font(.riffet(size: S(11), weight: .semibold)).foregroundStyle(palette.accent).help("已完成里改动最小")
                }
                Spacer(minLength: 0)
                Text(stateLabel(state)).font(.riffet(size: S(12))).foregroundStyle(state.isActive ? palette.accent : palette.fg3)
            }
            Text(attempt.branch).font(.riffet(size: S(11), design: .monospaced)).foregroundStyle(palette.fg4).lineLimit(1).truncationMode(.middle)
            if let attemptError = attempt.error {
                Text(attemptError).font(.riffet(size: S(12))).foregroundStyle(palette.danger).lineLimit(3)
            }
            if let diff = attempt.comparison {
                HStack(spacing: Space.md) {
                    HStack(spacing: 3) {
                        Text("+\(diff.added)").foregroundStyle(palette.success)
                        Text("−\(diff.removed)").foregroundStyle(palette.danger)
                    }
                    Text("\(diff.files.count) 个文件").foregroundStyle(palette.fg3)
                    if diff.commits > 0 { Text("\(diff.commits) 个提交").foregroundStyle(palette.fg3) }
                    if overlapCount(of: attempt) > 0 {
                        Text("\(overlapCount(of: attempt)) 个文件与其他尝试重叠").foregroundStyle(palette.warning)
                    }
                }
                .font(.riffet(size: S(12)).monospacedDigit())
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(diff.files.prefix(5), id: \.path) { file in
                        HStack(spacing: Space.sm) {
                            Text((file.path as NSString).lastPathComponent)
                                .font(.riffet(size: S(11.5), design: .monospaced)).foregroundStyle(palette.fg2).lineLimit(1)
                            Spacer(minLength: Space.sm)
                            HStack(spacing: 3) {
                                if let added = file.added { Text("+\(added)").foregroundStyle(palette.success) }
                                if let removed = file.removed { Text("−\(removed)").foregroundStyle(palette.danger) }
                            }
                            .font(.riffet(size: S(11)).monospacedDigit())
                        }
                    }
                    if diff.files.count > 5 {
                        Text("还有 \(diff.files.count - 5) 个").font(.riffet(size: S(11.5))).foregroundStyle(palette.fg4)
                    }
                }
            }
            Spacer(minLength: 0)
            HStack(spacing: Space.xs) {
                Button("打开") { workbench.open(sessionId: attempt.sessionId) }.buttonStyle(ChipButtonStyle())
                if state.isActive {
                    Button("停止") { Task { await stop(attempt) } }.buttonStyle(ChipButtonStyle())
                } else if state == .failed || state == .interrupted {
                    Button("重试") { Task { await retry(attempt) } }.buttonStyle(ChipButtonStyle())
                }
                Spacer(minLength: 0)
                if adoptedId == nil {
                    if !isAdopted {
                        Button("丢弃") { discarding = attempt }.buttonStyle(ChipButtonStyle())
                    }
                    Button("采用") { Task { await prepareAdopt(attempt, group: group) } }
                        .buttonStyle(ChipButtonStyle())
                        .disabled(state.isActive || (attempt.comparison?.files.isEmpty ?? true) || busyAction != nil)
                }
            }
        }
        .padding(Space.md)
        .frame(maxWidth: .infinity, minHeight: 196, alignment: .topLeading)
        .background(palette.bgElevated, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(isAdopted ? palette.success : isRecommended ? palette.accent : palette.line, lineWidth: isAdopted || isRecommended ? 1 : 0.5))
    }

    // MARK: Matrix

    private func matrix(_ shown: AttemptComparisonResult) -> some View {
        let files = unionFiles
        return VStack(alignment: .leading, spacing: Space.sm) {
            Text("文件").font(.riffet(size: S(13), weight: .semibold)).foregroundStyle(palette.fg)
            VStack(spacing: 0) {
                ForEach(files, id: \.self) { path in
                    HStack(spacing: Space.sm) {
                        Text(path).font(.riffet(size: S(11.5), design: .monospaced)).foregroundStyle(palette.fg2)
                            .lineLimit(1).truncationMode(.middle).frame(maxWidth: 300, alignment: .leading)
                        if attemptsChanging(path).count > 1 {
                            Image(icon: "exclamationmark.triangle.fill").font(.riffet(size: S(10))).foregroundStyle(palette.warning)
                        }
                        Spacer(minLength: Space.sm)
                        ForEach(alive, id: \.sessionId) { attempt in
                            if let file = attempt.comparison?.files.first(where: { $0.path == path }) {
                                HStack(spacing: 3) {
                                    Text(file.added.map { "+\($0)" } ?? "").foregroundStyle(palette.success)
                                    Text(file.removed.map { "−\($0)" } ?? "").foregroundStyle(palette.danger)
                                }
                                .font(.riffet(size: S(11)).monospacedDigit())
                                .frame(width: 92, alignment: .trailing)
                            } else {
                                Text("—").font(.riffet(size: S(11))).foregroundStyle(palette.fg4).frame(width: 92, alignment: .trailing)
                            }
                        }
                    }
                    .padding(.vertical, 5)
                    Divider()
                }
            }
        }
    }

    // MARK: Add sheet

    private var addSheet: some View {
        OrchestrationSheet(
            title: String(localized: "追加尝试"),
            subtitle: shown.map { String($0.group.prompt.prefix(80)) } ?? "",
            confirmTitle: String(localized: "开始"),
            canConfirm: addChoice.agent != nil,
            busy: busyAction != nil,
            error: error,
            confirm: { Task { await add() } }
        ) {
            LaunchTargetPicker(workbench: workbench, choice: $addChoice, projectId: projectId, allowsDefault: false)
        }
    }

    // MARK: Derived

    private var unionFiles: [String] {
        Array(Set(alive.flatMap { $0.comparison?.files.map(\.path) ?? [] })).sorted()
    }

    private func attemptsChanging(_ path: String) -> [AttemptComparison] {
        alive.filter { $0.comparison?.files.contains { $0.path == path } ?? false }
    }

    private func overlapCount(of attempt: AttemptComparison) -> Int {
        (attempt.comparison?.files ?? []).filter { attemptsChanging($0.path).count > 1 }.count
    }

    /// Done, readable, and the smallest change: a tiebreaker, not a verdict.
    private var recommendedAttempt: AttemptComparison? {
        alive.filter { state(of: $0) == .idle && !($0.comparison?.files.isEmpty ?? true) }
            .min { ($0.comparison?.added ?? 0) + ($0.comparison?.removed ?? 0) < ($1.comparison?.added ?? 0) + ($1.comparison?.removed ?? 0) }
    }

    private func state(of attempt: AttemptComparison) -> SessionState {
        liveStates[attempt.sessionId] ?? attempt.state ?? .idle
    }

    private func title(of attempt: AttemptComparison) -> String {
        let agent = attempt.target.agent.map(backendLabel) ?? String(localized: "默认")
        if let model = attempt.target.model, !model.isEmpty { return "\(agent) · \(model)" }
        return agent
    }

    private func stateLabel(_ state: SessionState) -> String {
        switch state {
        case .running, .starting: String(localized: "运行中")
        case .waiting: String(localized: "待处理")
        case .cancelling: String(localized: "停止中")
        case .failed: String(localized: "失败")
        case .interrupted: String(localized: "已中断")
        case .archived: String(localized: "已归档")
        default: String(localized: "已完成")
        }
    }

    // MARK: Actions

    private func load() async {
        guard let api = workbench.host.api else { return }
        guard let result = try? await api.compareAttempts(groupId: groupId), !Task.isCancelled else { return }
        AttemptComparisonCache.store(result)
        data = result
    }

    private func prepareAdopt(_ attempt: AttemptComparison, group: AttemptGroup) async {
        guard busyAction == nil, let api = workbench.host.api else { return }
        busyAction = attempt.sessionId
        defer { busyAction = nil }
        do {
            let into = try? await api.gitBranch(projectId: group.projectId).branch
            let status = try await api.gitStatus(projectId: attempt.projectId)
            adopting = AdoptRequest(group: group, attempt: attempt, into: into, dirty: !status.entries.isEmpty)
        } catch {
            self.error = String(localized: "无法读取这个尝试的改动：\(error.riffetMessage)")
        }
    }

    private func stop(_ attempt: AttemptComparison) async {
        guard let api = workbench.host.api else { return }
        try? await workbench.store.interruptFor(sessionId: attempt.sessionId)
        await load()
    }

    private func stopAll() async {
        guard let api = workbench.host.api else { return }
        for attempt in alive where state(of: attempt).isActive {
            try? await workbench.store.interruptFor(sessionId: attempt.sessionId)
        }
        await load()
    }

    private func retry(_ attempt: AttemptComparison) async {
        guard busyAction == nil, let api = workbench.host.api, let shown else { return }
        busyAction = attempt.sessionId
        defer { busyAction = nil }
        do {
            // Discard first: the group size limit counts attempts that are not discarded yet.
            _ = try await api.discardAttempt(groupId: shown.group.id, sessionId: attempt.sessionId, removeWorktree: true)
            _ = try await api.addAttempt(groupId: shown.group.id, target: attempt.target)
            workbench.refresh()
            await load()
        } catch {
            self.error = String(localized: "无法重试：\(error.riffetMessage)")
        }
    }

    private func discard(_ attempt: AttemptComparison) async {
        guard let api = workbench.host.api, let shown else { return }
        do {
            if state(of: attempt).isActive { try? await workbench.store.interruptFor(sessionId: attempt.sessionId) }
            let result = try await api.discardAttempt(groupId: shown.group.id, sessionId: attempt.sessionId, removeWorktree: true)
            if let warning = result.warnings.first { notice = warning }
            workbench.refresh()
            await load()
        } catch {
            self.error = String(localized: "无法丢弃：\(error.riffetMessage)")
        }
    }

    private func add() async {
        guard busyAction == nil, let api = workbench.host.api, let shown else { return }
        busyAction = "add"
        defer { busyAction = nil }
        do {
            _ = try await api.addAttempt(groupId: shown.group.id, target: addChoice.target)
            adding = false
            workbench.refresh()
            await load()
        } catch {
            self.error = String(localized: "无法追加：\(error.riffetMessage)")
        }
    }
}

/// The attempt groups of one project, newest first. The way back to a group whose conversations
/// were closed.
struct AttemptsHistorySection: View {
    let workbench: Workbench
    let projectId: String
    @Environment(\.palette) private var palette

    var body: some View {
        // Kept by the workbench: shown at once on a return to the home page, then read again.
        let groups = workbench.pageModels.attemptGroups.groups[projectId] ?? []
        Group {
            if !groups.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    Text("并行尝试")
                        .font(.riffet(size: S(11.5), weight: .semibold)).foregroundStyle(palette.fg3)
                        .padding(.bottom, Space.xs).padding(.leading, Space.xs)
                    ForEach(groups.prefix(5), id: \.id) { group in
                        Button { workbench.openAttemptGroup(id: group.id, projectId: projectId) } label: {
                            HStack(spacing: Space.sm) {
                                Image(icon: "square.split.2x1").font(.riffet(size: S(12))).foregroundStyle(palette.fg3)
                                Text(group.prompt).font(.riffet(size: S(12.5))).foregroundStyle(palette.fg).lineLimit(1)
                                Spacer(minLength: Space.sm)
                                if group.adopted != nil {
                                    Image(icon: "checkmark").font(.riffet(size: S(11), weight: .semibold)).foregroundStyle(palette.success)
                                }
                                Text("\(group.attempts.filter { $0.discardedAt == nil }.count)")
                                    .font(.riffet(size: S(11.5)).monospacedDigit()).foregroundStyle(palette.fg4)
                            }
                            .padding(.horizontal, Space.sm).padding(.vertical, 6)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(HoverRowStyle(radius: 8))
                    }
                }
                .padding(.top, Space.xxl)
            }
        }
        .task(id: projectId) {
            await workbench.pageModels.attemptGroups.load(projectId, api: workbench.host.api)
        }
    }
}

extension SessionState {
    var isTerminal: Bool {
        switch self {
        case .idle, .failed, .interrupted, .archived: true
        default: false
        }
    }
}
