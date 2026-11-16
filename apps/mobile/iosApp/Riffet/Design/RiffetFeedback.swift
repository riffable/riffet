import SwiftUI
import UIKit

// The feedback parts of docs/design/system/ios.md §4.4 that the system does not draw: a notice (one
// fact about the page, in place) and a toast (the result of one operation). Empty states, loading and
// skeletons are the system's (`ContentUnavailableView`, `ProgressView`, `.redacted(reason:)`).

/// How serious a notice is: its symbol and the symbol's tone. The text stays in the page's ink.
enum RiffetNoticeKind {
    case info, success, warning, error

    var symbol: String {
        switch self {
        case .info: "info.circle"
        case .success: "checkmark.circle"
        case .warning: "exclamationmark.triangle"
        case .error: "exclamationmark.circle"
        }
    }

    func tone(_ palette: Palette) -> Color {
        switch self {
        case .info: palette.fg3
        case .success: palette.accent
        case .warning: palette.warning
        case .error: palette.danger
        }
    }
}

/// One fact the reader needs about the page or the object it shows (mobile.md §5): a symbol in the
/// kind's tone, an optional title, one sentence, at most one action. In a list it is a row of its own
/// section (the card is the list's); elsewhere pass `boxed` and it draws its own card. One per page:
/// what a card, a row or the bar already says is not repeated here.
struct RiffetNotice: View {
    let kind: RiffetNoticeKind
    var title: String? = nil
    let message: String
    var actionTitle: String? = nil
    var action: (() -> Void)? = nil
    var boxed = false
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: kind.symbol)
                .riffetFont(.caption, weight: .medium)
                .foregroundStyle(kind.tone(palette))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                if let title { Text(title).riffetFont(.label).foregroundStyle(palette.fg) }
                Text(message).riffetFont(.caption).foregroundStyle(title == nil ? palette.fg : palette.fg2)
                    .textSelection(.enabled)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .riffetFont(.label).foregroundStyle(palette.accent)
                    .buttonStyle(RiffetDimPressStyle())
                    .frame(minHeight: RiffetMetrics.hitTarget)
            }
        }
        .padding(.vertical, actionTitle == nil ? 4 : 0)
        .padding(.horizontal, boxed ? RiffetMetrics.pageInset : 0)
        .padding(.vertical, boxed ? 8 : 0)
        .background {
            if boxed { RoundedRectangle(cornerRadius: RiffetMetrics.groupRadius, style: .continuous).fill(palette.bgSubtle) }
        }
        .accessibilityElement(children: .combine)
    }
}

extension RiffetNotice {
    /// The notice as a list section of its own: the place a page's one notice takes in a list.
    /// A concrete type rather than `some View`, for the reason `riffetFont` gives.
    static func section(_ kind: RiffetNoticeKind, title: String? = nil, _ message: String?,
                        actionTitle: String? = nil, action: (() -> Void)? = nil) -> Section<EmptyView, RiffetNotice, EmptyView>? {
        guard let message, !message.isEmpty else { return nil }
        return Section { RiffetNotice(kind: kind, title: title, message: message, actionTitle: actionTitle, action: action) }
    }
}

// MARK: - Toast

/// The result of one operation, said once in a sentence (ios.md §4.4): one queue for the whole app,
/// hosted by the root, four seconds on screen or six with an action ("Undo", "Retry").
@MainActor @Observable
final class RiffetToastCenter {
    static let shared = RiffetToastCenter()

    enum Kind { case info, success, error }

    struct Toast: Identifiable, Equatable {
        let id = UUID()
        let text: String
        let kind: Kind
        let actionTitle: String?
        let action: (() -> Void)?
        static func == (a: Toast, b: Toast) -> Bool { a.id == b.id }
    }

    private(set) var current: Toast?
    private var waiting: [Toast] = []
    /// What a page keeps at the bottom edge above the hosting safe area (a conversation's composer), so the
    /// toast clears it. Pages set it through `riffetToastClearance(_:)`.
    var clearance: CGFloat = 0

    func show(_ text: String, kind: Kind = .info, actionTitle: String? = nil, action: (() -> Void)? = nil) {
        guard !text.isEmpty else { return }
        let toast = Toast(text: text, kind: kind, actionTitle: actionTitle, action: action)
        if current == nil { current = toast } else { waiting.append(toast) }
    }

    /// An operation's error as a toast; nothing for nil.
    func error(_ text: String?) { if let text { show(text, kind: .error) } }

    func dismiss(_ id: UUID) {
        guard current?.id == id else { return }
        current = waiting.isEmpty ? nil : waiting.removeFirst()
    }
}

struct RiffetToastHost: ViewModifier {
    @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let center = RiffetToastCenter.shared

    func body(content: Content) -> some View {
        content.overlay(alignment: .bottom) {
            ZStack {
                if let toast = center.current {
                    pill(toast)
                        .padding(.horizontal, RiffetMetrics.pageInset)
                        .padding(.bottom, RiffetMetrics.floatingGap + center.clearance)
                        .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
                        .task(id: toast.id) {
                            AccessibilityNotification.Announcement(toast.text).post()
                            try? await Task.sleep(for: .seconds(toast.action == nil ? 4 : 6))
                            guard !Task.isCancelled else { return }
                            center.dismiss(toast.id)
                        }
                }
            }
            .animation(RiffetMotion.spatial, value: center.current)
        }
    }

    private func pill(_ toast: RiffetToastCenter.Toast) -> some View {
        HStack(spacing: 10) {
            if toast.kind != .info {
                Image(systemName: toast.kind == .success ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                    .foregroundStyle(toast.kind == .success ? palette.toastSuccess : palette.toastDanger)
                    .accessibilityHidden(true)
            }
            Text(toast.text).foregroundStyle(.white).lineLimit(3)
            if let title = toast.actionTitle, let action = toast.action {
                Button(title) { action(); center.dismiss(toast.id) }
                    .riffetFont(.label).foregroundStyle(.white)
                    .buttonStyle(RiffetDimPressStyle())
                    .frame(minHeight: RiffetMetrics.hitTarget)
            }
        }
        .riffetFont(.label, weight: .regular)
        .padding(.horizontal, RiffetMetrics.pageInset)
        .frame(minHeight: RiffetMetrics.hitTarget)
        .background(Capsule().fill(palette.toast))
        .riffetFloatingShadow()
        .contentShape(Capsule())
        .onTapGesture { center.dismiss(toast.id) }
        .accessibilityAddTraits(.isStaticText)
    }
}

struct RiffetToastClearance: ViewModifier {
    let height: CGFloat
    func body(content: Content) -> some View {
        content
            .onChange(of: height, initial: true) { _, value in RiffetToastCenter.shared.clearance = value }
            // Back from a pushed page or another tab, the composer is in the way again.
            .onAppear { RiffetToastCenter.shared.clearance = height }
            .onDisappear { RiffetToastCenter.shared.clearance = 0 }
    }
}

extension View {
    /// Draws the app's toasts over this view, above its bottom safe area. Each tab's stack hosts one.
    func riffetToastHost() -> ModifiedContent<Self, RiffetToastHost> { modifier(RiffetToastHost()) }
    /// Lifts toasts above what this page keeps at its bottom edge (the conversation's composer).
    func riffetToastClearance(_ height: CGFloat) -> ModifiedContent<Self, RiffetToastClearance> { modifier(RiffetToastClearance(height: height)) }
}

// MARK: - Copy

/// Copies a text: the symbol turns into a check for a moment, with a success tap. One for every copy
/// action that is a button of its own (code blocks, diffs, a command to paste in a terminal).
struct RiffetCopyButton: View {
    let text: String
    /// What is copied, for VoiceOver ("复制代码", "复制命令").
    var label = String(localized: "复制", bundle: .riffet)
    /// Two copy buttons side by side tell themselves apart by symbol (a diff's before and after).
    var symbol = "doc.on.doc"
    var height: CGFloat = RiffetMetrics.hitTarget
    @State private var feedback = ConversationCopyFeedback()
    @Environment(\.palette) private var palette

    var body: some View {
        Button {
            UIPasteboard.general.string = text
            feedback.copy()
        } label: {
            Image(systemName: feedback.copied ? "checkmark" : symbol)
                .riffetFont(.caption)
                .frame(width: RiffetMetrics.hitTarget, height: height)
                .contentShape(Rectangle())
        }
        .buttonStyle(RiffetDimPressStyle())
        .foregroundStyle(palette.fg3)
        .sensoryFeedback(.success, trigger: feedback.copied) { _, copied in copied }
        .conversationCopyFeedback(feedback)
        .accessibilityLabel(feedback.copied ? String(localized: "已复制", bundle: .riffet) : label)
    }
}

// MARK: - Status dot

/// A small state mark beside a row's title: running, waiting for you, failed, or unread.
struct RiffetStatusDot: View {
    enum State { case running, waiting, failed, unread, idle }
    let state: State
    var size: CGFloat = 8
    @Environment(\.palette) private var palette

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }

    private var color: Color {
        switch state {
        case .running, .unread: palette.accent
        case .waiting: palette.warning
        case .failed: palette.danger
        case .idle: palette.fg4
        }
    }
}
