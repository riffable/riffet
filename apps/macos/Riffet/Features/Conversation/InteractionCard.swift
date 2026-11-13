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
    var summaryTitle: String?
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

    /// Quick actions are offered only when every source line fits without wrapping or clipping.
    /// A wrapped preview remains readable, but its decision belongs in the full reader.
    private var summaryBody: some View {
        ViewThatFits(in: .horizontal) {
            if title.components(separatedBy: .newlines).count <= 2,
               (shown.message ?? "").components(separatedBy: .newlines).count <= 3 {
                summaryContent(collapsed: false).fixedSize(horizontal: true, vertical: true)
            }
            summaryContent(collapsed: true)
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    private func summaryContent(collapsed: Bool) -> some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            if summaryTitle != title {
                HStack(alignment: .top, spacing: Space.sm) {
                    headerIcon
                    Text(title).font(.riffet(size: S(13), weight: .medium)).foregroundStyle(palette.fg)
                        .lineLimit(collapsed ? 2 : nil).fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
            }
            if let message = shown.message, !message.isEmpty {
                Text(message).font(.riffet(size: S(12), design: .monospaced)).foregroundStyle(palette.fg2)
                    .lineLimit(collapsed ? 3 : nil).fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
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
                summaryActions(collapsed: collapsed)
                Button("查看详情", action: openDetails).buttonStyle(ChipButtonStyle())
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

    private func summaryActions(collapsed: Bool) -> some View {
        let complete = !collapsed && shown.message?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
            && shown.actions.allSatisfy { $0.detail?.isEmpty != false }
        return HStack(spacing: Space.sm) {
            Button("查看详情", action: openDetails).buttonStyle(ChipButtonStyle())
            submissionActions
            Spacer(minLength: 0)
            if !busy, !selectsOptions, !isQuestion, isInteractionRenderable(interaction: shown) {
                ForEach(shown.actions.filter {
                    $0.detail == nil && (!complete ? ["deny", "decline", "reject", "cancel"] : ["approve", "allow-once", "accept", "deny", "decline", "reject", "cancel"]).contains($0.id)
                        && ($0.shortLabel != nil || $0.label.count < 28)
                }, id: \.id) { action in
                    actionButton(action.shortLabel ?? action.label, action.tone == "danger" ? .secondary : .primary) { submit(action.id) }
                        .disabled(!connected || busy)
                }
            }
        }
    }

    /// Long titles, content and choice descriptions share one scroll owner. Sending stays outside it.
    private var detailBody: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.md) {
                    Text(title).font(.riffet(size: S(14), weight: .semibold)).foregroundStyle(palette.fg)
                        .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
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
                    if !connected { Text("重连后提交").font(.riffet(size: S(12))).foregroundStyle(palette.fg3) }
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
            }
                .buttonStyle(SolidButtonStyle(kind: action.tone == "danger" ? .secondary : .primary))
                .disabled(!connected || busy || !isInteractionRenderable(interaction: shown))
        } else if isQuestion || selectsOptions {
            footer
        }
    }

    private var chosenAction: NativeInteractionAction? {
        shown.actions.first { $0.id == pickedAllow }
            ?? shown.actions.first { $0.detail == nil && ["approve", "accept", "allow-once"].contains($0.id) }
    }

    private var expandedCard: some View {
        VStack(alignment: .leading, spacing: recipe == .inline ? 0 : Space.sm) {
            HStack(alignment: recipe == .stack ? .firstTextBaseline : .center, spacing: recipe == .inline ? 10 : Space.sm) {
                headerIcon
                Text(title)
                    .font(.riffet(size: S(recipe == .rows ? 13 : 14), weight: recipe == .rows ? .medium : .semibold))
                    .foregroundStyle(palette.fg)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer()
                if cardFocused, let shortcutHint { Text(shortcutHint).font(.riffet(size: S(12))).foregroundStyle(palette.fg3) }
                if shown.expiresAt != nil, submission?.phase != .success, let sessionID = currentSessionID {
                    ExpiryCountdown(workbench: workbench, sessionID: sessionID, interaction: shown, failed: { extendError = $0 })
                }
                if isQuestion, let count = shown.questionCount?.int64Value, count > 0 {
                    Text("\(max(1, shown.questionIndex?.int64Value ?? 1)) / \(count)").font(.riffet(size: S(12)).monospacedDigit()).foregroundStyle(palette.fg3)
                }
            }
            .padding(inset(14))
            if let message = shown.message, !message.isEmpty { messageView(message).padding(inset(10)) }
            Button("查看详情", action: openDetails).buttonStyle(ChipButtonStyle()).padding(inset(8))
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
                footer
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
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// What sits on the card: the page colour on the stack and rows cards, whose fills differ from it,
    /// and the subtle fill on the inline card, whose own fill is the page colour.
    private var blockFill: Color { recipe == .inline ? palette.bgSubtle : palette.bg }

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
