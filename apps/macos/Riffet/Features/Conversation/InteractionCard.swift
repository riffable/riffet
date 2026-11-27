import SwiftUI
import RiffetKit

/// Each card's state, per session and interaction, for as long as the app runs (the web keeps the
/// draft and submission in `sessionStorage`). The card is composed again whenever it moves between
/// the conversation and a subagent page, and an answer that was out when it moved still lands here.
@MainActor @Observable
final class InteractionDrafts {
    static let shared = InteractionDrafts()

    private(set) var states: [String: InteractionCardState] = [:]
    /// Keys from least to most recently shown; only the last few settled cards are kept.
    @ObservationIgnored private var recent: [String] = []
    /// Cards waiting on Touch ID before they send, so a second press cannot send twice.
    var confirming: Set<String> = []

    /// The card as it mounts or as the server redraws it.
    func show(_ key: String, _ interaction: NativeInteraction) {
        set(key, states[key]?.interactionChanged(next: interaction)
            ?? restoreInteractionCard(interaction: interaction, savedDraft: nil, savedSubmission: nil))
    }

    func set(_ key: String, _ state: InteractionCardState) {
        states[key] = state
        recent.removeAll { $0 == key }
        recent.append(key)
        // An answer still out or inconclusive stays: a card composed again must find it.
        for old in recent.dropLast(8) where states[old]?.frozen != true && !confirming.contains(old) {
            states[old] = nil
            recent.removeAll { $0 == old }
        }
    }

    /// Applies a transition to the card's state as it is now, which may have moved on since it began.
    func update(_ key: String, _ transition: (InteractionCardState) -> InteractionCardState) {
        if let state = states[key] { states[key] = transition(state) }
    }
}

/// The dialog the CLI is waiting on: approvals, questions, plan reviews. The state machine is the one
/// every client runs (`InteractionCard.kt`); this view renders it and performs the requests it asks
/// for. A request whose fate is unknown can be retried with the same request id; a refused (409) or
/// unconfirmed one offers 同步 and the terminal.
struct InteractionCardView: View {
    let workbench: Workbench
    let interaction: NativeInteraction
    var openTerminal: (() -> Void)?
    var sessionID: String?
    var detailsOnly = false
    var summaryOnly = false
    var onOpenDetails: (() -> Void)?
    var onInteractionChange: ((NativeInteraction?) -> Void)?
    /// The conversation a summary belongs to, shown on its first line where the summary stands alone (the menu bar).
    var summaryContext: (title: String, open: () -> Void)?
    @Environment(\.palette) private var palette
    @State private var showingDetails = false
    /// Extending the deadline failed; the platform's own action, outside the shared state machine.
    @State private var extendError: String?
    /// The action selected in the reader; its exact scope stays in the scrollable body.
    @State private var pickedAllow: String?
    @FocusState private var cardFocused: Bool
    @AppStorage("riffet.touchid-approvals") private var requireTouchID = false
    private let drafts = InteractionDrafts.shared

    private var currentSessionID: String? { sessionID ?? workbench.selected?.id }
    private var key: String { "\(workbench.baseURL.absoluteString):\(currentSessionID ?? ""):\(interaction.id)" }
    /// The open conversation answers over its live stream; another one (the menu bar) answers over the API.
    private var connected: Bool {
        currentSessionID == workbench.selected?.id ? workbench.connection is RiffetConnectionStateLive : workbench.host.api != nil
    }
    private var state: InteractionCardState {
        drafts.states[key] ?? restoreInteractionCard(interaction: interaction, savedDraft: nil, savedSubmission: nil)
    }
    private var confirming: Bool { drafts.confirming.contains(key) }
    private var busy: Bool { state.busy || confirming }
    private var submission: InteractionSubmission? { state.submission }
    private var shown: NativeInteraction { state.shown }
    private var current: InteractionDraft { state.currentDraft }
    private var isQuestion: Bool { shown.kind == .question }
    private var selectsOptions: Bool { interactionSelectsOptions(interaction: shown) }
    private var answerPresent: Bool { !current.selectedIds.isEmpty || !current.otherText.trimmingCharacters(in: .whitespaces).isEmpty }

    /// The web card: px-3 py-2.5.
    private var containerInsets: EdgeInsets { EdgeInsets(top: 10, leading: 12, bottom: 10, trailing: 12) }

    var body: some View {
        Group {
            if detailsOnly {
                detailBody
            } else if summaryOnly || !isQuestion {
                summaryBody
            } else {
                expandedCard
            }
        }
        // Clicking the card's empty space focuses it; text fields and buttons keep their own clicks.
        .background { Color.clear.contentShape(Rectangle()).onTapGesture { cardFocused = true } }
        .background(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).fill(palette.bgSubtle.opacity(0.45)))
        .overlay {
            if cardFocused {
                RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(palette.accent.opacity(0.35), lineWidth: 2)
            }
        }
        // Like the web card: 1–9 and Esc act only while the card itself has focus, so typing in
        // the composer never answers a dialog.
        .focusable(isInteractionRenderable(interaction: shown))
        .focused($cardFocused)
        .focusEffectDisabled()
        .onKeyPress(phases: .down, action: cardKeyPress)
        .onAppear { drafts.show(key, interaction) }
        .onChange(of: interaction) { old, new in
            if old.revision != new.revision { extendError = nil }
            drafts.show(key, new)
        }
        .onChange(of: shown.revision) { _, _ in pickedAllow = nil }
        .onChange(of: key) { _, key in pickedAllow = nil; drafts.show(key, interaction) }
        .onChange(of: submission?.phase) { _, phase in
            if phase == .success { showingDetails = false }
        }
        .sheet(isPresented: $showingDetails) {
            VStack(spacing: 0) {
                HStack {
                    Text("审批").font(.riffet(size: S(14), weight: .semibold)).lineLimit(1)
                    Spacer()
                    Button("关闭") { showingDetails = false }.buttonStyle(ChipButtonStyle()).keyboardShortcut(.cancelAction)
                }
                .padding(Space.lg)
                Divider()
                detailBody
            }
            .frame(width: min(820, max(320, (NSScreen.main?.visibleFrame.width ?? 900) - 40)), height: min(680, max(300, (NSScreen.main?.visibleFrame.height ?? 800) - 56)))
            .background(palette.bg)
        }
    }

    private func openDetails() {
        if let onOpenDetails { onOpenDetails() } else { showingDetails = true }
    }

    /// The summary clamps the title and the command; how long they are does not change which answers it offers.
    private var summaryBody: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            if let context = summaryContext {
                Button(action: context.open) {
                    HStack(spacing: Space.xs) {
                        Circle().fill(palette.warning).frame(width: 6, height: 6)
                        Text(context.title.ifEmpty(String(localized: "新会话"))).font(.riffet(size: S(12))).foregroundStyle(palette.fg2).lineLimit(1)
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("打开会话")
            }
            if summaryContext?.title != title {
                HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
                    Text(title).font(.riffet(size: S(13), weight: .medium)).foregroundStyle(palette.fg)
                        .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            if let message = shown.message, !message.isEmpty {
                Text(message).font(.riffet(size: S(12), design: .monospaced)).foregroundStyle(palette.fg2)
                    .lineLimit(3).fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
                    .padding(.horizontal, Space.sm).padding(.vertical, Space.xs)
                    .background(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).fill(blockFill))
            }
            if shown.expiresAt != nil, submission?.phase != .success, let sessionID = currentSessionID {
                ExpiryCountdown(workbench: workbench, sessionID: sessionID, interaction: shown, failed: { extendError = $0 })
            }
            if let message = summaryNotice {
                Text(message).font(.riffet(size: S(12))).foregroundStyle(palette.warning)
                    .lineLimit(2).fixedSize(horizontal: false, vertical: true)
            }
            if let message = state.error?.message ?? extendError, !message.isEmpty {
                Text(message).font(.riffet(size: S(12))).foregroundStyle(palette.danger)
                    .lineLimit(2).fixedSize(horizontal: false, vertical: true)
            }
            ViewThatFits(in: .horizontal) {
                summaryActions
                HStack { Spacer(minLength: 0); Button("查看详情", action: openDetails).buttonStyle(ChipButtonStyle()) }
            }
        }
        .padding(Space.md)
        .fixedSize(horizontal: false, vertical: true)
    }

    private var summaryNotice: String? {
        switch submission?.phase {
        case .unknown, .uncertain: String(localized: "暂时无法确认回答是否已提交")
        case .stale: String(localized: "题目已变化，请同步后继续。")
        default: noticeText
        }
    }

    /// Details, then the refusal, then the approval on the trailing edge. A protocol request names them by
    /// id; a permission lifted from a terminal marks its plain Yes and No by tone. Options that remember a
    /// rule show their scope only in the reader, so they are never quick actions.
    private var summaryActions: some View {
        let permission = shown.kind == .permission
        let refuses = { (action: NativeInteractionAction) in ["deny", "decline", "reject", "cancel"].contains(action.id) || (permission && action.tone == "danger") }
        let approves = { (action: NativeInteractionAction) in ["approve", "allow", "allow-once", "accept"].contains(action.id) || (permission && action.tone == "primary") }
        let quick = shown.actions.filter {
            $0.detail == nil && (approves($0) || refuses($0)) && ($0.shortLabel != nil || $0.label.count < 28)
        }.sorted { refuses($0) && !refuses($1) }
        return HStack(spacing: Space.sm) {
            submissionActions
            let showsQuick = !selectsOptions && !isQuestion && isInteractionRenderable(interaction: shown) && (!busy || postingAction != nil)
            if let postingAction, !(showsQuick && quick.contains { $0.id == postingAction }) { postingStatus }
            Spacer(minLength: 0)
            Button("查看详情", action: openDetails).buttonStyle(ChipButtonStyle())
            if showsQuick {
                ForEach(quick, id: \.id) { action in
                    actionButton(action.shortLabel ?? action.label, refuses(action) ? .secondary : .primary, posting: action.id == postingAction) { submit(action.id) }
                        .disabled(action.id != postingAction && (!connected || busy))
                }
            }
        }
    }

    /// Long titles, content and choice descriptions share one scroll owner. Sending stays outside it.
    private var detailBody: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.md) {
                    HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
                        Text(title).font(.riffet(size: S(14), weight: .semibold)).foregroundStyle(palette.fg)
                            .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                        Spacer(minLength: 0)
                        titleStatus(buttonActions: chosenAction.map { [$0.id] } ?? [])
                    }
                    if shown.expiresAt != nil, submission?.phase != .success, let sessionID = currentSessionID {
                        ExpiryCountdown(workbench: workbench, sessionID: sessionID, interaction: shown, failed: { extendError = $0 })
                    }
                    if let message = shown.message, !message.isEmpty {
                        if shown.kind == .plan {
                            MarkdownView(source: message, compact: true).frame(maxWidth: .infinity, alignment: .leading)
                        } else {
                            Text(message).font(.riffet(size: S(13), design: .monospaced)).foregroundStyle(palette.fg2)
                                .fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
                        }
                    }
                    if selectsOptions { options }
                    if isQuestion || selectsOptions, shown.allowOther?.boolValue == true || shown.options.isEmpty {
                        TextField(shown.options.isEmpty ? "输入回答" : "其他…", text: Binding(get: { current.otherText }, set: changeOther))
                            .textFieldStyle(.roundedBorder).disabled(busy || !connected || otherTextLocked(interaction: shown)).onSubmit(submitOnEnter)
                        if otherTextLocked(interaction: shown) {
                            Text("其他回答暂不能清空。").font(.riffet(size: S(12))).foregroundStyle(palette.fg3)
                        }
                    }
                    if !isQuestion, !selectsOptions {
                        ForEach(shown.actions, id: \.id) { action in
                            VStack(alignment: .leading, spacing: Space.xs) {
                                optionRow(label: action.shortLabel ?? action.label, on: chosenAction?.id == action.id, multiple: false) { pickedAllow = action.id }
                                if let detail = action.detail, !detail.isEmpty {
                                    Text(detail).font(.riffet(size: S(12), design: .monospaced)).foregroundStyle(palette.fg2)
                                        .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                                } else if let shortLabel = action.shortLabel, shortLabel != action.label {
                                    Text(action.label).font(.riffet(size: S(12))).foregroundStyle(palette.fg2)
                                        .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                                }
                            }
                        }
                    }
                    if !isInteractionRenderable(interaction: shown) {
                        Text("这个对话框需要在终端里处理。").font(.riffet(size: S(12))).foregroundStyle(palette.fg3)
                        if let openTerminal { Button("打开终端", action: openTerminal).buttonStyle(ChipButtonStyle()) }
                    }
                    notices
                }
                .padding(Space.lg)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            Divider()
            ViewThatFits(in: .horizontal) {
                HStack(spacing: Space.sm) {
                    submissionActions
                    detailCopyButton
                    Spacer(minLength: 0)
                    detailConfirmation
                }
                VStack(alignment: .leading, spacing: Space.sm) {
                    HStack(spacing: Space.sm) {
                        submissionActions
                        Spacer(minLength: 0)
                        detailCopyButton
                    }
                    HStack(spacing: Space.sm) {
                        Spacer(minLength: 0)
                        detailConfirmation
                    }
                }
            }
            .padding(Space.md)
        }
    }

    @ViewBuilder
    private var detailCopyButton: some View {
        Button("复制") {
            let content = [title, shown.message].compactMap { $0 }
                + shown.actions.flatMap { [$0.label, $0.detail].compactMap { $0 } }
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(content.joined(separator: "\n\n"), forType: .string)
        }.buttonStyle(ChipButtonStyle())
    }

    @ViewBuilder
    private var detailConfirmation: some View {
        if !isQuestion, !selectsOptions, let action = chosenAction {
            Button { submit(action.id) } label: {
                ViewThatFits(in: .horizontal) {
                    Text(action.shortLabel ?? action.label).lineLimit(1).fixedSize(horizontal: true, vertical: false)
                    Text("提交").lineLimit(1)
                }
                .opacity(action.id == postingAction ? 0 : 1)
                .overlay { if action.id == postingAction { Spinner(size: .mini) } }
            }
                .buttonStyle(SolidButtonStyle(kind: action.tone == "danger" ? .secondary : .primary))
                .disabled(action.id != postingAction && (!connected || busy || !isInteractionRenderable(interaction: shown)))
        } else if isQuestion || selectsOptions {
            footer
        }
    }

    private var chosenAction: NativeInteractionAction? {
        shown.actions.first { $0.id == pickedAllow }
            ?? shown.actions.first { $0.detail == nil && ["approve", "allow", "accept", "allow-once"].contains($0.id) }
    }

    private var expandedCard: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            HStack(alignment: .center, spacing: Space.sm) {
                Text(title)
                    .font(.riffet(size: S(13), weight: .medium))
                    .foregroundStyle(palette.fg)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer()
                titleStatus(buttonActions: footerButtonIDs)
                if cardFocused, let shortcutHint { Text(shortcutHint).font(.riffet(size: S(12))).foregroundStyle(palette.fg3) }
                if shown.expiresAt != nil, submission?.phase != .success, let sessionID = currentSessionID {
                    ExpiryCountdown(workbench: workbench, sessionID: sessionID, interaction: shown, failed: { extendError = $0 })
                }
                if isQuestion, let count = shown.questionCount?.int64Value, count > 0 {
                    Text("\(max(1, shown.questionIndex?.int64Value ?? 1)) / \(count)").font(.riffet(size: S(12)).monospacedDigit()).foregroundStyle(palette.fg3)
                }
            }

            if let message = shown.message, !message.isEmpty { messageView(message) }
            Button("查看详情", action: openDetails).buttonStyle(ChipButtonStyle())
            if isInteractionRenderable(interaction: shown) {
                if selectsOptions, !shown.options.isEmpty { options }
                if isQuestion, shown.allowOther?.boolValue == true || shown.options.isEmpty {
                    TextField(shown.options.isEmpty ? "输入回答" : "其他…", text: Binding(get: { current.otherText }, set: changeOther))
                        .textFieldStyle(.roundedBorder)
                        // Disabled rather than refused: a field whose edit is refused can show text the draft does not hold.
                        .disabled(busy || !connected || otherTextLocked(interaction: shown))
                        .onSubmit(submitOnEnter)

                    if otherTextLocked(interaction: shown) {
                        Text("其他回答暂不能清空。").font(.riffet(size: S(12))).foregroundStyle(palette.fg3)
                    }
                }
                notices
                footer
            } else {
                notices
                Text("这个对话框需要在终端里处理。").font(.riffet(size: S(12))).foregroundStyle(palette.fg3)
                if let openTerminal { Button("打开终端", action: openTerminal).buttonStyle(SolidButtonStyle(kind: .secondary)) }
            }
        }
        .padding(containerInsets)
        .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: Keyboard

    /// Refusals in the order Esc prefers them (`nativeInteractionShortcuts.ts`).
    private var dismissID: String? {
        ["deny", "decline", "reject", "cancel"].first { id in shown.actions.contains { $0.id == id } }
    }

    private var showsOptions: Bool { selectsOptions && !shown.options.isEmpty }

    private var shortcutCount: Int {
        if summaryOnly || !isQuestion { return 0 }
        return min(9, showsOptions ? shown.options.count : 0)
    }

    private var shortcutHint: String? {
        let parts = [
            shortcutCount > 1 ? String(localized: "1–\(shortcutCount) 选择") : shortcutCount == 1 ? String(localized: "1 选择") : nil,
            dismissID != nil ? String(localized: "Esc 拒绝") : nil,
        ].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private func cardKeyPress(_ press: KeyPress) -> KeyPress.Result {
        guard press.modifiers.isDisjoint(with: [.command, .control, .option]), connected, !busy,
              isInteractionRenderable(interaction: shown),
              !(NSApp.keyWindow?.firstResponder is NSText) else { return .ignored }
        if press.key == .escape {
            if showingDetails || detailsOnly { return .ignored }
            guard let dismissID else { return .ignored }
            submit(dismissID)
            return .handled
        }
        guard let digit = Int(press.characters), (1...9).contains(digit), digit <= shortcutCount else { return .ignored }
        if showsOptions { selectOption(shown.options[digit - 1].id) } else { submit(shown.actions[digit - 1].id) }
        return .handled
    }

    private var title: String {
        if !shown.title.isEmpty { return shown.title }
        return isQuestion ? String(localized: "需要回答") : shown.kind == .plan ? String(localized: "需要批准计划") : String(localized: "需要选择")
    }

    /// Whether the plan is longer than the collapsed window can show.
    private var planIsLong: Bool { (shown.message?.count ?? 0) > 1_200 }

    @ViewBuilder
    private func messageView(_ message: String) -> some View {
        if shown.kind == .plan {
            // Keep the dock bounded: rendering the full plan inline pushes the approval actions
            // and composer out of the window. The full plan has its own scrollable sheet.
            VStack(alignment: .leading, spacing: 0) {
                if !planIsLong {
                    MarkdownView(source: message, compact: true).frame(maxWidth: .infinity, alignment: .leading).padding(Space.sm + 2)
                } else {
                    ScrollView {
                        MarkdownView(source: message, compact: true).frame(maxWidth: .infinity, alignment: .leading).padding(Space.sm + 2)
                    }
                    .frame(maxHeight: 320)
                    .fixedSize(horizontal: false, vertical: true)
                }
                if planIsLong {
                    Divider()
                    Button("查看完整计划", action: openDetails)
                        .buttonStyle(.plain)
                        .font(.riffet(size: S(12)))
                        .foregroundStyle(palette.accent)
                        .padding(.horizontal, Space.md)
                        .padding(.vertical, 8)
                }
            }
            .background(blockFill, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))

        } else if !isQuestion, !selectsOptions {
            ScrollView {
                Text(message)
                    .font(.riffet(size: S(12), design: .monospaced))
                    .foregroundStyle(palette.fg2)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, Space.sm)
                    .padding(.vertical, Space.xs + Space.xxs)
            }
            .frame(maxHeight: 220)
            .fixedSize(horizontal: false, vertical: true)
            .background(blockFill, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
        } else {
            Text(message)
                .font(.riffet(size: S(13)))
                .foregroundStyle(palette.fg2)
                .lineSpacing(3)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// What sits on the card: the page colour, which the card's tint differs from.
    private var blockFill: Color { palette.bg }

    private var options: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(shown.options, id: \.id) { option in
                optionRow(label: option.label, on: current.selectedIds.contains(option.id), multiple: shown.multiple?.boolValue == true) {
                    selectOption(option.id)
                }
            }
        }

    }

    /// One choice: a full-width row with a filled radio.
    private func optionRow(label: String, on: Bool, multiple: Bool, wide: Bool = true, action: @escaping () -> Void) -> some View {
        let button = Button(action: action) {
            HStack(alignment: .center, spacing: 10) {
                optionGlyph(on: on, multiple: multiple)
                Text(label)
                    .font(.riffet(size: S(13)))
                    .foregroundStyle(on ? palette.fg : palette.fg2)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                if wide { Spacer(minLength: 0) }
            }
            .padding(.horizontal, Space.sm)
            .padding(.vertical, Space.xs)
            .frame(minHeight: 32)
            .background(on ? palette.accentSoft.opacity(0.55) : Color.clear, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
            .contentShape(Rectangle())
        }
        return button.buttonStyle(HoverRowStyle())
        .disabled(busy || !connected)
        .opacity(busy ? 0.65 : 1)
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    @ViewBuilder
    private func optionGlyph(on: Bool, multiple: Bool) -> some View {
        let ring: Color = on ? palette.accent : palette.lineStrong
        if multiple {
            RoundedRectangle(cornerRadius: 4, style: .continuous).strokeBorder(ring, lineWidth: 1.5)
                .background(on ? palette.accent : Color.clear, in: RoundedRectangle(cornerRadius: 4, style: .continuous))
                .overlay { if on { Image(icon: "checkmark").font(.riffet(size: 9, weight: .bold)).foregroundStyle(.white) } }
                .frame(width: 16, height: 16)
        } else {
            Circle().strokeBorder(ring, lineWidth: 1.5)
                .overlay { if on { Circle().fill(palette.accent).frame(width: 8, height: 8) } }
                .frame(width: 16, height: 16)
        }
    }

    private var noticeText: String? {
        switch state.notice {
        case .draftStale: String(localized: "题目已更新，旧草稿未提交。")
        case .unconfirmed: String(localized: "暂时无法确认回答是否已提交")
        default: nil
        }
    }

    @ViewBuilder
    private var notices: some View {
        if let noticeText { noticeLine(noticeText, palette.warning) }
        switch submission?.phase {
        case .unknown: noticeLine(String(localized: "暂时无法确认回答是否已提交"), palette.warning)
        case .stale: noticeLine(String(localized: "题目已变化，请同步后继续。"), palette.warning)
        case .uncertain:
            noticeLine(String(localized: "暂时无法确认回答是否已提交"), palette.warning)
            if let message = submission?.message, !message.isEmpty { noticeLine(message, palette.fg3) }
        case .success:
            if let message = submission?.message, !message.isEmpty { noticeLine(message, palette.success) }
        default: EmptyView()
        }
        if let message = state.error?.message ?? extendError, !message.isEmpty { noticeLine(message, palette.danger) }
    }

    private func noticeLine(_ text: String, _ color: Color) -> some View {
        Text(text).font(.riffet(size: S(12))).foregroundStyle(color).fixedSize(horizontal: false, vertical: true)
    }

    private var footer: some View {
        HStack(spacing: 6) {
            submissionActions
            Spacer(minLength: Space.sm)
            ForEach(shown.actions.filter { $0.id != "next" }, id: \.id) { action in
                let submits = action.id == "answer" || action.id == "submit"
                let last = (shown.questionIndex?.int64Value ?? 0) >= (shown.questionCount?.int64Value ?? Int64.max)
                let label = action.id == "previous" ? String(localized: "上一题")
                    : submits ? (last || action.label.contains("提交") ? String(localized: "提交") : String(localized: "下一题")) // i18n-ignore: matches the server's submit action label
                    : action.id == "skip" ? String(localized: "跳过") : action.label
                actionButton(label, action.tone == "danger" ? .danger : submits || action.tone == "primary" ? .primary : .secondary, posting: action.id == postingAction) { submit(action.id) }
                    .disabled(action.id != postingAction && (!connected || busy || (submits && !answerPresent)))
                    .help(action.id == "skip" ? "跳过这组问题" : "")
                    .modifier(DefaultActionIf(enabled: submits))
            }
        }
    }

    /// The action being posted. Its button shows the wait in place; a transient state never adds a row.
    private var postingAction: String? { submission?.phase == .posting ? submission?.request.action : nil }

    private var footerButtonIDs: [String] { shown.actions.filter { $0.id != "next" }.map(\.id) }

    private var postingStatus: some View {
        HStack(spacing: 6) { Spinner(size: .mini); Text("提交中…") }.font(.riffet(size: S(12))).foregroundStyle(palette.fg3)
    }

    /// Trailing end of a title row: the wait for an action with no button here, or the offline note.
    @ViewBuilder
    private func titleStatus(buttonActions: [String]) -> some View {
        if submission?.phase == .posting, !(postingAction.map(buttonActions.contains) ?? false) {
            postingStatus
        } else if !connected {
            Text("重连后提交").font(.riffet(size: S(12))).foregroundStyle(palette.fg3)
        }
    }

    /// The shared solid buttons, in the web card's sizes and tones.
    /// A posting button stays enabled so its spinner is not dimmed; `submit` ignores it while the card is busy.
    private func actionButton(_ title: String, _ role: ApprovalActionRole, posting: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).opacity(posting ? 0 : 1).overlay { if posting { Spinner(size: .mini) } }
        }
            .buttonStyle(SolidButtonStyle(kind: role == .danger ? .danger : role == .primary ? .primary : .secondary))
    }

    @ViewBuilder
    private var submissionActions: some View {
        if state.canSync {
            HStack(spacing: 6) {
                if submission?.phase == .unknown {
                    Button("重试", action: retry).buttonStyle(ChipButtonStyle()).disabled(!connected || !state.canRetry || confirming)
                }
                syncButton
                if let openTerminal { Button("终端", action: openTerminal).buttonStyle(ChipButtonStyle()) }
            }
        }
    }

    private var syncButton: some View {
        Button(state.syncing ? "检查中…" : "检查状态") { Task { await sync() } }.buttonStyle(ChipButtonStyle()).disabled(state.syncing)
    }

    // MARK: Draft

    private func selectOption(_ id: String) {
        drafts.update(key) { $0.selectOption(optionId: id) }
    }

    /// The reducer refuses what the server would: clearing a locked "Other", or any change while busy.
    private func changeOther(_ text: String) {
        drafts.update(key) { $0.changeOtherText(value: text) }
    }

    private func submitOnEnter() {
        guard let action = shown.actions.first(where: { $0.id == "answer" }) ?? shown.actions.first(where: { $0.id == "submit" }),
              connected, !busy, answerPresent else { return }
        submit(action.id)
    }

    // MARK: Submit and sync

    private func submit(_ action: String) {
        guard connected, !busy else { return }
        let asked = shown
        confirmThenPost { current in
            guard current.shown.id == asked.id, current.shown.revision == asked.revision else { return nil }
            return current.submit(action: action, requestId: UUID().uuidString.lowercased())
        }
    }

    /// Sends an inconclusive answer again, as the same request.
    private func retry() {
        guard connected, !confirming, state.canRetry else { return }
        confirmThenPost { $0.retry() }
    }

    /// Asks for Touch ID when a permission needs it, then takes the transition from the state as it is
    /// by then and posts the request it carries. The result lands on the key's current state, so a card
    /// composed again in the meantime still receives it; the reducer ignores any other request's answer.
    private func confirmThenPost(_ transition: @escaping (InteractionCardState) -> InteractionCardState?) {
        let key = key, drafts = drafts, store = workbench.store, sessionID = currentSessionID, api = workbench.host.api
        let confirms = requireTouchID && shown.kind == .permission
        drafts.confirming.insert(key)
        extendError = nil
        Task {
            if confirms, !(await TouchID.confirm(String(localized: "批准 Agent 的操作"))) {
                drafts.confirming.remove(key)
                return
            }
            drafts.confirming.remove(key)
            guard let next = drafts.states[key].flatMap(transition), let sent = next.submission else { return }
            drafts.set(key, next)
            let requestId = sent.request.requestId
            do {
                let result: NativeInteractionResult
                if sessionID == workbench.selected?.id {
                    result = try await store.respondInteraction(response: sent.request)
                } else if let sessionID, let api {
                    let received = try await api.nativeInteraction(id: sessionID, response: sent.request)
                    if received.status == .advanced, received.interaction?.id == sent.request.interactionId, received.interaction?.revision == sent.request.revision {
                        result = NativeInteractionResult(status: .uncertain, interaction: received.interaction, message: received.message ?? String(localized: "暂时无法确认回答是否已提交"))
                    } else {
                        result = received
                    }
                } else {
                    throw LocalPairing.Failure(message: String(localized: "重连后提交"))
                }
                workbench.host.poke()
                drafts.update(key) { current in
                    let answered = current.responded(requestId: requestId, status: result.status, message: result.message)
                    guard result.status != .uncertain, let fresh = result.interaction,
                          fresh.id == answered.interaction.id,
                          current.interaction.revision == sent.interaction.revision || current.interaction == fresh else { return answered }
                    return answered.interactionChanged(next: fresh)
                }
                if result.status != .uncertain {
                    onInteractionChange?(result.interaction)
                }
            } catch {
                // Only an HTTP answer says what happened; anything else may have landed and is retried as the same request.
                let status = riffetHTTP(error).map { KotlinInt(int: $0.status) }
                let message = error.riffetMessage
                drafts.update(key) { $0.failed(requestId: requestId, status: status, message: message) }
            }
        }
    }

    private func sync() async {
        let key = key
        guard let current = drafts.states[key], !current.syncing else { return }
        drafts.set(key, current.syncStarted())
        do {
            let fresh: NativeInteraction?
            if currentSessionID == workbench.selected?.id {
                fresh = try await workbench.store.syncInteraction()
            } else if let sessionID = currentSessionID, let api = workbench.host.api {
                fresh = try await api.nativeCurrentInteraction(id: sessionID)
            } else {
                throw LocalPairing.Failure(message: String(localized: "重连后提交"))
            }
            drafts.update(key) { current in
                let synced = current.synced(fresh: fresh)
                guard let fresh, fresh.id == synced.interaction.id else { return synced }
                return synced.interactionChanged(next: fresh)
            }
            if fresh != nil || drafts.states[key]?.frozen != true {
                onInteractionChange?(fresh)
            }
        } catch {
            let message = error.riffetMessage
            drafts.update(key) { $0.syncFailed(message: message) }
        }
    }
}

/// Text held to a line limit that reports whether the limit cut it off: its height against the same text unlimited.
/// The backend's own deadline for this request (`ExpiryCountdown` in `NativeInteractionCard.tsx`).
/// Its own view so the once-a-second tick redraws only the label.
private struct ExpiryCountdown: View {
    let workbench: Workbench
    let sessionID: String
    let interaction: NativeInteraction
    let failed: (String) -> Void
    @Environment(\.palette) private var palette
    @State private var extending = false

    /// Under this much time left the countdown turns into a warning.
    private static let warning: TimeInterval = 120

    var body: some View {
        if let deadline = ServerTime.date(interaction.expiresAt) {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                let remaining = deadline.timeIntervalSince(context.date)
                HStack(spacing: Space.sm) {
                    Text(remaining > 0 ? "\(Self.format(remaining)) 后自动拒绝" : "已超时，自动拒绝")
                        .font(.riffet(size: S(12)).monospacedDigit())
                        .foregroundStyle(remaining < Self.warning ? palette.warning : palette.fg3)
                        .help("超时后后端会自动拒绝这次请求")
                        .accessibilityLabel(remaining > 0 ? "\(deadline.formatted(date: .omitted, time: .shortened)) 自动拒绝" : "已超时，自动拒绝")
                    if remaining > 0, let until = ServerTime.date(interaction.extendableUntil), until > deadline {
                        Button("延长", action: extend)
                            .buttonStyle(ChipButtonStyle())
                            .disabled(extending)
                            .help("再等 10 分钟")
                    }
                }
            }
        }
    }

    private static func format(_ remaining: TimeInterval) -> String {
        let seconds = max(0, Int(remaining.rounded(.up)))
        return "\(seconds / 60):\(String(format: "%02d", seconds % 60))"
    }

    private func extend() {
        guard !extending, let api = workbench.host.api else { return }
        extending = true
        Task {
            defer { extending = false }
            do {
                _ = try await api.nativeExtendInteraction(id: sessionID, interactionId: interaction.id)
            } catch {
                failed(error.riffetMessage.isEmpty ? String(localized: "无法延长等待时间") : error.riffetMessage)
            }
        }
    }
}

/// Return presses the primary action of the card in front; not of one kept under another page.
private struct DefaultActionIf: ViewModifier {
    let enabled: Bool
    @Environment(\.covered) private var covered

    func body(content: Content) -> some View {
        if enabled, !covered { content.keyboardShortcut(.defaultAction) } else { content }
    }
}

private enum ApprovalActionRole { case primary, secondary, danger }

