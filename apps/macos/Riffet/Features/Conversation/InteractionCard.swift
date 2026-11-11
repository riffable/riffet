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
    @Environment(\.palette) private var palette
    @State private var showingFullPlan = false
    /// Extending the deadline failed; the platform's own action, outside the shared state machine.
    @State private var extendError: String?
    /// Which allow choice the 允许 button sends when a permission offers several (`.rows`, `.inline`).
    @State private var pickedAllow: String?
    @FocusState private var cardFocused: Bool
    @AppStorage("riffet.touchid-approvals") private var requireTouchID = false
    private let drafts = InteractionDrafts.shared

    private var key: String { "\(workbench.selected?.id ?? ""):\(interaction.id)" }
    private var connected: Bool { workbench.connection is RiffetConnectionStateLive }
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

    /// How the approval card is drawn; the card never asks which style is on screen.
    private var recipe: StyleSpec.Approval { DisplayPreferences.shared.style.approval }

    /// The inline card has no outer padding, so each section carries its own; the other recipes
    /// space their sections by the stack and the card's padding.
    private func inset(_ top: CGFloat) -> EdgeInsets {
        recipe == .inline ? EdgeInsets(top: top, leading: 16, bottom: 0, trailing: 16) : EdgeInsets()
    }

    private var containerInsets: EdgeInsets {
        switch recipe {
        case .stack: EdgeInsets(top: Space.lg, leading: Space.lg, bottom: Space.lg, trailing: Space.lg)
        // The web card: px-3 py-2.5.
        case .rows: EdgeInsets(top: 10, leading: 12, bottom: 10, trailing: 12)
        case .inline: EdgeInsets(top: 0, leading: 0, bottom: 10, trailing: 0)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: recipe == .inline ? 0 : Space.sm) {
            HStack(alignment: recipe == .stack ? .firstTextBaseline : .center, spacing: recipe == .inline ? 10 : Space.sm) {
                headerIcon
                Text(title)
                    .font(.riffet(size: S(recipe == .rows ? 13 : 14), weight: recipe == .rows ? .medium : .semibold))
                    .foregroundStyle(palette.fg)
                    .lineLimit(recipe == .rows ? 1 : nil)
                    .fixedSize(horizontal: false, vertical: recipe != .rows)
                Spacer()
                if cardFocused, let shortcutHint { Text(shortcutHint).font(.riffet(size: S(12))).foregroundStyle(palette.fg3) }
                if shown.expiresAt != nil, submission?.phase != .success, let sessionID = workbench.selected?.id {
                    ExpiryCountdown(workbench: workbench, sessionID: sessionID, interaction: shown, failed: { extendError = $0 })
                }
                if isQuestion, let count = shown.questionCount?.int64Value, count > 0 {
                    Text("\(max(1, shown.questionIndex?.int64Value ?? 1)) / \(count)").font(.riffet(size: S(12)).monospacedDigit()).foregroundStyle(palette.fg3)
                }
            }
            .padding(inset(14))
            if let message = shown.message, !message.isEmpty { messageView(message).padding(inset(10)) }
            if isInteractionRenderable(interaction: shown) {
                if selectsOptions, !shown.options.isEmpty { options }
                if isQuestion, shown.allowOther?.boolValue == true || shown.options.isEmpty {
                    TextField(shown.options.isEmpty ? "输入回答" : "其他…", text: Binding(get: { current.otherText }, set: changeOther))
                        .textFieldStyle(.roundedBorder)
                        // Disabled rather than refused: a field whose edit is refused can show text the draft does not hold.
                        .disabled(busy || !connected || otherTextLocked(interaction: shown))
                        .onSubmit(submitOnEnter)
                        .padding(inset(8))
                    if otherTextLocked(interaction: shown) {
                        Text("其他回答暂不能清空。").font(.riffet(size: S(12))).foregroundStyle(palette.fg3).padding(inset(8))
                    }
                }
                notices
                if let split = approvalSplit { approvalFooter(split) } else if !isQuestion, !selectsOptions { choiceButtons } else { footer }
            } else {
                notices
                Text("这个对话框需要在终端里处理。").font(.riffet(size: S(12))).foregroundStyle(palette.fg3).padding(inset(8))
                if let openTerminal { Button("打开终端", action: openTerminal).buttonStyle(SolidButtonStyle(kind: .secondary)).padding(inset(8)) }
            }
            if !connected {
                Text("重连后提交").font(.riffet(size: S(12))).foregroundStyle(palette.fg3).frame(maxWidth: .infinity, alignment: .trailing).padding(inset(8))
            }
        }
        .padding(containerInsets)
        .fixedSize(horizontal: false, vertical: true)
        // Clicking the card's empty space focuses it; text fields and buttons keep their own clicks.
        .background { Color.clear.contentShape(Rectangle()).onTapGesture { cardFocused = true } }
        .modifier(ApprovalChrome(recipe: recipe, palette: palette))
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
        .onChange(of: key) { _, key in drafts.show(key, interaction) }
    }

    // MARK: Keyboard

    /// Refusals in the order Esc prefers them (`nativeInteractionShortcuts.ts`).
    private var dismissID: String? {
        ["deny", "decline", "reject", "cancel"].first { id in shown.actions.contains { $0.id == id } }
    }

    private var showsOptions: Bool { selectsOptions && !shown.options.isEmpty }

    private var shortcutCount: Int {
        // The inline card's digits pick the allow choice; the card sends on 允许 or Return.
        if recipe == .inline, let split = approvalSplit { return split.allow.count > 1 ? min(9, split.allow.count) : 0 }
        return min(9, showsOptions ? shown.options.count : !isQuestion && !selectsOptions ? shown.actions.count : 0)
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
            guard let dismissID else { return .ignored }
            submit(dismissID)
            return .handled
        }
        guard let digit = Int(press.characters), (1...9).contains(digit), digit <= shortcutCount else { return .ignored }
        if recipe == .inline, let split = approvalSplit { pickedAllow = split.allow[digit - 1].id; return .handled }
        if showsOptions { selectOption(shown.options[digit - 1].id) } else { submit(shown.actions[digit - 1].id) }
        return .handled
    }

    private var title: String {
        if !shown.title.isEmpty { return shown.title }
        return isQuestion ? String(localized: "需要回答") : shown.kind == .plan ? String(localized: "需要批准计划") : String(localized: "需要选择")
    }

    private var icon: String {
        switch shown.kind {
        case .permission: "hand.raised"
        case .question: "questionmark.bubble"
        case .plan: "list.bullet.clipboard"
        default: "exclamationmark.bubble"
        }
    }

    /// The web card has no icon; the inline card marks a shell request with the terminal.
    @ViewBuilder
    private var headerIcon: some View {
        switch recipe {
        case .stack:
            Image(icon: icon).font(.riffet(size: S(13))).foregroundStyle(iconColor)
        case .rows:
            EmptyView()
        case .inline:
            Image(icon: asksShell ? "terminal" : icon).font(.riffet(size: S(13))).foregroundStyle(palette.fg2)
        }
    }

    /// Whether the request names a shell as its tool (Claude sends `toolName`).
    private var asksShell: Bool {
        guard shown.kind == .permission,
              let name = (shown.request?["toolName"] as? Kotlinx_serialization_jsonJsonPrimitive)?.content else { return false }
        return ["bash", "shell", "powershell", "terminal"].contains(name.lowercased())
    }

    /// A permission asks to act, so it takes the accent; questions and plans stay neutral. The
    /// warning colour is kept for the waiting state, not for every card.
    private var iconColor: Color {
        shown.kind == .permission ? palette.accent : palette.fg3
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
                    Button("查看完整计划") { showingFullPlan = true }
                        .buttonStyle(.plain)
                        .font(.riffet(size: S(12)))
                        .foregroundStyle(palette.accent)
                        .padding(.horizontal, Space.md)
                        .padding(.vertical, 8)
                }
            }
            .background(blockFill, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
            .sheet(isPresented: $showingFullPlan) { fullPlanView(message) }
        } else if !isQuestion, !selectsOptions {
            let inline = recipe == .inline
            ScrollView {
                Text(message)
                    .font(.riffet(size: S(inline ? 13 : 12), design: .monospaced))
                    .foregroundStyle(inline ? palette.fg : palette.fg2)
                    .lineSpacing(inline ? 4 : 0)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, inline ? 12 : Space.sm)
                    .padding(.vertical, inline ? 9 : 6)
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
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// What sits on the card: the page colour on the stack and rows cards, whose fills differ from it,
    /// and the subtle fill on the inline card, whose own fill is the page colour.
    private var blockFill: Color { recipe == .inline ? palette.bgSubtle : palette.bg }

    private func fullPlanView(_ message: String) -> some View {
        let screen = NSScreen.main?.visibleFrame.size ?? CGSize(width: 1280, height: 900)
        return VStack(spacing: 0) {
            HStack(spacing: Space.md) {
                Text(title)
                    .font(.riffet(size: S(14), weight: .semibold))
                    .foregroundStyle(palette.fg)
                Spacer(minLength: Space.sm)
                Button("关闭") { showingFullPlan = false }
                    .buttonStyle(ChipButtonStyle())
                    .keyboardShortcut(.cancelAction)
            }
            .padding(Space.lg)
            Divider()
            ScrollView {
                MarkdownView(source: message, compact: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(Space.lg)
            }
        }
        .frame(width: min(820, max(320, screen.width - 40)), height: min(680, max(300, screen.height - 56)))
        .background(palette.bg)
    }

    private var options: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(shown.options, id: \.id) { option in
                optionRow(label: option.label, on: current.selectedIds.contains(option.id), multiple: shown.multiple?.boolValue == true) {
                    selectOption(option.id)
                }
            }
        }
        .padding(inset(8))
    }

    /// One choice. The stack draws the system symbols; the rows card a full-width row with a filled
    /// radio; the inline card a bare radio and label.
    private func optionRow(label: String, on: Bool, multiple: Bool, wide: Bool = true, action: @escaping () -> Void) -> some View {
        let inline = recipe == .inline
        let button = Button(action: action) {
            HStack(alignment: recipe == .stack ? .firstTextBaseline : .center, spacing: recipe == .stack ? Space.sm + 2 : inline ? 8 : 10) {
                optionGlyph(on: on, multiple: multiple)
                Text(label)
                    .font(.riffet(size: S(13)))
                    .foregroundStyle(on && !inline ? palette.fg : palette.fg2)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                if wide { Spacer(minLength: 0) }
            }
            .padding(.horizontal, inline ? 0 : Space.sm)
            .padding(.vertical, inline ? 3 : recipe == .rows ? 4 : 6)
            .frame(minHeight: recipe == .rows ? 32 : inline ? 0 : 30)
            .background(on && !inline ? palette.accentSoft.opacity(0.55) : Color.clear, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
            .contentShape(Rectangle())
        }
        return Group {
            if inline { button.buttonStyle(.plain) } else { button.buttonStyle(HoverRowStyle()) }
        }
        .disabled(busy || !connected)
        .opacity(busy ? 0.65 : 1)
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    @ViewBuilder
    private func optionGlyph(on: Bool, multiple: Bool) -> some View {
        switch recipe {
        case .stack:
            Image(icon: multiple ? (on ? "checkmark.square.fill" : "square") : (on ? "largecircle.fill.circle" : "circle"))
                .font(.riffet(size: S(13)))
                .foregroundStyle(on ? palette.accent : palette.fg4)
        case .rows:
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
        case .inline:
            let ring: Color = on ? palette.fg : palette.fg4
            if multiple {
                RoundedRectangle(cornerRadius: 3, style: .continuous).strokeBorder(ring, lineWidth: 1.5)
                    .background(on ? palette.fg : Color.clear, in: RoundedRectangle(cornerRadius: 3, style: .continuous))
                    .overlay { if on { Image(icon: "checkmark").font(.riffet(size: 8, weight: .bold)).foregroundStyle(palette.bg) } }
                    .frame(width: 14, height: 14)
            } else {
                Circle().strokeBorder(ring, lineWidth: 1.5)
                    .overlay { if on { Circle().fill(palette.fg).frame(width: 6, height: 6) } }
                    .frame(width: 14, height: 14)
            }
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
        Text(text).font(.riffet(size: S(12))).foregroundStyle(color).fixedSize(horizontal: false, vertical: true).padding(inset(8))
    }

    /// A permission or a menu: one row per choice in the CLI's order, the focused one primary.
    private var choiceButtons: some View {
        let focused = shown.options.first { $0.selected }?.id
        return VStack(alignment: .leading, spacing: 6) {
            ForEach(shown.actions, id: \.id) { action in
                let primary = focused != nil && action.id == "option:\(focused!)"
                Button { submit(action.id) } label: {
                    Text(action.label)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .multilineTextAlignment(.leading)
                }
                .buttonStyle(SolidButtonStyle(kind: action.tone == "danger" ? .danger : primary ? .primary : .secondary))
                .disabled(!connected || busy)
                .modifier(DefaultActionIf(enabled: primary))
            }
            submissionActions
        }
        .padding(inset(12))
    }

    private var footer: some View {
        HStack(spacing: recipe == .inline ? 8 : 6) {
            submissionActions
            Spacer(minLength: Space.sm)
            ForEach(shown.actions.filter { $0.id != "next" }, id: \.id) { action in
                let submits = action.id == "answer" || action.id == "submit"
                let last = (shown.questionIndex?.int64Value ?? 0) >= (shown.questionCount?.int64Value ?? Int64.max)
                let label = action.id == "previous" ? String(localized: "上一题")
                    : submits ? (last || action.label.contains("提交") ? String(localized: "提交") : String(localized: "下一题")) // i18n-ignore: matches the server's submit action label
                    : action.id == "skip" ? String(localized: "跳过") : action.label
                actionButton(label, action.tone == "danger" ? .danger : submits || action.tone == "primary" ? .primary : .secondary) { submit(action.id) }
                    .disabled(!connected || busy || (submits && !answerPresent))
                    .help(action.id == "skip" ? "跳过这组问题" : "")
                    .modifier(DefaultActionIf(enabled: submits))
            }
        }
        .padding(recipe == .inline ? EdgeInsets(top: 12, leading: 16, bottom: 0, trailing: 10) : EdgeInsets())
    }

    /// A permission or a menu with a refusal and one or more ways to allow: the refusals and the
    /// primary allow become buttons, the other allows become the radios that pick what 允许 sends.
    /// Only the inline recipe takes this layout; the stack and the web-like rows card keep one full-width button per action.
    private var approvalSplit: (deny: [NativeInteractionAction], allow: [NativeInteractionAction])? {
        guard recipe == .inline, shown.kind == .permission, !isQuestion, !selectsOptions else { return nil }
        let deny = shown.actions.filter { $0.tone == "danger" || ["deny", "decline", "reject", "cancel"].contains($0.id) }
        let allow = shown.actions.filter { action in !deny.contains { $0.id == action.id } }
        return deny.isEmpty || allow.isEmpty ? nil : (deny, allow)
    }

    @ViewBuilder
    private func approvalFooter(_ split: (deny: [NativeInteractionAction], allow: [NativeInteractionAction])) -> some View {
        let focused = shown.options.first { $0.selected }.map { "option:\($0.id)" }
        let lead = split.allow.first { $0.tone == "primary" } ?? split.allow.first { $0.id == focused } ?? split.allow[0]
        let chosen = split.allow.first { $0.id == pickedAllow } ?? lead
        let radios = split.allow.count > 1
        let radioList = ForEach(split.allow, id: \.id) { action in
            optionRow(label: action.label, on: action.id == chosen.id, multiple: false, wide: false) { pickedAllow = action.id }
        }
        let buttons = HStack(spacing: 8) {
            ForEach(split.deny, id: \.id) { action in
                actionButton(action.label, .secondary) { submit(action.id) }
                    .disabled(!connected || busy)
            }
            actionButton(lead.label, .primary) { submit(chosen.id) }
                .disabled(!connected || busy)
                .modifier(DefaultActionIf(enabled: true))
        }
        // Radios on the left, buttons on the right; when the card is too narrow the buttons go under the radios.
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 16) {
                if radios { HStack(spacing: 16) { radioList } }
                submissionActions
                Spacer(minLength: 16)
                buttons
            }
            VStack(alignment: .leading, spacing: 10) {
                if radios { HStack(spacing: 16) { radioList } }
                HStack(spacing: 8) {
                    submissionActions
                    Spacer(minLength: 16)
                    buttons
                }
            }
        }
        .padding(EdgeInsets(top: 12, leading: 16, bottom: 0, trailing: 10))
    }

    /// The stack and the rows card use the shared solid buttons (the web card's sizes and tones); the inline card draws its own.
    @ViewBuilder
    private func actionButton(_ title: String, _ role: ApprovalActionRole, action: @escaping () -> Void) -> some View {
        if recipe != .inline {
            Button(title, action: action)
                .buttonStyle(SolidButtonStyle(kind: role == .danger ? .danger : role == .primary ? .primary : .secondary))
        } else {
            Button(title, action: action).buttonStyle(ApprovalButtonStyle(role: role))
        }
    }

    @ViewBuilder
    private var submissionActions: some View {
        if submission?.phase == .posting {
            HStack(spacing: 6) { Spinner(size: .mini); Text("提交中…") }.font(.riffet(size: S(12))).foregroundStyle(palette.fg3)
        }
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
        confirmThenPost { $0.submit(action: action, requestId: UUID().uuidString.lowercased()) }
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
        let key = key, drafts = drafts, store = workbench.store
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
                let result = try await store.respondInteraction(response: sent.request)
                drafts.update(key) { $0.responded(requestId: requestId, status: result.status, message: result.message) }
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
            let fresh = try await workbench.store.syncInteraction()
            drafts.update(key) { $0.synced(fresh: fresh) }
        } catch {
            let message = error.riffetMessage
            drafts.update(key) { $0.syncFailed(message: message) }
        }
    }
}

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

/// The card's surface per recipe: the stack's shared card, the rows card's tinted fill (the web's `bg-subtle/45`, no border),
/// and the inline card's page-coloured fill with a 1pt border and no shadow.
private struct ApprovalChrome: ViewModifier {
    let recipe: StyleSpec.Approval
    let palette: Palette

    @ViewBuilder
    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
        switch recipe {
        case .stack:
            content.card(radius: Radius.card, palette: palette)
        case .rows:
            content
                .background(shape.fill(palette.bgSubtle.opacity(0.45)))
        case .inline:
            content
                .background(shape.fill(palette.page))
                .overlay(shape.strokeBorder(palette.lineStrong, lineWidth: 1))
        }
    }
}

private enum ApprovalActionRole { case primary, secondary, danger }

/// The inline card's outlined and inverted buttons.
private struct ApprovalButtonStyle: ButtonStyle {
    let role: ApprovalActionRole
    @Environment(\.palette) private var palette
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
        let foreground: Color = switch role {
        case .primary: palette.page
        case .danger: palette.danger
        case .secondary: palette.fg
        }
        configuration.label
            .font(.riffet(size: S(13), weight: role == .primary ? .medium : .regular))
            .foregroundStyle(foreground)
            .lineLimit(1)
            .padding(.horizontal, 12)
            .frame(minHeight: 30)
            .background(shape.fill(role == .primary ? palette.fg : palette.page))
            .overlay(shape.strokeBorder(role == .primary ? .clear : palette.lineStrong, lineWidth: 1))
            .opacity(enabled ? (configuration.isPressed ? 0.82 : 1) : 0.5)
            .contentShape(shape)
    }
}
