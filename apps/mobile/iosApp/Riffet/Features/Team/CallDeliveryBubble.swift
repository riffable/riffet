import SwiftUI
import RiffetKit

/// The answer of a call handed back into the conversation (docs/AGENT-CALLS.md): a message from the called Agent or
/// member, not from the reader. The envelope is not shown: the markdown body on the muted surface, and under it the
/// answerer's avatar and name with the time, on the right like the reader's own messages.
struct CallDeliveryBubble: View {
    let workbench: Workbench
    let projectID: String
    let delivery: CallDelivery
    let at: String
    @Environment(\.palette) private var palette

    var body: some View {
        let answerer = workbench.teamMembers.flatMap {
            CallDeliveryKt.deliveryMember(delivery: delivery, sessions: workbench.list.sessions, projects: workbench.list.projects, members: $0)
        }
        // On the reader's side like their own messages (the prototype and the web): it arrives in the conversation as one.
        VStack(alignment: .trailing, spacing: 6) {
            ConversationMarkdown(source: delivery.body, workbench: workbench, projectID: projectID, stateID: "delivery." + delivery.callId)
                // design-rules: allow the same insets and corner as the reader's own bubble
                .padding(.horizontal, 14).padding(.vertical, 10)
                // design-rules: allow the same insets and corner as the reader's own bubble
                .background(palette.bgMuted, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            HStack(spacing: 6) {
                if let answerer { MemberAvatarView(workbench: workbench, member: answerer, size: 16) }
                Text(answerer?.name ?? delivery.agentName).riffetFont(.caption).foregroundStyle(palette.fg3).lineLimit(1)
                if let date = ServerTime.date(at) {
                    Text(date.formatted(Date.FormatStyle(date: .omitted, time: .shortened).locale(AppLocalization.shared.locale)))
                        .riffetFont(.caption).monospacedDigit().foregroundStyle(palette.fg4)
                }
            }
        }
        // design-rules: allow the gap that keeps a peer bubble off the Agent's column, as the reader's own bubble's width cap does
        .padding(.leading, 32)
        .frame(maxWidth: .infinity, alignment: .trailing)
        .accessibilityElement(children: .combine)
    }
}
