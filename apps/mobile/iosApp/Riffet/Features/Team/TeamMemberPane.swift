import SwiftUI
import RiffetKit

// A member's panel (mobile.md §2.7, §9.12): its head, 记忆 · 规则 · 能力 · 文件, its conversations, the facts, and the
// small actions. The conversation's details and the fresh member's page both put these sections in their list.

/// Where a row of the panel leads.
enum MemberRoute: Hashable {
    case page(AssistantPage), files, sessions, delegations
}

/// The destination pages of a `MemberRoute`; the host attaches it with `navigationDestination(item:)`.
struct MemberRouteDestination: View {
    let workbench: Workbench
    let member: AgentMember
    let setup: AssistantSetup
    let route: MemberRoute
    let currentID: String?
    let open: (String) -> Void

    var body: some View {
        switch route {
        case let .page(page): page.destination(workbench: workbench, setup: setup)
        case .files: MemberFilesView(workbench: workbench, member: member, setup: setup)
        case .sessions: MemberSessionsPage(workbench: workbench, member: member, currentID: currentID, open: open)
        case .delegations: AssistantDelegationsView(workbench: workbench, setup: setup)
        }
    }
}

/// Who started a conversation of a member: you, the schedule, or another member that called it.
@MainActor struct MemberInitiator {
    enum Kind { case owner, automatic, member(AgentMember) }
    let kind: Kind

    init(session: Session, workbench: Workbench) {
        switch session.origin?.kind {
        case "call":
            if let members = workbench.teamMembers,
               let caller = callerMember(session: session, sessions: workbench.list.sessions, projects: workbench.list.projects, members: members) { kind = .member(caller) }
            else { kind = .automatic }
        case "automation", "schedule", "template", "assistant": kind = .automatic
        default: kind = .owner
        }
    }

    var name: String {
        switch kind {
        case .owner: String(localized: "你", bundle: .riffet)
        case .automatic: String(localized: "自动", bundle: .riffet)
        case let .member(member): String(localized: "\(member.name) 调用", bundle: .riffet)
        }
    }
}

/// The initiator's small avatar: the owner, the calling member, or a neutral disc for the schedule.
struct InitiatorAvatar: View {
    let workbench: Workbench
    let initiator: MemberInitiator
    let size: CGFloat
    @Environment(\.palette) private var palette
    var body: some View {
        switch initiator.kind {
        case .owner: OwnerAvatarView(workbench: workbench, owner: workbench.owner, size: size)
        case let .member(member): MemberAvatarView(workbench: workbench, member: member, size: size)
        case .automatic:
            Image(systemName: "clock").font(.system(size: size * 0.5)).foregroundStyle(palette.fg2)
                .frame(width: size, height: size).background(Circle().fill(palette.bgActive)).accessibilityHidden(true)
        }
    }
}

/// The conversation's own mark: waiting, running or unread.
func memberSessionMark(_ session: Session) -> MemberRowMark {
    if session.state == .waiting { return .waiting }
    if session.state.isActive { return .running }
    return SidebarModelKt.isDoneUnseen(session: session) ? .unread : .none
}

// MARK: - Sections

/// 记忆 · 规则 · 能力, and 文件 once the member has left some.
struct MemberActionBarSection: View {
    let setup: AssistantSetup
    let go: (MemberRoute) -> Void
    var body: some View {
        var actions = [AssistantPage.memory, .rules, .abilities].map { page in
            RiffetPaneAction(symbol: page.symbol, title: page.title) { go(.page(page)) }
        }
        if !setup.files.isEmpty { actions.append(RiffetPaneAction(symbol: "folder", title: String(localized: "文件", bundle: .riffet)) { go(.files) }) }
        return Section { RiffetPaneActionBar(actions: actions) }
    }
}

/// The member's conversations: the main one and the ones others called, three at most.
struct MemberSessionsSection: View {
    let workbench: Workbench
    let member: AgentMember
    let currentID: String?
    let go: (MemberRoute) -> Void
    let open: (String) -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        let all = MemberSessionList.ordered(member: member, workbench: workbench)
        if !all.isEmpty {
            let running = all.count { $0.state.isActive }
            let figure = running > 0 ? String(localized: "\(Int32(running)) 个运行中 · 共 \(Int32(all.count))", bundle: .riffet) : String(localized: "共 \(Int32(all.count))", bundle: .riffet)
            Section {
                ForEach(all.prefix(3), id: \.id) { session in
                    MemberSessionRow(workbench: workbench, member: member, session: session, current: session.id == currentID, compact: true) { open(session.id) }
                }
                if all.count > 3 {
                    Button { go(.sessions) } label: {
                        HStack(spacing: 8) {
                            Text(String(localized: "全部 \(all.count) 个", bundle: .riffet)).riffetFont(.body).foregroundStyle(palette.fg)
                            Spacer(minLength: 8)
                            Image(systemName: "chevron.right").riffetFont(.caption, weight: .semibold).foregroundStyle(palette.fg4)
                        }.contentShape(Rectangle())
                    }.buttonStyle(RiffetRowPressStyle())
                }
            } header: { RiffetSectionTitle(String(localized: "会话", bundle: .riffet), figure: figure) }
        }
    }
}

enum MemberSessionList {
    /// The main conversation first, then the rest newest first.
    @MainActor static func ordered(member: AgentMember, workbench: Workbench) -> [Session] {
        let all = memberSessions(member: member, sessions: workbench.list.sessions)
        guard let main = memberMain(member: member, projects: workbench.list.projects, sessions: workbench.list.sessions) else { return all }
        return [main] + all.filter { $0.id != main.id }
    }
}

/// One conversation of a member: who started it and when, the 当前 badge or its mark.
struct MemberSessionRow: View {
    let workbench: Workbench
    let member: AgentMember
    let session: Session
    let current: Bool
    /// In the panel: the main conversation is named 主对话 and the time goes with the initiator.
    let compact: Bool
    let action: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        let initiator = MemberInitiator(session: session, workbench: workbench)
        let isMain = member.continuous && memberMain(member: member, projects: workbench.list.projects, sessions: workbench.list.sessions)?.id == session.id
        let title = isMain && compact ? String(localized: "主对话", bundle: .riffet) : session.shownTitle.isEmpty ? String(localized: "未命名会话", bundle: .riffet) : session.shownTitle
        let mark = memberSessionMark(session)
        Button(action: action) {
            HStack(spacing: 10) {
                if compact { InitiatorAvatar(workbench: workbench, initiator: initiator, size: 22) }
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).riffetFont(.body).foregroundStyle(palette.fg).lineLimit(1)
                    if !(isMain && compact) {
                        HStack(spacing: 4) {
                            if !compact { InitiatorAvatar(workbench: workbench, initiator: initiator, size: 14) }
                            Text("\(initiator.name) · \(sessionRowTime(session.createdAt))").riffetFont(.caption).foregroundStyle(palette.fg3).lineLimit(1)
                        }
                    }
                }
                Spacer(minLength: 8)
                if current {
                    Text(String(localized: "当前", bundle: .riffet)).riffetFont(.caption).foregroundStyle(palette.fg3)
                } else if mark != .none {
                    MemberMark(mark: mark)
                } else if !compact {
                    Text(sessionRowTime(SidebarModelKt.activityAt(session: session))).riffetFont(.caption).foregroundStyle(palette.fg3).monospacedDigit()
                }
            }
            .padding(.vertical, compact ? 0 : 8)
            .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
        }
        .buttonStyle(RiffetRowPressStyle())
    }
}

/// Every conversation of the member, by day.
struct MemberSessionsPage: View {
    let workbench: Workbench
    let member: AgentMember
    let currentID: String?
    let open: (String) -> Void
    var body: some View {
        let groups = MemberDayGroups.make(MemberSessionList.ordered(member: member, workbench: workbench))
        RiffetList {
            ForEach(groups, id: \.title) { group in
                Section {
                    ForEach(group.sessions, id: \.id) { session in
                        MemberSessionRow(workbench: workbench, member: member, session: session, current: session.id == currentID, compact: false) { open(session.id) }
                    }
                } header: { RiffetSectionTitle(group.title) }
            }
        }
        .navigationTitle(String(localized: "会话", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
    }
}

enum MemberDayGroups {
    struct Group { let title: String; let sessions: [Session] }
    /// 今天, 昨天, then the rest, by the day of the last activity.
    static func make(_ sessions: [Session]) -> [Group] {
        let calendar = Calendar.current
        let buckets = Dictionary(grouping: sessions) { session -> Int in
            guard let date = ServerTime.date(SidebarModelKt.activityAt(session: session)) else { return 2 }
            return calendar.isDateInToday(date) ? 0 : calendar.isDateInYesterday(date) ? 1 : 2
        }
        let titles = [String(localized: "今天", bundle: .riffet), String(localized: "昨天", bundle: .riffet), String(localized: "更早", bundle: .riffet)]
        return titles.indices.compactMap { index in buckets[index].map { Group(title: titles[index], sessions: $0) } }
    }
}

/// Agent and scope, and 委托 when some are active.
struct MemberFactRows: View {
    let workbench: Workbench
    let member: AgentMember
    let setup: AssistantSetup
    /// A conversation's own panel already says its Agent and model.
    let showsAgent: Bool
    let go: (MemberRoute) -> Void

    var body: some View {
        let active = setup.delegations?.filter { $0.state == "active" }.count ?? 0
        Section {
            if showsAgent, let agent = agentLine { RiffetValueRow(label: "Agent", value: agent) }
            RiffetValueRow(label: String(localized: "范围", bundle: .riffet), value: scopeLine)
            if active > 0 {
                Button { go(.delegations) } label: { SettingsRowLabel(title: String(localized: "委托", bundle: .riffet), value: "\(active)").contentShape(Rectangle()) }
                    .buttonStyle(RiffetRowPressStyle())
            }
        }
    }

    private var agentLine: String? {
        guard let target = member.target, let wire = target.backendId else { return nil }
        let label = workbench.backends.first { $0.backendId.name.lowercased() == wire.lowercased() }?.label ?? wire.capitalized
        return [label, target.model].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }
    private var scopeLine: String {
        switch member.scope.kind {
        case "global": String(localized: "全局", bundle: .riffet)
        case "project":
            (member.scope.projectIds ?? [member.projectId]).compactMap { workbench.project($0)?.name }.joined(separator: "、")
        default: String(localized: "个人", bundle: .riffet)
        }
    }
}

/// 置顶 / 取消置顶 of a member, for an action bar of its own or the conversation's low-frequency one.
@MainActor func memberPinAction(_ workbench: Workbench, _ member: AgentMember) -> RiffetPaneAction {
    let pinned = member.pinned?.boolValue == true
    return RiffetPaneAction(symbol: pinned ? "pin.slash" : "pin", title: pinned ? String(localized: "取消置顶", bundle: .riffet) : String(localized: "置顶", bundle: .riffet)) {
        Task { await workbench.setPinned(member, !pinned) }
    }
}

/// 归档 · 置顶, and for a member that is not the default 删除 at the very end. `onDeleted` runs when the member leaves the list.
struct MemberFooterSections: View {
    let workbench: Workbench
    let member: AgentMember
    /// False in a conversation's panel, whose low-frequency bar already carries 置顶 (and archives the conversation).
    var showsPin = true
    let onDeleted: () -> Void
    @State private var confirming = false
    @Environment(\.palette) private var palette

    var body: some View {
        // 归档 takes the member out of the list, so it leaves the page like 删除. The default member cannot be archived
        // (the server refuses it), and a bar of 置顶 alone is not worth a card: its row in 团队 still offers 置顶.
        if showsPin, !member.isDefault {
            Section { RiffetPaneActionBar(actions: [
                RiffetPaneAction(symbol: "archivebox", title: String(localized: "归档", bundle: .riffet)) {
                    Task { if await workbench.archive(member) { onDeleted() } }
                },
                memberPinAction(workbench, member),
            ]) }
        }
        if !member.isDefault {
            Section {
                Button(role: .destructive) { confirming = true } label: {
                    SettingsRowLabel(title: String(localized: "删除…", bundle: .riffet), tint: palette.danger).contentShape(Rectangle())
                }
                .buttonStyle(RiffetRowPressStyle())
                .confirmationDialog(String(localized: "删除成员「\(member.name)」？", bundle: .riffet), isPresented: $confirming, titleVisibility: .visible) {
                    Button(String(localized: "删除", bundle: .riffet), role: .destructive) { Task { if await workbench.delete(member) { onDeleted() } } }
                } message: { Text(String(localized: "保留历史会话记录，不再出现在团队列表中。", bundle: .riffet)) }
            }
        }
    }
}

// MARK: - Panel of a fresh member

/// The fresh member's panel, a sheet from its page.
struct MemberPanel: View {
    let workbench: Workbench
    let member: AgentMember
    let setup: AssistantSetup
    let open: (String) -> Void
    let onDeleted: () -> Void
    @State private var route: MemberRoute?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        NavigationStack {
            RiffetList {
                MemberActionBarSection(setup: setup) { route = $0 }
                MemberSessionsSection(workbench: workbench, member: member, currentID: nil, go: { route = $0 }, open: { dismiss(); open($0) })
                MemberFactRows(workbench: workbench, member: member, setup: setup, showsAgent: true) { route = $0 }
                MemberFooterSections(workbench: workbench, member: member) { dismiss(); onDeleted() }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) { MemberBarTitle(workbench: workbench, member: member) }
                ToolbarItem(placement: .topBarTrailing) { Button { dismiss() } label: { Image(systemName: "xmark") }.accessibilityLabel(String(localized: "关闭", bundle: .riffet)) }
            }
            .navigationDestination(item: $route) { target in
                MemberRouteDestination(workbench: workbench, member: member, setup: setup, route: target, currentID: nil, open: { dismiss(); open($0) })
            }
        }
        .environment(\.riffetPanelSheet, true)
        .riffetToastHost()
        .presentationDetents(dynamicTypeSize.isAccessibilitySize ? [.large] : [.medium, .large]).presentationDragIndicator(.visible)
        .task { await setup.refresh(workbench.api) }
    }
}

// MARK: - Files

/// The files the member left in its `files/` folder; a tap downloads one and previews it.
struct MemberFilesView: View {
    let workbench: Workbench
    let member: AgentMember
    let setup: AssistantSetup
    @State private var preview: URL?
    @State private var loading: String?
    @Environment(\.palette) private var palette

    var body: some View {
        RiffetList {
            ForEach(setup.files, id: \.path) { file in
                Button { Task { await show(file) } } label: {
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(file.path).riffetFont(.body).foregroundStyle(palette.fg).lineLimit(1).truncationMode(.middle)
                            Text(ByteCountFormatter.string(fromByteCount: file.size, countStyle: .file)).riffetFont(.caption).foregroundStyle(palette.fg3)
                        }
                        Spacer(minLength: 8)
                        if loading == file.path { ProgressView() }
                    }.contentShape(Rectangle())
                }.buttonStyle(RiffetRowPressStyle())
            }
        }
        .navigationTitle(String(localized: "文件", bundle: .riffet)).navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: Binding(get: { preview != nil }, set: { if !$0 { preview = nil } })) { if let preview { FilePreview(url: preview) } }
    }

    private func show(_ file: AgentMemberFile) async {
        guard loading == nil, let api = workbench.api, let url = URL(string: api.memberFileUrl(id: member.id, path: file.path)) else { return }
        loading = file.path
        defer { loading = nil }
        do { preview = try await workbench.resources.file(for: url, name: (file.path as NSString).lastPathComponent) }
        catch { RiffetToastCenter.shared.error(error.riffetMessage) }
    }
}
