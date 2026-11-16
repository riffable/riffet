import SwiftUI

/// One thing worth saying about the whole session (mobile.md §9.1). Several can hold at once; the page
/// shows the most severe as its one notice under the bar.
struct SessionNotice: Identifiable {
    let id: String
    /// Higher wins.
    let severity: Int
    let kind: RiffetNoticeKind
    var title: String? = nil
    let message: String
    var actionTitle: String? = nil
    var action: (() -> Void)? = nil
    /// The retained feedback this notice presents; its clock decides when 「已恢复」 clears.
    var entry: ConversationFeedback.Entry? = nil
    /// Opens the longer text the notice cuts short.
    var details: (() -> Void)? = nil
}

extension Collection where Element == SessionNotice {
    var mostSevere: SessionNotice? { self.max { $0.severity < $1.severity } }
}

/// The session's notice, boxed, under the top bar. A feedback notice opens whole on tap, its text and any
/// diagnostic, since three lines may cut either short.
struct PinnedSessionNotice: View {
    let notice: SessionNotice
    let feedback: ConversationFeedback
    @Environment(\.palette) private var palette

    var body: some View {
        let view = RiffetNotice(kind: notice.kind, title: notice.title, message: notice.message,
                                actionTitle: notice.actionTitle, action: notice.action, boxed: true)
            .lineLimit(3)
            .background(palette.bg, in: RoundedRectangle(cornerRadius: RiffetMetrics.groupRadius, style: .continuous))
            .contentShape(Rectangle())
            .onTapGesture { notice.details?() }
            .accessibilityIdentifier("sessionNotice")
        if let entry = notice.entry { view.conversationFeedbackVisibility(feedback, id: entry.id) } else { view }
    }
}

/// Pins the page's one notice under the bar, below the find bar when that is open.
struct SessionNoticeLayer: ViewModifier {
    let notice: SessionNotice?
    let feedback: ConversationFeedback
    /// How far below the top edge it rests.
    let top: CGFloat
    @Binding var height: CGFloat

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .top) {
                if let notice {
                    // Its own identity per notice: the feedback entry it presents is the one marked as seen.
                    PinnedSessionNotice(notice: notice, feedback: feedback)
                        .id(notice.id)
                        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
                        .padding(.horizontal, 12).padding(.top, top) // design-rules: allow the find bar's side inset
                        .frame(maxWidth: RiffetMetrics.readingWidth)
                        .transition(.opacity)
                }
            }
            .riffetAnimation(RiffetMotion.release, value: notice?.id)
    }
}
