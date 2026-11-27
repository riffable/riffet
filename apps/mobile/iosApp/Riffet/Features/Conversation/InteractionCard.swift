import SwiftUI
import Observation
import RiffetKit

/// The card's state is shared during this app run; receipts of unsettled answers survive process termination.
/// The card is composed twice while a subagent sheet covers the conversation,
/// and the two compositions must share one draft and one submission.
@MainActor @Observable
final class InteractionDrafts {
    static let shared = InteractionDrafts()

    /// The latest state of each card (`InteractionCard.kt`), as its last transition left it. Views
    /// render it from here, so every composition of a card shows the one state its requests update.
    private var cards: [String: InteractionCardState] = [:]
    /// Keys from least to most recently stored, so the oldest settled card is the one that goes.
    @ObservationIgnored private var recency: [String] = []
    private static let kept = 8
    private struct Draft: Codable, Equatable {
        var revision: String
        var selected: [String]
        var other: String
    }
    private struct Pending: Codable, Equatable {
        enum Phase: String, Codable {
            case posting, unknown, uncertain, stale, success
            /// Only an answer whose result is still open is kept as a receipt.
            init?(_ phase: SubmissionPhase) {
                switch phase {
                case .posting: self = .posting
                case .unknown: self = .unknown
                case .uncertain: self = .uncertain
                default: return nil
                }
            }
            var value: SubmissionPhase {
                switch self {
                case .posting: .posting
                case .unknown: .unknown
                case .uncertain: .uncertain
                case .stale: .stale
                case .success: .success
                }
            }
        }
        let revision: String
        let requestID: String
        let action: String
        let selectedIDs: [String]?
        let otherText: String?
        let phase: Phase
        let draft: Draft
        let interaction: InteractionSnapshot?
    }

    /// Only presentation fields are retained. The wire response remains the exact saved receipt.
    private struct InteractionSnapshot: Codable, Equatable {
        struct Option: Codable, Equatable { let id: String; let label: String; let selected: Bool }
        struct Action: Codable, Equatable { let id: String; let label: String; let tone: String?; let shortLabel: String?; let detail: String? }
        let id: String, revision: String, kind: String, title: String
        let transport: String?, terminalID: String?, epoch: Int64?, requestID: String?
        let message: String?, multiple: Bool?, allowOther: Bool?, otherValue: String?, otherSelected: Bool?
        let questionIndex: Int64?, questionCount: Int64?, expiresAt: String?, extendableUntil: String?
        let options: [Option]
        let actions: [Action]
        init(_ value: NativeInteraction) {
            id = value.id; revision = value.revision; kind = value.kind.name; title = value.title
            transport = value.transport; terminalID = value.terminalId; epoch = value.epoch?.int64Value; requestID = value.requestId
            message = value.message; multiple = value.multiple?.boolValue; allowOther = value.allowOther?.boolValue
            otherValue = value.otherValue; otherSelected = value.otherSelected?.boolValue
            questionIndex = value.questionIndex?.int64Value; questionCount = value.questionCount?.int64Value
            expiresAt = value.expiresAt; extendableUntil = value.extendableUntil
            options = value.options.map { .init(id: $0.id, label: $0.label, selected: $0.selected) }
            actions = value.actions.map { .init(id: $0.id, label: $0.label, tone: $0.tone, shortLabel: $0.shortLabel, detail: $0.detail) }
        }
        var value: NativeInteraction? {
            let kinds: [NativeInteractionKind] = [.permission, .question, .plan, .confirmation, .choice]
            guard let kind = kinds.first(where: { $0.name == self.kind }) else { return nil }
            return NativeInteraction(id: id, revision: revision, transport: transport, terminalId: terminalID,
                epoch: epoch.map { KotlinLong(value: $0) }, requestId: requestID, request: nil, kind: kind,
                title: title, message: message, options: options.map { NativeInteractionOption(id: $0.id, label: $0.label, selected: $0.selected) },
                multiple: multiple.map { KotlinBoolean(bool: $0) }, allowOther: allowOther.map { KotlinBoolean(bool: $0) },
                otherValue: otherValue, otherSelected: otherSelected.map { KotlinBoolean(bool: $0) },
                questionIndex: questionIndex.map { KotlinLong(value: $0) }, questionCount: questionCount.map { KotlinLong(value: $0) },
                actions: actions.map { NativeInteractionAction(id: $0.id, label: $0.label, tone: $0.tone, shortLabel: $0.shortLabel, detail: $0.detail) },
                expiresAt: expiresAt, extendableUntil: extendableUntil)
        }
    }
    private let receiptsKey = "riffet.ios.pending-interaction-receipts.v1"
    private var receipts: [String: Pending] = [:]
    private var inFlight: Set<String> = []
    func beginSubmission(for key: String) -> Bool { inFlight.insert(key).inserted }
    func endSubmission(for key: String) { inFlight.remove(key) }
    private init() {
        if let data = UserDefaults.standard.data(forKey: receiptsKey), let saved = try? JSONDecoder().decode([String: Pending].self, from: data) { receipts = saved }
    }

    /// The card as it first mounts in this process: an answer persisted before the app went away
    /// comes back through the reducer (POSTING turns UNKNOWN, since no request is awaiting it now).
    func initial(_ interaction: NativeInteraction, for key: String) -> InteractionCardState {
        restoreInteractionCard(interaction: interaction, savedDraft: nil, savedSubmission: receipt(for: key, interaction: interaction))
    }

    /// The card as it mounts or as the server redraws it. A stored card, and one whose request is
    /// still out, is only redrawn, never restored over.
    func show(_ interaction: NativeInteraction, for key: String) {
        if let current = cards[key] { set(key, current.interactionChanged(next: interaction)) }
        else if !inFlight.contains(key) { set(key, initial(interaction, for: key)) }
    }

    func state(for key: String) -> InteractionCardState? { cards[key] }

    /// Applies a transition to the card's state as it is now, which may have moved on since it began.
    func update(_ key: String, _ transition: (InteractionCardState) -> InteractionCardState) {
        if let current = cards[key] { set(key, transition(current)) }
    }

    private func set(_ key: String, _ state: InteractionCardState) {
        if cards[key] != state { cards[key] = state }
        remember(key)
        var pending: Pending?
        if let submission = state.submission, let phase = Pending.Phase(submission.phase) {
            let draft = submission.draft
            pending = Pending(revision: submission.request.revision, requestID: submission.request.requestId,
                              action: submission.request.action, selectedIDs: submission.request.selectedIds,
                              otherText: submission.request.otherText, phase: phase,
                              draft: Draft(revision: draft.revision, selected: draft.selectedIds, other: draft.otherText),
                              interaction: InteractionSnapshot(submission.interaction))
        }
        guard receipts[key] != pending else { return }
        receipts[key] = pending
        persist()
    }

    /// Keeps the most recent cards. One whose request is out or whose answer is unsettled stays,
    /// since its retry and the ledger depend on it.
    private func remember(_ key: String) {
        if recency.last != key {
            recency.removeAll { $0 == key }
            recency.append(key)
        }
        var index = 0
        while recency.count > Self.kept, index < recency.count {
            let old = recency[index]
            if old == key || inFlight.contains(old) || cards[old]?.frozen == true { index += 1; continue }
            recency.remove(at: index)
            cards[old] = nil
        }
    }

    private func receipt(for key: String, interaction: NativeInteraction) -> InteractionSubmission? {
        guard let pending = receipts[key], pending.revision == interaction.revision else { return nil }
        let request = NativeInteractionResponse(interactionId: interaction.id, revision: pending.revision,
            requestId: pending.requestID, action: pending.action, selectedIds: pending.selectedIDs, otherText: pending.otherText)
        return InteractionSubmission(phase: pending.phase.value, interaction: interaction, request: request,
            draft: InteractionDraft(revision: pending.draft.revision, selectedIds: pending.draft.selected, otherText: pending.draft.other),
            message: nil)
    }
    func hasPendingSubmission(for key: String) -> Bool { receipts[key] != nil }
    func pendingInteractions(server: String, session: String) -> [NativeInteraction] {
        let prefix = "\(server):\(session):"
        return receipts.filter { $0.key.hasPrefix(prefix) }.compactMap { $0.value.interaction?.value }
    }
    private func persist() {
        if receipts.isEmpty { UserDefaults.standard.removeObject(forKey: receiptsKey) }
        else if let data = try? JSONEncoder().encode(receipts) { UserDefaults.standard.set(data, forKey: receiptsKey) }
    }
}

/// The dialog the CLI is waiting on: approvals, questions, plan reviews. Its state is the shared
/// state machine (`InteractionCard.kt`) every client runs. A request whose fate is unknown can be
/// retried with the same request id; a refused (409) or unconfirmed one offers 同步 and the terminal.
struct InteractionCardView: View {
    let workbench: Workbench
    let interaction: NativeInteraction
    var sessionID: String? = nil
    var openTerminal: (() -> Void)?
    /// Settled ledger records reuse the reader while keeping every submit path disabled.
    var readOnly = false
    var confirmed = false
    var result: String? = nil
    @Environment(\.palette) private var palette
    var onSubmitted: ((NativeInteractionResult) -> Void)? = nil
    /// Docked above the composer, the card folds to one line from the end of its title row.
    var onCollapse: (() -> Void)? = nil
    /// Why this device held an answer back (device verification, a moved session, expiry) or failed on its own.
    @State private var localNotice: String?
    @State private var localError: String?
    @State private var now = Date()
    @State private var extending = false
    @State private var authenticating = false
    /// The action this device is sending; nil while the send is a retry.
    @State private var tappedAction: String?
    @State private var showingDetails = false
    @State private var selectedAction: String?
    @AppStorage("riffet.ios.biometricApprovals") private var requireTouchID = false
    private let drafts = InteractionDrafts.shared

    private var key: String { "\(workbench.baseURL.absoluteString):\(sessionID ?? workbench.selected?.id ?? ""):\(interaction.id)" }
    private var connected: Bool { workbench.connection is RiffetConnectionStateLive && workbench.selected?.archivedAt == nil && (sessionID == nil || workbench.selected?.id == sessionID) }
    private var expires: Date? { ServerTime.date(shown.expiresAt) }
    private var expired: Bool { expires.map { $0 <= now } ?? false }
    private var card: InteractionCardState { drafts.state(for: key) ?? drafts.initial(interaction, for: key) }
    private var submission: InteractionSubmission? { card.submission }
    /// The reducer's busy, plus what only this device knows: verifying the reader, extending, expiry.
    private var busy: Bool { readOnly || card.busy || authenticating || extending || expired }
    private var shown: NativeInteraction { readOnly ? interaction : card.shown }
    private var current: InteractionDraft { card.currentDraft }
    private var isQuestion: Bool { shown.kind == .question }
    private var selectsOptions: Bool { interactionSelectsOptions(interaction: shown) }
    /// The action whose button shows progress: the one being verified, then the one being posted.
    private var inFlightAction: String? {
        authenticating ? tappedAction : submission?.phase == .posting ? submission?.request.action : nil
    }
    private var retryInFlight: Bool { authenticating && tappedAction == nil }
    private var sending: Bool { authenticating || submission?.phase == .posting }
    /// The summary shows buttons for the quick approval and the refusal only; a send from anywhere else is noted in the title row.
    private var sendingWithoutSummaryButton: Bool {
        guard sending, !retryInFlight, let action = inFlightAction else { return sending && !retryInFlight }
        let quick = !readOnly && shown.kind == .permission && !selectsOptions ? shown.actions.first(where: approves)?.id : nil
        let refusal = readOnly ? nil : shown.actions.first(where: refuses)?.id
        return action != quick && action != refusal
    }
    private var answerPresent: Bool { !current.selectedIds.isEmpty || !current.otherText.trimmingCharacters(in: .whitespaces).isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: readOnly ? (confirmed ? "checkmark.circle" : "info.circle") : icon).riffetFont(.label, weight: .regular).foregroundStyle(readOnly ? palette.fg3 : palette.warning)
                Text(title).riffetFont(.headline).lineLimit(2)
                    .foregroundStyle(palette.fg)
                Spacer(minLength: 0)
                if sendingWithoutSummaryButton {
                    HStack(spacing: 6) { ProgressView().controlSize(.small); Text("提交中…", bundle: .riffet) }.riffetFont(.label, weight: .regular).foregroundStyle(palette.fg3)
                } else if !connected, !readOnly {
                    Text("重连后提交", bundle: .riffet).riffetFont(.label, weight: .regular).foregroundStyle(palette.fg3)
                }
                if isQuestion, let count = shown.questionCount?.int64Value, count > 0 {
                    Text("\(max(1, shown.questionIndex?.int64Value ?? 1)) / \(count)").riffetFont(.caption).monospacedDigit().foregroundStyle(palette.fg3)
                }
                if let onCollapse {
                    Button(action: onCollapse) {
                        Image(systemName: "chevron.down").riffetFont(.caption, weight: .semibold).foregroundStyle(palette.fg4)
                            .frame(minWidth: RiffetMetrics.hitTarget, minHeight: RiffetMetrics.hitTarget).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .padding(.vertical, -RiffetMetrics.hitTarget / 4)
                    .accessibilityLabel(String(localized: "收起", bundle: .riffet))
                }
            }
            if let message = shown.message, !message.isEmpty {
                Text(message).riffetFont(isQuestion ? .label : .monoSmall, weight: .regular).lineLimit(3)
                    .foregroundStyle(palette.fg3)
            }
            if readOnly, let result {
                Text(result).riffetFont(.label, weight: .regular).foregroundStyle(palette.fg3).lineLimit(2)
            }
            summaryActions
        }
        .padding(16)
        .background(palette.bgSubtle, in: RoundedRectangle(cornerRadius: RiffetMetrics.groupRadius, style: .continuous))
        .accessibilityElement(children: .contain)
        .sheet(isPresented: $showingDetails) { detailView }
        // The countdown is the only reader of `now`: a card without an expiry does not re-render every second.
        .task(id: expires) {
            guard !readOnly, let expires else { return }
            while !Task.isCancelled {
                now = .now
                if expires <= now { break }
                do { try await Task.sleep(for: .seconds(1)) } catch { break }
            }
        }
        .onAppear { if !readOnly { drafts.show(interaction, for: key) } }
        .onChange(of: key) { _, key in
            selectedAction = nil
            if !readOnly { drafts.show(interaction, for: key) }
        }
        .onChange(of: interaction) { _, next in
            if !readOnly { drafts.show(next, for: key) }
        }
        .onChange(of: shown.revision) { _, _ in selectedAction = nil }
        .onChange(of: submission?.phase) { _, phase in
            if !readOnly, phase == .success { showingDetails = false }
        }
    }

    /// 详情, the refusal and the approval. How long the request is does not decide which answers are offered.
    private var summaryActions: some View {
        VStack(alignment: .leading, spacing: 8) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { summaryButtons; quickApproval }
                VStack(alignment: .leading, spacing: 8) { summaryButtons }
            }
            if !readOnly, !sending, card.frozen || card.notice != nil || card.error != nil || localNotice != nil || localError != nil || expired {
                Button { showingDetails = true } label: {
                    Text(summaryNotice).riffetFont(.caption).foregroundStyle(palette.warning).lineLimit(2)
                }.buttonStyle(.plain)
            }
        }
    }

    /// A protocol request names its one-off approval and its refusal by id; a permission lifted from a
    /// terminal marks its plain Yes and No by tone. Options that remember a rule carry `detail` and stay in the sheet.
    private func approves(_ action: NativeInteractionAction) -> Bool {
        action.detail == nil && (["approve", "allow", "accept", "allow-once"].contains(action.id) || (shown.kind == .permission && action.tone == "primary"))
    }
    private func refuses(_ action: NativeInteractionAction) -> Bool {
        action.detail == nil && (["cancel", "deny", "decline", "reject"].contains(action.id) || (shown.kind == .permission && action.tone == "danger"))
    }

    @ViewBuilder
    private var quickApproval: some View {
        if !readOnly, shown.kind == .permission, !selectsOptions, let action = shown.actions.first(where: approves) {
            Button { submit(action.id) } label: {
                InteractionButtonLabel(text: action.shortLabel ?? action.label, running: inFlightAction == action.id)
            }
            .buttonStyle(.borderedProminent).tint(palette.primary).foregroundStyle(palette.primaryFg).disabled(!connected || busy)
            .accessibilityIdentifier("interactionAction.\(action.id)")
            .fixedSize(horizontal: true, vertical: false)
        }
    }

    @ViewBuilder
    private var summaryButtons: some View {
        Button("详情") { showingDetails = true }.buttonStyle(.borderless).frame(minHeight: 44)
        if !readOnly, let action = shown.actions.first(where: refuses) {
            Button { submit(action.id) } label: { InteractionButtonLabel(text: action.id == "cancel" ? String(localized: "取消", bundle: .riffet) : String(localized: "拒绝", bundle: .riffet), running: inFlightAction == action.id) }
                .buttonStyle(.bordered).disabled(!connected || busy)
                .accessibilityIdentifier("interactionAction.\(action.id)")
        }
    }

    private var summaryNotice: String {
        if let localError { return localError }
        if let localNotice { return localNotice }
        if let error = card.error { return error.message ?? String(localized: "发送失败", bundle: .riffet) }
        if expired { return String(localized: "此请求已过期，请同步最新状态。", bundle: .riffet) }
        if let submission, let message = submissionMessage(submission) { return message }
        if card.notice == .draftStale { return String(localized: "题目已更新，旧草稿未提交。", bundle: .riffet) }
        return String(localized: "暂时无法确认回答是否已提交", bundle: .riffet)
    }

    private var detailView: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(title).riffetFont(.headline).foregroundStyle(palette.fg).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if let message = shown.message, !message.isEmpty { messageView(message) }
                    if readOnly, let result { Text(result).riffetFont(.label, weight: .regular).foregroundStyle(palette.fg3).textSelection(.enabled) }
                    if !readOnly { expiryNotice }
                    if isInteractionRenderable(interaction: shown) {
                        if selectsOptions, !shown.options.isEmpty { options }
                        if (isQuestion || selectsOptions), shown.allowOther?.boolValue == true || (isQuestion && shown.options.isEmpty) {
                            TextField(shown.options.isEmpty ? "输入回答" : "其他…", text: Binding(get: { current.otherText }, set: changeOther), axis: .vertical)
                                .textFieldStyle(.roundedBorder)
                                .disabled(busy || !connected)
                                .onSubmit(submitOnEnter)
                            if shown.multiple?.boolValue == true, shown.otherSelected?.boolValue == true {
                                Text("其他回答暂不能清空。").riffetFont(.label, weight: .regular).foregroundStyle(palette.fg3)
                            }
                        }
                        if !isQuestion, !selectsOptions { actionOptions }
                    } else {
                        Text("这个对话框需要在终端里处理。").riffetFont(.label, weight: .regular).foregroundStyle(palette.fg3)
                        if let openTerminal { Button("打开终端", action: openTerminal).buttonStyle(.bordered) }
                    }
                    if !readOnly { notices }
                    if !connected, !readOnly { Text("重连后提交").riffetFont(.label, weight: .regular).foregroundStyle(palette.fg3) }
                }
                .padding(16)
            }
            .background(palette.bg)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(alignment: .leading, spacing: 8) {
                    if !readOnly {
                        if isInteractionRenderable(interaction: shown) {
                            if !isQuestion, !selectsOptions { detailActions } else { footer }
                        } else { submissionActions }
                    }
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(palette.bg)
            }
            .navigationTitle("审批")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { showingDetails = false } } }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }

    @ViewBuilder
    private var expiryNotice: some View {
        if let expires {
            HStack(alignment: .firstTextBaseline) {
                Text(expires <= now ? String(localized: "此请求已过期，请同步最新状态。", bundle: .riffet) : String(localized: "剩余等待时间 \(max(0, Int(expires.timeIntervalSince(now)))) 秒", bundle: .riffet))
                    .riffetFont(.caption).monospacedDigit().foregroundStyle(expires <= now ? palette.danger : palette.fg3)
                Spacer(minLength: 4)
                if let until = ServerTime.date(shown.extendableUntil), until > now {
                    Button(extending ? "延长中…" : "延长等待") { Task { await extend() } }.riffetFont(.caption).disabled(extending || !connected || card.frozen)
                }
            }
            if expired { syncButton }
        }
    }

    private var chosenAction: NativeInteractionAction? {
        shown.actions.first { $0.id == selectedAction } ?? shown.actions.first { ["approve", "allow", "accept", "allow-once"].contains($0.id) && $0.detail == nil }
    }

    /// Selection stays in the row; the chosen rule is separate selectable reading content.
    private var actionOptions: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(shown.actions, id: \.id) { action in
                Button { selectedAction = action.id } label: {
                    HStack(alignment: .top, spacing: 10) {
                        Text(action.shortLabel ?? action.label).riffetFont(.label, weight: .regular).foregroundStyle(palette.fg)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        if chosenAction?.id == action.id {
                            Image(systemName: "checkmark").riffetFont(.label, weight: .medium).foregroundStyle(palette.accent)
                        }
                    }.multilineTextAlignment(.leading).padding(.vertical, 8).contentShape(Rectangle())
                }.buttonStyle(.plain).disabled(!connected || busy)
                if readOnly || chosenAction?.id == action.id {
                    if let detail = action.detail {
                        Text(detail).riffetFont(.monoSmall).foregroundStyle(palette.fg3).textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } else if action.shortLabel != nil, action.shortLabel != action.label {
                        Text(action.label).riffetFont(.label, weight: .regular).foregroundStyle(palette.fg3).textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
    }

    private var detailActions: some View {
        VStack(alignment: .leading, spacing: 8) {
            submissionActions
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { detailButtons }
                VStack(alignment: .leading, spacing: 8) { detailButtons }
            }
        }
    }

    @ViewBuilder
    private var detailButtons: some View {
        if let action = shown.actions.first(where: { $0.id == "cancel" && $0.detail == nil }), chosenAction?.id != action.id {
            Button { submit(action.id) } label: { InteractionButtonLabel(text: String(localized: "取消", bundle: .riffet), running: inFlightAction == action.id) }
                .buttonStyle(.bordered).disabled(!connected || busy)
        }
        if let chosen = chosenAction {
            Button { submit(chosen.id) } label: {
                InteractionButtonLabel(text: chosen.shortLabel ?? chosen.label, running: inFlightAction == chosen.id, fallback: String(localized: "提交", bundle: .riffet))
            }
            .buttonStyle(.borderedProminent).tint(chosen.tone == "danger" ? palette.danger : palette.primary)
            .foregroundStyle(chosen.tone == "danger" ? palette.dangerFg : palette.primaryFg)
            .disabled(!connected || busy)
            .accessibilityIdentifier("interactionAction.\(chosen.id)")
        } else {
            Button("提交") {}.buttonStyle(.borderedProminent).tint(palette.primary).foregroundStyle(palette.primaryFg).disabled(true)
        }
    }

    private var title: String {
        if !shown.title.isEmpty { return shown.title }
        return isQuestion ? String(localized: "需要回答", bundle: .riffet) : shown.kind == .plan ? String(localized: "需要批准计划", bundle: .riffet) : String(localized: "需要选择", bundle: .riffet)
    }

    private var icon: String {
        switch shown.kind {
        case .permission: "hand.raised"
        case .question: "questionmark.bubble"
        case .plan: "list.bullet.clipboard"
        default: "exclamationmark.bubble"
        }
    }

    @ViewBuilder
    private func messageView(_ message: String) -> some View {
        if shown.kind == .plan {
            ConversationMarkdown(source: message, workbench: workbench, projectID: workbench.selected?.projectId ?? "", compact: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            Text(message)
                .riffetFont(isQuestion ? .label : .monoSmall, weight: .regular)
                .foregroundStyle(palette.fg3)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var options: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(shown.options, id: \.id) { option in
                let on = current.selectedIds.contains(option.id)
                let multiple = shown.multiple?.boolValue == true
                Button { changeOption(option.id) } label: {
                    HStack(spacing: 10) {
                        if multiple {
                            Image(systemName: on ? "checkmark.circle.fill" : "circle")
                                .riffetFont(.label, weight: .regular)
                                .foregroundStyle(on ? palette.accent : palette.fg3)
                        }
                        Text(option.label).riffetFont(.label, weight: .regular).foregroundStyle(on ? palette.fg : palette.fg3).multilineTextAlignment(.leading)
                        Spacer(minLength: 0)
                        if !multiple && on {
                            Image(systemName: "checkmark").riffetFont(.label, weight: .medium).foregroundStyle(palette.accent)
                        }
                    }
                    .padding(.horizontal, 8)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("interactionOption.\(option.id)")
                .disabled(busy || !connected)
                .opacity(busy ? 0.65 : 1)
            }
        }
    }

    @ViewBuilder
    private var notices: some View {
        if let notice = card.notice {
            RiffetNotice(kind: .warning, message: notice == .unconfirmed ? String(localized: "暂时无法确认回答是否已提交", bundle: .riffet) : String(localized: "题目已更新，旧草稿未提交。", bundle: .riffet))
        }
        if let localNotice { RiffetNotice(kind: .warning, message: localNotice) }
        if let submission, let message = submissionMessage(submission) {
            RiffetNotice(kind: submission.phase == .success ? .success : .warning, message: message)
        }
        if let error = card.error {
            RiffetNotice(kind: .error, message: error.message ?? (error.kind == .submit ? String(localized: "发送失败", bundle: .riffet) : String(localized: "失败", bundle: .riffet)))
        }
        if let localError { RiffetNotice(kind: .error, message: localError) }
    }

    private func submissionMessage(_ submission: InteractionSubmission) -> String? {
        switch submission.phase {
        case .unknown: String(localized: "暂时无法确认回答是否已提交", bundle: .riffet)
        case .stale: String(localized: "题目已变化，请同步后继续。", bundle: .riffet)
        case .uncertain: [String(localized: "暂时无法确认回答是否已提交", bundle: .riffet), submission.message].compactMap { $0 }.joined(separator: " ")
        case .success: submission.message
        default: nil
        }
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 8) {
            submissionActions
            ForEach(shown.actions.filter { $0.id != "next" }, id: \.id) { action in
                let submits = action.id == "answer" || action.id == "submit"
                let last = (shown.questionIndex?.int64Value ?? 0) >= (shown.questionCount?.int64Value ?? Int64.max)
                let label = action.id == "previous" ? String(localized: "上一题", bundle: .riffet)
                    : submits ? (last || action.label.contains("提交") ? String(localized: "提交", bundle: .riffet) : String(localized: "下一题", bundle: .riffet))
                    : action.id == "skip" ? String(localized: "跳过", bundle: .riffet) : action.shortLabel ?? action.label
                Button { submit(action.id) } label: { InteractionButtonLabel(text: label, running: inFlightAction == action.id, fallback: String(localized: "提交", bundle: .riffet)) }
                    .buttonStyle(.bordered).tint(action.tone == "danger" ? palette.danger : palette.primary)
                    .disabled(!connected || busy || (submits && !answerPresent))
                    .help(action.id == "skip" ? String(localized: "跳过这组问题", bundle: .riffet) : "")
                    .accessibilityIdentifier("interactionAction.\(action.id)")
                    .modifier(DefaultActionIf(enabled: submits))
            }
        }
    }

    @ViewBuilder
    private var submissionActions: some View {
        // Progress shows in the button that sent it, or in the card's title row; never as a row here.
        if let submission, submission.phase == .unknown {
            HStack(spacing: 6) {
                Button(action: retry) { InteractionButtonLabel(text: String(localized: "重试", bundle: .riffet), running: retryInFlight) }.buttonStyle(.bordered).disabled(!connected || !card.canRetry || authenticating)
                syncButton
                if let openTerminal { Button("终端", action: openTerminal).buttonStyle(.bordered) }
            }
        }
        if submission?.phase == .stale || submission?.phase == .uncertain {
            HStack(spacing: 6) {
                syncButton
                if let openTerminal { Button("终端", action: openTerminal).buttonStyle(.bordered) }
            }
        }
    }

    private var syncButton: some View {
        Button(card.syncing ? "检查中…" : "检查状态") { Task { await sync() } }.buttonStyle(.bordered).disabled(card.syncing)
    }

    // MARK: State

    private func changeOption(_ id: String) {
        guard !busy else { return }
        localNotice = nil
        drafts.update(key) { $0.selectOption(optionId: id) }
    }

    private func changeOther(_ text: String) {
        guard !busy else { return }
        localNotice = nil
        drafts.update(key) { $0.changeOtherText(value: text) }
    }

    private func submitOnEnter() {
        guard let action = shown.actions.first(where: { $0.id == "answer" }) ?? shown.actions.first(where: { $0.id == "submit" }),
              connected, !busy, answerPresent else { return }
        submit(action.id)
    }

    // MARK: Submit and sync

    private func submit(_ action: String) {
        if !authenticating { tappedAction = action }
        let requestID = UUID().uuidString.lowercased()
        send(retrying: false) { $0.submit(action: action, requestId: requestID) }
    }

    private func retry() {
        if !authenticating { tappedAction = nil }
        send(retrying: true) { $0.retry() }
    }

    /// Verifies the reader when asked to, checks the request still stands, then posts what [transition] sent.
    private func send(retrying: Bool, _ transition: @escaping (InteractionCardState) -> InteractionCardState?) {
        guard !readOnly, connected, !authenticating, !extending, retrying ? card.canRetry : !busy,
              let pending = transition(card)?.submission else { return }
        let submissionKey = key
        guard drafts.beginSubmission(for: submissionKey) else { return }
        // Enter the gate synchronously, before the authentication suspension point, so two taps
        // (or the parent's retained card and a child page) cannot create two commands.
        authenticating = true
        localNotice = nil
        localError = nil
        let sessionAtSubmit = workbench.selected?.id
        let asked = pending.interaction
        Task {
            defer {
                authenticating = false
                drafts.endSubmission(for: submissionKey)
            }
            if requireTouchID, [.permission, .plan, .confirmation].contains(asked.kind) {
                do {
                    guard try await workbench.host.authenticate(reason: String(localized: "确认 Agent 的操作", bundle: .riffet)).boolValue else {
                        localNotice = String(localized: "设备验证未完成，操作尚未提交。", bundle: .riffet)
                        return
                    }
                } catch { localError = error.riffetMessage; return }
            }
            guard workbench.selected?.id == sessionAtSubmit,
                  (workbench.interaction?.id == asked.id && workbench.interaction?.revision == asked.revision
                   || retrying && workbench.interaction == nil),
                  workbench.connection is RiffetConnectionStateLive else {
                localNotice = String(localized: "会话或请求已变化，操作尚未提交。请同步当前请求。", bundle: .riffet)
                return
            }
            if !retrying, let expires = ServerTime.date(asked.expiresAt), expires <= Date() {
                localNotice = String(localized: "请求已过期，操作尚未提交。请同步当前请求。", bundle: .riffet)
                return
            }
            var sent: InteractionSubmission?
            drafts.update(submissionKey) { current in
                guard let next = transition(current), let posting = next.submission,
                      posting.interaction.id == asked.id, posting.interaction.revision == asked.revision else { return current }
                sent = posting
                return next
            }
            guard let sent else {
                localNotice = String(localized: "会话或请求已变化，操作尚未提交。请同步当前请求。", bundle: .riffet)
                return
            }
            authenticating = false
            let requestID = sent.request.requestId
            do {
                let result = try await workbench.store.respondInteraction(response: sent.request)
                drafts.update(submissionKey) { $0.responded(requestId: requestID, status: result.status, message: result.message) }
                if result.status != .uncertain { onSubmitted?(result) }
            } catch {
                let status = error.riffetStatus.map { KotlinInt(int: Int32($0)) }
                let message = error.riffetMessage
                drafts.update(submissionKey) { $0.failed(requestId: requestID, status: status, message: message) }
            }
        }
    }

    private func extend() async {
        guard !extending, let sessionID = workbench.selected?.id, let api = workbench.api else { return }
        let extendKey = key
        extending = true
        localError = nil
        defer { extending = false }
        do {
            _ = try await api.nativeExtendInteraction(id: sessionID, interactionId: shown.id)
            if let fresh = try await workbench.store.syncInteraction(), fresh.id == interaction.id {
                drafts.update(extendKey) { $0.interactionChanged(next: fresh) }
            }
        } catch { localError = error.riffetMessage }
    }

    private func sync() async {
        guard !card.syncing else { return }
        let syncKey = key
        let held = drafts.hasPendingSubmission(for: syncKey)
        localNotice = nil
        localError = nil
        drafts.update(syncKey) { $0.syncStarted() }
        do {
            let fresh = try await workbench.store.syncInteraction()
            // The returned value is authoritative now; Swift Flow observation may arrive a run loop
            // later, and the ledger keeps a receipt's interaction on screen until it is released.
            drafts.update(syncKey) { current in
                let synced = current.synced(fresh: fresh)
                guard let fresh, fresh.id == synced.interaction.id else { return synced }
                return synced.interactionChanged(next: fresh)
            }
            if held, !drafts.hasPendingSubmission(for: syncKey), let sessionID = workbench.selected?.id {
                ConversationInteractionLedger.shared.observe(fresh, for: "\(workbench.baseURL.absoluteString)|\(sessionID)", after: nil, authoritative: true)
            }
        } catch {
            let message = error.riffetMessage
            drafts.update(syncKey) { $0.syncFailed(message: message) }
        }
    }
}

/// A button title that keeps its width while a spinner stands in for it.
private struct InteractionButtonLabel: View {
    let text: String
    let running: Bool
    var fallback: String? = nil
    var body: some View {
        ZStack {
            ViewThatFits(in: .horizontal) {
                Text(text).lineLimit(1).fixedSize(horizontal: true, vertical: false)
                if let fallback { Text(fallback).lineLimit(1) }
            }.opacity(running ? 0 : 1)
            if running { ProgressView().controlSize(.small) }
        }
    }
}

/// Return presses the primary action of the card in front.
private struct DefaultActionIf: ViewModifier {
    let enabled: Bool

    func body(content: Content) -> some View {
        if enabled { content.keyboardShortcut(.defaultAction) } else { content }
    }
}
