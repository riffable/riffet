import SwiftUI
import RiffetKit

// Team members on the phone (docs/TEAM.md, mobile.md §9.12): what the 团队 tab, a member's pages and the
// conversation share. `Workbench.teamMembers` is nil when the server has none: every page then keeps the
// single 个人助理 it had before.

extension Workbench {
    /// Nil while the server declares no team members; else every active member, the default one included.
    var teamMembers: [AgentMember]? { list.teamMembers }
    func member(_ id: String) -> AgentMember? { list.teamMembers?.first { $0.id == id } }
    /// The member a conversation belongs to; nil for an ordinary one.
    func member(of session: Session) -> AgentMember? {
        guard let members = list.teamMembers else { return nil }
        return memberOf(session: session, projects: list.projects, members: members)
    }
    func project(of member: AgentMember) -> Project? { project(member.projectId) }
    /// The bound project's name of a `project` member, for the caption after its name.
    func boundProjectName(_ member: AgentMember) -> String? {
        guard member.scope.kind == "project" else { return nil }
        return project(member.scope.projectIds?.first ?? member.projectId)?.name
    }
    /// The Agents a member may run on, whatever its scope: the assistant's set (the server refuses the others).
    var memberBackends: [NativeBackendCatalogEntry] { backends.filter { AssistantKt.isAssistantBackend(id: $0.backendId) } }
    func backend(wire: String?) -> NativeBackendId? {
        guard let wire else { return nil }
        return backends.first { $0.backendId.name.lowercased() == wire.lowercased() }?.backendId
    }
    /// The settings a member's composer reads its opening model from: its saved choice in the Agent's place.
    func memberSettings(_ member: AgentMember) -> AppSettings? {
        guard let settings else { return nil }
        let offered = memberBackends
        let saved = backend(wire: member.target?.backendId).flatMap { id in offered.first { $0.backendId == id } }
        let chosen = saved ?? offered.first { $0.available } ?? offered.first
        guard let chosen else { return settings }
        let kept = chosen.backendId == saved?.backendId && (member.target?.profileId == nil || chosen.profiles.contains { $0.id == member.target?.profileId })
        return settings.withAssistantChoice(choice: AssistantChoice(backendId: chosen.backendId, profileId: kept ? member.target?.profileId : nil, model: kept ? member.target?.model : nil))
    }

    func setPinned(_ member: AgentMember, _ pinned: Bool) async {
        guard let api else { return }
        do { store.applyTeamMember(member: try await api.setTeamMemberPinned(id: member.id, pinned: pinned)) }
        catch is CancellationError {} catch { RiffetToastCenter.shared.error(error.riffetMessage) }
    }
    /// True when it is archived.
    @discardableResult func archive(_ member: AgentMember) async -> Bool {
        guard let api else { return false }
        do { store.applyTeamMember(member: try await api.archiveTeamMember(id: member.id)); return true }
        catch is CancellationError { return false } catch { RiffetToastCenter.shared.error(error.riffetMessage); return false }
    }
    /// True when it is gone; the default member cannot be deleted.
    func delete(_ member: AgentMember) async -> Bool {
        guard let api, !member.isDefault else { return false }
        do { try await api.deleteTeamMember(id: member.id); store.removeTeamMember(id: member.id); return true }
        catch is CancellationError { return false } catch { RiffetToastCenter.shared.error(error.riffetMessage); return false }
    }
    /// `send` with the members and Agents the message `@`-mentions, on every path: a plain send, an interrupt, the queue.
    func sendMentioning(_ text: String, attachments: [Attachment], context: [PromptContextReference], agents: [AgentMention], interrupt: Bool = false, enqueue: Bool = false, onStored: (() -> Void)? = nil) async -> Bool {
        do { return try await store.sendMentioning(text: text, attachments: attachments, context: context, agents: agents, interrupt: interrupt, enqueue: enqueue, onStored: onStored).boolValue }
        catch { self.error = error.riffetMessage; return false }
    }
}

/// How a page of the 团队 stack opens a conversation or leaves a member that is gone. Refreshed on each pass of
/// the root and handed down as the same object, so a closure change does not redraw every page.
final class TeamNavigator {
    var open: (String) -> Void = { _ in }
    var popToRoot: () -> Void = {}
}

private struct TeamNavigatorKey: EnvironmentKey { static let defaultValue = TeamNavigator() }
extension EnvironmentValues {
    var teamNavigator: TeamNavigator {
        get { self[TeamNavigatorKey.self] }
        set { self[TeamNavigatorKey.self] = newValue }
    }
}

/// A member's circle: the picture, its emoji, or for the default member without either a machine glyph, on the
/// active surface. No outer ring (DECISIONS 2026-11-17).
struct MemberAvatarView: View {
    let workbench: Workbench
    let member: AgentMember?
    var size: CGFloat = RiffetMetrics.avatar
    @Environment(\.palette) private var palette

    var body: some View {
        if let member, let url = workbench.api?.memberAvatarUrl(member: member).flatMap(URL.init(string:)) {
            OwnerAvatarView(workbench: workbench, owner: nil, size: size, url: url)
        } else {
            ZStack {
                Circle().fill(palette.bgActive)
                if let emoji = member?.avatar?.value, member?.avatar?.kind == "emoji", !emoji.isEmpty {
                    Text(emoji).font(.system(size: size * 0.5))
                } else {
                    Image(systemName: "cpu").font(.system(size: size * 0.46)).foregroundStyle(palette.fg2)
                }
            }
            .frame(width: size, height: size)
            .accessibilityHidden(true)
        }
    }
}

/// A page title of a member: its small avatar, its name, and after it the bound project in caption size.
struct MemberBarTitle: View {
    let workbench: Workbench
    let member: AgentMember
    var status: String? = nil
    @Environment(\.palette) private var palette
    var body: some View {
        HStack(spacing: 8) {
            MemberAvatarView(workbench: workbench, member: member, size: 24)
            VStack(spacing: 0) {
                HStack(spacing: 6) {
                    Text(member.name).riffetFont(.barTitle).foregroundStyle(palette.fg).lineLimit(1)
                    if let project = workbench.boundProjectName(member) { Text(project).riffetFont(.caption).foregroundStyle(palette.fg3).lineLimit(1) }
                }
                if let status, !status.isEmpty { Text(status).riffetFont(.caption).foregroundStyle(palette.fg3).lineLimit(1) }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// The row's clock: today the time, yesterday its name, within a week the weekday, else month/day.
func sessionRowTime(_ iso: String) -> String {
    guard let date = ServerTime.date(iso) else { return "" }
    let calendar = Calendar.current
    if calendar.isDateInToday(date) { return date.formatted(Date.FormatStyle(date: .omitted, time: .shortened).locale(AppLocalization.shared.locale)) }
    if calendar.isDateInYesterday(date) { return String(localized: "昨天", bundle: .riffet) }
    if date >= calendar.date(byAdding: .day, value: -6, to: calendar.startOfDay(for: .now))! { return date.formatted(.dateTime.weekday(.abbreviated).locale(AppLocalization.shared.locale)) }
    let parts = calendar.dateComponents([.month, .day], from: date)
    return "\(parts.month ?? 0)/\(parts.day ?? 0)"
}

/// The small warning-outlined tag of a conversation that waits for the reader.
struct WaitingTag: View {
    @Environment(\.palette) private var palette
    var body: some View {
        Text(String(localized: "待确认", bundle: .riffet)).riffetFont(.caption).foregroundStyle(palette.warning).lineLimit(1)
            .padding(.horizontal, RiffetMetrics.rowRadius - 2).frame(minHeight: 20)
            .overlay(Capsule().strokeBorder(palette.warning, lineWidth: 1))
    }
}

/// The one mark at the end of a conversation's row, the most urgent.
struct MemberMark: View {
    let mark: MemberRowMark
    @Environment(\.palette) private var palette
    var body: some View {
        switch mark {
        case .waiting: WaitingTag()
        case .running: ProgressView().controlSize(.small)
        case .unread: RiffetStatusDot(state: .unread)
        default: EmptyView()
        }
    }
}

// MARK: - Mentions

/// What the `@` menu of a conversation offers besides files and sessions: the other members, then the Agents.
struct MentionOptions {
    let members: [AgentMember]
    let agents: [NativeBackendCatalogEntry]
    /// The Agent a member without a saved one runs on.
    let fallback: NativeBackendId

    /// Nil without team members or in a quick chat.
    @MainActor static func make(workbench: Workbench, session: Session) -> MentionOptions? {
        guard let members = workbench.teamMembers, session.backendId != .chat else { return nil }
        let own = workbench.member(of: session)?.id
        let fallback = workbench.backends.first { AssistantKt.isAssistantBackend(id: $0.backendId) && $0.available }?.backendId ?? .claude
        return MentionOptions(members: sortTeamMembers(members: members).filter { $0.id != own },
                              agents: workbench.backends.filter { $0.available && $0.backendId != .chat }, fallback: fallback)
    }

    func mention(_ member: AgentMember) -> AgentMention {
        AgentMention(backendId: member.target?.backendId ?? fallback.name.lowercased(), backendProfileId: nil, model: nil, memberId: member.id, label: member.name)
    }
    func mention(_ agent: NativeBackendCatalogEntry) -> AgentMention {
        AgentMention(backendId: agent.backendId.name.lowercased(), backendProfileId: nil, model: nil, memberId: nil, label: agent.label)
    }
}

extension MessageDraft {
    /// The mentions whose `@name` is still in the text.
    func liveMentions() -> [AgentMention] {
        mentions.filter { mention in mention.label.map { text.contains("@" + $0) } ?? false }
    }
    /// Backspace into a mention takes the whole token: called with the text before and after an edit.
    func trimMention(from old: String, to new: String) {
        guard !mentions.isEmpty, new.count == old.count - 1, old.hasPrefix(new) else { return }
        for mention in mentions {
            guard let label = mention.label, old.hasSuffix("@" + label + " ") else { continue }
            mentions.removeAll { $0.label == label }
            text = String(old.dropLast(label.count + 2))
            return
        }
    }
}
